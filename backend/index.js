require('dotenv').config()
const express = require('express')
const axios = require('axios')
const cors = require('cors')
const {
  recordSightings, getAircraftHistory, getAircraftTrack, getUniqueSeen,
  getStats, getTopAircraft, getTopCountries,
  getHourlyActivity, getRecentFetches, getDbSize,
  calcOpenSkyCredits, recordApiCall,
  getUsageSummary, getTodayCredits, getDailyUsage, getRecentCalls,
  getAeroSpendTotal, getAeroSpendMonth,
  recordAnomalies, resolveAnomalies,
  getRecentAnomalies, getActiveAnomalies, getAnomaliesByIcao, getAnomalyStats,
  getTrafficHeatmap,
  runDeferredMaintenance,
} = require('./db')
const { getStatus: getS3Status, isEnabled: s3IsEnabled } = require('./s3archive')

const path = require('path')
const app = express()
const PORT = process.env.PORT || 3001
const AERO_BASE = 'https://aeroapi.flightaware.com/aeroapi'
const AERO_CAP = 5.00 // hard cap in USD — do not change
const OS_BASE   = 'https://opensky-network.org/api'
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const FAA_NOTAM_BASE = 'https://external-api.faa.gov/notamapi/v1/notams'

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
}))
app.use(express.json({ limit: '10mb' }))

// ── OpenSky OAuth2 token cache ────────────────────────────────────────────────
// Separate caches for server (.env) and user-provided credentials
const _osTokens = {}  // keyed by clientId → { token, expiresAt }

async function getOsToken(clientId, clientSecret) {
  const now = Date.now()
  const cached = _osTokens[clientId]
  if (cached && now < cached.expiresAt) return cached.token

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  })
  const res = await axios.post(OS_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
  const expiresIn = res.data.expires_in ?? 1800
  _osTokens[clientId] = {
    token:     res.data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  }
  return _osTokens[clientId].token
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

// ── serve frontend in production ──────────────────────────────────────────────
const STATIC_DIR = path.join(__dirname, '..', 'frontend', 'dist')
console.log(`looking for frontend at ${STATIC_DIR} — exists: ${require('fs').existsSync(STATIC_DIR)}`)
if (require('fs').existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR))
  console.log(`serving frontend from ${STATIC_DIR}`)
}

// ── routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    aeroapi_configured: !!process.env.AEROAPI_KEY,
    opensky_configured: !!(process.env.OS_CLIENT_ID && process.env.OS_CLIENT_SECRET),
    faa_notam_configured: !!(process.env.FAA_CLIENT_ID && process.env.FAA_CLIENT_SECRET),
    s3_archive: getS3Status(),
    db_size: getDbSize(),
    timestamp: new Date().toISOString()
  })
})

// ── Passive service health — tracks success/failure of actual proxy calls ────
// No active probing. Status is derived from real traffic through our proxy routes.
const _serviceHealth = {
  opensky:         { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null },
  adsbfi:          { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null },
  aviationweather: { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null },
  aeroapi:         { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null },
  faa_notam:       { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null },
  // adsbdb + hexdb are called directly from the browser (CORS-enabled), not proxied
}

function recordServiceOk(name, latency) {
  const svc = _serviceHealth[name]
  if (!svc) return
  svc.status = 'ok'
  svc.lastOk = Date.now()
  svc.lastLatency = latency
  svc.error = null
}

function recordServiceError(name, latency, error) {
  const svc = _serviceHealth[name]
  if (!svc) return
  svc.status = 'error'
  svc.lastError = Date.now()
  svc.lastLatency = latency
  svc.error = (error || '').substring(0, 120)
}

// Mark unconfigured services
if (!process.env.AEROAPI_KEY) _serviceHealth.aeroapi.status = 'unconfigured'
if (!process.env.FAA_CLIENT_ID) _serviceHealth.faa_notam.status = 'unconfigured'

