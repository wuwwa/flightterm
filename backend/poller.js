// ── Backend anomaly polling service ──────────────────────────────────────────
// Replaces the frontend's fetch→score→post cycle with a server-side poller
// that runs independently of any browser session.

const axios = require('axios')
const { EventEmitter } = require('events')
const { scoreAnomaly, ANOMALY_THRESHOLD } = require('./anomaly')
const db = require('./db')

// ── Event bus ────────────────────────────────────────────────────────────────
// Consumers can subscribe: anomalyEvents.on('anomaly:new', (data) => { ... })
const anomalyEvents = new EventEmitter()

// ── Configuration ────────────────────────────────────────────────────────────

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 90_000  // ms
const RESOLVE_AFTER = 3   // consecutive misses before resolving
const MAX_SNAPSHOTS = 30  // per aircraft

const OS_BASE = 'https://opensky-network.org/api'
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const AWX_BASE = 'https://aviationweather.gov/api/data'

const REGIONS = {
  global:   { bbox: null },
  usa:      { bbox: { lamin: 24,  lomin: -125, lamax: 49.5, lomax: -66 } },
  europe:   { bbox: { lamin: 35,  lomin: -10,  lamax: 71,   lomax: 40 } },
  asia:     { bbox: { lamin: 10,  lomin: 70,   lamax: 55,   lomax: 145 } },
  atlantic: { bbox: { lamin: 10,  lomin: -70,  lamax: 60,   lomax: -10 } },
}

// ── In-memory state ──────────────────────────────────────────────────────────

const trackHistory = new Map()     // icao → snapshot[]
const activeAnomalies = new Map()  // icao → { score, ... }
const anomalyMisses = new Map()    // icao → consecutive miss count
const enrichCache = new Map()      // icao → { adsbfi, flightroute, ... }
let latestFlights = []             // most recent flight states from last cycle
let lastFetchAt = null             // timestamp of last successful fetch
let weatherContext = null           // { sigmets, pireps } from last cycle
let osToken = null                  // { token, expiresAt }
let pollTimer = null
let running = false

// ── OpenSky auth ─────────────────────────────────────────────────────────────

