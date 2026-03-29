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

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 45_000  // ms
const RESOLVE_AFTER = 3   // consecutive misses before resolving
const MAX_SNAPSHOTS = 30  // per aircraft
const ENRICH_BATCH  = 50  // how many aircraft to background-enrich per cycle
const ENRICH_DELAY  = 5000 // ms between enrichment requests

const OS_BASE = 'https://opensky-network.org/api'
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const APL_BASE = 'https://api.airplanes.live/v2'
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
let pollTimer = null
let running = false

// ── OpenSky dual-key auth ───────────────────────────────────────────────────
// Supports two sets of credentials. Each key gets 4000 credits/day.
// When key 1 runs low (< CREDIT_SWITCH_THRESHOLD), auto-switch to key 2.

const CREDIT_SWITCH_THRESHOLD = 100 // remaining credits before switching
const OS_KEY_SLOTS = [
  { id: process.env.OS_CLIENT_ID,   secret: process.env.OS_CLIENT_SECRET },
  { id: process.env.OS_CLIENT_ID_2, secret: process.env.OS_CLIENT_SECRET_2 },
].filter(k => k.id && k.secret)

let activeKeySlot = 0                // index into OS_KEY_SLOTS
const osTokens = [null, null]        // cached tokens per slot

function getActiveKeyCount() { return OS_KEY_SLOTS.length }

