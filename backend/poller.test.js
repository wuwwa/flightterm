// ── Poller integration tests ──────────────────────────────────────────────────
// Uses vitest globals mode. Mocks axios and db to avoid real network/DB calls.

const fs = require('fs')
const os = require('os')
const path = require('path')
const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flightterm-poller-test-'))
process.env.DB_DIR = TEST_DB_DIR
process.env.ANOMALY_DETECTION_ENABLED = 'true'
process.env.ANOMALY_SCORE_DIVISOR = '1'
process.env.COMMUNITY_POINT_DELAY_MS = '0'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockRecordAnomalies = vi.fn(() => 0)
const mockResolveAnomalies = vi.fn(() => 0)
const mockGetRoutesBulk = vi.fn(() => ({}))
const mockGetFlightPlan = vi.fn(() => null)

// Patch axios directly — vi.mock doesn't intercept node_modules CJS requires
const axios = require('axios')
axios.get = mockGet
axios.post = mockPost

// Patch db exports BEFORE poller.js requires them
const db = require('./db')
const _origRecordAnomalies = db.recordAnomalies
const _origResolveAnomalies = db.resolveAnomalies
const _origGetRoutesBulk = db.getRoutesBulk
const _origGetFlightPlan = db.getFlightPlan
db.recordAnomalies = mockRecordAnomalies
db.resolveAnomalies = mockResolveAnomalies
db.getRoutesBulk = mockGetRoutesBulk
db.getFlightPlan = mockGetFlightPlan
db.getFlowEventsByAirport = vi.fn(() => [])
db.getTerminalWeatherByAirport = vi.fn(() => [])

const poller = require('./poller')
const { _internals } = poller
const {
  updateTrackHistory,
  buildEnrichment,
  summarizePireps,
  summarizeSigmets,
  trackHistory,
  activeAnomalies,
  anomalyMisses,
} = _internals

const NOW = 1711500000000

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  _internals.resetTestState()
  vi.clearAllMocks()
  // Re-apply default mock implementations after clearAllMocks
  mockGet.mockImplementation(() => Promise.resolve({ data: [] }))
  mockPost.mockImplementation(() => Promise.resolve({ data: { access_token: 'test', expires_in: 1800 } }))
  mockRecordAnomalies.mockImplementation(() => 0)
  mockResolveAnomalies.mockImplementation(() => 0)
  mockGetRoutesBulk.mockImplementation(() => ({}))
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
// Track History
// ═════════════════════════════════════════════════════════════════════════════

