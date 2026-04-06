const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { isEnabled: s3Enabled, archiveBeforePurge } = require('./s3archive')

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
      lat         REAL,
      lon         REAL,
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
      lat         REAL,
      lon         REAL,
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
}

// ── v3 migration: add lat/lon back to sightings ──────────────────────────────
const v3Cols = db.prepare("PRAGMA table_info('sightings')").all().map(c => c.name)
if (v3Cols.length > 0 && !v3Cols.includes('lat')) {
  console.log('db: adding lat/lon columns to sightings...')
  db.exec(`
    ALTER TABLE sightings ADD COLUMN lat REAL;
    ALTER TABLE sightings ADD COLUMN lon REAL;
  `)
  console.log('db: lat/lon columns added')
}

{
  // Ensure daily table exists
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

// ── anomalies table ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS anomalies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    icao        TEXT    NOT NULL,
    callsign    TEXT,
    score       INTEGER NOT NULL,
    phase       TEXT,
    reasons     TEXT,
    confirmed   INTEGER DEFAULT 0,
    lat         REAL,
    lon         REAL,
    alt         REAL,
    vel         REAL,
    hdg         REAL,
    squawk      TEXT,
    region      TEXT,
    resolved    INTEGER DEFAULT 0,
    resolved_at TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_anomalies_icao ON anomalies(icao);
  CREATE INDEX IF NOT EXISTS idx_anomalies_detected ON anomalies(detected_at);
  CREATE INDEX IF NOT EXISTS idx_anomalies_score ON anomalies(score DESC);
  CREATE INDEX IF NOT EXISTS idx_anomalies_resolved ON anomalies(resolved);
`)

// ── v4 migration: add category + severity to anomalies ──────────────────────
{
  const cols = db.pragma('table_info(anomalies)').map(c => c.name)
  if (!cols.includes('category')) {
    db.exec(`ALTER TABLE anomalies ADD COLUMN category TEXT`)
    db.exec(`ALTER TABLE anomalies ADD COLUMN severity TEXT`)
    db.exec(`ALTER TABLE anomalies ADD COLUMN categories TEXT`) // JSON array of all triggered categories
    db.exec(`CREATE INDEX IF NOT EXISTS idx_anomalies_category ON anomalies(category)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_anomalies_severity ON anomalies(severity)`)
  }
}

// ── v5 migration: add weather_context to anomalies ──────────────────────────
{
  const cols = db.pragma('table_info(anomalies)').map(c => c.name)
  if (!cols.includes('weather_context')) {
    db.exec(`ALTER TABLE anomalies ADD COLUMN weather_context TEXT`) // JSON weather snapshot
  }
}

// ── v6 migration: add feedback column to anomalies ─────────────────────────
// Stores user feedback inline: 'false_positive', 'confirmed_real', or null.
// Simpler than a separate table — each anomaly gets at most one verdict.
{
  const cols = db.pragma('table_info(anomalies)').map(c => c.name)
  if (!cols.includes('feedback')) {
    db.exec(`ALTER TABLE anomalies ADD COLUMN feedback TEXT`)       // 'false_positive' | 'confirmed_real' | null
    db.exec(`ALTER TABLE anomalies ADD COLUMN feedback_note TEXT`)  // optional user note
    db.exec(`ALTER TABLE anomalies ADD COLUMN feedback_at TEXT`)    // timestamp
  }
}

// ── callsign route cache ─────────────────────────────────────────────────────
// Stores callsign→route mappings so diversion detection works for all aircraft,
// not just ones the user has clicked on. Routes are stable per callsign (e.g.
// UAL123 is almost always the same city pair). Cache self-corrects via staleness
// checks and heading-vs-destination mismatch detection.
db.exec(`
  CREATE TABLE IF NOT EXISTS callsign_routes (
    callsign        TEXT PRIMARY KEY,
    origin_icao     TEXT,
    origin_lat      REAL,
    origin_lon      REAL,
    destination_icao TEXT,
    destination_lat REAL,
    destination_lon REAL,
    source          TEXT DEFAULT 'adsbdb',
    last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_routes_updated ON callsign_routes(updated_at);
`)

// ── Aircraft enrichment cache (type, reg, operator by ICAO hex) ─────────────
// Populated by poller's background enrichment. Survives restarts.
// 30-day staleness — aircraft rarely change type/reg.
db.exec(`
  CREATE TABLE IF NOT EXISTS aircraft_cache (
    icao        TEXT PRIMARY KEY,
    type        TEXT,
    reg         TEXT,
    desc        TEXT,
    operator    TEXT,
    source      TEXT DEFAULT 'adsbdb',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ── Zone baseline tracking (daily anomaly counts per grid cell) ─────────────
// Rolled up daily from the anomalies table. Builds a per-zone baseline so we
// can detect when a zone is unusually active vs its historical norm.
// Grid cells match the hotspot query: ROUND(lat*2)/2, ROUND(lon*2)/2 (~0.5°)
db.exec(`
  CREATE TABLE IF NOT EXISTS zone_daily (
    date        TEXT NOT NULL,
    cell_lat    REAL NOT NULL,
    cell_lon    REAL NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    critical    INTEGER NOT NULL DEFAULT 0,
    high        INTEGER NOT NULL DEFAULT 0,
    medium      INTEGER NOT NULL DEFAULT 0,
    unique_aircraft INTEGER NOT NULL DEFAULT 0,
    categories  TEXT,
    PRIMARY KEY (date, cell_lat, cell_lon)
  );
  CREATE INDEX IF NOT EXISTS idx_zone_daily_date ON zone_daily(date);
`)

// ── Per-route baselines — learned norms from historical sightings ───────────
// Instead of static PHASE_NORMS, these capture what aircraft actually do on
// each route. Built from sightings + callsign_routes joins.
db.exec(`
  CREATE TABLE IF NOT EXISTS route_baselines (
    origin_icao      TEXT NOT NULL,
    destination_icao TEXT NOT NULL,
    sample_flights   INTEGER NOT NULL DEFAULT 0,
    sample_points    INTEGER NOT NULL DEFAULT 0,
    alt_rate_mean    REAL,      -- mean vertical rate across all sightings (m/s)
    alt_rate_std     REAL,      -- standard deviation of vertical rate
    alt_rate_p95     REAL,      -- 95th percentile absolute altitude rate
    vel_mean         REAL,      -- mean ground speed (m/s)
    vel_std          REAL,      -- standard deviation of speed
    max_alt_mean     REAL,      -- typical cruise altitude (m)
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (origin_icao, destination_icao)
  );
`)

// ── SWIM NOTAM storage ──────────────────────────────────────────────────────
// Stores NOTAMs from FAA FNS (Federal NOTAM System) via SWIM SCDS.
// Used for TFR detection, airport status, and anomaly suppression.
db.exec(`
  CREATE TABLE IF NOT EXISTS notams (
    id              TEXT PRIMARY KEY,
    location        TEXT,            -- airport ICAO or area code
    classification  TEXT,            -- FDC, NOTAM, etc.
    keyword         TEXT,            -- RWY, TWY, OBST, AIRSPACE, SVC, etc.
    scenario        TEXT,
    is_tfr          INTEGER DEFAULT 0,
    lat             REAL,
    lon             REAL,
    alt_lower       REAL,            -- feet (TFR lower altitude)
    alt_upper       REAL,            -- feet (TFR upper altitude)
    geometry        TEXT,            -- JSON array of [lat, lon] pairs (TFR boundary)
    effective       TEXT,            -- ISO datetime
    expiration      TEXT,            -- ISO datetime (null if permanent)
    permanent       INTEGER DEFAULT 0,
    text            TEXT,            -- NOTAM E-field text
    full_text       TEXT,            -- complete traditional message
    raw_xml         TEXT,            -- original AIXM XML (for debugging/reparse)
    received_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notams_location ON notams(location);
  CREATE INDEX IF NOT EXISTS idx_notams_tfr ON notams(is_tfr);
  CREATE INDEX IF NOT EXISTS idx_notams_effective ON notams(effective);
  CREATE INDEX IF NOT EXISTS idx_notams_expiration ON notams(expiration);
`)

// ── SWIM TFMS flight plans ──────────────────────────────────────────────────
// Stores filed flight plans from TFMS (Traffic Flow Management System).
// Keyed by acid (callsign) — updated as amendments arrive.
db.exec(`
  CREATE TABLE IF NOT EXISTS flight_plans (
    acid            TEXT NOT NULL,
    gufi            TEXT,
    dep_arpt        TEXT,
    arr_arpt        TEXT,
    aircraft_type   TEXT,
    altitude        TEXT,
    speed           TEXT,
    route           TEXT,
    flight_status   TEXT,
    etd             TEXT,
    eta             TEXT,
    atd             TEXT,
    ata             TEXT,
    beacon_code     TEXT,
    lat             REAL,
    lon             REAL,
    reported_alt    TEXT,
    msg_type        TEXT,
    received_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (acid)
  );
  CREATE INDEX IF NOT EXISTS idx_fp_dep ON flight_plans(dep_arpt);
  CREATE INDEX IF NOT EXISTS idx_fp_arr ON flight_plans(arr_arpt);
  CREATE INDEX IF NOT EXISTS idx_fp_status ON flight_plans(flight_status);
  CREATE INDEX IF NOT EXISTS idx_fp_updated ON flight_plans(updated_at);
  -- Compound indexes for analytics
  CREATE INDEX IF NOT EXISTS idx_fp_arr_status ON flight_plans(arr_arpt, flight_status);
  CREATE INDEX IF NOT EXISTS idx_fp_dep_arr ON flight_plans(dep_arpt, arr_arpt);
`)

// ── SWIM TFMS flow events ───────────────────────────────────────────────────
// Stores traffic management initiatives: GDPs, ground stops, AFPs, reroutes.
db.exec(`
  CREATE TABLE IF NOT EXISTS flow_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT NOT NULL,
    airport         TEXT,
    status          TEXT,
    reason          TEXT,
    text            TEXT,
    delay_minutes   REAL,
    start_time      TEXT,
    end_time        TEXT,
    msg_type        TEXT,
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_flow_airport ON flow_events(airport);
  CREATE INDEX IF NOT EXISTS idx_flow_type ON flow_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_flow_received ON flow_events(received_at);
`)

// v7 migration: add new columns to flow_events for RSTR/FXA data
{
  const cols = db.pragma('table_info(flow_events)').map(c => c.name)
  if (!cols.includes('facility')) {
    db.exec(`ALTER TABLE flow_events ADD COLUMN facility TEXT`)
    db.exec(`ALTER TABLE flow_events ADD COLUMN geometry TEXT`)  // JSON [[lat,lon], ...]
    db.exec(`ALTER TABLE flow_events ADD COLUMN ceiling TEXT`)
    db.exec(`ALTER TABLE flow_events ADD COLUMN floor TEXT`)
    db.exec(`ALTER TABLE flow_events ADD COLUMN restriction_type TEXT`)
    db.exec(`ALTER TABLE flow_events ADD COLUMN restriction_value TEXT`)
  }
}

// v8 migration: add route_deviation to flight_plans for analytics
{
  const cols = db.pragma('table_info(flight_plans)').map(c => c.name)
  if (!cols.includes('route_deviation')) {
    db.exec(`ALTER TABLE flight_plans ADD COLUMN route_deviation INTEGER`)
  }
}

// ── SWIM TFMS airport configurations ────────────────────────────────────────
// Real-time runway configs, arrival/departure rates, weather. Upserted by airport.
db.exec(`
  CREATE TABLE IF NOT EXISTS airport_configs (
    airport         TEXT PRIMARY KEY,
    facility        TEXT,
    arr_runway      TEXT,
    dep_runway      TEXT,
    arr_rate        INTEGER,
    dep_rate        INTEGER,
    weather         TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ── SWIM ITWS terminal weather ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS terminal_weather (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT NOT NULL,
    site            TEXT,
    airport         TEXT,
    severity        TEXT,
    lat             REAL,
    lon             REAL,
    altitude        TEXT,
    cell_id         TEXT,
    movement        TEXT,
    speed           TEXT,
    tops            TEXT,
    vil_level       TEXT,
    runway          TEXT,
    gain_loss       TEXT,
    text            TEXT,
    valid_time      TEXT,
    expiry_time     TEXT,
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tw_airport ON terminal_weather(airport);
  CREATE INDEX IF NOT EXISTS idx_tw_type ON terminal_weather(event_type);
  CREATE INDEX IF NOT EXISTS idx_tw_received ON terminal_weather(received_at);
`)

// ── SWIM STDDS surface/terminal data ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS surface_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    service         TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    airport         TEXT,
    tracon          TEXT,
    callsign        TEXT,
    lat             REAL,
    lon             REAL,
    altitude        TEXT,
    speed           REAL,
    heading         REAL,
    surface_event   TEXT,
    runway          TEXT,
    gate            TEXT,
    taxiway         TEXT,
    rvr             REAL,
    rvr_trend       TEXT,
    alert_type      TEXT,
    text            TEXT,
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_se_airport ON surface_events(airport);
  CREATE INDEX IF NOT EXISTS idx_se_callsign ON surface_events(callsign);
  CREATE INDEX IF NOT EXISTS idx_se_service ON surface_events(service);
  CREATE INDEX IF NOT EXISTS idx_se_received ON surface_events(received_at);
  CREATE INDEX IF NOT EXISTS idx_se_type ON surface_events(event_type);
  -- Compound indexes for analytics joins (taxi times, airline perf, turnarounds)
  CREATE INDEX IF NOT EXISTS idx_se_airport_type_received ON surface_events(airport, event_type, received_at);
  CREATE INDEX IF NOT EXISTS idx_se_callsign_type_received ON surface_events(callsign, event_type, received_at);
`)

// ── prepared statements (pre-compiled once) ─────────────────────────────────

const _stmts = {
  insert: db.prepare(`
    INSERT INTO sightings (icao, callsign, country, lat, lon, alt, vel, hdg, grounded, squawk, fetch_id, seen_at)
    VALUES (@icao, @callsign, @country, @lat, @lon, @alt, @vel, @hdg, @grounded, @squawk, @fetch_id, @seen_at)
  `),

  insertFetch: db.prepare(`
    INSERT INTO fetches (source, region, aircraft_count, fetched_at)
    VALUES (@source, @region, @aircraft_count, @fetched_at)
  `),

  aircraftTrack: db.prepare(`
    SELECT lat, lon, alt, vel, hdg, grounded, seen_at FROM sightings
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

  // Anomaly statements
  insertAnomaly: db.prepare(`
    INSERT INTO anomalies (icao, callsign, score, phase, reasons, confirmed, category, severity, categories, lat, lon, alt, vel, hdg, squawk, region, weather_context, detected_at)
    VALUES (@icao, @callsign, @score, @phase, @reasons, @confirmed, @category, @severity, @categories, @lat, @lon, @alt, @vel, @hdg, @squawk, @region, @weather_context, @detected_at)
  `),

  // Skip insert if same icao already has an unresolved anomaly within last 10 minutes
  findRecentAnomaly: db.prepare(`
    SELECT id FROM anomalies
    WHERE icao = ? AND resolved = 0 AND detected_at > datetime('now', '-10 minutes')
    LIMIT 1
  `),

  resolveAnomalies: db.prepare(`
    UPDATE anomalies SET resolved = 1, resolved_at = datetime('now')
    WHERE icao = ? AND resolved = 0
  `),

  recentAnomalies: db.prepare(`
    SELECT * FROM anomalies
    WHERE detected_at > datetime('now', '-1 hour')
    ORDER BY detected_at DESC LIMIT ?
  `),

  activeAnomalies: db.prepare(`
    SELECT * FROM anomalies WHERE resolved = 0 ORDER BY score DESC
  `),

  anomaliesByIcao: db.prepare(`
    SELECT * FROM anomalies WHERE icao = ? ORDER BY detected_at DESC LIMIT ?
  `),

  // Anomalies in a specific grid cell (for zone drilldown)
  anomaliesByZone: db.prepare(`
    SELECT * FROM anomalies
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND ROUND(lat * 2) / 2 = ? AND ROUND(lon * 2) / 2 = ?
      AND detected_at > datetime('now', ?)
    ORDER BY detected_at DESC
    LIMIT ?
  `),

  // Heatmap: recent sighting positions (1 per aircraft, most recent only)
  trafficHeatmap: db.prepare(`
    SELECT s.lat, s.lon FROM sightings s
    INNER JOIN (
      SELECT icao, MAX(seen_at) as max_seen FROM sightings
      WHERE seen_at > datetime('now', '-1 hour') AND lat IS NOT NULL AND lon IS NOT NULL
      GROUP BY icao
    ) latest ON s.icao = latest.icao AND s.seen_at = latest.max_seen
  `),

  anomalyStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) as confirmed,
      AVG(score) as avg_score,
      MAX(score) as max_score,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN category = 'SQUAWK' THEN 1 ELSE 0 END) as cat_squawk,
      SUM(CASE WHEN category = 'EMERGENCY' THEN 1 ELSE 0 END) as cat_emergency,
      SUM(CASE WHEN category = 'ALTITUDE' THEN 1 ELSE 0 END) as cat_altitude,
      SUM(CASE WHEN category = 'SPEED' THEN 1 ELSE 0 END) as cat_speed,
      SUM(CASE WHEN category = 'HEADING' THEN 1 ELSE 0 END) as cat_heading,
      SUM(CASE WHEN category = 'DIVERSION' THEN 1 ELSE 0 END) as cat_diversion,
      SUM(CASE WHEN category = 'PHASE' THEN 1 ELSE 0 END) as cat_phase,
      SUM(CASE WHEN category = 'INTENT' THEN 1 ELSE 0 END) as cat_intent,
      COUNT(DISTINCT icao) as unique_aircraft
    FROM anomalies
    WHERE detected_at > datetime('now', '-24 hours')
  `),

  // Mean time to resolution (only for resolved anomalies in last 24h)
  anomalyMttr: db.prepare(`
    SELECT AVG(
      (julianday(resolved_at) - julianday(detected_at)) * 24 * 60
    ) as avg_minutes
    FROM anomalies
    WHERE resolved = 1 AND resolved_at IS NOT NULL
      AND detected_at > datetime('now', '-24 hours')
  `),

  // Repeat offenders: aircraft with 2+ anomalies in last 24h
  anomalyRepeaters: db.prepare(`
    SELECT icao, callsign, COUNT(*) as count, MAX(score) as max_score, MAX(severity) as max_severity
    FROM anomalies
    WHERE detected_at > datetime('now', '-24 hours')
    GROUP BY icao
    HAVING count > 1
    ORDER BY count DESC
    LIMIT 10
  `),

  // Anomaly feedback
  setFeedback: db.prepare(`
    UPDATE anomalies SET feedback = ?, feedback_note = ?, feedback_at = datetime('now')
    WHERE id = ?
  `),

  // False positive rate: how many anomalies in last 7 days were marked false_positive
  feedbackStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN feedback = 'false_positive' THEN 1 ELSE 0 END) as false_positives,
      SUM(CASE WHEN feedback = 'confirmed_real' THEN 1 ELSE 0 END) as confirmed_real,
      SUM(CASE WHEN feedback IS NULL THEN 1 ELSE 0 END) as unreviewed
    FROM anomalies
    WHERE detected_at > datetime('now', '-7 days')
  `),

  // ── Route baseline statements ───────────────────────────────────────────
  upsertBaseline: db.prepare(`
    INSERT INTO route_baselines (origin_icao, destination_icao, sample_flights, sample_points, alt_rate_mean, alt_rate_std, alt_rate_p95, vel_mean, vel_std, max_alt_mean, updated_at)
    VALUES (@origin_icao, @destination_icao, @sample_flights, @sample_points, @alt_rate_mean, @alt_rate_std, @alt_rate_p95, @vel_mean, @vel_std, @max_alt_mean, datetime('now'))
    ON CONFLICT(origin_icao, destination_icao) DO UPDATE SET
      sample_flights = excluded.sample_flights,
      sample_points = excluded.sample_points,
      alt_rate_mean = excluded.alt_rate_mean,
      alt_rate_std = excluded.alt_rate_std,
      alt_rate_p95 = excluded.alt_rate_p95,
      vel_mean = excluded.vel_mean,
      vel_std = excluded.vel_std,
      max_alt_mean = excluded.max_alt_mean,
      updated_at = datetime('now')
  `),

  getBaseline: db.prepare(`
    SELECT * FROM route_baselines WHERE origin_icao = ? AND destination_icao = ?
  `),

  allBaselines: db.prepare(`
    SELECT * FROM route_baselines ORDER BY sample_flights DESC
  `),

  // Sightings for baseline computation — recent sightings with routes
  sightingsForBaseline: db.prepare(`
    SELECT s.icao, s.callsign, s.alt, s.vel, s.hdg, s.seen_at,
           cr.origin_icao, cr.destination_icao
    FROM sightings s
    INNER JOIN callsign_routes cr ON s.callsign = cr.callsign
    WHERE s.seen_at > datetime('now', '-7 days')
      AND s.alt IS NOT NULL AND s.vel IS NOT NULL
      AND s.grounded = 0
    ORDER BY s.icao, s.seen_at
  `),

  // ── NOTAM statements ────────────────────────────────────────────────────
  upsertNotam: db.prepare(`
    INSERT INTO notams (id, location, classification, keyword, scenario, is_tfr, lat, lon, alt_lower, alt_upper, geometry, effective, expiration, permanent, text, full_text, raw_xml, received_at, updated_at)
    VALUES (@id, @location, @classification, @keyword, @scenario, @is_tfr, @lat, @lon, @alt_lower, @alt_upper, @geometry, @effective, @expiration, @permanent, @text, @full_text, @raw_xml, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      location = excluded.location,
      classification = excluded.classification,
      keyword = excluded.keyword,
      is_tfr = excluded.is_tfr,
      lat = excluded.lat,
      lon = excluded.lon,
      alt_lower = excluded.alt_lower,
      alt_upper = excluded.alt_upper,
      geometry = excluded.geometry,
      effective = excluded.effective,
      expiration = excluded.expiration,
      permanent = excluded.permanent,
      text = excluded.text,
      full_text = excluded.full_text,
      raw_xml = excluded.raw_xml,
      updated_at = datetime('now')
  `),

  getActiveTfrs: db.prepare(`
    SELECT * FROM notams
    WHERE is_tfr = 1
      AND (expiration IS NULL OR expiration > datetime('now'))
      AND (effective IS NULL OR effective <= datetime('now'))
    ORDER BY effective DESC
  `),

  getActiveNotamsByLocation: db.prepare(`
    SELECT * FROM notams
    WHERE location = ?
      AND (expiration IS NULL OR expiration > datetime('now'))
      AND (effective IS NULL OR effective <= datetime('now'))
    ORDER BY effective DESC
  `),

  getNotamStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_tfr = 1 THEN 1 ELSE 0 END) as tfrs,
      SUM(CASE WHEN expiration IS NULL OR expiration > datetime('now') THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN is_tfr = 1 AND (expiration IS NULL OR expiration > datetime('now')) THEN 1 ELSE 0 END) as active_tfrs
    FROM notams
  `),

  purgeExpiredNotams: db.prepare(`
    DELETE FROM notams WHERE expiration IS NOT NULL AND expiration < datetime('now', '-7 days')
  `),

  // Airports with active NOTAMs — grouped, with keyword counts
  notamsByAirport: db.prepare(`
    SELECT location,
      COUNT(*) as count,
      SUM(CASE WHEN keyword = 'RWY' THEN 1 ELSE 0 END) as rwy,
      SUM(CASE WHEN keyword = 'TWY' THEN 1 ELSE 0 END) as twy,
      SUM(CASE WHEN keyword = 'APRON' THEN 1 ELSE 0 END) as apron,
      SUM(CASE WHEN keyword = 'AIRSPACE' THEN 1 ELSE 0 END) as airspace,
      SUM(CASE WHEN keyword = 'SVC' OR keyword = 'NAV' THEN 1 ELSE 0 END) as svc,
      SUM(CASE WHEN keyword = 'OBST' THEN 1 ELSE 0 END) as obst,
      MAX(received_at) as latest
    FROM notams
    WHERE location IS NOT NULL
      AND (text IS NULL OR text NOT LIKE 'CANCELLED%')
      AND (expiration IS NULL OR expiration > datetime('now'))
    GROUP BY location
    ORDER BY count DESC
    LIMIT ?
  `),

  // Recent NOTAM activity (last N messages received)
  recentNotams: db.prepare(`
    SELECT id, location, keyword, classification, text, is_tfr, received_at
    FROM notams
    ORDER BY received_at DESC
    LIMIT ?
  `),

  // Individual NOTAMs for a specific airport
  notamsForLocation: db.prepare(`
    SELECT id, location, keyword, classification, text, full_text, is_tfr,
           effective, expiration, permanent, lat, lon, alt_lower, alt_upper,
           received_at
    FROM notams
    WHERE location = ?
      AND (text IS NULL OR text NOT LIKE 'CANCELLED%')
      AND (expiration IS NULL OR expiration > datetime('now'))
    ORDER BY
      CASE WHEN keyword = 'AIRSPACE' THEN 0
           WHEN keyword = 'RWY' THEN 1
           WHEN keyword = 'TWY' THEN 2
           WHEN keyword = 'SVC' OR keyword = 'NAV' THEN 3
           ELSE 4 END,
      received_at DESC
    LIMIT 50
  `),

  // ── TFMS statements ─────────────────────────────────────────────────────
  upsertFlightPlan: db.prepare(`
    INSERT INTO flight_plans (acid, gufi, dep_arpt, arr_arpt, aircraft_type, altitude, speed, route, flight_status, etd, eta, atd, ata, beacon_code, lat, lon, reported_alt, msg_type, received_at, updated_at)
    VALUES (@acid, @gufi, @dep_arpt, @arr_arpt, @aircraft_type, @altitude, @speed, @route, @flight_status, @etd, @eta, @atd, @ata, @beacon_code, @lat, @lon, @reported_alt, @msg_type, datetime('now'), datetime('now'))
    ON CONFLICT(acid) DO UPDATE SET
      gufi = COALESCE(excluded.gufi, flight_plans.gufi),
      dep_arpt = COALESCE(excluded.dep_arpt, flight_plans.dep_arpt),
      arr_arpt = COALESCE(excluded.arr_arpt, flight_plans.arr_arpt),
      aircraft_type = COALESCE(excluded.aircraft_type, flight_plans.aircraft_type),
      altitude = COALESCE(excluded.altitude, flight_plans.altitude),
      speed = COALESCE(excluded.speed, flight_plans.speed),
      route = COALESCE(excluded.route, flight_plans.route),
      flight_status = COALESCE(excluded.flight_status, flight_plans.flight_status),
      etd = COALESCE(excluded.etd, flight_plans.etd),
      eta = COALESCE(excluded.eta, flight_plans.eta),
      atd = COALESCE(excluded.atd, flight_plans.atd),
      ata = COALESCE(excluded.ata, flight_plans.ata),
      beacon_code = COALESCE(excluded.beacon_code, flight_plans.beacon_code),
      lat = COALESCE(excluded.lat, flight_plans.lat),
      lon = COALESCE(excluded.lon, flight_plans.lon),
      reported_alt = COALESCE(excluded.reported_alt, flight_plans.reported_alt),
      msg_type = excluded.msg_type,
      updated_at = datetime('now')
  `),

  insertFlowEvent: db.prepare(`
    INSERT INTO flow_events (event_type, airport, status, reason, text, delay_minutes, start_time, end_time, msg_type, facility, geometry, ceiling, floor, restriction_type, restriction_value, received_at)
    VALUES (@event_type, @airport, @status, @reason, @text, @delay_minutes, @start_time, @end_time, @msg_type, @facility, @geometry, @ceiling, @floor, @restriction_type, @restriction_value, datetime('now'))
  `),

  upsertAirportConfig: db.prepare(`
    INSERT INTO airport_configs (airport, facility, arr_runway, dep_runway, arr_rate, dep_rate, weather, updated_at)
    VALUES (@airport, @facility, @arr_runway, @dep_runway, @arr_rate, @dep_rate, @weather, datetime('now'))
    ON CONFLICT(airport) DO UPDATE SET
      facility = excluded.facility,
      arr_runway = excluded.arr_runway,
      dep_runway = excluded.dep_runway,
      arr_rate = excluded.arr_rate,
      dep_rate = excluded.dep_rate,
      weather = excluded.weather,
      updated_at = datetime('now')
  `),

  getAirportConfigs: db.prepare(`
    SELECT * FROM airport_configs ORDER BY updated_at DESC
  `),

  getAirportConfig: db.prepare(`
    SELECT * FROM airport_configs WHERE airport = ?
  `),

  // Terminal weather
  insertTerminalWeather: db.prepare(`
    INSERT INTO terminal_weather (event_type, site, airport, severity, lat, lon, altitude, cell_id, movement, speed, tops, vil_level, runway, gain_loss, text, valid_time, expiry_time, received_at)
    VALUES (@event_type, @site, @airport, @severity, @lat, @lon, @altitude, @cell_id, @movement, @speed, @tops, @vil_level, @runway, @gain_loss, @text, @valid_time, @expiry_time, datetime('now'))
  `),

  getRecentTerminalWeather: db.prepare(`
    SELECT * FROM terminal_weather
    WHERE received_at > datetime('now', '-1 hour')
    ORDER BY received_at DESC LIMIT ?
  `),

  getTerminalWeatherByAirport: db.prepare(`
    SELECT * FROM terminal_weather
    WHERE airport = ? AND received_at > datetime('now', '-1 hour')
    ORDER BY received_at DESC LIMIT ?
  `),

  getTerminalWeatherStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN event_type = 'TORNADO' THEN 1 ELSE 0 END) as tornado,
      SUM(CASE WHEN event_type = 'WINDSHEAR' THEN 1 ELSE 0 END) as windshear,
      SUM(CASE WHEN event_type = 'MICROBURST' THEN 1 ELSE 0 END) as microburst,
      SUM(CASE WHEN event_type = 'GUST_FRONT' THEN 1 ELSE 0 END) as gust_front,
      SUM(CASE WHEN event_type = 'PRECIP' THEN 1 ELSE 0 END) as precip,
      SUM(CASE WHEN event_type = 'HAZARD_TEXT' THEN 1 ELSE 0 END) as hazard_text,
      SUM(CASE WHEN event_type = 'STORM_MOTION' THEN 1 ELSE 0 END) as storm_motion,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as critical,
      COUNT(DISTINCT airport) as sites
    FROM terminal_weather
    WHERE received_at > datetime('now', '-1 hour')
  `),

  purgeOldTerminalWeather: db.prepare(`
    DELETE FROM terminal_weather WHERE received_at < datetime('now', '-24 hours')
  `),

  // Surface events (STDDS)
  insertSurfaceEvent: db.prepare(`
    INSERT INTO surface_events (service, event_type, airport, tracon, callsign, lat, lon, altitude, speed, heading, surface_event, runway, gate, taxiway, rvr, rvr_trend, alert_type, text, received_at)
    VALUES (@service, @event_type, @airport, @tracon, @callsign, @lat, @lon, @altitude, @speed, @heading, @surface_event, @runway, @gate, @taxiway, @rvr, @rvr_trend, @alert_type, @text, datetime('now'))
  `),

  getRecentSurfaceEvents: db.prepare(`
    SELECT * FROM surface_events WHERE received_at > datetime('now', '-1 hour') ORDER BY received_at DESC LIMIT ?
  `),

  getSurfaceEventsByAirport: db.prepare(`
    SELECT * FROM surface_events WHERE airport = ? AND received_at > datetime('now', '-1 hour') ORDER BY received_at DESC LIMIT ?
  `),

  getOooi: db.prepare(`
    SELECT * FROM surface_events WHERE event_type IN ('SPOT_OUT','OFF','ON','SPOT_IN','DEPARTURE') AND received_at > datetime('now', '-2 hours') ORDER BY received_at DESC LIMIT ?
  `),

  getSurfaceStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN service = 'SMES' THEN 1 ELSE 0 END) as surface,
      SUM(CASE WHEN service = 'TDES' THEN 1 ELSE 0 END) as departures,
      SUM(CASE WHEN service = 'TAIS' THEN 1 ELSE 0 END) as tracon,
      SUM(CASE WHEN service = 'APDS' THEN 1 ELSE 0 END) as rvr,
      SUM(CASE WHEN event_type IN ('SPOT_OUT','OFF','ON','SPOT_IN') THEN 1 ELSE 0 END) as oooi,
      COUNT(DISTINCT airport) as airports
    FROM surface_events
    WHERE received_at > datetime('now', '-1 hour')
  `),

  purgeOldSurfaceEvents: db.prepare(`
    DELETE FROM surface_events WHERE received_at < datetime('now', '-6 hours')
  `),

  getFlightPlan: db.prepare(`SELECT * FROM flight_plans WHERE acid = ?`),

  getFlightPlanByRoute: db.prepare(`
    SELECT * FROM flight_plans WHERE dep_arpt = ? AND arr_arpt = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getActiveFlightPlans: db.prepare(`
    SELECT * FROM flight_plans
    WHERE flight_status IN ('ACTIVE', 'ASCENDING', 'CRUISING', 'DESCENDING', 'FILED')
      AND updated_at > datetime('now', '-2 hours')
    ORDER BY updated_at DESC LIMIT ?
  `),

  getActiveFlowEvents: db.prepare(`
    SELECT * FROM flow_events
    WHERE received_at > datetime('now', '-6 hours')
      AND event_type NOT IN ('TMI_LIST', 'TMI_UPDATE')
    ORDER BY received_at DESC LIMIT ?
  `),

  // Flow control programs only (GS, GDP, AFP, CTOP, REROUTE) — never drowned by RSTR/FXA noise
  getActiveFlowPrograms: db.prepare(`
    SELECT * FROM flow_events
    WHERE received_at > datetime('now', '-6 hours')
      AND event_type IN ('GS', 'GDP', 'AFP', 'CTOP', 'REROUTE')
    ORDER BY received_at DESC LIMIT 200
  `),

  getFlightPositions: db.prepare(`
    SELECT acid, lat, lon, reported_alt, speed, dep_arpt, arr_arpt, flight_status
    FROM flight_plans
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND updated_at > datetime('now', '-30 minutes')
    ORDER BY updated_at DESC LIMIT ?
  `),

  getSurfacePositions: db.prepare(`
    SELECT callsign, lat, lon, altitude, speed, heading, airport, tracon, service, event_type
    FROM surface_events
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND received_at > datetime('now', '-15 minutes')
      AND service IN ('TAIS', 'SMES')
    ORDER BY received_at DESC LIMIT ?
  `),

  getFlowEventsByAirport: db.prepare(`
    SELECT * FROM flow_events
    WHERE airport = ? AND received_at > datetime('now', '-12 hours')
    ORDER BY received_at DESC LIMIT ?
  `),

  getTfmsStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM flight_plans) as total_plans,
      (SELECT COUNT(*) FROM flight_plans WHERE updated_at > datetime('now', '-1 hour')) as recent_plans,
      (SELECT COUNT(*) FROM flight_plans WHERE flight_status IN ('ACTIVE','ASCENDING','CRUISING','DESCENDING')) as active_flights,
      (SELECT COUNT(*) FROM flow_events WHERE received_at > datetime('now', '-6 hours')) as recent_flow_events,
      (SELECT COUNT(*) FROM flow_events WHERE event_type = 'GDP' AND received_at > datetime('now', '-6 hours')) as active_gdps,
      (SELECT COUNT(*) FROM flow_events WHERE event_type = 'GS' AND received_at > datetime('now', '-6 hours')) as active_gs
  `),

  purgeOldFlightPlans: db.prepare(`
    DELETE FROM flight_plans WHERE updated_at < datetime('now', '-24 hours')
  `),

  purgeOldFlowEvents: db.prepare(`
    DELETE FROM flow_events WHERE received_at < datetime('now', '-7 days')
  `),

  // Hourly anomaly counts (for chart overlay)
  // ── Route cache statements ──────────────────────────────────────────────
  routeLookup: db.prepare(`
    SELECT * FROM callsign_routes WHERE callsign = ?
  `),

  routeBulkLookup: db.prepare(`
    SELECT * FROM callsign_routes WHERE callsign IN (SELECT value FROM json_each(?))
  `),

  // Route upsert with source confidence: TFMS routes are authoritative (filed flight plans).
  // Non-TFMS sources (adsbdb, hexdb) won't overwrite a TFMS route — but TFMS always overwrites.
  routeUpsert: db.prepare(`
    INSERT INTO callsign_routes (callsign, origin_icao, origin_lat, origin_lon, destination_icao, destination_lat, destination_lon, source, last_seen, updated_at)
    VALUES (@callsign, @origin_icao, @origin_lat, @origin_lon, @destination_icao, @destination_lat, @destination_lon, @source, datetime('now'), datetime('now'))
    ON CONFLICT(callsign) DO UPDATE SET
      origin_icao = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.origin_icao ELSE callsign_routes.origin_icao END,
      origin_lat = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.origin_lat ELSE callsign_routes.origin_lat END,
      origin_lon = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.origin_lon ELSE callsign_routes.origin_lon END,
      destination_icao = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.destination_icao ELSE callsign_routes.destination_icao END,
      destination_lat = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.destination_lat ELSE callsign_routes.destination_lat END,
      destination_lon = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.destination_lon ELSE callsign_routes.destination_lon END,
      source = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN excluded.source ELSE callsign_routes.source END,
      last_seen = datetime('now'),
      updated_at = CASE WHEN excluded.source = 'tfms' OR callsign_routes.source != 'tfms' THEN datetime('now') ELSE callsign_routes.updated_at END
  `),

  routeTouch: db.prepare(`
    UPDATE callsign_routes SET last_seen = datetime('now') WHERE callsign = ?
  `),

  routeCount: db.prepare(`
    SELECT COUNT(*) as c FROM callsign_routes
  `),

  routeStale: db.prepare(`
    SELECT callsign FROM callsign_routes
    WHERE updated_at < datetime('now', '-30 days')
    LIMIT 50
  `),

  // ── Aircraft cache statements ─────────────────────────────────────────────
  aircraftCacheBulk: db.prepare(`
    SELECT * FROM aircraft_cache WHERE icao IN (SELECT value FROM json_each(?))
  `),

  aircraftCacheUpsert: db.prepare(`
    INSERT INTO aircraft_cache (icao, type, reg, desc, operator, source, updated_at)
    VALUES (@icao, @type, @reg, @desc, @operator, @source, datetime('now'))
    ON CONFLICT(icao) DO UPDATE SET
      type = excluded.type,
      reg = excluded.reg,
      desc = excluded.desc,
      operator = excluded.operator,
      source = excluded.source,
      updated_at = datetime('now')
  `),

  anomalyHourly: db.prepare(`
    SELECT
      CAST(strftime('%H', detected_at) AS INTEGER) AS hour,
      COUNT(*) AS count,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as critical
    FROM anomalies
    WHERE detected_at > datetime('now', '-24 hours')
    GROUP BY hour
    ORDER BY hour
  `),

  // Anomaly hotspots: grid-cell clustering over configurable time window
  // Groups anomalies into ~0.5° grid cells (~55km), returns cells with 2+ events
  anomalyHotspots: db.prepare(`
    SELECT
      ROUND(lat * 2) / 2 AS cell_lat,
      ROUND(lon * 2) / 2 AS cell_lon,
      COUNT(*) AS count,
      AVG(lat) AS avg_lat,
      AVG(lon) AS avg_lon,
      MAX(score) AS max_score,
      AVG(score) AS avg_score,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END) AS medium,
      GROUP_CONCAT(DISTINCT category) AS categories,
      COUNT(DISTINCT icao) AS unique_aircraft,
      MIN(detected_at) AS first_seen,
      MAX(detected_at) AS last_seen
    FROM anomalies
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND detected_at > datetime('now', ?)
    GROUP BY cell_lat, cell_lon
    HAVING count >= ?
    ORDER BY count DESC
    LIMIT 50
  `),

  // Zone daily rollup: aggregate yesterday's anomalies into zone_daily
  zoneDailyRollup: db.prepare(`
    INSERT OR REPLACE INTO zone_daily (date, cell_lat, cell_lon, count, critical, high, medium, unique_aircraft, categories)
    SELECT
      DATE(detected_at) AS date,
      ROUND(lat * 2) / 2 AS cell_lat,
      ROUND(lon * 2) / 2 AS cell_lon,
      COUNT(*) AS count,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END),
      SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END),
      SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END),
      COUNT(DISTINCT icao),
      GROUP_CONCAT(DISTINCT category)
    FROM anomalies
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND DATE(detected_at) = ?
    GROUP BY date, cell_lat, cell_lon
  `),

  // Zone baseline: rolling average per cell over N days
  zoneBaseline: db.prepare(`
    SELECT
      cell_lat, cell_lon,
      AVG(count) AS avg_daily,
      MAX(count) AS max_daily,
      SUM(count) AS total,
      COUNT(*) AS days_active
    FROM zone_daily
    WHERE date >= DATE('now', ?)
      AND date < DATE('now')
    GROUP BY cell_lat, cell_lon
  `),

  // Purge old zone_daily rows (keep 90 days)
  zoneDailyPurge: db.prepare(`
    DELETE FROM zone_daily WHERE date < DATE('now', '-90 days')
  `),
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
      lat:      f.lat ?? null,
      lon:      f.lon ?? null,
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

// ── anomaly persistence ─────────────────────────────────────────────────────

const _insertAnomalyBatch = db.transaction((rows) => {
  for (const row of rows) _stmts.insertAnomaly.run(row)
})

function recordAnomalies(anomalies, region) {
  const now = new Date().toISOString()
  const rows = []

  for (const a of anomalies) {
    // Skip if this aircraft already has an unresolved anomaly recently
    const existing = _stmts.findRecentAnomaly.get(a.icao)
    if (existing) continue

    rows.push({
      icao:        a.icao,
      callsign:    a.callsign || null,
      score:       a.score,
      phase:       a.phase || null,
      reasons:     JSON.stringify(a.reasons || []),
      confirmed:   a.confirmed ? 1 : 0,
      category:    a.category || null,
      severity:    a.severity || null,
      categories:  JSON.stringify(a.categories || []),
      lat:         a.lat ?? null,
      lon:         a.lon ?? null,
      alt:         a.alt ?? null,
      vel:         a.vel ?? null,
      hdg:         a.hdg ?? null,
      squawk:      a.squawk || null,
      region:      region || null,
      weather_context: a.weather_context ? JSON.stringify(a.weather_context) : null,
      detected_at: now,
    })
  }

  if (rows.length > 0) _insertAnomalyBatch(rows)
  return rows.length
}

function resolveAnomalies(icaos) {
  let resolved = 0
  for (const icao of icaos) {
    resolved += _stmts.resolveAnomalies.run(icao).changes
  }
  return resolved
}

function parseAnomaly(r) {
  const { nearestAirport } = require('./anomaly')
  const near = nearestAirport(r.lat, r.lon)
  return {
    ...r,
    reasons: JSON.parse(r.reasons || '[]'),
    categories: JSON.parse(r.categories || '[]'),
    weather_context: r.weather_context ? JSON.parse(r.weather_context) : null,
    confirmed: !!r.confirmed,
    resolved: !!r.resolved,
    nearest_airport: near?.icao || null,
    airport_city: near?.city || null,
    airport_state: near?.state || null,
    airport_dist_km: near?.dist_km ?? null,
  }
}

function getRecentAnomalies(limit = 50) {
  return _stmts.recentAnomalies.all(limit).map(parseAnomaly)
}

function getActiveAnomalies() {
  return _stmts.activeAnomalies.all().map(parseAnomaly)
}

function getAnomaliesByIcao(icao, limit = 20) {
  return _stmts.anomaliesByIcao.all(icao, limit).map(parseAnomaly)
}

// ── Route baseline computation ─────────────────────────────────────────────
// Builds per-route statistical profiles from recent sightings.
// Call periodically (e.g. daily during maintenance).

function buildRouteBaselines() {
  const rows = _stmts.sightingsForBaseline.all()
  if (rows.length < 100) return 0 // not enough data

  // Group sightings by aircraft+route, compute altitude rates from consecutive readings
  const routeStats = {} // "KJFK→KLAX" → { altRates: [], vels: [], maxAlts: [], flights: Set }
  let prevRow = null

  for (const row of rows) {
    const routeKey = `${row.origin_icao}→${row.destination_icao}`
    if (!routeStats[routeKey]) {
      routeStats[routeKey] = { altRates: [], vels: [], maxAlts: [], flights: new Set(), origin: row.origin_icao, dest: row.destination_icao }
    }
    const rs = routeStats[routeKey]
    rs.flights.add(row.icao)
    rs.vels.push(row.vel)
    rs.maxAlts.push(row.alt)

    // Compute altitude rate between consecutive sightings of the same aircraft
    if (prevRow && prevRow.icao === row.icao) {
      const dt = (new Date(row.seen_at) - new Date(prevRow.seen_at)) / 1000
      if (dt > 10 && dt < 300 && prevRow.alt != null) { // reasonable time gap
        const altRate = (row.alt - prevRow.alt) / dt
        rs.altRates.push(altRate)
      }
    }
    prevRow = row
  }

  // Compute statistics per route and upsert
  const upsertBatch = db.transaction((baselines) => {
    for (const b of baselines) _stmts.upsertBaseline.run(b)
  })

  const baselines = []
  for (const [, rs] of Object.entries(routeStats)) {
    if (rs.altRates.length < 20 || rs.flights.size < 3) continue // need meaningful sample

    const altMean = rs.altRates.reduce((a, b) => a + b, 0) / rs.altRates.length
    const altVariance = rs.altRates.reduce((a, r) => a + (r - altMean) ** 2, 0) / rs.altRates.length
    const altStd = Math.sqrt(altVariance)

    // 95th percentile of absolute altitude rate
    const absRates = rs.altRates.map(Math.abs).sort((a, b) => a - b)
    const p95Idx = Math.floor(absRates.length * 0.95)
    const altP95 = absRates[p95Idx] || absRates[absRates.length - 1]

    const velMean = rs.vels.reduce((a, b) => a + b, 0) / rs.vels.length
    const velVariance = rs.vels.reduce((a, v) => a + (v - velMean) ** 2, 0) / rs.vels.length
    const velStd = Math.sqrt(velVariance)

    const maxAltMean = rs.maxAlts.reduce((a, b) => a + b, 0) / rs.maxAlts.length

    baselines.push({
      origin_icao: rs.origin,
      destination_icao: rs.dest,
      sample_flights: rs.flights.size,
      sample_points: rs.altRates.length,
      alt_rate_mean: Math.round(altMean * 100) / 100,
      alt_rate_std: Math.round(altStd * 100) / 100,
      alt_rate_p95: Math.round(altP95 * 100) / 100,
      vel_mean: Math.round(velMean * 100) / 100,
      vel_std: Math.round(velStd * 100) / 100,
      max_alt_mean: Math.round(maxAltMean),
    })
  }

  if (baselines.length > 0) upsertBatch(baselines)
  return baselines.length
}

function getRouteBaseline(origin, destination) {
  if (!origin || !destination) return null
  return _stmts.getBaseline.get(origin, destination) || null
}

function getAllBaselines() {
  return _stmts.allBaselines.all()
}

// ── NOTAM functions ─────────────────────────────────────────────────────────

const _upsertNotamBatch = db.transaction((rows) => {
  for (const row of rows) _stmts.upsertNotam.run(row)
})

function upsertNotam(notam, rawXml = null) {
  _stmts.upsertNotam.run({
    id: notam.id || `FNS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    location: notam.location || null,
    classification: notam.classification || null,
    keyword: notam.keyword || null,
    scenario: notam.scenario || null,
    is_tfr: notam.isTfr ? 1 : 0,
    lat: notam.lat ?? null,
    lon: notam.lon ?? null,
    alt_lower: notam.altitudeLower ?? null,
    alt_upper: notam.altitudeUpper ?? null,
    geometry: notam.geometry ? JSON.stringify(notam.geometry) : null,
    effective: notam.effective || null,
    expiration: notam.expiration || null,
    permanent: notam.permanent ? 1 : 0,
    text: notam.text || null,
    full_text: notam.fullText || null,
    raw_xml: rawXml || null,
  })
}

