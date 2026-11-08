const fs = require('fs')
const os = require('os')
const path = require('path')
const request = require('supertest')

// Never touch the real SQLite file or any provider (including paid APIs).
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightterm-correctness-'))
Object.assign(process.env, {
  DB_DIR: testDir, AEROAPI_KEY: 'test-owner-key', ADMIN_SECRET: 'test-admin',
  SWIM_INTERNAL_SECRET: 'test-internal', SWIM_WORKER_URL: 'http://test-worker.invalid',
  FLY_MACHINES_TOKEN: '', SWIM_WAKE_TOKEN: '', S3_BUCKET: 'test-configured-bucket',
  PURGE_AFTER_HOURS: '2', POLLER_ENABLED: 'false', BUSINESS_JET_TRACKER_DISABLED: 'true',
})
const axios = require('axios')
axios.get = vi.fn()
axios.post = vi.fn()
const storage = require('./db')
const swim = require('./swim')
swim.startAll = vi.fn().mockResolvedValue({})
swim.getStatus = vi.fn().mockReturnValue({ workerConnected: true })
const { app, drainSwimSync } = require('./index')
const sql = storage.db

beforeEach(() => {
  sql.exec('DELETE FROM api_usage; DELETE FROM sightings; DELETE FROM sightings_daily; DELETE FROM anomalies; DELETE FROM zone_daily; DELETE FROM zone_daily_aircraft; DELETE FROM callsign_routes; DELETE FROM fetches;')
  axios.get.mockReset().mockResolvedValue({ data: { flights: [] } })
  axios.post.mockReset().mockResolvedValue({ data: {} })
  swim.startAll.mockClear()
  process.env.AEROAPI_KEY = 'test-owner-key'
  process.env.ADMIN_SECRET = 'test-admin'
})
afterAll(() => {
  swim.stopAll()
  storage.close()
  fs.rmSync(testDir, { recursive: true, force: true })
})

function seedSpend(credits, calledAt) {
  storage.recordApiCall({ service: 'aeroapi', endpoint: '/seed', credits, status: 200 })
  if (calledAt) sql.prepare('UPDATE api_usage SET called_at = ?').run(calledAt)
}