describe('updateTrackHistory', () => {
  it('creates snapshot entries for new aircraft', () => {
    updateTrackHistory([
      { icao: 'abc123', alt: 10000, vel: 230, hdg: 90, lat: 40.0, lon: -74.0, grounded: false, vertRate: 0, geoAlt: 10000, posSrc: 0, ndb: null },
    ])

    expect(trackHistory.has('abc123')).toBe(true)
    expect(trackHistory.get('abc123')).toHaveLength(1)
    expect(trackHistory.get('abc123')[0].ts).toBe(NOW)
    expect(trackHistory.get('abc123')[0].alt).toBe(10000)
  })

  it('appends to existing aircraft history', () => {
    const flight = { icao: 'abc123', alt: 10000, vel: 230, hdg: 90, lat: 40.0, lon: -74.0, grounded: false, vertRate: 0, geoAlt: 10000, posSrc: 0, ndb: null }
    updateTrackHistory([flight])
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 90000)
    updateTrackHistory([{ ...flight, alt: 10100 }])
    expect(trackHistory.get('abc123')).toHaveLength(2)
  })

  it('caps at MAX_SNAPSHOTS (30)', () => {
    const flight = { icao: 'abc123', alt: 10000, vel: 230, hdg: 90, lat: 40.0, lon: -74.0, grounded: false, vertRate: 0, geoAlt: 10000, posSrc: 0, ndb: null }
    for (let i = 0; i < 35; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + i * 90000)
      updateTrackHistory([{ ...flight, alt: 10000 + i }])
    }
    expect(trackHistory.get('abc123')).toHaveLength(30)
  })

  it('skips aircraft with null alt AND null vel', () => {
    updateTrackHistory([{ icao: 'skip1', alt: null, vel: null, hdg: 90 }])
    expect(trackHistory.has('skip1')).toBe(false)
  })

  it('keeps aircraft with null alt but valid vel', () => {
    updateTrackHistory([{ icao: 'keep1', alt: null, vel: 200, hdg: 90 }])
    expect(trackHistory.has('keep1')).toBe(true)
  })

  it('prunes stale aircraft (>10 min old)', () => {
    updateTrackHistory([
      { icao: 'old1', alt: 10000, vel: 230, hdg: 90, lat: 40, lon: -74, grounded: false, vertRate: 0, geoAlt: 10000, posSrc: 0, ndb: null },
    ])
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 11 * 60 * 1000)
    updateTrackHistory([
      { icao: 'new1', alt: 10000, vel: 230, hdg: 90, lat: 40, lon: -74, grounded: false, vertRate: 0, geoAlt: 10000, posSrc: 0, ndb: null },
    ])
    expect(trackHistory.has('old1')).toBe(false)
    expect(trackHistory.has('new1')).toBe(true)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Route Enrichment
// ═════════════════════════════════════════════════════════════════════════════

describe('buildEnrichment', () => {
  it('returns null when no enrichment available', () => {
    mockGetRoutesBulk.mockReturnValue({})
    expect(buildEnrichment({ icao: 'abc123', callsign: 'UAL123' })).toBeNull()
  })

  it('injects route from DB cache', () => {
    mockGetRoutesBulk.mockReturnValue({
      'UAL123': {
        destination_lat: 33.94, destination_lon: -118.41, destination_icao: 'KLAX',
        origin_lat: 40.64, origin_lon: -73.78, origin_icao: 'KJFK',
      },
    })
    const enrich = buildEnrichment({ icao: 'abc123', callsign: 'UAL123' })
    expect(enrich).not.toBeNull()
    expect(enrich.flightroute.destination.icao_code).toBe('KLAX')
    expect(enrich.flightroute.origin.icao_code).toBe('KJFK')
  })

  it('skips route lookup when no callsign', () => {
    expect(buildEnrichment({ icao: 'abc123', callsign: null })).toBeNull()
    expect(mockGetRoutesBulk).not.toHaveBeenCalled()
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Weather Summarization
// ═════════════════════════════════════════════════════════════════════════════

describe('summarizePireps', () => {
  it('returns empty summary for no pireps', () => {
    expect(summarizePireps([])).toEqual({ count: 0, maxTurbulence: null, maxIcing: null, severe: false })
  })

  it('detects severe turbulence', () => {
    const result = summarizePireps([
      { tbInt1: 'SEV', tbType1: 'CAT', fltLvl: '350' },
      { tbInt1: 'MOD', tbType1: 'CAT', fltLvl: '300' },
    ])
    expect(result.severe).toBe(true)
    expect(result.count).toBe(2)
    expect(result.maxTurbulence).toContain('SEV')
  })

  it('detects moderate (non-severe) conditions', () => {
    const result = summarizePireps([{ tbInt1: 'MOD', fltLvl: '250' }])
    expect(result.severe).toBe(false)
    expect(result.count).toBe(1)
  })
})

describe('summarizeSigmets', () => {
  it('returns empty summary for no sigmets', () => {
    expect(summarizeSigmets([])).toEqual({ count: 0, convective: 0, turbulence: 0, icing: 0 })
  })

  it('counts by hazard type', () => {
    const result = summarizeSigmets([
      { hazard: 'CONVECTIVE' }, { hazard: 'CONVECTIVE' }, { hazard: 'TURB' }, { hazard: 'ICE' },
    ])
    expect(result).toEqual({ count: 4, convective: 2, turbulence: 1, icing: 1 })
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Full Poll Cycle
// ═════════════════════════════════════════════════════════════════════════════

describe('pollCycle', () => {
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
      if (url.includes('opensky')) return Promise.resolve({ data: { states } })
      return Promise.resolve({ data: [] })
    })
  }

  it('detects anomalies from emergency squawk', async () => {
    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 50))

    expect(mockRecordAnomalies).toHaveBeenCalled()
    const anomalies = mockRecordAnomalies.mock.calls[0][0]
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0].icao).toBe('abc123')
    expect(anomalies[0].score).toBeGreaterThanOrEqual(80)
    expect(activeAnomalies.has('abc123')).toBe(true)
  })

  it('skips recording when all flights are normal', async () => {
    mockFlights([makeState('def456', 'DAL456')])
    seedHistory('def456')

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 50))

    expect(mockRecordAnomalies).not.toHaveBeenCalled()
  })

  it('resolves anomalies after 3 consecutive misses', async () => {
    activeAnomalies.set('abc123', { icao: 'abc123', score: 80 })
    mockFlights([makeState('abc123', 'UAL123')]) // normal data
    seedHistory('abc123')

    for (let i = 0; i < 3; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW + i * 90000)
      await _internals.pollCycle()
    }

    expect(mockResolveAnomalies).toHaveBeenCalledWith(['abc123'])
    expect(activeAnomalies.has('abc123')).toBe(false)
  })

  it('resets miss counter when anomaly reappears', async () => {
    activeAnomalies.set('abc123', { icao: 'abc123', score: 80 })
    anomalyMisses.set('abc123', 2)

    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 50))

    expect(anomalyMisses.has('abc123')).toBe(false)
    expect(mockResolveAnomalies).not.toHaveBeenCalled()
  })

  it('handles fetch failure gracefully', async () => {
    mockGet.mockRejectedValue(new Error('network timeout'))

    await _internals.pollCycle() // should not throw

    expect(mockRecordAnomalies).not.toHaveBeenCalled()
  })

  it('emits events for new anomalies', async () => {
    const emitted = []
    poller.anomalyEvents.on('anomaly:new', (a) => emitted.push(a))
    poller.anomalyEvents.on('anomaly:critical', (a) => emitted.push({ ...a, _critical: true }))

    mockFlights([makeState('abc123', 'UAL123', { squawk: '7700' })])
    seedHistory('abc123')

    await _internals.pollCycle()
    await new Promise(r => setTimeout(r, 50))

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted.some(e => e.icao === 'abc123')).toBe(true)
    expect(emitted.some(e => e._critical)).toBe(true)

    poller.anomalyEvents.removeAllListeners()
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

describe('poller lifecycle', () => {
  it('getStatus reports correct state when stopped', () => {
    const status = poller.getStatus()
    expect(status.running).toBe(false)
    expect(status.trackedAircraft).toBe(0)
    expect(status.activeAnomalies).toBe(0)
  })

  it('getStatus reflects tracked state', () => {
    trackHistory.set('a', [])
    trackHistory.set('b', [])
    activeAnomalies.set('a', { score: 50 })

    const status = poller.getStatus()
    expect(status.trackedAircraft).toBe(2)
    expect(status.activeAnomalies).toBe(1)
  })
})
