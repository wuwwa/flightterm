import { useState, useEffect, useRef, useCallback } from 'react'

import TopBar from './components/TopBar'
import ControlBar from './components/ControlBar'
import LogPanel from './components/LogPanel'
import FlightTable from './components/FlightTable'
import DetailPanel from './components/DetailPanel'
import SettingsModal from './components/SettingsModal'
import UsagePanel from './components/UsagePanel'
import NotamPanel from './components/NotamPanel'
import DashboardPanel from './components/DashboardPanel'

import { fetchStates } from './services/opensky'
import { fetchAdsbx } from './services/adsbx'
import { fetchAplByHex } from './services/airplaneslive'
import { enrichFlight, fetchRouteOnly } from './services/adsbdb'
import { enrichByHex } from './services/adsbfi'
import { checkHealth, fetchAeroSpend } from './services/aeroapi'

import { recordSightings, fetchOpenSkyUsageToday, fetchAircraftTrack, recordAnomalies, resolveAnomalies, lookupRoutes, saveRoutes } from './services/sightings'
import { scoreAnomaly, ANOMALY_THRESHOLD } from './utils/anomaly'
import { fetchMetars, fetchPireps, fetchSigmets, summarizePireps, summarizeSigmets } from './services/weather'

// ── default settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  sourcePref: 'auto',
  adsbxKey: '',
  adsbxRadius: 100,
  interval: 90,
  userAeroKey: '',
  userOsClientId: '',
  userOsClientSecret: '',
}

function loadSettings() {
  try {
    const s = localStorage.getItem('ft_cfg')
    return s
      ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) }
      : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem('ft_cfg', JSON.stringify(s))
  } catch {}
}

// ── log helper ────────────────────────────────────────────────────────────────
function makeEntry(msg, type = '') {
  return {
    msg,
    type,
    time: new Date().toISOString().substring(11, 19),
    ts: Date.now(),
  }
}

