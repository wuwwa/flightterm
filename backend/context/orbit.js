// ── Orbit / holding / loiter detection ──────────────────────────────────────
// v2.0.0 — Given a short history of (lat, lon, hdg, time) samples, decide
// whether the aircraft is effectively circling (holding pattern, SAR racetrack,
// ISR loiter, firefighting orbit) as opposed to transiting.
//
// Two independent tests, both must pass:
//   1. Cumulative heading change ≥ 360° over the window
//   2. Positional drift small relative to path length (ratio < 0.35)
//
// A holding pattern that's drifting (e.g. a helicopter slowly walking the
// orbit across a scene) still qualifies because the second test is a ratio,
// not an absolute.
//
// v5.1.1 bug_004 — input rows come from `getAircraftTrack()` which selects
// columns `lat, lon, hdg, ...` from the sightings DB. Earlier revs of this
// file read `latitude/longitude/heading` and got `undefined` for every sample,
// so circling was never detected on the /api/context/aircraft/:icao path.

const { haversineKm } = require('./geo')

// Normalize a heading delta to [-180, 180].
function hdgDelta(a, b) {
  let d = b - a
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

function detectOrbit(track, opts = {}) {
  const minSamples = opts.minSamples ?? 6
  const maxAgeMs = opts.maxAgeMs ?? 15 * 60_000
  if (!Array.isArray(track) || track.length < minSamples) {
    return { circling: false, reason: 'insufficient samples' }
  }

  // Accept either DB-shape rows (lat/lon/hdg) or rich-shape rows
  // (latitude/longitude/heading). Callers have mixed both historically.
  const coordOf = (p) => [p.lat ?? p.latitude, p.lon ?? p.longitude]
  const hdgOf   = (p) => p.hdg ?? p.heading

  // Only the most-recent window.
  const last = track[track.length - 1]
  const now = last.seen_at ? new Date(last.seen_at).getTime() : Date.now()
  const windowed = track.filter(p => {
    if (!p.seen_at) return true
    return now - new Date(p.seen_at).getTime() <= maxAgeMs
  })
  if (windowed.length < minSamples) {
    return { circling: false, reason: 'insufficient recent samples' }
  }

  let totalAbsTurn = 0
  let pathKm = 0
  for (let i = 1; i < windowed.length; i++) {
    const a = windowed[i - 1]
    const b = windowed[i]
    const ha = hdgOf(a), hb = hdgOf(b)
    if (ha != null && hb != null) {
      totalAbsTurn += Math.abs(hdgDelta(ha, hb))
    }
    const [alat, alon] = coordOf(a)
    const [blat, blon] = coordOf(b)
    if (alat != null && alon != null && blat != null && blon != null) {
      pathKm += haversineKm(alat, alon, blat, blon)
    }
  }

  const first = windowed[0]
  const lastW = windowed[windowed.length - 1]
  const [flat, flon] = coordOf(first)
  const [llat, llon] = coordOf(lastW)
  const driftKm = (flat != null && llat != null)
    ? haversineKm(flat, flon, llat, llon)
    : 0
  const compactness = pathKm > 0 ? driftKm / pathKm : 1
  const circling = totalAbsTurn >= 360 && compactness < 0.35

  // Infer a center from sample mean (good enough for cheap flags on the map).
  const coords = windowed.map(coordOf).filter(([lt, ln]) => lt != null && ln != null)
  const centerLat = coords.length ? coords.reduce((s, c) => s + c[0], 0) / coords.length : null
  const centerLon = coords.length ? coords.reduce((s, c) => s + c[1], 0) / coords.length : null

  return {
    circling,
    totalTurnDeg: Math.round(totalAbsTurn),
    pathKm: +pathKm.toFixed(2),
    driftKm: +driftKm.toFixed(2),
    compactness: +compactness.toFixed(2),
    samples: windowed.length,
    center: centerLat != null
      ? { lat: +centerLat.toFixed(4), lon: +centerLon.toFixed(4) }
      : null,
    reason: circling ? 'cumulative turn ≥ 360° with compact drift' : 'transit profile',
  }
}

module.exports = { detectOrbit }
