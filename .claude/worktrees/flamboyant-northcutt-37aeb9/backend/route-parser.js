// ── Route parser: convert FAA route strings to waypoint sequences ───────────
// Resolves waypoints against navaids database + airport coordinates from anomaly.js.
// Falls back gracefully — unknown fixes are skipped, not fatal.

const path = require('path')

// ── Load navaid database ────────────────────────────────────────────────────
const navaidsRaw = require('./data/navaids.json')
const { AIRPORTS } = require('./anomaly')

// Build a lookup map: ID → { lat, lon }
// Navaids first, then airports (airports use ICAO codes with K-prefix and 3-letter)
const navaidMap = new Map()

for (const n of navaidsRaw) {
  navaidMap.set(n.id.toUpperCase(), { lat: n.lat, lon: n.lon, type: n.type })
}

// Add airports: both ICAO (KJFK) and FAA 3-letter (JFK) forms
for (const ap of AIRPORTS) {
  const icao = ap.icao.toUpperCase()
  const faa = icao.startsWith('K') ? icao.slice(1) : null
  navaidMap.set(icao, { lat: ap.lat, lon: ap.lon, type: 'APT' })
  if (faa && !navaidMap.has(faa)) {
    navaidMap.set(faa, { lat: ap.lat, lon: ap.lon, type: 'APT' })
  }
}

/**
 * Resolve a fix/navaid/airport identifier to coordinates.
 * Returns { name, lat, lon } or null if not found.
 */
function resolveWaypoint(id) {
  if (!id) return null
  const key = id.toUpperCase().trim()
  if (!key) return null
  const entry = navaidMap.get(key)
  if (entry) return { name: key, lat: entry.lat, lon: entry.lon }
  return null
}

// Airway identifiers: J-routes (J80), V-routes (V233), Q-routes (Q100), T-routes (T200)
const AIRWAY_RE = /^[JVQT]\d{1,4}$/

// SID/STAR identifiers: typically end with a digit (GLAND4, HAWKZ2, RNAV6)
// but could also be fully named. We detect them by the trailing digit pattern.
const SID_STAR_RE = /^[A-Z]{2,5}\d{1,2}$/

/**
 * Parse an FAA route string into an ordered array of resolved waypoints.
 *
 * Handles formats:
 *   "KBFL..VNY"                    — direct (split on ..)
 *   "J80 BOWIE J42 ETG"            — airways + fixes (skip airway IDs)
 *   "DIRECT"                       — return empty array (use great circle)
 *   "GLAND4 GLAND J80 ETG J42 BOWIE V233 LAX" — SID + airways + fixes
 *
 * Returns: [ { name, lat, lon }, ... ] — ordered waypoints with coordinates
 *          Empty array if route can't be parsed or is "DIRECT"
 */
