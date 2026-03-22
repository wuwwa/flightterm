// ── Flight anomaly scoring engine ───────────────────────────────────────────
// Pure function — uses only OpenSky/ADSBX data (alt, vel, hdg, grounded).
// No AeroAPI calls.

// ── Phase detection ─────────────────────────────────────────────────────────
// Infer flight phase from the last N snapshots

export const PHASE = {
  GROUND:   'ground',
  CLIMB:    'climb',
  CRUISE:   'cruise',
  DESCENT:  'descent',
  APPROACH: 'approach',
  UNKNOWN:  'unknown',
}

export function detectPhase(snapshots) {
  if (!snapshots || snapshots.length < 2) return PHASE.UNKNOWN

  const recent = snapshots.slice(-5)
  const last = recent[recent.length - 1]

  if (last.grounded) return PHASE.GROUND

  // compute altitude trend over recent snapshots
  const alts = recent.filter(s => s.alt != null).map(s => s.alt)
  if (alts.length < 2) return PHASE.UNKNOWN

  const altDeltas = []
  for (let i = 1; i < alts.length; i++) altDeltas.push(alts[i] - alts[i - 1])
  const avgAltDelta = altDeltas.reduce((a, b) => a + b, 0) / altDeltas.length

  const currentAlt = last.alt ?? 0
  const currentVel = last.vel ?? 0

  // low altitude + decelerating + descending = approach
  if (currentAlt < 3000 && avgAltDelta < -20 && currentVel < 120) return PHASE.APPROACH
  // low altitude + accelerating + climbing = climb-out
  if (currentAlt < 3000 && avgAltDelta > 20) return PHASE.CLIMB

  // consistent descent
  if (avgAltDelta < -30) return PHASE.DESCENT
  // consistent climb
  if (avgAltDelta > 30) return PHASE.CLIMB
  // stable altitude at speed = cruise
  if (Math.abs(avgAltDelta) < 50 && currentVel > 80) return PHASE.CRUISE

  return PHASE.UNKNOWN
}

// ── Major US airports (top 50) for proximity suppression ────────────────────
const AIRPORTS = [
  { icao: 'KATL', lat: 33.637, lon: -84.428 },
  { icao: 'KLAX', lat: 33.943, lon: -118.408 },
  { icao: 'KDFW', lat: 32.897, lon: -97.038 },
  { icao: 'KDEN', lat: 39.852, lon: -104.673 },
  { icao: 'KORD', lat: 41.974, lon: -87.907 },
  { icao: 'KJFK', lat: 40.641, lon: -73.778 },
  { icao: 'KMCO', lat: 28.429, lon: -81.309 },
  { icao: 'KLAS', lat: 36.084, lon: -115.152 },
  { icao: 'KCLT', lat: 35.214, lon: -80.943 },
  { icao: 'KMIA', lat: 25.796, lon: -80.287 },
  { icao: 'KSEA', lat: 47.449, lon: -122.309 },
  { icao: 'KEWR', lat: 40.693, lon: -74.169 },
  { icao: 'KSFO', lat: 37.619, lon: -122.379 },
  { icao: 'KPHX', lat: 33.434, lon: -112.012 },
  { icao: 'KIAH', lat: 29.984, lon: -95.341 },
  { icao: 'KBOS', lat: 42.366, lon: -71.010 },
  { icao: 'KFLL', lat: 26.073, lon: -80.153 },
  { icao: 'KMSP', lat: 44.882, lon: -93.222 },
  { icao: 'KLGA', lat: 40.777, lon: -73.873 },
  { icao: 'KDTW', lat: 42.212, lon: -83.353 },
  { icao: 'KBWI', lat: 39.176, lon: -76.669 },
  { icao: 'KDCA', lat: 38.852, lon: -77.038 },
  { icao: 'KIAD', lat: 38.945, lon: -77.456 },
  { icao: 'KPHL', lat: 39.872, lon: -75.241 },
  { icao: 'KSLC', lat: 40.788, lon: -111.978 },
  { icao: 'KSAN', lat: 32.734, lon: -117.190 },
  { icao: 'KBNA', lat: 36.124, lon: -86.678 },
  { icao: 'KAUS', lat: 30.195, lon: -97.670 },
  { icao: 'KRDU', lat: 35.880, lon: -78.788 },
  { icao: 'KTPA', lat: 27.975, lon: -82.533 },
  { icao: 'KSTL', lat: 38.748, lon: -90.370 },
  { icao: 'KPIT', lat: 40.492, lon: -80.233 },
  { icao: 'KPDX', lat: 45.589, lon: -122.597 },
  { icao: 'KMSY', lat: 29.993, lon: -90.258 },
  { icao: 'KMCI', lat: 39.298, lon: -94.714 },
  { icao: 'KCLE', lat: 41.412, lon: -81.850 },
  { icao: 'KSAT', lat: 29.534, lon: -98.470 },
  { icao: 'KIND', lat: 39.717, lon: -86.294 },
  { icao: 'KSDF', lat: 38.174, lon: -85.736 },
  { icao: 'KCVG', lat: 39.049, lon: -84.668 },
  { icao: 'KOAK', lat: 37.721, lon: -122.221 },
  { icao: 'KSJC', lat: 37.362, lon: -121.929 },
  { icao: 'KSMF', lat: 38.695, lon: -121.591 },
  { icao: 'KHNL', lat: 21.319, lon: -157.922 },
  { icao: 'KHOU', lat: 29.645, lon: -95.279 },
  { icao: 'KMDW', lat: 41.786, lon: -87.752 },
  { icao: 'KDAL', lat: 32.847, lon: -96.852 },
  { icao: 'KRSW', lat: 26.536, lon: -81.755 },
  { icao: 'KPBI', lat: 26.683, lon: -80.096 },
  { icao: 'KABQ', lat: 35.040, lon: -106.609 },
]

