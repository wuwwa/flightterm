// ── Open-Meteo (no key) ─────────────────────────────────────────────────────
// v2.0.0 — Keyless, global, returns current wind/vis/weather-code. Used as a
// fallback + for non-US coverage where NWS/METAR stop.

const axios = require('axios')

const BASE = 'https://api.open-meteo.com/v1/forecast'
const CACHE = new Map()
const TTL_MS = 5 * 60_000

// WMO weather code → plain-English (subset enough for aircraft context).
const WMO = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'heavy rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm w/ hail', 99: 'heavy thunderstorm w/ hail',
}

async function fetchCurrent({ lat, lon } = {}) {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`
  const hit = CACHE.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v

  const res = await axios.get(BASE, {
    params: {
      latitude: lat, longitude: lon,
      current: 'temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility,weather_code,cloud_cover,precipitation',
      wind_speed_unit: 'kn',
    },
    timeout: 10000,
  })
  const c = res.data?.current || {}
  const out = {
    tempC: c.temperature_2m,
    windKts: c.wind_speed_10m,
    windGustKts: c.wind_gusts_10m,
    windDeg: c.wind_direction_10m,
    visibilityM: c.visibility,
    weatherCode: c.weather_code,
    weather: WMO[c.weather_code] ?? `wmo:${c.weather_code}`,
    cloudCover: c.cloud_cover,
    precipMm: c.precipitation,
    time: c.time,
  }
  CACHE.set(cacheKey, { t: Date.now(), v: out })
  return out
}

module.exports = { fetchCurrent }
