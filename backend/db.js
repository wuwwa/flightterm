const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { isEnabled: s3Enabled, archiveOldDaily } = require('./s3archive')

const DB_DIR = process.env.DB_DIR || __dirname
const DB_PATH = path.join(DB_DIR, 'flightterm.db')
const db = new Database(DB_PATH)

// ── pragmas for performance ─────────────────────────────────────────────────
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
db.pragma('cache_size = -16000') // 16 MB cache

// ── schema migration ────────────────────────────────────────────────────────
// v2: dropped lat, lon, mil, source, region from sightings (moved to fetches table)

db.exec(`
  -- Per-fetch metadata (one row per fetch cycle)
  CREATE TABLE IF NOT EXISTS fetches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT    NOT NULL,
    region      TEXT,
    aircraft_count INTEGER DEFAULT 0,
    fetched_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_fetches_at ON fetches(fetched_at);

  CREATE TABLE IF NOT EXISTS api_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service     TEXT    NOT NULL,
    endpoint    TEXT    NOT NULL,
    region      TEXT,
    credits     REAL    NOT NULL DEFAULT 0,
    status      INTEGER,
    aircraft_count INTEGER DEFAULT 0,
    rate_remaining INTEGER,
    called_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_api_usage_service   ON api_usage(service);
  CREATE INDEX IF NOT EXISTS idx_api_usage_called_at ON api_usage(called_at);
`)

// Migrate sightings table: drop lat, lon, mil, source, region if old schema exists
const colInfo = db.prepare("PRAGMA table_info('sightings')").all()
const colNames = colInfo.map(c => c.name)
const hasOldSchema = colNames.includes('lat') && colNames.includes('source')

