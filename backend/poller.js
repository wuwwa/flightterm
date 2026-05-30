// ── Backend anomaly polling service ──────────────────────────────────────────
// Replaces the frontend's fetch→score→post cycle with a server-side poller
// that runs independently of any browser session.

const axios = require('axios')
const { EventEmitter } = require('events')
const { scoreAnomaly, ANOMALY_THRESHOLD, AIRPORTS } = require('./anomaly')
const { parseRoute, polylineCrossTrackDistKm } = require('./route-parser')
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
const MAX_ENRICH_CACHE = 10_000  // cap enrichCache to prevent unbounded growth
const ENRICH_CACHE_TTL = 60 * 60 * 1000 // 1 hour — evict stale entries

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

// ── Anomaly detection kill switch ────────────────────────────────────────────
// The app is now used purely as a dashboard. Anomaly detection is the heaviest
// per-cycle workload (sync DB lookups + scoring per flight + sightings writes).
// Default OFF; set ANOMALY_DETECTION_ENABLED=true to re-enable.
const ANOMALY_DETECTION_ENABLED = process.env.ANOMALY_DETECTION_ENABLED === 'true'

// ── In-memory state ──────────────────────────────────────────────────────────

const trackHistory = new Map()     // icao → snapshot[]
const activeAnomalies = new Map()  // icao → { score, ... }
const anomalyMisses = new Map()    // icao → consecutive miss count
const pendingAnomalies = new Map() // icao → { anomaly, cycles } — persistence gate for MEDIUM
const enrichCache = new Map()      // icao → { adsbfi, flightroute, ... }
let latestFlights = []             // most recent flight states from last cycle
let lastFetchAt = null             // timestamp of last successful fetch
let weatherContext = null           // { sigmets, pireps } from last cycle
let baselineCache = new Map()      // "KJFK→KLAX" → baseline object
let pollTimer = null
let baselineTimer = null
let running = false

// ── Flight lifecycle state ─────────────────────────────────────────────────
// Drives the "cleanup on landing" path in cleanupLandedFlights().
const groundedStreak = new Map()   // icao → consecutive cycles seen with grounded=1
const purgedCallsigns = new Map()  // callsign → expiry ms (don't re-purge within TTL)
let lastLifecycleCheckIso = new Date(0).toISOString() // watermark for TFMS/STDDS lookups

const GROUNDED_STREAK_THRESHOLD = 3            // cycles of grounded=1 before we'll call it landed
const NEAR_DEST_NM = 5                         // "arrived at destination" radius (nautical miles)
const LOST_AFTER_MS = 5 * 60 * 1000            // 5 min without a sighting → lost/landed
const PURGED_TTL_MS = 30 * 60 * 1000           // once purged, ignore same callsign for 30 min

// ── OpenSky dual-key auth ───────────────────────────────────────────────────
// Supports two sets of credentials. Each key gets 4000 credits/day.
// When key 1 runs low (< CREDIT_SWITCH_THRESHOLD), auto-switch to key 2.

const CREDIT_SWITCH_THRESHOLD = 100 // remaining credits before switching
const OS_KEY_SLOTS = [
  { id: process.env.OS_CLIENT_ID,   secret: process.env.OS_CLIENT_SECRET },
  { id: process.env.OS_CLIENT_ID_2, secret: process.env.OS_CLIENT_SECRET_2 },
  { id: process.env.OS_CLIENT_ID_3, secret: process.env.OS_CLIENT_SECRET_3 },
].filter(k => k.id && k.secret)