describe('paid request budget enforcement', () => {
  it('admits only two of three simultaneous calls with $0.010 left', async () => {
    seedSpend(4.99)
    const waiting = []
    axios.get.mockImplementation(() => new Promise(resolve => waiting.push(resolve)))
    const pending = ['ONE', 'TWO', 'THREE'].map(ident => request(app).get(`/api/aero/flights/${ident}`).then(r => r))
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2))
      expect(storage.getAeroSpendTotal().total_spend).toBe(5)
      expect(sql.prepare('SELECT COUNT(*) AS n FROM api_usage WHERE status = 102').get().n).toBe(2)
    } finally {
      for (const resolve of waiting) resolve({ data: { flights: [{}] } })
    }
    const replies = await Promise.all(pending)
    expect(replies.map(r => r.status).sort()).toEqual([200, 200, 403])
    expect(axios.get).toHaveBeenCalledTimes(2)
    expect(storage.getAeroSpendTotal()).toEqual({ total_spend: 5, total_calls: 3 })
    expect(sql.prepare('SELECT COUNT(*) AS n FROM api_usage WHERE status = 102').get().n).toBe(0)
  })

  it.each(['1000', '0', '-1', 'NaN', '1.5', '1&max_pages=2'])('rejects unsupported max_pages=%s before any provider call', async value => {
    const response = await request(app).get(`/api/aero/flights/UAL123?max_pages=${value}`)
    expect(response.status).toBe(400)
    expect(axios.get).not.toHaveBeenCalled()
    expect(storage.getAeroSpendTotal().total_calls).toBe(0)
  })

  it('defaults to a single page and bounds the upstream request', async () => {
    const response = await request(app).get('/api/aero/flights/UAL123')
    expect(response.status).toBe(200)
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/flights/UAL123'), expect.objectContaining({
      params: { max_pages: 1 }, timeout: 15000, maxRedirects: 0,
    }))
  })

  it('does not let identifiers inject a provider query or path', async () => {
    const response = await request(app).get('/api/aero/flights/UAL123%3Fmax_pages%3D1000')
    expect(response.status).toBe(400)
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('keeps personal-key charges outside the owner ledger, even at the owner cap', async () => {
    seedSpend(5)
    const response = await request(app).get('/api/aero/flights/UAL123').set('x-user-aero-key', 'test-personal-key')
    expect(response.status).toBe(200)
    expect(storage.getAeroSpendTotal()).toEqual({ total_spend: 5, total_calls: 1 })
    expect(sql.prepare("SELECT service, credits FROM api_usage WHERE endpoint = '/flights/UAL123'").get()).toEqual({ service: 'aeroapi_user', credits: 0.005 })
    expect(axios.get.mock.calls[0][1].headers['x-apikey']).toBe('test-personal-key')
  })

  it('releases a known nonbillable rejection without double recording the call', async () => {
    seedSpend(4.995)
    axios.get.mockRejectedValueOnce({ response: { status: 404, data: { title: 'Unknown flight' } } })
    expect((await request(app).get('/api/aero/flights/UNKNOWN')).status).toBe(404)
    expect(storage.getAeroSpendTotal()).toEqual({ total_spend: 4.995, total_calls: 2 })
    expect((await request(app).get('/api/aero/flights/UAL123')).status).toBe(200)
    expect(storage.getAeroSpendTotal().total_spend).toBe(5)
  })

  it('keeps uncertain charges reserved after a timeout', async () => {
    seedSpend(4.995)
    axios.get.mockRejectedValueOnce(new Error('timeout'))
    expect((await request(app).get('/api/aero/flights/UAL123')).status).toBe(500)
    expect((await request(app).get('/api/aero/flights/UAL456')).status).toBe(403)
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(storage.getAeroSpendTotal().total_spend).toBe(5)
  })

  it('fails closed without contacting the provider if the reservation cannot be saved', async () => {
    sql.exec("CREATE TEMP TRIGGER reject_budget BEFORE INSERT ON api_usage BEGIN SELECT RAISE(ABORT, 'test write failure'); END")
    try {
      const response = await request(app).get('/api/aero/flights/UAL123')
      expect(response.status).toBe(503)
      expect(axios.get).not.toHaveBeenCalled()
      expect(storage.getAeroSpendTotal().total_spend).toBe(0)
    } finally { sql.exec('DROP TRIGGER reject_budget') }
  })

  it('counts an unsettled reservation from another database connection', () => {
    seedSpend(4.995)
    const reservation = storage.reserveAeroCall({ endpoint: '/flights/INFLIGHT', credits: 0.005, cap: 5 })
    const connection = new (require('better-sqlite3'))(storage.DB_PATH)
    try {
      expect(connection.prepare("SELECT ROUND(SUM(credits), 3) AS spend FROM api_usage WHERE service = 'aeroapi'").get().spend).toBe(5)
      expect(storage.reserveAeroCall({ endpoint: '/flights/NEXT', credits: 0.005, cap: 5 }).allowed).toBe(false)
      expect(reservation.allowed).toBe(true)
    } finally { connection.close() }
  })

  it('reports the same lifetime cap it enforces, independently of provider account usage', async () => {
    seedSpend(5, '2020-01-01T00:00:00.000Z')
    axios.get.mockResolvedValue({ data: { total_cost: 0, total_calls: 0 } })
    const response = await request(app).get('/api/aero/spend')
    expect(response.body).toMatchObject({ total_spend: 5, cap_remaining: 0, cap_reached: true, cap_scope: 'lifetime', account_spend: 0 })
    expect((await request(app).get('/api/aero/flights/UAL123')).status).toBe(403)
  })

  it('includes reservations made while account usage is being fetched', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000)
    let release
    axios.get.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = request(app).get('/api/aero/spend').then(r => r)
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      seedSpend(4.995)
      storage.reserveAeroCall({ endpoint: '/flights/INFLIGHT', credits: 0.005, cap: 5 })
      release({ data: { total_cost: 0 } })
      expect((await pending).body).toMatchObject({ total_spend: 5, cap_reached: true })
    } finally {
      release?.({ data: {} })
      clock.mockRestore()
    }
  })
})

