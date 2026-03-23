// ── S3 archival for sightings_daily rows older than ARCHIVE_AFTER_DAYS ───────
//
// Exports old daily summaries as gzipped JSON to S3, then deletes them from
// SQLite. Runs as part of the periodic purge cycle. Does nothing if S3 is
// not configured (all env vars are optional).
//
// Safety:
//   - Max 5 MB per upload (rejects abnormally large payloads)
//   - Max 50,000 rows per cycle (circuit breaker for runaway growth)
//   - Only deletes from SQLite AFTER successful upload
//   - PutObject-only IAM policy — can't read, list, or delete from bucket
//
// Env vars:
//   S3_BUCKET              – bucket name (required to enable archival)
//   S3_REGION              – AWS region, default us-east-1
//   S3_PREFIX              – key prefix inside bucket, default "flightterm/"
//   S3_ARCHIVE_DAYS        – archive daily rows older than this, default 3
//   AWS_ACCESS_KEY_ID      – standard AWS credential
//   AWS_SECRET_ACCESS_KEY

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const zlib = require('zlib')

const BUCKET = process.env.S3_BUCKET
const REGION = process.env.S3_REGION || 'us-east-1'
const PREFIX = process.env.S3_PREFIX || 'flightterm/'
const ARCHIVE_AFTER_DAYS = parseInt(process.env.S3_ARCHIVE_DAYS, 10) || 3

// Safety limits
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024  // 5 MB per file
const MAX_ROWS_PER_CYCLE = 50_000         // refuse to archive if more than this

let s3 = null
if (BUCKET) {
  s3 = new S3Client({ region: REGION })
  console.log(`s3: archival enabled → s3://${BUCKET}/${PREFIX} (>${ARCHIVE_AFTER_DAYS}d)`)
} else {
  console.log('s3: archival disabled (S3_BUCKET not set)')
}

// ── status tracking ─────────────────────────────────────────────────────────
const _status = {
  enabled: !!s3,
  lastRun: null,       // ISO timestamp
  lastResult: null,    // 'ok' | 'empty' | 'error' | 'skipped'
  lastError: null,     // error message if failed
  lastArchived: 0,     // rows archived in last run
  totalArchived: 0,    // rows archived since startup
  totalRuns: 0,
}

function isEnabled() {
  return !!s3
}

function getStatus() {
  return { ..._status }
}

// Archive old daily summaries to S3 and delete them from SQLite.
// `db` is the better-sqlite3 instance, passed in to avoid circular deps.
async function archiveOldDaily(db) {
  if (!s3) return { archived: 0, uploaded: false }

  _status.totalRuns++
  _status.lastRun = new Date().toISOString()

  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86400000)
    .toISOString()
    .slice(0, 10) // YYYY-MM-DD

  // Count first — circuit breaker
  const count = db
    .prepare('SELECT COUNT(*) as c FROM sightings_daily WHERE date < ?')
    .get(cutoff).c

  if (count === 0) {
    _status.lastResult = 'empty'
    _status.lastArchived = 0
    _status.lastError = null
    return { archived: 0, uploaded: false }
  }

  if (count > MAX_ROWS_PER_CYCLE) {
    console.warn(`  s3: SKIPPED — ${count} rows exceeds safety limit of ${MAX_ROWS_PER_CYCLE}. Check for data anomaly.`)
    _status.lastResult = 'skipped'
    _status.lastError = `${count} rows exceeds ${MAX_ROWS_PER_CYCLE} limit`
    return { archived: 0, uploaded: false, skipped: true }
  }

  // Fetch rows to archive
  const rows = db
    .prepare('SELECT * FROM sightings_daily WHERE date < ?')
    .all(cutoff)

  // Group by month for cleaner S3 keys
  const byMonth = {}
  for (const row of rows) {
    const month = row.date.slice(0, 7) // YYYY-MM
    if (!byMonth[month]) byMonth[month] = []
    byMonth[month].push(row)
  }

  let totalArchived = 0
  const uploadedMonths = [] // track which months succeeded

  for (const [month, monthRows] of Object.entries(byMonth)) {
    const json = JSON.stringify(monthRows)
    const compressed = zlib.gzipSync(json)

    // Size guard
    if (compressed.length > MAX_UPLOAD_BYTES) {
      console.warn(`  s3: SKIPPED ${month} — ${(compressed.length / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`)
      continue
    }

    const key = `${PREFIX}daily/${month}.json.gz`

    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: compressed,
        ContentType: 'application/gzip',
        ContentEncoding: 'gzip',
        Metadata: {
          'row-count': String(monthRows.length),
          'date-range': `${monthRows[0].date} to ${monthRows[monthRows.length - 1].date}`,
        },
      }))

      totalArchived += monthRows.length
      uploadedMonths.push(month)
      console.log(`  s3: uploaded ${key} (${monthRows.length} rows, ${(compressed.length / 1024).toFixed(1)} KB)`)
    } catch (err) {
      // Upload failed — do NOT delete these rows
      console.error(`  s3: FAILED to upload ${key}: ${err.message}`)
      _status.lastError = err.message
    }
  }

  // Only delete rows for months that were successfully uploaded
  if (uploadedMonths.length > 0) {
    const likeClauses = uploadedMonths.map(() => 'date LIKE ?').join(' OR ')
    const likeParams = uploadedMonths.map((m) => `${m}%`)
    const deleted = db
      .prepare(`DELETE FROM sightings_daily WHERE date < ? AND (${likeClauses})`)
      .run(cutoff, ...likeParams)

    console.log(`  s3: archived ${totalArchived} daily rows, deleted ${deleted.changes} from sqlite`)
  }

  _status.lastArchived = totalArchived
  _status.totalArchived += totalArchived
  _status.lastResult = totalArchived > 0 ? 'ok' : 'error'
  if (totalArchived > 0) _status.lastError = null

  return { archived: totalArchived, uploaded: uploadedMonths.length > 0 }
}

module.exports = { isEnabled, archiveOldDaily, getStatus, ARCHIVE_AFTER_DAYS }
