// ── S3 archival — archive before purge ──────────────────────────────────────
//
// Archives sightings + daily summaries + anomalies to S3 before the hourly
// purge cycle deletes them from SQLite. Runs every hour (matching the 3-hour
// retention window). Does nothing if S3 is not configured.
//
// Sightings are uploaded in 10K-row batches to avoid blocking the event loop
// and exceeding S3 payload limits.
//
// Env vars:
//   S3_BUCKET              – bucket name (required to enable archival)
//   S3_REGION              – AWS region, default us-east-1
//   S3_PREFIX              – key prefix inside bucket, default "flightterm/"
//   AWS_ACCESS_KEY_ID      – standard AWS credential
//   AWS_SECRET_ACCESS_KEY

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const zlib = require('zlib')

const BUCKET = process.env.S3_BUCKET
const REGION = process.env.S3_REGION || 'us-east-1'
const PREFIX = process.env.S3_PREFIX || 'flightterm/'

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024  // 5 MB per file
const BATCH_SIZE = 10_000                  // rows per sightings upload

let s3 = null
if (BUCKET) {
  s3 = new S3Client({ region: REGION })
  console.log(`[s3] ✓ archival enabled → s3://${BUCKET}/${PREFIX}`)
  console.log(`[s3]   region=${REGION} | AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID ? 'set (' + process.env.AWS_ACCESS_KEY_ID.substring(0, 4) + '...)' : 'NOT SET'}`)
} else {
  console.log('[s3] ✗ archival disabled (S3_BUCKET not set)')
}

// ── status tracking ─────────────────────────────────────────────────────────
const _status = {
  enabled: !!s3,
  lastRun: null,
  lastSuccess: null,
  lastResult: null,
  lastError: null,
  lastArchived: 0,
  totalArchived: 0,
  totalRuns: 0,
  totalFailures: 0,
}

function isEnabled() { return !!s3 }
function getStatus() { return { ..._status } }

// Yield event loop so HTTP requests aren't starved during long archives
const tick = () => new Promise(r => setImmediate(r))

// Upload a gzipped JSON payload to S3. Returns true on success.
async function _upload(key, rows, label) {
  const json = JSON.stringify(rows)
  const compressed = zlib.gzipSync(json)
  const sizeKB = (compressed.length / 1024).toFixed(1)

  if (compressed.length > MAX_UPLOAD_BYTES) {
    console.warn(`[s3]   ✗ SKIP ${label} — ${(compressed.length / 1024 / 1024).toFixed(2)} MB exceeds limit`)
    return false
  }

  const t0 = Date.now()
  console.log(`[s3]   ↑ ${label} → ${key} (${sizeKB} KB)...`)

  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: compressed,
      ContentType: 'application/gzip',
      ContentEncoding: 'gzip',
      Metadata: { 'row-count': String(rows.length), 'archived-at': new Date().toISOString() },
    }))
    console.log(`[s3]   ✓ ${label} (${sizeKB} KB, ${Date.now() - t0}ms)`)
    return true
  } catch (err) {
    console.error(`[s3]   ✗ FAILED ${label} (${Date.now() - t0}ms): ${err.name} — ${err.message}`)
    throw err
  }
}

