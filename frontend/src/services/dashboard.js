import axios from 'axios'

export async function fetchAnomalyFeed(limit = 30) {
  const res = await axios.get('/api/anomalies', { params: { limit } })
  return res.data
}

export async function fetchActiveAnomalies() {
  const res = await axios.get('/api/anomalies/active')
  return res.data
}

export async function fetchAnomalyStats() {
  const res = await axios.get('/api/anomalies/stats')
  return res.data
}

export async function fetchSightingStats() {
  const res = await axios.get('/api/sightings/stats')
  return res.data
}

export async function fetchHourlyActivity() {
  const res = await axios.get('/api/sightings/activity/hourly')
  return res.data
}

export async function fetchServiceHealth() {
  const res = await axios.get('/api/health/services', { timeout: 30000 })
  return res.data
}

export async function fetchTrafficHeatmap() {
  const res = await axios.get('/api/sightings/heatmap', { timeout: 10000 })
  return res.data
}

export async function fetchBusinessJetTracker(signal) {
  const res = await axios.get('/api/business-jet-tracker', { timeout: 10000, signal })
  return res.data
}

export async function fetchPrivateFlightPath(icao, signal) {
  const res = await axios.get(`/api/business-jet-tracker/${encodeURIComponent(icao)}/path`, { timeout: 10000, signal })
  return res.data
}

export async function fetchArchiveHealth() {
  const res = await axios.get('/api/health/archive', { timeout: 10000 })
  return res.data
}

export async function fetchDbMetrics() {
  const res = await axios.get('/api/db/metrics')
  return res.data
}

export async function fetchAnomaliesByIcao(icao, limit = 20) {
  const res = await axios.get(`/api/anomalies/aircraft/${icao}`, { params: { limit } })
  return res.data
}

export async function fetchAnomalyHotspots(hours = 24, min = 2) {
  const res = await axios.get('/api/anomalies/hotspots', { params: { hours, min } })
  return res.data
}

export async function fetchFlightPositions(limit = 500) {
  const res = await axios.get('/api/swim/flights/positions', { params: { limit } })
  return res.data
}

export async function fetchSurfacePositions(limit = 300) {
  const res = await axios.get('/api/swim/surface/positions', { params: { limit } })
  return res.data
}

export async function fetchAnomaliesByZone(lat, lon, hours = 24, limit = 30) {
  const res = await axios.get('/api/anomalies/zone', { params: { lat, lon, hours, limit } })
  return res.data
}

export async function submitAnomalyFeedback(id, feedback, note = null) {
  const res = await axios.put(`/api/anomalies/${id}/feedback`, { feedback, note })
  return res.data
}

export async function fetchFeedbackStats() {
  const res = await axios.get('/api/anomalies/feedback/stats')
  return res.data
}
