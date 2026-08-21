const path = require('path')
require('dotenv').config({
  path: [path.join(__dirname, '.env'), path.join(__dirname, 'env')],
  quiet: true,
})
const express = require('express')
const axios = require('axios')
const cors = require('cors')
const helmet = require('helmet')
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

const poller = require('./poller')
const businessJetTracker = require('./businessJetTracker')
const swim = require('./swim')
const app = express()
app.disable('x-powered-by')
// Fly Proxy terminates TLS and supplies the client address in X-Forwarded-For.
// Trust exactly that first proxy hop so express-rate-limit keys real clients
// without emitting ERR_ERL_UNEXPECTED_X_FORWARDED_FOR in production.
app.set('trust proxy', 1)
const PORT = process.env.PORT || 3001
const AERO_BASE = 'https://aeroapi.flightaware.com/aeroapi'
const AERO_CAP = 5.00 // hard cap in USD — do not change
const OS_BASE   = 'https://opensky-network.org/api'
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const FAA_NOTAM_BASE = 'https://external-api.faa.gov/notamapi/v1/notams'

const configuredCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : null
// A deployment must opt in to each browser origin. Local Vite is the only
// fallback; production never widens to every origin when configuration is
// missing.
const corsOrigin = configuredCorsOrigins || (process.env.NODE_ENV === 'production'
  ? false
  : ['http://localhost:5173', 'http://127.0.0.1:5173'])
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", 'https://api.adsbdb.com', 'https://adsbexchange-com1.p.rapidapi.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}))
app.use(cors({ origin: corsOrigin, credentials: false }))
app.use(express.json({ limit: '10mb' }))

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Configurable via .env — defaults are sane for single-user / small-team use
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS) || 60_000       // 1 minute
const RATE_MAX       = Number(process.env.RATE_MAX)       || 100          // requests per window
const SSE_MAX_PER_IP = Number(process.env.SSE_MAX_PER_IP) || 5            // concurrent SSE connections
const SSE_TIMEOUT_MS = Number(process.env.SSE_TIMEOUT_MS) || 5 * 60_000   // 5 minutes
const POST_MAX_ITEMS = Number(process.env.POST_MAX_ITEMS) || 2000         // max array items per POST
const SWIM_WAKE_APP = process.env.SWIM_WAKE_APP || 'flightterm-swim'
const SWIM_WAKE_MACHINE_ID = process.env.SWIM_WAKE_MACHINE_ID || ''
const SWIM_WAKE_TOKEN = process.env.FLY_MACHINES_TOKEN || ''
const SWIM_WAKE_API = (process.env.FLY_MACHINES_API || 'https://api.machines.dev/v1').replace(/\/+$/, '')
const SWIM_WAKE_COOLDOWN_MS = Number(process.env.SWIM_WAKE_COOLDOWN_MS) || 60_000
const SWIM_WAKE_TIMEOUT_MS = Number(process.env.SWIM_WAKE_TIMEOUT_MS) || 10_000
const SWIM_IDLE_TIMEOUT_MS = Number(process.env.SWIM_IDLE_TIMEOUT_MS) || 5 * 60_000
let swimWakeLastAttempt = 0
let swimWakeInFlight = null
let swimLastActivityAt = 0
let swimIdleTimer = null

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

// ── Slow request logger ──────────────────────────────────────────────────────
// Records when a route handler runs sync work that blocks the event loop. We
// already have the perf_hooks monitor flagging when the loop blocks; this
// pinpoints WHICH endpoint caused it. Logs anything over 500ms.
app.use('/api/', (req, res, next) => {
  const t0 = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - t0
    if (ms > 500) {
      console.warn(`slow-req ${ms}ms ${req.method} ${req.originalUrl}`)
    }
  })
  next()
})

function cachePublic(res, maxAge) {
  res.set('Cache-Control', `public, max-age=${maxAge}`)
}

function cachePrivate(res, maxAge) {
  res.set('Cache-Control', `private, max-age=${maxAge}`)
}

const swimWakeLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.SWIM_WAKE_RATE_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'SWIM wake rate limit exceeded' },
})

function swimWakeConfigured() {
  return Boolean(SWIM_WAKE_APP && SWIM_WAKE_MACHINE_ID && SWIM_WAKE_TOKEN)
}

async function getFlySwimMachine() {
  const res = await axios.get(
    `${SWIM_WAKE_API}/apps/${encodeURIComponent(SWIM_WAKE_APP)}/machines/${encodeURIComponent(SWIM_WAKE_MACHINE_ID)}`,
    {
      headers: { Authorization: `Bearer ${SWIM_WAKE_TOKEN}` },
      timeout: SWIM_WAKE_TIMEOUT_MS,
      validateStatus: status => status < 500,
    }
  )
  if (res.status >= 400) {
    throw new Error(`Fly Machines API status ${res.status}`)
  }
  return res.data
}

async function startFlySwimMachine() {
  const res = await axios.post(
    `${SWIM_WAKE_API}/apps/${encodeURIComponent(SWIM_WAKE_APP)}/machines/${encodeURIComponent(SWIM_WAKE_MACHINE_ID)}/start`,
    null,
    {
      headers: { Authorization: `Bearer ${SWIM_WAKE_TOKEN}` },
      timeout: SWIM_WAKE_TIMEOUT_MS,
      validateStatus: status => status < 500,
    }
  )
  if (![200, 202, 204].includes(res.status)) {
    throw new Error(`Fly Machines API start status ${res.status}`)
  }
  return res.data || {}
}

async function wakeSwimWorker() {
  if (!swimWakeInFlight) {
    swimWakeInFlight = (async () => {
      const machine = await getFlySwimMachine()
      if (['started', 'starting'].includes(machine.state)) {
        return { state: machine.state, alreadyRunning: true }
      }
      await startFlySwimMachine()
      return { state: 'starting', started: true }
    })().finally(() => {
      swimWakeInFlight = null
    })
  }
  return swimWakeInFlight
}

function kickSwimWake(reason) {
  if (!swimWakeConfigured()) return
  if (swimWakeInFlight) return

  wakeSwimWorker()
    .then(result => console.log(`swim wake (${reason}): ${result.state}`))
    .catch(err => console.error(`swim wake (${reason}) failed:`, err.message))
}

function scheduleSwimIdleCheck() {
  if (swimIdleTimer) clearTimeout(swimIdleTimer)
  if (!process.env.SWIM_WORKER_URL || SWIM_IDLE_TIMEOUT_MS <= 0) return

  swimIdleTimer = setTimeout(() => {
    const idleFor = Date.now() - swimLastActivityAt
    if (idleFor >= SWIM_IDLE_TIMEOUT_MS) {
      swim.stopAll()
      console.log(`swim: idle for ${Math.round(idleFor / 1000)}s; stopped worker polling`)
      return
    }
    scheduleSwimIdleCheck()
  }, SWIM_IDLE_TIMEOUT_MS).unref()
}

function markSwimActivity(reason, { wake = true } = {}) {
  if (!process.env.SWIM_WORKER_URL) return

  const now = Date.now()
  const wasIdle = !swimLastActivityAt || (now - swimLastActivityAt) >= SWIM_IDLE_TIMEOUT_MS
  swimLastActivityAt = now
  swim.startAll()
  scheduleSwimIdleCheck()

  if (wake && wasIdle) kickSwimWake(reason)
}

function getSwimActivityStatus() {
  const now = Date.now()
  const idleForMs = swimLastActivityAt ? now - swimLastActivityAt : null
  return {
    active: idleForMs != null && idleForMs < SWIM_IDLE_TIMEOUT_MS,
    idleForMs,
    idleTimeoutMs: SWIM_IDLE_TIMEOUT_MS,
    lastActivityAt: swimLastActivityAt ? new Date(swimLastActivityAt).toISOString() : null,
  }
}

