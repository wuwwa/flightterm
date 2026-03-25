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
