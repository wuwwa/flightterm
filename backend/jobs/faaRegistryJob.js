// FAA Releasable Aircraft Registry — fetch + unzip + ingest.
//
// One shared module for three callers:
//   1. Backend startup (self-heal: pull on boot if DB is empty or >7d stale)
//   2. Weekly setInterval in backend/index.js (keep current for warm boxes)
//   3. CLI script backend/scripts/ingest-faa-registry.js (--fetch flag)
//
// Written so the whole pipeline lives in Node code — portable from Fly to
// AWS/GCP/self-hosted with zero infra-specific config. The FAA URL is a
// public download; we fetch it directly instead of committing the 70MB
// dataset to git.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const axios = require('axios')
const StreamZip = require('node-stream-zip')

const db = require('../db')

const INGEST_SOURCE = 'faa_registry'

// ── Config (all overridable via env for easy CI/CD tweaks) ──────────────────

const FAA_ZIP_URL  = process.env.FAA_ZIP_URL  || 'https://registry.faa.gov/database/ReleasableAircraft.zip'
const FAA_REFERER  = 'https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download'
const FAA_UA       = 'Mozilla/5.0 (compatible; flightterm-registry-sync/1.0)'
const STALENESS_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
const MIN_ZIP_BYTES = 10 * 1024 * 1024        // reject absurdly small responses (auth walls, errors)
const UPSERT_BATCH  = 5000

// ── MASTER.txt parsing (extracted so the CLI can reuse) ─────────────────────

const COL = {
  N_NUMBER: 0, SERIAL: 1, MFR_MDL_CODE: 2, ENG_MFR_MDL: 3, YEAR_MFR: 4,
  TYPE_REGISTRANT: 5, NAME: 6, STREET: 7, STREET2: 8, CITY: 9, STATE: 10,
  ZIP: 11, REGION: 12, COUNTY: 13, COUNTRY: 14, LAST_ACTION_DATE: 15,
  CERT_ISSUE_DATE: 16, CERTIFICATION: 17, TYPE_AIRCRAFT: 18, TYPE_ENGINE: 19,
  STATUS_CODE: 20, MODE_S_CODE: 21, FRACT_OWNER: 22, AIR_WORTH_DATE: 23,
  EXPIRATION_DATE: 29, UNIQUE_ID: 30, KIT_MFR: 31, KIT_MODEL: 32,
  MODE_S_CODE_HEX: 33,
}

function clean(s) {
  if (s == null) return null
  const t = s.trim()
  return t.length ? t : null
}

function parseMasterLine(line) {
  const cols = line.split(',')
  if (cols.length < 22) return null

  const nNumRaw = clean(cols[COL.N_NUMBER])
  if (!nNumRaw) return null

  const typeReg = parseInt(cols[COL.TYPE_REGISTRANT], 10)
  const modeSHex = clean(cols[COL.MODE_S_CODE_HEX])

  return {
    n_number:          nNumRaw.toUpperCase(),
    icao24_hex:        modeSHex ? modeSHex.toLowerCase() : null,
    owner_name:        clean(cols[COL.NAME])?.toUpperCase() || null,
    type_registrant:   Number.isFinite(typeReg) ? typeReg : null,
    street:            clean(cols[COL.STREET]),
    city:              clean(cols[COL.CITY]),
    state:             clean(cols[COL.STATE]),
    zip:               clean(cols[COL.ZIP]),
    aircraft_mfr_code: clean(cols[COL.MFR_MDL_CODE]),
    model_code:        clean(cols[COL.ENG_MFR_MDL]),
    last_action_date:  clean(cols[COL.LAST_ACTION_DATE]),
    status_code:       clean(cols[COL.STATUS_CODE]),
  }
}

// ── Pipeline steps ──────────────────────────────────────────────────────────

async function downloadZip(destPath) {
  const res = await axios.get(FAA_ZIP_URL, {
    responseType: 'stream',
    timeout: 5 * 60 * 1000,
    maxRedirects: 5,
    headers: {
      'User-Agent': FAA_UA,
      'Referer': FAA_REFERER,
      'Accept': '*/*',
    },
    validateStatus: s => s >= 200 && s < 300,
  })

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath)
    res.data.pipe(out)
    out.on('finish', resolve)
    out.on('error', reject)
    res.data.on('error', reject)
  })

  const { size } = fs.statSync(destPath)
  if (size < MIN_ZIP_BYTES) {
    throw new Error(`FAA zip suspiciously small (${size} bytes) — likely an HTML error page`)
  }
  return size
}

async function extractMasterTxt(zipPath, destPath) {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    // MASTER.txt is the root-level filename inside the FAA zip
    await zip.extract('MASTER.txt', destPath)
  } finally {
    await zip.close()
  }
  return fs.statSync(destPath).size
}

async function ingestMasterFile(filePath, { limit = null, silent = false } = {}) {
  const started = Date.now()
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let lineNo = 0, parsed = 0, skipped = 0
  let changed = 0, unchanged = 0
  let batch = []
  const byType = {}

  const flushBatch = () => {
    if (!batch.length) return
    const r = db.upsertFaaRegistryBulk(batch)
    changed   += r.changed
    unchanged += r.unchanged
    batch = []
  }

  for await (const line of rl) {
    lineNo++
    if (lineNo === 1) continue  // header
    const row = parseMasterLine(line)
    if (!row) { skipped++; continue }
    parsed++
    if (row.type_registrant != null) {
      byType[row.type_registrant] = (byType[row.type_registrant] || 0) + 1
    }
    batch.push(row)
    if (batch.length >= UPSERT_BATCH) flushBatch()
    if (limit && parsed >= limit) break
  }
  flushBatch()

  const durationMs = Date.now() - started
  if (!silent) {
    console.log(`[faa-registry] lines=${lineNo} parsed=${parsed} skipped=${skipped} changed=${changed} unchanged=${unchanged} in ${(durationMs/1000).toFixed(1)}s`)
    console.log(`[faa-registry] registrant type histogram:`, byType)
  }
  return { parsed, skipped, changed, unchanged, durationMs, byType }
}