// GET /api/health/services — returns passive health derived from real traffic
app.get('/api/health/services', (_req, res) => {
  const services = Object.entries(_serviceHealth).map(([name, svc]) => ({
    name,
    status: svc.status,
    latency: svc.lastLatency,
    lastOk: svc.lastOk ? new Date(svc.lastOk).toISOString() : null,
    lastError: svc.lastError ? new Date(svc.lastError).toISOString() : null,
    error: svc.error,
  }))
  const healthy = services.filter(s => s.status === 'ok' || s.status === 'unconfigured').length
  res.json({
    healthy,
    total: services.length,
    services,
    checked_at: new Date().toISOString(),
  })
})

// GET /api/health/archive — S3 archival status
app.get('/api/health/archive', (_req, res) => {
  const status = getS3Status()
  res.json({
    ...status,
    retention_hours: 3,
    purge_interval: '1h',
    message: status.totalFailures > 0
      ? `⚠ ${status.totalFailures} consecutive failure(s) — data preserved until S3 succeeds`
      : status.lastSuccess
        ? `Last successful archive: ${status.lastSuccess}`
        : s3IsEnabled()
          ? 'Awaiting first archive cycle'
          : 'S3 not configured — data purged without archival',
  })
})

// ── API key status (read-only, never exposes actual values) ─────────────────
app.get('/api/keys', (_req, res) => {
  res.json({
    aeroapi:        !!process.env.AEROAPI_KEY,
    opensky_id:     !!process.env.OS_CLIENT_ID,
    opensky_secret: !!process.env.OS_CLIENT_SECRET,
    faa_notam:      !!(process.env.FAA_CLIENT_ID && process.env.FAA_CLIENT_SECRET),
    adsbx:          false, // adsbx key is stored client-side in settings
    s3_archive:     getS3Status(),
  })
})

// Expose cost map to frontend (no key needed)
app.get('/api/aero/costs', (req, res) => {
  res.json(COST_MAP)
})

// OpenSky states proxy — holds OAuth2 token server-side
// User can override credentials via x-user-os-id / x-user-os-secret headers
// GET /api/opensky/states?region=europe  (bbox params forwarded)
app.get('/api/opensky/states', async (req, res) => {
  const headers = {}
  // prefer user-provided credentials, fall back to .env
  const osId = req.headers['x-user-os-id'] || process.env.OS_CLIENT_ID
  const osSecret = req.headers['x-user-os-secret'] || process.env.OS_CLIENT_SECRET
  if (osId && osSecret) {
    try {
      const token = await getOsToken(osId, osSecret)
      headers['Authorization'] = `Bearer ${token}`
    } catch (err) {
      console.warn('opensky token fetch failed:', err.message)
      // fall through as anonymous
    }
  }
  const credits = calcOpenSkyCredits(req.query)
  const t0 = Date.now()
  try {
    const response = await axios.get(`${OS_BASE}/states/all`, {
      headers,
      params: req.query,   // bbox params (lamin/lomin/lamax/lomax) pass straight through
    })
    recordServiceOk('opensky', Date.now() - t0)
    const stateCount = response.data?.states?.length || 0
    const rateRemaining = response.headers['x-rate-limit-remaining']
    recordApiCall({
      service: 'opensky', endpoint: '/states/all',
      region: req.query.region || 'global', credits,
      status: 200, aircraftCount: stateCount,
      rateRemaining: rateRemaining ? Number(rateRemaining) : null,
    })
    // attach credit info to response for frontend logging
    response.data._credits = { used: credits, remaining: rateRemaining ? Number(rateRemaining) : null }
    res.json(response.data)
  } catch (err) {
    recordServiceError('opensky', Date.now() - t0, err.message)
    const status = err.response?.status || 500
    recordApiCall({
      service: 'opensky', endpoint: '/states/all',
      region: req.query.region || 'global', credits: status === 429 ? 0 : credits,
      status, aircraftCount: 0,
    })
    res.status(status).json({ error: err.response?.data || err.message, status })
  }
})