export default function App() {
  // ── core state ──────────────────────────────────────────────────────────────
  const [flights, setFlights] = useState([])
  const [logEntries, setLogEntries] = useState([])
  const [settings, setSettings] = useState(loadSettings)
  const [region, setRegion] = useState('usa')
  const [filter, setFilter] = useState('')
  const [fetching, setFetching] = useState(false)
  const [autoOn, setAutoOn] = useState(false)
  const [activeSource, setActiveSource] = useState('opensky')
  const [backendOk, setBackendOk] = useState(false)
  const [statusText, setStatusText] = useState('idle')
  const [lastFetchAt, setLastFetchAt] = useState(null)
  const [openskyUsage, setOpenskyUsage] = useState(null)
  const [aeroSpend, setAeroSpend] = useState(null)

  // ── UI overlay state ────────────────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const [showNotams, setShowNotams] = useState(false)

  // ── sidebar resize state ───────────────────────────────────────────────────
  const [sidebarW, setSidebarW] = useState(360)
  const draggingRef = useRef(false)

  useEffect(() => {
    const onMove = (e) => {
      if (!draggingRef.current) return
      const w = window.innerWidth - e.clientX
      setSidebarW(Math.max(200, Math.min(600, w)))
    }
    const onUp = () => { draggingRef.current = false; document.body.style.cursor = '' }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // ── detail / enrichment state ───────────────────────────────────────────────
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [enrichCache, setEnrichCache] = useState({})
  const [aeroCache, setAeroCache] = useState({})

  // ── flight tracking history (per-icao, last N snapshots) ────────────────────
  const [trackHistory, setTrackHistory] = useState({})
  const trackHistoryRef = useRef({})
  trackHistoryRef.current = trackHistory

  // ── anomalies: icaos with sudden alt/vel changes ──────────────────────────
  const [anomalies, setAnomalies] = useState({}) // { icao: { score, phase, reasons[], confirmed, label } }

  // ── weather context from previous fetch cycle (available for scoring) ──────
  const weatherRef = useRef(null) // { sigmets: {...}, pireps: {...} }

  // ── route cache: callsign → { destination_lat, destination_lon, destination_icao, ... }
  const routeCacheRef = useRef({})    // in-memory mirror of backend cache
  const enrichQueueRef = useRef([])   // callsigns waiting for ADSBdb enrichment
  const enrichingRef = useRef(false)  // is the background enrichment loop running?

  // ── auto-refresh ref ────────────────────────────────────────────────────────
  const autoRef = useRef(null)
  const fetchFlightsRef = useRef(null)
  const openskyUsageRef = useRef(null)
  openskyUsageRef.current = openskyUsage

  const anomalyMissRef = useRef({})      // icao → consecutive miss count (grace period before resolve)

  // ── logging ──────────────────────────────────────────────────────────────────
  const log = useCallback((msg, type = '') => {
    setLogEntries((prev) => [...prev.slice(-199), makeEntry(msg, type)])
  }, [])

  const clearLog = useCallback(() => {
    setLogEntries([makeEntry('log cleared', 'info')])
  }, [])

  // ── background route enrichment queue (1 req/sec to ADSBdb) ─────────────────
  // Processes unknown callsigns in the background, saves results to backend cache.
  // Self-corrects stale entries when heading doesn't match cached destination.
  const startEnrichQueue = useCallback(() => {
    if (enrichingRef.current) return // already running
    enrichingRef.current = true

    async function processQueue() {
      while (enrichQueueRef.current.length > 0) {
        const cs = enrichQueueRef.current.shift()
        try {
          const route = await fetchRouteOnly(cs)
          if (route?.destination) {
            const destLat = route.destination.latitude ?? route.destination.lat
            const destLon = route.destination.longitude ?? route.destination.lon
            const originLat = route.origin?.latitude ?? route.origin?.lat
            const originLon = route.origin?.longitude ?? route.origin?.lon

            if (destLat != null && destLon != null) {
              const entry = {
                callsign: cs,
                origin_icao: route.origin?.icao_code || route.origin?.iata_code || null,
                origin_lat: originLat ?? null,
                origin_lon: originLon ?? null,
                destination_icao: route.destination?.icao_code || route.destination?.iata_code || null,
                destination_lat: destLat,
                destination_lon: destLon,
                source: route._source || 'adsbdb',
              }
              // Save to backend + local cache
              saveRoutes([entry]).catch(() => {})
              routeCacheRef.current[cs] = entry
            }
          }
        } catch {}
        // Rate limit: 1 req/sec
        if (enrichQueueRef.current.length > 0) {
          await new Promise(r => setTimeout(r, 1100))
        }
      }
      enrichingRef.current = false
    }

    processQueue()
  }, [])

  // ── refresh usage from backend ───────────────────────────────────────────────
  const refreshAeroSpend = useCallback(() => {
    fetchAeroSpend()
      .then(setAeroSpend)
      .catch(() => {})
  }, [])

  const refreshOpenskyUsage = useCallback(() => {
    fetchOpenSkyUsageToday()
      .then(setOpenskyUsage)
      .catch(() => {})
  }, [])

  // ── loading state for initial boot ──────────────────────────────────────────
  const [booting, setBooting] = useState(true)
  const [bootMsg, setBootMsg] = useState('connecting to backend…')

  // ── backend health check → initial fetch → auto ────────────────────────────
  useEffect(() => {
    const isProd = !window.location.hostname.includes('localhost')
    let cancelled = false

    log('flightterm v4 booting…', 'info')
    console.log('[boot] starting — isProd:', isProd)

    // Retry health check up to 10 times (covers Fly cold start)
    async function waitForBackend(retries = 10, delay = 2000) {
      for (let i = 0; i < retries; i++) {
        try {
          console.log(`[boot] health check attempt ${i + 1}/${retries}`)
          setBootMsg(i === 0 ? 'connecting to backend…' : `waiting for backend… (${i + 1}/${retries})`)
          if (i > 0) log(`backend: retrying… (${i + 1}/${retries})`, 'warn')
          const d = await checkHealth()
          if (cancelled) return null
          setBackendOk(true)
          log(`backend ok · opensky: ${d.opensky_configured ? '✓' : '✗'} · aeroapi: ${d.aeroapi_configured ? '✓' : '✗'} · notam: ${d.faa_notam_configured ? '✓' : '✗'}`, 'ok')
          console.log('[boot] backend ready')
          return d
        } catch {
          if (cancelled) return null
          if (i < retries - 1) {
            console.log(`[boot] backend not ready, retrying in ${delay}ms`)
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
      setBackendOk(false)
      log('backend offline — start the Express server (cd backend && npm run dev)', 'warn')
      console.log('[boot] backend unreachable after retries')
      return null
    }

    async function boot() {
      log('connecting to backend…', 'info')
      const health = await waitForBackend()
      if (cancelled) return

      if (health) {
        log('loading usage data…', 'info')
        setBootMsg('loading usage data…')
        console.log('[boot] refreshing usage data')
        await Promise.allSettled([refreshAeroSpend(), refreshOpenskyUsage()])
        log('usage data loaded', 'ok')
      }

      if (isProd && health) {
        log('fetching initial flight data…', 'info')
        setBootMsg('fetching flights…')
        console.log('[boot] initial fetch')
        await fetchFlightsRef.current?.()
        if (cancelled) return
        log(`auto-refresh enabled (${settings.interval}s)`, 'ok')
        console.log('[boot] enabling auto-refresh')
        setAutoOn(true)
      }

      setBooting(false)
      setBootMsg('')
      log('flightterm v4 ready', 'ok')
      console.log('[boot] complete')
    }

    boot()
    return () => { cancelled = true }
  }, [])

  // ── resolve which source to actually use ─────────────────────────────────────
  // OpenSky is primary for fleet scanning (one bbox call, instant).
  // ADSBx if user has a key. Airplanes.live is used to enrich anomalies only.
  function resolveSource() {
    if (settings.sourcePref === 'adsbx') return 'adsbx'
    if (settings.sourcePref === 'opensky') return 'opensky'
    return settings.adsbxKey ? 'adsbx' : 'opensky'
  }

  // ── fetch flights ─────────────────────────────────────────────────────────────
  const fetchFlights = useCallback(async () => {
    if (fetching) return

    const src = resolveSource()

    // ── credit guard (opensky only) ──────────────────────────────────────────
    if (src === 'opensky' && openskyUsageRef.current?.remaining <= 0) {
      log('opensky: daily credit limit reached — fetch blocked', 'err')
      return
    }

    setFetching(true)
    setStatusText('fetching')
    const t0 = performance.now()

    let result = null
    let usedSource = src

    // ── ADSBx (paid, unfiltered) ─────────────────────────────────────────────
    if (src === 'adsbx') {
      try {
        log(`adsbx: querying lat/lon radius ${settings.adsbxRadius}nm · region=${region}`, 'info')
        const { flights: f, remaining } = await fetchAdsbx(region, settings.adsbxKey, settings.adsbxRadius)
        result = f
        setActiveSource('adsbx')
        const ms = Math.round(performance.now() - t0)
        log(`adsbx: ${f.length} aircraft (${ms}ms)${remaining ? ` · quota remaining: ${remaining}` : ''}`, 'ok')
        const mil = f.filter(x => x.mil).length
        if (mil > 0) log(`adsbx: ${mil} military aircraft in feed`, 'warn')
      } catch (err) {
        log(`adsbx failed (${err.message}) — falling back to opensky`, 'warn')
        usedSource = 'opensky'
      }
    }

    // ── OpenSky (primary, free, bounding box) ────────────────────────────────
    if ((src === 'opensky' || usedSource === 'opensky') && result === null) {
      try {
        log(`opensky: GET states/all · region=${region}`, 'info')
        const resp = await fetchStates(region, {
          osClientId: settings.userOsClientId,
          osClientSecret: settings.userOsClientSecret,
        })
        result = resp.flights
        setActiveSource('opensky')
        const ms = Math.round(performance.now() - t0)
        log(`opensky: ${result.length} state vectors received (${ms}ms)`, 'ok')
        refreshOpenskyUsage()
      } catch (err) {
        log(`opensky error: ${err.message}`, 'err')
        result = []
      }
    }

    if (result && result.length > 0) {
      setFlights(result)
      setLastFetchAt(Date.now())

      // ── track history snapshots per aircraft ────────────────────────────
      const MAX_SNAPSHOTS = 30
      const now = Date.now()
      setTrackHistory((prev) => {
        const next = { ...prev }
        for (const f of result) {
          if (f.alt == null && f.vel == null) continue
          const arr = next[f.icao] ? [...next[f.icao]] : []
          arr.push({ ts: now, lat: f.lat, lon: f.lon, alt: f.alt, vel: f.vel, hdg: f.hdg, grounded: f.grounded, vertRate: f.vertRate, geoAlt: f.geoAlt, posSrc: f.posSrc, ndb: f.ndb })
          if (arr.length > MAX_SNAPSHOTS) arr.shift()
          next[f.icao] = arr
        }
        return next
      })

      // ── route lookup for diversion detection ──────────────────────────────
      // Only query the backend for callsigns NOT already in the local cache.
      // This keeps the HTTP + SQL cost proportional to new aircraft, not total.
      const allCallsigns = [...new Set(result.map(f => f.callsign).filter(cs => cs && cs !== '—'))]
      const uncached = allCallsigns.filter(cs => !routeCacheRef.current[cs])

      if (uncached.length > 0) {
        try {
          const { routes, unknown } = await lookupRoutes(uncached)
          // Merge backend hits into local cache
          for (const [cs, route] of Object.entries(routes)) {
            routeCacheRef.current[cs] = route
          }
          // Queue unknowns for background ADSBdb enrichment
          if (unknown.length > 0) {
            const queued = new Set(enrichQueueRef.current)
            const toAdd = unknown.filter(cs => !queued.has(cs))
            enrichQueueRef.current.push(...toAdd)
            startEnrichQueue()
          }
          // Only log when there's something new to report
          if (Object.keys(routes).length > 0 || unknown.length > 0) {
            const cached = Object.keys(routeCacheRef.current).length
            log(`routes: ${Object.keys(routes).length} new from cache, ${unknown.length} queued · ${cached} total`, 'info')
          }
        } catch {
          // Backend offline — continue without route data
        }
      }

      // ── score anomalies using phase-aware engine ─────────────────────────
      // Pass enrichment data (route + adsb.fi + cached routes) for richer scoring
      const prevTrack = trackHistoryRef.current
      const newAnomalies = {}
      for (const f of result) {
        const hist = prevTrack[f.icao]
        if (!hist || hist.length < 2) continue
        // Build enrichment: merge click-enrichment with cached route data
        let enrich = enrichCache[f.icao] || null
        const cachedRoute = routeCacheRef.current[f.callsign]
        if (cachedRoute && !enrich?.flightroute) {
          // Inject cached route as flightroute for diversion detection
          enrich = {
            ...(enrich || {}),
            flightroute: {
              destination: { latitude: cachedRoute.destination_lat, longitude: cachedRoute.destination_lon, icao_code: cachedRoute.destination_icao },
              origin: { latitude: cachedRoute.origin_lat, longitude: cachedRoute.origin_lon, icao_code: cachedRoute.origin_icao },
            },
          }
        }
        const { score, phase, reasons, confirmed, category, severity, categories } = scoreAnomaly(hist, f, enrich, weatherRef.current, result)
        if (score >= ANOMALY_THRESHOLD) {
          newAnomalies[f.icao] = { score, phase, reasons, confirmed, category, severity, categories, label: reasons[0] || 'anomaly' }
        }
      }

      // ── stale route detection ──────────────────────────────────────────────
      // If a cruising aircraft's heading consistently deviates >60° from the
      // cached destination bearing, the cache is probably wrong — re-enrich.
      const staleReenrich = []
      for (const f of result) {
        if (f.grounded || f.hdg == null || f.lat == null || !f.callsign || f.callsign === '—') continue
        const cached = routeCacheRef.current[f.callsign]
        if (!cached?.destination_lat) continue
        const hist = prevTrack[f.icao]
        if (!hist || hist.length < 3) continue
        // Only check cruise-phase aircraft
        const alts = hist.slice(-3).filter(s => s.alt != null).map(s => s.alt)
        if (alts.length < 2) continue
        const avgDelta = Math.abs(alts[alts.length - 1] - alts[0]) / alts.length
        if (avgDelta > 50) continue // not cruising

        // Compute bearing to cached destination
        const dLat = cached.destination_lat - f.lat
        const dLon = cached.destination_lon - f.lon
        const bearing = (Math.atan2(dLon * Math.cos(f.lat * Math.PI / 180), dLat) * 180 / Math.PI + 360) % 360
        const delta = Math.abs(f.hdg - bearing) % 360
        const hdgDiff = delta > 180 ? 360 - delta : delta

        if (hdgDiff > 60) {
          staleReenrich.push(f.callsign)
          delete routeCacheRef.current[f.callsign]
        }
      }
      if (staleReenrich.length > 0) {
        const queued = new Set(enrichQueueRef.current)
        const toAdd = staleReenrich.filter(cs => !queued.has(cs))
        enrichQueueRef.current.push(...toAdd)
        startEnrichQueue()
        log(`routes: ${staleReenrich.length} stale route(s) queued for re-enrichment`, 'info')
      }

      // Merge: keep grace-period anomalies (fading) alongside fresh ones
      const merged = { ...newAnomalies }
      for (const icao of Object.keys(anomalies)) {
        if (!merged[icao] && anomalyMissRef.current[icao]) {
          merged[icao] = { ...anomalies[icao], fading: true }
        }
      }
      setAnomalies(merged)
      if (Object.keys(newAnomalies).length > 0) {
        const confirmed = Object.values(newAnomalies).filter(a => a.confirmed).length
        log(`anomalies: ${Object.keys(newAnomalies).length} scored above threshold${confirmed ? ` (${confirmed} confirmed)` : ''}`, 'warn')

        // Persist anomalies to backend with weather context
        const anomalyPayload = Object.entries(newAnomalies).map(([icao, a]) => {
          const f = result.find(fl => fl.icao === icao)
          return {
            icao, callsign: f?.callsign, score: a.score, phase: a.phase,
            reasons: a.reasons, confirmed: a.confirmed,
            category: a.category, severity: a.severity, categories: a.categories,
            lat: f?.lat, lon: f?.lon, alt: f?.alt, vel: f?.vel, hdg: f?.hdg, squawk: f?.squawk,
          }
        })

        // Fetch weather context for anomaly area (non-blocking)
        const anomalyLats = anomalyPayload.filter(a => a.lat != null).map(a => a.lat)
        const anomalyLons = anomalyPayload.filter(a => a.lon != null).map(a => a.lon)
        if (anomalyLats.length > 0) {
          const pad = 2 // degrees padding around anomaly cluster
          const bbox = [
            Math.min(...anomalyLats) - pad,
            Math.min(...anomalyLons) - pad,
            Math.max(...anomalyLats) + pad,
            Math.max(...anomalyLons) + pad,
          ]
          Promise.all([
            fetchPireps(bbox[0], bbox[1], bbox[2], bbox[3], { age: 2, inten: 'mod' }).catch(() => []),
            fetchSigmets().catch(() => []),
          ]).then(([pireps, sigmets]) => {
            const pirepSummary = summarizePireps(pireps)
            const sigmetSummary = summarizeSigmets(sigmets)
            // Store weather for next scoring cycle
            weatherRef.current = { sigmets: sigmetSummary, pireps: pirepSummary }
            if (pirepSummary.count > 0 || sigmetSummary.count > 0) {
              const wxContext = { pireps: pirepSummary, sigmets: sigmetSummary }
              // Attach weather to each anomaly and re-persist
              const enrichedPayload = anomalyPayload.map(a => ({ ...a, weather_context: wxContext }))
              recordAnomalies(enrichedPayload, region).catch(() => {})
              if (pirepSummary.severe) log(`weather: severe PIREPs near anomaly area (${pirepSummary.maxTurbulence || pirepSummary.maxIcing})`, 'warn')
              if (sigmetSummary.convective > 0) log(`weather: ${sigmetSummary.convective} convective SIGMET(s) active`, 'warn')
            } else {
              weatherRef.current = null
              recordAnomalies(anomalyPayload, region).catch(() => {})
            }
          }).catch(() => {
            recordAnomalies(anomalyPayload, region).catch(() => {})
          })
        } else {
          recordAnomalies(anomalyPayload, region).catch(() => {})
        }

        // Enrich top anomalies with adsb.fi telemetry (1 req/sec rate limit)
        const toEnrich = Object.keys(newAnomalies)
          .filter(icao => !enrichCache[icao]?.adsbfi)
          .sort((a, b) => newAnomalies[b].score - newAnomalies[a].score)
          .slice(0, 3) // max 3 per cycle
        for (let i = 0; i < toEnrich.length; i++) {
          const icao = toEnrich[i]
          if (i > 0) await new Promise(r => setTimeout(r, 1100)) // respect 1 req/sec
          enrichByHex(icao)
            .then(data => {
              if (!data) return
              setEnrichCache(prev => ({
                ...prev,
                [icao]: { ...(prev[icao] || {}), adsbfi: data },
              }))
              if (data.emergency) {
                log(`⚠ adsb.fi: ${icao} emergency=${data.emergency}`, 'err')
              }
            })
            .catch(() => {})
        }

        // Airplanes.live enrichment is on-demand only — triggered when the analyst
        // clicks an anomaly in the investigation panel (AnomalyDrilldown).
      }

      // Resolve anomalies — require 3 consecutive misses before resolving.
      // OpenSky often drops aircraft between calls (coverage gaps, timing).
      // A single miss shouldn't instantly resolve a real anomaly.
      const RESOLVE_AFTER = 3  // consecutive cycles without scoring
      const prevAnomalyIcaos = Object.keys(anomalies)
      const misses = anomalyMissRef.current
      const resolvedIcaos = []
      for (const icao of prevAnomalyIcaos) {
        if (newAnomalies[icao]) {
          delete misses[icao]  // still anomalous — reset
        } else {
          misses[icao] = (misses[icao] || 0) + 1
          if (misses[icao] >= RESOLVE_AFTER) {
            resolvedIcaos.push(icao)
            delete misses[icao]
          }
        }
      }
      if (resolvedIcaos.length > 0) {
        resolveAnomalies(resolvedIcaos).catch(() => {})
        log(`anomalies: ${resolvedIcaos.length} resolved after ${RESOLVE_AFTER} clear cycles`, 'info')
      }

      // ── summary stats ─────────────────────────────────────────────────────
      const airborne = result.filter((f) => !f.grounded)
      const grounded = result.length - airborne.length
      log(`  airborne: ${airborne.length} · grounded: ${grounded}`, 'info')

      // ── persist to SQLite ────────────────────────────────────────────────
      recordSightings(result, usedSource, region)
        .then((d) => log(`db: ${d.recorded} sightings recorded`, 'info'))
        .catch(() => {}) // silent — backend may be offline
    } else if (result !== null) {
      log(
        'no aircraft data returned — possibly rate limited, wait ~60s',
        'warn'
      )
    }

    setFetching(false)
    setStatusText('idle')
  }, [fetching, settings, region, log])

  useEffect(() => {
    fetchFlightsRef.current = fetchFlights
  }, [fetchFlights])

  // ── auto-refresh with ramp-up ────────────────────────────────────────────────
  // Starts at 10s on first load, doubles each cycle until hitting the configured interval.
  // This gets data on screen fast without hammering the API long-term.
  const rampRef = useRef(10) // current interval in seconds (starts at 10)
  useEffect(() => {
    if (!autoOn) return
    const targetInterval = settings.interval // user-configured steady-state (default 90s)
    function scheduleNext() {
      const delay = rampRef.current
      autoRef.current = setTimeout(() => {
        fetchFlightsRef.current?.()
        // Double the interval until we hit the target
        if (rampRef.current < targetInterval) {
          rampRef.current = Math.min(rampRef.current * 2, targetInterval)
        }
        scheduleNext()
      }, delay * 1000)
    }
    scheduleNext()
    return () => clearTimeout(autoRef.current)
  }, [autoOn, settings.interval])

  const toggleAuto = () => {
    if (autoOn) {
      clearTimeout(autoRef.current)
      setAutoOn(false)
      log('auto-refresh disabled', 'info')
    } else {
      rampRef.current = 10  // restart ramp from 10s
      setAutoOn(true)
      log('auto-refresh enabled (10s → ' + settings.interval + 's)', 'info')
    }
  }

  // ── region change ─────────────────────────────────────────────────────────────
  const handleRegionChange = (r) => {
    setRegion(r)
    log(`region → ${r}`, 'info')
  }

  // ── row selection + adsbdb enrichment + backend track pre-fill ───────────────
  const handleSelectFlight = useCallback(
    async (flight) => {
      setSelectedFlight(flight)

      // Pre-fill track history from backend if we don't have much in-memory
      // Backend rows lack lat/lon, so only use them for chart data — never overwrite
      // in-memory snapshots that have positions
      const existing = trackHistoryRef.current[flight.icao]
      if (!existing || existing.length < 3) {
        fetchAircraftTrack(flight.icao, 60)
          .then((rows) => {
            if (rows.length > 0) {
              const backendSnaps = rows.map((r) => ({
                ts: new Date(r.seen_at).getTime(),
                lat: r.lat, lon: r.lon,
                alt: r.alt, vel: r.vel, hdg: r.hdg, grounded: !!r.grounded,
              }))
              setTrackHistory((prev) => {
                const mem = prev[flight.icao] || []
                const seen = new Set(mem.map((s) => s.ts))
                const merged = [...backendSnaps.filter((s) => !seen.has(s.ts)), ...mem]
                merged.sort((a, b) => a.ts - b.ts)
                return { ...prev, [flight.icao]: merged.slice(-60) }
              })
            }
          })
          .catch(() => {})
      }

      if (enrichCache[flight.icao]) return

      // Fetch ADSBdb + adsb.fi + airplanes.live enrichment in parallel
      log(`enriching ${flight.icao} / ${flight.callsign}`, 'info')
      const [adsbdbResult, adsbfiResult, aplResult] = await Promise.allSettled([
        enrichFlight(flight.icao, flight.callsign),
        enrichByHex(flight.icao),
        fetchAplByHex(flight.icao),
      ])

      const adsbdb = adsbdbResult.status === 'fulfilled' ? adsbdbResult.value : { aircraft: null, flightroute: null }
      const adsbfi = adsbfiResult.status === 'fulfilled' ? adsbfiResult.value : null
      const aplData = aplResult.status === 'fulfilled' ? aplResult.value : null

      setEnrichCache((prev) => ({ ...prev, [flight.icao]: { ...adsbdb, adsbfi, apl: aplData } }))

      const parts = []
      if (adsbdb.aircraft) parts.push('aircraft=found')
      if (adsbdb.flightroute) parts.push(`route=${adsbdb.flightroute._source || 'adsbdb'}`)
      if (adsbfi) parts.push(`adsb.fi=${[adsbfi.type, adsbfi.reg, adsbfi.operator].filter(Boolean).join('/') || 'ok'}`)
      if (aplData) parts.push(`apl=${[aplData.ias ? `IAS:${aplData.ias}` : null, aplData.mach ? `M${aplData.mach}` : null, aplData.windSpeed ? `wind:${aplData.windDir}°/${aplData.windSpeed}kt` : null].filter(Boolean).join('/') || 'ok'}`)
      log(`enrich: ${flight.icao} — ${parts.join(' · ') || 'no data'}`, parts.length ? 'ok' : 'warn')
    },
    [enrichCache, log]
  )

  // ── arrived / departed aircraft log ──────────────────────────────────────────
  const handleArrived = useCallback(
    (callsigns) => {
      const list = callsigns.slice(0, 8).join(', ')
      const overflow =
        callsigns.length > 8 ? ` +${callsigns.length - 8} more` : ''
      log(`arrived: ${callsigns.length} aircraft (${list}${overflow})`, 'ok')
    },
    [log]
  )

  const handleDeparted = useCallback(
    (callsigns) => {
      const list = callsigns.slice(0, 8).join(', ')
      const overflow =
        callsigns.length > 8 ? ` +${callsigns.length - 8} more` : ''
      log(`departed: ${callsigns.length} aircraft (${list}${overflow})`, 'warn')
    },
    [log]
  )

  // ── aero cache update ─────────────────────────────────────────────────────────
  const handleAeroFetched = useCallback(
    (icao, data) => {
      setAeroCache((prev) => ({ ...prev, [icao]: data }))
      log(
        `aeroapi: ${icao} — ${data ? 'data received' : 'no flight data'}`,
        data ? 'ok' : 'warn'
      )
      refreshAeroSpend()
    },
    [log, refreshAeroSpend]
  )

  // ── settings save ─────────────────────────────────────────────────────────────
  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings)
    saveSettings(newSettings)
    log(
      `settings saved · source=${newSettings.sourcePref} interval=${newSettings.interval}s`,
      'ok'
    )
    // Reset ramp to the new target interval (already ramped up by now)
    rampRef.current = newSettings.interval
    setShowSettings(false)
  }

  // ── derived stats ─────────────────────────────────────────────────────────────
  const stats = {
    total: flights.length || null,
    airborne: flights.filter((f) => !f.grounded).length || null,
    grounded: flights.filter((f) => f.grounded).length || null,
    region,
    enriched: Object.keys(enrichCache).length + Object.keys(aeroCache).length,
    lastUpdate: flights.length
      ? new Date().toISOString().substring(11, 19) + ' utc'
      : null,
  }

  const botSrc =
    activeSource === 'adsbx'
      ? 'adsbexchange.com (rapidapi) + api.adsbdb.com'
      : 'opensky-network.org + api.adsbdb.com'

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Boot loading bar */}
      {booting && (
        <div className="fixed top-0 left-0 right-0 z-100">
          <div className="h-0.5 bg-acc/30 overflow-hidden">
            <div className="h-full bg-acc animate-pulse w-2/3" style={{ animation: 'bootbar 1.5s ease-in-out infinite' }} />
          </div>
          <div className="bg-bg2/95 border-b border-border text-center py-1.5 text-[10px] text-fg3">
            {bootMsg}
          </div>
          <style>{`@keyframes bootbar { 0% { transform: translateX(-100%) } 50% { transform: translateX(50%) } 100% { transform: translateX(200%) } }`}</style>
        </div>
      )}

      {/* Page 1: flight tracker — fills one viewport */}
      <div
        className="grid grid-rows-[auto_auto_auto_1fr] grid-cols-1 md:grid-cols-[1fr_var(--sidebar-w)] h-screen overflow-hidden"
        style={{ '--sidebar-w': `${sidebarW}px` }}
      >
        {/* Top status bar */}
        <div className="col-span-full row-start-1">
          <TopBar
            stats={stats}
            source={activeSource}
            backendOk={backendOk}
            autoOn={autoOn}
            lastFetchAt={lastFetchAt}
          />
        </div>

        {/* Control bar */}
        <div className="col-span-full row-start-2">
          <ControlBar
            filter={filter}
            onFilterChange={setFilter}
            onFetch={fetchFlights}
            fetching={fetching}
            hasFetched={lastFetchAt !== null}
            autoOn={autoOn}
            onToggleAuto={toggleAuto}
            onClearLog={clearLog}
            onOpenSettings={() => setShowSettings(true)}
            onOpenUsage={() => setShowUsage(true)}
            onOpenNotams={() => setShowNotams(true)}
            region={region}
            onRegionChange={handleRegionChange}
            interval={settings.interval}
            lastFetchAt={lastFetchAt}
          />
        </div>

        {/* Log panel */}
        <div className="col-span-full row-start-3">
          <LogPanel entries={logEntries} />
        </div>

        {/* Flight table */}
        <div className="row-start-4 min-h-0 flex flex-col">
          <FlightTable
            flights={flights}
            filter={filter}
            selectedIcao={selectedFlight?.icao}
            enrichCache={enrichCache}
            anomalies={anomalies}
            trackHistory={trackHistory}
            openskyUsage={openskyUsage}
            aeroSpend={aeroSpend}
            onSelect={handleSelectFlight}
            onArrived={handleArrived}
            onDeparted={handleDeparted}
          />
        </div>

        {/* Detail panel — desktop sidebar */}
        <div className="row-start-4 overflow-y-auto min-h-0 hidden md:block relative">
          {/* Resize handle */}
          <div
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-acc/30 active:bg-acc/50 transition-colors"
            onMouseDown={(e) => { e.preventDefault(); draggingRef.current = true; document.body.style.cursor = 'col-resize' }}
          />
          <DetailPanel
            flight={selectedFlight}
            flights={flights}
            enrichData={
              selectedFlight ? enrichCache[selectedFlight.icao] : null
            }
            aeroCache={aeroCache}
            aeroSpend={aeroSpend}
            userAeroKey={settings.userAeroKey}
            trackHistory={selectedFlight ? trackHistory[selectedFlight.icao] : null}
            onClose={() => setSelectedFlight(null)}
            onAeroFetched={handleAeroFetched}
            backendOk={backendOk}
          />
        </div>

        {/* Detail panel — mobile slide-up sheet */}
        {selectedFlight && (
          <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
            <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedFlight(null)} />
            <div className="relative bg-bg1 max-h-[80vh] overflow-y-auto rounded-t-lg border-t border-border">
              <div className="sticky top-0 z-10 bg-bg2 flex justify-between items-center py-1 px-3 border-b border-border">
                <span className="text-acc text-[11px]">aircraft intel</span>
                <button className="text-fg3 text-sm px-2" onClick={() => setSelectedFlight(null)}>✕</button>
              </div>
              <DetailPanel
                flight={selectedFlight}
                flights={flights}
                enrichData={enrichCache[selectedFlight.icao] ?? null}
                aeroCache={aeroCache}
                aeroSpend={aeroSpend}
                userAeroKey={settings.userAeroKey}
                trackHistory={trackHistory[selectedFlight.icao] ?? null}
                onClose={() => setSelectedFlight(null)}
                onAeroFetched={handleAeroFetched}
                backendOk={backendOk}
                mobile
              />
            </div>
          </div>
        )}
      </div>

      {/* Page 2: dashboard — always visible, scroll down to see */}
      <DashboardPanel backendOk={backendOk} activeSource={activeSource} region={region} lastFetchAt={lastFetchAt} />

      {/* Sticky status bar — always at bottom of viewport */}
      <div className="sticky bottom-0 z-40 bg-acc py-0.5 px-1.5 sm:px-2.5 flex justify-between text-[10px] sm:text-[11px] text-bg">
        <div className="truncate">
          <span className="bg-bg text-acc py-0 px-2 mr-1.5">NORMAL</span>
          <span className="hidden sm:inline">{botSrc}</span>
        </div>
        <div className="shrink-0">{statusText}</div>
      </div>

      {/* Overlays */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showUsage && (
        <UsagePanel onClose={() => setShowUsage(false)} backendOk={backendOk} />
      )}

      {showNotams && (
        <NotamPanel region={region} onClose={() => setShowNotams(false)} />
      )}
    </>
  )
}
