require('dotenv').config()
const express = require('express')
const axios = require('axios')
const cors = require('cors')
const {
  db: rawDb,
  recordSightings, getAircraftHistory, getAircraftTrack, getUniqueSeen,
  getStats, getTopAircraft, getTopCountries,
  getHourlyActivity, getRecentFetches, getDbSize,
  calcOpenSkyCredits, recordApiCall,
  getUsageSummary, getTodayCredits, getDailyUsage, getRecentCalls,
  getAeroSpendTotal, getAeroSpendMonth,
  getRecentAnomalies, getActiveAnomalies, getAnomaliesByIcao, getAnomalyStats, getAnomalyHotspots, getAnomaliesByZone,
  setAnomalyFeedback, getFeedbackStats,
  getTrafficHeatmap,
  runDeferredMaintenance,
  getRoutesBulk,
  upsertRoutesBatch,
  getRouteCount,
  close: closeDb,
} = require('./db')
const { getStatus: getS3Status, isEnabled: s3IsEnabled } = require('./s3archive')
const rateLimit = require('express-rate-limit')

const path = require('path')
const poller = require('./poller')
const swim = require('./swim')
const app = express()
const PORT = process.env.PORT || 3001
const AERO_BASE = 'https://aeroapi.flightaware.com/aeroapi'
const AERO_CAP = 5.00 // hard cap in USD — do not change
const OS_BASE   = 'https://opensky-network.org/api'
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const FAA_NOTAM_BASE = 'https://external-api.faa.gov/notamapi/v1/notams'

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : '*'
app.use(cors({ origin: corsOrigin }))
app.use(express.json({ limit: '10mb' }))

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Configurable via .env — defaults are sane for single-user / small-team use
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS) || 60_000       // 1 minute
const RATE_MAX       = Number(process.env.RATE_MAX)       || 100          // requests per window
const SSE_MAX_PER_IP = Number(process.env.SSE_MAX_PER_IP) || 5            // concurrent SSE connections
const SSE_TIMEOUT_MS = Number(process.env.SSE_TIMEOUT_MS) || 5 * 60_000   // 5 minutes
const POST_MAX_ITEMS = Number(process.env.POST_MAX_ITEMS) || 2000         // max array items per POST

app.use('/api/', rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded — try again shortly' },
}))

// ── Cache control (default-deny) ─────────────────────────────────────────────
// Every API response defaults to no-store. Individual routes opt in below.
app.use('/api/', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

function cachePublic(res, maxAge) {
  res.set('Cache-Control', `public, max-age=${maxAge}`)
}

function cachePrivate(res, maxAge) {
  res.set('Cache-Control', `private, max-age=${maxAge}`)
}

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
  // Hashed assets (JS/CSS): cache aggressively — filename changes on rebuild
  app.use('/assets', express.static(path.join(STATIC_DIR, 'assets'), {
    maxAge: '1y',
    immutable: true,
  }))
  // Everything else (index.html): always revalidate to pick up new deploys
  app.use(express.static(STATIC_DIR, {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.set('Cache-Control', 'no-cache')
      }
    },
  }))
  console.log(`serving frontend from ${STATIC_DIR}`)
}

// ── routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  cachePublic(res, 10)
  const ps = poller.getStatus()
  res.json({
    status: 'ok',
    aeroapi_configured: !!process.env.AEROAPI_KEY,
    opensky_configured: !!(process.env.OS_CLIENT_ID && process.env.OS_CLIENT_SECRET),
    faa_notam_configured: !!(process.env.FAA_CLIENT_ID && process.env.FAA_CLIENT_SECRET),
    poller_running: ps.running,
    poller_region: ps.region,
    poller_aircraft: ps.trackedAircraft,
    s3_archive: getS3Status(),
    db_size: getDbSize(),
    timestamp: new Date().toISOString()
  })
})

// Liveness — is the process alive and able to serve HTTP? Always returns 200
// unless the event loop is completely frozen (in which case it won't respond).
// Fly.io uses this to decide whether to restart the machine.
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok' })
})

// Readiness — is the service ready to handle real traffic?
// Checks DB connectivity and (if enabled) that the poller has fetched at least once.
app.get('/api/health/ready', (_req, res) => {
  const checks = {}
  // DB: can we execute a trivial query?
  try {
    rawDb.prepare('SELECT 1').get()
    checks.db = 'ok'
  } catch {
    checks.db = 'fail'
  }
  // Poller: if enabled, has it completed at least one cycle?
  if (process.env.POLLER_ENABLED === 'true') {
    const ps = poller.getStatus()
    checks.poller = ps.running && ps.trackedAircraft > 0 ? 'ok' : 'waiting'
  }
  const ready = checks.db === 'ok' && (!checks.poller || checks.poller === 'ok')
  res.status(ready ? 200 : 503).json({ ready, checks })
})

