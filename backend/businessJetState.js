const FRESH_MS = 5 * 60_000
const COMPARISON_GAP_MS = 45 * 60_000

function freshness(sampledAt, now = Date.now()) {
  const at = sampledAt == null ? NaN : new Date(sampledAt).getTime()
  const ageMs = now - at
  return { state: !Number.isFinite(at) ? 'warming' : ageMs < -60_000 || ageMs > FRESH_MS ? 'saved' : 'live', ageMs: Number.isFinite(at) ? Math.max(0, ageMs) : null }
}

function compareSamples(current, previous) {
  if (!current || !previous) return null
  const gap = new Date(current.sampledAt) - new Date(previous.sampledAt)
  if (gap <= 0 || gap > COMPARISON_GAP_MS || current.source !== previous.source || current.cohortVersion !== previous.cohortVersion) return null
  const prior = new Set(previous.positions.map(p => p.icao))
  const present = new Set(current.positions.map(p => p.icao))
  return {
    previousSampledAt: previous.sampledAt,
    records: [
      ...current.positions.map(p => ({ ...p, change: prior.has(p.icao) ? 'continued' : 'newly_observed' })),
      ...previous.positions.filter(p => !present.has(p.icao)).map(p => ({ ...p, change: 'not_observed' })),
    ],
  }
}

module.exports = { freshness, compareSamples, FRESH_MS }
