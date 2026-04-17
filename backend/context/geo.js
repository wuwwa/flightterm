// ── Geographic helpers for the correlation layer ────────────────────────────
// v2.0.0 — small utilities used by every context adapter: bounding-box math,
// haversine distance, and radius-to-bbox conversion. Kept standalone so each
// adapter stays dependency-free.

const EARTH_RADIUS_KM = 6371

function toRad(deg) { return (deg * Math.PI) / 180 }
function toDeg(rad) { return (rad * 180) / Math.PI }

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

// Returns [w, s, e, n] in degrees for a circle of `radiusKm` around (lat, lon).
// At high latitudes this overbounds in longitude; callers should re-filter
// with haversine if they need tight radius.
function radiusBbox(lat, lon, radiusKm) {
  const dLat = toDeg(radiusKm / EARTH_RADIUS_KM)
  const dLon = toDeg(radiusKm / (EARTH_RADIUS_KM * Math.cos(toRad(lat)) || 1e-9))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

module.exports = { haversineKm, radiusBbox, clamp, toRad, toDeg }