function upsertNotamBatch(notams, rawXmls = []) {
  const rows = notams.map((n, i) => ({
    id: n.id || `FNS_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    location: n.location || null,
    classification: n.classification || null,
    keyword: n.keyword || null,
    scenario: n.scenario || null,
    is_tfr: n.isTfr ? 1 : 0,
    lat: n.lat ?? null,
    lon: n.lon ?? null,
    alt_lower: n.altitudeLower ?? null,
    alt_upper: n.altitudeUpper ?? null,
    geometry: n.geometry ? JSON.stringify(n.geometry) : null,
    effective: n.effective || null,
    expiration: n.expiration || null,
    permanent: n.permanent ? 1 : 0,
    text: n.text || null,
    full_text: n.fullText || null,
    raw_xml: rawXmls[i] || null,
  }))
  _upsertNotamBatch(rows)
  return rows.length
}

function getActiveTfrs() {
  const rows = _stmts.getActiveTfrs.all()
  return rows.map(r => ({
    ...r,
    geometry: r.geometry ? JSON.parse(r.geometry) : null,
    is_tfr: !!r.is_tfr,
    permanent: !!r.permanent,
  }))
}

function getActiveNotamsByLocation(location) {
  return _stmts.getActiveNotamsByLocation.all(location)
}

function getNotamStats() {
  return _stmts.getNotamStats.get()
}

function purgeExpiredNotams() {
  return _stmts.purgeExpiredNotams.run().changes
}

function getNotamsByAirport(limit = 20) {
  return _stmts.notamsByAirport.all(limit)
}

function getNotamsForLocation(location) {
  return _stmts.notamsForLocation.all(location)
}

function getRecentNotams(limit = 15) {
  return _stmts.recentNotams.all(limit)
}

// ── TFMS functions ──────────────────────────────────────────────────────────

const _upsertFlightPlanBatch = db.transaction((rows) => {
  for (const row of rows) _stmts.upsertFlightPlan.run(row)
})

function upsertFlightPlan(fp) {
  _stmts.upsertFlightPlan.run({
    acid: fp.acid,
    gufi: fp.gufi || null,
    dep_arpt: fp.depArpt || null,
    arr_arpt: fp.arrArpt || null,
    aircraft_type: fp.aircraftType || null,
    altitude: fp.altitude != null ? String(fp.altitude) : null,
    speed: fp.speed != null ? String(fp.speed) : null,
    route: fp.route || null,
    flight_status: fp.flightStatus || null,
    etd: fp.etd || null,
    eta: fp.eta || null,
    atd: fp.atd || null,
    ata: fp.ata || null,
    beacon_code: fp.beaconCode || null,
    lat: fp.lat ?? null,
    lon: fp.lon ?? null,
    reported_alt: fp.reportedAlt != null ? String(fp.reportedAlt) : null,
    msg_type: fp.msgType || null,
  })
}

function upsertFlightPlanBatch(plans) {
  const rows = plans.map(fp => ({
    acid: fp.acid,
    gufi: fp.gufi || null,
    dep_arpt: fp.depArpt || null,
    arr_arpt: fp.arrArpt || null,
    aircraft_type: fp.aircraftType || null,
    altitude: fp.altitude != null ? String(fp.altitude) : null,
    speed: fp.speed != null ? String(fp.speed) : null,
    route: fp.route || null,
    flight_status: fp.flightStatus || null,
    etd: fp.etd || null,
    eta: fp.eta || null,
    atd: fp.atd || null,
    ata: fp.ata || null,
    beacon_code: fp.beaconCode || null,
    lat: fp.lat ?? null,
    lon: fp.lon ?? null,
    reported_alt: fp.reportedAlt != null ? String(fp.reportedAlt) : null,
    msg_type: fp.msgType || null,
  }))
  _upsertFlightPlanBatch(rows)
  return rows.length
}

function insertFlowEvent(event) {
  // APTC events go to airport_configs table (upsert by airport)
  if (event.eventType === 'APTC' && event.airport) {
    _stmts.upsertAirportConfig.run({
      airport: event.airport,
      facility: event.facility || null,
      arr_runway: event.arrRunwayConf || null,
      dep_runway: event.depRunwayConf || null,
      arr_rate: event.arrRate ?? null,
      dep_rate: event.depRate ?? null,
      weather: event.weather || null,
    })
    return
  }

  _stmts.insertFlowEvent.run({
    event_type: event.eventType || 'UNKNOWN',
    airport: event.airport || null,
    status: event.status || null,
    reason: event.reason || null,
    text: event.text || null,
    delay_minutes: event.delay ? Number(event.delay) : null,
    start_time: event.startTime || null,
    end_time: event.endTime || null,
    msg_type: event.msgType || null,
    facility: event.facility || null,
    geometry: event.geometry ? JSON.stringify(event.geometry) : null,
    ceiling: event.ceiling || null,
    floor: event.floor || null,
    restriction_type: event.restrictionType || null,
    restriction_value: event.restrictionValue || null,
  })
}

function getAirportConfigs() { return _stmts.getAirportConfigs.all() }
function getAirportConfig(airport) { return _stmts.getAirportConfig.get(airport) || null }

// ── Terminal weather functions ───────────────────────────────────────────────

function insertTerminalWeather(event) {
  _stmts.insertTerminalWeather.run({
    event_type: event.eventType || 'UNKNOWN',
    site: event.site || null,
    airport: event.airport || null,
    severity: event.severity || null,
    lat: event.lat ?? null,
    lon: event.lon ?? null,
    altitude: event.altitude || null,
    cell_id: event.cellId || null,
    movement: event.movement != null ? String(event.movement) : null,
    speed: event.speed != null ? String(event.speed) : null,
    tops: event.tops || null,
    vil_level: event.vilLevel || null,
    runway: event.runway || null,
    gain_loss: event.gainLoss || null,
    text: event.text || null,
    valid_time: event.validTime || null,
    expiry_time: event.expiryTime || null,
  })
}

function insertSurfaceEvent(event) {
  _stmts.insertSurfaceEvent.run({
    service: event.service || 'UNKNOWN',
    event_type: event.eventType || 'UNKNOWN',
    airport: event.airport || null,
    tracon: event.tracon || null,
    callsign: event.callsign || null,
    lat: event.lat ?? null, lon: event.lon ?? null,
    altitude: event.altitude || null,
    speed: event.speed ?? null, heading: event.heading ?? null,
    surface_event: event.surfaceEvent || null,
    runway: event.runway || null, gate: event.gate || null, taxiway: event.taxiway || null,
    rvr: event.rvr ?? null, rvr_trend: event.rvrTrend || null,
    alert_type: event.alertType || null,
    text: event.text || null,
  })
}

function getRecentSurfaceEvents(limit = 30) { return _stmts.getRecentSurfaceEvents.all(limit) }
function getSurfaceEventsByAirport(airport, limit = 20) { return _stmts.getSurfaceEventsByAirport.all(airport, limit) }
function getOooi(limit = 30) { return _stmts.getOooi.all(limit) }
function getSurfaceStats() { return _stmts.getSurfaceStats.get() }
function purgeOldSurfaceEvents() { return _stmts.purgeOldSurfaceEvents.run().changes }

function getRecentTerminalWeather(limit = 20) { return _stmts.getRecentTerminalWeather.all(limit) }
function getTerminalWeatherByAirport(airport, limit = 10) { return _stmts.getTerminalWeatherByAirport.all(airport, limit) }
function getTerminalWeatherStats() { return _stmts.getTerminalWeatherStats.get() }
function purgeOldTerminalWeather() { return _stmts.purgeOldTerminalWeather.run().changes }

function getFlightPlan(acid) { return _stmts.getFlightPlan.get(acid) || null }
function getActiveFlightPlans(limit = 50) { return _stmts.getActiveFlightPlans.all(limit) }
function getActiveFlowEvents(limit = 20) { return _stmts.getActiveFlowEvents.all(limit) }
function getFlightPositions(limit = 500) { return _stmts.getFlightPositions.all(limit) }
function getSurfacePositions(limit = 300) { return _stmts.getSurfacePositions.all(limit) }
function getFlowEventsByAirport(airport, limit = 10) { return _stmts.getFlowEventsByAirport.all(airport, limit) }
function getTfmsStats() { return _stmts.getTfmsStats.get() }

function purgeOldTfms() {
  const plans = _stmts.purgeOldFlightPlans.run().changes
  const events = _stmts.purgeOldFlowEvents.run().changes
  return { plans, events }
}

function getAnomaliesByZone(cellLat, cellLon, hours = 168, limit = 30) {
  return _stmts.anomaliesByZone.all(cellLat, cellLon, `-${hours} hours`, limit).map(parseAnomaly)
}

function getTrafficHeatmap() {
  return _stmts.trafficHeatmap.all()
}

function getAnomalyStats() {
  const stats = _stmts.anomalyStats.get()
  const mttr = _stmts.anomalyMttr.get()
  const repeaters = _stmts.anomalyRepeaters.all()
  const hourly = _stmts.anomalyHourly.all()
  return {
    ...stats,
    mttr_minutes: mttr?.avg_minutes ?? null,
    repeaters,
    hourly,
  }
}

function setAnomalyFeedback(id, feedback, note = null) {
  const valid = ['false_positive', 'confirmed_real']
  if (!valid.includes(feedback)) throw new Error(`Invalid feedback: ${feedback}`)
  return _stmts.setFeedback.run(feedback, note, id)
}

function getFeedbackStats() {
  return _stmts.feedbackStats.get()
}

// ── Anomaly hotspot clustering ───────────────────────────────────────────────

function getAnomalyHotspots(hours = 168, minCount = 2) {
  const { nearestAirport } = require('./anomaly')
  const timeOffset = `-${hours} hours`
  const rows = _stmts.anomalyHotspots.all(timeOffset, minCount)

  // Load baseline averages (last 30 days, excluding today)
  const baselineRows = _stmts.zoneBaseline.all('-30 days')
  const baselineMap = {}
  for (const b of baselineRows) {
    baselineMap[`${b.cell_lat},${b.cell_lon}`] = b
  }

  return rows.map(r => {
    const near = nearestAirport(r.avg_lat, r.avg_lon)
    const cellKey = `${ROUND2(r.avg_lat)},${ROUND2(r.avg_lon)}`
    const baseline = baselineMap[cellKey]

    // Current rate: events per day in the query window
    const days = Math.max(1, hours / 24)
    const currentDaily = r.count / days

    // Deviation: how many times above baseline (null if no baseline yet)
    let deviation = null
    if (baseline && baseline.avg_daily > 0) {
      deviation = Math.round((currentDaily / baseline.avg_daily) * 10) / 10
    }

    return {
      lat: r.avg_lat,
      lon: r.avg_lon,
      count: r.count,
      max_score: r.max_score,
      avg_score: Math.round(r.avg_score),
      critical: r.critical,
      high: r.high,
      medium: r.medium,
      categories: r.categories ? r.categories.split(',') : [],
      unique_aircraft: r.unique_aircraft,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      nearest_airport: near?.icao || null,
      airport_city: near?.city || null,
      airport_state: near?.state || null,
      airport_dist_km: near?.dist_km ?? null,
      // Baseline context
      baseline_avg: baseline ? Math.round(baseline.avg_daily * 10) / 10 : null,
      baseline_max: baseline?.max_daily ?? null,
      baseline_days: baseline?.days_active ?? 0,
      deviation, // e.g. 3.2 = 3.2x above baseline, null = no baseline yet
    }
  })
}

// Round to 0.5° grid cell (matches SQL: ROUND(lat*2)/2)
function ROUND2(v) { return Math.round(v * 2) / 2 }

// ── Zone baseline rollup ─────────────────────────────────────────────────────

// Roll up a specific day's anomalies into zone_daily
function rollupZoneDaily(dateStr) {
  return _stmts.zoneDailyRollup.run(dateStr).changes
}

// Roll up yesterday (called from maintenance cycle)
function rollupYesterday() {
  const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10)
  return rollupZoneDaily(yesterday)
}

// Purge old zone_daily data (>90 days)
function purgeZoneDaily() {
  return _stmts.zoneDailyPurge.run().changes
}

// Backfill zone_daily from historical anomalies (run once to bootstrap baseline)
function backfillZoneDaily(days = 30) {
  let total = 0
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().substring(0, 10)
    total += rollupZoneDaily(d)
  }
  return total
}

// ── Route cache functions ────────────────────────────────────────────────────

function getRoute(callsign) {
  return _stmts.routeLookup.get(callsign) || null
}

// Bulk lookup: pass an array of callsigns, get back a map { callsign: route }
function getRoutesBulk(callsigns) {
  if (!callsigns || callsigns.length === 0) return {}
  const rows = _stmts.routeBulkLookup.all(JSON.stringify(callsigns))
  const map = {}
  for (const r of rows) map[r.callsign] = r
  return map
}

// Upsert a route (insert or update if callsign already exists)
function upsertRoute(route) {
  _stmts.routeUpsert.run({
    callsign: route.callsign,
    origin_icao: route.origin_icao || null,
    origin_lat: route.origin_lat ?? null,
    origin_lon: route.origin_lon ?? null,
    destination_icao: route.destination_icao || null,
    destination_lat: route.destination_lat ?? null,
    destination_lon: route.destination_lon ?? null,
    source: route.source || 'adsbdb',
  })
}

// Batch upsert (transactional)
const upsertRoutesBatch = db.transaction((routes) => {
  for (const r of routes) upsertRoute(r)
})

// Touch last_seen for callsigns still active (keeps stale detection accurate)
function touchRoutes(callsigns) {
  if (!callsigns || callsigns.length === 0) return
  const touch = db.transaction((list) => {
    for (const cs of list) _stmts.routeTouch.run(cs)
  })
  touch(callsigns)
}

function getRouteCount() {
  return _stmts.routeCount.get().c
}

// Callsigns not seen/updated in 30+ days — candidates for re-enrichment
function getStaleRoutes() {
  return _stmts.routeStale.all().map(r => r.callsign)
}

// ── Aircraft enrichment cache ────────────────────────────────────────────────

function getAircraftCacheBulk(icaos) {
  if (!icaos.length) return {}
  const rows = _stmts.aircraftCacheBulk.all(JSON.stringify(icaos))
  const map = {}
  for (const r of rows) map[r.icao] = r
  return map
}

function getAircraftCacheIcaos() {
  return new Set(db.prepare('SELECT icao FROM aircraft_cache').all().map(r => r.icao))
}

// ICAOs cached as 'unknown' (no data from primary source) — eligible for fallback retry
function getUnknownAircraftIcaos() {
  return new Set(db.prepare("SELECT icao FROM aircraft_cache WHERE source = 'unknown'").all().map(r => r.icao))
}

function upsertAircraftCache(entries) {
  const tx = db.transaction(() => {
    for (const e of entries) {
      _stmts.aircraftCacheUpsert.run({
        icao: e.icao,
        type: e.type || null,
        reg: e.reg || null,
        desc: e.desc || null,
        operator: e.operator || null,
        source: e.source || 'adsbdb',
      })
    }
  })
  tx()
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

// ── auto-purge: 6-hour retention window ─────────────────────────────────────
// Keep 6 hours of raw data. Archive to S3 before purging.
// If S3 fails, data stays in SQLite until next cycle succeeds.
const PURGE_AFTER_HOURS = 6

function getPurgeCutoff() {
  return new Date(Date.now() - PURGE_AFTER_HOURS * 3600_000).toISOString()
}

function purgeOldSightings(cutoff) {
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
    console.log(`  purge: archived ${deleted} sightings older than ${PURGE_AFTER_HOURS}h (${before} → ${_stmts.countSightings.get().c} rows)`)
  }
  return deleted
}

function purgeOldAnomalies(cutoff) {
  const del = db.prepare('DELETE FROM anomalies WHERE detected_at < ?').run(cutoff)
  if (del.changes > 0) {
    console.log(`  purge: deleted ${del.changes} anomalies older than ${PURGE_AFTER_HOURS}h`)
  }
  return del.changes
}

function purgeOldDailySummaries() {
  // Daily summaries older than 24h can go — they've been archived to S3
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
  const before = _stmts.countDaily.get().c
  const del = db.prepare('DELETE FROM sightings_daily WHERE date < ?').run(cutoff)
  if (del.changes > 0) {
    console.log(`  purge: deleted ${del.changes} old daily summaries (${before} → ${_stmts.countDaily.get().c} rows)`)
  }
  return del.changes
}

// Full purge cycle: delete everything older than retention window.
// S3 archival is disabled for now — just purge directly.
async function runPurgeCycle() {
  const cutoff = getPurgeCutoff()
  console.log(`purge: starting cycle (cutoff: ${cutoff})`)

  // TODO: re-enable S3 archival when ready
  // if (s3Enabled()) {
  //   const { ok, archived } = await archiveBeforePurge(db, cutoff)
  //   if (!ok && archived === 0) {
  //     console.error('  ⚠ S3 archive FAILED — skipping purge to preserve data')
  //     return
  //   }
  // }

  purgeOldSightings(cutoff)
  purgeOldAnomalies(cutoff)
  purgeOldDailySummaries()
  purgeStaleRoutes()

  // SWIM data purge — flight plans, flow events, surface events, weather, NOTAMs
  try {
    const tfms = purgeOldTfms()
    if (tfms.plans > 0 || tfms.events > 0) console.log(`  purge: ${tfms.plans} flight plans, ${tfms.events} flow events`)
    const surface = purgeOldSurfaceEvents()
    if (surface.changes > 0) console.log(`  purge: ${surface.changes} surface events`)
    const wx = purgeOldTerminalWeather()
    if (wx.changes > 0) console.log(`  purge: ${wx.changes} terminal weather events`)
    const notams = purgeExpiredNotams()
    if (notams.changes > 0) console.log(`  purge: ${notams.changes} expired NOTAMs`)
  } catch (err) {
    console.warn('  purge: SWIM data purge error:', err.message)
  }

  // Zone baseline rollup: aggregate yesterday's anomalies into daily zone data
  const zoneRows = rollupYesterday()
  if (zoneRows > 0) console.log(`  zone: rolled up ${zoneRows} zone-day records`)
  const zonePurged = purgeZoneDaily()
  if (zonePurged > 0) console.log(`  zone: purged ${zonePurged} zone records (>90d)`)

  vacuumDb()
}

function purgeStaleRoutes() {
  // Remove routes not updated in 60+ days — airline route changes, seasonal shifts
  const del = db.prepare("DELETE FROM callsign_routes WHERE updated_at < datetime('now', '-60 days')").run()
  if (del.changes > 0) {
    console.log(`  purge: deleted ${del.changes} stale route cache entries (>60d)`)
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

// ── startup: only warm dedup cache synchronously (fast) ─────────────────────
// Heavy maintenance (dedup scan, vacuum, purge) is deferred so Express can
// start listening before Fly's health check times out.
_warmDedup()
console.log(`db: ready (${(_stmts.countSightings.get().c).toLocaleString()} sightings, ${(_stmts.countDaily.get().c).toLocaleString()} daily summaries, ${(getDbSize() / 1048576).toFixed(1)} MB)`)

// Deferred heavy maintenance — runs after server is listening
function runDeferredMaintenance() {
  setTimeout(async () => {
    try {
      console.log('db: running deferred maintenance...')
      deduplicateExisting()
      vacuumDb()
      await runPurgeCycle()

      // Bootstrap zone baseline from historical anomalies if zone_daily is empty
      const zoneCount = db.prepare('SELECT COUNT(*) as c FROM zone_daily').get().c
      if (zoneCount === 0) {
        console.log('db: backfilling zone baseline (30 days)...')
        const filled = backfillZoneDaily(30)
        console.log(`db: backfilled ${filled} zone-day records`)
      }

      console.log('db: deferred maintenance complete')
    } catch (err) {
      console.error('deferred maintenance error:', err.message)
    }
  }, 15000) // 15s delay — gives Express + SWIM connections time to stabilize
}

// Force purge — bypasses S3, deletes everything outside the retention window
function forcePurge() {
  const cutoff = getPurgeCutoff()
  console.log(`force-purge: deleting all data older than ${cutoff}`)
  const sightings = purgeOldSightings(cutoff)
  const anomalies = purgeOldAnomalies(cutoff)
  const daily = purgeOldDailySummaries()
  vacuumDb()
  const remaining = _stmts.countSightings.get().c
  const size = getDbSize()
  console.log(`force-purge: complete (${remaining.toLocaleString()} sightings, ${(size / 1048576).toFixed(1)} MB)`)
  return { sightings, anomalies, daily, remaining, size_mb: +(size / 1048576).toFixed(1) }
}

// Schedule purge cycle every 6 hours (matches 6-hour retention window)
const _purgeTimer = setInterval(async () => {
  try {
    await runPurgeCycle()
  } catch (err) {
    console.error('purge cycle error:', err.message)
  }
}, 6 * 3600 * 1000)

// Graceful close: stop purge timer + close database connection
function close() {
  clearInterval(_purgeTimer)
  try { db.close() } catch {}
}

// ── Computed airport operations (cross-referencing TFMS + STDDS + ITWS) ─────

// Departure delay: compare TFMS ETD with STDDS actual OFF time for an airport
const _stmtDepDelay = db.prepare(`
  SELECT
    fp.acid,
    fp.etd,
    fp.arr_arpt,
    se.received_at AS actual_off,
    CAST((julianday(se.received_at) - julianday(fp.etd)) * 1440 AS INTEGER) AS delay_min
  FROM flight_plans fp
  JOIN surface_events se ON se.callsign = fp.acid AND se.event_type = 'OFF'
  WHERE fp.dep_arpt = ?
    AND fp.etd IS NOT NULL
    AND se.received_at > datetime('now', '-2 hours')
    AND fp.updated_at > datetime('now', '-2 hours')
  ORDER BY se.received_at DESC LIMIT ?
`)

// Arrival delay: compare TFMS ETA with STDDS actual ON time
const _stmtArrDelay = db.prepare(`
  SELECT
    fp.acid,
    fp.eta,
    fp.dep_arpt,
    se.received_at AS actual_on,
    CAST((julianday(se.received_at) - julianday(fp.eta)) * 1440 AS INTEGER) AS delay_min
  FROM flight_plans fp
  JOIN surface_events se ON se.callsign = fp.acid AND se.event_type = 'ON'
  WHERE fp.arr_arpt = ?
    AND fp.eta IS NOT NULL
    AND se.received_at > datetime('now', '-2 hours')
    AND fp.updated_at > datetime('now', '-2 hours')
  ORDER BY se.received_at DESC LIMIT ?
`)

// Taxi-out time: SPOT_OUT to OFF for an airport (minutes)
// Filters: same airport, > 1 min (eliminates radar noise), < 60 min, dedup by callsign
const _stmtTaxiOut = db.prepare(`
  SELECT callsign, MIN(taxi_min) AS taxi_min FROM (
    SELECT
      a.callsign,
      CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL) AS taxi_min
    FROM surface_events a
    JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'OFF' AND b.airport = a.airport
    WHERE a.airport = ? AND a.event_type = 'SPOT_OUT'
      AND a.received_at > datetime('now', '-2 hours')
      AND b.received_at > a.received_at
      AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 > 1
      AND b.received_at < datetime(a.received_at, '+60 minutes')
  ) GROUP BY callsign ORDER BY taxi_min DESC LIMIT ?
`)

// Taxi-in time: ON to SPOT_IN for an airport (minutes)
// Filters: same airport, > 1 min (eliminates radar noise), < 60 min, dedup by callsign
const _stmtTaxiIn = db.prepare(`
  SELECT callsign, MIN(taxi_min) AS taxi_min FROM (
    SELECT
      a.callsign,
      CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL) AS taxi_min
    FROM surface_events a
    JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'SPOT_IN' AND b.airport = a.airport
    WHERE a.airport = ? AND a.event_type = 'ON'
      AND a.received_at > datetime('now', '-2 hours')
      AND b.received_at > a.received_at
      AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 > 1
      AND b.received_at < datetime(a.received_at, '+60 minutes')
  ) GROUP BY callsign ORDER BY taxi_min DESC LIMIT ?
`)

// Inbound count: flights with arr_arpt = airport and active status
const _stmtInboundCount = db.prepare(`
  SELECT COUNT(*) as count FROM flight_plans
  WHERE arr_arpt = ? AND flight_status IN ('ACTIVE','ASCENDING','CRUISING','DESCENDING')
    AND updated_at > datetime('now', '-2 hours')
`)

// Outbound count: flights with dep_arpt = airport and active/filed status
const _stmtOutboundCount = db.prepare(`
  SELECT COUNT(*) as count FROM flight_plans
  WHERE dep_arpt = ? AND flight_status IN ('ACTIVE','ASCENDING','FILED')
    AND updated_at > datetime('now', '-2 hours')
`)

// Per-airport flight lists (direct DB query, not filtered from global 200)
const _stmtAirportArrivals = db.prepare(`
  SELECT acid, dep_arpt, arr_arpt, flight_status, eta, ata, altitude, speed, aircraft_type, lat, lon, beacon_code, reported_alt
  FROM flight_plans
  WHERE arr_arpt = ?
    AND flight_status IN ('ACTIVE','ASCENDING','CRUISING','DESCENDING','FILED')
    AND updated_at > datetime('now', '-2 hours')
  ORDER BY eta ASC LIMIT ?
`)

const _stmtAirportDepartures = db.prepare(`
  SELECT acid, dep_arpt, arr_arpt, flight_status, etd, atd, altitude, speed, aircraft_type, lat, lon, beacon_code, reported_alt
  FROM flight_plans
  WHERE dep_arpt = ?
    AND flight_status IN ('ACTIVE','ASCENDING','CRUISING','DESCENDING','FILED')
    AND updated_at > datetime('now', '-2 hours')
  ORDER BY etd ASC LIMIT ?
`)

// Recently completed arrivals (landed in last 30 min)
const _stmtRecentArrivals = db.prepare(`
  SELECT acid, dep_arpt, arr_arpt, flight_status, eta, ata, aircraft_type
  FROM flight_plans
  WHERE arr_arpt = ?
    AND flight_status = 'COMPLETED'
    AND updated_at > datetime('now', '-30 minutes')
  ORDER BY updated_at DESC LIMIT ?
`)

// Weather events at airport (ITWS)
const _stmtAirportWeather = db.prepare(`
  SELECT * FROM terminal_weather
  WHERE airport = ? AND received_at > datetime('now', '-1 hour')
  ORDER BY received_at DESC LIMIT ?
`)

// ── Analytics: Feature 1 — Congestion Prediction ────────────────────────────
const _stmtTaxiOut30 = db.prepare(`
  SELECT AVG(taxi_min) AS avg, COUNT(*) AS cnt FROM (
    SELECT MIN(CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL)) AS taxi_min
    FROM surface_events a
    JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'OFF' AND b.airport = a.airport
    WHERE a.airport = ? AND a.event_type = 'SPOT_OUT'
      AND a.received_at > datetime('now', '-30 minutes')
      AND b.received_at > a.received_at
      AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 BETWEEN 1 AND 60
    GROUP BY a.callsign
  )
`)

// ── Analytics: Feature 2 — Cascade Impact ───────────────────────────────────
const _stmtCascadeImpact = db.prepare(`
  SELECT
    COUNT(*) AS affected_flights,
    COUNT(DISTINCT dep_arpt) AS origin_airports,
    GROUP_CONCAT(DISTINCT dep_arpt) AS origins_list
  FROM flight_plans
  WHERE arr_arpt = ?
    AND flight_status IN ('ACTIVE', 'ASCENDING', 'CRUISING')
    AND updated_at > datetime('now', '-2 hours')
`)

// ── Analytics: Feature 3 — Airline Performance ──────────────────────────────
const _stmtAirlineTaxiOut = db.prepare(`
  SELECT airline, COUNT(*) AS flights, ROUND(AVG(taxi_min), 1) AS avg_taxi_out FROM (
    SELECT SUBSTR(a.callsign, 1, 3) AS airline, MIN(CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL)) AS taxi_min
    FROM surface_events a
    JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'OFF' AND b.airport = a.airport
    WHERE a.airport = ? AND a.event_type = 'SPOT_OUT'
      AND a.received_at > datetime('now', '-2 hours')
      AND b.received_at > a.received_at
      AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 BETWEEN 1 AND 60
    GROUP BY a.callsign
  ) GROUP BY airline HAVING flights >= 2 ORDER BY avg_taxi_out ASC
