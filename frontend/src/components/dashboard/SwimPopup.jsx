import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'

function LoadingDots() {
  return (
    <div className="py-8 flex flex-col items-center justify-center gap-2">
      <div className="flex gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '0ms' }} />
        <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '150ms' }} />
        <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  )
}

// ── Shared popup shell ──────────────────────────────────────────────────────

function Popup({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 z-10000 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg1 border border-border rounded-lg shadow-xl w-full max-w-xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 bg-bg2 border-b border-border rounded-t-lg shrink-0">
          <div>
            <span className="text-acc font-bold text-sm">{title}</span>
            {subtitle && <span className="text-fg3 text-[10px] ml-2">{subtitle}</span>}
          </div>
          <button className="text-fg3 hover:text-fg text-sm px-2 cursor-pointer" onClick={onClose}>✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Flight Lifecycle Popup ──────────────────────────────────────────────────

export function FlightLifecyclePopup({ callsign, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`/api/swim/flight/${encodeURIComponent(callsign)}/lifecycle`)
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [callsign])

  const plan = data?.plan
  const milestones = data?.milestones
  const times = data?.times
  const delays = data?.delays

  return (
    <Popup title={callsign} subtitle={plan ? `${plan.dep_arpt?.replace(/^K/, '')} → ${plan.arr_arpt?.replace(/^K/, '')}` : ''} onClose={onClose}>
      {loading ? (
        <LoadingDots />
      ) : !data ? (
        <div className="py-8 text-center text-fg3 text-[11px]">No data for {callsign}</div>
      ) : (
        <div className="p-3 space-y-3">
          {/* Flight plan info */}
          {plan && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">Flight Plan</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                <div><span className="text-fg3">From:</span> <span className="text-fg2 font-bold">{plan.dep_arpt}</span></div>
                <div><span className="text-fg3">To:</span> <span className="text-fg2 font-bold">{plan.arr_arpt}</span></div>
                <div><span className="text-fg3">Type:</span> <span className="text-fg2">{plan.aircraft_type || '—'}</span></div>
                <div><span className="text-fg3">Status:</span> <span className="text-fg2">{plan.flight_status || '—'}</span></div>
                {plan.etd && <div><span className="text-fg3">Sched depart:</span> <span className="text-fg2 tabular-nums">{fmtFull(plan.etd)}</span></div>}
                {plan.eta && <div><span className="text-fg3">Sched arrive:</span> <span className="text-fg2 tabular-nums">{fmtFull(plan.eta)}</span></div>}
              </div>
              {plan.route && (
                <div className="text-[9px] text-fg3 font-mono mt-1 bg-bg2 rounded px-2 py-1 break-all">{plan.route}</div>
              )}
            </div>
          )}

          {/* Timeline */}
          <div className="space-y-1">
            <div className="text-[9px] text-fg3/50 uppercase">Timeline</div>
            <div className="space-y-1.5 pl-1">
              <TimelineRow label="Pushback" data={milestones?.gateOut} color="text-ylw" />
              <TimelineRow label="Takeoff" data={milestones?.wheelsOff} color="text-grn" />
              <TimelineRow label="Landing" data={milestones?.wheelsOn} color="text-cyn" />
              <TimelineRow label="At Gate" data={milestones?.gateIn} color="text-acc" />
            </div>
          </div>

          {/* Computed times */}
          {(times?.taxiOut != null || times?.flightTime != null || times?.taxiIn != null) && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">Durations</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                {times.taxiOut != null && <div><span className="text-fg3">Taxi out:</span> <span className="text-fg2">{times.taxiOut} min</span></div>}
                {times.flightTime != null && <div><span className="text-fg3">Airborne:</span> <span className="text-fg2">{times.flightTime} min</span></div>}
                {times.taxiIn != null && <div><span className="text-fg3">Taxi in:</span> <span className="text-fg2">{times.taxiIn} min</span></div>}
                {times.gateToGate != null && <div><span className="text-fg3">Total:</span> <span className="text-acc font-bold">{times.gateToGate} min</span></div>}
              </div>
            </div>
          )}

          {/* Delays */}
          {(delays?.departure != null || delays?.arrival != null) && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">Delays</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                {delays.departure != null && (
                  <div>
                    <span className="text-fg3">Departure:</span>{' '}
                    <span className={delays.departure > 15 ? 'text-red font-bold' : delays.departure > 5 ? 'text-ylw' : 'text-grn'}>
                      {delays.departure > 0 ? '+' : ''}{delays.departure} min
                    </span>
                  </div>
                )}
                {delays.arrival != null && (
                  <div>
                    <span className="text-fg3">Arrival:</span>{' '}
                    <span className={delays.arrival > 15 ? 'text-red font-bold' : delays.arrival > 5 ? 'text-ylw' : 'text-grn'}>
                      {delays.arrival > 0 ? '+' : ''}{delays.arrival} min
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* En-route phases (from SFDPS altitude trail) */}
          {data.phases?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">En-Route Phases</div>
              {data.phases.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-white/3">
                  <span className={clsx('font-bold w-14 shrink-0',
                    p.phase === 'CLIMB' ? 'text-grn' : p.phase === 'DESCENT' ? 'text-cyn' : 'text-fg2'
                  )}>{p.phase}</span>
                  <span className="text-fg3 tabular-nums">
                    {p.startAlt != null && p.endAlt != null
                      ? `FL${Math.round(p.startAlt)}→${Math.round(p.endAlt)}`
                      : ''}
                  </span>
                  <span className="text-fg2 tabular-nums">{p.durationMin}m</span>
                  {p.startArtcc && <span className="text-fg3/40">{p.startArtcc}</span>}
                  <span className="ml-auto text-fg3/50 tabular-nums">{p.startTime?.substring(11, 16)}z</span>
                </div>
              ))}
            </div>
          )}

          {/* ARTCC progression */}
          {data.artccProgression?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">ARTCC Progression</div>
              <div className="flex flex-wrap gap-1.5">
                {data.artccProgression.map((a, i) => (
                  <span key={i} className="text-[9px] bg-bg2 rounded px-1.5 py-0.5">
                    <span className="text-acc font-bold">{a.artcc}</span>
                    {a.sector && <span className="text-fg3/50 ml-0.5">/{a.sector}</span>}
                    <span className="text-fg3/40 ml-1 tabular-nums">{a.time?.substring(11, 16)}z</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Altitude profile (mini sparkline) */}
          {data.trail?.length > 2 && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">Altitude Profile ({data.trail.length} pts)</div>
              <AltitudeProfile trail={data.trail} />
            </div>
          )}

          {/* Raw events */}
          {data.events?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">Surface Events ({data.events.length})</div>
              {data.events.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[9px] text-fg3 py-0.5 border-b border-white/3">
                  <span className="text-fg2 w-28 shrink-0">{e.event_type?.replace(/_/g, ' ')}</span>
                  <span className="text-acc">{e.airport?.replace(/^K/, '')}</span>
                  {e.runway && <span className="text-fg3/50">rwy {e.runway.split('/')[0]}</span>}
                  <span className="ml-auto text-fg3/50 tabular-nums">{e.received_at?.substring(11, 19)}z</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Popup>
  )
}

// ── Airport Movements Popup ─────────────────────────────────────────────────

export function AirportMovementsPopup({ airport, onClose }) {
  const [data, setData] = useState(null)
  const [flow, setFlow] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.allSettled([
      axios.get(`/api/swim/surface/${encodeURIComponent(airport)}`, { params: { limit: 40 } }),
      axios.get(`/api/swim/airport/${encodeURIComponent(airport)}/surface-flow`),
    ]).then(([movRes, flowRes]) => {
      setData(movRes.status === 'fulfilled' ? movRes.value.data : [])
      setFlow(flowRes.status === 'fulfilled' ? flowRes.value.data : null)
    }).finally(() => setLoading(false))
  }, [airport])

  const oooi = (data || []).filter(e => ['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))
  const other = (data || []).filter(e => !['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))

  const VERB = { OFF: 'Departed', ON: 'Landed', SPOT_OUT: 'Pushback', SPOT_IN: 'At gate' }
  const COLOR = { OFF: 'text-grn', ON: 'text-cyn', SPOT_OUT: 'text-ylw', SPOT_IN: 'text-acc' }

  return (
    <Popup title={airport.replace(/^K/, '')} subtitle={`Surface operations at ${airport}`} onClose={onClose}>
      {loading ? (
        <LoadingDots />
      ) : (
        <>
          {/* Surface flow stats */}
          {flow && (
            <div className="p-2 border-b border-border">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-bg2 rounded py-1 px-2">
                  <div className={clsx('text-sm font-bold tabular-nums', flow.depQueue?.count > 5 ? 'text-red' : flow.depQueue?.count > 0 ? 'text-ylw' : 'text-grn')}>
                    {flow.depQueue?.count || 0}
                  </div>
                  <div className="text-[7px] text-fg3">dep queue</div>
                </div>
                <div className="bg-bg2 rounded py-1 px-2">
                  <div className="text-sm font-bold text-fg2 tabular-nums">{flow.activeGroundMovements || 0}</div>
                  <div className="text-[7px] text-fg3">ground mvmt</div>
                </div>
                <div className="bg-bg2 rounded py-1 px-2">
                  <div className="text-sm font-bold text-acc tabular-nums">{flow.runways?.length || 0}</div>
                  <div className="text-[7px] text-fg3">active rwys</div>
                </div>
              </div>

              {/* Departure queue flights */}
              {flow.depQueue?.count > 0 && (
                <div className="mt-2">
                  <div className="text-[8px] text-fg3/50 uppercase mb-0.5">Waiting to depart</div>
                  {flow.depQueue.flights.slice(0, 8).map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-white/3">
                      <span className="text-fg2 font-bold w-16 shrink-0">{f.callsign}</span>
                      <span className="text-ylw tabular-nums">{Math.round(f.wait_min)}m waiting</span>
                      <span className="ml-auto text-fg3/50 tabular-nums">{f.pushback_time?.substring(11, 16)}z</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Runway utilization */}
              {flow.runways?.length > 0 && (
                <div className="mt-2">
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

              {/* Throughput mini chart */}
              {flow.throughput?.length > 0 && (
                <div className="mt-2">
                  <div className="text-[8px] text-fg3/50 uppercase mb-0.5">Throughput (15-min bins)</div>
                  <ThroughputChart bins={flow.throughput} />
                </div>
              )}
            </div>
          )}

          {/* Flight movements */}
          {oooi.length > 0 && (
            <div className="p-2">
              <div className="text-[9px] text-fg3/50 uppercase mb-1">Recent flights ({oooi.length})</div>
              {oooi.map((e, i) => (
                <div key={e.id || i} className="flex items-center gap-2 text-[10px] py-0.5 border-b border-white/3">
                  <span className="text-fg2 font-bold w-16 shrink-0">{e.callsign || '—'}</span>
                  <span className={clsx('w-16 shrink-0', COLOR[e.event_type])}>{VERB[e.event_type]}</span>
                  {e.runway && <span className="text-fg3">rwy {e.runway.split('/')[0]}</span>}
                  {e.gate && <span className="text-fg3">gate {e.gate}</span>}
                  <span className="ml-auto text-fg3/50 tabular-nums shrink-0">{e.received_at?.substring(11, 19)}z</span>
                </div>
              ))}
            </div>
          )}
          {oooi.length === 0 && !flow && (
            <div className="py-8 text-center text-fg3 text-[11px]">No recent movements at {airport.replace(/^K/, '')}</div>
          )}
        </>
      )}
    </Popup>
  )
}

// ── Weather Detail Popup ────────────────────────────────────────────────────

export function WeatherDetailPopup({ airport, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`/api/swim/weather/${encodeURIComponent(airport)}`, { params: { limit: 30 } })
      .then(r => setData(r.data))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [airport])

  const SEV_COLOR = { CRITICAL: 'text-red', HIGH: 'text-ylw', MEDIUM: 'text-fg2', LOW: 'text-fg3' }
  const TYPE_LABEL = {
    TORNADO: 'Tornado', MICROBURST: 'Microburst', WINDSHEAR: 'Windshear',
    GUST_FRONT: 'Gust Front', PRECIP: 'Precipitation', HAZARD_TEXT: 'Hazard',
    STORM_MOTION: 'Storm Motion', LIGHTNING: 'Lightning',
  }

  return (
    <Popup title={airport.replace(/^K/, '')} subtitle="Terminal weather alerts" onClose={onClose}>
      {loading ? (
        <LoadingDots />
      ) : !data || data.length === 0 ? (
        <div className="py-8 text-center text-fg3 text-[11px]">No weather alerts at {airport.replace(/^K/, '')}</div>
      ) : (
        <div className="p-2 space-y-0">
          {data.map((e, i) => (
            <div key={e.id || i} className={clsx('py-1.5 px-2 border-b border-white/5', e.severity === 'CRITICAL' && 'bg-red/5')}>
              <div className="flex items-center gap-2 text-[10px]">
                <span className={clsx('font-bold', SEV_COLOR[e.severity])}>{e.severity}</span>
                <span className="text-fg2 font-bold">{TYPE_LABEL[e.event_type] || e.event_type}</span>
                {e.runway && <span className="text-fg3">rwy {e.runway}</span>}
                <span className="ml-auto text-fg3/50 tabular-nums text-[9px]">{e.received_at?.substring(11, 19)}z</span>
              </div>
              {e.text && <div className="text-[9px] text-fg3 mt-0.5">{e.text}</div>}
              <div className="flex gap-3 text-[8px] text-fg3/50 mt-0.5">
                {e.speed && <span>Speed: {e.speed}kt</span>}
                {e.tops && <span>Tops: FL{e.tops}</span>}
                {e.gain_loss && <span>Gain/Loss: {e.gain_loss}kt</span>}
                {e.altitude && <span>Alt: {e.altitude}ft</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Popup>
  )
}

// ── Flow Event Detail Popup ─────────────────────────────────────────────────

export function FlowEventPopup({ airport, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`/api/swim/flow/${encodeURIComponent(airport)}`, { params: { limit: 20 } })
      .then(r => setData(r.data))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [airport])

  const TYPE_LABEL = {
    GS: 'Ground Stop', GDP: 'Ground Delay Program', AFP: 'Airspace Flow Program',
    REROUTE: 'Reroute', RSTR: 'Restriction', CTOP: 'Collaborative Trajectory',
    FXA: 'Flow Constraint Area', GADV: 'Advisory',
  }
  const TYPE_COLOR = { GS: 'text-red', GDP: 'text-ylw', AFP: 'text-ylw', REROUTE: 'text-mag' }

  return (
    <Popup title={airport.replace(/^K/, '')} subtitle="Flow control events" onClose={onClose}>
      {loading ? (
        <LoadingDots />
      ) : !data || data.length === 0 ? (
        <div className="py-8 text-center text-fg3 text-[11px]">No flow events at {airport.replace(/^K/, '')}</div>
      ) : (
        <div className="p-2 space-y-0">
          {data.map((e, i) => (
            <div key={e.id || i} className={clsx('py-1.5 px-2 border-b border-white/5', e.event_type === 'GS' && 'bg-red/5', e.event_type === 'GDP' && 'bg-ylw/3')}>
              <div className="flex items-center gap-2 text-[10px]">
                <span className={clsx('font-bold', TYPE_COLOR[e.event_type] || 'text-fg3')}>{TYPE_LABEL[e.event_type] || e.event_type}</span>
                {e.status && <span className="text-fg3 text-[9px]">{e.status}</span>}
                <span className="ml-auto text-fg3/50 tabular-nums text-[9px]">{e.received_at?.substring(11, 19)}z</span>
              </div>
              {e.reason && <div className="text-[9px] text-fg3 mt-0.5">Reason: {e.reason}</div>}
              {e.text && <div className="text-[9px] text-fg2 mt-0.5">{e.text}</div>}
              <div className="flex gap-3 text-[8px] text-fg3/50 mt-0.5">
                {e.delay_minutes && <span>Avg delay: {Math.round(e.delay_minutes)} min</span>}
                {e.start_time && <span>Start: {e.start_time.substring(11, 16)}z</span>}
                {e.end_time && <span>End: {e.end_time.substring(11, 16)}z</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Popup>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function TimelineRow({ label, data, color }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className={clsx('w-2 h-2 rounded-full shrink-0', data ? `bg-current ${color}` : 'bg-border2')} />
      <span className={clsx('w-16 shrink-0', data ? color : 'text-fg3/30')}>{label}</span>
      {data ? (
        <>
          <span className="text-fg2 tabular-nums">{data.time?.substring(11, 19)}z</span>
          <span className="text-fg3/60">{data.airport?.replace(/^K/, '')}</span>
          {data.runway && <span className="text-fg3/40">rwy {data.runway.split('/')[0]}</span>}
        </>
      ) : (
        <span className="text-fg3/20">—</span>
      )}
    </div>
  )
}

function fmtFull(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    if (isNaN(d)) return ts.substring?.(11, 19) || '—'
    return d.toISOString().substring(11, 19) + 'z'
  } catch { return '—' }
}

// Mini throughput bar chart (departures + arrivals in 15-min bins)
function ThroughputChart({ bins }) {
  const max = Math.max(...bins.map(b => Math.max(b.departures || 0, b.arrivals || 0)), 1)
  return (
    <div className="flex items-end gap-0.5" style={{ height: 32 }}>
      {bins.map((b, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-px" title={`${b.bin} — ${b.departures || 0} dep, ${b.arrivals || 0} arr`}>
          <div className="w-full flex gap-px justify-center" style={{ height: 28 }}>
            <div className="w-1/2 bg-grn/60 rounded-t-sm self-end" style={{ height: `${((b.departures || 0) / max) * 100}%` }} />
            <div className="w-1/2 bg-cyn/60 rounded-t-sm self-end" style={{ height: `${((b.arrivals || 0) / max) * 100}%` }} />
          </div>
          {i % 4 === 0 && <div className="text-[6px] text-fg3/30 tabular-nums">{b.bin?.substring(0, 5)}</div>}
        </div>
      ))}
    </div>
  )
}

// Mini altitude profile chart (SVG sparkline)
function AltitudeProfile({ trail }) {
  const W = 460, H = 60, PAD = 2
  const alts = trail.map(p => p.alt).filter(a => a != null && a > 0)
  if (alts.length < 2) return null
  const maxAlt = Math.max(...alts)
  const minAlt = Math.min(...alts)
  const range = maxAlt - minAlt || 1

  const points = alts.map((a, i) => {
    const x = PAD + (i / (alts.length - 1)) * (W - 2 * PAD)
    const y = PAD + (1 - (a - minAlt) / range) * (H - 2 * PAD)
    return `${x},${y}`
  }).join(' ')

  return (
    <div className="bg-bg2 rounded px-2 py-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 50 }}>
        <polyline points={points} fill="none" stroke="#81a2be" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div className="flex justify-between text-[8px] text-fg3/50 tabular-nums">
        <span>FL{Math.round(minAlt)}</span>
        <span>FL{Math.round(maxAlt)}</span>
      </div>
    </div>
  )
}