let activeKeySlot = 0                // index into OS_KEY_SLOTS
const osTokens = Array(OS_KEY_SLOTS.length).fill(null) // cached tokens per slot

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
  const slotUsed = activeKeySlot

  try {
    const token = await getOsToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      console.warn(`poller: opensky no token available (slot ${slotUsed + 1}/${OS_KEY_SLOTS.length}, id: ${OS_KEY_SLOTS[slotUsed]?.id?.substring(0, 8)}...)`)
    }
  } catch (err) {
    const status = err.response?.status
    const body = err.response?.data ? JSON.stringify(err.response.data).substring(0, 200) : ''
    console.warn(`poller: opensky token failed (slot ${slotUsed + 1}): ${status || ''} ${err.message}${body ? ' — ' + body : ''}`)
  }

  const authMode = headers['Authorization'] ? 'authenticated' : 'anonymous'
  let res
  try {
    res = await axios.get(`${OS_BASE}/states/all`, { headers, params, timeout: 30000 })
  } catch (err) {
    const status = err.response?.status
    const body = err.response?.data ? JSON.stringify(err.response.data).substring(0, 200) : ''
    // v5.7 — surface the retry-after window when OpenSky returns 429 so we
    // can see at a glance how long we're shut out for. OpenSky returns
    // X-Rate-Limit-Retry-After-Seconds pointing at the daily-credit reset.
    let retryHint = ''
    if (status === 429) {
      const retry = Number(err.response?.headers?.['x-rate-limit-retry-after-seconds']) || null
      if (retry) retryHint = ` · retry in ${(retry / 3600).toFixed(1)}h`
    }
    console.error(`poller: opensky API ${status || 'network error'} (${authMode}, key ${slotUsed + 1}/${OS_KEY_SLOTS.length})${retryHint}: ${err.message}${body ? ' — ' + body : ''}`)
    // Auto-switch key on 429 (rate limit) or 401 (bad token)
    if ((status === 429 || status === 401) && OS_KEY_SLOTS.length > 1) {
      const nextSlot = (activeKeySlot + 1) % OS_KEY_SLOTS.length
      console.log(`poller: switching from key ${activeKeySlot + 1} to key ${nextSlot + 1} after ${status}`)
      activeKeySlot = nextSlot
    }
    throw err
  }
  const states = res.data?.states || []
  if (states.length === 0) {
    console.warn(`poller: opensky returned 0 states (${authMode}, key ${slotUsed + 1}, region: ${region})`)
  }

  // Check remaining credits from response header and auto-switch if needed
  const remaining = res.headers?.['x-rate-limit-remaining']
  if (remaining != null) {
    const rem = Number(remaining)
    if (rem < CREDIT_SWITCH_THRESHOLD && OS_KEY_SLOTS.length > 1) {
      const nextSlot = (activeKeySlot + 1) % OS_KEY_SLOTS.length
      if (nextSlot !== activeKeySlot) {
        console.log(`poller: opensky key ${activeKeySlot + 1} low (${rem} remaining), switching to key ${nextSlot + 1}`)
        activeKeySlot = nextSlot
      }
      if (nextSlot === 0) {
        console.warn(`poller: all ${OS_KEY_SLOTS.length} opensky keys cycled — credits may be near exhaustion`)
      }
    } else if (rem > 3000 && activeKeySlot !== 0) {
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
      callsign: f.callsign || null,
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

  // Prune stale enrichment cache entries (older than TTL)
  const enrichCutoff = now - ENRICH_CACHE_TTL
  for (const [icao, entry] of enrichCache) {
    if (entry._ts && entry._ts < enrichCutoff) {
      enrichCache.delete(icao)
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

  // ── TFMS enrichment: look up flight plan by callsign ──────────────────────
  if (!enrich.tfms && f.callsign) {
    try {
      const plan = db.getFlightPlan(f.callsign)
      if (plan) {
        // Get coordinates from callsign_routes (14K+ routes with coords) or AIRPORTS fallback
        let depLat = null, depLon = null, arrLat = null, arrLon = null
        if (enrich.flightroute) {
          depLat = enrich.flightroute.origin?.latitude
          depLon = enrich.flightroute.origin?.longitude
          arrLat = enrich.flightroute.destination?.latitude
          arrLon = enrich.flightroute.destination?.longitude
        }
        if ((!depLat || !arrLat) && plan.dep_arpt && plan.arr_arpt) {
          if (!depLat) { const a = AIRPORTS.find(a => a.icao === plan.dep_arpt); if (a) { depLat = a.lat; depLon = a.lon } }
          if (!arrLat) { const a = AIRPORTS.find(a => a.icao === plan.arr_arpt); if (a) { arrLat = a.lat; arrLon = a.lon } }
        }

        enrich.tfms = {
          dep_arpt: plan.dep_arpt,
          arr_arpt: plan.arr_arpt,
          dep_lat: depLat, dep_lon: depLon,
          arr_lat: arrLat, arr_lon: arrLon,
          route: plan.route,
          etd: plan.etd,
          eta: plan.eta,
          atd: plan.atd,
          ata: plan.ata,
          altitude: plan.altitude,
          speed: plan.speed,
          beacon_code: plan.beacon_code,
          aircraft_type: plan.aircraft_type,
          flight_status: plan.flight_status,
        }
        // Backfill flightroute if we have coords
        if (!enrich.flightroute && depLat && arrLat) {
          enrich.flightroute = {
            origin: { latitude: depLat, longitude: depLon, icao_code: plan.dep_arpt },
            destination: { latitude: arrLat, longitude: arrLon, icao_code: plan.arr_arpt },
          }
        }
      }
    } catch {}
  }

  // ── Off-route deviation detection ─────────────────────────────────────────
  // Phase 4: prefer waypoint-based polyline deviation using the filed route
  // string (from SFDPS/TFMS). Falls back to great-circle between dep/arr
  // airports if no route string or parsing yields <2 waypoints.
  if (enrich.flightroute && f.lat != null && f.lon != null) {
    const orig = enrich.flightroute.origin
    const dest = enrich.flightroute.destination

    if (orig?.latitude && dest?.latitude) {
      let deviation = null
      let mode = 'gc' // 'polyline' | 'gc'

      // Try waypoint-based deviation using the filed route string
      const routeStr = enrich.tfms?.route || enrich.flightroute?.route || null
      if (routeStr) {
        try {
          const waypoints = parseRoute(routeStr)
          // Prepend origin and append destination so the polyline is anchored
          // to the airports even if the filed route only lists en-route fixes.
          const anchored = [
            { name: orig.icao_code || 'ORIG', lat: orig.latitude, lon: orig.longitude },
            ...waypoints,
            { name: dest.icao_code || 'DEST', lat: dest.latitude, lon: dest.longitude },
          ]
          if (anchored.length >= 2) {
            const polyDist = polylineCrossTrackDistKm(f.lat, f.lon, anchored)
            if (Number.isFinite(polyDist)) {
              deviation = polyDist
              // Only count as polyline-mode if we resolved at least one intermediate fix
              if (waypoints.length >= 1) mode = 'polyline'
            }
          }
        } catch {}
      }

      // Fall back to straight great-circle between dep and arr
      if (deviation == null) {
        deviation = crossTrackDistKm(
          f.lat, f.lon,
          orig.latitude, orig.longitude,
          dest.latitude, dest.longitude
        )
      }

      enrich.routeDeviation = Math.round(deviation)
      enrich.routeDeviationMode = mode
    }
  }

  // Persist to cache so getFlights() can attach it to flight payloads.
  // (Previously this was missing — buildEnrichment mutated the local enrich
  // object every cycle but never wrote it back, so TFMS/route data only ever
  // appeared on flights that ALSO got APL-enriched via the anomaly path.)
  if (Object.keys(enrich).length > 0) {
    enrich._ts = Date.now()
    enrichCache.set(f.icao, enrich)
    if (enrichCache.size > MAX_ENRICH_CACHE) {
      const first = enrichCache.keys().next().value
      enrichCache.delete(first)
    }
    return enrich
  }
  return null
}

// Great-circle cross-track distance: how far a point is from the line between two points (km)
function crossTrackDistKm(pLat, pLon, aLat, aLon, bLat, bLon) {
  const R = 6371
  const toRad = d => d * Math.PI / 180
  const pLatR = toRad(pLat), pLonR = toRad(pLon)
  const aLatR = toRad(aLat), aLonR = toRad(aLon)
  const bLatR = toRad(bLat), bLonR = toRad(bLon)

  // Angular distance from A to P
  const dAP = 2 * Math.asin(Math.sqrt(
    Math.sin((pLatR - aLatR) / 2) ** 2 +
    Math.cos(aLatR) * Math.cos(pLatR) * Math.sin((pLonR - aLonR) / 2) ** 2
  ))
  // Bearing from A to B
  const brngAB = Math.atan2(
    Math.sin(bLonR - aLonR) * Math.cos(bLatR),
    Math.cos(aLatR) * Math.sin(bLatR) - Math.sin(aLatR) * Math.cos(bLatR) * Math.cos(bLonR - aLonR)
  )
  // Bearing from A to P
  const brngAP = Math.atan2(
    Math.sin(pLonR - aLonR) * Math.cos(pLatR),
    Math.cos(aLatR) * Math.sin(pLatR) - Math.sin(aLatR) * Math.cos(pLatR) * Math.cos(pLonR - aLonR)
  )
  return Math.abs(Math.asin(Math.sin(dAP) * Math.sin(brngAP - brngAB)) * R)
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

// ── Flight lifecycle cleanup ────────────────────────────────────────────────
// End-to-end flight tracking: when a flight lands, drop its rows immediately
// instead of waiting for the 2h time-based retention. Signals used (any one
// fires the cleanup):
//
//   1. TFMS flight_plan.ata is set (authoritative, 1–5 min after touchdown)
//   2. STDDS surface_events ON event matches the callsign (~40 majors only)
//   3. grounded=1 for GROUNDED_STREAK_THRESHOLD cycles AND within
//      NEAR_DEST_NM of the TFMS destination airport
//   4. No sighting in LOST_AFTER_MS (5 min) — treat as landed/lost
//
// On detection: cascade-delete sightings, anomalies, flight_positions, and
// flight_plans for the flight, plus clear in-memory poller state for the icao.
// A per-callsign TTL (purgedCallsigns) prevents re-purging the same flight
// within 30 min if a stale ata signal retriggers.

function distNm(lat1, lon1, lat2, lon2) {
  // Haversine great-circle distance in nautical miles.
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity
  const R = 3440.065 // Earth radius, nm
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function clearPollerStateForIcao(icao) {
  trackHistory.delete(icao)
  activeAnomalies.delete(icao)
  anomalyMisses.delete(icao)
  pendingAnomalies.delete(icao)
  enrichCache.delete(icao)
  groundedStreak.delete(icao)
}

async function cleanupLandedFlights(flights) {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const landedCallsigns = new Set()
  const stats = { tfms: 0, stdds: 0, nearDest: 0, lost: 0 }

  // Signal 1: TFMS ata set since last check.
  try {
    const tfmsLanded = db.getLandedFlightPlans(lastLifecycleCheckIso)
    stats.tfms = tfmsLanded.length
    for (const acid of tfmsLanded) if (acid) landedCallsigns.add(acid)
  } catch (err) {
    console.warn('lifecycle: tfms landed lookup failed:', err.message)
  }

  // Signal 2: STDDS ON events since last check.
  try {
    const stddsLanded = db.getLandingSurfaceEvents(lastLifecycleCheckIso)
    stats.stdds = stddsLanded.length
    for (const cs of stddsLanded) if (cs) landedCallsigns.add(cs)
  } catch (err) {
    console.warn('lifecycle: stdds landed lookup failed:', err.message)
  }

  lastLifecycleCheckIso = nowIso

  // Signal 3: grounded streak near destination airport.
  const seenIcaos = new Set()
  for (const f of flights) {
    seenIcaos.add(f.icao)
    if (f.grounded) {
      const streak = (groundedStreak.get(f.icao) || 0) + 1
      groundedStreak.set(f.icao, streak)
      if (streak >= GROUNDED_STREAK_THRESHOLD && f.callsign) {
        const enrich = enrichCache.get(f.icao)
        const destLat = enrich?.tfms?.arr_lat ?? enrich?.flightroute?.destination?.latitude
        const destLon = enrich?.tfms?.arr_lon ?? enrich?.flightroute?.destination?.longitude
        if (destLat != null && destLon != null) {
          if (distNm(f.lat, f.lon, destLat, destLon) < NEAR_DEST_NM) {
            landedCallsigns.add(f.callsign)
            stats.nearDest++
          }
        }
      }
    } else {
      groundedStreak.delete(f.icao)
    }
  }

  // Signal 4: aircraft in trackHistory that we haven't seen this cycle and
  // whose last sample is older than LOST_AFTER_MS. Treat as landed/lost.
  const lostIcaos = []
  for (const [icao, snapshots] of trackHistory.entries()) {
    if (seenIcaos.has(icao)) continue
    const lastSnap = snapshots[snapshots.length - 1]
    if (!lastSnap?.ts) continue
    if (now - lastSnap.ts > LOST_AFTER_MS) {
      lostIcaos.push(icao)
    }
  }
  stats.lost = lostIcaos.length

  // Map callsigns to icaos using the current poll's flight list so cascade
  // delete hits both identifier columns.
  const csToIcao = new Map()
  for (const f of flights) {
    if (f.callsign && landedCallsigns.has(f.callsign)) {
      csToIcao.set(f.callsign, f.icao)
    }
  }

  // Skip callsigns already purged within the TTL window (dedup the signals).
  const fresh = []
  for (const cs of landedCallsigns) {
    const exp = purgedCallsigns.get(cs)
    if (!exp || exp <= now) fresh.push(cs)
  }

  let totalRowsDeleted = 0

  // Cap per-cycle work at MAX_CLEANUP_PER_CYCLE flights. Anything over the
  // cap is deferred to subsequent cycles (the lost icaos stay in
  // trackHistory and re-trigger next time, which is the same end state).
  // Without this cap, a single recovery from a wedge could blast 1000+
  // cascade-deletes into the loop in one shot — observed: 1007 flights
  // × ~20 rows each = 20k DB ops in rapid succession, which then wedges
  // the loop again. The cap turns a recovery cliff into a recovery slope.
  const MAX_CLEANUP_PER_CYCLE = 100
  const overCap = (fresh.length + lostIcaos.length) > MAX_CLEANUP_PER_CYCLE
  if (overCap) {
    console.warn(
      `lifecycle: ${fresh.length + lostIcaos.length} flights to clean ` +
      `(over ${MAX_CLEANUP_PER_CYCLE} cap); deferring rest to next cycle`
    )
  }
  // Slice to the cap. fresh first (signal-driven), then lost (filler).
  const freshSlice = fresh.slice(0, MAX_CLEANUP_PER_CYCLE)
  const lostBudget = Math.max(0, MAX_CLEANUP_PER_CYCLE - freshSlice.length)
  const lostSlice = lostIcaos.slice(0, lostBudget)

  // Cascade delete for each landed callsign. Unknown icao is OK — the delete
  // just skips the icao-keyed tables. Yield every CLEANUP_CHUNK deletes so a
  // big batch doesn't block the event loop for 5+ seconds.
  const CLEANUP_CHUNK = 20
  let chunkCounter = 0
  for (const cs of freshSlice) {
    const icao = csToIcao.get(cs) || null
    try {
      totalRowsDeleted += db.deleteFlightArtifacts({ icao, callsign: cs })
    } catch (err) {
      console.warn('lifecycle: cascade delete failed for', cs, err.message)
    }
    if (icao) clearPollerStateForIcao(icao)
    purgedCallsigns.set(cs, now + PURGED_TTL_MS)
    if (++chunkCounter % CLEANUP_CHUNK === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // Lost-from-feed aircraft: we have the icao but may not know the callsign.
  // Last-known callsign from the trackHistory snapshot lets us also drop the
  // flight_plans + flight_positions rows. Capped via lostSlice above.
  for (const icao of lostSlice) {
    const snapshots = trackHistory.get(icao)
    const lastCall = snapshots?.[snapshots.length - 1]?.callsign || null
    try {
      totalRowsDeleted += db.deleteFlightArtifacts({ icao, callsign: lastCall })
    } catch (err) {
      console.warn('lifecycle: cascade delete failed for lost icao', icao, err.message)
    }
    clearPollerStateForIcao(icao)
    if (lastCall) purgedCallsigns.set(lastCall, now + PURGED_TTL_MS)
    if (++chunkCounter % CLEANUP_CHUNK === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // GC expired purgedCallsigns entries so the Map doesn't leak.
  for (const [cs, exp] of purgedCallsigns) {
    if (exp < now) purgedCallsigns.delete(cs)
  }

  const purgedNow = freshSlice.length + lostSlice.length
  const deferred = (fresh.length + lostIcaos.length) - purgedNow
  if (purgedNow > 0) {
    console.log(
      `lifecycle: purged ${purgedNow} landed/lost flights ` +
      `(tfms=${stats.tfms}, stdds=${stats.stdds}, nearDest=${stats.nearDest}, ` +
      `lost=${stats.lost}, rows=${totalRowsDeleted}` +
      (deferred > 0 ? `, deferred=${deferred}` : '') +
      `)`
    )
  }
}

// ── Core polling cycle ───────────────────────────────────────────────────────

async function pollCycle() {
  const region = process.env.POLL_REGION || 'usa'

  // 1. Fetch flight data (retry once with next key on 429/401)
  let flights
  try {
    flights = await fetchOpenSky(region)
  } catch (err) {
    if ((err.response?.status === 429 || err.response?.status === 401) && OS_KEY_SLOTS.length > 1) {
      console.log(`poller: retrying immediately with key ${activeKeySlot + 1}`)
      try {
        flights = await fetchOpenSky(region)
      } catch (retryErr) {
        return
      }
    } else {
      return
    }
  }

  if (!flights.length) return

  // Store latest flights for API consumers
  latestFlights = flights
  lastFetchAt = Date.now()

  // Persist sightings to DB only when anomaly detection is on. Sightings are
  // the input to anomaly history; without scoring, they're write-only data.
  if (ANOMALY_DETECTION_ENABLED) {
    try {
      await db.recordSightingsChunked(flights, 'opensky', region)
    } catch (err) {
      console.error('poller: sightings record error:', err.message)
    }
  }

  // 2a. Enrich ALL flights with TFMS + flightroute data first (cheap DB lookups,
  //     no HTTP). The dashboard's flight list reads from enrichCache so this
  //     is needed even when anomaly detection is off. Chunked with setImmediate
  //     yields so that 7000+ DB lookups don't block the event loop in one shot.
  const ENRICH_CHUNK = 500
  for (let i = 0; i < flights.length; i += ENRICH_CHUNK) {
    const slice = flights.slice(i, i + ENRICH_CHUNK)
    for (const f of slice) buildEnrichment(f)
    if (i + ENRICH_CHUNK < flights.length) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // When anomaly detection is off, the dashboard has everything it needs
  // (latestFlights + enrichCache + the kicked-off background HTTP enrichment).
  // Skip scoring, persistence gating, weather context, anomaly resolution,
  // and recordAnomalies — all anomaly-only work. But we still maintain
  // trackHistory (for the lost-from-feed lifecycle signal) and run the
  // landed-flight cleanup.
  if (!ANOMALY_DETECTION_ENABLED) {
    enrichAircraftBackground(flights).catch((err) =>
      console.warn('poller: background enrichment error:', err.message)
    )
    updateTrackHistory(flights)
    await cleanupLandedFlights(flights)
    return
  }

  // 2b. Score each aircraft BEFORE updating history.
  //    scoreAnomaly compares current flight against the last snapshot (prev).
  //    If we update history first, prev === current and all deltas are 0.
  //
  //    IMPORTANT: this loop must yield the event loop every SCORE_CHUNK flights.
  //    scoreAnomaly is CPU-heavy JS (branching + math) and we also do two DB
  //    reads per flight with a TFMS destination. With 6000–7000 flights/cycle,
  //    the unchunked version blocked the event loop for 20–40s, which tripped
  //    Fly health checks and caused the SWIM worker's HTTP POSTs to time out.
  //
  //    Destination-airport lookups (flow events, terminal weather) are memoized
  //    for the duration of this cycle — many flights share the same arr_arpt,
  //    so without memoization we'd hit the DB ~2000x per cycle for ~300 unique
  //    destinations.
  const newAnomalies = {}
  const anomalyFlights = []
  let enrichStats = { scored: 0, withRoute: 0, withApl: 0, withAdsbfi: 0, withAny: 0 }

  const flowEventsByArpt = new Map()
  const terminalWxByArpt = new Map()
  const getFlowEventsCached = (arpt) => {
    if (flowEventsByArpt.has(arpt)) return flowEventsByArpt.get(arpt)
    const v = db.getFlowEventsByAirport(arpt, 5)
    flowEventsByArpt.set(arpt, v)
    return v
  }
  const getTerminalWxCached = (arpt) => {
    if (terminalWxByArpt.has(arpt)) return terminalWxByArpt.get(arpt)
    const v = db.getTerminalWeatherByAirport ? db.getTerminalWeatherByAirport(arpt, 5) : []
    terminalWxByArpt.set(arpt, v)
    return v
  }

  const SCORE_CHUNK = 500
  for (let ci = 0; ci < flights.length; ci += SCORE_CHUNK) {
    const slice = flights.slice(ci, ci + SCORE_CHUNK)
    for (const f of slice) {
      const hist = trackHistory.get(f.icao)
      if (!hist || hist.length < 2) continue

      const enrich = buildEnrichment(f)
      enrichStats.scored++
      if (enrich?.flightroute) enrichStats.withRoute++
      if (enrich?.apl) enrichStats.withApl++
      if (enrich?.adsbfi) enrichStats.withAdsbfi++
      if (enrich) enrichStats.withAny++

      // Inject destination flow events + weather for TFMS-aware scoring (steps 17-18)
      if (enrich?.tfms?.arr_arpt) {
        try {
          const destArpt = enrich.tfms.arr_arpt
          const flowEvts = getFlowEventsCached(destArpt)
          if (flowEvts.length > 0) {
            enrich._destFlowEvents = {
              hasGS: flowEvts.some(e => e.event_type === 'GS'),
              hasGDP: flowEvts.some(e => e.event_type === 'GDP'),
            }
          }
          const wxEvts = getTerminalWxCached(destArpt)
          if (wxEvts.length > 0) {
            enrich._destWeather = wxEvts
          }
        } catch {}
      }

      // Look up per-route baseline if route is known
      let baseline = null
      if (enrich?.flightroute) {
        const orig = enrich.flightroute.origin?.icao_code
        const dest = enrich.flightroute.destination?.icao_code
        if (orig && dest) {
          const key = `${orig}→${dest}`
          baseline = baselineCache.get(key) || null
        }
      }

      const result = scoreAnomaly(hist, f, enrich, weatherContext, flights, baseline)

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
    if (ci + SCORE_CHUNK < flights.length) {
      await new Promise((resolve) => setImmediate(resolve))
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
        // Chunked with setImmediate yields — anomalyFlights can run 200–300
        // entries and each iteration calls scoreAnomaly again, so without
        // yielding this block alone can freeze the loop for 1–2s.
        const RESCORE_CHUNK = 100
        for (let ai = 0; ai < anomalyFlights.length; ai += RESCORE_CHUNK) {
          const slice = anomalyFlights.slice(ai, ai + RESCORE_CHUNK)
          for (const f of slice) {
            const apl = aplData.get(f.icao)
            if (!apl) continue

            // Store in enrichment cache for future cycles
            const existing = enrichCache.get(f.icao) || {}
            existing.apl = apl
            existing._ts = Date.now()
            enrichCache.set(f.icao, existing)

            // Evict oldest entries if cache exceeds cap
            if (enrichCache.size > MAX_ENRICH_CACHE) {
              const first = enrichCache.keys().next().value
              enrichCache.delete(first)
            }

            // Re-score with enrichment
            const hist = trackHistory.get(f.icao)
            if (!hist || hist.length < 2) continue
            const enrich = buildEnrichment(f)
            // Look up route baseline for re-scoring
            let reBaseline = null
            if (enrich?.flightroute) {
              const orig = enrich.flightroute.origin?.icao_code
              const dest = enrich.flightroute.destination?.icao_code
              if (orig && dest) reBaseline = baselineCache.get(`${orig}→${dest}`) || null
            }
            const result = scoreAnomaly(hist, f, enrich, weatherContext, flights, reBaseline)

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
          if (ai + RESCORE_CHUNK < anomalyFlights.length) {
            await new Promise((resolve) => setImmediate(resolve))
          }
        }
      }
    } catch (err) {
      console.warn('poller: APL enrichment failed:', err.message)
    }
  }

  // 4. Persistence gate — require MEDIUM anomalies to persist for 2 consecutive
  //    cycles before emitting. This eliminates single-sample noise (turbulence
  //    bumps, GPS jitter, momentary transponder spikes). CRITICAL and HIGH
  //    severity bypass the gate — genuine emergencies should never be delayed.
  const PERSIST_CYCLES = 2
  const gatedIcaos = []
  for (const [icao, anomaly] of Object.entries(newAnomalies)) {
    // Already active — no need to gate again
    if (activeAnomalies.has(icao)) continue

    // CRITICAL/HIGH bypass — emit immediately
    if (anomaly.severity === 'CRITICAL' || anomaly.severity === 'HIGH') {
      pendingAnomalies.delete(icao)
      continue
    }

    // MEDIUM — must persist across multiple cycles
    const pending = pendingAnomalies.get(icao)
    if (pending) {
      pending.cycles++
      if (pending.cycles >= PERSIST_CYCLES) {
        // Confirmed — promote to real anomaly
        pendingAnomalies.delete(icao)
        // Keep in newAnomalies — it will be emitted
      } else {
        // Not yet confirmed — hold back
        gatedIcaos.push(icao)
      }
    } else {
      // First sighting — add to pending, don't emit yet
      pendingAnomalies.set(icao, { anomaly, cycles: 1 })
      gatedIcaos.push(icao)
    }
  }
  for (const icao of gatedIcaos) delete newAnomalies[icao]

  // Clear pending entries that didn't re-score this cycle (transient noise)
  for (const icao of pendingAnomalies.keys()) {
    if (!gatedIcaos.includes(icao) && !newAnomalies[icao]) {
      pendingAnomalies.delete(icao)
    }
  }

  // 5. Update track history (after scoring, so prev ≠ current)
  updateTrackHistory(flights)

  // 6. Anomaly lifecycle — grace period & resolution
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

  // 7. Persist + emit new anomalies
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

    console.log(`poller: ${flights.length} flights, ${anomalyList.length} anomalies (${resolvedIcaos.length} resolved) | enrichment: ${enrichStats.scored} scored, ${enrichStats.withRoute} route (${enrichStats.scored > 0 ? Math.round(enrichStats.withRoute / enrichStats.scored * 100) : 0}%), ${enrichStats.withAny} any`)
  } else {
    // No anomalies — still update weather context to null for next cycle
    if (weatherContext) weatherContext = null
    console.log(`poller: ${flights.length} flights, 0 anomalies (${resolvedIcaos.length} resolved) | enrichment: ${enrichStats.scored} scored, ${enrichStats.withRoute} route (${enrichStats.scored > 0 ? Math.round(enrichStats.withRoute / enrichStats.scored * 100) : 0}%)`)
  }

  // 8. Persist route deviations to flight_plans table (for analytics aggregation)
  try {
    const updateDev = db.db.prepare('UPDATE flight_plans SET route_deviation = ? WHERE acid = ?')
    const batch = db.db.transaction((items) => { for (const [dev, acid] of items) updateDev.run(dev, acid) })
    const deviations = []
    for (const f of flights) {
      const enrich = enrichCache.get(f.icao)
      if (enrich?.routeDeviation != null && f.callsign) {
        deviations.push([enrich.routeDeviation, f.callsign])
      }
    }
    if (deviations.length > 0) batch(deviations)
  } catch {}

  // 9. Background aircraft enrichment (non-blocking, runs between cycles)
  enrichAircraftBackground(flights).catch(err =>
    console.warn('poller: background enrichment error:', err.message)
  )

  // 10. Flight lifecycle cleanup — drop rows for flights that just landed
  //     (TFMS ata, STDDS ON, grounded+near-dest, or lost from feed).
  //     Cheap: ~50–100ms, bounded by number of landings since last cycle.
  try {
    await cleanupLandedFlights(flights)
  } catch (err) {
    console.warn('poller: lifecycle cleanup error:', err.message)
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Load route baselines into memory from DB
function refreshBaselines() {
  try {
    const all = db.getAllBaselines()
    baselineCache = new Map()
    for (const b of all) {
      baselineCache.set(`${b.origin_icao}→${b.destination_icao}`, b)
    }
    if (all.length > 0) console.log(`poller: loaded ${all.length} route baselines`)
  } catch (err) {
    console.warn('poller: baseline load failed:', err.message)
  }
}

function start() {
  if (running) return
  running = true

  console.log(`poller: starting (interval: ${POLL_INTERVAL / 1000}s, region: ${process.env.POLL_REGION || 'usa'}, keys: ${OS_KEY_SLOTS.length}, anomaly: ${ANOMALY_DETECTION_ENABLED ? 'on' : 'off'})`)
  for (let i = 0; i < OS_KEY_SLOTS.length; i++) {
    console.log(`poller:   key ${i + 1}: ${OS_KEY_SLOTS[i].id.substring(0, 12)}...`)
  }

  // Route baselines and rebuilds are only used by anomaly scoring. Skip when off.
  if (ANOMALY_DETECTION_ENABLED) {
    refreshBaselines()
    baselineTimer = setInterval(() => {
      try {
        const count = db.buildRouteBaselines()
        if (count > 0) {
          console.log(`poller: rebuilt ${count} route baselines`)
          refreshBaselines()
        }
      } catch (err) {
        console.warn('poller: baseline rebuild failed:', err.message)
      }
    }, 6 * 60 * 60 * 1000)
  }

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
  if (baselineTimer) { clearInterval(baselineTimer); baselineTimer = null }
  console.log('poller: stopped')
}

function getStatus() {
  return {
    running,
    interval: POLL_INTERVAL,
    region: process.env.POLL_REGION || 'usa',
    // When anomaly detection is off we don't maintain trackHistory, so report
    // the latest flight count instead — the readiness check just wants proof
    // that the poller has completed at least one cycle.
    trackedAircraft: trackHistory.size > 0 ? trackHistory.size : latestFlights.length,
    activeAnomalies: activeAnomalies.size,
    pendingMisses: anomalyMisses.size,
  }
}

function getFlights() {
  // Merge aircraft cache (type/reg/operator) + TFMS enrichment into flight objects
  const icaos = latestFlights.map(f => f.icao)
  const acCache = icaos.length > 0 ? db.getAircraftCacheBulk(icaos) : {}

  const flights = latestFlights.map(f => {
    const out = { ...f }
    const ac = acCache[f.icao]
    if (ac?.type) {
      out.acType = ac.type; out.acReg = ac.reg; out.acDesc = ac.desc; out.acOperator = ac.operator
    }
    // Attach TFMS enrichment from cache
    const enrich = enrichCache.get(f.icao)
    if (enrich?.tfms) {
      out.tfms = enrich.tfms
    }
    if (enrich?.routeDeviation != null) {
      out.routeDeviation = enrich.routeDeviation
      out.routeDeviationMode = enrich.routeDeviationMode || 'gc'
    }
    return out
  })

  return {
    flights,
    fetchedAt: lastFetchAt,
    region: process.env.POLL_REGION || 'usa',
    count: flights.length,
    pollInterval: POLL_INTERVAL,
  }
}

// Aggregate route deviations from live enrichment cache (works without TFMS)
function getRouteDeviationsLive(minDevKm = 20, limit = 25) {
  const routePairs = new Map() // "DEP→ARR" -> { flights, totalDev, maxDev }
  for (const f of latestFlights) {
    const enrich = enrichCache.get(f.icao)
    if (!enrich?.routeDeviation || enrich.routeDeviation < minDevKm) continue
    const route = enrich.flightroute || (enrich.tfms && {
      origin: { icao_code: enrich.tfms.dep_arpt },
      destination: { icao_code: enrich.tfms.arr_arpt },
    })
    if (!route?.origin?.icao_code || !route?.destination?.icao_code) continue
    const dep = route.origin.icao_code
    const arr = route.destination.icao_code
    const key = `${dep}→${arr}`
    const existing = routePairs.get(key) || { dep_arpt: dep, arr_arpt: arr, flights: 0, totalDev: 0, max_km: 0 }
    existing.flights++
    existing.totalDev += enrich.routeDeviation
    existing.max_km = Math.max(existing.max_km, enrich.routeDeviation)
    routePairs.set(key, existing)
  }
  return Array.from(routePairs.values())
    .map(r => ({ ...r, avg_km: Math.round(r.totalDev / r.flights * 10) / 10, totalDev: undefined }))
    .sort((a, b) => b.avg_km - a.avg_km)
    .slice(0, limit)
}

module.exports = {
  start,
  stop,
  getStatus,
  getFlights,
  getRouteDeviationsLive,
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
    enrichCache,
    resetFlights() { latestFlights = []; lastFetchAt = null },
    _setTestFlights(flights) { latestFlights = flights || [] },
  },
}
