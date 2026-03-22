import { useState, useEffect, useRef, useCallback } from 'react'

import TopBar        from './components/TopBar'
import ControlBar    from './components/ControlBar'
import LogPanel      from './components/LogPanel'
import FlightTable   from './components/FlightTable'
import DetailPanel   from './components/DetailPanel'
import SettingsModal from './components/SettingsModal'
import UsagePanel    from './components/UsagePanel'

import { fetchStates }  from './services/opensky'
import { fetchAdsbx }   from './services/adsbx'
import { enrichFlight } from './services/adsbdb'
import { checkHealth }  from './services/aeroapi'

// ── default settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  sourcePref:  'auto',
  adsbxKey:    '',
  adsbxRadius: 100,
  interval:    30,
}

function loadSettings() {
  try {
    const s = localStorage.getItem('ft_cfg')
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(s) {
  try { localStorage.setItem('ft_cfg', JSON.stringify(s)) } catch {}
}

// ── log helper ────────────────────────────────────────────────────────────────
function makeEntry(msg, type = '') {
  return { msg, type, time: new Date().toISOString().substring(11, 19) }
}

// ── layout styles ─────────────────────────────────────────────────────────────
const layout = {
  root: {
    display: 'grid',
    gridTemplateRows: 'auto auto auto 1fr auto',
    gridTemplateColumns: '1fr 300px',
    height: '100vh',
    overflow: 'hidden',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    gridColumn: '1',
    gridRow: '4',
  },
  botbar: {
    gridColumn: '1 / -1',
    background: 'var(--acc)',
    padding: '2px 10px',
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: 'var(--bg)',
    flexShrink: 0,
  },
  mode: {
    background: 'var(--bg)',
    color: 'var(--acc)',
    padding: '0 8px',
    marginRight: '6px',
  },
}

export default function App() {
  // ── core state ──────────────────────────────────────────────────────────────
  const [flights,      setFlights]      = useState([])
  const [logEntries,   setLogEntries]   = useState([])
  const [settings,     setSettings]     = useState(loadSettings)
  const [region,       setRegion]       = useState('global')
  const [filter,       setFilter]       = useState('')
  const [fetching,     setFetching]     = useState(false)
  const [autoOn,       setAutoOn]       = useState(false)
  const [activeSource, setActiveSource] = useState('opensky')
  const [backendOk,    setBackendOk]    = useState(false)
  const [statusText,   setStatusText]   = useState('idle')
  const [lastFetchAt,  setLastFetchAt]  = useState(null)   // Date.now() of last successful fetch

  // ── UI overlay state ────────────────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false)
  const [showUsage,    setShowUsage]    = useState(false)

  // ── detail / enrichment state ───────────────────────────────────────────────
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [enrichCache,    setEnrichCache]    = useState({})  // icao → { aircraft, flightroute }
  const [aeroCache,      setAeroCache]      = useState({})  // icao → aero flight data

  // ── auto-refresh ref ────────────────────────────────────────────────────────
  const autoRef = useRef(null)
  // Always hold the latest fetchFlights so the interval never goes stale
  const fetchFlightsRef = useRef(null)

  // ── logging ──────────────────────────────────────────────────────────────────
  const log = useCallback((msg, type = '') => {
    setLogEntries(prev => [...prev.slice(-199), makeEntry(msg, type)])
  }, [])

  const clearLog = useCallback(() => {
    setLogEntries([makeEntry('log cleared', 'info')])
  }, [])

  // ── backend health check ─────────────────────────────────────────────────────
  useEffect(() => {
    checkHealth()
      .then(d => {
        setBackendOk(true)
        log(`backend ok · aeroapi configured: ${d.aeroapi_configured}`, 'ok')
      })
      .catch(() => {
        setBackendOk(false)
        log('backend offline — start the Express server (cd backend && npm run dev)', 'warn')
      })
  }, [])

  // ── boot log + initial fetch ─────────────────────────────────────────────────
  useEffect(() => {
    log('flightterm v4 ready', 'ok')
    log('live: opensky (default) · adsbx (optional) — see ⚙ settings', 'info')
    log('enrichment: adsbdb (free, auto) · aeroapi (on-demand, $0.005/call)', 'info')
    // kick off an initial fetch on load
    setTimeout(() => fetchFlightsRef.current?.(), 0)
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
    setFetching(true)
    setStatusText('fetching')

    const src = resolveSource()

    let result = null
    let usedSource = src

    if (src === 'adsbx') {
      try {
        log(`adsbx: querying lat/lon radius ${settings.adsbxRadius}nm · region=${region}`, 'info')
        const { flights: f, remaining } = await fetchAdsbx(region, settings.adsbxKey, settings.adsbxRadius)
        result = f
        setActiveSource('adsbx')
        log(`adsbx: ${f.length} aircraft${remaining ? ` · quota remaining: ${remaining}` : ''}`, 'ok')
        const mil = f.filter(x => x.mil).length
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
        result = await fetchStates(region)
        setActiveSource('opensky')
        log(`opensky: ${result.length} state vectors received`, 'ok')
      } catch (err) {
        log(`opensky error: ${err.message}`, 'err')
        result = []
      }
    }

    if (result && result.length > 0) {
      setFlights(result)
      setLastFetchAt(Date.now())
    } else if (result !== null) {
      log('no aircraft data returned — possibly rate limited, wait ~60s', 'warn')
    }

    setFetching(false)
    setStatusText('idle')
  }, [fetching, settings, region, log])

  // Keep ref current so the interval always calls the latest fetchFlights
  useEffect(() => { fetchFlightsRef.current = fetchFlights }, [fetchFlights])

  // ── auto-refresh ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoOn) {
      fetchFlightsRef.current?.()
      autoRef.current = setInterval(() => fetchFlightsRef.current?.(), settings.interval * 1000)
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

  // ── row selection + adsbdb enrichment ────────────────────────────────────────
  const handleSelectFlight = useCallback(async (flight) => {
    setSelectedFlight(flight)

    if (enrichCache[flight.icao]) return  // already cached

    log(`adsbdb: lookup ${flight.icao} / ${flight.callsign}`, 'info')
    try {
      const data = await enrichFlight(flight.icao, flight.callsign)
      setEnrichCache(prev => ({ ...prev, [flight.icao]: data }))
      log(
        `adsbdb: ${flight.icao} — aircraft=${data.aircraft ? 'found' : 'unknown'} route=${data.flightroute ? 'found' : 'unknown'}`,
        'ok'
      )
    } catch (err) {
      log(`adsbdb error: ${err.message}`, 'err')
      setEnrichCache(prev => ({ ...prev, [flight.icao]: { aircraft: null, flightroute: null } }))
    }
  }, [enrichCache, log])

  // ── aero cache update (called by DetailPanel after query) ─────────────────────
  const handleAeroFetched = useCallback((icao, data) => {
    setAeroCache(prev => ({ ...prev, [icao]: data }))
    log(`aeroapi: ${icao} — ${data ? 'data received' : 'no flight data'}`, data ? 'ok' : 'warn')
  }, [log])

  // ── settings save ─────────────────────────────────────────────────────────────
  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings)
    saveSettings(newSettings)
    log(`settings saved · source=${newSettings.sourcePref} interval=${newSettings.interval}s`, 'ok')
    if (autoOn) {
      clearInterval(autoRef.current)
      autoRef.current = setInterval(fetchFlights, newSettings.interval * 1000)
    }
    setShowSettings(false)
  }

  // ── derived stats ─────────────────────────────────────────────────────────────
  const stats = {
    total:     flights.length || null,
    airborne:  flights.filter(f => !f.grounded).length || null,
    grounded:  flights.filter(f => f.grounded).length || null,
    region,
    enriched:  Object.keys(enrichCache).length + Object.keys(aeroCache).length,
    lastUpdate: flights.length
      ? new Date().toISOString().substring(11, 19) + ' utc'
      : null,
  }

  const botSrc = activeSource === 'adsbx'
    ? 'adsbexchange.com (rapidapi) + api.adsbdb.com'
    : 'opensky-network.org + api.adsbdb.com'

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        .hide-sm { display: table-cell; }
        @media (max-width: 580px) { .hide-sm { display: none !important; } }
        @media (max-width: 860px) {
          .detail-panel { display: none !important; }
          .app-root { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div style={layout.root} className="app-root">

        {/* Top status bar — spans full width */}
        <div style={{ gridColumn: '1 / -1', gridRow: 1 }}>
          <TopBar stats={stats} source={activeSource} backendOk={backendOk} autoOn={autoOn} lastFetchAt={lastFetchAt} />
        </div>

        {/* Control bar — spans full width */}
        <div style={{ gridColumn: '1 / -1', gridRow: 2 }}>
          <ControlBar
            filter={filter}
            onFilterChange={setFilter}
            onFetch={fetchFlights}
            fetching={fetching}
            autoOn={autoOn}
            onToggleAuto={toggleAuto}
            onClearLog={clearLog}
            onOpenSettings={() => setShowSettings(true)}
            onOpenUsage={() => setShowUsage(true)}
            region={region}
            onRegionChange={handleRegionChange}
            interval={settings.interval}
          />
        </div>

        {/* Log panel — spans full width */}
        <div style={{ gridColumn: '1 / -1', gridRow: 3 }}>
          <LogPanel entries={logEntries} />
        </div>

        {/* Flight table */}
        <div style={{ gridRow: 4, overflowY: 'auto', minHeight: 0 }}>
          <FlightTable
            flights={flights}
            filter={filter}
            selectedIcao={selectedFlight?.icao}
            enrichCache={enrichCache}
            onSelect={handleSelectFlight}
          />
        </div>

        {/* Detail panel */}
        <div style={{ gridRow: 4, overflowY: 'auto', minHeight: 0 }} className="detail-panel">
          <DetailPanel
            flight={selectedFlight}
            enrichData={selectedFlight ? enrichCache[selectedFlight.icao] : null}
            aeroCache={aeroCache}
            onClose={() => setSelectedFlight(null)}
            onAeroFetched={handleAeroFetched}
            backendOk={backendOk}
          />
        </div>

        {/* Bottom status bar — spans full width */}
        <div style={{ ...layout.botbar, gridColumn: '1 / -1', gridRow: 5 }}>
          <div>
            <span style={layout.mode}>NORMAL</span>
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
        <UsagePanel
          onClose={() => setShowUsage(false)}
          backendOk={backendOk}
        />
      )}
    </>
  )
}
