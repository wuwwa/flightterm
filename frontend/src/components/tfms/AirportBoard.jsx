import { useState, useEffect, useRef, useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import axios from 'axios'
import AIRPORTS from '../../data/airports'

// ── AirportPicker v3 — pill trigger + map modal ─────────────────────────────
// The current selection shows as a compact pill. Clicking opens a modal with:
//   • A US map with all airports as clickable dots (positioned by lat/lon)
//   • A search input that filters BOTH the map (highlighting matches) and shows
//     a small text list for keyboard pick
// Selection persists recent picks to localStorage for quick re-access.

function AirportPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState(() => {
    try { return JSON.parse(localStorage.getItem('flightterm:recent_airports') || '[]') } catch { return [] }
  })

  const selected = value ? AIRPORTS[value] : null
  const code = value ? value.replace(/^K/, '') : ''

  const handleSelect = (icao) => {
    onChange(icao)
    setRecents(prev => {
      const next = [icao, ...prev.filter(x => x !== icao)].slice(0, 5)
      try { localStorage.setItem('flightterm:recent_airports', JSON.stringify(next)) } catch {}
      return next
    })
    setOpen(false)
  }

  return (
    <>
      {/* Compact pill trigger */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-baseline gap-1.5 bg-bg1 border border-border hover:border-acc rounded px-2 py-0.5 cursor-pointer transition-colors text-left min-w-0"
        title="click to change airport"
      >
        {selected ? (
          <>
            <span className="text-fg font-bold text-[12px] tabular-nums">{code}</span>
            <span className="text-fg3 text-[9px] truncate hidden sm:inline">{selected.city}</span>
          </>
        ) : (
          <span className="text-fg3 text-[10px]">select airport</span>
        )}
        <span className="text-fg3/50 text-[8px] ml-0.5">▾</span>
      </button>

      {open && (
        <AirportPickerModal
          value={value}
          recents={recents}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function AirportPickerModal({ value, recents, onSelect, onClose }) {
  const [query, setQuery] = useState('')
  const [hoverIcao, setHoverIcao] = useState(null)
  const inputRef = useRef(null)

  // Focus search input on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // Escape closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Filtered airports — used to dim non-matching dots and to populate the side list
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null  // null = show all
    const set = new Set()
    for (const [icao, ap] of Object.entries(AIRPORTS)) {
      const lower = icao.toLowerCase()
      const code = icao.replace(/^K/, '').toLowerCase()
      const city = (ap.city || '').toLowerCase()
      const state = (ap.state || '').toLowerCase()
      if (lower.includes(q) || code.includes(q) || city.includes(q) || state === q) set.add(icao)
    }
    return set
  }, [query])

  const allAirports = Object.entries(AIRPORTS)
  const matchList = matches
    ? allAirports.filter(([icao]) => matches.has(icao)).slice(0, 30)
    : null

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div
        className="relative bg-bg1 border border-border rounded-lg shadow-2xl w-[90vw] max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-bg2 border-b border-border rounded-t-lg shrink-0">
          <span className="text-acc font-bold text-[11px] uppercase tracking-wide">select airport</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search by code, city, or state…"
            className="flex-1 bg-bg1 border border-border text-fg text-[11px] font-mono px-2 py-1 rounded outline-none focus:border-acc placeholder:text-fg3/40"
          />
          <button onClick={onClose} className="text-fg3 hover:text-fg text-sm px-2 cursor-pointer">✕</button>
        </div>

        {/* Map + side panel */}
        <div className="flex-1 min-h-0 grid grid-cols-[1fr_200px] gap-px bg-border">
          {/* Map */}
          <div className="bg-bg1 relative" style={{ minHeight: 360 }}>
            <MapContainer
              center={[39, -96]}
              zoom={4}
              className="h-full w-full"
              style={{ background: '#1a1a1a' }}
              zoomControl={true}
              scrollWheelZoom={false}
              attributionControl={false}
            >
              <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
              {allAirports.map(([icao, ap]) => {
                const isMatch = !matches || matches.has(icao)
                const isSelected = icao === value
                const isHover = icao === hoverIcao
                const code = icao.replace(/^K/, '')
                return (
                  <CircleMarker
                    key={icao}
                    center={[ap.lat, ap.lon]}
                    radius={isSelected ? 7 : isHover ? 6 : 4}
                    pathOptions={{
                      color: isSelected ? '#81a2be' : isMatch ? '#b5bd68' : '#444',
                      fillColor: isSelected ? '#81a2be' : isMatch ? '#b5bd68' : '#444',
                      fillOpacity: isMatch ? 0.7 : 0.2,
                      weight: isSelected ? 2 : 1,
                    }}
                    eventHandlers={{
                      click: () => onSelect(icao),
                      mouseover: () => setHoverIcao(icao),
                      mouseout: () => setHoverIcao(null),
                    }}
                  >
                    <LeafletTooltip direction="top" offset={[0, -4]} className="leaflet-airport-tooltip">
                      <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                        <b>{code}</b> · {ap.city}, {ap.state}
                      </span>
                    </LeafletTooltip>
                  </CircleMarker>
                )
              })}
            </MapContainer>
          </div>

          {/* Side panel — recents + match list */}
          <div className="bg-bg1 overflow-y-auto py-1">
            {!query && recents.length > 0 && (
              <div>
                <div className="text-[8px] text-fg3/50 uppercase tracking-wide px-2 py-1">Recent</div>
                {recents.slice(0, 5).map(icao => {
                  const ap = AIRPORTS[icao]
                  if (!ap) return null
                  return <SideRow key={icao} icao={icao} ap={ap} selected={icao === value} onClick={() => onSelect(icao)} onHover={setHoverIcao} />
                })}
              </div>
            )}
            {!query && (
              <div>
                <div className="text-[8px] text-fg3/50 uppercase tracking-wide px-2 py-1 mt-1">All Tracked</div>
                {allAirports.map(([icao, ap]) => (
                  <SideRow key={icao} icao={icao} ap={ap} selected={icao === value} onClick={() => onSelect(icao)} onHover={setHoverIcao} />
                ))}
              </div>
            )}
            {query && (
              <div>
                <div className="text-[8px] text-fg3/50 uppercase tracking-wide px-2 py-1">
                  Matches ({matchList?.length || 0})
                </div>
                {matchList?.length > 0 ? (
                  matchList.map(([icao, ap]) => (
                    <SideRow key={icao} icao={icao} ap={ap} selected={icao === value} onClick={() => onSelect(icao)} onHover={setHoverIcao} />
                  ))
                ) : (
                  <div className="px-2 py-2 text-[9px] text-fg3/50">no matches</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <div className="px-3 py-1 bg-bg2 border-t border-border rounded-b-lg shrink-0 text-[8px] text-fg3/60 flex justify-between">
          <span>click any dot on the map · or search by code/city/state</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  )
}

function SideRow({ icao, ap, selected, onClick, onHover }) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => onHover(icao)}
      onMouseLeave={() => onHover(null)}
      className={clsx(
        'w-full text-left px-2 py-0.5 flex items-baseline gap-1.5 text-[10px] cursor-pointer tabular-nums',
        selected ? 'bg-acc/15 text-acc' : 'text-fg2 hover:bg-bg2'
      )}
    >
      <span className="font-bold w-8 shrink-0">{icao.replace(/^K/, '')}</span>
      <span className="text-fg2 truncate flex-1">{ap.city}</span>
      <span className="text-fg3/50 text-[9px]">{ap.state}</span>
    </button>
  )
}

const STATUS_COLORS = {
  ACTIVE: 'text-grn', ASCENDING: 'text-cyn', CRUISING: 'text-acc',
  DESCENDING: 'text-ylw', COMPLETED: 'text-fg3', FILED: 'text-mag', CANCELLED: 'text-red',
  PLANNED: 'text-mag',
}

const STATUS_SHORT = {
  ACTIVE: 'Active', ASCENDING: 'Climb', CRUISING: 'Cruise',
  DESCENDING: 'Descend', COMPLETED: 'Done', FILED: 'Filed',
  CANCELLED: 'Cancel', LANDED: 'Landed', PLANNED: 'Plan',
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d)) return ts.substring?.(11, 16) || '—'
  return d.toISOString().substring(11, 16) + 'z'
}

function LoadingDots() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function AirportBoard({ backendOk, airport, onAirportChange }) {
  const [tab, setTab] = useState('flights')
  const [ops, setOps] = useState(null)
  const [surfaceFlow, setSurfaceFlow] = useState(null)
  const [headerMetar, setHeaderMetar] = useState(null)
  const [loading, setLoading] = useState(false)
  const [newAcids, setNewAcids] = useState(new Set())
  const prevArrRef = useRef(new Set())
  const prevDepRef = useRef(new Set())
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [lifecycle, setLifecycle] = useState(null)
  const [lcLoading, setLcLoading] = useState(false)

  // Lazy-loaded tab data
  const [metar, setMetar] = useState(null)
  const [notams, setNotams] = useState(null)
  const [surface, setSurface] = useState(null)
  const [flowDetail, setFlowDetail] = useState(null)
  const [tabLoading, setTabLoading] = useState(false)
  const loadedTabsRef = useRef({})

  // Fetch ops + surface flow + METAR (always, in parallel)
  useEffect(() => {
    if (!airport || !backendOk) { setOps(null); setSurfaceFlow(null); setHeaderMetar(null); setLoading(false); return }
    let cancelled = false
    setOps(null)
    setSurfaceFlow(null)
    setHeaderMetar(null)
    setLoading(true)
    setNewAcids(new Set())
    prevArrRef.current = new Set()
    prevDepRef.current = new Set()
    // Reset lazy tab data
    setMetar(null); setNotams(null); setSurface(null); setFlowDetail(null)
    loadedTabsRef.current = {}
    setTab('flights')

    const refresh = () => {
      Promise.allSettled([
        axios.get(`/api/swim/airport/${airport}/ops`),
        axios.get(`/api/swim/airport/${airport}/surface-flow`),
        axios.get('/api/weather/metar', { params: { ids: airport } }),
      ]).then(([opsRes, flowRes, metarRes]) => {
        if (cancelled) return
        if (opsRes.status === 'fulfilled') setOps(opsRes.value.data)
        if (flowRes.status === 'fulfilled') setSurfaceFlow(flowRes.value.data)
        if (metarRes.status === 'fulfilled') {
          const m = Array.isArray(metarRes.value.data) ? metarRes.value.data[0] : metarRes.value.data
          setHeaderMetar(m || null)
        }
        setLoading(false)
      })
    }
    refresh()
    const id = setInterval(refresh, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [airport, backendOk])

  // Lazy-load tab data when tab changes
  useEffect(() => {
    if (!airport || tab === 'flights' || loadedTabsRef.current[tab]) return
    loadedTabsRef.current[tab] = true
    setTabLoading(true)

    if (tab === 'weather') {
      axios.get('/api/weather/metar', { params: { ids: airport } })
        .then(r => setMetar(Array.isArray(r.data) ? r.data[0] : null))
        .catch(() => {})
        .finally(() => setTabLoading(false))
    } else if (tab === 'notams') {
      axios.get(`/api/swim/notams/${airport}`)
        .then(r => setNotams(r.data))
        .catch(() => setNotams([]))
        .finally(() => setTabLoading(false))
    } else if (tab === 'surface') {
      Promise.allSettled([
        axios.get(`/api/swim/surface/${airport}`, { params: { limit: 30 } }),
        axios.get(`/api/swim/airport/${airport}/surface-flow`),
      ]).then(([movRes, flowRes]) => {
        setSurface({
          events: movRes.status === 'fulfilled' ? movRes.value.data : [],
          flow: flowRes.status === 'fulfilled' ? flowRes.value.data : null,
        })
      }).finally(() => setTabLoading(false))
    } else if (tab === 'flow') {
      axios.get(`/api/swim/flow/${airport}`, { params: { limit: 20 } })
        .then(r => setFlowDetail(r.data))
        .catch(() => setFlowDetail([]))
        .finally(() => setTabLoading(false))
    }
  }, [tab, airport])

  // Fetch lifecycle when a flight is selected
  useEffect(() => {
    if (!selectedFlight) { setLifecycle(null); return }
    setLcLoading(true)
    axios.get(`/api/swim/flight/${selectedFlight}/lifecycle`)
      .then(r => setLifecycle(r.data))
      .catch(() => setLifecycle(null))
      .finally(() => setLcLoading(false))
  }, [selectedFlight])

  useEffect(() => { setSelectedFlight(null) }, [airport])

  const arrivals = ops?.arrivals || []
  const departures = ops?.departures || []
  const recentArrivals = ops?.recentArrivals || []
  const cfg = ops?.config
  const flow = ops?.flow
  const delays = ops?.delays
  const taxi = ops?.taxi
  const cap = ops?.capacity

  // Track new flights
  useEffect(() => {
    if (!ops) return
    const currArr = new Set(arrivals.map(f => f.acid))
    const currDep = new Set(departures.map(f => f.acid))
    const fresh = new Set()
    for (const acid of currArr) { if (!prevArrRef.current.has(acid)) fresh.add(acid) }
    for (const acid of currDep) { if (!prevDepRef.current.has(acid)) fresh.add(acid) }
    prevArrRef.current = currArr
    prevDepRef.current = currDep
    if (fresh.size > 0) {
      setNewAcids(fresh)
      const timer = setTimeout(() => setNewAcids(new Set()), 2500)
      return () => clearTimeout(timer)
    }
  }, [ops, arrivals, departures])

  const TABS = [
    { id: 'flights', label: 'Flights', count: arrivals.length + departures.length || null },
    { id: 'weather', label: 'Weather', count: ops?.weather?.length || null },
    { id: 'notams', label: 'NOTAMs', count: notams?.length },
    { id: 'surface', label: 'Surface', count: surface?.events?.length ?? (Array.isArray(surface) ? surface.length : null) },
    { id: 'flow', label: 'Flow', count: flowDetail?.length ?? ops?.flow?.events?.length },
  ]

  // Airport metadata lookup (city/state from local AIRPORTS, falls back gracefully)
  const meta = airport && AIRPORTS[airport]
  const airportCode = (airport || '').replace(/^K/, '')

  // Build a status banner from currently-active conditions. Only renders when something is happening.
  const banners = []
  if (flow?.groundStop) {
    banners.push({
      kind: 'critical',
      label: 'GROUND STOP',
      detail: flow.groundStop.reason ? flow.groundStop.reason.toLowerCase().substring(0, 50) : 'no departures',
    })
  }
  if (flow?.gdp) {
    banners.push({
      kind: 'warn',
      label: 'GDP',
      detail: flow.gdp.delay_minutes ? `avg ${Math.round(flow.gdp.delay_minutes)}m delay` : 'arrivals delayed',
    })
  }
  const hazards = (ops?.weather || []).filter(w => w.severity === 'CRITICAL' || w.severity === 'HIGH')
  if (hazards.length > 0) {
    const types = [...new Set(hazards.map(h => h.event_type?.toLowerCase().replace(/_/g, ' ')))].slice(0, 3)
    banners.push({ kind: 'warn', label: 'HAZARDS', detail: types.join(', ') })
  }
  if (ops?.cascade) {
    banners.push({
      kind: 'warn',
      label: 'CASCADE',
      detail: `${ops.cascade.affectedFlights} flights held at ${ops.cascade.originAirports} other airports`,
    })
  }

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Header — airport identity + key context */}
      <div className="flex items-center gap-2 px-2 py-1 bg-bg2 border-b border-border shrink-0">
        <AirportPicker value={airport} onChange={onAirportChange} />

        {airport && meta && (
          <span className="text-fg3 text-[9px] truncate hidden md:inline">{meta.state}</span>
        )}

        {/* Quick traffic summary inline so it's visible at a glance */}
        {airport && ops && (
          <span className="hidden sm:flex items-center gap-2 text-[9px] tabular-nums ml-2">
            <span className="text-cyn"><span className="font-bold">{cap?.inbound || 0}</span> in</span>
            <span className="text-grn"><span className="font-bold">{cap?.outbound || 0}</span> out</span>
          </span>
        )}

        {/* Right side: METAR snippet (always available) + runways from config when present */}
        <div className="ml-auto flex items-center gap-3 text-[9px] text-fg3 shrink-0 tabular-nums">
          {cfg && (
            <>
              <span>Arr <span className="text-cyn font-bold">{cfg.arr_runway || '—'}</span></span>
              <span>Dep <span className="text-grn font-bold">{cfg.dep_runway || '—'}</span></span>
              {cfg.weather && (
                <span className={clsx('font-bold', cfg.weather === 'IMC' ? 'text-ylw' : 'text-grn')}>
                  {cfg.weather}
                </span>
              )}
            </>
          )}
          {headerMetar && <MetarSnippet m={headerMetar} />}
        </div>
      </div>

      {/* Status banner — only renders when there's something to report */}
      {airport && banners.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-0.5 border-b border-white/5 bg-bg2/40 shrink-0">
          {banners.map((b, i) => (
            <span key={i} className={clsx(
              'flex items-center gap-1 text-[9px] px-1.5 py-0 rounded border',
              b.kind === 'critical' ? 'bg-red/15 text-red border-red/40 animate-pulse'
                : 'bg-ylw/15 text-ylw border-ylw/40'
            )}>
              <span className="font-bold uppercase">{b.label}</span>
              <span className="text-fg3 normal-case font-normal">{b.detail}</span>
            </span>
          ))}
        </div>
      )}

      {!airport ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-fg3 px-4">
          <span className="text-[10px]">select an airport to view live operations</span>
          <span className="text-[8px] text-fg3/50">real-time arrivals, departures, weather, NOTAMs, and flow control</span>
        </div>
      ) : loading ? (
        <LoadingDots />
      ) : (
        <>
          {/* Metrics row v2 — computes useful KPIs from existing arrivals/departures
              data so the section is always populated, even for airports without
              full STDDS/ITWS coverage. */}
          {ops && (
            <MetricsRow
              ops={ops}
              arrivals={arrivals}
              departures={departures}
              recentArrivals={recentArrivals}
              cap={cap}
              delays={delays}
              taxi={taxi}
              surfaceFlow={surfaceFlow}
            />
          )}

          {/* Airport context strip — surfaces airport-wide stats inline so they're
              always visible (was previously hidden in the right sidebar). */}
          {ops && (
            <AirportContextStrip
              arrivals={arrivals}
              departures={departures}
              recentArrivals={recentArrivals}
            />
          )}

          {/* Tabs */}
          <div className="flex gap-0 border-b border-border shrink-0 bg-bg2/50 px-1">
            {TABS.map(t => (
              <button
                key={t.id}
                className={clsx(
                  'px-2 py-0.5 text-[9px] cursor-pointer border-b transition-colors',
                  tab === t.id ? 'text-acc border-acc' : 'text-fg3 border-transparent hover:text-fg2'
                )}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.count > 0 && <span className="text-fg3/40 ml-0.5">{t.count}</span>}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 flex flex-col">
            {tab === 'flights' && (
              <FlightsTab
                arrivals={arrivals} departures={departures} recentArrivals={recentArrivals}
                newAcids={newAcids} selectedFlight={selectedFlight} setSelectedFlight={setSelectedFlight}
                lifecycle={lifecycle} lcLoading={lcLoading} taxi={taxi} loading={loading}
              />
            )}
            {tab === 'weather' && (tabLoading && !metar ? <LoadingDots /> : <WeatherTab metar={metar} opsWeather={ops?.weather} />)}
            {tab === 'notams' && (tabLoading && !notams ? <LoadingDots /> : <NotamsTab notams={notams} />)}
            {tab === 'surface' && (tabLoading && !surface ? <LoadingDots /> : <SurfaceTab surface={surface} />)}
            {tab === 'flow' && (tabLoading && !flowDetail ? <LoadingDots /> : <FlowTab flow={flowDetail} />)}
          </div>
        </>
      )}
    </div>
  )
}

// ── Flights Tab v2 — denser rows + side stats panel when nothing selected ────

// Format an ETA/ETD as a relative delta from now: "+17m", "-3m", "now"
function fmtRel(iso) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  const m = Math.round((t - Date.now()) / 60000)
  if (m === 0) return 'now'
  if (Math.abs(m) > 360) return null // > 6 hours, suppress (probably stale)
  return m > 0 ? `+${m}m` : `${m}m`
}

