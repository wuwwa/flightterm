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

          {/* Raw events */}
          {data.events?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] text-fg3/50 uppercase">All Events ({data.events.length})</div>
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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`/api/swim/surface/${encodeURIComponent(airport)}`, { params: { limit: 40 } })
      .then(r => setData(r.data))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [airport])

  const oooi = (data || []).filter(e => ['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))
  const other = (data || []).filter(e => !['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))

  const VERB = { OFF: 'Departed', ON: 'Landed', SPOT_OUT: 'Pushback', SPOT_IN: 'At gate' }
  const COLOR = { OFF: 'text-grn', ON: 'text-cyn', SPOT_OUT: 'text-ylw', SPOT_IN: 'text-acc' }

  return (
    <Popup title={airport.replace(/^K/, '')} subtitle={`Recent activity at ${airport}`} onClose={onClose}>
      {loading ? (
        <LoadingDots />
      ) : oooi.length === 0 && other.length === 0 ? (
        <div className="py-8 text-center text-fg3 text-[11px]">No recent movements at {airport.replace(/^K/, '')}</div>
      ) : (
        <>
          {oooi.length > 0 && (
            <div className="p-2">
              <div className="text-[9px] text-fg3/50 uppercase mb-1">Flights ({oooi.length})</div>
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
          {other.length > 0 && (
            <div className="p-2 border-t border-border">
              <div className="text-[9px] text-fg3/50 uppercase mb-1">Other Events ({other.length})</div>
              {other.slice(0, 15).map((e, i) => (
                <div key={e.id || i} className="flex items-center gap-2 text-[9px] text-fg3 py-0.5 border-b border-white/3">
                  <span className="text-fg2 w-24 shrink-0">{e.event_type?.replace(/_/g, ' ')}</span>
                  {e.callsign && <span className="text-fg2">{e.callsign}</span>}
                  {e.text && <span className="truncate flex-1">{e.text.substring(0, 50)}</span>}
                  <span className="ml-auto text-fg3/50 tabular-nums shrink-0">{e.received_at?.substring(11, 19)}z</span>
                </div>
              ))}
            </div>
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