const AIRPORT_PROXIMITY_KM = 50 // suppress descent anomalies within this radius

function distKm(lat1, lon1, lat2, lon2) {
  // fast approximation — good enough for 50km checks
  const dLat = (lat2 - lat1) * 111.32
  const dLon = (lon2 - lon1) * 111.32 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

function nearAirport(lat, lon) {
  if (lat == null || lon == null) return false
  for (const ap of AIRPORTS) {
    if (distKm(lat, lon, ap.lat, ap.lon) < AIRPORT_PROXIMITY_KM) return true
  }
  return false
}

// ── Scoring ─────────────────────────────────────────────────────────────────

// Normal rates by phase (m/s vertical, m/s² horizontal)
const PHASE_NORMS = {
  [PHASE.CLIMB]:    { altRate: [5, 20],  velChange: 15 },   // 5-20 m/s climb
  [PHASE.CRUISE]:   { altRate: [-2, 2],  velChange: 5 },    // nearly flat
  [PHASE.DESCENT]:  { altRate: [-20, -3], velChange: 15 },  // 3-20 m/s descent
  [PHASE.APPROACH]: { altRate: [-15, -1], velChange: 20 },  // slower descent, speed varies
  [PHASE.GROUND]:   { altRate: [0, 0],   velChange: 5 },
  [PHASE.UNKNOWN]:  { altRate: [-15, 15], velChange: 20 },  // wide tolerance
}

/**
 * Score a single aircraft's anomaly level.
 *
 * @param {Array} snapshots - last N snapshots [{ ts, alt, vel, hdg, grounded }]
 * @param {Object} current  - current flight object { alt, vel, hdg, lat, lon, grounded, squawk }
 * @returns {{ score: number, phase: string, reasons: string[], confirmed: boolean }}
 *   score 0-100, reasons array, confirmed = true if anomaly persists 2+ fetches
 */
export function scoreAnomaly(snapshots, current) {
  const result = { score: 0, phase: PHASE.UNKNOWN, reasons: [], confirmed: false }

  if (!snapshots || snapshots.length < 2 || !current) return result

  const phase = detectPhase(snapshots)
  result.phase = phase

  const prev = snapshots[snapshots.length - 1]
  const prevPrev = snapshots.length >= 3 ? snapshots[snapshots.length - 2] : null

  // ── 1. Rate-normalized altitude change ────────────────────────────────
  if (prev.alt != null && current.alt != null && prev.ts) {
    const dtSec = Math.max(1, (Date.now() - prev.ts) / 1000)
    const altRate = (current.alt - prev.alt) / dtSec  // m/s

    const norms = PHASE_NORMS[phase] || PHASE_NORMS[PHASE.UNKNOWN]
    const [normLow, normHigh] = norms.altRate

    // how far outside the expected range?
    let altDeviation = 0
    if (altRate < normLow) altDeviation = Math.abs(altRate - normLow)
    else if (altRate > normHigh) altDeviation = Math.abs(altRate - normHigh)

    if (altDeviation > 0) {
      // scale: 5 m/s deviation from norm = ~30 points, 15 m/s = ~60, 30+ = ~80
      const altScore = Math.min(80, altDeviation * 4)
      result.score += altScore

      if (altRate < normLow) {
        result.reasons.push(`descent ${altRate.toFixed(1)} m/s (expected ${normLow} to ${normHigh} in ${phase})`)
      } else {
        result.reasons.push(`climb ${altRate.toFixed(1)} m/s (expected ${normLow} to ${normHigh} in ${phase})`)
      }
    }
  }

  // ── 2. Speed anomaly ──────────────────────────────────────────────────
  if (prev.vel != null && current.vel != null && prev.ts) {
    const dtSec = Math.max(1, (Date.now() - prev.ts) / 1000)
    const velRate = Math.abs(current.vel - prev.vel) / dtSec  // m/s per second

    const norms = PHASE_NORMS[phase] || PHASE_NORMS[PHASE.UNKNOWN]
    const velDeviation = Math.max(0, velRate * dtSec - norms.velChange)

    if (velDeviation > 10) {
      const velScore = Math.min(40, velDeviation * 1.5)
      result.score += velScore
      result.reasons.push(`speed change ${(current.vel - prev.vel).toFixed(1)} m/s in ${dtSec.toFixed(0)}s`)
    }
  }

  // ── 3. Heading discontinuity (only meaningful in cruise) ──────────────
  if (phase === PHASE.CRUISE && prev.hdg != null && current.hdg != null) {
    let hdgDelta = Math.abs(current.hdg - prev.hdg)
    if (hdgDelta > 180) hdgDelta = 360 - hdgDelta

    if (hdgDelta > 45) {
      const hdgScore = Math.min(25, (hdgDelta - 45) * 0.5)
      result.score += hdgScore
      result.reasons.push(`heading change ${hdgDelta}° during cruise`)
    }
  }

  // ── 4. Phase transition anomaly ───────────────────────────────────────
  if (snapshots.length >= 5) {
    const olderPhase = detectPhase(snapshots.slice(0, -1))
    // unexpected transitions: cruise→rapid descent is noteworthy
    if (olderPhase === PHASE.CRUISE && phase === PHASE.DESCENT) {
      // only flag if the descent rate is steep
      if (result.score > 10) {
        result.score += 15
        result.reasons.push(`phase transition: cruise → descent`)
      }
    }
  }

  // ── 5. Squawk multiplier ──────────────────────────────────────────────
  if (current.squawk === '7700') {
    result.score = Math.max(result.score, 80)
    result.score = Math.min(100, result.score * 1.5)
    result.reasons.unshift('SQUAWK 7700 — EMERGENCY')
  } else if (current.squawk === '7600') {
    result.score += 20
    result.reasons.unshift('SQUAWK 7600 — RADIO FAILURE')
  } else if (current.squawk === '7500') {
    result.score = 100
    result.reasons.unshift('SQUAWK 7500 — HIJACK')
  }

  // ── 6. Airport proximity dampener ─────────────────────────────────────
  if (nearAirport(current.lat, current.lon)) {
    // if the anomaly is purely descent-based during approach, heavily dampen
    const isDescentOnly = result.reasons.every(r => r.includes('descent') || r.includes('phase transition'))
    if (isDescentOnly && phase !== PHASE.CRUISE) {
      result.score = Math.round(result.score * 0.25)
      result.reasons.push('(near airport — dampened)')
    } else {
      // partial dampening for other anomalies near airports
      result.score = Math.round(result.score * 0.6)
      result.reasons.push('(near airport)')
    }
  }

  // ── 7. Multi-fetch confirmation ───────────────────────────────────────
  // Check if the previous delta also showed the same direction of anomaly
  if (prevPrev && prev.alt != null && prevPrev.alt != null && current.alt != null) {
    const prevDelta = prev.alt - prevPrev.alt
    const currDelta = current.alt - prev.alt
    // both descending steeply = confirmed
    if (prevDelta < -300 && currDelta < -300) {
      result.confirmed = true
      result.score = Math.min(100, Math.round(result.score * 1.3))
      result.reasons.push('confirmed (2 consecutive fetches)')
    }
    // previous was anomalous but current recovered = likely noise
    if (Math.abs(prevDelta) > 500 && Math.abs(currDelta) < 100) {
      result.score = Math.round(result.score * 0.3)
      result.reasons.push('(recovered — likely data noise)')
    }
  }

  // clamp
  result.score = Math.round(Math.min(100, Math.max(0, result.score)))

  return result
}

// ── Threshold ───────────────────────────────────────────────────────────────
export const ANOMALY_THRESHOLD = 35