if (hasOldSchema && colInfo.length > 0) {
  console.log('db: migrating sightings table (dropping lat, lon, mil, source, region)...')

  db.exec(`
    -- Archive lat/lon into daily before dropping
    CREATE TABLE IF NOT EXISTS sightings_daily (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT    NOT NULL,
      icao            TEXT    NOT NULL,
      callsign        TEXT,
      country         TEXT,
      source          TEXT,
      region          TEXT,
      sighting_count  INTEGER DEFAULT 1,
      avg_lat         REAL,
      avg_lon         REAL,
      avg_alt         REAL,
      avg_vel         REAL,
      min_alt         REAL,
      max_alt         REAL,
      mil             INTEGER DEFAULT 0,
      first_seen      TEXT,
      last_seen       TEXT,
      UNIQUE(date, icao, callsign)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_date ON sightings_daily(date);
    CREATE INDEX IF NOT EXISTS idx_daily_icao ON sightings_daily(icao);
  `)

  // Archive everything into daily summaries before dropping columns
  db.prepare(`
    INSERT OR REPLACE INTO sightings_daily (date, icao, callsign, country, source, region, sighting_count, avg_lat, avg_lon, avg_alt, avg_vel, min_alt, max_alt, mil, first_seen, last_seen)
    SELECT
      DATE(seen_at) as date, icao, callsign, country, source, region,
      COUNT(*) as sighting_count,
      AVG(lat) as avg_lat, AVG(lon) as avg_lon,
      AVG(alt) as avg_alt, AVG(vel) as avg_vel,
      MIN(alt) as min_alt, MAX(alt) as max_alt,
      MAX(mil) as mil,
      MIN(seen_at) as first_seen, MAX(seen_at) as last_seen
    FROM sightings
    GROUP BY DATE(seen_at), icao, callsign
  `).run()

  // Backfill fetches table from old sightings
  db.prepare(`
    INSERT INTO fetches (source, region, aircraft_count, fetched_at)
    SELECT source, region, COUNT(*), seen_at
    FROM sightings
    WHERE source IS NOT NULL
    GROUP BY seen_at
  `).run()

  // Recreate sightings with lean schema
  db.exec(`
    CREATE TABLE sightings_v2 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      icao        TEXT    NOT NULL,
      callsign    TEXT,
      country     TEXT,
      alt         REAL,
      vel         REAL,
      hdg         REAL,
      grounded    INTEGER DEFAULT 0,
      squawk      TEXT,
      fetch_id    INTEGER,
      seen_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO sightings_v2 (icao, callsign, country, alt, vel, hdg, grounded, squawk, seen_at)
    SELECT icao, callsign, country, alt, vel, hdg, grounded, squawk, seen_at
    FROM sightings;

    DROP TABLE sightings;
    ALTER TABLE sightings_v2 RENAME TO sightings;

    CREATE INDEX IF NOT EXISTS idx_sightings_icao     ON sightings(icao);
    CREATE INDEX IF NOT EXISTS idx_sightings_seen_at  ON sightings(seen_at);
    CREATE INDEX IF NOT EXISTS idx_sightings_callsign ON sightings(callsign);
    CREATE INDEX IF NOT EXISTS idx_sightings_icao_seen ON sightings(icao, seen_at DESC);
  `)

  console.log('db: migration complete — running VACUUM...')
  db.exec('VACUUM')
  console.log(`db: post-migration size: ${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB`)

} else if (colInfo.length === 0) {
  // Fresh database — create lean schema directly
  db.exec(`
    CREATE TABLE IF NOT EXISTS sightings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      icao        TEXT    NOT NULL,
      callsign    TEXT,
      country     TEXT,
      alt         REAL,
      vel         REAL,
      hdg         REAL,
      grounded    INTEGER DEFAULT 0,
      squawk      TEXT,
      fetch_id    INTEGER,
      seen_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sightings_icao     ON sightings(icao);
    CREATE INDEX IF NOT EXISTS idx_sightings_seen_at  ON sightings(seen_at);
    CREATE INDEX IF NOT EXISTS idx_sightings_callsign ON sightings(callsign);
    CREATE INDEX IF NOT EXISTS idx_sightings_icao_seen ON sightings(icao, seen_at DESC);

    CREATE TABLE IF NOT EXISTS sightings_daily (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT    NOT NULL,
      icao            TEXT    NOT NULL,
      callsign        TEXT,
      country         TEXT,
      source          TEXT,
      region          TEXT,
      sighting_count  INTEGER DEFAULT 1,
      avg_lat         REAL,
      avg_lon         REAL,
      avg_alt         REAL,
      avg_vel         REAL,
      min_alt         REAL,
      max_alt         REAL,
      mil             INTEGER DEFAULT 0,
      first_seen      TEXT,
      last_seen       TEXT,
      UNIQUE(date, icao, callsign)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_date ON sightings_daily(date);
    CREATE INDEX IF NOT EXISTS idx_daily_icao ON sightings_daily(icao);
  `)
} else {
  // Already migrated — ensure daily table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS sightings_daily (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT    NOT NULL,
      icao            TEXT    NOT NULL,
      callsign        TEXT,
      country         TEXT,
      source          TEXT,
      region          TEXT,
      sighting_count  INTEGER DEFAULT 1,
      avg_lat         REAL,
      avg_lon         REAL,
      avg_alt         REAL,
      avg_vel         REAL,
      min_alt         REAL,
      max_alt         REAL,
      mil             INTEGER DEFAULT 0,
      first_seen      TEXT,
      last_seen       TEXT,
      UNIQUE(date, icao, callsign)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_date ON sightings_daily(date);
    CREATE INDEX IF NOT EXISTS idx_daily_icao ON sightings_daily(icao);
  `)
}

// ── prepared statements (pre-compiled once) ─────────────────────────────────

const _stmts = {
  insert: db.prepare(`
    INSERT INTO sightings (icao, callsign, country, alt, vel, hdg, grounded, squawk, fetch_id, seen_at)
    VALUES (@icao, @callsign, @country, @alt, @vel, @hdg, @grounded, @squawk, @fetch_id, @seen_at)
  `),

  insertFetch: db.prepare(`
    INSERT INTO fetches (source, region, aircraft_count, fetched_at)
    VALUES (@source, @region, @aircraft_count, @fetched_at)
  `),

  aircraftTrack: db.prepare(`
    SELECT alt, vel, hdg, grounded, seen_at FROM sightings
    WHERE icao = ? ORDER BY seen_at DESC LIMIT ?
  `),

  aircraftHistory: db.prepare(`
    SELECT * FROM sightings WHERE icao = ? ORDER BY seen_at DESC LIMIT ?
  `),

  uniqueSeen: {
    base: `SELECT icao, callsign, country,
           COUNT(*) as times_seen,
           MIN(seen_at) as first_seen,
           MAX(seen_at) as last_seen
    FROM sightings WHERE `,
  },

  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sightings) +
      (SELECT COALESCE(SUM(sighting_count), 0) FROM sightings_daily) AS total_sightings,
      (SELECT COUNT(DISTINCT icao) FROM (
        SELECT icao FROM sightings UNION SELECT icao FROM sightings_daily
      )) AS unique_aircraft,
      (SELECT COUNT(DISTINCT callsign) FROM (
        SELECT callsign FROM sightings WHERE callsign IS NOT NULL
        UNION SELECT callsign FROM sightings_daily WHERE callsign IS NOT NULL
      )) AS unique_callsigns,
      (SELECT COUNT(DISTINCT country) FROM (
        SELECT country FROM sightings WHERE country IS NOT NULL
        UNION SELECT country FROM sightings_daily WHERE country IS NOT NULL
      )) AS unique_countries,
      (SELECT MIN(t) FROM (
        SELECT MIN(seen_at) as t FROM sightings UNION ALL SELECT MIN(first_seen) FROM sightings_daily
      )) AS first_record,
      (SELECT MAX(t) FROM (
        SELECT MAX(seen_at) as t FROM sightings UNION ALL SELECT MAX(last_seen) FROM sightings_daily
      )) AS last_record
  `),

  topAircraft: db.prepare(`
    SELECT icao, callsign, country, SUM(cnt) as times_seen, MAX(ls) as last_seen FROM (
      SELECT icao, callsign, country, COUNT(*) as cnt, MAX(seen_at) as ls FROM sightings GROUP BY icao
      UNION ALL
      SELECT icao, callsign, country, sighting_count as cnt, last_seen as ls FROM sightings_daily
    ) GROUP BY icao ORDER BY times_seen DESC LIMIT ?
  `),

  topCountries: db.prepare(`
    SELECT country, COUNT(DISTINCT icao) as unique_aircraft, SUM(cnt) as sightings FROM (
      SELECT country, icao, COUNT(*) as cnt FROM sightings WHERE country IS NOT NULL GROUP BY country, icao
      UNION ALL
      SELECT country, icao, sighting_count as cnt FROM sightings_daily WHERE country IS NOT NULL
    ) GROUP BY country ORDER BY unique_aircraft DESC LIMIT ?
  `),

  hourlyActivity: db.prepare(`
    SELECT
      CAST(strftime('%H', seen_at) AS INTEGER) AS hour,
      COUNT(DISTINCT icao) AS unique_aircraft,
      COUNT(*) AS sightings
    FROM sightings
    GROUP BY hour
    ORDER BY hour
  `),

  recentFetches: db.prepare(`
    SELECT fetched_at as seen_at, source, region, aircraft_count
    FROM fetches
    ORDER BY fetched_at DESC
    LIMIT ?
  `),

  insertApiCall: db.prepare(`
    INSERT INTO api_usage (service, endpoint, region, credits, status, aircraft_count, rate_remaining, called_at)
    VALUES (@service, @endpoint, @region, @credits, @status, @aircraft_count, @rate_remaining, @called_at)
  `),

  todayCredits: db.prepare(`
    SELECT COALESCE(SUM(credits), 0) AS credits_used, COUNT(*) AS calls
    FROM api_usage WHERE service = ? AND called_at >= ?
  `),

  dailyUsage: db.prepare(`
    SELECT DATE(called_at) AS date, COUNT(*) AS calls, SUM(credits) AS credits, SUM(aircraft_count) AS aircraft
    FROM api_usage WHERE service = ? AND called_at >= DATE('now', ?)
    GROUP BY DATE(called_at) ORDER BY date DESC
  `),

  recentCalls: db.prepare(`
    SELECT * FROM api_usage WHERE service = ? ORDER BY called_at DESC LIMIT ?
  `),

  aeroSpendTotal: db.prepare(`
    SELECT COALESCE(SUM(credits), 0) AS total_spend, COUNT(*) AS total_calls
    FROM api_usage WHERE service = 'aeroapi'
  `),

  aeroSpendMonth: db.prepare(`
    SELECT COALESCE(SUM(credits), 0) AS month_spend, COUNT(*) AS month_calls
    FROM api_usage WHERE service = 'aeroapi' AND called_at >= ?
  `),

  // Purge helpers
  archiveToDailySummary: db.prepare(`
    INSERT OR REPLACE INTO sightings_daily (date, icao, callsign, country, sighting_count, avg_alt, avg_vel, min_alt, max_alt, first_seen, last_seen)
    SELECT
      DATE(seen_at) as date, icao, callsign, country,
      COUNT(*) as sighting_count,
      AVG(alt) as avg_alt, AVG(vel) as avg_vel,
      MIN(alt) as min_alt, MAX(alt) as max_alt,
      MIN(seen_at) as first_seen, MAX(seen_at) as last_seen
    FROM sightings
    WHERE seen_at < ?
    GROUP BY DATE(seen_at), icao, callsign
  `),

  deleteOldSightings: db.prepare(`DELETE FROM sightings WHERE seen_at < ?`),
  deleteOldFetches: db.prepare(`DELETE FROM fetches WHERE fetched_at < ?`),

  countSightings: db.prepare(`SELECT COUNT(*) as c FROM sightings`),
  countDaily: db.prepare(`SELECT COUNT(*) as c FROM sightings_daily`),
}

