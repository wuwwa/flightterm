// ── Flight interest-score engine (v5.2.0) ──────────────────────────────────
// Converts a flight + optional track + optional active-anomaly record into a
// single integer score and a primary human-readable "why" line.
//
// The score is a blend of:
//   - Squawk emergency codes (dispositive)
//   - Callsign prefix priors (medevac, SAR, LE, CBP, mil, VIP)
//   - Backend-computed anomaly severity (CRITICAL/HIGH/MEDIUM)
//   - Orbit / circling (when track history is passed in)
//   - Route deviation vs filed TFMS route
//   - Military flag
//
// Design notes:
//   - Signals are *additive*, not multiplicative, so missing inputs degrade
//     gracefully (orbit data is only available for a small subset of flights).
//   - The `primary` field is what the UI row should display — the single
//     strongest reason this flight ranks. We assign it to the first match
//     in priority order, then let lower-ranked signals add to the numeric
//     score without overwriting the banner.
//   - Callsign + squawk are trivially gameable; their weight is bounded so a
//     genuine anomaly + kinematic confirmation can still outrank them.

const { classifyCallsign, classifySquawk } = require('../context/callsign')
const { detectOrbit } = require('../context/orbit')

// ── Weights ─────────────────────────────────────────────────────────────────

const W = {
  SQUAWK_EMERGENCY:  100,
  ANOMALY_CRITICAL:   80,
  ANOMALY_HIGH:       40,
  ANOMALY_MEDIUM:     15,
  ORBIT:              35,
  ROUTE_DEV_MAJOR:    25,  // > 100 km
  ROUTE_DEV_MINOR:    10,  // > 50 km
  MILITARY:           15,
}

// Callsign weight = tag confidence × CALLSIGN_BASE.
// Cap so a spoofed callsign can't dominate on its own.
const CALLSIGN_BASE = 45

function scoreFlight({ flight, track = null, anomaly = null } = {}) {
  const tags = []
  let primary = null
  let score = 0

  const setPrimary = (line) => { if (!primary) primary = line }

  // ── 1. Emergency squawk (dispositive) ──────────────────────────────────
  const squawkTag = classifySquawk(flight.squawk)
  if (squawkTag) {
    score += W.SQUAWK_EMERGENCY
    tags.push({ label: squawkTag.tag, weight: W.SQUAWK_EMERGENCY, source: 'squawk' })
    setPrimary(`squawk ${flight.squawk} — ${squawkTag.tag.replace(/_/g, ' ')}`)
  }

  // ── 2. Callsign priors ─────────────────────────────────────────────────
  const csTags = classifyCallsign(flight.callsign)
  for (const t of csTags) {
    const w = Math.round(t.confidence * CALLSIGN_BASE)
    score += w
    tags.push({ label: t.tag, weight: w, source: 'callsign' })
  }
  if (csTags[0]) {
    setPrimary(csTags[0].tag.replace(/_/g, ' '))
  }

  // ── 3. Active anomaly ──────────────────────────────────────────────────
  if (anomaly) {
    const sev = anomaly.severity
    const w = sev === 'CRITICAL' ? W.ANOMALY_CRITICAL
            : sev === 'HIGH'     ? W.ANOMALY_HIGH
            : sev === 'MEDIUM'   ? W.ANOMALY_MEDIUM
            : 0
    if (w > 0) {
      score += w
      const cat = (anomaly.category || 'anomaly').toLowerCase()
      tags.push({ label: `${sev.toLowerCase()}:${cat}`, weight: w, source: 'anomaly' })
      if (w >= W.ANOMALY_HIGH) setPrimary(`${cat} anomaly (${sev.toLowerCase()})`)
    }
  }

  // ── 4. Orbit / circling ────────────────────────────────────────────────
  // Requires track history; caller only fetches for pre-filtered candidates.
  if (track && track.length >= 6) {
    const o = detectOrbit(track)
    if (o.circling) {
      score += W.ORBIT
      tags.push({ label: 'circling', weight: W.ORBIT, source: 'orbit' })
      setPrimary(`circling — ${o.totalTurnDeg}° cumulative turn`)
    }
  }

  // ── 5. Route deviation (from TFMS enrichment) ──────────────────────────
  const dev = flight.routeDeviation || 0
  if (dev > 100) {
    score += W.ROUTE_DEV_MAJOR
    tags.push({ label: `${dev}km off-route`, weight: W.ROUTE_DEV_MAJOR, source: 'route' })
    setPrimary(`${dev} km off filed route`)
  } else if (dev > 50) {
    score += W.ROUTE_DEV_MINOR
    tags.push({ label: `${dev}km off-route`, weight: W.ROUTE_DEV_MINOR, source: 'route' })
  }

  // ── 6. Military ────────────────────────────────────────────────────────
  if (flight.mil) {
    score += W.MILITARY
    tags.push({ label: 'military', weight: W.MILITARY, source: 'mil' })
    setPrimary('military traffic')
  }

  tags.sort((a, b) => b.weight - a.weight)
  return { score, primary, tags }
}

// Cheap pre-filter: returns true if a flight might earn a non-zero score
// without touching the sightings DB. Used to gate the expensive track-fetch
// pass in interesting-feed generation.
function isCandidate(flight) {
  if (!flight) return false
  if (classifySquawk(flight.squawk)) return true
  if (classifyCallsign(flight.callsign).length > 0) return true
  if ((flight.routeDeviation || 0) > 50) return true
  if (flight.mil) return true
  // Potential orbit: slow + low + airborne. We won't *know* until we run
  // orbit detection, but that needs the DB; this gate keeps the candidate
  // pool to a tractable size.
  if (flight.grounded) return false
  const velKt = flight.vel != null ? flight.vel * 1.944 : null
  const altFt = flight.alt != null ? flight.alt * 3.281 : null
  if (velKt != null && velKt < 200 && altFt != null && altFt < 15000) return true
  return false
}

module.exports = { scoreFlight, isCandidate, W }
