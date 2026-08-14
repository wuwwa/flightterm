// ── Integration tests ─────────────────────────────────────────────────────────
// End-to-end: poller detects anomaly → event emits → SSE stream delivers → API serves

const fs = require('fs')
const os = require('os')
const path = require('path')
const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flightterm-integration-test-'))
process.env.DB_DIR = TEST_DB_DIR
process.env.ANOMALY_DETECTION_ENABLED = 'true'
process.env.ANOMALY_SCORE_DIVISOR = '1'
process.env.COMMUNITY_POINT_DELAY_MS = '0'

const mockGet = vi.fn()
const mockPost = vi.fn()

// Patch axios before any module loads
const axios = require('axios')
axios.get = mockGet
axios.post = mockPost

// Patch db with spies that pass through to real db
const db = require('./db')
const realRecordAnomalies = db.recordAnomalies
const realResolveAnomalies = db.resolveAnomalies
const spyRecordAnomalies = vi.fn((...args) => realRecordAnomalies(...args))
const spyResolveAnomalies = vi.fn((...args) => realResolveAnomalies(...args))
db.recordAnomalies = spyRecordAnomalies
db.resolveAnomalies = spyResolveAnomalies
db.getRoutesBulk = vi.fn(() => ({}))

const request = require('supertest')
process.env.ADMIN_SECRET = 'test-secret'
const { app } = require('./index')
const poller = require('./poller')
const { _internals } = poller
const { trackHistory, activeAnomalies, anomalyMisses } = _internals

const NOW = 1711500000000

function makeState(icao, callsign, opts = {}) {
  return [
    icao, callsign + '  ', 'United States', null, null,
    opts.lon ?? -74.0, opts.lat ?? 40.0, opts.alt ?? 10000,
    opts.grounded ?? false, opts.vel ?? 230, opts.hdg ?? 90,
    opts.vertRate ?? 0, null, opts.geoAlt ?? 10000,
    opts.squawk ?? '1200', false, opts.posSrc ?? 0, null,
  ]
}

function seedHistory(icao) {
  trackHistory.set(icao, [
    { ts: NOW - 180000, alt: 10000, vel: 230, hdg: 90, grounded: false, vertRate: 0, posSrc: 0, ndb: null },
    { ts: NOW - 90000, alt: 10000, vel: 230, hdg: 90, grounded: false, vertRate: 0, posSrc: 0, ndb: null },
  ])
}

function mockFlights(states) {
  mockGet.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('opensky'))
      return Promise.resolve({ data: { states } })
    return Promise.resolve({ data: [] })
  })
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  _internals.resetTestState()
  vi.clearAllMocks()
  mockGet.mockImplementation(() => Promise.resolve({ data: [] }))
  mockPost.mockImplementation(() => Promise.resolve({ data: { access_token: 'test', expires_in: 1800 } }))
  spyRecordAnomalies.mockImplementation((...args) => realRecordAnomalies(...args))
  spyResolveAnomalies.mockImplementation((...args) => realResolveAnomalies(...args))
  db.getRoutesBulk = vi.fn(() => ({}))
})

afterEach(() => {
  vi.restoreAllMocks()
  poller.stop()
})

afterAll(() => {
  poller.stop()
  db.close?.()
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
})


// ═════════════════════════════════════════════════════════════════════════════
// Full Loop: poller → event → SSE
// ═════════════════════════════════════════════════════════════════════════════

