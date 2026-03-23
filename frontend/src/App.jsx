import { useState, useEffect, useRef, useCallback } from 'react'

import TopBar from './components/TopBar'
import ControlBar from './components/ControlBar'
import LogPanel from './components/LogPanel'
import FlightTable from './components/FlightTable'
import DetailPanel from './components/DetailPanel'
import SettingsModal from './components/SettingsModal'
import UsagePanel from './components/UsagePanel'
import NotamPanel from './components/NotamPanel'

import { fetchStates } from './services/opensky'
import { fetchAdsbx } from './services/adsbx'
import { enrichFlight } from './services/adsbdb'
import { checkHealth, fetchAeroSpend } from './services/aeroapi'

import { recordSightings, fetchOpenSkyUsageToday, fetchAircraftTrack } from './services/sightings'
import { scoreAnomaly, ANOMALY_THRESHOLD } from './utils/anomaly'

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

  // ── auto-refresh ref ────────────────────────────────────────────────────────
  const autoRef = useRef(null)
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

  // ── backend health check ─────────────────────────────────────────────────────
  useEffect(() => {
    checkHealth()
      .then((d) => {
        setBackendOk(true)
        log(`backend ok · opensky: ${d.opensky_configured ? '✓' : '✗'} · aeroapi: ${d.aeroapi_configured ? '✓' : '✗'} · notam: ${d.faa_notam_configured ? '✓' : '✗'}`, 'ok')
        refreshAeroSpend()
        refreshOpenskyUsage()
      })
      .catch(() => {
        setBackendOk(false)
        log(
          'backend offline — start the Express server (cd backend && npm run dev)',
          'warn'
        )
      })
  }, [])

  // ── boot log + initial fetch ─────────────────────────────────────────────────
  useEffect(() => {
    log('flightterm v4 ready', 'ok')
    log('live: opensky (default) · adsbx (optional) — see ⚙ settings', 'info')
    log(
      'enrichment: adsbdb (free, auto) · aeroapi (on-demand, $0.005/call)',
      'info'
    )
    //auto-fetches
    //setTimeout(() => fetchFlightsRef.current?.(), 0)
  }, [])

  // ── resolve which source to actually use ─────────────────────────────────────
  function resolveSource() {
    if (settings.sourcePref === 'adsbx') return 'adsbx'
    if (settings.sourcePref === 'opensky') return 'opensky'
    return settings.adsbxKey ? 'adsbx' : 'opensky'
  }

  // ── fetch flights ─────────────────────────────────────────────────────────────
  const fetchFlights = useCallback(async () => {
    if (fetching) return

    // ── credit guard ────────────────────────────────────────────────────────
    const src = resolveSource()
    if (src === 'opensky' && openskyUsageRef.current?.remaining <= 0) {
      log('opensky: daily credit limit reached — fetch blocked', 'err')
      return
    }

    setFetching(true)
    setStatusText('fetching')
    const t0 = performance.now()

    let result = null
    let usedSource = src

    if (src === 'adsbx') {
      try {
        log(
          `adsbx: querying lat/lon radius ${settings.adsbxRadius}nm · region=${region}`,
          'info'
        )
        const { flights: f, remaining } = await fetchAdsbx(
          region,
          settings.adsbxKey,
          settings.adsbxRadius
        )
        result = f
        setActiveSource('adsbx')
        const ms = Math.round(performance.now() - t0)
        log(
          `adsbx: ${f.length} aircraft (${ms}ms)${remaining ? ` · quota remaining: ${remaining}` : ''}`,
          'ok'
        )
        const mil = f.filter((x) => x.mil).length
        if (mil > 0) log(`adsbx: ${mil} military aircraft in feed`, 'warn')
      } catch (err) {
        log(`adsbx failed (${err.message}) — falling back to opensky`, 'warn')
        setActiveSource('fallback')
        usedSource = 'opensky'
      }
    }

    if (usedSource === 'opensky' && result === null) {
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
          arr.push({ ts: now, lat: f.lat, lon: f.lon, alt: f.alt, vel: f.vel, hdg: f.hdg, grounded: f.grounded })
          if (arr.length > MAX_SNAPSHOTS) arr.shift()
          next[f.icao] = arr
        }
        return next
      })

      // ── score anomalies using phase-aware engine ─────────────────────────
      const prevTrack = trackHistoryRef.current
      const newAnomalies = {}
      for (const f of result) {
        const hist = prevTrack[f.icao]
        if (!hist || hist.length < 2) continue
        const { score, phase, reasons, confirmed } = scoreAnomaly(hist, f)
        if (score >= ANOMALY_THRESHOLD) {
          newAnomalies[f.icao] = { score, phase, reasons, confirmed, label: reasons[0] || 'anomaly' }
        }
      }
      setAnomalies(newAnomalies)
      if (Object.keys(newAnomalies).length > 0) {
        const confirmed = Object.values(newAnomalies).filter(a => a.confirmed).length
        log(`anomalies: ${Object.keys(newAnomalies).length} scored above threshold${confirmed ? ` (${confirmed} confirmed)` : ''}`, 'warn')
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

  // ── auto-refresh ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoOn) {
      fetchFlightsRef.current?.()
      autoRef.current = setInterval(
        () => fetchFlightsRef.current?.(),
        settings.interval * 1000
      )
      return () => clearInterval(autoRef.current)
    }
  }, [autoOn, settings.interval])

  const toggleAuto = () => {
    if (autoOn) {
      clearInterval(autoRef.current)
      setAutoOn(false)
      log('auto-refresh disabled', 'info')
    } else {
      setAutoOn(true)
      log(`auto-refresh enabled (${settings.interval}s)`, 'info')
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
      const existing = trackHistoryRef.current[flight.icao]
      if (!existing || existing.length < 3) {
        fetchAircraftTrack(flight.icao, 60)
          .then((rows) => {
            if (rows.length > 0) {
              const backendSnaps = rows.map((r) => ({
                ts: new Date(r.seen_at).getTime(),
                alt: r.alt, vel: r.vel, hdg: r.hdg, grounded: !!r.grounded,
              }))
              setTrackHistory((prev) => {
                const mem = prev[flight.icao] || []
                // merge: backend rows first, then in-memory (dedup by ts)
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

      log(`adsbdb: lookup ${flight.icao} / ${flight.callsign}`, 'info')
      try {
        const data = await enrichFlight(flight.icao, flight.callsign)
        setEnrichCache((prev) => ({ ...prev, [flight.icao]: data }))
        log(
          `adsbdb: ${flight.icao} — aircraft=${data.aircraft ? 'found' : 'unknown'} route=${data.flightroute ? 'found' : 'unknown'}`,
          'ok'
        )
      } catch (err) {
        log(`adsbdb error: ${err.message}`, 'err')
        setEnrichCache((prev) => ({
          ...prev,
          [flight.icao]: { aircraft: null, flightroute: null },
        }))
      }
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
    if (autoOn) {
      clearInterval(autoRef.current)
      autoRef.current = setInterval(fetchFlights, newSettings.interval * 1000)
    }
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
      <div className="grid grid-rows-[auto_auto_auto_1fr_auto] grid-cols-1 md:grid-cols-[1fr_300px] h-screen overflow-hidden">
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

        {/* Detail panel */}
        <div className="row-start-4 overflow-y-auto min-h-0 hidden md:block">
          <DetailPanel
            flight={selectedFlight}
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

        {/* Bottom status bar */}
        <div className="col-span-full row-start-5 bg-acc py-0.5 px-2.5 flex justify-between text-[11px] text-bg shrink-0">
          <div>
            <span className="bg-bg text-acc py-0 px-2 mr-1.5">NORMAL</span>
            <span>{botSrc}</span>
          </div>
          <div>{statusText}</div>
        </div>
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
