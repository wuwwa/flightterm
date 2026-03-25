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
  console.log(`s3: archival enabled → s3://${BUCKET}/${PREFIX}`)
} else {
  console.log('s3: archival disabled (S3_BUCKET not set)')
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

  if (compressed.length > MAX_UPLOAD_BYTES) {
    console.warn(`  s3: SKIPPED ${label} — ${(compressed.length / 1024 / 1024).toFixed(1)} MB exceeds limit`)
    return false
  }

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

  console.log(`  s3: uploaded ${key} (${rows.length} rows, ${(compressed.length / 1024).toFixed(1)} KB)`)
  return true
}

// Archive all data that's about to be purged.
// Called with the cutoff timestamp — archives everything older than cutoff.
// Returns { ok: boolean, sightings, daily, anomalies }
async function archiveBeforePurge(db, cutoff) {
  if (!s3) return { ok: false, reason: 'disabled' }

  _status.totalRuns++
  _status.lastRun = new Date().toISOString()

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let totalRows = 0
  let anyFailed = false

  // ── 1. Archive raw sightings about to be purged ───────────────────────
  try {
    const sightings = db
      .prepare('SELECT * FROM sightings WHERE seen_at < ?')
      .all(cutoff)

    if (sightings.length > 0 && sightings.length <= MAX_ROWS_PER_CYCLE) {
      const ok = await _upload(`${PREFIX}sightings/${ts}.json.gz`, sightings, `sightings (${sightings.length})`)
      if (ok) totalRows += sightings.length
      else anyFailed = true
    } else if (sightings.length > MAX_ROWS_PER_CYCLE) {
      console.warn(`  s3: SKIPPED sightings — ${sightings.length} rows exceeds ${MAX_ROWS_PER_CYCLE} limit`)
      anyFailed = true
    }
  } catch (err) {
    console.error(`  s3: FAILED sightings archive: ${err.message}`)
    anyFailed = true
    _status.lastError = `sightings: ${err.message}`
  }

  // ── 2. Archive daily summaries ────────────────────────────────────────
  try {
    const daily = db
      .prepare('SELECT * FROM sightings_daily')
      .all()

    if (daily.length > 0 && daily.length <= MAX_ROWS_PER_CYCLE) {
      const ok = await _upload(`${PREFIX}daily/${ts}.json.gz`, daily, `daily (${daily.length})`)
      if (ok) totalRows += daily.length
      else anyFailed = true
    }
  } catch (err) {
    console.error(`  s3: FAILED daily archive: ${err.message}`)
    anyFailed = true
    _status.lastError = `daily: ${err.message}`
  }

  // ── 3. Archive anomalies about to be purged ───────────────────────────
  try {
    const anomalies = db
      .prepare('SELECT * FROM anomalies WHERE detected_at < ?')
      .all(cutoff)

    if (anomalies.length > 0 && anomalies.length <= MAX_ROWS_PER_CYCLE) {
      const ok = await _upload(`${PREFIX}anomalies/${ts}.json.gz`, anomalies, `anomalies (${anomalies.length})`)
      if (ok) totalRows += anomalies.length
      else anyFailed = true
    }
  } catch (err) {
    console.error(`  s3: FAILED anomaly archive: ${err.message}`)
    anyFailed = true
    _status.lastError = `anomalies: ${err.message}`
  }

  // ── Update status ─────────────────────────────────────────────────────
  _status.lastArchived = totalRows
  _status.totalArchived += totalRows

  if (totalRows > 0 && !anyFailed) {
    _status.lastResult = 'ok'
    _status.lastSuccess = new Date().toISOString()
    _status.lastError = null
    _status.totalFailures = 0
  } else if (totalRows > 0 && anyFailed) {
    _status.lastResult = 'partial'
    _status.totalFailures++
  } else if (anyFailed) {
    _status.lastResult = 'error'
    _status.totalFailures++
  } else {
    _status.lastResult = 'empty'
    _status.lastError = null
  }

  if (_status.totalFailures > 0) {
    console.error(`  ⚠ S3 ARCHIVAL ${anyFailed ? 'FAILED' : 'PARTIAL'} — ${_status.totalFailures} consecutive failure(s). Data will NOT be purged until S3 succeeds.`)
  }

  return { ok: !anyFailed, archived: totalRows }
}

module.exports = { isEnabled, archiveBeforePurge, getStatus }
