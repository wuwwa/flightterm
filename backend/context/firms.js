// ── NASA FIRMS active-fire pixels ──────────────────────────────────────────
// v2.0.0 — VIIRS_SNPP_NRT (Near-Real-Time) is the lowest-latency source with
// the best resolution (~375m). MODIS_NRT lags more. FIRMS returns CSV.
//
// URL pattern: /api/area/csv/{MAP_KEY}/{SOURCE}/{W,S,E,N}/{DAYS}
// Note: 1-day windows are often empty mid-cycle — use 2 days by default.

const axios = require('axios')
const { radiusBbox, haversineKm } = require('./geo')

const KEY = process.env.FIRMS_MAP_KEY
const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'
const CACHE = new Map()
const TTL_MS = 10 * 60_000

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length <= 1) return []
  const hdr = lines[0].split(',')
  return lines.slice(1).map(row => {
    const cols = row.split(',')
    const o = {}
    hdr.forEach((h, i) => { o[h] = cols[i] })
    return o
  })
}

async function fetchFires({ lat, lon, radiusKm = 50, days = 2, source = 'VIIRS_SNPP_NRT' } = {}) {
  if (!KEY) return { error: 'FIRMS_MAP_KEY not set', fires: [] }
  const [w, s, e, n] = radiusBbox(lat, lon, radiusKm)
  const cacheKey = `${source}:${w.toFixed(2)},${s.toFixed(2)},${e.toFixed(2)},${n.toFixed(2)}:${days}`
  const hit = CACHE.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v

  const url = `${BASE}/${KEY}/${source}/${w.toFixed(4)},${s.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}/${days}`
  const res = await axios.get(url, { timeout: 4000, responseType: 'text' })
  const rows = parseCsv(res.data)
  const fires = rows.map(r => ({
    lat: parseFloat(r.latitude),
    lon: parseFloat(r.longitude),
    brightness: parseFloat(r.bright_ti4 ?? r.brightness),
    frp: parseFloat(r.frp),
    confidence: r.confidence,
    acqDate: r.acq_date,
    acqTime: r.acq_time,
    daynight: r.daynight,
    satellite: r.satellite,
    distanceKm: haversineKm(lat, lon, parseFloat(r.latitude), parseFloat(r.longitude)),
  })).filter(f => Number.isFinite(f.lat) && f.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)

  const out = { count: fires.length, nearest: fires[0] || null, fires }
  CACHE.set(cacheKey, { t: Date.now(), v: out })
  return out
}

module.exports = { fetchFires }
