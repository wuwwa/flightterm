import { useState, useEffect, useRef, useCallback } from 'react'

import CommandBar from './components/CommandBar'
import LogPanel from './components/LogPanel'
import FlightTable from './components/FlightTable'
import DetailPanel from './components/DetailPanel'
import SettingsModal from './components/SettingsModal'
import UsagePanel from './components/UsagePanel'
import NotamPanel from './components/NotamPanel'
import NasPanel from './components/NasPanel'
import TfmsPanel from './components/tfms/TfmsPanel'
import DashboardPanel from './components/DashboardPanel'
import { SwimProvider } from './contexts/SwimContext'

import axios from 'axios'
import { fetchStates } from './services/opensky'
import { fetchAplByHex } from './services/airplaneslive'
import { enrichFlight, fetchRouteOnly } from './services/adsbdb'
import { enrichByHex } from './services/adsbfi'
import { checkHealth, fetchAeroSpend } from './services/aeroapi'

import { fetchOpenSkyUsageToday, fetchAircraftTrack, lookupRoutes, saveRoutes } from './services/sightings'

// ── default settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
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

  // ── route cache: callsign → { destination_lat, destination_lon, destination_icao, ... }
  const routeCacheRef = useRef({})    // in-memory mirror of backend cache
  const enrichQueueRef = useRef([])   // callsigns waiting for route enrichment
  const enrichingRef = useRef(false)

  // ── slow route enrichment queue (1 req / 15s to avoid 429s) ────────────────
  const startEnrichQueue = useCallback(() => {
    if (enrichingRef.current) return
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
              saveRoutes([entry]).catch(() => {})
              routeCacheRef.current[cs] = entry
            }
          }
        } catch (err) {
          // Stop queue on rate limit
          if (err?.response?.status === 429) {
            enrichQueueRef.current = []
            break
          }
        }
        if (enrichQueueRef.current.length > 0) {
          await new Promise(r => setTimeout(r, 15000))
        }
      }
      enrichingRef.current = false
    }

    processQueue()
  }, [])

  const fetchFlightsRef = useRef(null)
  const openskyUsageRef = useRef(null)
  openskyUsageRef.current = openskyUsage


  // ── logging ──────────────────────────────────────────────────────────────────
  const log = useCallback((msg, type = '') => {
    setLogEntries((prev) => [...prev.slice(-199), makeEntry(msg, type)])
  }, [])

  const clearLog = useCallback(() => {
    setLogEntries([makeEntry('log cleared', 'info')])
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
          console.log('[boot] backend ready:', {
            opensky: d.opensky_configured, aeroapi: d.aeroapi_configured, notam: d.faa_notam_configured,
            poller: d.poller_running ? `running (${d.poller_region}, ${d.poller_aircraft} aircraft)` : 'disabled',
            db: d.db_size,
          })
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

      if (health) {
        log('fetching initial flight data…', 'info')
        setBootMsg('fetching flights…')
        console.log('[boot] initial fetch')
        await fetchFlightsRef.current?.()
        if (cancelled) return
        const intervalSec = pollInterval ? Math.round(pollInterval / 1000) : '?'
        log(`live sync enabled (${intervalSec}s)`, 'ok')
        console.log('[boot] live sync enabled')
      }

      setBooting(false)
      setBootMsg('')
      log('flightterm v4 ready', 'ok')
      console.log('[boot] complete')
    }

    boot()
    return () => { cancelled = true }
  }, [])

  // ── fetch flights ─────────────────────────────────────────────────────────────
  // Primary path: read from backend poller cache (GET /api/flights).
  // All users see the same data. Backend records sightings + scores anomalies.
  // Fallback: direct OpenSky fetch if poller region doesn't match.
  const lastServerFetchRef = useRef(null) // tracks when poller last fetched (to detect new cycles)
  const fetchingRef = useRef(false)
  const [pollInterval, setPollInterval] = useState(null) // poll interval from backend (ms)

  const fetchFlights = useCallback(async () => {
    if (fetchingRef.current) return

    fetchingRef.current = true
    setFetching(true)
    const t0 = performance.now()

    let result = null
    let serverFetchedAt = null

    try {
      const resp = await axios.get('/api/flights')
      const pollerRegion = resp.data?.region
      const pollerHasData = resp.data?.flights?.length > 0
      serverFetchedAt = resp.data?.fetchedAt || null
      console.log('[fetch] /api/flights →', { pollerRegion, pollerHasData, flightCount: resp.data?.flights?.length, serverFetchedAt, clientRegion: region })
      if (resp.data?.pollInterval && resp.data.pollInterval !== pollInterval) setPollInterval(resp.data.pollInterval)

      if (pollerHasData && pollerRegion === region) {
        result = resp.data.flights
        for (const f of result) {
          if (!f.callsign) f.callsign = '—'
        }
      } else if (pollerHasData && pollerRegion !== region) {
        log(`flights: poller region is ${pollerRegion}, need ${region} — fetching direct`, 'info')
        const direct = await fetchStates(region, {
          osClientId: settings.userOsClientId,
          osClientSecret: settings.userOsClientSecret,
        })
        result = direct.flights
        serverFetchedAt = Date.now()
        const ms = Math.round(performance.now() - t0)
        log(`opensky: ${result.length} state vectors received (${ms}ms)`, 'ok')
      } else {
        result = []
      }
    } catch (err) {
      console.error('[fetch] backend error:', err.message)
      log(`flights: backend error (${err.message})`, 'err')
      result = []
    }

    console.log('[fetch] result:', result?.length ?? 0, 'flights')
    if (result && result.length > 0) {
      setFlights(result)
      setLastFetchAt(serverFetchedAt || Date.now())

      // Detect new poller cycle (fetchedAt changed) vs enrichment refresh
      const isNewCycle = serverFetchedAt !== lastServerFetchRef.current
      lastServerFetchRef.current = serverFetchedAt

      if (isNewCycle) {
        setStatusText('fetching')
        const ms = Math.round(performance.now() - t0)
        const age = serverFetchedAt ? Math.round((Date.now() - serverFetchedAt) / 1000) : '?'
        log(`flights: ${result.length} aircraft from poller (${ms}ms, ${age}s old)`, 'ok')

        // ── track history snapshots per aircraft ──────────────────────────
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

        // ── route lookup for diversion detection ──────────────────────────
        const allCallsigns = [...new Set(result.map(f => f.callsign).filter(cs => cs && cs !== '—'))]
        const uncached = allCallsigns.filter(cs => !routeCacheRef.current[cs])

        if (uncached.length > 0) {
          try {
            const { routes, unknown } = await lookupRoutes(uncached)
            for (const [cs, route] of Object.entries(routes)) {
              routeCacheRef.current[cs] = route
            }
            if (unknown.length > 0) {
              const queued = new Set(enrichQueueRef.current)
              const toAdd = unknown.filter(cs => !queued.has(cs)).slice(0, 50)
              enrichQueueRef.current.push(...toAdd)
              startEnrichQueue()
            }
            if (Object.keys(routes).length > 0 || unknown.length > 0) {
              const cached = Object.keys(routeCacheRef.current).length
              log(`routes: ${Object.keys(routes).length} new from cache, ${unknown.length} queued · ${cached} total`, 'info')
            }
          } catch {}
        }

        const airborne = result.filter((f) => !f.grounded)
        const grounded = result.length - airborne.length
        log(`  airborne: ${airborne.length} · grounded: ${grounded}`, 'info')
      }
      // else: silent refresh — just updates flight data (picks up new enrichment)
    } else if (result !== null && !lastServerFetchRef.current) {
      log('flights: no data yet — poller may still be starting', 'warn')
    }

    fetchingRef.current = false
    setFetching(false)
    setStatusText('idle')
  }, [settings, region, log, pollInterval])

  useEffect(() => {
    fetchFlightsRef.current = fetchFlights
  }, [fetchFlights])

  // ── SSE: receive anomalies from backend poller ──────────────────────────────
  useEffect(() => {
    const baseUrl = import.meta.env.VITE_API_URL || ''
    const es = new EventSource(`${baseUrl}/api/anomalies/stream`)

    es.addEventListener('anomaly', (e) => {
      try {
        const a = JSON.parse(e.data)
        setAnomalies((prev) => ({
          ...prev,
          [a.icao]: {
            score: a.score, phase: a.phase, reasons: a.reasons,
            confirmed: a.confirmed, category: a.category,
            severity: a.severity, categories: a.categories,
            label: a.reasons?.[0] || 'anomaly',
          },
        }))
      } catch {}
    })

    es.addEventListener('critical', (e) => {
      try {
        const a = JSON.parse(e.data)
        log(`anomaly: CRITICAL ${a.icao} ${a.callsign || ''} — ${a.reasons?.[0] || 'emergency'}`, 'warn')
      } catch {}
    })

    es.addEventListener('resolved', (e) => {
      try {
        const icaos = JSON.parse(e.data)
        setAnomalies((prev) => {
          const next = { ...prev }
          for (const icao of icaos) delete next[icao]
          return next
        })
        log(`anomalies: ${icaos.length} resolved by backend poller`, 'info')
      } catch {}
    })

    es.onerror = () => {
      // SSE will auto-reconnect; no action needed
    }

    return () => es.close()
  }, [log])

  // ── auto-refresh ──────────────────────────────────────────────────────────────
  // Polls backend cache at half the poller interval (floor 5s). This is cheap
  // (memory + SQLite read, no external API calls). Picks up enrichment (type/reg)
  // as it trickles in between poller cycles, and new flight positions as soon as
  // the poller fetches.
  useEffect(() => {
    const interval = Math.max(5000, Math.round((pollInterval || 45000) / 2))
    const id = setInterval(() => {
      fetchFlightsRef.current?.()
    }, interval)
    return () => clearInterval(id)
  }, [pollInterval])

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

      // Skip if fully enriched (has adsbdb + adsbfi + apl)
      const cached = enrichCache[flight.icao]
      if (cached?.aircraft !== undefined && cached?.adsbfi && cached?.apl) return

      // Only fetch what's missing
      log(`enriching ${flight.icao} / ${flight.callsign}`, 'info')
      const needsAdsbdb = cached?.aircraft === undefined && cached?.flightroute === undefined
      const needsAdsbfi = !cached?.adsbfi
      const needsApl = !cached?.apl

      const [adsbdbResult, adsbfiResult, aplResult] = await Promise.allSettled([
        needsAdsbdb ? enrichFlight(flight.icao, flight.callsign) : Promise.resolve(cached ? { aircraft: cached.aircraft, flightroute: cached.flightroute } : { aircraft: null, flightroute: null }),
        needsAdsbfi ? enrichByHex(flight.icao) : Promise.resolve(cached?.adsbfi),
        needsApl ? fetchAplByHex(flight.icao) : Promise.resolve(cached?.apl),
      ])

      const adsbdb = adsbdbResult.status === 'fulfilled' ? adsbdbResult.value : { aircraft: null, flightroute: null }
      const adsbfi = adsbfiResult.status === 'fulfilled' ? adsbfiResult.value : null
      const aplData = aplResult.status === 'fulfilled' ? aplResult.value : null

      setEnrichCache((prev) => ({ ...prev, [flight.icao]: { ...prev[flight.icao], ...adsbdb, adsbfi: adsbfi || prev[flight.icao]?.adsbfi, apl: aplData } }))

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
    log('settings saved', 'ok')
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

  const botSrc = 'opensky-network.org + api.adsbdb.com'

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <SwimProvider backendOk={backendOk}>
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
        className="grid grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] grid-cols-1 md:grid-cols-[1fr_var(--sidebar-w)] h-screen overflow-hidden"
        style={{ '--sidebar-w': `${sidebarW}px` }}
      >
        {/* Combined command bar: branding, stats, filter, region, controls, SWIM indicators, clock */}
        <div className="col-span-full row-start-1">
          <CommandBar
            stats={stats}
            backendOk={backendOk}
            lastFetchAt={lastFetchAt}
            pollInterval={pollInterval}
            filter={filter}
            onFilterChange={setFilter}
            onClearLog={clearLog}
            onOpenSettings={() => setShowSettings(true)}
            onOpenUsage={() => setShowUsage(true)}
            region={region}
            onRegionChange={handleRegionChange}
          />
        </div>

        {/* Log panel — collapsed by default, click to expand */}
        <div className="col-span-full row-start-2">
          <LogPanel entries={logEntries} />
        </div>

        {/* Flight table */}
        <div className="row-start-3 min-h-0 flex flex-col">
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
        <div className="row-start-3 overflow-y-auto min-h-0 hidden md:block relative">
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
        {/* TFMS — flight plans, map, airport board, delays */}
        <div className="col-span-full row-start-4 overflow-y-auto">
          <TfmsPanel backendOk={backendOk} />
        </div>

        {/* FAA SWIM / NAS section */}
        <div className="col-span-full row-start-5 overflow-y-auto">
          <NasPanel backendOk={backendOk} region={region} />
        </div>
      </div>

      {/* Dashboard: anomaly analytics */}
      <div id="dashboard">
        <DashboardPanel backendOk={backendOk} flights={flights} trackHistory={trackHistory} enrichCache={enrichCache} />
      </div>

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
    </SwimProvider>
  )
}
