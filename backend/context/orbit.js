// ── Orbit / holding / loiter detection ──────────────────────────────────────
// v2.0.0 — Given a short history of (lat, lon, heading, time) samples, decide
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

  // Only the most-recent window.
  const now = track[track.length - 1].seen_at ? new Date(track[track.length - 1].seen_at).getTime() : Date.now()
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
    if (a.heading != null && b.heading != null) {
      totalAbsTurn += Math.abs(hdgDelta(a.heading, b.heading))
    }
    if (a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null) {
      pathKm += haversineKm(a.latitude, a.longitude, b.latitude, b.longitude)
    }
  }

  const first = windowed[0]
  const last = windowed[windowed.length - 1]
  const driftKm = haversineKm(first.latitude, first.longitude, last.latitude, last.longitude)
  const compactness = pathKm > 0 ? driftKm / pathKm : 1
  const circling = totalAbsTurn >= 360 && compactness < 0.35

  // Infer a center from sample mean (good enough for cheap flags on the map).
  const centerLat = windowed.reduce((s, p) => s + p.latitude, 0) / windowed.length
  const centerLon = windowed.reduce((s, p) => s + p.longitude, 0) / windowed.length

  return {
    circling,
    totalTurnDeg: Math.round(totalAbsTurn),
    pathKm: +pathKm.toFixed(2),
    driftKm: +driftKm.toFixed(2),
    compactness: +compactness.toFixed(2),
    samples: windowed.length,
    center: { lat: +centerLat.toFixed(4), lon: +centerLon.toFixed(4) },
    reason: circling ? 'cumulative turn ≥ 360° with compact drift' : 'transit profile',
  }
}

module.exports = { detectOrbit }