// ── Service health + circuit breaker ─────────────────────────────────────────
// Passive tracking from real traffic. Circuit breaker trips after consecutive
// failures and reopens after a cooldown period.
const CB_FAIL_THRESHOLD = 3            // consecutive failures before tripping
const CB_COOLDOWN_MS    = 30_000       // 30s cooldown before retrying

const _serviceHealth = {
  opensky:         { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null, failures: 0, openAt: null },
  adsbfi:          { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null, failures: 0, openAt: null },
  aviationweather: { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null, failures: 0, openAt: null },
  aeroapi:         { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null, failures: 0, openAt: null },
  faa_notam:       { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null, failures: 0, openAt: null },
  airplaneslive:   { status: 'unknown', lastOk: null, lastError: null, lastLatency: null, error: null, failures: 0, openAt: null },
  // adsbdb + hexdb are called directly from the browser (CORS-enabled), not proxied
}

function recordServiceOk(name, latency) {
  const svc = _serviceHealth[name]
  if (!svc) return
  svc.status = 'ok'
  svc.lastOk = Date.now()
  svc.lastLatency = latency
  svc.error = null
  svc.failures = 0
  svc.openAt = null
}

function recordServiceError(name, latency, error) {
  const svc = _serviceHealth[name]
  if (!svc) return
  svc.status = 'error'
  svc.lastError = Date.now()
  svc.lastLatency = latency
  svc.error = (error || '').substring(0, 120)
  svc.failures++
  if (svc.failures >= CB_FAIL_THRESHOLD) {
    svc.openAt = Date.now() + CB_COOLDOWN_MS
    console.warn(`circuit-breaker: ${name} tripped after ${svc.failures} failures, cooldown ${CB_COOLDOWN_MS / 1000}s`)
  }
}

// Returns true if the service is available (circuit closed or cooldown expired)
function serviceAvailable(name) {
  const svc = _serviceHealth[name]
  if (!svc || !svc.openAt) return true
  if (Date.now() >= svc.openAt) {
    // Cooldown expired — allow one request through (half-open)
    svc.openAt = null
    return true
  }
  return false
}

// Mark unconfigured services
if (!process.env.AEROAPI_KEY) _serviceHealth.aeroapi.status = 'unconfigured'
if (!process.env.FAA_CLIENT_ID) _serviceHealth.faa_notam.status = 'unconfigured'

