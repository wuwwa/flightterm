// ── Correlation Layer client (v2.0.0) ──────────────────────────────────────
// Thin wrapper over /api/context/*. The backend does all the heavy lifting;
// this file is just typed shapes for the UI.

import axios from 'axios'

const TIMEOUT = 20000

export async function fetchAircraftContext(icao, fallback = {}) {
  const params = {}
  if (fallback.lat != null) params.lat = fallback.lat
  if (fallback.lon != null) params.lon = fallback.lon
  if (fallback.altitude != null) params.altitude = fallback.altitude
  if (fallback.velocity != null) params.velocity = fallback.velocity
  if (fallback.heading != null) params.heading = fallback.heading
  if (fallback.callsign) params.callsign = fallback.callsign
  if (fallback.squawk) params.squawk = fallback.squawk
  const res = await axios.get(`/api/context/aircraft/${icao}`, { params, timeout: TIMEOUT })
  return res.data
}

export async function fetchPositionContext(body) {
  const res = await axios.post('/api/context/position', body, { timeout: TIMEOUT })
  return res.data
}

export async function fetchFires({ lat, lon, radiusKm, days }) {
  const res = await axios.get('/api/context/fires', { params: { lat, lon, radiusKm, days }, timeout: TIMEOUT })
  return res.data
}

export async function fetchEvents({ lat, lon, radiusKm }) {
  const res = await axios.get('/api/context/events', { params: { lat, lon, radiusKm }, timeout: TIMEOUT })
  return res.data
}

export async function fetchNearbyAQ({ lat, lon, radiusKm }) {
  const res = await axios.get('/api/context/airquality', { params: { lat, lon, radiusKm }, timeout: TIMEOUT })
  return res.data
}

export async function fetchWeather({ lat, lon, provider }) {
  const res = await axios.get('/api/context/weather', { params: { lat, lon, provider }, timeout: TIMEOUT })
  return res.data
}

export async function fetchWebcams({ lat, lon, radiusKm }) {
  const res = await axios.get('/api/context/webcams', { params: { lat, lon, radiusKm }, timeout: TIMEOUT })
  return res.data
}

export async function fetchStreetLevel({ lat, lon, radiusKm }) {
  const res = await axios.get('/api/context/streetlevel', { params: { lat, lon, radiusKm }, timeout: TIMEOUT })
  return res.data
}

export async function fetchSpaceWeather() {
  const res = await axios.get('/api/context/space-weather', { timeout: TIMEOUT })
  return res.data
}

export async function fetchQuakes({ lat, lon, radiusKm }) {
  const res = await axios.get('/api/context/quakes', { params: { lat, lon, radiusKm }, timeout: TIMEOUT })
  return res.data
}

export async function fetchVolcanoAlerts() {
  const res = await axios.get('/api/context/volcanoes', { timeout: TIMEOUT })
  return res.data
}