// Flight lookup by ident (callsign)
// User can override key via x-user-aero-key header (bypasses cap — their key, their bill)
// GET /api/aero/flights/:ident
app.get('/api/aero/flights/:ident', async (req, res) => {
  const userAeroKey = req.headers['x-user-aero-key']
  const activeKey = userAeroKey || process.env.AEROAPI_KEY
  if (!activeKey) {
    return res.status(500).json({ error: 'No AeroAPI key configured' })
  }

  const callCost = COST_MAP['GET /flights/{ident}'] || 0.005

  // ── hard cap check (only for server key, not user-provided) ────────────
  if (!userAeroKey) {
    const { total_spend } = getAeroSpendTotal()
    if (total_spend + callCost > AERO_CAP) {
      return res.status(403).json({
        error: `AeroAPI hard cap reached ($${total_spend.toFixed(3)} / $${AERO_CAP.toFixed(2)})`,
        cap_reached: true,
        total_spend,
        cap: AERO_CAP,
      })
    }
  }

  const { ident } = req.params
  const { max_pages = 1 } = req.query
  const t0 = Date.now()
  try {
    const response = await axios.get(
      `${AERO_BASE}/flights/${ident}`,
      {
        headers: { 'x-apikey': activeKey },
        params: { max_pages: Number(max_pages) }
      }
    )
    recordServiceOk('aeroapi', Date.now() - t0)
    recordApiCall({
      service: 'aeroapi', endpoint: `/flights/${ident}`,
      credits: callCost, status: 200,
      aircraftCount: response.data?.flights?.length || 0,
    })
    res.json(response.data)
  } catch (err) {
    recordServiceError('aeroapi', Date.now() - t0, err.message)
    const status = err.response?.status || 500
    const message = err.response?.data?.title || err.message
    recordApiCall({
      service: 'aeroapi', endpoint: `/flights/${ident}`,
      credits: status >= 400 && status < 500 ? 0 : callCost,
      status,
    })
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

// ── FAA NOTAM proxy ─────────────────────────────────────────────────────────
// Caches per-airport results for 15 minutes to avoid hammering the FAA API
const _notamCache = {} // { KJFK: { data, expiresAt } }
const NOTAM_CACHE_TTL = 15 * 60 * 1000

// GET /api/notams?locations=KJFK,KLAX&pageSize=50
app.get('/api/notams', async (req, res) => {
  const clientId = process.env.FAA_CLIENT_ID
  const clientSecret = process.env.FAA_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'FAA_CLIENT_ID / FAA_CLIENT_SECRET not set in backend .env' })
  }

  const locations = req.query.locations // comma-separated ICAO codes
  if (!locations) {
    return res.status(400).json({ error: 'locations param required (comma-separated ICAO codes)' })
  }

  const codes = locations.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const now = Date.now()
  const results = {}
  const toFetch = []

  // Check cache first
  for (const code of codes) {
    const cached = _notamCache[code]
    if (cached && now < cached.expiresAt) {
      results[code] = cached.data
    } else {
      toFetch.push(code)
    }
  }

  // Fetch uncached airports (batch up to 5 at a time to avoid rate limits)
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5)
    const fetches = batch.map(async (code) => {
      const t0 = Date.now()
      try {
        const response = await axios.get(FAA_NOTAM_BASE, {
          params: {
            responseFormat: 'geoJson',
            icaoLocation: code,
            client_id: clientId,
            client_secret: clientSecret,
            pageSize: 20,
            sortBy: 'effectiveStartDate',
            sortOrder: 'Desc',
          },
          timeout: 10000,
        })
        recordServiceOk('faa_notam', Date.now() - t0)
        const items = (response.data?.items || []).map(item => {
          const notam = item?.properties?.coreNOTAMData?.notam || {}
          return {
            id: notam.id || notam.number,
            number: notam.number,
            type: notam.type,
            issued: notam.issued,
            effectiveStart: notam.effectiveStart,
            effectiveEnd: notam.effectiveEnd,
            text: notam.text,
            classification: notam.classification,
            location: notam.location || notam.icaoLocation || code,
          }
        })
        _notamCache[code] = { data: items, expiresAt: now + NOTAM_CACHE_TTL }
        results[code] = items
      } catch (err) {
        recordServiceError('faa_notam', Date.now() - t0, err.message)
        console.warn(`notam fetch failed for ${code}:`, err.response?.status || err.message)
        results[code] = []
      }
    })
    await Promise.all(fetches)
  }

  res.json({ notams: results, cached: codes.length - toFetch.length, fetched: toFetch.length })
})