function relColor(rel) {
  if (!rel) return 'text-fg3/40'
  if (rel === 'now') return 'text-ylw font-bold'
  const m = parseInt(rel)
  if (isNaN(m)) return 'text-fg3'
  if (m < 0) return 'text-fg3/40' // past
  if (m < 15) return 'text-ylw'   // imminent
  if (m < 60) return 'text-fg2'   // soon
  return 'text-fg3'                // later
}

// Format altitude as FL (rounded to nearest 10). Strips trailing letters like "C".
function fmtFL(alt) {
  if (alt == null || alt === '') return null
  const num = parseInt(String(alt).replace(/[^\d]/g, ''))
  if (isNaN(num) || num <= 0) return null
  return `FL${num}`
}

function FlightRow({ f, onClick, isNew, isSelected, accent, originField, timeField }) {
  const rel = fmtRel(f[timeField])
  const abs = fmtTime(f[timeField])
  const fl = fmtFL(f.reported_alt || f.altitude)
  return (
    <div
      onClick={onClick}
      title={`${f.acid} · ${f.dep_arpt}→${f.arr_arpt} · ${abs}${rel ? ` (${rel})` : ''}`}
      className={clsx(
        'flex items-center gap-1.5 py-0.5 px-2 text-[9px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors tabular-nums',
        isNew && 'animate-row-arrive',
        isSelected && 'bg-acc/10 border-l-2 border-l-acc'
      )}
    >
      <span className={clsx('font-bold w-14 shrink-0 truncate', isSelected ? 'text-acc' : 'text-fg2')}>{f.acid}</span>
      <span className="text-fg3 w-8 shrink-0">{f[originField]?.replace(/^K/, '') || '?'}</span>
      <span className={clsx('w-10 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3/40')}>
        {STATUS_SHORT[f.flight_status] || 'Sched'}
      </span>
      <span className="text-fg3/60 w-10 shrink-0 text-right">{fl || ''}</span>
      {/* Combined time: shows relative if known and recent, otherwise absolute */}
      <span className="ml-auto shrink-0 flex items-baseline gap-1">
        {rel ? (
          <>
            <span className={relColor(rel)}>{rel}</span>
            <span className={clsx('text-[8px] opacity-60', accent)}>{abs}</span>
          </>
        ) : (
          <span className={clsx('text-[9px]', accent)}>{abs}</span>
        )}
      </span>
    </div>
  )
}