const route = { callsign: 'UAL123', origin_icao: 'KJFK', destination_icao: 'KLAX', origin_lat: 40.6, origin_lon: -73.7, destination_lat: 33.9, destination_lon: -118.4, source: 'tfms' }
describe('trusted ingestion', () => {
  it('blocks anonymous or incorrectly authenticated attempts to overwrite FAA routes', async () => {
    storage.upsertRoutesBatch([route])
    for (const secret of [null, 'wrong']) {
      const req = request(app).post('/api/routes/save').send({ routes: [{ ...route, destination_icao: 'KFAKE' }] })
      if (secret) req.set('x-admin-secret', secret)
      expect((await req).status).toBe(401)
    }
    expect(storage.getRoute(route.callsign).destination_icao).toBe('KLAX')
  })

  it('blocks anonymous sightings without changing the database', async () => {
    expect((await request(app).post('/api/sightings').send({ flights: [{ icao: 'abc123' }] })).status).toBe(401)
    expect(sql.prepare('SELECT COUNT(*) AS n FROM sightings').get().n).toBe(0)
  })

  it('fails closed when admin ingestion is not configured', async () => {
    process.env.ADMIN_SECRET = ''
    expect((await request(app).post('/api/routes/save').send({ routes: [route] })).status).toBe(403)
  })

  it('retains authenticated route ingestion, validation, and public read access', async () => {
    expect((await request(app).post('/api/routes/save').set('x-admin-secret', 'test-admin').send({ routes: [route] })).status).toBe(200)
    expect((await request(app).post('/api/routes/save').set('x-admin-secret', 'test-admin').send({ routes: [{ ...route, destination_lat: 1000 }] })).status).toBe(400)
    const response = await request(app).post('/api/routes/lookup').send({ callsigns: [route.callsign] })
    expect(response.status).toBe(200)
    expect(response.body.routes.UAL123.destination_icao).toBe('KLAX')
  })

  it('retains validated administrative sightings ingestion', async () => {
    const response = await request(app).post('/api/sightings').set('x-admin-secret', 'test-admin').send({ flights: [{ icao: 'def456', lat: 40, lon: -74, alt: 1000 }], source: 'test' })
    expect(response.status).toBe(200)
    expect(response.body.recorded).toBe(1)
    expect(sql.prepare('SELECT icao FROM sightings').get().icao).toBe('def456')
    expect((await request(app).post('/api/sightings').set('x-admin-secret', 'test-admin').send({ flights: [{ icao: 'invalid' }] })).status).toBe(400)
  })

  it('keeps FAA worker ingestion behind its existing internal credential', async () => {
    expect((await request(app).post('/internal/swim/routes').send({ routes: [route] })).status).toBe(401)
    const response = await request(app).post('/internal/swim/routes').set('Authorization', 'Bearer test-internal').send({ routes: [route] })
    expect(response.status).toBe(200)
    drainSwimSync()
    expect(storage.getRoute(route.callsign)).toMatchObject({ destination_icao: 'KLAX', source: 'tfms' })
  })
})

// Use a fixed clock away from midnight so separate purges share a UTC day.
const now = new Date('2026-11-08T18:00:00.000Z').getTime()
const at = hoursAgo => new Date(now - hoursAgo * 3600_000).toISOString()
function sighting(hoursAgo, alt, vel, callsign = 'TEST123') {
  sql.prepare('INSERT INTO sightings (icao, callsign, country, alt, vel, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run('abc123', callsign, 'United States', alt, vel, at(hoursAgo))
}
async function purge() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try { await storage.runPurgeCycle({ vacuum: false }) } finally { clock.mockRestore() }
}