// ── Sightings DB routes ─────────────────────────────────────────────────────

// Record a batch of sightings (called by frontend after each fetch)
// POST /api/sightings  { flights: [...], source: 'opensky', region: 'usa' }
app.post('/api/sightings', (req, res) => {
  const { flights, source, region } = req.body
  if (!flights || !Array.isArray(flights)) {
    return res.status(400).json({ error: 'flights array required' })
  }
  try {
    const count = recordSightings(flights, source || 'unknown', region || 'global')
    res.json({ recorded: count })
  } catch (err) {
    console.error('sightings insert error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Aircraft history — all sightings for a single ICAO
// GET /api/sightings/aircraft/:icao?limit=100
app.get('/api/sightings/aircraft/:icao', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000)
  res.json(getAircraftHistory(req.params.icao, limit))
})

// Aircraft track — lightweight alt/vel/hdg history for sparkline charts
// GET /api/sightings/track/:icao?limit=60
app.get('/api/sightings/track/:icao', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 200)
  res.json(getAircraftTrack(req.params.icao, limit))
})

// Unique aircraft seen in a time range
// GET /api/sightings/unique?since=2026-03-01&until=2026-03-22
app.get('/api/sightings/unique', (req, res) => {
  res.json(getUniqueSeen(req.query.since, req.query.until))
})

// Aggregate stats
// GET /api/sightings/stats
app.get('/api/sightings/stats', (_req, res) => {
  res.json(getStats())
})

// Top aircraft by frequency
// GET /api/sightings/top/aircraft?limit=20
app.get('/api/sightings/top/aircraft', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getTopAircraft(limit))
})

// Top countries
// GET /api/sightings/top/countries?limit=20
app.get('/api/sightings/top/countries', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getTopCountries(limit))
})

// Hourly activity pattern
// GET /api/sightings/activity/hourly
app.get('/api/sightings/activity/hourly', (_req, res) => {
  res.json(getHourlyActivity())
})

// Recent fetch history
// GET /api/sightings/fetches?limit=20
app.get('/api/sightings/fetches', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getRecentFetches(limit))
})

// Traffic heatmap — latest position per aircraft from last hour
// GET /api/sightings/heatmap
app.get('/api/sightings/heatmap', (_req, res) => {
  res.json(getTrafficHeatmap())
})

// ── adsb.fi proxy (CORS bypass) ─────────────────────────────────────────────

