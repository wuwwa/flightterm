const fs = require('fs')
const os = require('os')
const path = require('path')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightterm-private-test-'))
process.env.DB_DIR = tempDir
process.env.BUSINESS_JET_HEATMAP_URL = ''
process.env.ADSB_HEATMAP_URL = ''
const db = require('./db')
const poller = require('./poller')
let tracker
let bundle
let saved
let persist

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-10T12:01:00Z'))
  bundle = { flights: [], fetchedAt: null, region: 'usa', feedSource: 'opensky' }
  saved = null
  vi.spyOn(poller, 'getFlights').mockImplementation(() => bundle)
  vi.spyOn(db, 'getFaaAircraftRefCount').mockReturnValue(1)
  vi.spyOn(db, 'getFaaRegistryCount').mockReturnValue(1)
  vi.spyOn(db, 'ensureBusinessJetCohortCurrent').mockReturnValue({ health: { count: 1 } })
  vi.spyOn(db, 'getBusinessJetCohort').mockReturnValue([{ icao24_hex: 'abcdef', n_number: '123', aircraft_model: 'G650' }])
  vi.spyOn(db, 'getBusinessJetLatest').mockImplementation(() => ({ snapshot: saved, positions: [], history: [], cohortSize: 1 }))
  vi.spyOn(db, 'getBusinessJetCohortAudit').mockReturnValue({})
  persist = vi.spyOn(db, 'recordBusinessJetSnapshot').mockImplementation(args => {
    saved = { id: 1, sampled_at: args.sampledAt.toISOString(), cohort_version: db.BUSINESS_JET_COHORT_VERSION, source: args.source, airborne_count: args.positions.length, matched_count: args.positions.length }
    return { sampled_at: saved.sampled_at, snapshotId: 1 }
  })
  delete require.cache[require.resolve('./businessJetTracker')]
  tracker = require('./businessJetTracker')
})
afterEach(() => { tracker.stop(); vi.restoreAllMocks(); vi.useRealTimers() })
afterAll(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }) })

const flight = { icao: 'abcdef', lat: 35, lon: -100, alt: 10000, vel: 200, grounded: false }
describe('private sampling on wake', () => {
  it('retries an empty startup feed and captures the first ready feed without waiting for a half-hour boundary', async () => {
    tracker.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(persist).not.toHaveBeenCalled()
    bundle = { ...bundle, fetchedAt: Date.now(), flights: [flight] }
    await vi.advanceTimersByTimeAsync(15000)
    const state = tracker.getTrackerState()
    expect(state.snapshot.airborneCount).toBe(1)
    expect(state.freshness.state).toBe('live')
    expect(persist).toHaveBeenCalledTimes(1)
    bundle = { ...bundle, fetchedAt: Date.now(), flights: [{ ...flight, lat: 36 }] }
    await vi.advanceTimersByTimeAsync(15000)
    expect(tracker.getTrackerState().positions[0].lat).toBe(36)
    expect(persist).toHaveBeenCalledTimes(1)
  })
  it('deduplicates concurrent refreshes', async () => {
    bundle = { ...bundle, fetchedAt: Date.now(), flights: [flight] }
    await Promise.all([tracker.sampleOnce({ live: true }), tracker.sampleOnce({ live: true })])
    expect(persist).toHaveBeenCalledTimes(1)
  })
  it('rejects old source data instead of labeling it live', async () => {
    bundle = { ...bundle, fetchedAt: Date.now() - 3600000, flights: [flight] }
    await expect(tracker.sampleOnce({ live: true })).rejects.toThrow('fresh shared flight feed')
    expect(persist).not.toHaveBeenCalled()
  })
  it('does not turn missing coordinates into a position at zero degrees', () => {
    const normalized = tracker._internals.normalizeAircraft({ icao: 'abcdef', lat: null, lon: null })
    expect(normalized.lat).toBeNull()
    expect(normalized.airborne).toBe(false)
  })
  it('reuses reference calculations for repeated reads of an unchanged snapshot', async () => {
    bundle = { ...bundle, fetchedAt: Date.now(), flights: [flight] }
    await tracker.sampleOnce({ live: true })
    const baseline = vi.spyOn(db, 'getBusinessJetBaseline')
    tracker.getTrackerState()
    tracker.getTrackerState()
    expect(baseline).toHaveBeenCalledTimes(1)
  })
  it('filters reference samples by source, date and distinct observed days', () => {
    const rows = [
      { sampled_at: '2026-09-03T11:00:00.000Z', airborne_count: 10, source: 'a' },
      { sampled_at: '2026-09-03T11:30:00.000Z', airborne_count: 20, source: 'a' },
      { sampled_at: '2026-09-03T11:45:00.000Z', airborne_count: 100, source: 'b' },
      { sampled_at: '2026-09-10T12:30:00.000Z', airborne_count: 1000, source: 'a' },
    ]
    const baseline = db.getBusinessJetBaseline({ sampledAt: new Date(), source: 'a', rows })
    expect(baseline.samples).toBe(2)
    expect(baseline.distinctDays).toBe(1)
    expect(baseline.mean).toBe(15)
  })
})
