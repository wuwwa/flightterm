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
const { classifyAircraft } = require('../context/aircraft')
const { detectOrbit } = require('../context/orbit')

// ── Weights ─────────────────────────────────────────────────────────────────

const W = {
  SQUAWK_EMERGENCY:  100,
  ANOMALY_CRITICAL:   80,
  ANOMALY_HIGH:       40,
  ANOMALY_MEDIUM:     15,
  ORBIT:              35,
  ROUTE_DEV_SIG:      20,  // 200–500 km (significant)
  ROUTE_DEV_MOD:      10,  // 100–200 km (moderate)
  ROUTE_DEV_MINOR:     5,  //  50–100 km (worth noting, not ranking)
  MILITARY:           20,  // v5.2.1: raised from 15 — base rate is ~5% after APL wiring
}

// v5.2.1 — Empirical cap. On a 4,316-flight sample the route-deviation
// distribution had p99 = 526 km and max = 3,515 km. Anything over 500 km
// is almost certainly a filed-route-vs-actual mismatch (e.g. a flight that
// departed from a different airport than the filed plan). Treat those as
// data errors rather than signal — they clog the feed with flights that
// aren't actually doing anything unusual.
const ROUTE_DEV_MAX_CREDIBLE_KM = 500

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

  // ── 2. Aircraft classifier (callsign + type + operator + curated hex) ───
  // v5.7.7 — replaces the bare callsign classifier with the multi-signal
  // classifyAircraft(), which dedups across all four sources and returns
  // refined helicopter-use tags (helicopter_news, helicopter_ems, etc.).
  // The category (wide_body / narrow_body / business_jet / etc.) feeds the
  // size/use chip in the dossier and feed UI.
  const acClass = classifyAircraft({
    icao:     flight.icao,
    acType:   flight.acType,
    operator: flight.acOperator,
    callsign: flight.callsign,
  })
  for (const t of acClass.tags) {
    const w = Math.round(t.confidence * CALLSIGN_BASE)
    score += w
    tags.push({ label: t.tag, weight: w, source: t.source })
  }
  if (acClass.tags[0]) {
    setPrimary(acClass.tags[0].tag.replace(/_/g, ' '))
  }
  if (acClass.category) {
    // Category is informational, doesn't add score — but surface it so the
    // UI can render a category chip ("wide_body", "business_jet", etc.).
    tags.push({ label: acClass.category, weight: 0, source: 'category' })
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
  // Tiered bucketing after the p99 cap. Route deviation correlates weakly
  // with "interesting" — the signal is dominated by filed-vs-actual data
  // errors at the extremes, so we suppress those entirely rather than
  // letting a 3,500-km "deviation" crowd the top of the feed.
  const rawDev = flight.routeDeviation || 0
  if (rawDev > 0 && rawDev <= ROUTE_DEV_MAX_CREDIBLE_KM) {
    let w = 0, label
    if (rawDev > 200)      { w = W.ROUTE_DEV_SIG;   label = `${rawDev}km off-route` }
    else if (rawDev > 100) { w = W.ROUTE_DEV_MOD;   label = `${rawDev}km off-route` }
    else if (rawDev > 50)  { w = W.ROUTE_DEV_MINOR; label = `${rawDev}km off-route` }
    if (w > 0) {
      score += w
      tags.push({ label, weight: w, source: 'route' })
      if (w >= W.ROUTE_DEV_MOD) setPrimary(`${rawDev} km off filed route`)
    }
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
  // v5.7.7 — also gate on hex-list match (e.g. AF1) and on news/EMS/police
  // operator hits. classifyAircraft() does the work; we only check the
  // tags array length to avoid recomputing in scoreFlight().
  const ac = classifyAircraft({
    icao: flight.icao, acType: flight.acType,
    operator: flight.acOperator, callsign: flight.callsign,
  })
  if (ac.tags.length > 0) return true
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