// ── In-memory memoization for heavy aggregation endpoints ────────────────────
// Frontend dashboards poll multiple SWIM analytics endpoints simultaneously.
// Some of those run multi-table joins that take seconds. Memoize the result
// so concurrent callers share one computation, and re-run at most every TTL.
const _memoCache = new Map()
function memoized(key, ttlMs, fn) {
  const now = Date.now()
  const hit = _memoCache.get(key)
  if (hit && now - hit.t < ttlMs) return hit.v
  const v = fn()
  _memoCache.set(key, { t: now, v })
  return v
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
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
  app.get(['/', '/index.html'], (req, res, next) => {
    markSwimActivity('app-hit')
    next()
  })
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

app.use('/api/swim', (req, _res, next) => {
  markSwimActivity(`api:${req.path}`)
  next()
})

// Health check
app.get('/api/health', (_req, res) => {
  cachePublic(res, 10)
  const ps = poller.getStatus()
  const pollerStaleAfterMs = Math.max(ps.interval * 3, 5 * 60 * 1000)
  const pollerStale = ps.running && (!ps.lastFetchAt || Date.now() - ps.lastFetchAt > pollerStaleAfterMs)
  res.json({
    status: pollerStale ? 'degraded' : 'ok',
    aeroapi_configured: !!process.env.AEROAPI_KEY,
    opensky_configured: !!(process.env.OS_CLIENT_ID && process.env.OS_CLIENT_SECRET),
    faa_notam_configured: !!(process.env.FAA_CLIENT_ID && process.env.FAA_CLIENT_SECRET),
    poller_running: ps.running,
    poller_region: ps.region,
    poller_aircraft: ps.trackedAircraft,
    poller_last_fetch: ps.lastFetchAt ? new Date(ps.lastFetchAt).toISOString() : null,
    poller_feed_source: ps.lastFeedSource,
    poller_stale: pollerStale,
    opensky_paused: ps.openSkyPaused,
    opensky_pause: ps.openSkyPause,
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

// Readiness — is the service ready to handle HTTP traffic?
// Keep upstream feed availability out of readiness so transient provider/network
// issues do not block deploys or cause machine churn.
app.get('/api/health/ready', (_req, res) => {
  const checks = {}
  // DB: can we execute a trivial query?
  try {
    rawDb.prepare('SELECT 1').get()
    checks.db = 'ok'
  } catch {
    checks.db = 'fail'
  }
  if (process.env.POLLER_ENABLED === 'true') {
    const ps = poller.getStatus()
    checks.poller = ps.running ? 'running' : 'stopped'
    checks.pollerAircraft = ps.trackedAircraft
  }
  const ready = checks.db === 'ok'
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
      timeout: 30000,
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

// ═════════════════════════════════════════════════════════════════════════════
// ── Unified aircraft search (v5.6.0) ────────────────────────────────────────
// Single endpoint the frontend command-bar calls as you type. Searches:
//   1. Live flights in the poller cache (callsign, icao, operator, type, reg)
//   2. The aircraft_cache DB (historical aircraft we've seen, even if offline)
// Returns up to N ranked suggestions with a { live: true|false } tag so the
// UI can label them. Live matches always rank above historical.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/search', (req, res) => {
  cachePublic(res, 10)
  const q = String(req.query.q || '').trim().toLowerCase()
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 15, 50))
  if (q.length < 2) return res.json({ q, total: 0, results: [] })

  // Detect an exact ICAO hex match (6 hex chars). If the query looks like one,
  // we bump it to the top of results so Enter goes straight to the dossier.
  const looksLikeHex = /^[0-9a-f]{6}$/.test(q)

  const bundle = poller.getFlights?.() || { flights: [] }
  const all = bundle.flights || []

  const results = []
  const seen = new Set()

  function addLive(f, why) {
    if (!f?.icao || seen.has(f.icao)) return
    seen.add(f.icao)
    results.push({
      icao: f.icao,
      callsign: f.callsign || null,
      acType: f.acType || null,
      acReg: f.acReg || null,
      acOperator: f.acOperator || null,
      country: f.country || null,
      live: true,
      lat: f.lat, lon: f.lon,
      altFt: f.alt != null ? Math.round(f.alt * 3.281) : null,
      squawk: f.squawk || null,
      match: why,
      rank: 0,
    })
  }

  // Pass 1: exact ICAO — highest priority.
  if (looksLikeHex) {
    const f = all.find(x => x.icao === q)
    if (f) addLive(f, 'icao')
  }

  // Pass 2: live flights — exact then prefix then substring matches.
  const scoreMatch = (f) => {
    const cs = (f.callsign || '').toLowerCase()
    const op = (f.acOperator || '').toLowerCase()
    const ty = (f.acType || '').toLowerCase()
    const reg = (f.acReg || '').toLowerCase()
    const ic = (f.icao || '').toLowerCase()
    if (ic === q || reg === q || cs === q)                         return { w: 100, why: 'exact' }
    if (cs.startsWith(q) || reg.startsWith(q) || ic.startsWith(q)) return { w: 70,  why: 'prefix' }
    if (cs.includes(q) || reg.includes(q))                         return { w: 50,  why: 'cs/reg' }
    if (op.includes(q))                                            return { w: 25,  why: 'operator' }
    if (ty.includes(q))                                            return { w: 20,  why: 'type' }
    return null
  }
  const liveMatches = []
  for (const f of all) {
    const m = scoreMatch(f)
    if (m) liveMatches.push({ f, ...m })
  }
  liveMatches.sort((a, b) => b.w - a.w)
  for (const { f, why } of liveMatches) {
    if (results.length >= limit) break
    addLive(f, why)
  }

  // Pass 3: historical aircraft_cache — only if we still have room.
  if (results.length < limit) {
    try {
      const need = limit - results.length
      const rows = rawDb.prepare(`
        SELECT icao, type, reg, desc, operator
        FROM aircraft_cache
        WHERE icao = ? OR reg LIKE ? OR operator LIKE ? OR type LIKE ? OR desc LIKE ?
        LIMIT ?
      `).all(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, need * 3)
      const lastSeenStmt = rawDb.prepare(`
        SELECT MAX(seen_at) as last_seen, callsign
        FROM sightings WHERE icao = ?
      `)
      for (const r of rows) {
        if (seen.has(r.icao) || results.length >= limit) continue
        seen.add(r.icao)
        const ls = lastSeenStmt.get(r.icao) || {}
        results.push({
          icao: r.icao,
          callsign: ls.callsign || null,
          acType: r.type,
          acReg: r.reg,
          acOperator: r.operator,
          country: null,
          live: false,
          lastSeen: ls.last_seen || null,
          match: 'cache',
          rank: 1,
        })
      }
    } catch (err) {
      console.warn('search: cache lookup failed:', err.message)
    }
  }

  res.json({ q, total: results.length, results })
})

// v5.4.0 — nearby flights in a radius around a point. Haversine-filtered
// over the live poller cache. Default radius 20 nm. Sorted by distance.
// MUST precede /api/flights/:icao so "nearby" doesn't get captured as an ICAO.
app.get('/api/flights/nearby', (req, res) => {
  cachePublic(res, 10)
  const lat = Number(req.query.lat), lon = Number(req.query.lon)
  const radiusNm = Math.min(Number(req.query.radiusNm) || 20, 500)
  const excludeIcao = (req.query.excludeIcao || '').toLowerCase()
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  const { haversineKm } = require('./context/geo')
  const NM_PER_KM = 0.539957
  const bundle = poller.getFlights?.() || { flights: [] }
  const out = []
  for (const f of bundle.flights || []) {
    if (f.lat == null || f.lon == null) continue
    if (f.icao && f.icao.toLowerCase() === excludeIcao) continue
    const distNm = haversineKm(lat, lon, f.lat, f.lon) * NM_PER_KM
    if (distNm <= radiusNm) {
      out.push({
        icao: f.icao, callsign: f.callsign, acType: f.acType, acReg: f.acReg,
        acOperator: f.acOperator, lat: f.lat, lon: f.lon,
        altFt: f.alt != null ? Math.round(f.alt * 3.281) : null,
        velKt: f.vel != null ? Math.round(f.vel * 1.944) : null,
        hdg: f.hdg, squawk: f.squawk, grounded: !!f.grounded, mil: !!f.mil,
        distNm: +distNm.toFixed(1),
        bearing: Math.round((Math.atan2(f.lon - lon, f.lat - lat) * 180 / Math.PI + 360) % 360),
      })
    }
  }
  out.sort((a, b) => a.distNm - b.distNm)
  res.json({ center: [lat, lon], radiusNm, count: out.length, flights: out.slice(0, 50) })
})

// v5.3.0 — single live flight record by ICAO.
// The FlightTable has all ~4,400 flights; the Dossier wants just one.
// Falls back to DB lookup if the icao isn't currently in the poller cache.
app.get('/api/flights/:icao', (req, res) => {
  cachePublic(res, 10)
  const icao = (req.params.icao || '').toLowerCase()
  const flightBundle = poller.getFlights?.() || { flights: [] }
  const match = (flightBundle.flights || []).find(f => (f.icao || '').toLowerCase() === icao)
  if (match) return res.json({ live: true, flight: match })

  // Not live — fall back to the most recent sighting so the dossier can
  // still render identity + last known position.
  const recent = getAircraftHistory(icao, 1)
  if (recent?.length) {
    const s = recent[0]
    return res.json({
      live: false,
      flight: {
        icao, callsign: s.callsign,
        lat: s.lat, lon: s.lon, alt: s.alt, vel: s.vel, hdg: s.hdg,
        squawk: s.squawk, grounded: !!s.grounded,
        src: 'sightings', seen_at: s.seen_at,
      },
    })
  }
  return res.status(404).json({ error: `aircraft ${icao} not in poller cache or sightings DB` })
})

// v5.4.0 — flights currently airborne for a given operator or aircraft type.
// Used by the dossier's clickable-value drill-ins.
// v5.7.0 — also accepts airline ICAO ("UAL") or IATA ("UA") keys, matched
// against the airline classifier attached by assignGroups().
app.get('/api/flights/by-operator/:operator', (req, res) => {
  cachePublic(res, 15)
  const op = (req.params.operator || '').toLowerCase()
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  const bundle = poller.getFlights?.() || { flights: [] }
  const out = (bundle.flights || [])
    .filter(f =>
      (f.acOperator || '').toLowerCase() === op ||
      (f.airline?.icao || '').toLowerCase() === op ||
      (f.airline?.iata || '').toLowerCase() === op
    )
    .slice(0, limit)
    .map(f => ({
      icao: f.icao, callsign: f.callsign, acType: f.acType, acReg: f.acReg,
      lat: f.lat, lon: f.lon,
      altFt: f.alt != null ? Math.round(f.alt * 3.281) : null,
      velKt: f.vel != null ? Math.round(f.vel * 1.944) : null,
      grounded: !!f.grounded,
    }))
  res.json({ operator: req.params.operator, count: out.length, flights: out })
})

// v5.7.0 — live aggregate for a group tag (e.g. "airline:ual", "family:b737",
// "class:widebody", "gov:usaf"). Returns counts, top aircraft types, top
// departure/arrival airports, and a slice of the actual flights.
// Memoized 20s to match the interesting-feed cache cadence.
app.get('/api/groups/:groupId', (req, res) => {
  cachePublic(res, 20)
  const groupId = String(req.params.groupId || '').toLowerCase()
  if (!groupId.includes(':')) {
    return res.status(400).json({ error: 'groupId must be "<kind>:<id>", e.g. "airline:ual"' })
  }
  const [kind, id] = groupId.split(':', 2)
  const limit = Math.min(Number(req.query.limit) || 50, 200)

  const payload = memoized(`group:${groupId}:${limit}`, 20_000, () => {
    const bundle = poller.getFlights?.() || { flights: [] }
    const members = (bundle.flights || []).filter(f => Array.isArray(f.groups) && f.groups.includes(groupId))

    let airborne = 0, grounded = 0
    const byType = new Map()
    const byDep  = new Map()
    const byArr  = new Map()

    for (const f of members) {
      if (f.grounded) grounded++
      else airborne++

      if (f.acType) byType.set(f.acType, (byType.get(f.acType) || 0) + 1)

      const dep = f.tfms?.dep_arpt
      const arr = f.tfms?.arr_arpt
      if (dep) byDep.set(dep, (byDep.get(dep) || 0) + 1)
      if (arr) byArr.set(arr, (byArr.get(arr) || 0) + 1)
    }

    const topN = (m, n) => Array.from(m.entries())
      .map(([k, v]) => ({ id: k, n: v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, n)

    // Pick a label: if this is an airline, echo the full entry; otherwise fall
    // back to a humanized version of the id.
    let label = id.toUpperCase()
    if (kind === 'airline' && members[0]?.airline) {
      label = members[0].airline.name
    } else if (kind === 'family' || kind === 'class' || kind === 'role') {
      label = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }

    return {
      groupId,
      kind,
      id,
      label,
      count: members.length,
      airborne,
      grounded,
      types: topN(byType, 10),
      topDep: topN(byDep, 10),
      topArr: topN(byArr, 10),
      flights: members.slice(0, limit).map(f => ({
        icao: f.icao,
        callsign: f.callsign,
        acType: f.acType,
        acReg: f.acReg,
        acOperator: f.acOperator,
        lat: f.lat, lon: f.lon,
        altFt: f.alt != null ? Math.round(f.alt * 3.281) : null,
        velKt: f.vel != null ? Math.round(f.vel * 1.944) : null,
        grounded: !!f.grounded,
        squawk: f.squawk,
        tfms: f.tfms ? { dep_arpt: f.tfms.dep_arpt, arr_arpt: f.tfms.arr_arpt } : null,
        groups: f.groups,
      })),
    }
  })

  res.json(payload)
})

app.get('/api/flights/by-type/:type', (req, res) => {
  cachePublic(res, 15)
  const type = (req.params.type || '').toUpperCase()
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  const bundle = poller.getFlights?.() || { flights: [] }
  const out = (bundle.flights || [])
    .filter(f => (f.acType || '').toUpperCase() === type)
    .slice(0, limit)
    .map(f => ({
      icao: f.icao, callsign: f.callsign, acType: f.acType, acReg: f.acReg,
      acOperator: f.acOperator, lat: f.lat, lon: f.lon,
      altFt: f.alt != null ? Math.round(f.alt * 3.281) : null,
      velKt: f.vel != null ? Math.round(f.vel * 1.944) : null,
      grounded: !!f.grounded,
    }))
  res.json({ type, count: out.length, flights: out })
})

// v5.4.0 — sightings history for a callsign (across all ICAOs that used it).
// Useful for callsign recycling patterns.
app.get('/api/sightings/callsign/:callsign', (req, res) => {
  cachePublic(res, 60)
  const cs = (req.params.callsign || '').toUpperCase().trim()
  const limit = Math.min(Number(req.query.limit) || 50, 500)
  try {
    const rows = rawDb.prepare(`
      SELECT icao, callsign, country, seen_at, lat, lon, alt, vel, hdg, squawk
      FROM sightings
      WHERE UPPER(callsign) = ?
      ORDER BY seen_at DESC
      LIMIT ?
    `).all(cs, limit)
    const uniqIcaos = [...new Set(rows.map(r => r.icao))]
    res.json({ callsign: cs, totalRows: rows.length, uniqueIcaos: uniqIcaos.length, icaos: uniqIcaos, rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// v5.3.0 — aggregated flight history summary for the Dossier.
// Much cheaper than pulling /api/sightings/aircraft/:icao?limit=1000 and
// counting client-side.
app.get('/api/flight/:icao/history', (req, res) => {
  cachePublic(res, 60)
  const icao = (req.params.icao || '').toLowerCase()
  try {
    const rows = getAircraftHistory(icao, 1000)
    if (!rows.length) return res.json({ count: 0, firstSeen: null, lastSeen: null, days: 0, callsigns: [], countries: [], squawks: [] })

    const times = rows.map(r => new Date(r.seen_at).getTime()).filter(Number.isFinite)
    const first = Math.min(...times), last = Math.max(...times)
    const daySet = new Set(rows.map(r => r.seen_at?.slice(0, 10)).filter(Boolean))
    const tally = (field) => {
      const m = {}
      for (const r of rows) if (r[field]) m[r[field]] = (m[r[field]] || 0) + 1
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, n]) => ({ value: v, count: n }))
    }
    res.json({
      count: rows.length,
      firstSeen: new Date(first).toISOString(),
      lastSeen: new Date(last).toISOString(),
      days: daySet.size,
      callsigns: tally('callsign'),
      countries: tally('country'),
      squawks: tally('squawk'),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

// ── Community ADS-B proxy (backwards-compatible /api/apl routes) ─────────────

const COMMUNITY_ADSB_BASE = process.env.ADSBFI_BASE || 'https://opendata.adsb.fi/api/v2'
let _aplLastReq = 0  // timestamp of last request — enforce 1 req/sec server-side

async function aplFetch(path, res) {
  cachePrivate(res, 5)
  if (!serviceAvailable('adsbfi')) {
    return res.status(503).json({ error: 'community ADS-B feed temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
  // Server-side rate limiting: wait if needed to respect 1 req/sec
  const now = Date.now()
  const wait = Math.max(0, 1050 - (now - _aplLastReq))
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _aplLastReq = Date.now()

  const t0 = Date.now()
  try {
    const resp = await axios.get(`${COMMUNITY_ADSB_BASE}${path}`, { timeout: 10000 })
    recordServiceOk('adsbfi', Date.now() - t0)
    const data = resp.data || {}
    // Keep the historical /api/apl response contract (`ac`) even though the
    // adsb.fi geographic endpoint names the collection `aircraft`.
    res.json(Array.isArray(data.aircraft) && !data.ac
      ? { ...data, ac: data.aircraft }
      : data)
  } catch (err) {
    recordServiceError('adsbfi', Date.now() - t0, err.message)
    res.status(err.response?.status || 502).json({ error: err.message })
  }
}

// GET /api/apl/point?lat=37&lon=-122&radius=250
app.get('/api/apl/point', (req, res) => {
  const { lat, lon, radius } = req.query
  aplFetch(`/lat/${lat}/lon/${lon}/dist/${Math.min(radius || 250, 250)}`, res)
})

// GET /api/apl/hex?hex=a12345
app.get('/api/apl/hex', (req, res) => {
  aplFetch(`/hex/${(req.query.hex || '').trim().toLowerCase()}`, res)
})

// GET /api/apl/squawk?code=7700
app.get('/api/apl/squawk', (req, res) => {
  res.status(501).json({ error: 'squawk search is not supported by the current community feed' })
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

// In-process async memoizer for external HTTP-backed endpoints. Concurrent
// callers share one in-flight promise so we never make N parallel upstream
// requests for the same data, and the result is cached for ttlMs.
const _asyncMemoCache = new Map()
function memoizedAsync(key, ttlMs, fn) {
  const now = Date.now()
  const hit = _asyncMemoCache.get(key)
  if (hit && now - hit.t < ttlMs) return hit.p
  const p = fn().then(
    (v) => { _asyncMemoCache.set(key, { t: Date.now(), p: Promise.resolve(v) }); return v },
    (err) => { _asyncMemoCache.delete(key); throw err }
  )
  _asyncMemoCache.set(key, { t: now, p })
  return p
}

// GET /api/weather/metar?ids=KJFK,KLAX  or  ?bbox=25,-130,50,-60
// Memoized 90s — aviationweather.gov is slow and METARs only refresh hourly anyway.
app.get('/api/weather/metar', async (req, res) => {
  cachePublic(res, 120)
  if (!serviceAvailable('aviationweather')) {
    return res.status(503).json({ error: 'aviationweather temporarily unavailable (circuit breaker)', retry_after: 30 })
  }
  const t0 = Date.now()
  try {
    const key = `metar:${JSON.stringify(req.query)}`
    const data = await memoizedAsync(key, 90000, async () => {
      const params = { format: 'json', ...req.query }
      const resp = await axios.get(`${AWX_BASE}/metar`, { params, timeout: 10000 })
      return resp.data
    })
    recordServiceOk('aviationweather', Date.now() - t0)
    res.json(data)
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
    const key = `pirep:${JSON.stringify(req.query)}`
    const data = await memoizedAsync(key, 90000, async () => {
      const params = { format: 'json', ...req.query }
      const resp = await axios.get(`${AWX_BASE}/pirep`, { params, timeout: 10000 })
      return resp.data
    })
    recordServiceOk('aviationweather', Date.now() - t0)
    res.json(data)
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
    const key = `sigmet:${JSON.stringify(req.query)}`
    const data = await memoizedAsync(key, 90000, async () => {
      const params = { format: 'json', ...req.query }
      const resp = await axios.get(`${AWX_BASE}/airsigmet`, { params, timeout: 10000 })
      return resp.data
    })
    recordServiceOk('aviationweather', Date.now() - t0)
    res.json(data)
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

// ── Business jet early-warning tracker ──────────────────────────────────────
app.get('/api/business-jet-tracker', (_req, res) => {
  cachePublic(res, 20)
  res.json(businessJetTracker.getTrackerState())
})

app.post('/api/business-jet-tracker/sample', requireAdmin, async (_req, res, next) => {
  try {
    const result = await businessJetTracker.sampleOnce()
    res.json(result)
  } catch (err) {
    next(err)
  }
})

app.post('/api/business-jet-tracker/cohort/rebuild', requireAdmin, (_req, res) => {
  const result = rawDb.prepare('SELECT COUNT(*) AS c FROM faa_aircraft_ref').get()
  if (!result.c) {
    return res.status(409).json({ error: 'FAA aircraft reference table is empty; run the FAA registry ingest first' })
  }
  const r = require('./db').rebuildBusinessJetCohort()
  res.json(r)
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

// ── Internal SWIM endpoints (called by swim worker service via HTTP) ───────
// Protected by SWIM_INTERNAL_SECRET. Handlers enqueue payloads and respond
// immediately; a drain loop yields the event loop with setImmediate between
// batches so SQLite writes don't block the HTTP server, the poller, or the
// snapshot poll.

function requireInternalAuth(req, res, next) {
  const secret = process.env.SWIM_INTERNAL_SECRET
  if (!secret) return res.status(503).json({ error: 'internal API not configured' })
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (token !== secret) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// ── In-process SWIM ingestion queue ────────────────────────────────────────
const SWIM_Q_MAX = 5000
const swimQueue = []
let swimDropped = 0
let swimProcessed = 0
let swimLastDrainMs = 0
let swimCoalesced = 0
let swimDraining = false

function dedupeLatest(items, keyFn) {
  const map = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item)
    if (key) map.set(key, item)
  }
  return [...map.values()]
}

function compactNotamPayload(payload = {}) {
  const byId = new Map()
  const xmlById = new Map()
  const notams = Array.isArray(payload.notams) ? payload.notams : []
  const rawXmls = Array.isArray(payload.rawXmls) ? payload.rawXmls : []
  for (let i = 0; i < notams.length; i++) {
    const notam = notams[i]
    if (!notam?.id) continue
    byId.set(notam.id, notam)
    if (rawXmls[i]) xmlById.set(notam.id, rawXmls[i])
  }
  const compact = [...byId.values()]
  return { notams: compact, rawXmls: compact.map(n => xmlById.get(n.id) || null) }
}

function flowKey(event = {}) {
  return [
    event.event_id || event.id || '',
    event.event_type || event.eventType || event.msg_type || event.msgType || '',
    event.facility || event.airport || '',
    event.start_time || event.startTime || '',
    event.end_time || event.endTime || '',
    event.reason || event.text || event.message || '',
  ].join('|')
}

function coalesceSwimPayload(kind, payload = {}) {
  if (kind === 'notams') return compactNotamPayload(payload)
  if (kind === 'flights') return { plans: dedupeLatest(payload.plans, p => p?.acid || p?.callsign) }
  if (kind === 'routes') {
    return {
      routes: dedupeLatest(payload.routes, r => {
        if (!r?.callsign || !r?.origin_icao || !r?.destination_icao) return null
        return `${r.callsign}|${r.origin_icao}|${r.destination_icao}`
      }),
    }
  }
  if (kind === 'flow') return { events: dedupeLatest(payload.events, flowKey) }
  if (kind === 'positions' || kind === 'sectors') {
    const snapshot = Array.isArray(payload.snapshot) ? payload.snapshot.slice(-500) : []
    return { snapshot }
  }
  return payload
}

function mergeSwimPayload(kind, a = {}, b = {}) {
  if (kind === 'notams') return coalesceSwimPayload(kind, {
    notams: [...(a.notams || []), ...(b.notams || [])],
    rawXmls: [...(a.rawXmls || []), ...(b.rawXmls || [])],
  })
  if (kind === 'flights') return coalesceSwimPayload(kind, { plans: [...(a.plans || []), ...(b.plans || [])] })
  if (kind === 'routes') return coalesceSwimPayload(kind, { routes: [...(a.routes || []), ...(b.routes || [])] })
  if (kind === 'flow') return coalesceSwimPayload(kind, { events: [...(a.events || []), ...(b.events || [])] })
  if (kind === 'positions' || kind === 'sectors') return coalesceSwimPayload(kind, b)
  return b
}

function payloadHasWork(kind, payload = {}) {
  if (kind === 'notams') return (payload.notams || []).length > 0
  if (kind === 'flights') return (payload.plans || []).length > 0
  if (kind === 'routes') return (payload.routes || []).length > 0
  if (kind === 'flow') return (payload.events || []).length > 0
  if (kind === 'positions' || kind === 'sectors') return (payload.snapshot || []).length > 0
  return true
}

function enqueueSwim(kind, payload) {
  payload = coalesceSwimPayload(kind, payload)
  if (!payloadHasWork(kind, payload)) return

  // Only latest-state snapshots are safe to merge in the queue. Durable TFMS
  // and NOTAM batches must stay small so SQLite work yields between items.
  if (kind === 'positions' || kind === 'sectors') {
    for (let i = swimQueue.length - 1; i >= 0; i--) {
      if (swimQueue[i].kind !== kind) continue
      swimQueue[i].payload = mergeSwimPayload(kind, swimQueue[i].payload, payload)
      swimCoalesced++
      if (!swimDraining) setImmediate(drainSwim)
      return
    }
  }

  if (swimQueue.length >= SWIM_Q_MAX) {
    swimQueue.shift()
    swimDropped++
  }
  swimQueue.push({ kind, payload })
  if (!swimDraining) setImmediate(drainSwim)
}

function processSwimItem(item) {
  const dbm = require('./db')
  if (item.kind === 'notams') {
    dbm.upsertNotamBatch(item.payload.notams, item.payload.rawXmls)
  } else if (item.kind === 'flights') {
    dbm.upsertFlightPlanBatch(item.payload.plans)
  } else if (item.kind === 'routes') {
    dbm.upsertRoutesBatch(item.payload.routes)
  } else if (item.kind === 'flow') {
    const tx = dbm.db.transaction((events) => {
      for (const event of events) dbm.insertFlowEvent(event)
    })
    tx(item.payload.events)
  } else if (item.kind === 'positions') {
    if (item.payload.snapshot) dbm.persistFlightPositions(item.payload.snapshot)
  } else if (item.kind === 'sectors') {
    if (item.payload.snapshot) dbm.persistSectorCounts(item.payload.snapshot)
  }
}

function drainSwim() {
  swimDraining = true
  const item = swimQueue.shift()
  if (!item) {
    swimDraining = false
    return
  }
  const t0 = Date.now()
  try {
    processSwimItem(item)
    swimProcessed++
  } catch (err) {
    console.error(`swim drain ${item.kind} error:`, err.message)
  }
  swimLastDrainMs = Date.now() - t0
  setImmediate(drainSwim) // yield event loop between every item
}

function drainSwimSync(maxMs = 20000) {
  const start = Date.now()
  while (swimQueue.length > 0 && Date.now() - start < maxMs) {
    const item = swimQueue.shift()
    try { processSwimItem(item) } catch (err) {
      console.error(`swim drain ${item.kind} error:`, err.message)
    }
  }
}

function getSwimQueueStats() {
  return {
    depth: swimQueue.length,
    dropped: swimDropped,
    processed: swimProcessed,
    coalesced: swimCoalesced,
    lastDrainMs: swimLastDrainMs,
  }
}

app.post('/internal/swim/notams', requireInternalAuth, (req, res) => {
  enqueueSwim('notams', req.body)
  res.json({ ok: true, queued: swimQueue.length })
})

app.post('/internal/swim/flights', requireInternalAuth, (req, res) => {
  enqueueSwim('flights', req.body)
  res.json({ ok: true, queued: swimQueue.length })
})

app.post('/internal/swim/flow', requireInternalAuth, (req, res) => {
  enqueueSwim('flow', req.body)
  res.json({ ok: true, queued: swimQueue.length })
})

app.post('/internal/swim/routes', requireInternalAuth, (req, res) => {
  enqueueSwim('routes', req.body)
  res.json({ ok: true, queued: swimQueue.length })
})

// SWIM feed status
// GET /api/swim/status
app.get('/api/swim/status', (_req, res) => {
  cachePublic(res, 15)
  res.json({ ...swim.getStatus(), activity: getSwimActivityStatus() })
})

// Wake the stopped SWIM worker machine on demand. This starts one configured
// machine only; it does not create machines or increase capacity.
app.post('/api/swim/wake', swimWakeLimiter, async (_req, res) => {
  res.set('Cache-Control', 'no-store, private')

  const status = swim.getStatus()
  if (status?.workerConnected) {
    return res.json({ ok: true, state: 'connected', workerConnected: true })
  }

  if (!swimWakeConfigured()) {
    return res.status(503).json({ ok: false, configured: false, error: 'SWIM wake not configured' })
  }

  const now = Date.now()
  const cooldownMs = Math.max(0, SWIM_WAKE_COOLDOWN_MS - (now - swimWakeLastAttempt))
  if (cooldownMs > 0 && !swimWakeInFlight) {
    return res.status(202).json({ ok: true, state: 'cooldown', cooldownMs })
  }

  try {
    if (cooldownMs === 0) swimWakeLastAttempt = now
    const result = await wakeSwimWorker()
    res.status(202).json({ ok: true, ...result })
  } catch (err) {
    console.error('swim wake failed:', err.message)
    res.status(502).json({ ok: false, error: 'SWIM wake failed' })
  }
})

// Active TFRs from SWIM FNS
// GET /api/swim/tfrs
app.get('/api/swim/tfrs', (_req, res) => {
  cachePublic(res, 60)
  try {
    const { getActiveTfrs } = require('./db')
    res.json(memoized('activeTfrs', 60000, () => getActiveTfrs()))
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

// NOTAMs for a specific airport/location
// GET /api/swim/notams/:location
app.get('/api/swim/notams/:location', (req, res) => {
  cachePublic(res, 60)
  try {
    const { getNotamsForLocation } = require('./db')
    res.json(getNotamsForLocation(req.params.location.toUpperCase()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TFMS — active flight plans
// GET /api/swim/flights?limit=50
app.get('/api/swim/flights', (req, res) => {
  cachePublic(res, 30)
  try {
    const { getActiveFlightPlans } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    // Memoize at max limit and slice — shared computation across all callers.
    const all = memoized('activeFlightPlans', 30000, () => getActiveFlightPlans(200))
    res.json(all.slice(0, limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TFMS — flight positions for map display (only flights with lat/lon)
// GET /api/swim/flights/positions?limit=500
app.get('/api/swim/flights/positions', (req, res) => {
  cachePublic(res, 10)
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000)
    res.json(swim.getFlightPositions(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// STDDS — surface/TRACON positions for map display (in-memory)
// GET /api/swim/surface/positions?limit=300
app.get('/api/swim/surface/positions', (req, res) => {
  cachePublic(res, 10)
  try {
    const limit = Math.min(Number(req.query.limit) || 300, 1000)
    res.json(swim.getSurfacePositions(limit))
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

// ITWS — recent terminal weather events (in-memory)
// GET /api/swim/weather?limit=20
app.get('/api/swim/weather', (req, res) => {
  cachePublic(res, 60)
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    res.json(swim.getRecentTerminalWeather(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ITWS — terminal weather for specific airport (in-memory)
// GET /api/swim/weather/:airport
app.get('/api/swim/weather/:airport', (req, res) => {
  cachePublic(res, 60)
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    res.json(swim.getTerminalWeatherByAirport(req.params.airport.toUpperCase(), limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// STDDS — recent surface events (in-memory)
// GET /api/swim/surface?limit=30
app.get('/api/swim/surface', (req, res) => {
  cachePublic(res, 15)
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    res.json(swim.getRecentSurfaceEvents(limit))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// STDDS — OOOI events (in-memory)
// GET /api/swim/oooi?limit=30
app.get('/api/swim/oooi', (req, res) => {
  cachePublic(res, 15)
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    res.json(swim.getOooi(limit))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// STDDS — surface events by airport (in-memory)
// GET /api/swim/surface/:airport
app.get('/api/swim/surface/:airport', (req, res) => {
  cachePublic(res, 15)
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    res.json(swim.getSurfaceEventsByAirport(req.params.airport.toUpperCase(), limit))
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

// ── Computed airport operations (cross-references TFMS + STDDS + ITWS) ──────

// GET /api/swim/airport/:icao/ops — full computed ops for one airport
// Memoized 30s — runs 15+ joins on surface_events/flight_plans, biggest single
// per-request workload on the dashboard.
app.get('/api/swim/airport/:icao/ops', (req, res) => {
  cachePublic(res, 30)
  try {
    const { getAirportOps } = require('./db')
    const icao = req.params.icao.toUpperCase()
    res.json(memoized(`airportOps:${icao}`, 30000, () => getAirportOps(icao)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/flight/:callsign/lifecycle — stitched TFMS + STDDS + SFDPS flight lifecycle
app.get('/api/swim/flight/:callsign/lifecycle', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getFlightLifecycleEnhanced } = require('./db')
    const cs = req.params.callsign.toUpperCase()
    res.json(memoized(`lifecycle:${cs}`, 15000, () => getFlightLifecycleEnhanced(cs)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/flight/:callsign/positions — SFDPS position trail for altitude profile
app.get('/api/swim/flight/:callsign/positions', (req, res) => {
  cachePublic(res, 15)
  try {
    const { getPositionTrail } = require('./db')
    const cs = req.params.callsign.toUpperCase()
    res.json(memoized(`posTrail:${cs}`, 15000, () => getPositionTrail(cs)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/airport/:icao/surface-flow — departure queue, throughput, ground movements
app.get('/api/swim/airport/:icao/surface-flow', (req, res) => {
  cachePublic(res, 30)
  try {
    const { getSurfaceFlow } = require('./db')
    const icao = req.params.icao.toUpperCase()
    res.json(memoized(`surfaceFlow:${icao}`, 30000, () => getSurfaceFlow(icao)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/routes/deviations — route corridors with unusual off-route deviation
// Blends live enrichment data (always available) with TFMS DB aggregation
app.get('/api/swim/routes/deviations', (req, res) => {
  cachePublic(res, 30)
  try {
    const { getRouteDeviations } = require('./db')
    const { getRouteDeviationsLive } = require('./poller')
    const limit = Math.min(Number(req.query.limit) || 20, 50)
    const dbResults = getRouteDeviations(limit)
    const liveResults = getRouteDeviationsLive(20, limit)
    // Merge: live data fills gaps where TFMS DB has nothing
    const seen = new Set(dbResults.map(d => `${d.dep_arpt}→${d.arr_arpt}`))
    const merged = [...dbResults]
    for (const r of liveResults) {
      if (!seen.has(`${r.dep_arpt}→${r.arr_arpt}`)) merged.push(r)
    }
    merged.sort((a, b) => b.avg_km - a.avg_km)
    res.json(merged.slice(0, limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/live-feed — unified real-time event stream from all sources
// Memoized 10s. The frontend dashboard polls this aggressively and the
// underlying 5 SELECTs + getRecentAnomalies fan out across multiple tables.
app.get('/api/swim/live-feed', (req, res) => {
  cachePublic(res, 10)
  try {
    const { getLiveFeed } = require('./db')
    const limit = Math.min(Number(req.query.limit) || 60, 200)
    // Memoize at the highest limit (200) and slice; lets all callers share one computation.
    const all = memoized('liveFeed', 10000, () => getLiveFeed(200))
    res.json(all.slice(0, limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/weather-delays — weather-delay causation + predictions
// Memoized 30s — multi-table join across flow_events × terminal_weather is heavy.
app.get('/api/swim/weather-delays', (_req, res) => {
  cachePublic(res, 30)
  try {
    const { getWeatherDelayCausation } = require('./db')
    res.json(memoized('weatherDelays', 30000, () => getWeatherDelayCausation()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/sectors — ARTCC sector congestion from SFDPS data
app.get('/api/swim/sectors', (_req, res) => {
  cachePublic(res, 30)
  try {
    res.json(memoized('sectorCongestion', 30000, () => swim.getSectorCongestion()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/sectors/:artcc — sector detail + history for an ARTCC
app.get('/api/swim/sectors/:artcc', (req, res) => {
  cachePublic(res, 30)
  try {
    const artcc = req.params.artcc.toUpperCase()
    res.json(memoized(`sectorDetail:${artcc}`, 30000, () => swim.getSectorDetail(artcc)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/nas/analytics — full NAS-wide analytics (all airports, scored and ranked)
// Memoized 60s — runs 5 large self-joins on surface_events and flight_plans.
// This is the prime suspect for the multi-second event-loop blocks.
app.get('/api/swim/nas/analytics', (_req, res) => {
  cachePublic(res, 60)
  try {
    const { getNasAnalytics } = require('./db')
    res.json(memoized('nasAnalytics', 60000, () => getNasAnalytics()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/swim/nas — NAS-wide health summary
app.get('/api/swim/nas', (_req, res) => {
  cachePublic(res, 30)
  try {
    const { getNasSummary } = require('./db')
    res.json(memoized('nasSummary', 30000, () => getNasSummary()))
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
    const keyCount = poller.getActiveKeyCount() // configured OpenSky OAuth keys
    const daily_limit = keyCount > 0 ? 4000 * keyCount : 400
    const db_remaining = daily_limit - db.credits_used

    // OpenSky's OAuth2 X-Rate-Limit-Remaining header is per active key and is
    // not always present/reliable. Do not add "unused keys" to it; that can
    // overstate remaining credits. Report the conservative lower value.
    const headerEstimate = headerRemaining != null && keyCount <= 1
      ? headerRemaining
      : null
    let remaining = headerEstimate != null
      ? Math.min(db_remaining, headerEstimate)
      : db_remaining

    // clamp to [0, daily_limit]
    remaining = Math.max(0, Math.min(daily_limit, remaining))

    res.json({
      ...db,
      daily_limit,
      key_count: keyCount,
      db_remaining,
      header_remaining: headerRemaining,
      header_estimate: headerEstimate,
      remaining,
      remaining_source: headerEstimate != null ? 'conservative_min_db_header' : 'db_estimate_multi_key_safe',
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
// Memoized 60s — usage data refreshes slowly upstream and the dashboard polls
// this on every refresh; without caching it took 12s under load.
// GET /api/aero/spend
app.get('/api/aero/spend', async (_req, res) => {
  const dbTotal = getAeroSpendTotal()
  const dbMonth = getAeroSpendMonth()

  let fa = null
  if (process.env.AEROAPI_KEY) {
    try {
      fa = await memoizedAsync('aeroSpend', 60000, async () => {
        const r = await axios.get(`${AERO_BASE}/account/usage`, { headers: aeroHeaders() })
        return r.data
      })
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

// ═════════════════════════════════════════════════════════════════════════════
// ── Correlation Layer (v2.0.0) ──────────────────────────────────────────────
// External context sources joined to flight tracks. Each endpoint fans out to
// one adapter in backend/context/ and is independently cacheable. The main
// entry — /api/context/aircraft/:icao — joins everything for one aircraft.
// ═════════════════════════════════════════════════════════════════════════════

const ctx = {
  firms:       require('./context/firms'),
  eonet:       require('./context/eonet'),
  openaq:      require('./context/openaq'),
  owm:         require('./context/owm'),
  openMeteo:   require('./context/openMeteo'),
  nps:         require('./context/nps'),
  mapillary:   require('./context/mapillary'),
  swpc:        require('./context/swpc'),
  usgsEvents:  require('./context/usgsEvents'),
  correlation: require('./context/correlation'),
}

function ctxWrap(handler) {
  return async (req, res) => {
    try { await handler(req, res) }
    catch (err) {
      console.warn(`context request failed (${req.path}):`, err.message)
      res.status(502).json({ error: 'context provider unavailable' })
    }
  }
}

// GET /api/context/fires?lat=&lon=&radiusKm=&days=
app.get('/api/context/fires', ctxWrap(async (req, res) => {
  cachePublic(res, 300)
  const lat = Number(req.query.lat), lon = Number(req.query.lon)
  const radiusKm = req.query.radiusKm ? Number(req.query.radiusKm) : undefined
  const days = req.query.days ? Number(req.query.days) : undefined
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  res.json(await ctx.firms.fetchFires({ lat, lon, radiusKm, days }))
}))

// GET /api/context/events?lat=&lon=&radiusKm=
app.get('/api/context/events', ctxWrap(async (req, res) => {
  cachePublic(res, 600)
  const lat = req.query.lat ? Number(req.query.lat) : null
  const lon = req.query.lon ? Number(req.query.lon) : null
  const radiusKm = req.query.radiusKm ? Number(req.query.radiusKm) : undefined
  res.json(await ctx.eonet.fetchEvents({ lat, lon, radiusKm }))
}))

// GET /api/context/airquality?lat=&lon=
app.get('/api/context/airquality', ctxWrap(async (req, res) => {
  cachePublic(res, 300)
  const lat = Number(req.query.lat), lon = Number(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  res.json(await ctx.openaq.fetchNearbyAQ({ lat, lon, radiusKm: req.query.radiusKm ? Number(req.query.radiusKm) : undefined }))
}))

// GET /api/context/weather?lat=&lon=&provider=owm|meteo
app.get('/api/context/weather', ctxWrap(async (req, res) => {
  cachePublic(res, 300)
  const lat = Number(req.query.lat), lon = Number(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  const provider = req.query.provider || 'both'
  const out = {}
  if (provider === 'owm' || provider === 'both') {
    out.openWeatherMap = await ctx.owm.fetchCurrent({ lat, lon }).catch(e => ({ error: e.message }))
  }
  if (provider === 'meteo' || provider === 'both') {
    out.openMeteo = await ctx.openMeteo.fetchCurrent({ lat, lon }).catch(e => ({ error: e.message }))
  }
  res.json(out)
}))

// GET /api/context/webcams?lat=&lon=&radiusKm=
app.get('/api/context/webcams', ctxWrap(async (req, res) => {
  cachePublic(res, 1800)
  const lat = Number(req.query.lat), lon = Number(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  res.json(await ctx.nps.fetchNearby({ lat, lon, radiusKm: req.query.radiusKm ? Number(req.query.radiusKm) : undefined }))
}))

// GET /api/context/streetlevel?lat=&lon=&radiusKm=  (Mapillary nearest images)
app.get('/api/context/streetlevel', ctxWrap(async (req, res) => {
  cachePublic(res, 1800)
  const lat = Number(req.query.lat), lon = Number(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  res.json(await ctx.mapillary.fetchNearest({
    lat, lon,
    radiusKm: req.query.radiusKm ? Number(req.query.radiusKm) : undefined,
  }))
}))

// GET /api/context/space-weather
app.get('/api/context/space-weather', ctxWrap(async (_req, res) => {
  cachePublic(res, 300)
  res.json(await ctx.swpc.fetchStatus())
}))

// GET /api/context/quakes?lat=&lon=&radiusKm=
app.get('/api/context/quakes', ctxWrap(async (req, res) => {
  cachePublic(res, 300)
  const lat = req.query.lat ? Number(req.query.lat) : null
  const lon = req.query.lon ? Number(req.query.lon) : null
  const radiusKm = req.query.radiusKm ? Number(req.query.radiusKm) : undefined
  res.json(await ctx.usgsEvents.fetchQuakes({ lat, lon, radiusKm }))
}))

// GET /api/context/volcanoes — current elevated-alert volcanoes globally
app.get('/api/context/volcanoes', ctxWrap(async (_req, res) => {
  cachePublic(res, 600)
  res.json(await ctx.usgsEvents.fetchVolcanoAlerts())
}))

// ═════════════════════════════════════════════════════════════════════════════
// ── "Now Showing" interesting-flights feed (v5.2.0) ─────────────────────────
// Ranks the live flight cache by interestingness (squawk / callsign / orbit /
// anomaly / route deviation / mil) and returns the top N. This is the home
// page's primary surface — the one place that says "these flights are worth
// your time right now."
// ═════════════════════════════════════════════════════════════════════════════

const { getInterestingFlights } = require('./feed')

// GET /api/feed/interesting?limit=20
app.get('/api/feed/interesting', ctxWrap(async (req, res) => {
  cachePublic(res, 15)
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 100))
  res.json(getInterestingFlights({ limit }))
}))

// GET /api/context/map?bbox=W,S,E,N&layers=fires,events,quakes,volcanoes,webcams
// ─ Unified bbox fan-out for map overlays. Returns all requested layers in one shot.
// ─ Each layer degrades independently: one source failing never tanks the rest.
// ─ Adapters are radius-based; we convert bbox → center+radius (half diagonal).
app.get('/api/context/map', ctxWrap(async (req, res) => {
  cachePublic(res, 120)

  const bboxParts = String(req.query.bbox || '').split(',').map(Number)
  if (bboxParts.length !== 4 || bboxParts.some(n => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox=W,S,E,N required (four comma-separated numbers)' })
  }
  const [w, s, e, n] = bboxParts
  const lat = (s + n) / 2
  const lon = (w + e) / 2

  // Haversine from center to NE corner in km — use as radius.
  const { haversineKm } = require('./context/geo')
  const radiusKm = Math.ceil(haversineKm(lat, lon, n, e))

  const wanted = new Set(
    String(req.query.layers || 'fires,events,quakes,volcanoes,webcams')
      .split(',').map(s => s.trim()).filter(Boolean)
  )

  const tasks = {}
  if (wanted.has('fires'))     tasks.fires     = ctx.firms.fetchFires({ lat, lon, radiusKm: Math.min(radiusKm, 1500), days: 2 })
  if (wanted.has('events'))    tasks.events    = ctx.eonet.fetchEvents({ lat, lon, radiusKm: Math.min(radiusKm, 3000) })
  if (wanted.has('quakes'))    tasks.quakes    = ctx.usgsEvents.fetchQuakes({ lat, lon, radiusKm: Math.min(radiusKm, 3000) })
  if (wanted.has('volcanoes')) tasks.volcanoes = ctx.usgsEvents.fetchVolcanoAlerts()
  if (wanted.has('webcams'))   tasks.webcams   = ctx.nps.fetchNearby({ lat, lon, radiusKm: Math.min(radiusKm, 3000), limit: 200 })

  const keys = Object.keys(tasks)
  const results = await Promise.allSettled(Object.values(tasks))
  const out = { bbox: [w, s, e, n], center: [lat, lon], radiusKm }
  keys.forEach((k, i) => {
    out[k] = results[i].status === 'fulfilled' ? results[i].value : { error: results[i].reason?.message || 'failed' }
  })
  res.json(out)
}))

// GET /api/context/aircraft/:icao
// Joins every correlation source for one aircraft. If the poller has the
// aircraft in its latest-flights cache we use that position; otherwise the
// caller can pass lat/lon/altitude/etc. as query params.
//
// v5.1.1 merged_bug_002 — the poller stores flights with short field names
// (alt / vel / hdg) and altitude in *meters* (OpenSky's state[7]). This
// handler previously read .alt_baro / .altitude / .gs / .velocity / .track
// / .heading — all undefined — and fell through to query params. Any caller
// without overrides (curl, external integrations) got altitude=null and every
// altitude-gated inference silently skipped. Fix: read the real fields AND
// convert m → ft because correlation.js thresholds and reason strings are
// written in feet.
app.get('/api/context/aircraft/:icao', ctxWrap(async (req, res) => {
  const icao = req.params.icao.toLowerCase()

  // Pull aircraft state from poller cache first, then fall back to query.
  // getFlights() returns { flights, fetchedAt, region, count, pollInterval }.
  const pollerFlights = poller.getFlights?.()?.flights || []
  const pollerFlight = pollerFlights.find(f => (f.icao || '').toLowerCase() === icao)

  const altFt = pollerFlight?.alt != null ? pollerFlight.alt * 3.281 : null
  const velKt = pollerFlight?.vel != null ? pollerFlight.vel * 1.944 : null  // m/s → kt
  const aircraft = {
    icao,
    callsign:  pollerFlight?.callsign || req.query.callsign,
    squawk:    pollerFlight?.squawk   || req.query.squawk,
    lat:       pollerFlight?.lat != null ? pollerFlight.lat : Number(req.query.lat),
    lon:       pollerFlight?.lon != null ? pollerFlight.lon : Number(req.query.lon),
    altitude:  altFt ?? (req.query.altitude ? Number(req.query.altitude) : null),
    velocity:  velKt ?? (req.query.velocity ? Number(req.query.velocity) : null),
    heading:   pollerFlight?.hdg ?? (req.query.heading ? Number(req.query.heading) : null),
  }
  if (!Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) {
    // bug_020 — do NOT let this 404 be cached; the next poll cycle may
    // populate the aircraft and we don't want browsers serving a stale 404.
    res.set('Cache-Control', 'no-store')
    return res.status(404).json({ error: 'aircraft position not in poller cache; pass ?lat=&lon=' })
  }

  cachePublic(res, 30)  // only set on the success path

  // Pull a short track from the sightings DB to feed orbit detection.
  let track = []
  try { track = getAircraftTrack(icao, 60) } catch { /* ignore */ }

  const bundle = await ctx.correlation.buildContext({ aircraft, track })
  res.json(bundle)
}))

// POST /api/context/position — same shape but for arbitrary lat/lon + optional track
app.post('/api/context/position', ctxWrap(async (req, res) => {
  const { lat, lon, altitude, velocity, heading, callsign, squawk, icao, track } = req.body || {}
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.set('Cache-Control', 'no-store')
    return res.status(400).json({ error: 'body requires lat and lon' })
  }
  cachePublic(res, 30)
  const bundle = await ctx.correlation.buildContext({
    aircraft: { icao, callsign, squawk, lat, lon, altitude, velocity, heading },
    track: Array.isArray(track) ? track : null,
  })
  res.json(bundle)
}))

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
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500
  res.status(status).json({ error: status === 500 ? 'internal server error' : 'request rejected' })
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
  console.log(`  OS_CLIENT_ID_3: ${process.env.OS_CLIENT_ID_3 ? '✓ set' : '✗ not set'}`)
  console.log(`  FAA_CLIENT_ID:  ${process.env.FAA_CLIENT_ID ? '✓ set' : '✗ not set'}`)
  console.log(``)
  console.log(`  ── correlation layer (v2.0.0) ──`)
  console.log(`  FIRMS_MAP_KEY:       ${process.env.FIRMS_MAP_KEY ? '✓ set' : '✗ not set'}`)
  console.log(`  OPENWEATHERMAP_KEY:  ${process.env.OPENWEATHERMAP_KEY ? '✓ set' : '✗ not set'}`)
  console.log(`  OPENAQ_KEY:          ${process.env.OPENAQ_KEY ? '✓ set' : '✗ not set'}`)
  console.log(`  NPS_KEY:             ${process.env.NPS_KEY ? '✓ set' : '✗ not set'}`)
  console.log(`  MAPILLARY_TOKEN:     ${process.env.MAPILLARY_ACCESS_TOKEN ? '✓ set' : '✗ not set'}`)
  console.log(`  SENTINEL_CLIENT_ID:  ${process.env.SENTINEL_CLIENT_ID ? '✓ set' : '✗ not set'}`)
  console.log(`  AISSTREAM_KEY:       ${process.env.AISSTREAM_KEY ? '✓ set (not wired)' : '✗ not set'}`)
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

  // ── OpenSky credential healthcheck (fire-and-forget) ────────────────────
  // Tests each configured slot at boot and prints a clear table so you don't
  // have to dig through poller logs to learn a slot is invalid_client or
  // rate-limited. Does not block startup.
  ;(async () => {
    const slots = [
      { label: 'slot 1', id: process.env.OS_CLIENT_ID,   secret: process.env.OS_CLIENT_SECRET   },
      { label: 'slot 2', id: process.env.OS_CLIENT_ID_2, secret: process.env.OS_CLIENT_SECRET_2 },
      { label: 'slot 3', id: process.env.OS_CLIENT_ID_3, secret: process.env.OS_CLIENT_SECRET_3 },
    ].filter(s => s.id && s.secret)
    if (!slots.length) {
      console.log('  ℹ  OpenSky: no credentials configured')
      return
    }
    console.log(`\n  ── OpenSky credential healthcheck ──`)
    for (const s of slots) {
      try {
        const tokRes = await axios.post(OS_TOKEN_URL,
          new URLSearchParams({ grant_type: 'client_credentials', client_id: s.id, client_secret: s.secret }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 })
        const token = tokRes.data?.access_token
        if (!token) { console.log(`  ${s.label} (${s.id}) — FAIL no token in response`); continue }
        // Test an actual /states call to distinguish "OAuth works but rate-limited" from "fully working".
        try {
          const ping = await axios.get(`${OS_BASE}/states/all?lamin=40&lomin=-75&lamax=42&lomax=-73`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
          const remaining = ping.headers?.['x-rate-limit-remaining']
          console.log(`  ${s.label} (${s.id}) — ✓ OK · ${ping.data?.states?.length ?? 0} states · ${remaining ?? '?'} credits remaining today`)
        } catch (apiErr) {
          const status = apiErr.response?.status
          if (status === 429) {
            const retry = Number(apiErr.response?.headers?.['x-rate-limit-retry-after-seconds']) || null
            const hrs = retry ? (retry / 3600).toFixed(1) : '?'
            console.log(`  ${s.label} (${s.id}) — ⚠ 429 rate-limited · retry in ~${hrs} hours (auth works, credits exhausted)`)
          } else {
            console.log(`  ${s.label} (${s.id}) — ✗ /states ${status || 'error'}: ${apiErr.message}`)
          }
        }
      } catch (authErr) {
        const status = authErr.response?.status
        const body = authErr.response?.data?.error_description || authErr.response?.data?.error || authErr.message
        console.log(`  ${s.label} (${s.id}) — ✗ OAuth ${status || ''}: ${body}`)
      }
    }
    console.log('')
  })()

  // Start anomaly poller if enabled via env
  if (process.env.POLLER_ENABLED === 'true') {
    poller.start()
  } else {
    console.log('  ℹ  Anomaly poller disabled — set POLLER_ENABLED=true to enable')
  }

  // SWIM worker polling is started on frontend/app SWIM activity and stopped
  // after SWIM_IDLE_TIMEOUT_MS so Fly can auto-stop the separate worker.
  if (process.env.SWIM_WORKER_URL) {
    console.log(`  ℹ  SWIM worker polling idle — starts on frontend activity, idle timeout ${SWIM_IDLE_TIMEOUT_MS}ms`)
  } else {
    console.log('  ℹ  SWIM worker not configured — set SWIM_WORKER_URL to enable')
  }

  // v5.7 Phase 2 — FAA registry self-heal + weekly refresh.
  // Opt-out via FAA_REGISTRY_DISABLED=true for local dev without network.
  // Deliberately app-level code (not Fly-specific) so the ingest travels with
  // the repo to any Node host.
  if (process.env.FAA_REGISTRY_DISABLED !== 'true') {
    const faaRegistryJob = require('./jobs/faaRegistryJob')
    faaRegistryJob.scheduleStartupIngest()
    faaRegistryJob.scheduleWeeklyRefresh()
  } else {
    console.log('  ℹ  FAA registry self-heal disabled via FAA_REGISTRY_DISABLED')
  }

  if (process.env.BUSINESS_JET_TRACKER_DISABLED !== 'true') {
    businessJetTracker.start()
    console.log(`  ℹ  Business jet tracker enabled — ${process.env.BUSINESS_JET_HEATMAP_URL || process.env.ADSB_HEATMAP_URL ? 'tar1090 snapshot source' : 'poller fallback source'}, interval ${businessJetTracker.getTrackerState().intervalMs}ms`)
  } else {
    console.log('  ℹ  Business jet tracker disabled via BUSINESS_JET_TRACKER_DISABLED')
  }

  // ── Event loop lag monitor (diagnostic) ──────────────────────────────────
  // Uses perf_hooks.monitorEventLoopDelay for accurate p99/max samples and
  // includes the SWIM ingest queue depth so we can attribute future stalls
  // (SWIM ingestion vs poller vs other) without guessing.
  const { monitorEventLoopDelay } = require('perf_hooks')
  const _loopHist = monitorEventLoopDelay({ resolution: 50 })
  _loopHist.enable()
  setInterval(() => {
    const maxMs = _loopHist.max / 1e6
    if (maxMs > 1000) {
      const p99Ms = _loopHist.percentile(99) / 1e6
      const mem = process.memoryUsage()
      console.warn(
        `⚠ event-loop max=${maxMs.toFixed(0)}ms p99=${p99Ms.toFixed(0)}ms ` +
        `swimQ=${swimQueue.length} swimDrop=${swimDropped} ` +
        `rss=${(mem.rss/1048576).toFixed(0)}MB heap=${(mem.heapUsed/1048576).toFixed(0)}/${(mem.heapTotal/1048576).toFixed(0)}MB`
      )
    }
    _loopHist.reset()
  }, 5000).unref()
})

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`)

  // Stop accepting new requests
  poller.stop()
  businessJetTracker.stop()
  swim.stopAll()

  // Drain anything still queued from /internal/swim/* before closing the DB,
  // so we don't lose NOTAM/flight/flow batches that the worker already POSTed.
  if (swimQueue.length > 0) {
    console.log(`shutdown: draining ${swimQueue.length} queued SWIM items`)
    drainSwimSync(20000)
  }

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

module.exports = { app, enqueueSwim, getSwimQueueStats, drainSwimSync }