`)

const _stmtAirlineTaxiIn = db.prepare(`
  SELECT airline, COUNT(*) AS flights, ROUND(AVG(taxi_min), 1) AS avg_taxi_in FROM (
    SELECT SUBSTR(a.callsign, 1, 3) AS airline, MIN(CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL)) AS taxi_min
    FROM surface_events a
    JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'SPOT_IN' AND b.airport = a.airport
    WHERE a.airport = ? AND a.event_type = 'ON'
      AND a.received_at > datetime('now', '-2 hours')
      AND b.received_at > a.received_at
      AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 BETWEEN 1 AND 60
    GROUP BY a.callsign
  ) GROUP BY airline HAVING flights >= 2 ORDER BY avg_taxi_in ASC
`)

// ── Analytics: Feature 5 — Turnaround Time ──────────────────────────────────
const _stmtTurnaroundsByAirline = db.prepare(`
  SELECT airline, COUNT(*) AS turns, ROUND(AVG(turnaround_min), 0) AS avg, MIN(turnaround_min) AS min_turn, MAX(turnaround_min) AS max_turn FROM (
    SELECT SUBSTR(a.callsign, 1, 3) AS airline,
      MIN(CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS INTEGER)) AS turnaround_min
    FROM surface_events a
    JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'SPOT_OUT' AND b.airport = a.airport
    WHERE a.airport = ? AND a.event_type = 'SPOT_IN'
      AND a.received_at > datetime('now', '-6 hours')
      AND b.received_at > a.received_at
      AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 BETWEEN 15 AND 300
    GROUP BY a.callsign, a.received_at
  ) GROUP BY airline HAVING turns >= 2 ORDER BY avg ASC
