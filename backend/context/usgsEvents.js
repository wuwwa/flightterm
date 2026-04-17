// ── USGS earthquakes + volcano alerts ──────────────────────────────────────
// v2.0.0 — Quakes come from the FDSN summary feed (GeoJSON). Volcano alerts
// from the HANS public API; they're color-coded by observatory.
// No key required for either.

const axios = require('axios')
const { haversineKm } = require('./geo')

const QUAKE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'
const VOLCANO_URL = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes'

const CACHE = new Map()
const TTL_MS = 5 * 60_000

async function fetchQuakes({ lat, lon, radiusKm = 500, minMag = 2.5 } = {}) {
  const hit = CACHE.get('quakes')
  const now = Date.now()
  let features
  if (hit && now - hit.t < TTL_MS) {
    features = hit.v
  } else {
    const res = await axios.get(QUAKE_URL, { timeout: 15000 })
    features = res.data?.features || []
    CACHE.set('quakes', { t: now, v: features })
  }

  const enriched = features.map(f => {
    const [qlon, qlat, depthKm] = f.geometry?.coordinates || []
    const props = f.properties || {}
    if (qlat == null || qlon == null) return null
    return {
      id: f.id,
      mag: props.mag,
      place: props.place,
      time: props.time,
      tsunami: !!props.tsunami,
      alert: props.alert,
      url: props.url,
      lat: qlat, lon: qlon, depthKm,
      distanceKm: (lat != null && lon != null) ? haversineKm(lat, lon, qlat, qlon) : null,
    }
  }).filter(q => q && q.mag >= minMag)

  const within = (lat != null && lon != null)
    ? enriched.filter(q => q.distanceKm <= radiusKm)
    : enriched
  within.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))

  return { count: within.length, nearest: within[0] || null, quakes: within.slice(0, 20) }
}

async function fetchVolcanoAlerts() {
  const hit = CACHE.get('volcanoes')
  const now = Date.now()
  if (hit && now - hit.t < TTL_MS) return hit.v

  const res = await axios.get(VOLCANO_URL, { timeout: 15000 })
  const raw = Array.isArray(res.data) ? res.data : []
  // Group by volcano, keep highest alert per volcano (most recent).
  const byVolcano = new Map()
  for (const v of raw) {
    const existing = byVolcano.get(v.volcano_name)
    if (!existing || (v.sent_unixtime || 0) > (existing.sent_unixtime || 0)) {
      byVolcano.set(v.volcano_name, v)
    }
  }
  const alerts = [...byVolcano.values()].map(v => ({
    name: v.volcano_name,
    vnum: v.vnum,
    colorCode: v.color_code,       // GREEN / YELLOW / ORANGE / RED
    alertLevel: v.alert_level,     // NORMAL / ADVISORY / WATCH / WARNING
    observatory: v.obs_fullname,
    sent: v.sent_utc,
    noticeUrl: v.notice_url,
  }))
  CACHE.set('volcanoes', { t: now, v: { count: alerts.length, alerts } })
  return CACHE.get('volcanoes').v
}

module.exports = { fetchQuakes, fetchVolcanoAlerts }