// SHA-256 of a file, computed in streaming 64KB chunks. Used to skip the
// 311k-row upsert on weeks when the FAA snapshot is byte-identical to last
// week's (most weeks).
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(filePath)
    s.on('data', chunk => h.update(chunk))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

// Full pipeline: download → hash-check → unzip → ingest → cleanup.
// v5.7 write-reduction: if the downloaded zip's SHA-256 matches the last
// successful ingest, skip the 311k-row upsert entirely. On weeks when FAA
// hasn't rolled the snapshot (common — most weekday refreshes touch only a
// handful of rows but the zip itself often stays identical), this cuts the
// write from hundreds of thousands of UPSERTs to zero.
//
// `force: true` bypasses the hash check (use for manual backfills / tests).
async function fetchAndIngest({ limit = null, silent = false, force = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faa-registry-'))
  const zipPath = path.join(tmpDir, 'ReleasableAircraft.zip')
  const masterPath = path.join(tmpDir, 'MASTER.txt')

  try {
    if (!silent) console.log(`[faa-registry] downloading ${FAA_ZIP_URL}…`)
    const zipBytes = await downloadZip(zipPath)
    if (!silent) console.log(`[faa-registry] downloaded ${(zipBytes/1024/1024).toFixed(1)} MB`)

    // Hash-skip gate — runs BEFORE unzip + ingest for maximum savings.
    const zipHash = await sha256File(zipPath)
    const prevState = db.getIngestState(INGEST_SOURCE)
    if (!force && prevState && prevState.success && prevState.last_hash === zipHash) {
      if (!silent) console.log(`[faa-registry] zip hash unchanged since ${prevState.last_ingest_at} — skipping ingest (0 writes)`)
      // Still bump last_ingest_at so staleness checks don't re-trigger.
      db.setIngestState(INGEST_SOURCE, { last_hash: zipHash, success: 1 })
      return { skipped: true, reason: 'hash-unchanged', zipHash }
    }

    if (!silent) console.log(`[faa-registry] extracting MASTER.txt…`)
    const masterBytes = await extractMasterTxt(zipPath, masterPath)
    if (!silent) console.log(`[faa-registry] extracted ${(masterBytes/1024/1024).toFixed(1)} MB`)

    const result = await ingestMasterFile(masterPath, { limit, silent })
    if (!silent) console.log(`[faa-registry] faa_registry now holds ${db.getFaaRegistryCount().toLocaleString()} rows`)

    // Record the hash so next week's job can short-circuit.
    db.setIngestState(INGEST_SOURCE, { last_hash: zipHash, success: 1 })
    return { ...result, skipped: false, zipHash }
  } catch (err) {
    // Persist failure so a retry runs even if the hash would have matched.
    try { db.setIngestState(INGEST_SOURCE, { success: 0, metadata: err.message }) } catch (_) {}
    throw err
  } finally {
    // Clean up temp files regardless of outcome
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    catch (e) { console.warn('[faa-registry] temp cleanup failed:', e.message) }
  }
}

// ── Staleness checks / startup self-heal ────────────────────────────────────

function shouldIngest({ stalenessMs = STALENESS_MS } = {}) {
  const count = db.getFaaRegistryCount()
  if (count === 0) return { needed: true, reason: 'empty' }
  const mostRecent = db.getFaaRegistryMostRecent()
  if (!mostRecent) return { needed: true, reason: 'no-timestamp' }
  // updated_at is stored as `datetime('now')` (UTC, SQLite format without 'Z')
  const ageMs = Date.now() - Date.parse(mostRecent + 'Z')
  if (ageMs > stalenessMs) {
    return { needed: true, reason: `stale (${(ageMs/86400e3).toFixed(1)}d)` }
  }
  return { needed: false, ageMs, count }
}

// Call from the Express startup path. Non-blocking: kicks off the job on the
// next tick so the server starts listening immediately. Logs & swallows
// errors so a transient FAA outage never crashes the process.
function scheduleStartupIngest({ stalenessMs = STALENESS_MS } = {}) {
  setImmediate(async () => {
    try {
      const check = shouldIngest({ stalenessMs })
      if (!check.needed) {
        console.log(`[faa-registry] skip startup ingest — ${check.count.toLocaleString()} rows, age ${(check.ageMs/86400e3).toFixed(1)}d`)
        return
      }
      console.log(`[faa-registry] startup ingest triggered (${check.reason})`)
      await fetchAndIngest({ silent: false })
    } catch (err) {
      console.error('[faa-registry] startup ingest failed:', err.message)
    }
  })
}

// Weekly re-ingest for warm machines. Returns the timer handle so callers
// can clearInterval in tests.
function scheduleWeeklyRefresh({ intervalMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  return setInterval(async () => {
    try {
      console.log('[faa-registry] weekly refresh starting…')
      await fetchAndIngest({ silent: false })
    } catch (err) {
      console.error('[faa-registry] weekly refresh failed:', err.message)
    }
  }, intervalMs).unref()  // unref so it doesn't block process exit in CLI use
}

module.exports = {
  // Pipeline
  fetchAndIngest,
  ingestMasterFile,
  downloadZip,
  extractMasterTxt,
  parseMasterLine,
  // Staleness / scheduling
  shouldIngest,
  scheduleStartupIngest,
  scheduleWeeklyRefresh,
  // Config exposed for tests
  STALENESS_MS,
}
