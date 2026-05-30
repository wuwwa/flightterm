// ── NASA EONET (Earth Observatory Natural Event Tracker) ───────────────────
// v2.0.0 — curated natural-event feed covering wildfires, severe storms,
// volcanoes, icebergs, etc. Each event carries geometry[] points with dates
// and magnitudes. No key required.

const axios = require('axios')
const { haversineKm } = require('./geo')

const BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events'
const CACHE = new Map()
const TTL_MS = 10 * 60_000

async function fetchEvents({ lat, lon, radiusKm = 200, status = 'open', days = 7 } = {}) {
  const cacheKey = `${status}:${days}`
  const hit = CACHE.get(cacheKey)
  const now = Date.now()

  let raw
  if (hit && now - hit.t < TTL_MS) {
    raw = hit.v
  } else {
    const res = await axios.get(BASE, {
      params: { status, days, limit: 200 },
      timeout: 4000,
    })
    raw = res.data?.events || []
    CACHE.set(cacheKey, { t: now, v: raw })
  }

  // Each event has geometry[] — use the most recent point for distance.
  const enriched = raw.map(ev => {
    const pts = (ev.geometry || [])
      .filter(g => Array.isArray(g.coordinates))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
    const last = pts[0]
    if (!last) return null
    const [elon, elat] = last.coordinates
    const distanceKm = (lat != null && lon != null)
      ? haversineKm(lat, lon, elat, elon)
      : null
    return {
      id: ev.id,
      title: ev.title,
      categories: ev.categories?.map(c => c.id) || [],
      lat: elat,
      lon: elon,
      magnitude: last.magnitudeValue,
      magnitudeUnit: last.magnitudeUnit,
      date: last.date,
      link: ev.link,
      distanceKm,
    }
  }).filter(Boolean)

  const within = (lat != null && lon != null)
    ? enriched.filter(e => e.distanceKm != null && e.distanceKm <= radiusKm)
    : enriched
  within.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))

  return { count: within.length, nearest: within[0] || null, events: within }
}

module.exports = { fetchEvents }