// ── in-memory dedup cache ───────────────────────────────────────────────────
// Tracks last known values per icao to skip writes when nothing meaningful changed
// { icao: { alt, vel, hdg, grounded, ts } }
const _lastSeen = new Map()
const DEDUP_ALT_THRESHOLD = 100    // 100 meters
const DEDUP_VEL_THRESHOLD = 10     // 10 m/s
const DEDUP_HDG_THRESHOLD = 5      // 5 degrees
const DEDUP_TIME_MAX = 300_000     // always write if >5 min since last record

// Warm the cache from the most recent fetch
function _warmDedup() {
  const rows = db.prepare(`
    SELECT icao, alt, vel, hdg, grounded, seen_at
    FROM sightings
    WHERE seen_at = (SELECT MAX(seen_at) FROM sightings)
  `).all()
  for (const r of rows) {
    _lastSeen.set(r.icao, {
      alt: r.alt, vel: r.vel, hdg: r.hdg,
      grounded: r.grounded,
      ts: new Date(r.seen_at).getTime(),
    })
  }
  console.log(`  dedup cache warmed: ${_lastSeen.size} aircraft`)
}

// ── transactional batch insert with dedup ───────────────────────────────────

const _insertMany = db.transaction((rows) => {
  for (const row of rows) _stmts.insert.run(row)
})

