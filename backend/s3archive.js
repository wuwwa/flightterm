// ── S3 archival — archive before purge ──────────────────────────────────────
//
// Archives sightings + daily summaries + anomalies to S3 before the hourly
// purge cycle deletes them from SQLite. Runs every hour (matching the 3-hour
// retention window). Does nothing if S3 is not configured.
//
// Safety:
//   - Max 5 MB per upload (rejects abnormally large payloads)
//   - Max 50,000 rows per table per cycle (circuit breaker)
//   - Only deletes from SQLite AFTER successful upload
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

// Safety limits
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024  // 5 MB per file
const MAX_ROWS_PER_CYCLE = 50_000

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
  lastRun: null,        // ISO timestamp of last attempt
  lastSuccess: null,    // ISO timestamp of last successful upload
  lastResult: null,     // 'ok' | 'empty' | 'error' | 'skipped'
  lastError: null,      // error message if failed
  lastArchived: 0,      // rows archived in last run
  totalArchived: 0,     // rows archived since startup
  totalRuns: 0,
  totalFailures: 0,     // consecutive failures (resets on success)
}

function isEnabled() {
  return !!s3
}

function getStatus() {
  return { ..._status }
}

// Upload a gzipped JSON payload to S3. Returns true on success.
async function _upload(key, rows, label) {
  const json = JSON.stringify(rows)
  const compressed = zlib.gzipSync(json)
  const sizeMB = (compressed.length / 1024 / 1024).toFixed(2)
  const sizeKB = (compressed.length / 1024).toFixed(1)

  if (compressed.length > MAX_UPLOAD_BYTES) {
    console.warn(`[s3]   ✗ SKIP ${label} — ${sizeMB} MB exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`)
    return false
  }

  const t0 = Date.now()
  console.log(`[s3]   ↑ uploading ${label} → ${key} (${sizeKB} KB)...`)

  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: compressed,
      ContentType: 'application/gzip',
      ContentEncoding: 'gzip',
      Metadata: {
        'row-count': String(rows.length),
        'archived-at': new Date().toISOString(),
      },
    }))
    const ms = Date.now() - t0
    console.log(`[s3]   ✓ uploaded ${label} (${sizeKB} KB, ${ms}ms)`)
    return true
  } catch (err) {
    const ms = Date.now() - t0
    console.error(`[s3]   ✗ FAILED ${label} after ${ms}ms: ${err.name} — ${err.message}`)
    throw err
  }
}

// Archive all data that's about to be purged.
// Called with the cutoff timestamp — archives everything older than cutoff.
// Returns { ok: boolean, sightings, daily, anomalies }
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

  // ── 1. Archive raw sightings about to be purged ───────────────────────
  try {
    const sightings = db
      .prepare('SELECT * FROM sightings WHERE seen_at < ?')
      .all(cutoff)

    console.log(`[s3]   sightings: ${sightings.length} rows to archive`)
    if (sightings.length > 0 && sightings.length <= MAX_ROWS_PER_CYCLE) {
      const ok = await _upload(`${PREFIX}sightings/${ts}.json.gz`, sightings, `sightings (${sightings.length} rows)`)
      if (ok) { totalRows += sightings.length; steps.push(`sightings: ${sightings.length}`) }
      else anyFailed = true
    } else if (sightings.length > MAX_ROWS_PER_CYCLE) {
      console.warn(`[s3]   ✗ SKIP sightings — ${sightings.length} rows exceeds ${MAX_ROWS_PER_CYCLE} limit`)
      anyFailed = true
    } else {
      console.log(`[s3]   sightings: nothing to archive`)
    }
  } catch (err) {
    console.error(`[s3]   ✗ sightings archive error: ${err.message}`)
    anyFailed = true
    _status.lastError = `sightings: ${err.message}`
  }

  // ── 2. Archive daily summaries ────────────────────────────────────────
  try {
    const daily = db
      .prepare('SELECT * FROM sightings_daily')
      .all()

    console.log(`[s3]   daily: ${daily.length} rows to archive`)
    if (daily.length > 0 && daily.length <= MAX_ROWS_PER_CYCLE) {
      const ok = await _upload(`${PREFIX}daily/${ts}.json.gz`, daily, `daily (${daily.length} rows)`)
      if (ok) { totalRows += daily.length; steps.push(`daily: ${daily.length}`) }
      else anyFailed = true
    } else if (daily.length === 0) {
      console.log(`[s3]   daily: nothing to archive`)
    }
  } catch (err) {
    console.error(`[s3]   ✗ daily archive error: ${err.message}`)
    anyFailed = true
    _status.lastError = `daily: ${err.message}`
  }

  // ── 3. Archive anomalies about to be purged ───────────────────────────
  try {
    const anomalies = db
      .prepare('SELECT * FROM anomalies WHERE detected_at < ?')
      .all(cutoff)

    console.log(`[s3]   anomalies: ${anomalies.length} rows to archive`)
    if (anomalies.length > 0 && anomalies.length <= MAX_ROWS_PER_CYCLE) {
      const ok = await _upload(`${PREFIX}anomalies/${ts}.json.gz`, anomalies, `anomalies (${anomalies.length} rows)`)
      if (ok) { totalRows += anomalies.length; steps.push(`anomalies: ${anomalies.length}`) }
      else anyFailed = true
    } else if (anomalies.length === 0) {
      console.log(`[s3]   anomalies: nothing to archive`)
    }
  } catch (err) {
    console.error(`[s3]   ✗ anomaly archive error: ${err.message}`)
    anyFailed = true
    _status.lastError = `anomalies: ${err.message}`
  }

  // ── Update status ─────────────────────────────────────────────────────
  _status.lastArchived = totalRows
  _status.totalArchived += totalRows
  const elapsed = Date.now() - t0

  if (totalRows > 0 && !anyFailed) {
    _status.lastResult = 'ok'
    _status.lastSuccess = new Date().toISOString()
    _status.lastError = null
    _status.totalFailures = 0
    console.log(`[s3] ✓ archive complete — ${totalRows} rows in ${elapsed}ms [${steps.join(' | ')}]`)
    console.log(`[s3]   lifetime total: ${_status.totalArchived.toLocaleString()} rows archived`)
  } else if (totalRows > 0 && anyFailed) {
    _status.lastResult = 'partial'
    _status.totalFailures++
    console.warn(`[s3] ⚠ partial — ${totalRows} rows archived, some failed (${elapsed}ms)`)
  } else if (anyFailed) {
    _status.lastResult = 'error'
    _status.totalFailures++
    console.error(`[s3] ✗ archive FAILED — 0 rows archived (${elapsed}ms) — ${_status.totalFailures} consecutive failure(s)`)
    console.error(`[s3]   data will NOT be purged until S3 succeeds`)
  } else {
    _status.lastResult = 'empty'
    _status.lastError = null
    console.log(`[s3] ○ archive cycle empty — nothing to archive (${elapsed}ms)`)
  }

  console.log(`[s3] ──────────────────────────────────────────────────`)

  return { ok: !anyFailed, archived: totalRows }
}

module.exports = { isEnabled, archiveBeforePurge, getStatus }