`)

// ── Analytics: Feature 6 — Weather Causation ────────────────────────────────
const _stmtWeatherCausation = db.prepare(`
  SELECT
    fe.id AS flow_id, fe.event_type AS flow_type, fe.airport,
    fe.received_at AS flow_start, fe.end_time AS flow_end, fe.delay_minutes,
    tw.event_type AS weather_type, tw.severity, tw.received_at AS weather_time,
    tw.expiry_time AS weather_expiry, tw.text AS weather_text
  FROM flow_events fe
  LEFT JOIN terminal_weather tw
    ON tw.airport = fe.airport
    AND tw.received_at BETWEEN datetime(fe.received_at, '-15 minutes') AND fe.received_at
  WHERE fe.airport = ?
    AND fe.event_type IN ('GS', 'GDP')
    AND fe.received_at > datetime('now', '-12 hours')
  ORDER BY fe.received_at DESC
`)

// ── Analytics: Feature 4 — Route Deviation Aggregation ──────────────────────
const _stmtRouteDeviations = db.prepare(`
  SELECT dep_arpt, arr_arpt, COUNT(*) AS flights,
    ROUND(AVG(route_deviation), 1) AS avg_km, MAX(route_deviation) AS max_km
  FROM flight_plans
  WHERE route_deviation IS NOT NULL AND route_deviation > 0
    AND dep_arpt IS NOT NULL AND arr_arpt IS NOT NULL
    AND updated_at > datetime('now', '-2 hours')
  GROUP BY dep_arpt, arr_arpt
  HAVING flights >= 1
  ORDER BY avg_km DESC LIMIT ?