describe('full loop: poller → SSE stream', () => {
  it('delivers anomaly events over SSE when poller detects one', async () => {
    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')

    // Listen directly on the event emitter (same mechanism SSE uses)
    const events = []
    const onNew = (a) => events.push({ type: 'anomaly', data: a })
    const onCritical = (a) => events.push({ type: 'critical', data: a })
    poller.anomalyEvents.on('anomaly:new', onNew)
    poller.anomalyEvents.on('anomaly:critical', onCritical)

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 50))

    poller.anomalyEvents.off('anomaly:new', onNew)
    poller.anomalyEvents.off('anomaly:critical', onCritical)

    // Should have received at least the anomaly event
    expect(events.length).toBeGreaterThanOrEqual(1)
    const anomalyEvent = events.find(e => e.type === 'anomaly')
    expect(anomalyEvent).toBeDefined()
    expect(anomalyEvent.data.icao).toBe('abc123')
    expect(anomalyEvent.data.score).toBeGreaterThanOrEqual(80)

    // Should also get a critical event (squawk 7700)
    const criticalEvent = events.find(e => e.type === 'critical')
    expect(criticalEvent).toBeDefined()
    expect(criticalEvent.data.icao).toBe('abc123')
  })

  it('emits resolved events when anomaly clears', async () => {
    const resolved = []
    const onResolved = (icaos) => resolved.push(icaos)
    poller.anomalyEvents.on('anomaly:resolved', onResolved)

    // Create anomaly first
    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')
    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 50))

    // 3 normal cycles to resolve
    mockFlights([makeState('abc123', 'UAL123')])
    for (let i = 0; i < 3; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + (i + 1) * 90000)
      seedHistory('abc123')
      await _internals.pollCycle()
    }

    poller.anomalyEvents.off('anomaly:resolved', onResolved)

    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toEqual(['abc123'])
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// API endpoints serve poller data
// ═════════════════════════════════════════════════════════════════════════════

describe('poller API routes', () => {
  it('GET /api/flights returns empty when poller has no data', async () => {
    const res = await request(app).get('/api/flights')
    expect(res.status).toBe(200)
    expect(res.body.flights).toEqual([])
    expect(res.body.fetchedAt).toBeNull()
  })

  it('GET /api/flights returns flight data after poll cycle', async () => {
    mockFlights([makeState('abc123', 'UAL123'), makeState('def456', 'DAL456')])
    seedHistory('abc123')
    seedHistory('def456')

    await _internals.pollCycle()

    const res = await request(app).get('/api/flights')
    expect(res.status).toBe(200)
    expect(res.body.flights).toHaveLength(2)
    expect(res.body.flights[0].icao).toBe('abc123')
    expect(res.body.fetchedAt).toBeTypeOf('number')
    expect(res.body.region).toBe('usa')
  })

  it('GET /api/poller/status returns poller state', async () => {
    const res = await request(app).get('/api/poller/status')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('running', false)
    expect(res.body).toHaveProperty('trackedAircraft', 0)
    expect(res.body).toHaveProperty('activeAnomalies', 0)
  })

  it('POST /api/poller/start rejects without admin secret', async () => {
    const res = await request(app).post('/api/poller/start')
    expect(res.status).toBe(401)
  })

  it('POST /api/poller/start starts the poller', async () => {
    mockFlights([]) // empty so first poll does nothing
    const res = await request(app).post('/api/poller/start').set('x-admin-secret', 'test-secret')
    expect(res.status).toBe(200)
    expect(res.body.running).toBe(true)
  })

  it('POST /api/poller/stop stops the poller', async () => {
    mockFlights([])
    await request(app).post('/api/poller/start').set('x-admin-secret', 'test-secret')
    const res = await request(app).post('/api/poller/stop').set('x-admin-secret', 'test-secret')
    expect(res.status).toBe(200)
    expect(res.body.running).toBe(false)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Anomaly persistence via poller
// ═════════════════════════════════════════════════════════════════════════════

describe('poller persists anomalies to DB', () => {
  it('records anomalies to database after poll cycle', async () => {
    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 100))

    expect(spyRecordAnomalies).toHaveBeenCalled()
    const payload = spyRecordAnomalies.mock.calls[0][0]
    expect(payload).toHaveLength(1)
    expect(payload[0].icao).toBe('abc123')
    expect(payload[0].severity).toBe('CRITICAL')
  })

  it('anomalies are queryable via GET /api/anomalies/active', async () => {
    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 100))

    const res = await request(app).get('/api/anomalies/active')
    expect(res.status).toBe(200)
    // Should contain our anomaly (recorded to DB by poller)
    const found = res.body.find(a => a.icao === 'abc123')
    expect(found).toBeDefined()
    expect(found.score).toBeGreaterThanOrEqual(80)
  })

  it('resolved anomalies get marked via poller lifecycle', async () => {
    // First, create an anomaly
    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')
    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 100))

    // Now switch to normal data and run 3 cycles
    mockFlights([makeState('abc123', 'UAL123')])
    for (let i = 0; i < 3; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + (i + 1) * 90000)
      seedHistory('abc123') // re-seed so history check passes
      await _internals.pollCycle()
    }

    expect(spyResolveAnomalies).toHaveBeenCalledWith(['abc123'])
  })
})
