import axios from 'axios'

export async function recordSightings(flights, source, region) {
  const res = await axios.post('/api/sightings', { flights, source, region })
  return res.data
}

export async function fetchAircraftTrack(icao, limit = 60) {
  const res = await axios.get(`/api/sightings/track/${icao}`, { params: { limit } })
  return res.data
}

export async function fetchOpenSkyUsageToday() {
  const res = await axios.get('/api/usage/today', { params: { service: 'opensky' } })
  return res.data
}

export async function recordAnomalies(anomalies, region) {
  const res = await axios.post('/api/anomalies', { anomalies, region })
  return res.data
}

export async function resolveAnomalies(icaos) {
  const res = await axios.post('/api/anomalies/resolve', { icaos })
  return res.data
}

// ── Route cache ──────────────────────────────────────────────────────────────

// Bulk lookup: returns { routes: { callsign: routeObj }, unknown: ['CS1', ...] }
export async function lookupRoutes(callsigns) {
  const res = await axios.post('/api/routes/lookup', { callsigns })
  return res.data
}

// Save enriched routes to backend cache
export async function saveRoutes(routes) {
  const res = await axios.post('/api/routes/save', { routes })
  return res.data
}
