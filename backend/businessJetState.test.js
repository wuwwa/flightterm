const { freshness, compareSamples } = require('./businessJetState')
const { createIdleLease } = require('./idleLease')

describe('intermittent private observations', () => {
  const now = Date.parse('2026-09-10T12:00:00Z')
  it('distinguishes absent, fresh, saved and future timestamps', () => {
    expect(freshness(null, now).state).toBe('warming')
    expect(freshness('2026-09-10T11:59:00Z', now).state).toBe('live')
    expect(freshness('2026-08-23T00:29:00Z', now).state).toBe('saved')
    expect(freshness('2026-09-11T00:00:00Z', now).state).toBe('saved')
  })
  const previous = { sampledAt: '2026-09-10T11:30:00Z', source: 'poller:opensky:usa', cohortVersion: 'v1', positions: [{ icao: 'aaaaaa' }, { icao: 'bbbbbb' }] }
  const current = { ...previous, sampledAt: '2026-09-10T12:00:00Z', positions: [{ icao: 'bbbbbb' }, { icao: 'cccccc' }] }
  it('compares adjacent samples without claiming takeoffs or landings', () => {
    expect(compareSamples(current, previous).records.map(p => p.change)).toEqual(['continued', 'newly_observed', 'not_observed'])
  })
  it('rejects sleep gaps, duplicate timestamps, changed feeds and cohorts', () => {
    expect(compareSamples({ ...current, sampledAt: '2026-09-11T12:00:00Z' }, previous)).toBeNull()
    expect(compareSamples(previous, previous)).toBeNull()
    expect(compareSamples({ ...current, source: 'poller:community:usa' }, previous)).toBeNull()
    expect(compareSamples({ ...current, cohortVersion: 'v2' }, previous)).toBeNull()
  })
  it('keeps a worker active only while its consumer renews the lease', () => {
    let time = 0
    const lease = createIdleLease({ timeoutMs: 90000, now: () => time })
    time = 80000
    expect(lease.expired()).toBe(false)
    lease.touch()
    time = 160000
    expect(lease.expired()).toBe(false)
    time = 170000
    expect(lease.expired()).toBe(true)
  })
})