// GET /api/health/services — returns passive health derived from real traffic
app.get('/api/health/services', (_req, res) => {
  cachePublic(res, 15)
  const services = Object.entries(_serviceHealth).map(([name, svc]) => ({
    name,
    status: svc.status,
    latency: svc.lastLatency,
    lastOk: svc.lastOk ? new Date(svc.lastOk).toISOString() : null,
    lastError: svc.lastError ? new Date(svc.lastError).toISOString() : null,
    error: svc.error,
    circuitBreaker: svc.failures >= CB_FAIL_THRESHOLD ? 'open' : 'closed',
    consecutiveFailures: svc.failures,
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
  cachePublic(res, 60)
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
  cachePublic(res, 86400)
  res.json(COST_MAP)
})

// OpenSky states proxy — holds OAuth2 token server-side
// User can override credentials via x-user-os-id / x-user-os-secret headers
// GET /api/opensky/states?region=europe  (bbox params forwarded)
app.get('/api/opensky/states', async (req, res) => {
  res.set('Vary', 'x-user-os-id, x-user-os-secret')
  if (!serviceAvailable('opensky')) {
    return res.status(503).json({ error: 'opensky temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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
  res.set('Vary', 'x-user-aero-key')
  if (!serviceAvailable('aeroapi')) {
    return res.status(503).json({ error: 'aeroapi temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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
  cachePublic(res, 300)
  if (!serviceAvailable('faa_notam')) {
    return res.status(503).json({ error: 'FAA NOTAM API temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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

// ── Input validation helpers ────────────────────────────────────────────────
function isValidIcao(v)     { return typeof v === 'string' && v.length >= 4 && v.length <= 6 }
function isValidLat(v)      { return v == null || (typeof v === 'number' && v >= -90  && v <= 90) }
function isValidLon(v)      { return v == null || (typeof v === 'number' && v >= -180 && v <= 180) }
function isValidAlt(v)      { return v == null || (typeof v === 'number' && v >= -2000 && v <= 100000) }
function isValidStr(v, max) { return v == null || (typeof v === 'string' && v.length <= max) }

function validateFlight(f) {
  if (!f || typeof f !== 'object') return 'not an object'
  if (!isValidIcao(f.icao))        return 'invalid icao'
  if (!isValidLat(f.lat))          return 'lat out of range'
  if (!isValidLon(f.lon))          return 'lon out of range'
  if (!isValidAlt(f.alt))          return 'alt out of range'
  if (!isValidStr(f.callsign, 10)) return 'callsign too long'
  if (!isValidStr(f.country, 50))  return 'country too long'
  if (!isValidStr(f.squawk, 4))    return 'squawk too long'
  return null
}

function validateRoute(r) {
  if (!r || typeof r !== 'object')         return 'not an object'
  if (!isValidStr(r.callsign, 10))         return 'callsign too long'
  if (!isValidStr(r.origin_icao, 4))       return 'origin_icao invalid'
  if (!isValidStr(r.destination_icao, 4))  return 'destination_icao invalid'
  if (!isValidLat(r.origin_lat))           return 'origin_lat out of range'
  if (!isValidLon(r.origin_lon))           return 'origin_lon out of range'
  if (!isValidLat(r.destination_lat))      return 'destination_lat out of range'
  if (!isValidLon(r.destination_lon))      return 'destination_lon out of range'
  return null
}

// ── Sightings DB routes ─────────────────────────────────────────────────────

// Record a batch of sightings (called by frontend after each fetch)
// POST /api/sightings  { flights: [...], source: 'opensky', region: 'usa' }
app.post('/api/sightings', (req, res) => {
  const { flights, source, region } = req.body
  if (!flights || !Array.isArray(flights)) {
    return res.status(400).json({ error: 'flights array required' })
  }
  if (flights.length > POST_MAX_ITEMS) {
    return res.status(400).json({ error: `max ${POST_MAX_ITEMS} items per request` })
  }
  // Validate individual flight objects
  for (let i = 0; i < flights.length; i++) {
    const err = validateFlight(flights[i])
    if (err) return res.status(400).json({ error: `flights[${i}]: ${err}` })
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
  cachePublic(res, 30)
  const limit = Math.min(Number(req.query.limit) || 100, 1000)
  res.json(getAircraftHistory(req.params.icao, limit))
})

// Aircraft track — lightweight alt/vel/hdg history for sparkline charts
// GET /api/sightings/track/:icao?limit=60
app.get('/api/sightings/track/:icao', (req, res) => {
  cachePublic(res, 15)
  const limit = Math.min(Number(req.query.limit) || 60, 200)
  res.json(getAircraftTrack(req.params.icao, limit))
})

// Unique aircraft seen in a time range
// GET /api/sightings/unique?since=2026-03-01&until=2026-03-22
app.get('/api/sightings/unique', (req, res) => {
  cachePublic(res, 60)
  res.json(getUniqueSeen(req.query.since, req.query.until))
})

// Aggregate stats
// GET /api/sightings/stats
app.get('/api/sightings/stats', (_req, res) => {
  cachePublic(res, 30)
  res.json(getStats())
})

// Top aircraft by frequency
// GET /api/sightings/top/aircraft?limit=20
app.get('/api/sightings/top/aircraft', (req, res) => {
  cachePublic(res, 60)
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getTopAircraft(limit))
})

// Top countries
// GET /api/sightings/top/countries?limit=20
app.get('/api/sightings/top/countries', (req, res) => {
  cachePublic(res, 60)
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getTopCountries(limit))
})

// Hourly activity pattern
// GET /api/sightings/activity/hourly
app.get('/api/sightings/activity/hourly', (_req, res) => {
  cachePublic(res, 60)
  res.json(getHourlyActivity())
})

// Recent fetch history
// GET /api/sightings/fetches?limit=20
app.get('/api/sightings/fetches', (req, res) => {
  cachePublic(res, 15)
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getRecentFetches(limit))
})

// Traffic heatmap — latest position per aircraft from last hour
// GET /api/sightings/heatmap
app.get('/api/sightings/heatmap', (_req, res) => {
  cachePublic(res, 30)
  res.json(getTrafficHeatmap())
})

// ── Route cache endpoints ───────────────────────────────────────────────────

// POST /api/routes/lookup  { callsigns: ['UAL123', 'DAL456'] }
// Returns cached routes for the given callsigns + list of unknown ones
app.post('/api/routes/lookup', (req, res) => {
  const { callsigns } = req.body
  if (!callsigns || !Array.isArray(callsigns)) {
    return res.status(400).json({ error: 'callsigns array required' })
  }
  try {
    const routes = getRoutesBulk(callsigns)
    const unknown = callsigns.filter(cs => !routes[cs])

    res.json({ routes, unknown, cached: Object.keys(routes).length, total: getRouteCount() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/routes/save  { routes: [{ callsign, origin_icao, origin_lat, ... }] }
// Batch upsert routes into cache
app.post('/api/routes/save', (req, res) => {
  const { routes } = req.body
  if (!routes || !Array.isArray(routes)) {
    return res.status(400).json({ error: 'routes array required' })
  }
  if (routes.length > POST_MAX_ITEMS) {
    return res.status(400).json({ error: `max ${POST_MAX_ITEMS} items per request` })
  }
  // Validate individual route objects
  for (let i = 0; i < routes.length; i++) {
    const err = validateRoute(routes[i])
    if (err) return res.status(400).json({ error: `routes[${i}]: ${err}` })
  }
  try {
    upsertRoutesBatch(routes)
    console.log(`routes: cached ${routes.length} new route(s) (total: ${getRouteCount()})`)
    res.json({ saved: routes.length, total: getRouteCount() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/routes/stats
app.get('/api/routes/stats', (_req, res) => {
  cachePublic(res, 60)
  res.json({ total: getRouteCount() })
})

// ── airplanes.live proxy (rate limited, service health tracked) ──────────────

const APL_BASE = 'https://api.airplanes.live/v2'
let _aplLastReq = 0  // timestamp of last request — enforce 1 req/sec server-side

async function aplFetch(path, res) {
  cachePrivate(res, 5)
  if (!serviceAvailable('airplaneslive')) {
    return res.status(503).json({ error: 'airplanes.live temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
  // Server-side rate limiting: wait if needed to respect 1 req/sec
  const now = Date.now()
  const wait = Math.max(0, 1050 - (now - _aplLastReq))
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _aplLastReq = Date.now()

  const t0 = Date.now()
  try {
    const resp = await axios.get(`${APL_BASE}${path}`, { timeout: 10000 })
    recordServiceOk('airplaneslive', Date.now() - t0)
    res.json(resp.data)
  } catch (err) {
    recordServiceError('airplaneslive', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
}

// GET /api/apl/point?lat=37&lon=-122&radius=250
app.get('/api/apl/point', (req, res) => {
  const { lat, lon, radius } = req.query
  aplFetch(`/point/${lat}/${lon}/${Math.min(radius || 250, 250)}`, res)
})

// GET /api/apl/hex?hex=a12345
app.get('/api/apl/hex', (req, res) => {
  aplFetch(`/hex/${(req.query.hex || '').trim().toLowerCase()}`, res)
})

// GET /api/apl/squawk?code=7700
app.get('/api/apl/squawk', (req, res) => {
  aplFetch(`/squawk/${req.query.code || '7700'}`, res)
})

// GET /api/apl/mil
app.get('/api/apl/mil', (_req, res) => {
  aplFetch('/mil', res)
})

// ── adsb.fi proxy (CORS bypass) ─────────────────────────────────────────────

// GET /api/adsbfi/hex/:hex — enrich by ICAO hex
app.get('/api/adsbfi/hex/:hex', async (req, res) => {
  cachePrivate(res, 5)
  if (!serviceAvailable('adsbfi')) {
    return res.status(503).json({ error: 'adsb.fi temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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
  cachePrivate(res, 5)
  if (!serviceAvailable('adsbfi')) {
    return res.status(503).json({ error: 'adsb.fi temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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

// GET /api/hexdb/route/:callsign — proxy hexdb.io route lookup (no CORS from browser)
app.get('/api/hexdb/route/:callsign', async (req, res) => {
  const cs = req.params.callsign.trim().replace(/\s+/g, '')
  if (!cs) return res.status(400).json({ error: 'missing callsign' })
  cachePublic(res, 3600)
  try {
    const routeRes = await axios.get(`https://hexdb.io/api/v1/route/icao/${cs}`, { timeout: 8000 })
    const routeStr = routeRes.data
    if (!routeStr || typeof routeStr !== 'string' || !routeStr.includes('-')) {
      return res.json({ route: null })
    }
    const [originIcao, destIcao] = routeStr.split('-').map(s => s.trim())
    // Fetch airport details in parallel
    const [originRes, destRes] = await Promise.allSettled([
      axios.get(`https://hexdb.io/api/v1/airport/icao/${originIcao}`, { timeout: 8000 }),
      axios.get(`https://hexdb.io/api/v1/airport/icao/${destIcao}`, { timeout: 8000 }),
    ])
    const parseAirport = (r, icao) => {
      if (r.status !== 'fulfilled' || !r.value?.data) return { icao }
      const d = r.value.data
      return { icao, iata: d.iata || null, name: d.airport || null, lat: d.latitude != null ? parseFloat(d.latitude) : null, lon: d.longitude != null ? parseFloat(d.longitude) : null, municipality: d.municipality || null, country: d.country || null }
    }
    res.json({ route: { origin: parseAirport(originRes, originIcao), destination: parseAirport(destRes, destIcao), source: 'hexdb' } })
  } catch (err) {
    if (err.response?.status === 404) return res.json({ route: null })
    res.status(502).json({ error: err.message })
  }
})

// ── Aviation Weather proxy (aviationweather.gov, no CORS) ───────────────────

const AWX_BASE = 'https://aviationweather.gov/api/data'

// GET /api/weather/metar?ids=KJFK,KLAX  or  ?bbox=25,-130,50,-60
app.get('/api/weather/metar', async (req, res) => {
  cachePublic(res, 120)
  if (!serviceAvailable('aviationweather')) {
    return res.status(503).json({ error: 'aviationweather temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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
  cachePublic(res, 120)
  if (!serviceAvailable('aviationweather')) {
    return res.status(503).json({ error: 'aviationweather temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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
  cachePublic(res, 120)
  if (!serviceAvailable('aviationweather')) {
    return res.status(503).json({ error: 'aviationweather temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
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

// ── Poller status & SSE stream ───────────────────────────────────────────────

// GET /api/poller/status — current poller state
app.get('/api/poller/status', (_req, res) => {
  cachePublic(res, 10)
  res.json(poller.getStatus())
})

// Admin auth middleware — requires ADMIN_SECRET env var
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET
  if (!secret) return res.status(403).json({ error: 'admin access not configured' })
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// POST /api/poller/start — start the polling service (admin only)
app.post('/api/poller/start', requireAdmin, (_req, res) => {
  poller.start()
  res.json(poller.getStatus())
})

// POST /api/poller/stop — stop the polling service (admin only)
app.post('/api/poller/stop', requireAdmin, (_req, res) => {
  poller.stop()
  res.json(poller.getStatus())
})

// GET /api/flights — latest flight states from poller (no external API call)
app.get('/api/flights', (_req, res) => {
  const data = poller.getFlights()
  if (!data.flights.length) {
    return res.json({ flights: [], fetchedAt: null, region: data.region, count: 0 })
  }
  res.json(data)
})

// GET /api/anomalies/stream — SSE endpoint for real-time anomaly events
const _sseConns = new Map() // ip → count

function sseIncrement(ip) {
  const current = _sseConns.get(ip) || 0
  if (current >= SSE_MAX_PER_IP) return false
  _sseConns.set(ip, current + 1)
  return true
}

function sseDecrement(ip) {
  const current = _sseConns.get(ip) || 1
  if (current <= 1) _sseConns.delete(ip)
  else _sseConns.set(ip, current - 1)
}

app.get('/api/anomalies/stream', (req, res) => {
  const ip = req.ip
  if (!sseIncrement(ip)) {
    return res.status(429).json({ error: 'too many SSE connections' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })

  const onNew = (anomaly) => {
    res.write(`event: anomaly\ndata: ${JSON.stringify(anomaly)}\n\n`)
  }
  const onCritical = (anomaly) => {
    res.write(`event: critical\ndata: ${JSON.stringify(anomaly)}\n\n`)
  }
  const onResolved = (icaos) => {
    res.write(`event: resolved\ndata: ${JSON.stringify(icaos)}\n\n`)
  }

  poller.anomalyEvents.on('anomaly:new', onNew)
  poller.anomalyEvents.on('anomaly:critical', onCritical)
  poller.anomalyEvents.on('anomaly:resolved', onResolved)

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 30000)

  // Auto-close after timeout
  const timeout = setTimeout(() => {
    res.end()
  }, SSE_TIMEOUT_MS)

  let cleaned = false
  function cleanup() {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeat)
    clearTimeout(timeout)
    sseDecrement(ip)
    poller.anomalyEvents.off('anomaly:new', onNew)
    poller.anomalyEvents.off('anomaly:critical', onCritical)
    poller.anomalyEvents.off('anomaly:resolved', onResolved)
  }

  req.on('close', cleanup)
  res.on('error', cleanup)
})

// ── Anomaly routes ──────────────────────────────────────────────────────────

// POST /api/anomalies and POST /api/anomalies/resolve removed —
// anomaly creation and resolution are now handled by the backend poller.

// Recent anomalies
// GET /api/anomalies?limit=50
app.get('/api/anomalies', (req, res) => {
  cachePublic(res, 15)
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
  cachePublic(res, 30)
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(getAnomaliesByIcao(req.params.icao, limit))
})

// Anomaly stats (last 24h)
// GET /api/anomalies/stats
app.get('/api/anomalies/stats', (_req, res) => {
  cachePublic(res, 30)
  res.json(getAnomalyStats())
})

// Anomaly hotspots — geographic clusters where anomalies recur
// GET /api/anomalies/hotspots?hours=168&min=2
app.get('/api/anomalies/hotspots', (req, res) => {
  cachePublic(res, 120)
  const hours = Math.min(Number(req.query.hours) || 168, 720) // default 7 days, max 30
  const min = Math.max(Number(req.query.min) || 2, 2) // minimum 2 events per cluster
  res.json(getAnomalyHotspots(hours, min))
})

// Anomalies in a specific zone (grid cell) for zone drilldown
// GET /api/anomalies/zone?lat=40.5&lon=-74.0&hours=168&limit=30
app.get('/api/anomalies/zone', (req, res) => {
  cachePublic(res, 60)
  const lat = Number(req.query.lat)
  const lon = Number(req.query.lon)
  if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon required' })
  const cellLat = Math.round(lat * 2) / 2
  const cellLon = Math.round(lon * 2) / 2
  const hours = Math.min(Number(req.query.hours) || 168, 720)
  const limit = Math.min(Number(req.query.limit) || 30, 100)
  res.json(getAnomaliesByZone(cellLat, cellLon, hours, limit))
})

// Anomaly feedback — mark as false positive or confirmed real
// PUT /api/anomalies/:id/feedback
app.put('/api/anomalies/:id/feedback', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' })
  const { feedback, note } = req.body || {}
  if (!['false_positive', 'confirmed_real'].includes(feedback)) {
    return res.status(400).json({ error: 'feedback must be "false_positive" or "confirmed_real"' })
  }
  try {
    const result = setAnomalyFeedback(id, feedback, note || null)
    res.json({ ok: true, changes: result.changes })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Feedback stats — false positive rate over last 7 days
// GET /api/anomalies/feedback/stats
app.get('/api/anomalies/feedback/stats', (_req, res) => {
  cachePublic(res, 120)
  res.json(getFeedbackStats())
})

// SWIM feed status
// GET /api/swim/status
app.get('/api/swim/status', (_req, res) => {
  cachePublic(res, 15)
  res.json(swim.getStatus())
})

// Active TFRs from SWIM FNS
// GET /api/swim/tfrs
app.get('/api/swim/tfrs', (_req, res) => {
  cachePublic(res, 60)
  try {
    const { getActiveTfrs } = require('./db')
    res.json(getActiveTfrs())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// NOTAMs grouped by airport
// GET /api/swim/notams/airports?limit=20
app.get('/api/swim/notams/airports', (req, res) => {
  cachePublic(res, 60)
  try {
    const { getNotamsByAirport } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 20, 50)
    res.json(getNotamsByAirport(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Recent NOTAM activity feed
// GET /api/swim/notams/recent?limit=15
app.get('/api/swim/notams/recent', (req, res) => {
  cachePublic(res, 60)
  try {
    const { getRecentNotams } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 15, 50)
    res.json(getRecentNotams(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TFMS — active flight plans
// GET /api/swim/flights?limit=50
app.get('/api/swim/flights', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getActiveFlightPlans } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    res.json(getActiveFlightPlans(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TFMS — single flight plan by callsign
// GET /api/swim/flights/:acid
app.get('/api/swim/flights/:acid', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getFlightPlan } = require('./db')
    const plan = getFlightPlan(req.params.acid.toUpperCase())
    if (!plan) return res.status(404).json({ error: 'not found' })
    res.json(plan)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TFMS — active flow events (GDPs, ground stops, reroutes)
// GET /api/swim/flow?limit=20
app.get('/api/swim/flow', (req, res) => {
  cachePublic(res, 30)
  try {
    const { getActiveFlowEvents } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    res.json(getActiveFlowEvents(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TFMS — flow events for a specific airport
// GET /api/swim/flow/:airport
app.get('/api/swim/flow/:airport', (req, res) => {
  cachePublic(res, 30)
  try {
    const { getFlowEventsByAirport } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    res.json(getFlowEventsByAirport(req.params.airport.toUpperCase(), limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ITWS — recent terminal weather events
// GET /api/swim/weather?limit=20
app.get('/api/swim/weather', (req, res) => {
  cachePublic(res, 60)
  try {
    const { getRecentTerminalWeather } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    res.json(getRecentTerminalWeather(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ITWS — terminal weather for specific airport
// GET /api/swim/weather/:airport
app.get('/api/swim/weather/:airport', (req, res) => {
  cachePublic(res, 60)
  try {
    const { getTerminalWeatherByAirport } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    res.json(getTerminalWeatherByAirport(req.params.airport.toUpperCase(), limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// STDDS — recent surface events (OOOI, taxi, departures, RVR)
// GET /api/swim/surface?limit=30
app.get('/api/swim/surface', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getRecentSurfaceEvents } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    res.json(getRecentSurfaceEvents(limit))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// STDDS — OOOI events (gate out, wheels off, wheels on, gate in)
// GET /api/swim/oooi?limit=30
app.get('/api/swim/oooi', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getOooi } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    res.json(getOooi(limit))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// STDDS — surface events by airport
// GET /api/swim/surface/:airport
app.get('/api/swim/surface/:airport', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getSurfaceEventsByAirport } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    res.json(getSurfaceEventsByAirport(req.params.airport.toUpperCase(), limit))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// TFMS — real-time airport configurations (runways, rates, weather)
// GET /api/swim/airports
app.get('/api/swim/airports', (_req, res) => {
  cachePublic(res, 30)
  try {
    const { getAirportConfigs } = require('./db')
    res.json(getAirportConfigs())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Database metrics
// GET /api/db/metrics
app.get('/api/db/metrics', (_req, res) => {
  cachePublic(res, 30)
  const sightings = rawDb.prepare('SELECT COUNT(*) as c FROM sightings').get().c
  const daily = rawDb.prepare('SELECT COUNT(*) as c FROM sightings_daily').get().c
  const anomalies = rawDb.prepare('SELECT COUNT(*) as c FROM anomalies WHERE resolved = 0').get().c
  const anomaliesTotal = rawDb.prepare('SELECT COUNT(*) as c FROM anomalies').get().c
  const routes = getRouteCount()
  const fetches = rawDb.prepare('SELECT COUNT(*) as c FROM fetches').get().c
  const sizeMb = +(getDbSize() / 1048576).toFixed(2)
  res.json({ sightings, daily, anomalies_active: anomalies, anomalies_total: anomaliesTotal, routes, fetches, size_mb: sizeMb })
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
    const keyCount = poller.getActiveKeyCount() // 1 or 2 keys configured
    const daily_limit = 4000 * keyCount
    const db_remaining = daily_limit - db.credits_used

    // prefer the more conservative (lower) value when header is available
    // header reflects a single key's remaining credits — combine with DB for total
    let remaining = db_remaining
    if (headerRemaining != null) {
      // header is for the currently active key only
      // estimate total: header remaining + unused keys' full allotment
      // but DB tracks all calls regardless of key, so use DB as primary
      const drift = Math.abs(headerRemaining - (4000 - db.credits_used)) / 4000
      if (drift < 0.05 || headerRemaining < (4000 - db.credits_used)) {
        // single-key: use header. dual-key: header + second key's full 4000
        remaining = headerRemaining + (keyCount > 1 && headerRemaining < 100 ? 0 : (keyCount - 1) * 4000)
      }
    }

    // clamp to [0, daily_limit]
    remaining = Math.max(0, Math.min(daily_limit, remaining))

    res.json({
      ...db,
      daily_limit,
      key_count: keyCount,
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

  // If no key is configured, report zero spend — stale DB records from
  // another machine / key shouldn't block usage or mislead the UI.
  if (!process.env.AEROAPI_KEY) {
    return res.json({
      total_spend: 0, total_calls: 0,
      db_spend: 0, db_calls: 0,
      month_spend: 0, month_calls: 0,
      cap: AERO_CAP, cap_remaining: AERO_CAP, cap_reached: false,
      source: 'unconfigured',
    })
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

// ── Centralized error handler (catches unhandled route errors) ───────────────
app.use((err, _req, res, _next) => {
  console.error('unhandled route error:', err.stack || err.message)
  res.status(err.status || 500).json({ error: err.message || 'internal server error' })
})

// Skip listening when imported by vitest (tests use supertest directly)
let _server = null
if (!process.env.VITEST) _server = app.listen(PORT, () => {
  console.log(`\n═══ flightterm backend ═══════════════════════════════════════`)
  console.log(`  port:           ${PORT}`)
  console.log(`  node:           ${process.version}`)
  console.log(`  env:            ${process.env.NODE_ENV || 'development'}`)
  console.log(``)
  console.log(`  ── data sources ──`)
  console.log(`  AEROAPI_KEY:    ${process.env.AEROAPI_KEY ? '✓ set' : '✗ not set'}`)
  console.log(`  OS_CLIENT_ID:   ${process.env.OS_CLIENT_ID ? '✓ set' : '✗ not set'}`)
  console.log(`  OS_CLIENT_ID_2: ${process.env.OS_CLIENT_ID_2 ? '✓ set' : '✗ not set'}`)
  console.log(`  FAA_CLIENT_ID:  ${process.env.FAA_CLIENT_ID ? '✓ set' : '✗ not set'}`)
  console.log(``)
  console.log(`  ── s3 archive ──`)
  console.log(`  S3_BUCKET:      ${process.env.S3_BUCKET || '✗ not set'}`)
  console.log(`  AWS_ACCESS_KEY: ${process.env.AWS_ACCESS_KEY_ID ? '✓ set' : '✗ not set'}`)
  console.log(``)
  console.log(`  ── poller ──`)
  console.log(`  POLLER_ENABLED: ${process.env.POLLER_ENABLED || 'false'}`)
  console.log(`  POLL_INTERVAL:  ${process.env.POLL_INTERVAL || '45000'}ms`)
  console.log(`  POLL_REGION:    ${process.env.POLL_REGION || 'usa'}`)
  console.log(``)
  console.log(`  ── swim feeds ──`)
  console.log(`  SWIM_USERNAME:   ${process.env.SWIM_USERNAME ? '✓ set' : '✗ not set'}`)
  console.log(`  SWIM_PASSWORD:   ${process.env.SWIM_PASSWORD ? '✓ set' : '✗ not set'}`)
  console.log(`  SWIM_FNS_QUEUE:   ${process.env.SWIM_FNS_QUEUE ? '✓ FNS (NOTAMs)' : '✗ not set'}`)
  console.log(`  SWIM_TFMS_QUEUE:  ${process.env.SWIM_TFMS_QUEUE ? '✓ TFMS (flight plans)' : '✗ not set'}`)
  console.log(`  SWIM_SFDPS_QUEUE: ${process.env.SWIM_SFDPS_QUEUE ? '✓ SFDPS (en route)' : '✗ not set'}`)
  console.log(`  SWIM_ITWS_QUEUE:  ${process.env.SWIM_ITWS_QUEUE ? '✓ ITWS (weather)' : '✗ not set'}`)
  console.log(`  SWIM_STDDS_QUEUE: ${process.env.SWIM_STDDS_QUEUE ? '✓ STDDS (surface)' : '✗ not set'}`)
  console.log(``)
  console.log(`  ── security ──`)
  console.log(`  ADMIN_SECRET:   ${process.env.ADMIN_SECRET ? '✓ set' : '✗ not set'}`)
  console.log(`  CORS_ORIGIN:    ${process.env.CORS_ORIGIN || '*'}`)
  console.log(`  RATE_LIMIT:     ${RATE_MAX} req/${RATE_WINDOW_MS / 1000}s`)
  console.log(``)
  console.log(`  ── database ──`)
  const _sightings = rawDb.prepare('SELECT COUNT(*) as c FROM sightings').get().c
  const _anomalies = rawDb.prepare('SELECT COUNT(*) as c FROM anomalies').get().c
  const _routes = getRouteCount()
  const _sizeMb = (getDbSize() / 1048576).toFixed(1)
  console.log(`  sightings:      ${_sightings.toLocaleString()}`)
  console.log(`  anomalies:      ${_anomalies.toLocaleString()}`)
  console.log(`  routes:         ${_routes.toLocaleString()}`)
  console.log(`  size:           ${_sizeMb} MB`)
  console.log(`═════════════════════════════════════════════════════════════\n`)

  // Heavy maintenance (dedup, vacuum, purge) — runs after server is listening
  runDeferredMaintenance()

  // Start anomaly poller if enabled via env
  if (process.env.POLLER_ENABLED === 'true') {
    poller.start()
  } else {
    console.log('  ℹ  Anomaly poller disabled — set POLLER_ENABLED=true to enable')
  }

  // Start SWIM feed consumers if configured
  if (process.env.SWIM_USERNAME && process.env.SWIM_PASSWORD) {
    swim.startAll().catch(err => console.error('swim: startup error:', err.message))
  } else {
    console.log('  ℹ  SWIM feeds disabled — set SWIM_USERNAME + SWIM_PASSWORD to enable')
  }
})

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`)

  // Stop accepting new requests
  poller.stop()
  swim.stopAll()

  if (_server) {
    _server.close(() => {
      console.log('http server closed')
      closeDb()
      process.exit(0)
    })
  } else {
    closeDb()
    process.exit(0)
  }

  // Force exit after 30s if connections don't drain
  setTimeout(() => {
    console.error('forced shutdown after 30s timeout')
    process.exit(1)
  }, 30_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

module.exports = { app }