// Archive all data about to be purged.
async function archiveBeforePurge(db, cutoff) {
  if (!s3) {
    console.log('[s3] archive skipped — not configured')
    return { ok: false, reason: 'disabled' }
  }

  _status.totalRuns++
  _status.lastRun = new Date().toISOString()
  const t0 = Date.now()

  console.log(`[s3] ── archive cycle #${_status.totalRuns} ──────────────────────────`)
  console.log(`[s3]   cutoff: ${cutoff}`)

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let totalRows = 0
  let anyFailed = false
  const steps = []

  // ── 1. Sightings — batched to avoid memory/payload issues ───────────
  try {
    const countRow = db.prepare('SELECT COUNT(*) as c FROM sightings WHERE seen_at < ?').get(cutoff)
    const total = countRow.c
    console.log(`[s3]   sightings: ${total} rows to archive (${BATCH_SIZE}/batch)`)

    if (total > 0) {
      const stmt = db.prepare('SELECT * FROM sightings WHERE seen_at < ? ORDER BY seen_at LIMIT ? OFFSET ?')
      let offset = 0
      let batchNum = 0
      let batchFailed = false

      while (offset < total) {
        await tick() // yield so HTTP stays responsive
        const batch = stmt.all(cutoff, BATCH_SIZE, offset)
        if (batch.length === 0) break
        batchNum++
        try {
          const ok = await _upload(
            `${PREFIX}sightings/${ts}_batch${String(batchNum).padStart(3, '0')}.json.gz`,
            batch,
            `sightings batch ${batchNum} (${batch.length} rows)`
          )
          if (ok) totalRows += batch.length
          else batchFailed = true
        } catch {
          batchFailed = true
        }
        offset += batch.length
      }

      if (batchFailed) anyFailed = true
      else steps.push(`sightings: ${total}`)
    } else {
      console.log(`[s3]   sightings: nothing to archive`)
    }
  } catch (err) {
    console.error(`[s3]   ✗ sightings error: ${err.message}`)
    anyFailed = true
    _status.lastError = `sightings: ${err.message}`
  }

  // ── 2. Daily summaries ──────────────────────────────────────────────
  try {
    await tick()
    const daily = db.prepare('SELECT * FROM sightings_daily').all()
    console.log(`[s3]   daily: ${daily.length} rows to archive`)
    if (daily.length > 0) {
      const ok = await _upload(`${PREFIX}daily/${ts}.json.gz`, daily, `daily (${daily.length} rows)`)
      if (ok) { totalRows += daily.length; steps.push(`daily: ${daily.length}`) }
      else anyFailed = true
    } else {
      console.log(`[s3]   daily: nothing to archive`)
    }
  } catch (err) {
    console.error(`[s3]   ✗ daily error: ${err.message}`)
    anyFailed = true
    _status.lastError = `daily: ${err.message}`
  }

  // ── 3. Anomalies ───────────────────────────────────────────────────
  try {
    await tick()
    const anomalies = db.prepare('SELECT * FROM anomalies WHERE detected_at < ?').all(cutoff)
    console.log(`[s3]   anomalies: ${anomalies.length} rows to archive`)
    if (anomalies.length > 0) {
      const ok = await _upload(`${PREFIX}anomalies/${ts}.json.gz`, anomalies, `anomalies (${anomalies.length} rows)`)
      if (ok) { totalRows += anomalies.length; steps.push(`anomalies: ${anomalies.length}`) }
      else anyFailed = true
    } else {
      console.log(`[s3]   anomalies: nothing to archive`)
    }
  } catch (err) {
    console.error(`[s3]   ✗ anomalies error: ${err.message}`)
    anyFailed = true
    _status.lastError = `anomalies: ${err.message}`
  }

  // ── Status ──────────────────────────────────────────────────────────
  _status.lastArchived = totalRows
  _status.totalArchived += totalRows
  const elapsed = Date.now() - t0

  if (totalRows > 0 && !anyFailed) {
    _status.lastResult = 'ok'
    _status.lastSuccess = new Date().toISOString()
    _status.lastError = null
    _status.totalFailures = 0
    console.log(`[s3] ✓ archive complete — ${totalRows} rows in ${elapsed}ms [${steps.join(' | ')}]`)
    console.log(`[s3]   lifetime: ${_status.totalArchived.toLocaleString()} rows`)
  } else if (totalRows > 0 && anyFailed) {
    _status.lastResult = 'partial'
    _status.totalFailures++
    console.warn(`[s3] ⚠ partial — ${totalRows} rows archived, some failed (${elapsed}ms)`)
  } else if (anyFailed) {
    _status.lastResult = 'error'
    _status.totalFailures++
    console.error(`[s3] ✗ FAILED — 0 rows (${elapsed}ms) — ${_status.totalFailures} consecutive failure(s)`)
    console.error(`[s3]   data preserved until S3 succeeds`)
  } else {
    _status.lastResult = 'empty'
    _status.lastError = null
    console.log(`[s3] ○ empty — nothing to archive (${elapsed}ms)`)
  }

  console.log(`[s3] ──────────────────────────────────────────────────`)
  return { ok: !anyFailed, archived: totalRows }
}

module.exports = { isEnabled, archiveBeforePurge, getStatus }