// GET /api/adsbfi/hex/:hex — enrich by ICAO hex
app.get('/api/adsbfi/hex/:hex', async (req, res) => {
  const t0 = Date.now()
  try {
    const hex = req.params.hex.trim().toLowerCase()
    const resp = await axios.get(`https://opendata.adsb.fi/api/v2/hex/${hex}`, { timeout: 10000 })
    recordServiceOk('adsbfi', Date.now() - t0)
    res.json(resp.data)
  } catch (err) {
    recordServiceError('adsbfi', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
})

// GET /api/adsbfi/callsign/:cs — enrich by callsign
app.get('/api/adsbfi/callsign/:cs', async (req, res) => {
  const t0 = Date.now()
  try {
    const cs = req.params.cs.trim()
    const resp = await axios.get(`https://opendata.adsb.fi/api/v2/callsign/${cs}`, { timeout: 10000 })
    recordServiceOk('adsbfi', Date.now() - t0)
    res.json(resp.data)
  } catch (err) {
    recordServiceError('adsbfi', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
})

// ── Aviation Weather proxy (aviationweather.gov, no CORS) ───────────────────

const AWX_BASE = 'https://aviationweather.gov/api/data'

// GET /api/weather/metar?ids=KJFK,KLAX  or  ?bbox=25,-130,50,-60
app.get('/api/weather/metar', async (req, res) => {
  const t0 = Date.now()
  try {
    const params = { format: 'json', ...req.query }
    const resp = await axios.get(`${AWX_BASE}/metar`, { params, timeout: 10000 })
    recordServiceOk('aviationweather', Date.now() - t0)
    res.json(resp.data)
  } catch (err) {
    recordServiceError('aviationweather', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
})

// GET /api/weather/pirep?bbox=25,-130,50,-60&age=2&inten=mod
app.get('/api/weather/pirep', async (req, res) => {
  const t0 = Date.now()
  try {
    const params = { format: 'json', ...req.query }
    const resp = await axios.get(`${AWX_BASE}/pirep`, { params, timeout: 10000 })
    recordServiceOk('aviationweather', Date.now() - t0)
    res.json(resp.data)
  } catch (err) {
    recordServiceError('aviationweather', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
})

// GET /api/weather/sigmet?hazard=conv
app.get('/api/weather/sigmet', async (req, res) => {
  const t0 = Date.now()
  try {
    const params = { format: 'json', ...req.query }
    const resp = await axios.get(`${AWX_BASE}/airsigmet`, { params, timeout: 10000 })
    recordServiceOk('aviationweather', Date.now() - t0)
    res.json(resp.data)
  } catch (err) {
    recordServiceError('aviationweather', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
})

// ── Anomaly routes ──────────────────────────────────────────────────────────

// Record a batch of anomalies (called by frontend after each fetch)
// POST /api/anomalies  { anomalies: [...], region: 'usa' }
app.post('/api/anomalies', (req, res) => {
  const { anomalies, region } = req.body
  if (!anomalies || !Array.isArray(anomalies)) {
    return res.status(400).json({ error: 'anomalies array required' })
  }
  try {
    const recorded = recordAnomalies(anomalies, region)
    res.json({ recorded })
  } catch (err) {
    console.error('anomaly insert error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Resolve anomalies for aircraft no longer flagged
// POST /api/anomalies/resolve  { icaos: ['abc123', ...] }
app.post('/api/anomalies/resolve', (req, res) => {
  const { icaos } = req.body
  if (!icaos || !Array.isArray(icaos)) {
    return res.status(400).json({ error: 'icaos array required' })
  }
  try {
    const resolved = resolveAnomalies(icaos)
    res.json({ resolved })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Recent anomalies
// GET /api/anomalies?limit=50
app.get('/api/anomalies', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  res.json(getRecentAnomalies(limit))
})

// Currently active (unresolved) anomalies
// GET /api/anomalies/active
app.get('/api/anomalies/active', (_req, res) => {
  res.json(getActiveAnomalies())
})

// Anomaly history for a specific aircraft
// GET /api/anomalies/aircraft/:icao?limit=20
app.get('/api/anomalies/aircraft/:icao', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getAnomaliesByIcao(req.params.icao, limit))
})

// Anomaly stats (last 24h)
// GET /api/anomalies/stats
app.get('/api/anomalies/stats', (_req, res) => {
  res.json(getAnomalyStats())
})

// ── API usage tracking routes ───────────────────────────────────────────────

// Today's credit usage for a service
// GET /api/usage/today?service=opensky
app.get('/api/usage/today', (req, res) => {
  const service = req.query.service || 'opensky'
  const db = getTodayCredits(service)

  if (service === 'opensky') {
    // get the most recent rate_remaining header value from our log
    const lastCall = getRecentCalls('opensky', 1)
    const headerRemaining = lastCall[0]?.rate_remaining ?? null
    const daily_limit = 4000
    const db_remaining = daily_limit - db.credits_used

    // prefer the more conservative (lower) value when header is available
    // if header and DB agree within 5%, use header (real-time)
    // if header reports fewer remaining, use header (safer)
    // otherwise use DB
    let remaining = db_remaining
    if (headerRemaining != null) {
      const drift = Math.abs(headerRemaining - db_remaining) / daily_limit
      if (drift < 0.05 || headerRemaining < db_remaining) {
        remaining = headerRemaining
      }
    }

    res.json({
      ...db,
      daily_limit,
      db_remaining,
      header_remaining: headerRemaining,
      remaining,
    })
  } else {
    res.json(db)
  }
})

// Usage summary for a service
// GET /api/usage/summary?service=opensky&since=2026-03-01
app.get('/api/usage/summary', (req, res) => {
  const service = req.query.service || 'opensky'
  res.json(getUsageSummary(service, req.query.since, req.query.until))
})

// Daily usage breakdown
// GET /api/usage/daily?service=opensky&days=30
app.get('/api/usage/daily', (req, res) => {
  const service = req.query.service || 'opensky'
  const days = Math.min(Number(req.query.days) || 30, 365)
  res.json(getDailyUsage(service, days))
})

// Recent API calls log
// GET /api/usage/calls?service=opensky&limit=50
app.get('/api/usage/calls', (req, res) => {
  const service = req.query.service || 'opensky'
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  res.json(getRecentCalls(service, limit))
})

// AeroAPI spend summary (for the records bar)
// Queries FlightAware's real /account/usage as authoritative source, DB as fallback
// GET /api/aero/spend
app.get('/api/aero/spend', async (_req, res) => {
  const dbTotal = getAeroSpendTotal()
  const dbMonth = getAeroSpendMonth()

  let fa = null
  if (process.env.AEROAPI_KEY) {
    try {
      const r = await axios.get(`${AERO_BASE}/account/usage`, { headers: aeroHeaders() })
      fa = r.data
    } catch {}
  }

  // prefer FlightAware's authoritative total_cost, fall back to our DB
  const realSpend = fa?.total_cost ?? dbTotal.total_spend
  const realCalls = fa?.total_calls ?? dbTotal.total_calls

  res.json({
    total_spend: realSpend,
    total_calls: realCalls,
    db_spend: dbTotal.total_spend,
    db_calls: dbTotal.total_calls,
    month_spend: dbMonth.month_spend,
    month_calls: dbMonth.month_calls,
    cap: AERO_CAP,
    cap_remaining: Math.max(0, AERO_CAP - realSpend),
    cap_reached: realSpend >= AERO_CAP,
    source: fa ? 'flightaware' : 'local_db',
  })
})

// ── SPA fallback (after all API routes) ──────────────────────────────────────
if (require('fs').existsSync(STATIC_DIR)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(STATIC_DIR, 'index.html'))
  })
}

// ── start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`flightterm backend running on http://localhost:${PORT}`)
  if (!process.env.AEROAPI_KEY) {
    console.warn('  ⚠  AEROAPI_KEY not set — add it to backend/.env')
  } else {
    console.log('  ✓  AEROAPI_KEY loaded')
  }
  if (!process.env.FAA_CLIENT_ID || !process.env.FAA_CLIENT_SECRET) {
    console.warn('  ⚠  FAA_CLIENT_ID / FAA_CLIENT_SECRET not set — NOTAMs disabled')
  } else {
    console.log('  ✓  FAA NOTAM credentials loaded')
  }

  // Heavy maintenance (dedup, vacuum, purge) — runs after server is listening
  runDeferredMaintenance()
})