describe('incremental retention rollups', () => {
  it.each(['TEST123', null])('accumulates batches and non-null weighted means for callsign %s', async callsign => {
    sighting(4, 100, 10, callsign)
    sighting(3.5, null, 20, callsign)
    await purge()
    sighting(3, 300, null, callsign)
    sighting(2.5, 500, 30, callsign)
    await purge()
    await purge() // Repeating a purge cannot double count.
    const rows = sql.prepare('SELECT * FROM sightings_daily').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sighting_count: 4, avg_alt: 300, avg_vel: 20, alt_sample_count: 3, vel_sample_count: 3, min_alt: 100, max_alt: 500, first_seen: at(4), last_seen: at(2.5) })
    expect(sql.prepare('SELECT COUNT(*) AS n FROM sightings').get().n).toBe(0)
  })

  it('retains null means when every measurement is missing', async () => {
    sighting(4, null, null)
    await purge()
    sighting(3, null, null)
    await purge()
    expect(sql.prepare('SELECT * FROM sightings_daily').get()).toMatchObject({ sighting_count: 2, avg_alt: null, avg_vel: null, min_alt: null, max_alt: null })
  })

  it('preserves recent raw rows under the unchanged retention window', async () => {
    sighting(3, 100, 10)
    sighting(1, 200, 20)
    await purge()
    expect(sql.prepare('SELECT alt FROM sightings').all()).toEqual([{ alt: 200 }])
    expect(sql.prepare('SELECT sighting_count FROM sightings_daily').get().sighting_count).toBe(1)
  })

  it('rolls back the rollup when deletion fails so a retry cannot double count', async () => {
    sighting(3, 100, 10)
    sql.exec("CREATE TEMP TRIGGER reject_purge BEFORE DELETE ON sightings BEGIN SELECT RAISE(ABORT, 'test purge failure'); END")
    try {
      await expect(purge()).rejects.toThrow('test purge failure')
      expect(sql.prepare('SELECT COUNT(*) AS n FROM sightings_daily').get().n).toBe(0)
      expect(sql.prepare('SELECT COUNT(*) AS n FROM sightings').get().n).toBe(1)
    } finally { sql.exec('DROP TRIGGER reject_purge') }
    await purge()
    expect(sql.prepare('SELECT sighting_count FROM sightings_daily').get().sighting_count).toBe(1)
  })

  it('upgrades an existing daily-summary schema and consolidates legacy NULL callsigns', () => {
    const legacyDir = path.join(testDir, 'legacy')
    fs.mkdirSync(legacyDir)
    const legacy = new (require('better-sqlite3'))(path.join(legacyDir, 'flightterm.db'))
    legacy.exec(`
      CREATE TABLE sightings_daily (
        id INTEGER PRIMARY KEY, date TEXT, icao TEXT, callsign TEXT, country TEXT, source TEXT, region TEXT,
        sighting_count INTEGER, avg_lat REAL, avg_lon REAL, avg_alt REAL, avg_vel REAL,
        min_alt REAL, max_alt REAL, mil INTEGER DEFAULT 0, first_seen TEXT, last_seen TEXT,
        UNIQUE(date, icao, callsign)
      );
      INSERT INTO sightings_daily (date, icao, sighting_count, avg_alt, avg_vel, min_alt, max_alt)
      VALUES ('2026-11-08', 'abc123', 2, 100, 10, 100, 100), ('2026-11-08', 'abc123', 1, 400, NULL, 400, 400);
    `)
    legacy.close()
    const script = `
      const assert = require('node:assert/strict');
      const storage = require(${JSON.stringify(path.join(__dirname, 'db.js'))});
      Date.now = () => ${now};
      storage.db.prepare('INSERT INTO sightings (icao, alt, vel, seen_at) VALUES (?, ?, ?, ?)').run('abc123', 500, 20, '${at(3)}');
      (async () => {
        await storage.runPurgeCycle({ vacuum: false });
        const rows = storage.db.prepare('SELECT * FROM sightings_daily').all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sighting_count, 4);
        assert.equal(rows[0].avg_alt, 275);
        assert.equal(rows[0].avg_vel, 40 / 3);
        storage.close();
      })().catch(err => { console.error(err); process.exitCode = 1; });
    `
    require('child_process').execFileSync(process.execPath, ['-e', script], { env: { ...process.env, DB_DIR: legacyDir }, timeout: 10000, stdio: 'pipe' })
  })

  it('rolls up zone counts before deletion, without duplicating aircraft across batches', async () => {
    const insert = sql.prepare('INSERT INTO anomalies (icao, score, severity, category, lat, lon, detected_at) VALUES (?, 80, ?, ?, 40, -74, ?)')
    insert.run('abc123', 'HIGH', 'speed', at(4))
    await purge()
    insert.run('abc123', 'CRITICAL', 'emergency', at(3))
    insert.run('def456', 'MEDIUM', 'speed', at(2.5))
    await purge()
    await purge()
    expect(sql.prepare('SELECT * FROM zone_daily').get()).toMatchObject({ count: 3, unique_aircraft: 2, critical: 1, high: 1, medium: 1, categories: 'emergency,speed' })
    expect(sql.prepare('SELECT COUNT(*) AS n FROM anomalies').get().n).toBe(0)
  })

  it('keeps backfills idempotent when later purges consume the same anomaly rows', async () => {
    sql.prepare('INSERT INTO anomalies (icao, score, severity, category, lat, lon, detected_at) VALUES (?, 80, ?, ?, 40, -74, ?)').run('abc123', 'HIGH', 'speed', at(24))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect(storage.rollupYesterday()).toBe(1)
      expect(storage.rollupYesterday()).toBe(0)
    } finally { clock.mockRestore() }
    await purge()
    expect(sql.prepare('SELECT count, unique_aircraft FROM zone_daily').get()).toEqual({ count: 1, unique_aircraft: 1 })
    expect(sql.prepare('SELECT COUNT(*) AS n FROM zone_daily_aircraft').get().n).toBe(0)
  })
})

describe('cost-preserving wake and archive status', () => {
  it('serves the homepage without polling or waking the FAA worker', async () => {
    await request(app).get('/')
    await request(app).get('/index.html')
    expect(swim.startAll).not.toHaveBeenCalled()
    expect(axios.get).not.toHaveBeenCalled()
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('still activates worker polling for actual NAS requests', async () => {
    expect((await request(app).get('/api/swim/status')).status).toBe(200)
    expect(swim.startAll).toHaveBeenCalledOnce()
  })

  it('reports configured-but-disabled archival and the actual purge policy', async () => {
    const response = await request(app).get('/api/health/archive')
    expect(response.body).toMatchObject({ configured: true, enabled: false, retention_hours: 2, purge_interval: '30m', purge_interval_ms: 1800000, totalRuns: 0 })
    expect(response.body.message).toContain('data purged without archival')
    expect((await request(app).get('/api/keys')).body.s3_archive).toMatchObject({ configured: true, enabled: false })
    expect(await require('./s3archive').archiveBeforePurge(sql, at(2))).toEqual({ ok: false, reason: 'disabled' })
  })
})
