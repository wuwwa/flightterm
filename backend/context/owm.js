// ── OpenWeatherMap current weather at a point ──────────────────────────────
// v2.0.0 — Redundant with METAR near airports but gives coverage over water
// and between stations. Cached 5 min since OWM refreshes ~every 10 min.

const axios = require('axios')

const KEY = process.env.OPENWEATHERMAP_KEY
const BASE = 'https://api.openweathermap.org/data/2.5/weather'
const CACHE = new Map()
const TTL_MS = 5 * 60_000

async function fetchCurrent({ lat, lon, units = 'metric' } = {}) {
  if (!KEY) return { error: 'OPENWEATHERMAP_KEY not set' }
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}:${units}`
  const hit = CACHE.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v

  const res = await axios.get(BASE, {
    params: { lat, lon, appid: KEY, units }, timeout: 4000,
  })
  const d = res.data || {}
  const out = {
    tempC: d.main?.temp,
    feelsLikeC: d.main?.feels_like,
    pressureHpa: d.main?.pressure,
    humidity: d.main?.humidity,
    visibility: d.visibility,
    wind: { speed: d.wind?.speed, deg: d.wind?.deg, gust: d.wind?.gust },
    clouds: d.clouds?.all,
    weather: (d.weather || []).map(w => ({ id: w.id, main: w.main, desc: w.description })),
    city: d.name,
    observedAt: d.dt ? new Date(d.dt * 1000).toISOString() : null,
  }
  CACHE.set(cacheKey, { t: Date.now(), v: out })
  return out
}

module.exports = { fetchCurrent }
