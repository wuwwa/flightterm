// ── NPS Webcams ─────────────────────────────────────────────────────────────
// v2.0.0 — 291 cams across US national parks. Used to visually corroborate a
// low-altitude orbit in or near a park (common for wildfire air ops, SAR).
//
// The full list is small so we fetch once and filter in memory. TTL 6h.

const axios = require('axios')
const { haversineKm } = require('./geo')

const KEY = process.env.NPS_KEY
const BASE = 'https://developer.nps.gov/api/v1/webcams'
const CACHE = { t: 0, v: null }
const TTL_MS = 6 * 60 * 60_000

async function loadAll() {
  if (!KEY) return []
  if (CACHE.v && Date.now() - CACHE.t < TTL_MS) return CACHE.v
  const all = []
  let start = 0
  const pageSize = 50
  // NPS total is ~291 — cap at 6 pages for safety.
  for (let i = 0; i < 6; i++) {
    const res = await axios.get(BASE, {
      params: { api_key: KEY, limit: pageSize, start },
      timeout: 10000,
    })
    const chunk = res.data?.data || []
    all.push(...chunk)
    if (chunk.length < pageSize) break
    start += pageSize
  }
  CACHE.t = Date.now()
  CACHE.v = all
  return all
}

async function fetchNearby({ lat, lon, radiusKm = 75, limit = 5 } = {}) {
  if (!KEY) return { error: 'NPS_KEY not set', webcams: [] }
  const all = await loadAll()
  const scored = all.map(c => {
    const clat = parseFloat(c.latitude)
    const clon = parseFloat(c.longitude)
    if (!Number.isFinite(clat) || !Number.isFinite(clon)) return null
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      isStreaming: c.isStreaming,
      url: c.url,
      image: c.images?.[0]?.url,
      park: c.relatedParks?.[0]?.fullName,
      parkState: c.relatedParks?.[0]?.states,
      lat: clat, lon: clon,
      distanceKm: haversineKm(lat, lon, clat, clon),
    }
  }).filter(x => x && x.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)

  return { count: scored.length, nearest: scored[0] || null, webcams: scored }
}

module.exports = { fetchNearby }
