import axios from 'axios'

// All requests go to /api/aero/* which Vite proxies to Express on :3001
// The Express server holds the API key — it never reaches the browser
const BASE = '/api/aero'

export async function fetchFlight(callsign, userAeroKey = '') {
  const cs = callsign.trim().replace(/\s+/g, '')
  const headers = {}
  if (userAeroKey) headers['x-user-aero-key'] = userAeroKey
  const response = await axios.get(`${BASE}/flights/${cs}`, {
    params: { max_pages: 1 }, headers,
  })
  const flights = response.data?.flights || []
  // Prefer an active en-route flight, fall back to most recent
  return flights.find(f => f.progress_percent > 0 && f.progress_percent < 100)
    || flights[0]
    || null
}

export async function fetchUsage(params = {}) {
  const response = await axios.get(`${BASE}/usage`, { params })
  return response.data
}

export async function fetchCosts() {
  const response = await axios.get(`${BASE}/costs`)
  return response.data
}

export async function fetchAeroSpend() {
  const response = await axios.get(`${BASE}/spend`)
  return response.data
}

export async function fetchKeyStatus() {
  const response = await axios.get('/api/keys')
  return response.data
}

export async function checkHealth() {
  const response = await axios.get('/api/health')
  return response.data
}
