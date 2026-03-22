require('dotenv').config()
const express = require('express')
const axios = require('axios')
const cors = require('cors')

const app = express()
const PORT = process.env.PORT || 3001
const AERO_BASE = 'https://aeroapi.flightaware.com/aeroapi'
const OS_BASE   = 'https://opensky-network.org/api'
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'

app.use(cors())
app.use(express.json())

// ── OpenSky OAuth2 token cache ────────────────────────────────────────────────
let _osToken = null  // { token, expiresAt }

async function getOsToken() {
  const now = Date.now()
  if (_osToken && now < _osToken.expiresAt) return _osToken.token

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.OS_CLIENT_ID,
    client_secret: process.env.OS_CLIENT_SECRET,
  })
  const res = await axios.post(OS_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
  const expiresIn = res.data.expires_in ?? 1800
  _osToken = {
    token:     res.data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  }
  return _osToken.token
}

// ── helpers ──────────────────────────────────────────────────────────────────

function aeroHeaders() {
  return { 'x-apikey': process.env.AEROAPI_KEY }
}

function missingKey(res) {
  if (!process.env.AEROAPI_KEY) {
    res.status(500).json({ error: 'AEROAPI_KEY not set in backend .env' })
    return true
  }
  return false
}

// ── AeroAPI cost map ──────────────────────────────────────────────────────────
// Prices per result set (1 set = up to 15 records)
// Source: flightaware.com/commercial/aeroapi/#plans-comparison-table

const COST_MAP = {
  'GET /flights/search':                     0.050,
  'GET /flights/search/positions':           0.050,
  'GET /flights/search/count':               0.020,
  'GET /flights/search/advanced':            0.050,
  'GET /flights/{ident}':                    0.005,
  'GET /flights/{ident}/canonical':          0.001,
  'GET /flights/{id}/position':              0.010,
  'GET /flights/{id}/track':                 0.012,
  'GET /flights/{id}/route':                 0.010,
  'GET /flights/{id}/map':                   0.030,
  'GET /airports':                           0.005,
  'GET /airports/nearby':                    0.004,
  'GET /airports/delays':                    0.050,
  'GET /airports/{id}':                      0.015,
  'GET /airports/{id}/canonical':            0.001,
  'GET /airports/{id}/nearby':               0.004,
  'GET /airports/{id}/delays':               0.010,
  'GET /airports/{id}/flights':              0.020,
  'GET /airports/{id}/flights/arrivals':     0.005,
  'GET /airports/{id}/flights/departures':   0.005,
  'GET /airports/{id}/flights/scheduled_departures': 0.005,
  'GET /airports/{id}/flights/scheduled_arrivals':   0.005,
  'GET /airports/{id}/flights/to/{dest_id}': 0.050,
  'GET /airports/{id}/flights/counts':       0.100,
  'GET /airports/{id}/weather/observations': 0.002,
  'GET /airports/{id}/weather/forecast':     0.002,
  'GET /airports/{id}/routes/{dest_id}':     0.020,
  'GET /operators':                          0.002,
  'GET /operators/{id}':                     0.015,
  'GET /operators/{id}/canonical':           0.001,
  'GET /operators/{id}/flights':             0.030,
  'GET /operators/{id}/flights/scheduled':   0.005,
  'GET /operators/{id}/flights/arrivals':    0.005,
  'GET /operators/{id}/flights/enroute':     0.005,
  'GET /operators/{id}/flights/counts':      0.100,
  'GET /history/flights/{ident}':            0.020,
  'GET /history/flights/{id}/track':         0.060,
  'GET /history/flights/{id}/map':           0.140,
  'GET /history/flights/{id}/route':         0.040,
  'GET /history/airports/{id}/flights/arrivals':    0.020,
  'GET /history/airports/{id}/flights/departures':  0.020,
  'GET /history/airports/{id}/flights/to/{dest_id}':0.120,
  'GET /history/aircraft/{registration}/last_flight':0.200,
  'GET /history/operators/{id}/flights':     0.020,
  'GET /aircraft/{ident}/blocked':           0.020,
  'GET /aircraft/{ident}/owner':             0.002,
  'GET /aircraft/types/{type}':              0.100,
  'GET /schedules/{date_start}/{date_end}':  0.020,
  'GET /disruption_counts/{entity_type}':    0.020,
  'Push Alert Delivery':                     0.020,
  'GET /account/usage':                      0.000,
  'GET /alerts':                             0.000,
  'POST /alerts':                            0.000,
}

// ── routes ────────────────────────────────────────────────────────────────────

// Root — helpful redirect hint
app.get('/', (req, res) => {
  res.json({ service: 'flightterm-backend', ui: 'http://localhost:5173', health: '/api/health' })
})

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    aeroapi_configured: !!process.env.AEROAPI_KEY,
    timestamp: new Date().toISOString()
  })
})

// Expose cost map to frontend (no key needed)
app.get('/api/aero/costs', (req, res) => {
  res.json(COST_MAP)
})

// OpenSky states proxy — holds OAuth2 token server-side
// GET /api/opensky/states?region=europe  (bbox params forwarded)
app.get('/api/opensky/states', async (req, res) => {
  const headers = {}
  if (process.env.OS_CLIENT_ID && process.env.OS_CLIENT_SECRET) {
    try {
      const token = await getOsToken()
      headers['Authorization'] = `Bearer ${token}`
    } catch (err) {
      console.warn('opensky token fetch failed:', err.message)
      // fall through as anonymous
    }
  }
  try {
    const response = await axios.get(`${OS_BASE}/states/all`, {
      headers,
      params: req.query,   // bbox params (lamin/lomin/lamax/lomax) pass straight through
    })
    res.json(response.data)
  } catch (err) {
    const status = err.response?.status || 500
    res.status(status).json({ error: err.response?.data || err.message, status })
  }
})

// Flight lookup by ident (callsign)
// GET /api/aero/flights/:ident
app.get('/api/aero/flights/:ident', async (req, res) => {
  if (missingKey(res)) return
  const { ident } = req.params
  const { max_pages = 1 } = req.query
  try {
    const response = await axios.get(
      `${AERO_BASE}/flights/${ident}`,
      {
        headers: aeroHeaders(),
        params: { max_pages: Number(max_pages) }
      }
    )
    res.json(response.data)
  } catch (err) {
    const status = err.response?.status || 500
    const message = err.response?.data?.title || err.message
    res.status(status).json({ error: message, status })
  }
})

// Account usage statistics
// GET /api/aero/usage
app.get('/api/aero/usage', async (req, res) => {
  if (missingKey(res)) return
  const { start, end, all_keys } = req.query
  try {
    const response = await axios.get(
      `${AERO_BASE}/account/usage`,
      {
        headers: aeroHeaders(),
        params: {
          ...(start && { start }),
          ...(end && { end }),
          ...(all_keys !== undefined && { all_keys })
        }
      }
    )
    // Attach cost_map to each resource_detail for convenience
    const data = response.data
    if (data.resource_details) {
      data.resource_details = data.resource_details.map(d => ({
        ...d,
        unit_cost: COST_MAP[d.operation] ?? null
      }))
    }
    res.json(data)
  } catch (err) {
    const status = err.response?.status || 500
    const message = err.response?.data?.title || err.message
    res.status(status).json({ error: message, status })
  }
})

// ── start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`flightterm backend running on http://localhost:${PORT}`)
  if (!process.env.AEROAPI_KEY) {
    console.warn('  ⚠  AEROAPI_KEY not set — add it to backend/.env')
  } else {
    console.log('  ✓  AEROAPI_KEY loaded')
  }
})
