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

export async function fetchArchiveHealth() {
  const res = await axios.get('/api/health/archive', { timeout: 10000 })
  return res.data
}