async function getOsToken() {
  const clientId = process.env.OS_CLIENT_ID
  const clientSecret = process.env.OS_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  const now = Date.now()
  if (osToken && now < osToken.expiresAt) return osToken.token

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })
  const res = await axios.post(OS_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const expiresIn = res.data.expires_in ?? 1800
  osToken = {
    token: res.data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  }
  return osToken.token
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchOpenSky(region = 'usa') {
  const reg = REGIONS[region] || REGIONS.usa
  const params = reg.bbox ? { ...reg.bbox } : {}
  const headers = {}

  try {
    const token = await getOsToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch (err) {
    console.warn('poller: opensky token failed:', err.message)
  }

  const res = await axios.get(`${OS_BASE}/states/all`, { headers, params, timeout: 30000 })
  const states = res.data?.states || []

  return states.map(s => ({
    icao:     (s[0] || '').trim(),
    callsign: (s[1] || '').trim() || null,
    country:  s[2] || 'unknown',
    lon:      s[5] != null ? parseFloat(s[5].toFixed(4)) : null,
    lat:      s[6] != null ? parseFloat(s[6].toFixed(4)) : null,
    alt:      s[7] != null ? Math.round(s[7]) : null,
    grounded: s[8] ?? false,
    vel:      s[9] != null ? parseFloat(s[9].toFixed(1)) : null,
    hdg:      s[10] != null ? Math.round(s[10]) : null,
    vertRate: s[11] != null ? parseFloat(s[11].toFixed(1)) : null,
    geoAlt:   s[13] != null ? Math.round(s[13]) : null,
    squawk:   s[14] || null,
    posSrc:   s[16] ?? 0,
    ndb:      s[17] ?? null,
    mil:      false,
    src:      'opensky',
  }))
}

async function fetchPireps(bbox) {
  try {
    const res = await axios.get(`${AWX_BASE}/pirep`, {
      params: { format: 'json', bbox: bbox.join(','), age: 2 },
      timeout: 10000,
    })
    return res.data || []
  } catch { return [] }
}

async function fetchSigmets() {
  try {
    const res = await axios.get(`${AWX_BASE}/airsigmet`, {
      params: { format: 'json' },
      timeout: 10000,
    })
    return res.data || []
  } catch { return [] }
}

function summarizePireps(pireps) {
  if (!pireps.length) return { count: 0, maxTurbulence: null, maxIcing: null, severe: false }
  const turbLevels = { LGT: 1, 'LGT-MOD': 2, MOD: 3, 'MOD-SEV': 4, SEV: 5, EXTRM: 6 }
  const iceLevels = { NEG: 0, 'NEG-LGT': 0, TRC: 1, 'TRC-LGT': 1, LGT: 2, 'LGT-MOD': 3, MOD: 4, 'MOD-SEV': 5, SEV: 6, HVY: 6 }
  let maxTurb = null, maxTurbVal = 0, maxIce = null, maxIceVal = 0

  for (const p of pireps) {
    if (p.tbInt1 && turbLevels[p.tbInt1] > maxTurbVal) {
      maxTurbVal = turbLevels[p.tbInt1]
      maxTurb = `${p.tbInt1}${p.tbType1 ? ' ' + p.tbType1 : ''} FL${p.fltLvl || '???'}`
    }
    if (p.icgInt1 && iceLevels[p.icgInt1] > maxIceVal) {
      maxIceVal = iceLevels[p.icgInt1]
      maxIce = `${p.icgInt1}${p.icgType1 ? ' ' + p.icgType1 : ''} FL${p.fltLvl || '???'}`
    }
  }

  return { count: pireps.length, maxTurbulence: maxTurb, maxIcing: maxIce, severe: maxTurbVal >= 5 || maxIceVal >= 5 }
}

function summarizeSigmets(sigmets) {
  if (!sigmets.length) return { count: 0, convective: 0, turbulence: 0, icing: 0 }
  return {
    count: sigmets.length,
    convective: sigmets.filter(s => s.hazard === 'CONVECTIVE').length,
    turbulence: sigmets.filter(s => s.hazard === 'TURB').length,
    icing: sigmets.filter(s => s.hazard === 'ICE').length,
  }
}

// ── Track history ────────────────────────────────────────────────────────────

function updateTrackHistory(flights) {
  const now = Date.now()
  for (const f of flights) {
    if (f.alt == null && f.vel == null) continue

    let arr = trackHistory.get(f.icao)
    if (!arr) { arr = []; trackHistory.set(f.icao, arr) }

    arr.push({
      ts: now, lat: f.lat, lon: f.lon, alt: f.alt, vel: f.vel,
      hdg: f.hdg, grounded: f.grounded, vertRate: f.vertRate,
      geoAlt: f.geoAlt, posSrc: f.posSrc, ndb: f.ndb,
    })

    if (arr.length > MAX_SNAPSHOTS) arr.shift()
  }

  // Prune stale aircraft (not seen in 10 minutes)
  const cutoff = now - 10 * 60 * 1000
  for (const [icao, arr] of trackHistory) {
    if (arr.length > 0 && arr[arr.length - 1].ts < cutoff) {
      trackHistory.delete(icao)
    }
  }
}

// ── Route enrichment ─────────────────────────────────────────────────────────

function buildEnrichment(f) {
  const enrich = enrichCache.get(f.icao) || {}

  // Inject route from DB cache if not already enriched
  if (!enrich.flightroute && f.callsign) {
    const routes = db.getRoutesBulk([f.callsign])
    const cached = routes[f.callsign]
    if (cached) {
      enrich.flightroute = {
        destination: { latitude: cached.destination_lat, longitude: cached.destination_lon, icao_code: cached.destination_icao },
        origin: { latitude: cached.origin_lat, longitude: cached.origin_lon, icao_code: cached.origin_icao },
      }
    }
  }

  return Object.keys(enrich).length > 0 ? enrich : null
}

// ── Weather fetching ─────────────────────────────────────────────────────────

async function fetchWeatherContext(anomalyFlights) {
  const lats = anomalyFlights.filter(a => a.lat != null).map(a => a.lat)
  const lons = anomalyFlights.filter(a => a.lon != null).map(a => a.lon)
  if (lats.length === 0) return null

  const pad = 2
  const bbox = [
    Math.min(...lats) - pad,
    Math.min(...lons) - pad,
    Math.max(...lats) + pad,
    Math.max(...lons) + pad,
  ]

  const [pireps, sigmets] = await Promise.all([
    fetchPireps(bbox),
    fetchSigmets(),
  ])

  const pirepSummary = summarizePireps(pireps)
  const sigmetSummary = summarizeSigmets(sigmets)

  if (pirepSummary.count > 0 || sigmetSummary.count > 0) {
    return { sigmets: sigmetSummary, pireps: pirepSummary }
  }
  return null
}

// ── Core polling cycle ───────────────────────────────────────────────────────

async function pollCycle() {
  const region = process.env.POLL_REGION || 'usa'

  // 1. Fetch flight data
  let flights
  try {
    flights = await fetchOpenSky(region)
  } catch (err) {
    console.error('poller: fetch failed:', err.message)
    return
  }

  if (!flights.length) return

  // Store latest flights for API consumers
  latestFlights = flights
  lastFetchAt = Date.now()

  // 2. Update track history
  updateTrackHistory(flights)

  // 3. Score each aircraft
  const newAnomalies = {}
  const anomalyFlights = []

  for (const f of flights) {
    const hist = trackHistory.get(f.icao)
    if (!hist || hist.length < 2) continue

    const enrich = buildEnrichment(f)
    const result = scoreAnomaly(hist, f, enrich, weatherContext, flights)

    if (result.score >= ANOMALY_THRESHOLD) {
      newAnomalies[f.icao] = {
        icao: f.icao,
        callsign: f.callsign,
        score: result.score,
        phase: result.phase,
        reasons: result.reasons,
        confirmed: result.confirmed,
        category: result.category,
        severity: result.severity,
        categories: result.categories,
        lat: f.lat,
        lon: f.lon,
        alt: f.alt,
        vel: f.vel,
        hdg: f.hdg,
        squawk: f.squawk,
      }
      anomalyFlights.push(f)
    }
  }

  // 4. Anomaly lifecycle — grace period & resolution
  const resolvedIcaos = []
  for (const icao of activeAnomalies.keys()) {
    if (newAnomalies[icao]) {
      anomalyMisses.delete(icao)
    } else {
      const misses = (anomalyMisses.get(icao) || 0) + 1
      anomalyMisses.set(icao, misses)
      if (misses >= RESOLVE_AFTER) {
        resolvedIcaos.push(icao)
        anomalyMisses.delete(icao)
      }
    }
  }

  // Resolve stale anomalies
  if (resolvedIcaos.length > 0) {
    try {
      db.resolveAnomalies(resolvedIcaos)
      for (const icao of resolvedIcaos) activeAnomalies.delete(icao)
      console.log(`poller: resolved ${resolvedIcaos.length} anomalies after ${RESOLVE_AFTER} clear cycles`)
      anomalyEvents.emit('anomaly:resolved', resolvedIcaos)
    } catch (err) {
      console.error('poller: resolve error:', err.message)
    }
  }

  // Update active anomalies map
  for (const [icao, anomaly] of Object.entries(newAnomalies)) {
    activeAnomalies.set(icao, anomaly)
  }

  // 5. Persist + emit new anomalies
  const anomalyList = Object.values(newAnomalies)
  if (anomalyList.length > 0) {
    // Fetch weather context for next cycle (non-blocking)
    fetchWeatherContext(anomalyFlights).then(wx => {
      weatherContext = wx

      // Attach weather to anomalies and persist
      const payload = wx
        ? anomalyList.map(a => ({ ...a, weather_context: wx }))
        : anomalyList

      try {
        db.recordAnomalies(payload, region)
      } catch (err) {
        console.error('poller: record error:', err.message)
      }
    }).catch(() => {
      try { db.recordAnomalies(anomalyList, region) } catch {}
    })

    // Emit events for each new anomaly
    for (const anomaly of anomalyList) {
      anomalyEvents.emit('anomaly:new', anomaly)
      if (anomaly.severity === 'CRITICAL') {
        anomalyEvents.emit('anomaly:critical', anomaly)
      }
    }

    console.log(`poller: ${flights.length} flights, ${anomalyList.length} anomalies (${resolvedIcaos.length} resolved)`)
  } else {
    // No anomalies — still update weather context to null for next cycle
    if (weatherContext) weatherContext = null
    console.log(`poller: ${flights.length} flights, 0 anomalies (${resolvedIcaos.length} resolved)`)
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function start() {
  if (running) return
  running = true

  console.log(`poller: starting (interval: ${POLL_INTERVAL / 1000}s, region: ${process.env.POLL_REGION || 'usa'})`)

  // Run first cycle immediately, then on interval
  pollCycle().catch(err => console.error('poller: cycle error:', err.message))
  pollTimer = setInterval(() => {
    pollCycle().catch(err => console.error('poller: cycle error:', err.message))
  }, POLL_INTERVAL)
}

function stop() {
  if (!running) return
  running = false
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  console.log('poller: stopped')
}

function getStatus() {
  return {
    running,
    interval: POLL_INTERVAL,
    region: process.env.POLL_REGION || 'usa',
    trackedAircraft: trackHistory.size,
    activeAnomalies: activeAnomalies.size,
    pendingMisses: anomalyMisses.size,
  }
}

function getFlights() {
  return {
    flights: latestFlights,
    fetchedAt: lastFetchAt,
    region: process.env.POLL_REGION || 'usa',
    count: latestFlights.length,
  }
}

module.exports = {
  start,
  stop,
  getStatus,
  getFlights,
  anomalyEvents,
  // Exposed for testing
  _internals: {
    pollCycle,
    updateTrackHistory,
    buildEnrichment,
    fetchWeatherContext,
    summarizePireps,
    summarizeSigmets,
    trackHistory,
    activeAnomalies,
    anomalyMisses,
    resetFlights() { latestFlights = []; lastFetchAt = null },
  },
}