async function getOsToken(slotIndex) {
  const slot = OS_KEY_SLOTS[slotIndex ?? activeKeySlot]
  if (!slot) return null
  const idx = slotIndex ?? activeKeySlot

  const now = Date.now()
  if (osTokens[idx] && now < osTokens[idx].expiresAt) return osTokens[idx].token

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: slot.id,
    client_secret: slot.secret,
  })
  const res = await axios.post(OS_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const expiresIn = res.data.expires_in ?? 1800
  osTokens[idx] = {
    token: res.data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  }
  return osTokens[idx].token
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

  // Check remaining credits from response header and auto-switch if needed
  const remaining = res.headers?.['x-rate-limit-remaining']
  if (remaining != null) {
    const rem = Number(remaining)
    if (rem < CREDIT_SWITCH_THRESHOLD && OS_KEY_SLOTS.length > 1 && activeKeySlot === 0) {
      activeKeySlot = 1
      console.log(`poller: opensky key 1 low (${rem} remaining), switching to key 2`)
    } else if (rem < CREDIT_SWITCH_THRESHOLD && OS_KEY_SLOTS.length > 1 && activeKeySlot === 1) {
      console.warn(`poller: opensky key 2 also low (${rem} remaining) — both keys near exhaustion`)
    } else if (rem > 3000 && activeKeySlot === 1) {
      // credits reset (new day) — switch back to key 1
      activeKeySlot = 0
      console.log(`poller: credits reset detected (${rem} remaining), switching back to key 1`)
    }

    // Record the call for usage tracking
    const credits = db.calcOpenSkyCredits(params)
    db.recordApiCall({
      service: 'opensky', endpoint: '/states/all',
      region: region, credits,
      status: 200, aircraftCount: states.length,
      rateRemaining: rem,
    })
  }

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

// ── APL enrichment for anomaly aircraft ─────────────────────────────────────
// Single hex lookups for aircraft that scored above threshold.
// Returns enrichment fields the scorer can use (emergency, MCP, category, mil).

let _aplLastReq = 0

async function fetchAplHex(icao) {
  // Enforce 1 req/sec to respect APL rate limits
  const now = Date.now()
  const wait = Math.max(0, 1100 - (now - _aplLastReq))
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _aplLastReq = Date.now()

  const res = await axios.get(`${APL_BASE}/hex/${icao}`, { timeout: 8000 })
  const ac = res.data?.ac?.[0]
  if (!ac) return null

  return {
    navAltMcp:  ac.nav_altitude_mcp ?? null,   // feet
    navHeading: ac.nav_heading ?? null,         // degrees
    emergency:  ac.emergency && ac.emergency !== 'none' ? ac.emergency : null,
    mil:        !!(ac.dbFlags & 1),
    category:   ac.category ?? null,            // A1-A5, B1-B4
    vertRate:   ac.baro_rate != null ? parseFloat((ac.baro_rate * 0.00508).toFixed(1)) : null, // ft/min → m/s
    reg:        ac.r ?? null,
    type:       ac.t ?? null,
    desc:       ac.desc ?? null,
    ownOp:      ac.ownOp ?? null,
  }
}

async function enrichAnomaliesWithApl(anomalyFlights) {
  const results = new Map()
  for (const f of anomalyFlights) {
    try {
      const apl = await fetchAplHex(f.icao)
      if (apl) results.set(f.icao, apl)
    } catch {
      // APL lookup failed — continue without enrichment
    }
  }
  return results
}

// ── Background aircraft enrichment (type/reg/operator) ────────────────────
// After each poll cycle, slowly enriches the first N uncached aircraft via
// adsbdb. Results are persisted to SQLite so they survive restarts.
// Runs one request every ENRICH_DELAY ms to avoid rate limits.

const ADSBDB_BASE = 'https://api.adsbdb.com/v0'
let _enrichAbort = null

const ADSBFI_BASE = 'https://opendata.adsb.fi/api/v2'

async function enrichFromAdsbfi(icao) {
  const res = await axios.get(`${ADSBFI_BASE}/hex/${icao}`, { timeout: 10000 })
  const ac = res.data?.ac?.[0]
  if (!ac?.t) return null // no type data
  return {
    icao,
    type: ac.t || null,
    reg: ac.r || null,
    desc: ac.desc || null,
    operator: ac.ownOp || null,
    source: 'adsbfi',
  }
}

async function enrichAircraftBackground(flights) {
  // Abort any running enrichment from a previous cycle
  if (_enrichAbort) _enrichAbort.abort = true
  const ctrl = { abort: false }
  _enrichAbort = ctrl

  const cachedSet = db.getAircraftCacheIcaos()
  const unknownSet = db.getUnknownAircraftIcaos()
  const flightIcaos = flights.map(f => f.icao)

  // Primary: uncached aircraft → try adsbdb first
  const uncached = flightIcaos.filter(icao => !cachedSet.has(icao)).slice(0, ENRICH_BATCH)
  // Fallback: aircraft that adsbdb didn't know → retry with adsb.fi
  const fallback = flightIcaos.filter(icao => unknownSet.has(icao)).slice(0, ENRICH_BATCH)

  if (uncached.length === 0 && fallback.length === 0) return

  if (uncached.length > 0) {
    console.log(`poller: enriching ${uncached.length} aircraft (adsbdb) + ${fallback.length} fallback (adsb.fi)`)
  } else {
    console.log(`poller: enriching ${fallback.length} aircraft via adsb.fi fallback`)
  }

  // Phase 1: adsbdb for uncached, with adsb.fi fallback on 404
  for (const icao of uncached) {
    if (ctrl.abort || !running) break

    try {
      const res = await axios.get(`${ADSBDB_BASE}/aircraft/${icao}`, { timeout: 10000 })
      const ac = res.data?.response?.aircraft
      if (!ctrl.abort) {
        db.upsertAircraftCache([{
          icao,
          type: ac?.icao_type || ac?.type || null,
          reg: ac?.registration || null,
          desc: ac?.type_description || null,
          operator: ac?.registered_owner || null,
          source: 'adsbdb',
        }])
      }
    } catch (err) {
      if (err?.response?.status === 429) {
        console.warn('poller: adsbdb rate limited, pausing enrichment')
        break
      }
      // adsbdb doesn't know this aircraft — try adsb.fi immediately
      if (err?.response?.status === 404 && !ctrl.abort) {
        try {
          const entry = await enrichFromAdsbfi(icao)
          if (entry && !ctrl.abort) {
            db.upsertAircraftCache([entry])
          } else if (!ctrl.abort) {
            db.upsertAircraftCache([{ icao, type: null, reg: null, desc: null, operator: null, source: 'unknown' }])
          }
        } catch {
          // both sources failed — mark unknown
          if (!ctrl.abort) {
            db.upsertAircraftCache([{ icao, type: null, reg: null, desc: null, operator: null, source: 'unknown' }])
          }
        }
      }
    }

    if (!ctrl.abort) {
      await new Promise(r => setTimeout(r, ENRICH_DELAY))
    }
  }

  // Phase 2: retry previously-unknown aircraft via adsb.fi
  // (they may now be airborne / trackable even if adsbdb had no record)
  for (const icao of fallback) {
    if (ctrl.abort || !running) break

    try {
      const entry = await enrichFromAdsbfi(icao)
      if (entry && !ctrl.abort) {
        db.upsertAircraftCache([entry])
      }
      // if adsb.fi also has nothing, leave as 'unknown' — will retry next cycle
    } catch {
      // skip — will retry next cycle
    }

    if (!ctrl.abort) {
      await new Promise(r => setTimeout(r, ENRICH_DELAY))
    }
  }
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

  // Persist sightings to DB (populates dashboard stats, heatmap, activity)
  try {
    db.recordSightings(flights, 'opensky', region)
  } catch (err) {
    console.error('poller: sightings record error:', err.message)
  }

  // 2. Score each aircraft BEFORE updating history.
  //    scoreAnomaly compares current flight against the last snapshot (prev).
  //    If we update history first, prev === current and all deltas are 0.
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

  // 3. Enrich anomaly aircraft with APL data and re-score
  //    APL provides emergency, MCP intent, category, military — fields OpenSky doesn't have.
  //    Re-scoring with enrichment may raise or lower scores (e.g. military suppression).
  if (anomalyFlights.length > 0) {
    try {
      const aplData = await enrichAnomaliesWithApl(anomalyFlights)
      if (aplData.size > 0) {
        console.log(`poller: enriched ${aplData.size}/${anomalyFlights.length} anomalies via APL`)
        for (const f of anomalyFlights) {
          const apl = aplData.get(f.icao)
          if (!apl) continue

          // Store in enrichment cache for future cycles
          const existing = enrichCache.get(f.icao) || {}
          existing.apl = apl
          enrichCache.set(f.icao, existing)

          // Re-score with enrichment
          const hist = trackHistory.get(f.icao)
          if (!hist || hist.length < 2) continue
          const enrich = buildEnrichment(f)
          const result = scoreAnomaly(hist, f, enrich, weatherContext, flights)

          if (result.score >= ANOMALY_THRESHOLD) {
            // Update anomaly with enriched score
            const anomaly = newAnomalies[f.icao]
            anomaly.score = result.score
            anomaly.phase = result.phase
            anomaly.reasons = result.reasons
            anomaly.confirmed = result.confirmed
            anomaly.category = result.category
            anomaly.severity = result.severity
            anomaly.categories = result.categories
          } else {
            // Enrichment dropped score below threshold (e.g. military suppression)
            delete newAnomalies[f.icao]
          }
        }
      }
    } catch (err) {
      console.warn('poller: APL enrichment failed:', err.message)
    }
  }

  // 4. Update track history (after scoring, so prev ≠ current)
  updateTrackHistory(flights)

  // 5. Anomaly lifecycle — grace period & resolution
  const anomalyList = Object.values(newAnomalies)
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

  // 6. Persist + emit new anomalies
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

  // 7. Background aircraft enrichment (non-blocking, runs between cycles)
  enrichAircraftBackground(flights).catch(err =>
    console.warn('poller: background enrichment error:', err.message)
  )
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
  // Merge aircraft cache (type/reg/operator) into flight objects
  const icaos = latestFlights.map(f => f.icao)
  const acCache = icaos.length > 0 ? db.getAircraftCacheBulk(icaos) : {}

  const flights = latestFlights.map(f => {
    const ac = acCache[f.icao]
    if (!ac || !ac.type) return f  // skip unknown/empty entries
    return { ...f, acType: ac.type, acReg: ac.reg, acDesc: ac.desc, acOperator: ac.operator }
  })

  return {
    flights,
    fetchedAt: lastFetchAt,
    region: process.env.POLL_REGION || 'usa',
    count: flights.length,
    pollInterval: POLL_INTERVAL,
  }
}

module.exports = {
  start,
  stop,
  getStatus,
  getFlights,
  getActiveKeyCount,
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