function parseRoute(routeString) {
  if (!routeString || typeof routeString !== 'string') return []

  const trimmed = routeString.trim().toUpperCase()

  // Handle DIRECT — no waypoints, use great circle fallback
  if (trimmed === 'DIRECT' || trimmed === 'DCT' || trimmed === '') return []

  // Split on common delimiters: ".." (direct-to), spaces, "/"
  // The ".." separator indicates direct routing between fixes
  const tokens = trimmed
    .replace(/\.\./g, ' ')  // convert .. to space
    .replace(/\//g, ' ')    // convert / to space
    .split(/\s+/)
    .filter(Boolean)

  const waypoints = []
  const seen = new Set() // avoid duplicate consecutive waypoints

  for (const token of tokens) {
    // Skip airway identifiers (J80, V233, Q100, T200)
    if (AIRWAY_RE.test(token)) continue

    // Skip the word DIRECT or DCT inline
    if (token === 'DIRECT' || token === 'DCT') continue

    // For SID/STAR names (e.g., GLAND4), try stripping the trailing digit(s)
    // to get the base fix name, but also try the full token
    let wp = resolveWaypoint(token)

    if (!wp && SID_STAR_RE.test(token)) {
      // Strip trailing digits to get base fix name
      const baseFix = token.replace(/\d+$/, '')
      wp = resolveWaypoint(baseFix)
    }

    if (wp && !seen.has(wp.name)) {
      waypoints.push(wp)
      seen.add(wp.name)
    }
  }

  return waypoints
}

// ── Haversine cross-track distance ──────────────────────────────────────────
// Reuses the same math as poller.js crossTrackDistKm but operates on
// a polyline (sequence of waypoints) and returns the minimum distance
// to any segment.

const R_EARTH = 6371 // km
const toRad = d => d * Math.PI / 180

/**
 * Cross-track distance from point P to the great-circle line A→B (km).
 * Same algorithm as poller.js crossTrackDistKm.
 */
function segmentCrossTrackDistKm(pLat, pLon, aLat, aLon, bLat, bLon) {
  const pLatR = toRad(pLat), pLonR = toRad(pLon)
  const aLatR = toRad(aLat), aLonR = toRad(aLon)
  const bLatR = toRad(bLat), bLonR = toRad(bLon)

  // Angular distance from A to P
  const dAP = 2 * Math.asin(Math.sqrt(
    Math.sin((pLatR - aLatR) / 2) ** 2 +
    Math.cos(aLatR) * Math.cos(pLatR) * Math.sin((pLonR - aLonR) / 2) ** 2
  ))

  // If A and P are essentially the same point, distance is 0
  if (dAP < 1e-10) return 0

  // Bearing from A to B
  const brngAB = Math.atan2(
    Math.sin(bLonR - aLonR) * Math.cos(bLatR),
    Math.cos(aLatR) * Math.sin(bLatR) - Math.sin(aLatR) * Math.cos(bLatR) * Math.cos(bLonR - aLonR)
  )
  // Bearing from A to P
  const brngAP = Math.atan2(
    Math.sin(pLonR - aLonR) * Math.cos(pLatR),
    Math.cos(aLatR) * Math.sin(pLatR) - Math.sin(aLatR) * Math.cos(pLatR) * Math.cos(pLonR - aLonR)
  )

  // Cross-track distance (signed, take abs)
  const xtd = Math.abs(Math.asin(Math.sin(dAP) * Math.sin(brngAP - brngAB)) * R_EARTH)

  // Also check along-track distance to handle points beyond segment endpoints.
  // The cross-track formula gives distance to the *infinite* great circle line,
  // but we want distance to the finite *segment* A→B.
  // Compute along-track distance from A:
  const atd = Math.acos(Math.cos(dAP) / Math.cos(xtd / R_EARTH)) * R_EARTH

  // Angular distance A→B
  const dAB = 2 * Math.asin(Math.sqrt(
    Math.sin((bLatR - aLatR) / 2) ** 2 +
    Math.cos(aLatR) * Math.cos(bLatR) * Math.sin((bLonR - aLonR) / 2) ** 2
  ))
  const segLen = dAB * R_EARTH

  // If the perpendicular foot falls within the segment, cross-track is the answer.
  // Otherwise, use the distance to the nearest endpoint.
  if (atd >= 0 && atd <= segLen) {
    return xtd
  }

  // Distance to endpoint A
  const distA = dAP * R_EARTH
  // Distance to endpoint B
  const dBP = 2 * Math.asin(Math.sqrt(
    Math.sin((pLatR - bLatR) / 2) ** 2 +
    Math.cos(bLatR) * Math.cos(pLatR) * Math.sin((pLonR - bLonR) / 2) ** 2
  ))
  const distB = dBP * R_EARTH

  return Math.min(distA, distB)
}

/**
 * Compute the minimum cross-track distance from a point to a polyline
 * defined by an array of waypoints.
 *
 * @param {number} pLat - Aircraft latitude
 * @param {number} pLon - Aircraft longitude
 * @param {Array<{lat: number, lon: number}>} waypoints - Ordered waypoint array
 * @returns {number} Minimum distance in km to the nearest segment
 */
function polylineCrossTrackDistKm(pLat, pLon, waypoints) {
  if (!waypoints || waypoints.length === 0) return Infinity
  if (waypoints.length === 1) {
    // Single waypoint — return distance to it
    const d = 2 * Math.asin(Math.sqrt(
      Math.sin(toRad(pLat - waypoints[0].lat) / 2) ** 2 +
      Math.cos(toRad(waypoints[0].lat)) * Math.cos(toRad(pLat)) *
      Math.sin(toRad(pLon - waypoints[0].lon) / 2) ** 2
    ))
    return d * R_EARTH
  }

  let minDist = Infinity

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]
    const b = waypoints[i + 1]
    const dist = segmentCrossTrackDistKm(pLat, pLon, a.lat, a.lon, b.lat, b.lon)
    if (dist < minDist) minDist = dist
  }

  return minDist
}

/**
 * Get stats about the navaid database (for logging/diagnostics).
 */
function getNavaidStats() {
  let vors = 0, fixes = 0, airports = 0
  for (const [, v] of navaidMap) {
    if (v.type === 'APT') airports++
    else if (v.type === 'FIX') fixes++
    else vors++
  }
  return { total: navaidMap.size, vors, fixes, airports }
}

module.exports = {
  parseRoute,
  polylineCrossTrackDistKm,
  resolveWaypoint,
  getNavaidStats,
  // Expose for testing
  _navaidMap: navaidMap,
  _segmentCrossTrackDistKm: segmentCrossTrackDistKm,
}
