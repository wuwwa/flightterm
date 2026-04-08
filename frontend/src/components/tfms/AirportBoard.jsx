import { useState, useEffect, useRef } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import AIRPORTS from '../../data/airports'

const STATUS_COLORS = {
  ACTIVE: 'text-grn', ASCENDING: 'text-cyn', CRUISING: 'text-acc',
  DESCENDING: 'text-ylw', COMPLETED: 'text-fg3', FILED: 'text-mag', CANCELLED: 'text-red',
}

const STATUS_SHORT = {
  ACTIVE: 'Active', ASCENDING: 'Climb', CRUISING: 'Cruise',
  DESCENDING: 'Descend', COMPLETED: 'Done', FILED: 'Filed',
  CANCELLED: 'Cancel', LANDED: 'Landed',
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

  // Fetch ops (always)
  useEffect(() => {
    if (!airport || !backendOk) { setOps(null); setLoading(false); return }
    let cancelled = false
    setOps(null)
    setLoading(true)
    setNewAcids(new Set())
    prevArrRef.current = new Set()
    prevDepRef.current = new Set()
    // Reset lazy tab data
    setMetar(null); setNotams(null); setSurface(null); setFlowDetail(null)
    loadedTabsRef.current = {}
    setTab('flights')

    const refresh = () => {
      axios.get(`/api/swim/airport/${airport}/ops`)
        .then(r => { if (!cancelled) { setOps(r.data); setLoading(false) } })
        .catch(() => { if (!cancelled) setLoading(false) })
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
    { id: 'flights', label: 'Flights' },
    { id: 'weather', label: 'Weather' },
    { id: 'notams', label: 'NOTAMs', count: notams?.length },
    { id: 'surface', label: 'Surface' },
    { id: 'flow', label: 'Flow', count: flowDetail?.length },
  ]

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Airport selector + status */}
      <div className="flex items-center gap-2 px-2 py-0.5 bg-bg2 border-b border-border shrink-0 flex-wrap">
        <select
          value={airport}
          onChange={(e) => onAirportChange(e.target.value)}
          className="bg-bg1 border border-border text-fg text-[10px] px-1.5 py-0.5 rounded outline-none focus:border-acc"
        >
          <option value="">select airport</option>
          {airport && !AIRPORTS[airport] && (
            <option value={airport}>{airport.replace(/^K/, '')}</option>
          )}
          {Object.entries(AIRPORTS)
            .sort((a, b) => a[1].city.localeCompare(b[1].city))
            .map(([icao, ap]) => (
              <option key={icao} value={icao}>{icao.replace(/^K/, '')} — {ap.city}</option>
            ))}
        </select>

        {flow?.groundStop && <span className="text-[9px] text-red font-bold animate-pulse">GROUND STOP</span>}
        {flow?.gdp && !flow?.groundStop && (
          <span className="text-[9px] text-ylw font-bold">
            GDP {flow.gdp.delay_minutes ? `${Math.round(flow.gdp.delay_minutes)}m` : ''}
          </span>
        )}

        {cfg && (
          <div className="flex gap-3 text-[8px] text-fg3 ml-auto">
            <span>Arr: <span className="text-cyn">{cfg.arr_runway || '—'}</span></span>
            <span>Dep: <span className="text-grn">{cfg.dep_runway || '—'}</span></span>
            {cfg.weather && <span className={cfg.weather === 'IMC' ? 'text-ylw' : 'text-grn'}>{cfg.weather}</span>}
          </div>
        )}
      </div>

      {!airport ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-fg3 px-4">
          <span className="text-[10px]">select an airport to view live operations</span>
          <span className="text-[8px] text-fg3/50">real-time arrivals, departures, weather, NOTAMs, and flow control</span>
        </div>
      ) : loading ? (
        <LoadingDots />
      ) : (
        <>
          {/* Metrics bar */}
          {ops && (
            <div className="grid grid-cols-4 gap-px bg-border shrink-0">
              <div className="bg-bg1 px-2 py-0.5">
                <div className="text-[7px] text-fg3/50 mb-0.5">Traffic</div>
                <div className="flex gap-2 text-[9px] tabular-nums">
                  <span><span className="text-cyn">{cap?.inbound || 0}</span> <span className="text-fg3 text-[7px]">in</span></span>
                  <span><span className="text-grn">{cap?.outbound || 0}</span> <span className="text-fg3 text-[7px]">out</span></span>
                </div>
              </div>
              <div className="bg-bg1 px-2 py-0.5">
                <div className="text-[7px] text-fg3/50 mb-0.5">Capacity</div>
                <div className="flex gap-2 text-[9px] tabular-nums">
                  {cap?.arrRate ? <span><span className="text-fg2">{cap.arrRate}</span><span className="text-fg3 text-[7px]">/hr arr</span></span> : <span className="text-fg3 text-[7px]">—</span>}
                  {cap?.depRate ? <span><span className="text-fg2">{cap.depRate}</span><span className="text-fg3 text-[7px]">/hr dep</span></span> : null}
                </div>
              </div>
              <div className="bg-bg1 px-2 py-0.5">
                <div className="text-[7px] text-fg3/50 mb-0.5">Avg Delay</div>
                <div className="flex gap-2 text-[9px] tabular-nums">
                  <span>
                    <span className={delays?.departures?.avg > 15 ? 'text-red' : delays?.departures?.avg > 5 ? 'text-ylw' : 'text-grn'}>
                      {delays?.departures?.avg != null ? `${delays.departures.avg > 0 ? '+' : ''}${delays.departures.avg}m` : '—'}
                    </span>
                    <span className="text-fg3 text-[7px]"> dep</span>
                  </span>
                  <span>
                    <span className={delays?.arrivals?.avg > 15 ? 'text-red' : delays?.arrivals?.avg > 5 ? 'text-ylw' : 'text-grn'}>
                      {delays?.arrivals?.avg != null ? `${delays.arrivals.avg > 0 ? '+' : ''}${delays.arrivals.avg}m` : '—'}
                    </span>
                    <span className="text-fg3 text-[7px]"> arr</span>
                  </span>
                </div>
              </div>
              <div className="bg-bg1 px-2 py-0.5">
                <div className="text-[7px] text-fg3/50 mb-0.5">Taxi Time</div>
                <div className="flex gap-2 text-[9px] tabular-nums">
                  <span><span className={taxi?.out?.avg > 20 ? 'text-ylw' : 'text-fg2'}>{taxi?.out?.avg != null ? `${taxi.out.avg}m` : '—'}</span><span className="text-fg3 text-[7px]"> out</span></span>
                  <span><span className={taxi?.in?.avg > 15 ? 'text-ylw' : 'text-fg2'}>{taxi?.in?.avg != null ? `${taxi.in.avg}m` : '—'}</span><span className="text-fg3 text-[7px]"> in</span></span>
                </div>
              </div>
            </div>
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

// ── Flights Tab (original arrivals/departures/lifecycle) ─────────────────────

function FlightsTab({ arrivals, departures, recentArrivals, newAcids, selectedFlight, setSelectedFlight, lifecycle, lcLoading, taxi, loading }) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-[1fr_1fr_240px] gap-px bg-border">
      {/* Arrivals */}
      <div className="bg-bg1 flex flex-col min-h-0">
        <div className="px-2 py-0.5 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between">
          <span className="text-cyn">ARRIVALS</span>
          <span className="text-fg3">{arrivals.length} inbound{recentArrivals.length > 0 ? ` · ${recentArrivals.length} landed` : ''}</span>
        </div>
        <div className="flex items-center gap-1 py-0 px-2 text-[7px] text-fg3/40 border-b border-white/3 shrink-0">
          <span className="w-14 shrink-0">Flight</span><span className="w-8 shrink-0">From</span><span className="w-12 shrink-0">Status</span><span className="ml-auto shrink-0">ETA</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {arrivals.length > 0 ? arrivals.map(f => (
            <div key={f.acid} onClick={() => setSelectedFlight(prev => prev === f.acid ? null : f.acid)}
              className={clsx('flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors', newAcids.has(f.acid) && 'animate-row-arrive', selectedFlight === f.acid && 'bg-acc/10 border-l-2 border-l-acc')}>
              <span className="text-acc font-bold w-14 shrink-0 truncate">{f.acid}</span>
              <span className="text-fg2 w-8 shrink-0">{f.dep_arpt?.replace(/^K/, '') || '?'}</span>
              <span className={clsx('w-12 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3')}>{STATUS_SHORT[f.flight_status] || f.flight_status || '—'}</span>
              <span className="text-cyn tabular-nums ml-auto shrink-0">{fmtTime(f.eta)}</span>
            </div>
          )) : <div className="py-2 text-center text-fg3 text-[8px]">no arrivals</div>}
          {recentArrivals.length > 0 && (
            <>
              <div className="px-2 py-0.5 text-[7px] text-fg3/50 bg-bg2/50 border-t border-border">LANDED</div>
              {recentArrivals.map(f => (
                <div key={f.acid} onClick={() => setSelectedFlight(prev => prev === f.acid ? null : f.acid)}
                  className={clsx('flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 opacity-50 cursor-pointer hover:opacity-80', selectedFlight === f.acid && 'bg-acc/10 opacity-100!')}>
                  <span className="text-fg3 font-bold w-14 shrink-0 truncate">{f.acid}</span>
                  <span className="text-fg3 w-8 shrink-0">{f.dep_arpt?.replace(/^K/, '') || '?'}</span>
                  <span className="text-fg3 w-12 shrink-0">Landed</span>
                  <span className="text-fg3 tabular-nums ml-auto shrink-0">{fmtTime(f.ata)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Departures */}
      <div className="bg-bg1 flex flex-col min-h-0">
        <div className="px-2 py-0.5 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between">
          <span className="text-grn">DEPARTURES</span>
          <span className="text-fg3">{departures.length} outbound</span>
        </div>
        <div className="flex items-center gap-1 py-0 px-2 text-[7px] text-fg3/40 border-b border-white/3 shrink-0">
          <span className="w-14 shrink-0">Flight</span><span className="w-8 shrink-0">To</span><span className="w-12 shrink-0">Status</span><span className="ml-auto shrink-0">ETD</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {departures.length > 0 ? departures.map(f => (
            <div key={f.acid} onClick={() => setSelectedFlight(prev => prev === f.acid ? null : f.acid)}
              className={clsx('flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors', newAcids.has(f.acid) && 'animate-row-arrive', selectedFlight === f.acid && 'bg-acc/10 border-l-2 border-l-acc')}>
              <span className="text-acc font-bold w-14 shrink-0 truncate">{f.acid}</span>
              <span className="text-fg2 w-8 shrink-0">{f.arr_arpt?.replace(/^K/, '') || '?'}</span>
              <span className={clsx('w-12 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3')}>{STATUS_SHORT[f.flight_status] || f.flight_status || '—'}</span>
              <span className="text-grn tabular-nums ml-auto shrink-0">{fmtTime(f.etd || f.atd)}</span>
            </div>
          )) : <div className="py-2 text-center text-fg3 text-[8px]">no departures</div>}
        </div>
      </div>

      {/* Lifecycle sidebar */}
      <div className="bg-bg1 flex flex-col min-h-0">
        <div className="px-2 py-0.5 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between items-center">
          <span className="text-fg3">FLIGHT DETAIL</span>
          {selectedFlight && <button onClick={() => setSelectedFlight(null)} className="text-fg3 hover:text-fg2 px-1 cursor-pointer">✕</button>}
        </div>
        {!selectedFlight ? (
          <div className="flex-1 flex flex-col items-center justify-center text-fg3 px-3 gap-1">
            <span className="text-[9px]">click a flight</span>
            <span className="text-[7px] text-fg3/50 text-center">timeline, delays, taxi times, route</span>
          </div>
        ) : lcLoading ? <LoadingDots /> : lifecycle ? (
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