function recordSightings(flights, source, region) {
  const now = new Date().toISOString()
  const nowMs = Date.now()

  // Record fetch metadata
  const fetchResult = _stmts.insertFetch.run({
    source,
    region: region || null,
    aircraft_count: flights.length,
    fetched_at: now,
  })
  const fetchId = Number(fetchResult.lastInsertRowid)

  const rows = []

  for (const f of flights) {
    const prev = _lastSeen.get(f.icao)
    if (prev) {
      const timeDelta = nowMs - prev.ts
      const altSame = Math.abs((f.alt ?? 0) - (prev.alt ?? 0)) < DEDUP_ALT_THRESHOLD
      const velSame = Math.abs((f.vel ?? 0) - (prev.vel ?? 0)) < DEDUP_VEL_THRESHOLD
      let hdgDelta = Math.abs((f.hdg ?? 0) - (prev.hdg ?? 0))
      if (hdgDelta > 180) hdgDelta = 360 - hdgDelta
      const hdgSame = hdgDelta < DEDUP_HDG_THRESHOLD
      const groundSame = (f.grounded ? 1 : 0) === prev.grounded

      // Skip if nothing meaningful changed and it's been less than 5 min
      if (altSame && velSame && hdgSame && groundSame && timeDelta < DEDUP_TIME_MAX) {
        continue
      }
    }

    rows.push({
      icao:     f.icao,
      callsign: f.callsign || null,
      country:  f.country || null,
      alt:      f.alt ?? null,
      vel:      f.vel ?? null,
      hdg:      f.hdg ?? null,
      grounded: f.grounded ? 1 : 0,
      squawk:   f.squawk || null,
      fetch_id: fetchId,
      seen_at:  now,
    })

    // Update cache
    _lastSeen.set(f.icao, {
      alt: f.alt ?? null, vel: f.vel ?? null, hdg: f.hdg ?? null,
      grounded: f.grounded ? 1 : 0,
      ts: nowMs,
    })
  }

  if (rows.length > 0) _insertMany(rows)
  return rows.length
}

// ── query helpers ───────────────────────────────────────────────────────────

function getAircraftHistory(icao, limit = 100) {
  return _stmts.aircraftHistory.all(icao, limit)
}

function getAircraftTrack(icao, limit = 60) {
  return _stmts.aircraftTrack.all(icao, limit).reverse()
}