`)

function getAirportOps(airport) {
  const config = getAirportConfig(airport)
  const flowEvents = getFlowEventsByAirport(airport, 10)

  // Per-airport flight lists — queried directly by airport, not filtered from global 200
  const arrivals = _stmtAirportArrivals.all(airport, 150)
  const departures = _stmtAirportDepartures.all(airport, 150)
  const recentArrivals = _stmtRecentArrivals.all(airport, 20)

  // Delay computation
  const depDelays = _stmtDepDelay.all(airport, 20)
  const arrDelays = _stmtArrDelay.all(airport, 20)
  const avgDepDelay = depDelays.length > 0 ? Math.round(depDelays.reduce((s, d) => s + (d.delay_min || 0), 0) / depDelays.length) : null
  const avgArrDelay = arrDelays.length > 0 ? Math.round(arrDelays.reduce((s, d) => s + (d.delay_min || 0), 0) / arrDelays.length) : null

  // Taxi times
  const taxiOuts = _stmtTaxiOut.all(airport, 20)
  const taxiIns = _stmtTaxiIn.all(airport, 20)
  const avgTaxiOut = taxiOuts.length > 0 ? +(taxiOuts.reduce((s, t) => s + t.taxi_min, 0) / taxiOuts.length).toFixed(1) : null
  const avgTaxiIn = taxiIns.length > 0 ? +(taxiIns.reduce((s, t) => s + t.taxi_min, 0) / taxiIns.length).toFixed(1) : null

  // Capacity vs demand (use actual query counts, not the arrivals list length which may differ)
  const inbound = _stmtInboundCount.get(airport)?.count || 0
  const outbound = _stmtOutboundCount.get(airport)?.count || 0
  const arrRate = config?.arr_rate || null
  const depRate = config?.dep_rate || null

  // Weather
  const weather = _stmtAirportWeather.all(airport, 10)

  // Active restrictions
  const groundStop = flowEvents.find(e => e.event_type === 'GS')
  const gdp = flowEvents.find(e => e.event_type === 'GDP')

  // Feature 1: Congestion prediction — 30-min taxi-out vs 2-hr baseline
  let congestion = null
  if (avgTaxiOut != null) {
    const cur = _stmtTaxiOut30.get(airport)
    if (cur?.avg != null && cur.cnt >= 2) {
      const ratio = +(cur.avg / avgTaxiOut).toFixed(2)
      congestion = {
        current: +cur.avg.toFixed(1),
        baseline: avgTaxiOut,
        ratio,
        signal: ratio > 1.5 ? 'CONGESTION_BUILDING' : ratio > 1.2 ? 'ELEVATED' : 'NORMAL',
        samples: cur.cnt,
      }
    }
  }

  // Feature 2: Cascade impact — only when GS or GDP active
  let cascade = null
  if (groundStop || gdp) {
    const impact = _stmtCascadeImpact.get(airport)
    if (impact?.affected_flights > 0) {
      cascade = {
        affectedFlights: impact.affected_flights,
        originAirports: impact.origin_airports,
        origins: impact.origins_list?.split(',') || [],
        estimatedDelayMin: impact.affected_flights * ((gdp?.delay_minutes) || 30),
      }
    }
  }

  // Feature 3: Airline performance
  const airlineTaxiOut = _stmtAirlineTaxiOut.all(airport)
  const airlineTaxiIn = _stmtAirlineTaxiIn.all(airport)
  const airlineMap = {}
  for (const r of airlineTaxiOut) airlineMap[r.airline] = { airline: r.airline, flights: r.flights, avgTaxiOut: r.avg_taxi_out }
  for (const r of airlineTaxiIn) {
    if (!airlineMap[r.airline]) airlineMap[r.airline] = { airline: r.airline, flights: r.flights }
    airlineMap[r.airline].avgTaxiIn = r.avg_taxi_in
  }
  const airlinePerformance = Object.values(airlineMap).sort((a, b) => (a.avgTaxiOut || 99) - (b.avgTaxiOut || 99))

  // Feature 5: Turnaround times by airline
  const turnarounds = _stmtTurnaroundsByAirline.all(airport)

  // Feature 6: Weather causation — only when flow events exist
  let causation = []
  if (groundStop || gdp) {
    const raw = _stmtWeatherCausation.all(airport)
    // Group by flow event, pick earliest weather as probable cause
    const byFlow = {}
    for (const r of raw) {
      if (!byFlow[r.flow_id]) {
        byFlow[r.flow_id] = {
          flowType: r.flow_type, airport: r.airport,
          flowStart: r.flow_start, flowEnd: r.flow_end, delay: r.delay_minutes,
          weather: null,
        }
      }
      if (r.weather_type && !byFlow[r.flow_id].weather) {
        byFlow[r.flow_id].weather = {
          type: r.weather_type, severity: r.severity,
          time: r.weather_time, expiry: r.weather_expiry, text: r.weather_text,
        }
      }
    }
    causation = Object.values(byFlow)
  }

  return {
    airport,
    config: config || null,
    arrivals,
    departures,
    recentArrivals,
    flow: {
      events: flowEvents,
      groundStop: groundStop || null,
      gdp: gdp || null,
      cascade,
      causation,
    },
    delays: {
      departures: { avg: avgDepDelay, recent: depDelays.slice(0, 5), count: depDelays.length },
      arrivals: { avg: avgArrDelay, recent: arrDelays.slice(0, 5), count: arrDelays.length },
    },
    taxi: {
      out: { avg: avgTaxiOut, recent: taxiOuts.slice(0, 5), count: taxiOuts.length },
      in: { avg: avgTaxiIn, recent: taxiIns.slice(0, 5), count: taxiIns.length },
    },
    congestion,
    capacity: {
      inbound,
      outbound,
      arrRate,
      depRate,
      arrOverflow: arrRate ? Math.max(0, inbound - arrRate) : null,
      depOverflow: depRate ? Math.max(0, outbound - depRate) : null,
    },
    airlinePerformance,
    turnarounds,
    weather,
  }
}

// NAS-wide summary: all airports with active issues
function getRouteDeviations(limit = 20) {
  return _stmtRouteDeviations.all(limit)
}

function getNasSummary() {
  const flowPrograms = _stmts.getActiveFlowPrograms.all()
  const flowEvents = getActiveFlowEvents(100)
  const allEvents = [...flowPrograms, ...flowEvents]
  const configs = getAirportConfigs()

  // Aggregate by airport (programs + other events, deduplicated)
  const airports = {}
  const seen = new Set()
  for (const e of allEvents) {
    if (!e.airport) continue
    const key = `${e.id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!airports[e.airport]) airports[e.airport] = { airport: e.airport, events: [], maxDelay: 0 }
    airports[e.airport].events.push(e)
    if (e.delay_minutes > airports[e.airport].maxDelay) airports[e.airport].maxDelay = e.delay_minutes
  }

  // Add capacity data
  for (const ap of Object.values(airports)) {
    const cfg = configs.find(c => c.airport === ap.airport)
    if (cfg) ap.config = cfg
    const inbound = _stmtInboundCount.get(ap.airport)?.count || 0
    const outbound = _stmtOutboundCount.get(ap.airport)?.count || 0
    ap.inbound = inbound
    ap.outbound = outbound
  }

  // NAS health score (0-100, 100 = healthy)
  const totalGS = flowPrograms.filter(e => e.event_type === 'GS').length
  const totalGDP = flowPrograms.filter(e => e.event_type === 'GDP').length
  const totalDelay = flowPrograms.reduce((s, e) => s + (e.delay_minutes || 0), 0)
  const affectedAirports = Object.keys(airports).length

  let health = 100
  health -= totalGS * 15        // ground stops are severe
  health -= totalGDP * 5         // GDPs are moderate
  health -= Math.min(30, totalDelay / 10)  // accumulated delay
  health -= affectedAirports * 2 // breadth of impact
  health = Math.max(0, Math.min(100, Math.round(health)))

  return {
    health,
    groundStops: totalGS,
    gdps: totalGDP,
    totalDelayMin: Math.round(totalDelay),
    affectedAirports,
    airports: Object.values(airports).sort((a, b) => {
      const aGS = a.events.some(e => e.event_type === 'GS') ? 1 : 0
      const bGS = b.events.some(e => e.event_type === 'GS') ? 1 : 0
      if (aGS !== bGS) return bGS - aGS
      return b.maxDelay - a.maxDelay
    }),
    flowEvents,
  }
}

