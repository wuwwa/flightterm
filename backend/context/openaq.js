// ── OpenAQ v3 air-quality monitors ─────────────────────────────────────────
// v2.0.0 — Global monitor directory with sensor listings. Values are fetched
// through /latest per sensor once we pick a location. Used to close the
// wildfire→smoke→low-altitude-tanker-orbit inference loop.

const axios = require('axios')
const { radiusBbox } = require('./geo')

const KEY = process.env.OPENAQ_KEY
const BASE = 'https://api.openaq.org/v3'
const CACHE = new Map()
const TTL_MS = 10 * 60_000

function headers() { return KEY ? { 'X-API-Key': KEY } : {} }

async function fetchNearbyAQ({ lat, lon, radiusKm = 15, limit = 10 } = {}) {
  if (!KEY) return { error: 'OPENAQ_KEY not set', locations: [] }
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}:${radiusKm}:${limit}`
  const hit = CACHE.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v

  const radiusMeters = Math.min(Math.round(radiusKm * 1000), 25000) // OpenAQ caps at 25km
  const locRes = await axios.get(`${BASE}/locations`, {
    params: { coordinates: `${lat},${lon}`, radius: radiusMeters, limit },
    headers: headers(),
    timeout: 4000,
  })
  const locs = locRes.data?.results || []

  // Pick the closest location and fetch latest readings per sensor (one call).
  let latest = null
  if (locs.length) {
    const closest = locs[0]
    try {
      const latestRes = await axios.get(`${BASE}/locations/${closest.id}/latest`, {
        headers: headers(), timeout: 4000,
      })
      latest = {
        locationId: closest.id,
        locationName: closest.name,
        coordinates: closest.coordinates,
        readings: (latestRes.data?.results || []).map(r => ({
          sensorId: r.sensorsId,
          value: r.value,
          datetime: r.datetime?.utc,
        })),
      }
    } catch { /* leave latest null */ }
  }

  const out = {
    count: locs.length,
    closest: locs[0] ? {
      id: locs[0].id,
      name: locs[0].name,
      coordinates: locs[0].coordinates,
      sensors: (locs[0].sensors || []).map(s => ({
        id: s.id,
        parameter: s.parameter?.name,
        units: s.parameter?.units,
      })),
    } : null,
    latest,
  }
  CACHE.set(cacheKey, { t: Date.now(), v: out })
  return out
}

module.exports = { fetchNearbyAQ }