function getUniqueSeen(since, until) {
  const params = {}
  let where = '1=1'
  if (since) { where += ' AND seen_at >= @since'; params.since = since }
  if (until) { where += ' AND seen_at <= @until'; params.until = until }
  return db.prepare(`${_stmts.uniqueSeen.base} ${where} GROUP BY icao ORDER BY last_seen DESC`).all(params)
}

function getStats() {
  return _stmts.stats.get()
}

function getTopAircraft(limit = 20) {
  return _stmts.topAircraft.all(limit)
}

function getTopCountries(limit = 20) {
  return _stmts.topCountries.all(limit)
}

function getHourlyActivity() {
  return _stmts.hourlyActivity.all()
}

function getRecentFetches(limit = 20) {
  return _stmts.recentFetches.all(limit)
}

// ── API usage tracking ──────────────────────────────────────────────────────

function calcOpenSkyCredits(query) {
  const { lamin, lamax, lomin, lomax } = query
  if (!lamin || !lamax || !lomin || !lomax) return 4
  const area = Math.abs(lamax - lamin) * Math.abs(lomax - lomin)
  if (area <= 25) return 1
  if (area <= 100) return 2
  if (area <= 400) return 3
  return 4
}

function recordApiCall({ service, endpoint, region, credits, status, aircraftCount, rateRemaining }) {
  return _stmts.insertApiCall.run({
    service,
    endpoint,
    region: region || null,
    credits: credits || 0,
    status: status || 200,
    aircraft_count: aircraftCount || 0,
    rate_remaining: rateRemaining ?? null,
    called_at: new Date().toISOString(),
  })
}

function getUsageSummary(service, since, until) {
  const params = { service }
  let where = 'service = @service'
  if (since) { where += ' AND called_at >= @since'; params.since = since }
  if (until) { where += ' AND called_at <= @until'; params.until = until }
  return db.prepare(`
    SELECT service, COUNT(*) AS total_calls, SUM(credits) AS total_credits,
           SUM(aircraft_count) AS total_aircraft, MIN(called_at) AS first_call,
           MAX(called_at) AS last_call, MIN(rate_remaining) AS min_rate_remaining
    FROM api_usage WHERE ${where}
  `).get(params)
}

function getTodayCredits(service) {
  const today = new Date().toISOString().substring(0, 10)
  return _stmts.todayCredits.get(service, today)
}

function getDailyUsage(service, days = 30) {
  return _stmts.dailyUsage.all(service, `-${days} days`)
}

function getRecentCalls(service, limit = 50) {
  return _stmts.recentCalls.all(service, limit)
}

function getAeroSpendTotal() {
  return _stmts.aeroSpendTotal.get()
}

function getAeroSpendMonth() {
  const monthStart = new Date().toISOString().substring(0, 7) + '-01'
  return _stmts.aeroSpendMonth.get(monthStart)
}

function getDbSize() {
  try { return fs.statSync(DB_PATH).size } catch { return 0 }
}

// ── auto-purge: archive old sightings into daily summaries ──────────────────
const PURGE_AFTER_DAYS = 7

function purgeOldSightings() {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 86400000).toISOString()
  const before = _stmts.countSightings.get().c

  const archiveAndDelete = db.transaction(() => {
    _stmts.archiveToDailySummary.run(cutoff)
    const del = _stmts.deleteOldSightings.run(cutoff)
    _stmts.deleteOldFetches.run(cutoff)
    return del.changes
  })

  const deleted = archiveAndDelete()
  if (deleted > 0) {
    db.exec('ANALYZE')
    console.log(`  purge: archived ${deleted} sightings older than ${PURGE_AFTER_DAYS}d (${before} → ${_stmts.countSightings.get().c} rows)`)
  }
  return deleted
}

// ── purge old daily summaries (fallback when S3 is disabled) ────────────────
const { ARCHIVE_AFTER_DAYS } = require('./s3archive')
const DAILY_RETENTION_DAYS = ARCHIVE_AFTER_DAYS // same threshold: 30 days default

function purgeOldDailySummaries() {
  const cutoff = new Date(Date.now() - DAILY_RETENTION_DAYS * 86400000)
    .toISOString()
    .slice(0, 10)
  const before = _stmts.countDaily.get().c
  const del = db.prepare('DELETE FROM sightings_daily WHERE date < ?').run(cutoff)
  if (del.changes > 0) {
    console.log(`  purge: deleted ${del.changes} daily summaries older than ${DAILY_RETENTION_DAYS}d (${before} → ${_stmts.countDaily.get().c} rows)`)
  }
  return del.changes
}