function FlightsTab({ arrivals, departures, recentArrivals, newAcids, selectedFlight, setSelectedFlight, lifecycle, lcLoading, taxi, loading }) {
  // Adaptive grid: 2-column when no flight selected (Arrivals + Departures get full width).
  // When a flight is clicked, the 240px lifecycle column slides in.
  return (
    <div
      className={clsx(
        'flex-1 min-h-0 grid gap-px bg-border',
        selectedFlight ? 'grid-cols-[1fr_1fr_240px]' : 'grid-cols-[1fr_1fr]'
      )}
    >
      {/* Arrivals */}
      <div className="bg-bg1 flex flex-col min-h-0">
        <div className="px-2 py-0.5 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between">
          <span className="text-cyn font-bold text-[10px]">ARRIVALS</span>
          <span className="text-fg3">{arrivals.length} inbound{recentArrivals.length > 0 ? ` · ${recentArrivals.length} landed` : ''}</span>
        </div>
        <div className="flex items-center gap-1.5 py-0 px-2 text-[7px] text-fg3/40 border-b border-white/3 shrink-0 uppercase tracking-wide">
          <span className="w-14 shrink-0">Flight</span>
          <span className="w-8 shrink-0">From</span>
          <span className="w-10 shrink-0">Status</span>
          <span className="w-10 shrink-0 text-right">Alt</span>
          <span className="ml-auto shrink-0">ETA</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {arrivals.length > 0 ? arrivals.map(f => (
            <FlightRow
              key={f.acid}
              f={f}
              onClick={() => setSelectedFlight(prev => prev === f.acid ? null : f.acid)}
              isNew={newAcids.has(f.acid)}
              isSelected={selectedFlight === f.acid}
              accent="text-cyn"
              originField="dep_arpt"
              timeField="eta"
            />
          )) : <div className="py-2 text-center text-fg3 text-[9px]">no arrivals</div>}
          {recentArrivals.length > 0 && (
            <>
              <div className="px-2 py-0.5 text-[7px] text-fg3/50 bg-bg2/50 border-t border-border uppercase tracking-wide">Landed</div>
              {recentArrivals.map(f => (
                <div key={f.acid} onClick={() => setSelectedFlight(prev => prev === f.acid ? null : f.acid)}
                  className={clsx('flex items-center gap-1.5 py-0.5 px-2 text-[9px] border-b border-white/3 opacity-50 cursor-pointer hover:opacity-80 tabular-nums', selectedFlight === f.acid && 'bg-acc/10 opacity-100!')}>
                  <span className="text-fg3 font-bold w-14 shrink-0 truncate">{f.acid}</span>
                  <span className="text-fg3 w-8 shrink-0">{f.dep_arpt?.replace(/^K/, '') || '?'}</span>
                  <span className="text-fg3 w-10 shrink-0">Done</span>
                  <span className="ml-auto shrink-0 text-fg3/60">{fmtTime(f.ata)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Departures */}
      <div className="bg-bg1 flex flex-col min-h-0">
        <div className="px-2 py-0.5 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between">
          <span className="text-grn font-bold text-[10px]">DEPARTURES</span>
          <span className="text-fg3">{departures.length} outbound</span>
        </div>
        <div className="flex items-center gap-1.5 py-0 px-2 text-[7px] text-fg3/40 border-b border-white/3 shrink-0 uppercase tracking-wide">
          <span className="w-14 shrink-0">Flight</span>
          <span className="w-8 shrink-0">To</span>
          <span className="w-10 shrink-0">Status</span>
          <span className="w-10 shrink-0 text-right">Alt</span>
          <span className="ml-auto shrink-0">ETD</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {departures.length > 0 ? departures.map(f => (
            <FlightRow
              key={f.acid}
              f={f}
              onClick={() => setSelectedFlight(prev => prev === f.acid ? null : f.acid)}
              isNew={newAcids.has(f.acid)}
              isSelected={selectedFlight === f.acid}
              accent="text-grn"
              originField="arr_arpt"
              timeField="etd"
            />
          )) : <div className="py-2 text-center text-fg3 text-[9px]">no departures</div>}
        </div>
      </div>

      {/* Lifecycle sidebar — only renders when a flight is selected. The airport
          stats live in the horizontal context strip above the tabs now. */}
      {selectedFlight && (
      <div className="bg-bg1 flex flex-col min-h-0">
        <div className="px-2 py-0.5 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between items-center">
          <span className="text-fg2 font-bold text-[10px]">FLIGHT DETAIL</span>
          <button onClick={() => setSelectedFlight(null)} className="text-fg3 hover:text-fg2 px-1 cursor-pointer">✕</button>
        </div>
        {lcLoading ? <LoadingDots /> : lifecycle ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {lifecycle.plan && (
              <div className="px-2 py-1 border-b border-white/5 flex items-center gap-1.5">
                <span className="text-acc font-bold text-[10px]">{selectedFlight}</span>
                <span className="text-fg2 text-[9px]">{lifecycle.plan.dep_arpt?.replace(/^K/, '')} → {lifecycle.plan.arr_arpt?.replace(/^K/, '')}</span>
                {lifecycle.plan.aircraft_type && <span className="text-fg3 text-[8px]">{lifecycle.plan.aircraft_type}</span>}
              </div>
            )}
            <div className="px-2 py-1.5"><PhaseBar milestones={lifecycle.milestones} /></div>
            <div className="px-2 relative">
              <div className="absolute left-[11px] top-1 bottom-1 w-px bg-border2" />
              <div className="space-y-1.5">
                <Milestone label="GATE OUT" data={lifecycle.milestones?.gateOut} color="ylw" planned={lifecycle.plan?.etd} />
                <Milestone label="WHEELS UP" data={lifecycle.milestones?.wheelsOff} color="grn" />
                <Milestone label="WHEELS DN" data={lifecycle.milestones?.wheelsOn} color="cyn" />
                <Milestone label="GATE IN" data={lifecycle.milestones?.gateIn} color="acc" planned={lifecycle.plan?.eta} />
              </div>
            </div>
            <div className="px-2 mt-1.5 pt-1.5 border-t border-white/5 text-[8px] space-y-0.5">
              {lifecycle.times?.taxiOut != null && <div className="flex justify-between"><span className="text-fg3">taxi out</span><span className={taxi?.out?.avg && lifecycle.times.taxiOut > taxi.out.avg * 1.5 ? 'text-ylw' : 'text-fg2'}>{lifecycle.times.taxiOut}m</span></div>}
              {lifecycle.times?.flightTime != null && <div className="flex justify-between"><span className="text-fg3">airborne</span><span className="text-fg2">{lifecycle.times.flightTime}m</span></div>}
              {lifecycle.times?.taxiIn != null && <div className="flex justify-between"><span className="text-fg3">taxi in</span><span className="text-fg2">{lifecycle.times.taxiIn}m</span></div>}
              {lifecycle.times?.gateToGate != null && <div className="flex justify-between pt-0.5 border-t border-white/5"><span className="text-fg3">total</span><span className="text-acc font-bold">{lifecycle.times.gateToGate}m</span></div>}
              {lifecycle.delays?.departure != null && <div className="flex justify-between"><span className="text-fg3">dep delay</span><span className={lifecycle.delays.departure > 15 ? 'text-red' : lifecycle.delays.departure > 5 ? 'text-ylw' : 'text-grn'}>{lifecycle.delays.departure > 0 ? '+' : ''}{lifecycle.delays.departure}m</span></div>}
              {lifecycle.delays?.arrival != null && <div className="flex justify-between"><span className="text-fg3">arr delay</span><span className={lifecycle.delays.arrival > 15 ? 'text-red' : lifecycle.delays.arrival > 5 ? 'text-ylw' : 'text-grn'}>{lifecycle.delays.arrival > 0 ? '+' : ''}{lifecycle.delays.arrival}m</span></div>}
            </div>
            {/* En-route phases */}
            {lifecycle.phases?.length > 0 && (
              <div className="px-2 mt-1.5 pt-1.5 border-t border-white/5 text-[8px] space-y-0.5">
                <div className="text-[7px] text-fg3/50 uppercase">En-Route</div>
                {lifecycle.phases.map((p, i) => (
                  <div key={i} className="flex justify-between">
                    <span className={p.phase === 'CLIMB' ? 'text-grn' : p.phase === 'DESCENT' ? 'text-cyn' : 'text-fg3'}>{p.phase}</span>
                    <span className="text-fg2 tabular-nums">
                      {p.startAlt != null ? `FL${Math.round(p.startAlt)}→${Math.round(p.endAlt)}` : ''} {p.durationMin}m
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* ARTCC progression */}
            {lifecycle.artccProgression?.length > 0 && (
              <div className="px-2 mt-1 text-[7px] text-fg3">
                {lifecycle.artccProgression.map(a => a.artcc).join(' → ')}
              </div>
            )}
            {/* Altitude profile */}
            {lifecycle.trail?.length > 2 && (
              <div className="px-2 mt-1">
                <AltMini trail={lifecycle.trail} />
              </div>
            )}
            {lifecycle.plan?.route && <div className="px-2 py-1.5 mt-1 border-t border-white/5"><span className="text-[7px] text-fg3 break-all">{lifecycle.plan.route}</span></div>}
          </div>
        ) : <div className="flex-1 flex items-center justify-center text-fg3 text-[8px]">no lifecycle data</div>}
      </div>
      )}
    </div>
  )
}

// ── Weather Tab ──────────────────────────────────────────────────────────────

function WeatherTab({ metar, opsWeather }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
      {metar ? (
        <>
          <div className="text-[9px] font-mono text-fg3 bg-bg2 rounded px-2 py-1">{metar.rawOb}</div>
          <div className="grid grid-cols-4 gap-2 text-[10px]">
            <div><div className="text-[7px] text-fg3/50">Wind</div><div className="text-fg2">{metar.wdir}° / {metar.wspd}kt</div></div>
            <div><div className="text-[7px] text-fg3/50">Visibility</div><div className="text-fg2">{metar.visib} sm</div></div>
            <div><div className="text-[7px] text-fg3/50">Ceiling</div><div className="text-fg2">{metar.clouds?.find(c => c.cover === 'BKN' || c.cover === 'OVC')?.base ? `${metar.clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC').base}ft` : 'Clear'}</div></div>
            <div><div className="text-[7px] text-fg3/50">Temp / Dew</div><div className="text-fg2">{metar.temp}° / {metar.dewp}°C</div></div>
          </div>
          {metar.clouds?.length > 0 && (
            <div className="flex gap-3 text-[9px]">
              <span className="text-fg3/50">Clouds:</span>
              {metar.clouds.map((c, i) => <span key={i} className="text-fg2">{c.cover} {c.base?.toLocaleString()}ft</span>)}
            </div>
          )}
        </>
      ) : <div className="py-4 text-center text-fg3 text-[10px]">No METAR available</div>}
      {opsWeather?.length > 0 && (
        <div>
          <div className="text-[8px] text-fg3/50 uppercase mb-1">Terminal Weather Alerts</div>
          {opsWeather.map((w, i) => (
            <div key={i} className={clsx('py-0.5 px-2 border-b border-white/5 text-[9px]', w.severity === 'CRITICAL' && 'bg-red/5')}>
              <span className={w.severity === 'CRITICAL' ? 'text-red font-bold' : w.severity === 'HIGH' ? 'text-ylw' : 'text-fg2'}>{w.event_type?.replace(/_/g, ' ')}</span>
              {w.text && <span className="text-fg3 ml-2">{w.text}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── NOTAMs Tab ───────────────────────────────────────────────────────────────

const KW_COLORS = { RWY: 'text-red', TWY: 'text-ylw', AIRSPACE: 'text-red', SVC: 'text-cyn', NAV: 'text-cyn', OBST: 'text-mag' }
const KW_LABELS = { RWY: 'Runway', TWY: 'Taxiway', APRON: 'Apron', AIRSPACE: 'Airspace', SVC: 'Service', NAV: 'Navigation', OBST: 'Obstacle' }

function NotamsTab({ notams }) {
  if (!notams || notams.length === 0) return <div className="flex-1 flex items-center justify-center text-fg3 text-[10px]">No active NOTAMs</div>
  return (
    <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/5">
      {notams.map((n, i) => (
        <div key={n.id || i} className={clsx('px-3 py-1.5', n.is_tfr && 'bg-red/5')}>
          <div className="flex items-center gap-2 text-[9px] mb-0.5">
            {n.is_tfr ? <span className="text-red font-bold">TFR</span>
              : n.keyword ? <span className={clsx('font-bold', KW_COLORS[n.keyword])}>{KW_LABELS[n.keyword] || n.keyword}</span>
              : <span className="text-fg3">General</span>}
            <span className="ml-auto text-fg3/50 text-[8px]">
              {n.expiration ? `exp ${n.expiration.substring(5, 16).replace('T', ' ')}z` : n.permanent ? 'PERM' : ''}
            </span>
          </div>
          <div className="text-[9px] text-fg2 font-mono leading-relaxed whitespace-pre-wrap">{n.text || n.full_text || '(no text)'}</div>
        </div>
      ))}
    </div>
  )
}

// ── Surface Tab ──────────────────────────────────────────────────────────────

const SVERB = { OFF: 'Departed', ON: 'Landed', SPOT_OUT: 'Pushback', SPOT_IN: 'At gate' }
const SCOLOR = { OFF: 'text-grn', ON: 'text-cyn', SPOT_OUT: 'text-ylw', SPOT_IN: 'text-acc' }

function SurfaceTab({ surface }) {
  const events = surface?.events || (Array.isArray(surface) ? surface : [])
  const flow = surface?.flow || null
  const oooi = events.filter(e => ['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Surface flow stats */}
      {flow && (
        <div className="p-2 border-b border-border space-y-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-bg2 rounded py-1 px-2">
              <div className={clsx('text-sm font-bold tabular-nums', flow.depQueue?.count > 5 ? 'text-red' : flow.depQueue?.count > 0 ? 'text-ylw' : 'text-grn')}>
                {flow.depQueue?.count || 0}
              </div>
              <div className="text-[7px] text-fg3">dep queue</div>
            </div>
            <div className="bg-bg2 rounded py-1 px-2">
              <div className="text-sm font-bold text-fg2 tabular-nums">{flow.activeGroundMovements || 0}</div>
              <div className="text-[7px] text-fg3">ground movements</div>
            </div>
            <div className="bg-bg2 rounded py-1 px-2">
              <div className="text-sm font-bold text-acc tabular-nums">{flow.runways?.length || 0}</div>
              <div className="text-[7px] text-fg3">active runways</div>
            </div>
          </div>

          {/* Departure queue */}
          {flow.depQueue?.count > 0 && (
            <div>
              <div className="text-[8px] text-fg3/50 uppercase mb-0.5">Waiting to depart</div>
              {flow.depQueue.flights.slice(0, 6).map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-white/3">
                  <span className="text-fg2 font-bold w-14">{f.callsign}</span>
                  <span className="text-ylw tabular-nums">{Math.round(f.wait_min)}m</span>
                  <span className="ml-auto text-fg3/50 tabular-nums">{f.pushback_time?.substring(11, 16)}z</span>
                </div>
              ))}
            </div>
          )}

          {/* Runway utilization */}
          {flow.runways?.length > 0 && (
            <div>
              <div className="text-[8px] text-fg3/50 uppercase mb-0.5">Runway ops (2hr)</div>
              <div className="flex flex-wrap gap-1.5">
                {flow.runways.map((r, i) => (
                  <span key={i} className="text-[9px] bg-bg2 rounded px-1.5 py-0.5">
                    <span className="text-fg2 font-bold">{r.runway}</span>
                    <span className={clsx('ml-1', r.event_type === 'OFF' ? 'text-grn' : 'text-cyn')}>
                      {r.ops} {r.event_type === 'OFF' ? 'dep' : 'arr'}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Throughput chart */}
          {flow.throughput?.length > 0 && (
            <div>
              <div className="text-[8px] text-fg3/50 uppercase mb-0.5">Throughput (15-min bins, <span className="text-grn">dep</span> / <span className="text-cyn">arr</span>)</div>
              <ThroughputMini bins={flow.throughput} />
            </div>
          )}
        </div>
      )}

      {/* Movement list */}
      {oooi.length > 0 ? (
        <div>
          <div className="px-2 py-0.5 text-[8px] text-fg3/50 uppercase bg-bg2/50 border-b border-white/5">Recent movements</div>
          {oooi.map((e, i) => (
            <div key={e.id || i} className="flex items-center gap-2 text-[9px] py-0.5 px-2 border-b border-white/3">
              <span className="text-fg2 font-bold w-14 shrink-0">{e.callsign || '—'}</span>
              <span className={clsx('w-14 shrink-0', SCOLOR[e.event_type])}>{SVERB[e.event_type]}</span>
              {e.runway && <span className="text-fg3">rwy {e.runway.split('/')[0]}</span>}
              {e.gate && <span className="text-fg3">gate {e.gate}</span>}
              <span className="ml-auto text-fg3/50 tabular-nums shrink-0">{e.received_at?.substring(11, 19)}z</span>
            </div>
          ))}
        </div>
      ) : !flow && (
        <div className="flex-1 flex items-center justify-center text-fg3 text-[10px] py-4">No surface data</div>
      )}
    </div>
  )
}

function ThroughputMini({ bins }) {
  const max = Math.max(...bins.map(b => Math.max(b.departures || 0, b.arrivals || 0)), 1)
  return (
    <div className="flex items-end gap-0.5" style={{ height: 28 }}>
      {bins.map((b, i) => (
        <div key={i} className="flex-1 flex gap-px justify-center" title={`${b.bin} — ${b.departures || 0} dep, ${b.arrivals || 0} arr`}>
          <div className="w-1/2 bg-grn/60 rounded-t-sm self-end" style={{ height: `${((b.departures || 0) / max) * 100}%`, minHeight: (b.departures || 0) > 0 ? 2 : 0 }} />
          <div className="w-1/2 bg-cyn/60 rounded-t-sm self-end" style={{ height: `${((b.arrivals || 0) / max) * 100}%`, minHeight: (b.arrivals || 0) > 0 ? 2 : 0 }} />
        </div>
      ))}
    </div>
  )
}

// ── Flow Tab ─────────────────────────────────────────────────────────────────

const FTYPE = { GS: 'Ground Stop', GDP: 'Ground Delay', AFP: 'Airspace Flow', REROUTE: 'Reroute', RSTR: 'Restriction', GADV: 'Advisory' }
const FCOLOR = { GS: 'text-red', GDP: 'text-ylw', AFP: 'text-ylw', REROUTE: 'text-mag' }

function FlowTab({ flow }) {
  if (!flow || flow.length === 0) return <div className="flex-1 flex items-center justify-center text-fg3 text-[10px]">No flow events</div>
  return (
    <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/5">
      {flow.map((e, i) => (
        <div key={e.id || i} className={clsx('px-3 py-1', e.event_type === 'GS' && 'bg-red/5', e.event_type === 'GDP' && 'bg-ylw/3')}>
          <div className="flex items-center gap-2 text-[9px]">
            <span className={clsx('font-bold', FCOLOR[e.event_type] || 'text-fg3')}>{FTYPE[e.event_type] || e.event_type}</span>
            {e.status && <span className="text-fg3">{e.status}</span>}
            <span className="ml-auto text-fg3/50 tabular-nums text-[8px]">{e.received_at?.substring(11, 19)}z</span>
          </div>
          {e.reason && <div className="text-[8px] text-fg3">Reason: {e.reason}</div>}
          {e.text && <div className="text-[8px] text-fg2">{e.text}</div>}
          {e.delay_minutes && <div className="text-[8px] text-fg3/50">Delay: {Math.round(e.delay_minutes)} min</div>}
        </div>
      ))}
    </div>
  )
}

// ── Airport Context Strip ──────────────────────────────────────────────────
// Compact horizontal strip showing airport-wide stats above the tabs.
// Always visible (was previously hidden in the right sidebar). Shows:
//   ETA distribution histogram | Top airlines | Top origins | Top destinations

function AirportContextStrip({ arrivals, departures, recentArrivals }) {
  const now = Date.now()

  // Top origins (where arrivals are coming FROM)
  const originCounts = {}
  for (const f of arrivals) {
    if (!f.dep_arpt) continue
    const code = f.dep_arpt.replace(/^K/, '')
    originCounts[code] = (originCounts[code] || 0) + 1
  }
  const topOrigins = Object.entries(originCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)

  // Top destinations
  const destCounts = {}
  for (const f of departures) {
    if (!f.arr_arpt) continue
    const code = f.arr_arpt.replace(/^K/, '')
    destCounts[code] = (destCounts[code] || 0) + 1
  }
  const topDests = Object.entries(destCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)

  // Top airline prefixes
  const airlineCounts = {}
  for (const f of [...arrivals, ...departures]) {
    if (!f.acid) continue
    const al = f.acid.substring(0, 3)
    if (!/^[A-Z]{3}$/.test(al)) continue
    airlineCounts[al] = (airlineCounts[al] || 0) + 1
  }
  const topAirlines = Object.entries(airlineCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)

  // ETA window distribution for arrivals
  const etaBuckets = { soon: 0, near: 0, mid: 0, far: 0 }
  for (const f of arrivals) {
    if (!f.eta) continue
    const m = (new Date(f.eta).getTime() - now) / 60000
    if (isNaN(m) || m < -5) continue
    if (m < 15) etaBuckets.soon++
    else if (m < 30) etaBuckets.near++
    else if (m < 60) etaBuckets.mid++
    else etaBuckets.far++
  }
  const etaTotal = etaBuckets.soon + etaBuckets.near + etaBuckets.mid + etaBuckets.far
  const pct = (n) => etaTotal > 0 ? Math.round((n / etaTotal) * 100) : 0

  // Don't render the strip at all when there's nothing to show
  if (!etaTotal && !topAirlines.length && !topOrigins.length && !topDests.length) return null

  // Render top entries as inline "CODE n" pills, comma-separated
  const inlineList = (entries, color) =>
    entries.map(([k, n]) => (
      <span key={k} className="inline-flex items-baseline gap-0.5 mr-1.5">
        <span className={color}>{k}</span>
        <span className="text-fg3/60 text-[8px]">{n}</span>
      </span>
    ))

  return (
    <div className="flex items-center gap-3 px-2 py-0.5 bg-bg2/40 border-b border-border shrink-0 text-[9px] tabular-nums whitespace-nowrap overflow-x-auto no-scrollbar">
      {/* ETA window — single inline line */}
      {etaTotal > 0 && (
        <span className="flex items-center gap-1 shrink-0">
          <span className="text-fg3/50 text-[8px] uppercase tracking-wide">eta</span>
          <span><span className="text-ylw font-bold">{etaBuckets.soon}</span><span className="text-fg3/50 text-[8px]">≤15m</span></span>
          <span><span className="text-cyn font-bold">{etaBuckets.near}</span><span className="text-fg3/50 text-[8px]">≤30m</span></span>
          <span><span className="text-fg2 font-bold">{etaBuckets.mid}</span><span className="text-fg3/50 text-[8px]">≤60m</span></span>
          <span><span className="text-fg3 font-bold">{etaBuckets.far}</span><span className="text-fg3/50 text-[8px]">+60m</span></span>
        </span>
      )}

      {topAirlines.length > 0 && (
        <span className="flex items-baseline gap-1 shrink-0 border-l border-border pl-3">
          <span className="text-fg3/50 text-[8px] uppercase tracking-wide">airlines</span>
          {inlineList(topAirlines, 'text-fg2 font-bold')}
        </span>
      )}

      {topOrigins.length > 0 && (
        <span className="flex items-baseline gap-1 shrink-0 border-l border-border pl-3">
          <span className="text-cyn/70 text-[8px] uppercase tracking-wide">in</span>
          {inlineList(topOrigins, 'text-cyn')}
        </span>
      )}

      {topDests.length > 0 && (
        <span className="flex items-baseline gap-1 shrink-0 border-l border-border pl-3">
          <span className="text-grn/70 text-[8px] uppercase tracking-wide">out</span>
          {inlineList(topDests, 'text-grn')}
        </span>
      )}
    </div>
  )
}

// ── Metrics row v2 ──────────────────────────────────────────────────────────
// Computes useful KPIs from existing arrivals/departures lists so the section
// is always populated, even for airports without full STDDS/ITWS coverage.

function MetricsRow({ ops, arrivals, departures, recentArrivals, cap, delays, taxi, surfaceFlow }) {
  // ── Computed stats from arrivals[] / departures[] ─────────────────────────
  const now = Date.now()

  // Next inbound — earliest ETA in the future
  const nextInbound = arrivals
    .filter(f => f.eta)
    .map(f => ({ acid: f.acid, ts: new Date(f.eta).getTime() }))
    .filter(f => !isNaN(f.ts) && f.ts > now)
    .sort((a, b) => a.ts - b.ts)[0]
  const nextInboundMin = nextInbound ? Math.round((nextInbound.ts - now) / 60000) : null

  // Next outbound — earliest ETD in the future
  const nextOutbound = departures
    .filter(f => f.etd)
    .map(f => ({ acid: f.acid, ts: new Date(f.etd).getTime() }))
    .filter(f => !isNaN(f.ts) && f.ts > now)
    .sort((a, b) => a.ts - b.ts)[0]
  const nextOutboundMin = nextOutbound ? Math.round((nextOutbound.ts - now) / 60000) : null

  // ETA proximity buckets — count arrivals within rolling time windows
  // (TFMS uses ACTIVE/FILED for status; phase isn't reliable so we derive from ETA)
  let arrSoon = 0     // < 30 minutes out
  let arrNext = 0     // 30-60 minutes
  for (const f of arrivals) {
    if (!f.eta) continue
    const min = (new Date(f.eta).getTime() - now) / 60000
    if (isNaN(min) || min < -5) continue
    if (min < 30) arrSoon++
    else if (min < 60) arrNext++
  }

  // Origin diversity — how many unique departure airports feed this arrival board
  const uniqueOrigins = new Set()
  for (const f of arrivals) if (f.dep_arpt) uniqueOrigins.add(f.dep_arpt)
  // Top origin (most-common feeder)
  const originCounts = {}
  for (const f of arrivals) {
    if (!f.dep_arpt) continue
    originCounts[f.dep_arpt] = (originCounts[f.dep_arpt] || 0) + 1
  }
  const topOrigin = Object.entries(originCounts).sort((a, b) => b[1] - a[1])[0]

  // Surface flow data (queue depth) — from ops if it has been hydrated by the surface tab
  // (only available when user has clicked the surface tab; otherwise shows neutral)

  // ── Coverage indicators — what data sources have we got for this airport ──
  const hasStdds = (taxi?.out?.count || 0) > 0 || (taxi?.in?.count || 0) > 0 || (delays?.departures?.count || 0) > 0
  const hasSurfaceFlow = !!surfaceFlow && (
    (surfaceFlow.depQueue?.count || 0) > 0 ||
    (surfaceFlow.activeGroundMovements || 0) > 0 ||
    (surfaceFlow.runways?.length || 0) > 0
  )
  const hasItws = (ops?.weather?.length || 0) > 0
  const hasFlow = (ops?.flow?.events?.length || 0) > 0
  const hasConfig = !!(cap?.arrRate || cap?.depRate || ops?.config?.arr_runway)

  return (
    <>
      <div className="grid grid-cols-4 gap-px bg-border shrink-0">
        {/* Tile 1 — Traffic */}
        <Tile label="Traffic">
          <div className="flex gap-2 text-[14px] tabular-nums leading-none">
            <span><span className="text-cyn font-bold">{cap?.inbound || 0}</span><span className="text-fg3 text-[9px]"> in</span></span>
            <span><span className="text-grn font-bold">{cap?.outbound || 0}</span><span className="text-fg3 text-[9px]"> out</span></span>
          </div>
          {recentArrivals.length > 0 && (
            <div className="text-[8px] text-fg3 mt-0.5">{recentArrivals.length} landed in last 30m</div>
          )}
        </Tile>

        {/* Tile 2 — Next inbound / outbound (always has data when there are flights) */}
        <Tile label="Next">
          <div className="flex gap-3 text-[12px] tabular-nums leading-none">
            <span>
              <span className="text-cyn font-bold">{nextInboundMin != null ? `${nextInboundMin}m` : '—'}</span>
              <span className="text-fg3 text-[9px]"> in</span>
            </span>
            <span>
              <span className="text-grn font-bold">{nextOutboundMin != null ? `${nextOutboundMin}m` : '—'}</span>
              <span className="text-fg3 text-[9px]"> out</span>
            </span>
          </div>
          <div className="text-[8px] text-fg3/60 mt-0.5 truncate">
            {nextInbound ? <span>{nextInbound.acid}</span> : null}
            {nextInbound && nextOutbound && <span className="text-fg3/30"> · </span>}
            {nextOutbound ? <span>{nextOutbound.acid}</span> : null}
          </div>
        </Tile>

        {/* Tile 3 — Avg Delay (STDDS) ▸ Queue (surface flow) ▸ Inbound Wave (TFMS only) */}
        {hasStdds ? (
          <Tile label="Avg Delay">
            <div className="flex gap-3 text-[14px] tabular-nums leading-none">
              <span>
                <span className={clsx('font-bold', delayColor(delays?.departures?.avg))}>
                  {delays?.departures?.avg != null ? `${delays.departures.avg > 0 ? '+' : ''}${delays.departures.avg}m` : '—'}
                </span>
                <span className="text-fg3 text-[9px]"> dep</span>
              </span>
              <span>
                <span className={clsx('font-bold', delayColor(delays?.arrivals?.avg))}>
                  {delays?.arrivals?.avg != null ? `${delays.arrivals.avg > 0 ? '+' : ''}${delays.arrivals.avg}m` : '—'}
                </span>
                <span className="text-fg3 text-[9px]"> arr</span>
              </span>
            </div>
            {(delays?.departures?.count || 0) + (delays?.arrivals?.count || 0) > 0 && (
              <div className="text-[8px] text-fg3 mt-0.5">{(delays?.departures?.count || 0) + (delays?.arrivals?.count || 0)} samples</div>
            )}
          </Tile>
        ) : hasSurfaceFlow ? (
          <Tile label="Dep Queue">
            <div className="flex items-baseline gap-2 text-[14px] tabular-nums leading-none">
              <span className={clsx('font-bold', (surfaceFlow.depQueue?.count || 0) > 5 ? 'text-red' : (surfaceFlow.depQueue?.count || 0) > 0 ? 'text-ylw' : 'text-grn')}>
                {surfaceFlow.depQueue?.count || 0}
              </span>
              <span className="text-fg3 text-[9px]">waiting</span>
            </div>
            <div className="text-[8px] text-fg3/60 mt-0.5">
              {surfaceFlow.depQueue?.flights?.[0] ? `${Math.round(surfaceFlow.depQueue.flights[0].wait_min)}m max wait` : 'queue clear'}
            </div>
          </Tile>
        ) : (
          <Tile label="Inbound Wave">
            <div className="flex gap-3 text-[14px] tabular-nums leading-none">
              <span>
                <span className={clsx('font-bold', arrSoon > 6 ? 'text-ylw' : 'text-cyn')}>{arrSoon}</span>
                <span className="text-fg3 text-[9px]"> ≤30m</span>
              </span>
              <span>
                <span className="text-fg2 font-bold">{arrNext}</span>
                <span className="text-fg3 text-[9px]"> 30-60m</span>
              </span>
            </div>
            <div className="text-[8px] text-fg3/60 mt-0.5">arrival pressure window</div>
          </Tile>
        )}

        {/* Tile 4 — Taxi Time (STDDS) ▸ Ground Movements (surface flow) ▸ Origins (TFMS only) */}
        {hasStdds ? (
          <Tile label="Taxi Time">
            <div className="flex gap-3 text-[14px] tabular-nums leading-none">
              <span><span className={clsx('font-bold', taxi?.out?.avg > 20 ? 'text-ylw' : taxi?.out?.avg != null ? 'text-fg2' : 'text-fg3/40')}>{taxi?.out?.avg != null ? `${taxi.out.avg}m` : '—'}</span><span className="text-fg3 text-[9px]"> out</span></span>
              <span><span className={clsx('font-bold', taxi?.in?.avg > 15 ? 'text-ylw' : taxi?.in?.avg != null ? 'text-fg2' : 'text-fg3/40')}>{taxi?.in?.avg != null ? `${taxi.in.avg}m` : '—'}</span><span className="text-fg3 text-[9px]"> in</span></span>
            </div>
            {(taxi?.out?.count || 0) + (taxi?.in?.count || 0) > 0 && (
              <div className="text-[8px] text-fg3 mt-0.5">{(taxi?.out?.count || 0) + (taxi?.in?.count || 0)} samples</div>
            )}
          </Tile>
        ) : hasSurfaceFlow ? (
          <Tile label="Ground Mvmt">
            <div className="flex items-baseline gap-2 text-[14px] tabular-nums leading-none">
              <span className="text-fg2 font-bold">{surfaceFlow.activeGroundMovements || 0}</span>
              <span className="text-fg3 text-[9px]">active</span>
            </div>
            <div className="text-[8px] text-fg3/60 mt-0.5">
              {surfaceFlow.runways?.length || 0} active rwy{surfaceFlow.runways?.length === 1 ? '' : 's'}
            </div>
          </Tile>
        ) : (
          <Tile label="Origins">
            <div className="flex items-baseline gap-2 text-[14px] tabular-nums leading-none">
              <span className="text-fg2 font-bold">{uniqueOrigins.size}</span>
              <span className="text-fg3 text-[9px]">unique</span>
            </div>
            <div className="text-[8px] text-fg3/60 mt-0.5 truncate">
              {topOrigin ? `top: ${topOrigin[0].replace(/^K/, '')} (${topOrigin[1]})` : '—'}
            </div>
          </Tile>
        )}
      </div>

      {/* Coverage strip — only shown when something is missing, so users know
          the empty fields aren't a bug — they're a data coverage gap. */}
      {!(hasStdds && hasSurfaceFlow && hasItws && hasConfig) && (
        <div className="flex items-center gap-2 px-2 py-0.5 border-b border-white/5 bg-bg2/30 text-[8px] shrink-0">
          <span className="text-fg3/50 uppercase tracking-wide">data coverage</span>
          <CoverageDot label="TFMS" on={true} />
          <CoverageDot label="STDDS" on={hasStdds || hasSurfaceFlow} />
          <CoverageDot label="ITWS" on={hasItws} />
          <CoverageDot label="cfg" on={hasConfig} />
          <CoverageDot label="flow" on={hasFlow} />
        </div>
      )}
    </>
  )
}

function Tile({ label, children }) {
  return (
    <div className="bg-bg1 px-2 py-0.5">
      <div className="text-[8px] text-fg3 uppercase tracking-wide leading-none mb-0.5">{label}</div>
      {children}
    </div>
  )
}

// Compact METAR snippet for the airport header — wind, visibility, ceiling, temp.
// Falls back gracefully if any field is missing.
function MetarSnippet({ m }) {
  if (!m) return null
  const wind = m.wdir != null && m.wspd != null
    ? `${String(m.wdir).padStart(3, '0')}@${m.wspd}${m.wgst ? `G${m.wgst}` : ''}`
    : null
  const vis = m.visib != null ? `${m.visib}sm` : null
  // Ceiling = lowest BKN/OVC layer
  const ceil = (m.clouds || []).find(c => c.cover === 'BKN' || c.cover === 'OVC')
  const ceilStr = ceil?.base ? `${Math.round(ceil.base / 100)}` : null  // hundreds of feet
  // Flight category coloring
  const cat = m.fltCat || (
    !ceil ? 'VFR'
    : ceil.base >= 3000 && (m.visib >= 5 || m.visib === '10+') ? 'VFR'
    : ceil.base >= 1000 && (m.visib >= 3 || m.visib === '10+') ? 'MVFR'
    : ceil.base >= 500 && (m.visib >= 1 || m.visib === '10+') ? 'IFR'
    : 'LIFR'
  )
  const catColor = cat === 'VFR' ? 'text-grn'
    : cat === 'MVFR' ? 'text-cyn'
    : cat === 'IFR' ? 'text-ylw'
    : 'text-red'

  return (
    <span className="flex items-center gap-2 border-l border-border pl-3" title={m.rawOb || ''}>
      <span className={clsx('font-bold text-[8px] uppercase', catColor)}>{cat}</span>
      {wind && <span><span className="text-fg2">{wind}</span><span className="text-fg3/60 text-[8px]">kt</span></span>}
      {vis && <span className="text-fg2">{vis}</span>}
      {ceilStr && <span><span className="text-fg2">BKN{ceilStr}</span></span>}
      {m.temp != null && <span><span className="text-fg2">{m.temp}</span><span className="text-fg3/60 text-[8px]">°C</span></span>}
    </span>
  )
}

function CoverageDot({ label, on }) {
  return (
    <span className="flex items-center gap-0.5">
      <span className={clsx('inline-block w-1.5 h-1.5 rounded-full', on ? 'bg-grn' : 'bg-fg3/20')} />
      <span className={on ? 'text-fg3' : 'text-fg3/30'}>{label}</span>
    </span>
  )
}

function delayColor(v) {
  if (v == null) return 'text-fg3/40'
  if (v > 15) return 'text-red'
  if (v > 5) return 'text-ylw'
  return 'text-grn'
}

// ── Shared UI ────────────────────────────────────────────────────────────────

function PhaseBar({ milestones }) {
  const phases = [
    { key: 'gateOut', label: 'PUSH', color: 'bg-ylw' },
    { key: 'wheelsOff', label: 'OFF', color: 'bg-grn' },
    { key: 'wheelsOn', label: 'ON', color: 'bg-cyn' },
    { key: 'gateIn', label: 'GATE', color: 'bg-acc' },
  ]
  return (
    <div className="flex gap-0.5">
      {phases.map(p => {
        const done = !!milestones?.[p.key]
        return (
          <div key={p.key} className="flex-1 flex flex-col items-center gap-0.5">
            <div className={clsx('w-full h-1 rounded-full', done ? p.color : 'bg-border2')} />
            <span className={clsx('text-[7px]', done ? 'text-fg2' : 'text-fg3/30')}>{p.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function AltMini({ trail }) {
  const alts = trail.map(p => p.alt).filter(a => a != null && a > 0)
  if (alts.length < 2) return null
  const maxA = Math.max(...alts), minA = Math.min(...alts), range = maxA - minA || 1
  const pts = alts.map((a, i) => `${2 + (i / (alts.length - 1)) * 196},${2 + (1 - (a - minA) / range) * 22}`).join(' ')
  return (
    <div className="bg-bg2 rounded px-1 py-0.5">
      <svg viewBox="0 0 200 26" className="w-full" style={{ height: 22 }}>
        <polyline points={pts} fill="none" stroke="#81a2be" strokeWidth="1" strokeLinejoin="round" />
      </svg>
      <div className="flex justify-between text-[6px] text-fg3/40 tabular-nums">
        <span>FL{Math.round(minA)}</span>
        <span>FL{Math.round(maxA)}</span>
      </div>
    </div>
  )
}

function Milestone({ label, data, color, planned }) {
  const time = data?.time?.substring(11, 16)
  const plannedStr = planned ? (() => { try { const d = new Date(planned); return !isNaN(d) ? d.toISOString().substring(11, 16) : null } catch { return null } })() : null

  return (
    <div className="flex items-center gap-1.5 text-[8px] relative z-10">
      <span className={clsx('w-2 h-2 rounded-full shrink-0 border', data ? `bg-${color} border-${color}` : 'bg-bg1 border-border2')} />
      <span className={clsx('w-14 shrink-0 font-bold', data ? `text-${color}` : 'text-fg3/30')}>{label}</span>
      {data ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-fg2 tabular-nums font-medium">{time}z</span>
          <span className="text-fg3/60">{data.airport?.replace(/^K/, '')}</span>
          {data.runway && <span className="text-fg3/40 truncate">{data.runway}</span>}
        </div>
      ) : (
        <div className="flex items-center gap-1 flex-1">
          {plannedStr ? <span className="text-fg3/30 tabular-nums">est {plannedStr}z</span> : <span className="text-fg3/20">—</span>}
        </div>
      )}
    </div>
  )
}