// ── NAS-wide analytics (batch queries for all airports) ─────────────────────

function getNasAnalytics() {
  const flowPrograms = _stmts.getActiveFlowPrograms.all()
  const flowEvents = [...flowPrograms, ...getActiveFlowEvents(100)]
  const configs = getAirportConfigs()

  // Batch: traffic counts per airport (all airports in one query)
  const trafficRows = db.prepare(`
    SELECT airport, direction, COUNT(*) as cnt FROM (
      SELECT arr_arpt AS airport, 'in' AS direction FROM flight_plans
        WHERE flight_status IN ('ACTIVE','ASCENDING','CRUISING','DESCENDING') AND updated_at > datetime('now', '-2 hours')
      UNION ALL
      SELECT dep_arpt AS airport, 'out' AS direction FROM flight_plans
        WHERE flight_status IN ('ACTIVE','ASCENDING','FILED') AND updated_at > datetime('now', '-2 hours')
    ) GROUP BY airport, direction
  `).all()
  const traffic = {}
  for (const r of trafficRows) {
    if (!traffic[r.airport]) traffic[r.airport] = { inbound: 0, outbound: 0 }
    traffic[r.airport][r.direction === 'in' ? 'inbound' : 'outbound'] = r.cnt
  }

  // Batch: avg taxi-out per airport (2hr baseline)
  const taxiOutRows = db.prepare(`
    SELECT airport, ROUND(AVG(taxi_min), 1) AS avg, COUNT(*) AS cnt FROM (
      SELECT a.airport, MIN(CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL)) AS taxi_min
      FROM surface_events a
      JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'OFF' AND b.airport = a.airport
      WHERE a.event_type = 'SPOT_OUT'
        AND a.received_at > datetime('now', '-2 hours')
        AND b.received_at > a.received_at
        AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 BETWEEN 1 AND 60
      GROUP BY a.airport, a.callsign
    ) GROUP BY airport HAVING cnt >= 2
  `).all()
  const taxiBaseline = {}
  for (const r of taxiOutRows) taxiBaseline[r.airport] = { avg: r.avg, cnt: r.cnt }

  // Batch: avg taxi-out per airport (30-min current)
  const taxiOut30Rows = db.prepare(`
    SELECT airport, ROUND(AVG(taxi_min), 1) AS avg, COUNT(*) AS cnt FROM (
      SELECT a.airport, MIN(CAST((julianday(b.received_at) - julianday(a.received_at)) * 1440 AS REAL)) AS taxi_min
      FROM surface_events a
      JOIN surface_events b ON a.callsign = b.callsign AND b.event_type = 'OFF' AND b.airport = a.airport
      WHERE a.event_type = 'SPOT_OUT'
        AND a.received_at > datetime('now', '-30 minutes')
        AND b.received_at > a.received_at
        AND (julianday(b.received_at) - julianday(a.received_at)) * 1440 BETWEEN 1 AND 60
      GROUP BY a.airport, a.callsign
    ) GROUP BY airport HAVING cnt >= 2
  `).all()
  const taxiCurrent = {}
  for (const r of taxiOut30Rows) taxiCurrent[r.airport] = { avg: r.avg, cnt: r.cnt }

  // Batch: avg dep/arr delay per airport
  const depDelayRows = db.prepare(`
    SELECT fp.dep_arpt AS airport,
      ROUND(AVG(CAST((julianday(se.received_at) - julianday(fp.etd)) * 1440 AS REAL)), 0) AS avg_delay,
      COUNT(*) AS cnt
    FROM flight_plans fp
    JOIN surface_events se ON se.callsign = fp.acid AND se.event_type = 'OFF'
    WHERE fp.etd IS NOT NULL
      AND se.received_at > datetime('now', '-2 hours')
      AND fp.updated_at > datetime('now', '-2 hours')
    GROUP BY fp.dep_arpt HAVING cnt >= 2
  `).all()
  const depDelays = {}
  for (const r of depDelayRows) depDelays[r.airport] = { avg: Math.round(r.avg_delay), cnt: r.cnt }

  const arrDelayRows = db.prepare(`
    SELECT fp.arr_arpt AS airport,
      ROUND(AVG(CAST((julianday(se.received_at) - julianday(fp.eta)) * 1440 AS REAL)), 0) AS avg_delay,
      COUNT(*) AS cnt
    FROM flight_plans fp
    JOIN surface_events se ON se.callsign = fp.acid AND se.event_type = 'ON'
    WHERE fp.eta IS NOT NULL
      AND se.received_at > datetime('now', '-2 hours')
      AND fp.updated_at > datetime('now', '-2 hours')
    GROUP BY fp.arr_arpt HAVING cnt >= 2
  `).all()
  const arrDelays = {}
  for (const r of arrDelayRows) arrDelays[r.airport] = { avg: Math.round(r.avg_delay), cnt: r.cnt }

  // Build per-airport flow event map (deduplicated)
  const flowMap = {}
  const seenIds = new Set()
  for (const e of flowEvents) {
    if (!e.airport || seenIds.has(e.id)) continue
    seenIds.add(e.id)
    if (!flowMap[e.airport]) flowMap[e.airport] = { events: [], hasGS: false, hasGDP: false, maxDelay: 0 }
    flowMap[e.airport].events.push(e)
    if (e.event_type === 'GS') flowMap[e.airport].hasGS = true
    if (e.event_type === 'GDP') flowMap[e.airport].hasGDP = true
    if (e.delay_minutes > flowMap[e.airport].maxDelay) flowMap[e.airport].maxDelay = e.delay_minutes
  }

  // Build config map
  const configMap = {}
  for (const c of configs) configMap[c.airport] = c

  // Collect all airports that have any data
  const allAirports = new Set([
    ...Object.keys(traffic),
    ...Object.keys(taxiBaseline),
    ...Object.keys(flowMap),
    ...Object.keys(depDelays),
    ...Object.keys(arrDelays),
  ])

  // Score and build each airport entry
  const airports = []
  for (const airport of allAirports) {
    const t = traffic[airport] || { inbound: 0, outbound: 0 }
    const tb = taxiBaseline[airport]
    const tc = taxiCurrent[airport]
    const dd = depDelays[airport]
    const ad = arrDelays[airport]
    const fl = flowMap[airport]
    const cfg = configMap[airport]

    // Congestion signal
    let congestion = 'NORMAL'
    let congestionRatio = null
    if (tb && tc) {
      congestionRatio = +(tc.avg / tb.avg).toFixed(2)
      congestion = congestionRatio > 1.5 ? 'CONGESTION_BUILDING' : congestionRatio > 1.2 ? 'ELEVATED' : 'NORMAL'
    }

    // Cascade impact (only for GS/GDP airports)
    let cascade = null
    if (fl?.hasGS || fl?.hasGDP) {
      const impact = _stmtCascadeImpact.get(airport)
      if (impact?.affected_flights > 0) {
        cascade = {
          affectedFlights: impact.affected_flights,
          originAirports: impact.origin_airports,
          origins: impact.origins_list?.split(',') || [],
        }
      }
    }

    // Severity score for sorting (higher = worse)
    let severity = 0
    if (fl?.hasGS) severity += 100
    if (fl?.hasGDP) severity += 50
    if (congestion === 'CONGESTION_BUILDING') severity += 30
    else if (congestion === 'ELEVATED') severity += 10
    if (dd?.avg > 15) severity += 20
    else if (dd?.avg > 5) severity += 5
    if (ad?.avg > 15) severity += 20
    else if (ad?.avg > 5) severity += 5
    if (cascade) severity += cascade.affectedFlights

    airports.push({
      airport,
      inbound: t.inbound,
      outbound: t.outbound,
      arrRate: cfg?.arr_rate || null,
      depRate: cfg?.dep_rate || null,
      taxiOut: tb?.avg || null,
      taxiOutCurrent: tc?.avg || null,
      congestion,
      congestionRatio,
      depDelay: dd?.avg || null,
      depDelaySamples: dd?.cnt || 0,
      arrDelay: ad?.avg || null,
      arrDelaySamples: ad?.cnt || 0,
      hasGS: fl?.hasGS || false,
      hasGDP: fl?.hasGDP || false,
      maxFlowDelay: fl?.maxDelay || 0,
      cascade,
      severity,
    })
  }

  // Sort by severity descending
  airports.sort((a, b) => b.severity - a.severity)

  // NAS health score
  const totalGS = Object.values(flowMap).filter(f => f.hasGS).length
  const totalGDP = Object.values(flowMap).filter(f => f.hasGDP).length
  const congestionCount = airports.filter(a => a.congestion === 'CONGESTION_BUILDING').length
  const elevatedCount = airports.filter(a => a.congestion === 'ELEVATED').length

  let health = 100
  health -= totalGS * 15
  health -= totalGDP * 5
  health -= congestionCount * 10
  health -= elevatedCount * 3
  health = Math.max(0, Math.min(100, Math.round(health)))

  return {
    health,
    groundStops: totalGS,
    gdps: totalGDP,
    congestionBuilding: congestionCount,
    elevated: elevatedCount,
    totalAirports: airports.length,
    airports,
  }
}