// ── startup dedup of existing data ──────────────────────────────────────────

function deduplicateExisting() {
  const before = _stmts.countSightings.get().c
  if (before === 0) return 0

  console.log(`  dedup: scanning ${before} rows...`)

  const deleted = db.transaction(() => {
    const result = db.prepare(`
      DELETE FROM sightings WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 alt, vel, hdg, grounded,
                 LAG(alt) OVER w as prev_alt,
                 LAG(vel) OVER w as prev_vel,
                 LAG(hdg) OVER w as prev_hdg,
                 LAG(grounded) OVER w as prev_grounded
          FROM sightings
          WINDOW w AS (PARTITION BY icao ORDER BY seen_at, id)
        )
        WHERE prev_alt IS NOT NULL
          AND ABS(COALESCE(alt, 0) - COALESCE(prev_alt, 0)) < ${DEDUP_ALT_THRESHOLD}
          AND ABS(COALESCE(vel, 0) - COALESCE(prev_vel, 0)) < ${DEDUP_VEL_THRESHOLD}
          AND CASE
                WHEN ABS(COALESCE(hdg, 0) - COALESCE(prev_hdg, 0)) > 180
                THEN 360 - ABS(COALESCE(hdg, 0) - COALESCE(prev_hdg, 0))
                ELSE ABS(COALESCE(hdg, 0) - COALESCE(prev_hdg, 0))
              END < ${DEDUP_HDG_THRESHOLD}
          AND grounded = prev_grounded
      )
    `).run()
    return result.changes
  })()

  const after = _stmts.countSightings.get().c
  console.log(`  dedup: removed ${deleted} duplicate rows (${before} → ${after})`)

  if (deleted > 0) db.exec('ANALYZE')
  return deleted
}

// ── VACUUM to reclaim space after purges ────────────────────────────────────
function vacuumDb() {
  const sizeBefore = getDbSize()
  db.exec('VACUUM')
  const sizeAfter = getDbSize()
  const saved = sizeBefore - sizeAfter
  if (saved > 0) {
    console.log(`  vacuum: ${(sizeBefore / 1048576).toFixed(1)} MB → ${(sizeAfter / 1048576).toFixed(1)} MB (saved ${(saved / 1048576).toFixed(1)} MB)`)
  }
}

// ── startup maintenance ─────────────────────────────────────────────────────
function runStartupMaintenance() {
  console.log('db: running startup maintenance...')
  deduplicateExisting()
  purgeOldSightings()
  vacuumDb()
  _warmDedup()
  console.log(`db: ready (${(_stmts.countSightings.get().c).toLocaleString()} sightings, ${(_stmts.countDaily.get().c).toLocaleString()} daily summaries, ${(getDbSize() / 1048576).toFixed(1)} MB)`)
}

// Run maintenance on module load (server startup)
runStartupMaintenance()

// Run S3 archival or fallback purge on startup (non-blocking)
;(async () => {
  try {
    if (s3Enabled()) {
      const { archived } = await archiveOldDaily(db)
      if (archived > 0) vacuumDb()
    } else {
      // No S3 — purge old daily summaries so the DB doesn't grow forever
      if (purgeOldDailySummaries() > 0) vacuumDb()
    }
  } catch (err) {
    console.error('startup archive/purge error:', err.message)
  }
})()

// Schedule periodic purge every 6 hours
setInterval(async () => {
  try {
    purgeOldSightings()
    if (s3Enabled()) {
      await archiveOldDaily(db)
    } else {
      purgeOldDailySummaries()
    }
    vacuumDb()
  } catch (err) {
    console.error('purge/archive error:', err.message)
  }
}, 6 * 3600 * 1000)

// ── exports ─────────────────────────────────────────────────────────────────

module.exports = {
  db,
  recordSightings,
  getAircraftHistory,
  getAircraftTrack,
  getUniqueSeen,
  getStats,
  getTopAircraft,
  getTopCountries,
  getHourlyActivity,
  getRecentFetches,
  getDbSize,
  calcOpenSkyCredits,
  recordApiCall,
  getUsageSummary,
  getTodayCredits,
  getDailyUsage,
  getRecentCalls,
  getAeroSpendTotal,
  getAeroSpendMonth,
  purgeOldSightings,
  deduplicateExisting,
  vacuumDb,
  DB_PATH,
}