// ── Flight lifecycle stitching (TFMS + STDDS cross-reference) ───────────────

const _stmtLifecycleEvents = db.prepare(`
  SELECT event_type, airport, runway, received_at
  FROM surface_events
  WHERE callsign = ?
    AND event_type IN ('SPOT_OUT','OFF','ON','SPOT_IN')
    AND received_at > datetime('now', '-6 hours')
  ORDER BY received_at ASC
`)

function getFlightLifecycle(callsign) {
  // 1. Get TFMS flight plan
  const plan = getFlightPlan(callsign)

  // 2. Get all STDDS surface events for this callsign
  const rawEvents = _stmtLifecycleEvents.all(callsign)

  // 3. Deduplicate — take first occurrence of each event type per airport
  // (STDDS often sends duplicate ON/OFF from multiple radar sources)
  const seen = new Set()
  const events = []
  for (const e of rawEvents) {
    const key = `${e.event_type}:${e.airport}:${e.received_at.substring(0, 16)}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push(e)
  }

  // 4. Build timeline phases
  const phases = []
  let gateOut = null, wheelsOff = null, wheelsOn = null, gateIn = null

  for (const e of events) {
    if (e.event_type === 'SPOT_OUT' && !gateOut) gateOut = e
    if (e.event_type === 'OFF' && !wheelsOff) wheelsOff = e
    // For ON/SPOT_IN, take the LAST one (arrival airport, not departure taxi wiggle)
    if (e.event_type === 'ON') wheelsOn = e
    if (e.event_type === 'SPOT_IN') gateIn = e
  }

  // 5. Compute derived times
  const taxiOut = gateOut && wheelsOff
    ? +((new Date(wheelsOff.received_at) - new Date(gateOut.received_at)) / 60000).toFixed(1)
    : null
  const taxiIn = wheelsOn && gateIn
    ? +((new Date(gateIn.received_at) - new Date(wheelsOn.received_at)) / 60000).toFixed(1)
    : null
  const flightTime = wheelsOff && wheelsOn
    ? +((new Date(wheelsOn.received_at) - new Date(wheelsOff.received_at)) / 60000).toFixed(1)
    : null
  const gateToGate = gateOut && (gateIn || wheelsOn)
    ? +((new Date((gateIn || wheelsOn).received_at) - new Date(gateOut.received_at)) / 60000).toFixed(1)
    : null

  // 6. Compute delays vs TFMS plan
  let depDelay = null, arrDelay = null
  if (plan?.etd && (wheelsOff || gateOut)) {
    const actual = new Date((wheelsOff || gateOut).received_at)
    const planned = new Date(plan.etd)
    if (!isNaN(actual) && !isNaN(planned)) depDelay = Math.round((actual - planned) / 60000)
  }
  if (plan?.eta && wheelsOn) {
    const actual = new Date(wheelsOn.received_at)
    const planned = new Date(plan.eta)
    if (!isNaN(actual) && !isNaN(planned)) arrDelay = Math.round((actual - planned) / 60000)
  }

  return {
    callsign,
    plan: plan ? {
      dep_arpt: plan.dep_arpt,
      arr_arpt: plan.arr_arpt,
      aircraft_type: plan.aircraft_type,
      flight_status: plan.flight_status,
      etd: plan.etd,
      eta: plan.eta,
      atd: plan.atd,
      ata: plan.ata,
      route: plan.route,
      beacon_code: plan.beacon_code,
    } : null,
    events,
    milestones: {
      gateOut: gateOut ? { airport: gateOut.airport, time: gateOut.received_at, runway: gateOut.runway } : null,
      wheelsOff: wheelsOff ? { airport: wheelsOff.airport, time: wheelsOff.received_at, runway: wheelsOff.runway } : null,
      wheelsOn: wheelsOn ? { airport: wheelsOn.airport, time: wheelsOn.received_at, runway: wheelsOn.runway } : null,
      gateIn: gateIn ? { airport: gateIn.airport, time: gateIn.received_at, runway: gateIn.runway } : null,
    },
    times: {
      taxiOut,
      taxiIn,
      flightTime,
      gateToGate,
    },
    delays: {
      departure: depDelay,
      arrival: arrDelay,
    },
  }
}

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
  runPurgeCycle,
  runDeferredMaintenance,
  deduplicateExisting,
  vacuumDb,
  DB_PATH,
  recordAnomalies,
  resolveAnomalies,
  getRecentAnomalies,
  getActiveAnomalies,
  getAnomaliesByIcao,
  getAnomalyStats,
  getAnomalyHotspots,
  getAnomaliesByZone,
  setAnomalyFeedback,
  getFeedbackStats,
  getTrafficHeatmap,
  rollupYesterday,
  purgeZoneDaily,
  backfillZoneDaily,
  forcePurge,
  getRoute,
  getRoutesBulk,
  upsertRoute,
  upsertRoutesBatch,
  touchRoutes,
  getRouteCount,
  getStaleRoutes,
  getAircraftCacheBulk,
  getAircraftCacheIcaos,
  getUnknownAircraftIcaos,
  upsertAircraftCache,
  buildRouteBaselines,
  getRouteBaseline,
  getAllBaselines,
  upsertNotam,
  upsertNotamBatch,
  getActiveTfrs,
  getActiveNotamsByLocation,
  getNotamStats,
  getNotamsByAirport,
  getNotamsForLocation,
  getRecentNotams,
  purgeExpiredNotams,
  upsertFlightPlan,
  upsertFlightPlanBatch,
  insertFlowEvent,
  getFlightPlan,
  getActiveFlightPlans,
  getActiveFlowEvents,
  getFlightPositions,
  getSurfacePositions,
  getFlowEventsByAirport,
  getTfmsStats,
  purgeOldTfms,
  getAirportConfigs,
  getAirportConfig,
  insertSurfaceEvent,
  getRecentSurfaceEvents,
  getSurfaceEventsByAirport,
  getOooi,
  getSurfaceStats,
  purgeOldSurfaceEvents,
  insertTerminalWeather,
  getRecentTerminalWeather,
  getTerminalWeatherByAirport,
  getTerminalWeatherStats,
  purgeOldTerminalWeather,
  getAirportOps,
  getNasSummary,
  getFlightLifecycle,
  getRouteDeviations,
  getNasAnalytics,
  close,
}
