import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import AIRPORTS from '../../data/airports'

function fmtTime(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    if (isNaN(d)) return ts.substring?.(11, 16) || '—'
    return d.toISOString().substring(11, 16) + 'z'
  } catch { return '—' }
}

function LoadingDots() {
  return (
    <div className="py-6 flex justify-center gap-1">
      <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '0ms' }} />
      <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '150ms' }} />
      <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'weather', label: 'Weather' },
  { id: 'notams', label: 'NOTAMs' },
  { id: 'surface', label: 'Surface' },
  { id: 'flow', label: 'Flow Control' },
]

// ���─ Main Component ───────────────────────────────────────────────────────────

export default function AirportDetail({ airport, onClose }) {
  const [tab, setTab] = useState('overview')
  const [ops, setOps] = useState(null)
  const [metar, setMetar] = useState(null)
  const [notams, setNotams] = useState(null)
  const [surface, setSurface] = useState(null)
  const [flow, setFlow] = useState(null)
  const [loading, setLoading] = useState(true)

  const known = AIRPORTS[airport]
  const code = airport.replace(/^K/, '')

  // Fetch all data in parallel
  useEffect(() => {
    setLoading(true)
    setOps(null); setMetar(null); setNotams(null); setSurface(null); setFlow(null)

    Promise.allSettled([
      axios.get(`/api/swim/airport/${airport}/ops`),
      axios.get(`/api/weather/metar`, { params: { ids: airport } }),
      axios.get(`/api/swim/notams/${airport}`),
      axios.get(`/api/swim/surface/${airport}`, { params: { limit: 30 } }),
      axios.get(`/api/swim/flow/${airport}`, { params: { limit: 20 } }),
    ]).then(([opsR, metarR, notamsR, surfaceR, flowR]) => {
      if (opsR.status === 'fulfilled') setOps(opsR.value.data)
      if (metarR.status === 'fulfilled') setMetar(Array.isArray(metarR.value.data) ? metarR.value.data[0] : null)
      if (notamsR.status === 'fulfilled') setNotams(notamsR.value.data)
      if (surfaceR.status === 'fulfilled') setSurface(surfaceR.value.data)
      if (flowR.status === 'fulfilled') setFlow(flowR.value.data)
      setLoading(false)
    })
  }, [airport])

  return (
    <div className="fixed inset-0 z-10000 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg1 border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-2.5 bg-bg2 border-b border-border rounded-t-lg shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-acc font-bold text-base">{code}</span>
              {known && <span className="text-fg2 text-[11px] ml-2">{known.city}, {known.state}</span>}
            </div>
            <button className="text-fg3 hover:text-fg text-sm px-2 cursor-pointer" onClick={onClose}>✕</button>
          </div>
          {/* Quick status pills */}
          <div className="flex gap-2 mt-1 text-[9px]">
            {ops?.flow?.groundStop && <span className="text-red font-bold">GROUND STOP</span>}
            {ops?.flow?.gdp && <span className="text-ylw font-bold">GDP {ops.flow.gdp.delay_minutes ? Math.round(ops.flow.gdp.delay_minutes) + 'm' : ''}</span>}
            {metar && (
              <span className="text-fg3">
                {metar.wspd}kt {metar.wdir}° · vis {metar.visib}sm · {metar.cover} {metar.clouds?.[0]?.base ? Math.round(metar.clouds[0].base) + 'ft' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border shrink-0 bg-bg2/50">
          {TABS.map(t => (
            <button
              key={t.id}
              className={clsx(
                'px-3 py-1 text-[10px] cursor-pointer border-b-2 transition-colors',
                tab === t.id ? 'text-acc border-acc' : 'text-fg3 border-transparent hover:text-fg2'
              )}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'notams' && notams?.length > 0 && <span className="text-fg3/50 ml-1">{notams.length}</span>}
              {t.id === 'flow' && flow?.length > 0 && <span className="text-fg3/50 ml-1">{flow.length}</span>}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? <LoadingDots /> : (
            <>
              {tab === 'overview' && <OverviewTab ops={ops} metar={metar} />}
              {tab === 'weather' && <WeatherTab metar={metar} opsWeather={ops?.weather} />}
              {tab === 'notams' && <NotamsTab notams={notams} airport={code} />}
              {tab === 'surface' && <SurfaceTab surface={surface} airport={code} />}
              {tab === 'flow' && <FlowTab flow={flow} airport={code} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ ops, metar }) {
  const cap = ops?.capacity
  const delays = ops?.delays
  const taxi = ops?.taxi
  const cong = ops?.congestion
  const cfg = ops?.config
  const airline = ops?.airlinePerformance
  const turns = ops?.turnarounds

  return (
    <div className="p-3 space-y-3">
      {/* Runway config */}
      {cfg && (
        <Section title="Runway Configuration">
          <div className="grid grid-cols-3 gap-3 text-[10px]">
            <div><span className="text-fg3">Arrival:</span> <span className="text-cyn font-bold">{cfg.arr_runway || '—'}</span></div>
            <div><span className="text-fg3">Departure:</span> <span className="text-grn font-bold">{cfg.dep_runway || '—'}</span></div>
            <div><span className="text-fg3">Weather:</span> <span className={cfg.weather === 'IMC' ? 'text-ylw font-bold' : 'text-grn'}>{cfg.weather || '—'}</span></div>
          </div>
        </Section>
      )}

      {/* Current METAR summary */}
      {metar && (
        <Section title="Current Weather (METAR)">
          <div className="text-[9px] font-mono text-fg3 bg-bg2 rounded px-2 py-1 mb-1.5">{metar.rawOb}</div>
          <div className="grid grid-cols-4 gap-2 text-[10px]">
            <Stat label="Wind" value={`${metar.wdir}° / ${metar.wspd}kt`} />
            <Stat label="Visibility" value={`${metar.visib} sm`} />
            <Stat label="Ceiling" value={metar.clouds?.find(c => c.cover === 'BKN' || c.cover === 'OVC')?.base ? `${metar.clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC').base}ft` : 'Clear'} />
            <Stat label="Temp / Dew" value={`${metar.temp}° / ${metar.dewp}°C`} />
          </div>
        </Section>
      )}

      {/* Traffic & capacity */}
      {cap && (
        <Section title="Traffic & Capacity">
          <div className="grid grid-cols-4 gap-2 text-[10px]">
            <Stat label="Inbound" value={cap.inbound} color="text-cyn" />
            <Stat label="Outbound" value={cap.outbound} color="text-grn" />
            <Stat label="Arr rate" value={cap.arrRate ? `${cap.arrRate}/hr` : '—'} />
            <Stat label="Dep rate" value={cap.depRate ? `${cap.depRate}/hr` : '—'} />
          </div>
        </Section>
      )}

      {/* Delays */}
      {(delays?.departures || delays?.arrivals) && (
        <Section title="Delays (avg)">
          <div className="grid grid-cols-4 gap-2 text-[10px]">
            {delays.departures && (
              <Stat label="Dep delay" value={`${delays.departures.avg > 0 ? '+' : ''}${delays.departures.avg}m`}
                color={delays.departures.avg > 15 ? 'text-red' : delays.departures.avg > 5 ? 'text-ylw' : 'text-grn'}
                sub={`${delays.departures.count} flights`} />
            )}
            {delays.arrivals && (
              <Stat label="Arr delay" value={`${delays.arrivals.avg > 0 ? '+' : ''}${delays.arrivals.avg}m`}
                color={delays.arrivals.avg > 15 ? 'text-red' : delays.arrivals.avg > 5 ? 'text-ylw' : 'text-grn'}
                sub={`${delays.arrivals.count} flights`} />
            )}
            {taxi?.out && (
              <Stat label="Taxi out" value={`${taxi.out.avg}m`}
                color={taxi.out.avg > 20 ? 'text-ylw' : 'text-fg2'}
                sub={`${taxi.out.count} samples`} />
            )}
            {taxi?.in && (
              <Stat label="Taxi in" value={`${taxi.in.avg}m`}
                color={taxi.in.avg > 15 ? 'text-ylw' : 'text-fg2'}
                sub={`${taxi.in.count} samples`} />
            )}
          </div>
        </Section>
      )}

      {/* Congestion */}
      {cong && (
        <Section title="Congestion">
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <Stat label="Status" value={cong.status?.replace(/_/g, ' ') || 'Normal'}
              color={cong.status === 'CONGESTION_BUILDING' ? 'text-red' : cong.status === 'ELEVATED' ? 'text-ylw' : 'text-grn'} />
            {cong.ratio && <Stat label="Ratio" value={`${cong.ratio}x`} sub="current vs baseline" />}
          </div>
        </Section>
      )}

      {/* Airline performance */}
      {airline?.length > 0 && (
        <Section title="Airline Performance (top)">
          <div className="space-y-0.5">
            {airline.slice(0, 8).map((a, i) => (
              <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-white/3">
                <span className="text-fg2 font-bold w-12 shrink-0">{a.airline}</span>
                <span className="text-fg3">{a.flights} flights</span>
                {a.avgDelay != null && (
                  <span className={a.avgDelay > 15 ? 'text-red' : a.avgDelay > 5 ? 'text-ylw' : 'text-grn'}>
                    {a.avgDelay > 0 ? '+' : ''}{a.avgDelay}m avg
                  </span>
                )}
                <span className="ml-auto text-fg3/50">{a.onTime != null ? `${a.onTime}% on-time` : ''}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Turnarounds */}
      {turns?.length > 0 && (
        <Section title="Recent Turnarounds">
          <div className="space-y-0.5">
            {turns.slice(0, 5).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-white/3">
                <span className="text-acc font-bold w-16 shrink-0">{t.callsign}</span>
                <span className="text-fg3">arrived {fmtTime(t.arrivalTime)}</span>
                <span className="text-fg3">departed {fmtTime(t.departureTime)}</span>
                {t.turnaroundMin != null && (
                  <span className={clsx('ml-auto', t.turnaroundMin > 60 ? 'text-ylw' : 'text-fg2')}>
                    {t.turnaroundMin}m turnaround
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {!cap && !metar && !cfg && (
        <div className="py-6 text-center text-fg3 text-[11px]">No operational data available for this airport</div>
      )}
    </div>
  )
}

// ── Weather Tab ──────────────────────────────────────────────────────────────

function WeatherTab({ metar, opsWeather }) {
  return (
    <div className="p-3 space-y-3">
      {metar ? (
        <Section title="METAR">
          <div className="text-[9px] font-mono text-fg3 bg-bg2 rounded px-2 py-1 mb-2">{metar.rawOb}</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[10px]">
            <div><span className="text-fg3">Wind:</span> <span className="text-fg2">{metar.wdir}° at {metar.wspd} knots</span></div>
            <div><span className="text-fg3">Visibility:</span> <span className="text-fg2">{metar.visib} statute miles</span></div>
            <div><span className="text-fg3">Temperature:</span> <span className="text-fg2">{metar.temp}°C ({Math.round(metar.temp * 9 / 5 + 32)}°F)</span></div>
            <div><span className="text-fg3">Dewpoint:</span> <span className="text-fg2">{metar.dewp}°C</span></div>
            <div><span className="text-fg3">Altimeter:</span> <span className="text-fg2">{metar.altim} hPa ({(metar.altim * 0.02953).toFixed(2)} inHg)</span></div>
            <div><span className="text-fg3">Report type:</span> <span className="text-fg2">{metar.metarType}</span></div>
          </div>
          {metar.clouds?.length > 0 && (
            <div className="mt-2">
              <div className="text-[9px] text-fg3/50 mb-0.5">Cloud layers</div>
              <div className="flex gap-3 text-[10px]">
                {metar.clouds.map((c, i) => (
                  <span key={i} className="text-fg2">{c.cover} {c.base?.toLocaleString()}ft</span>
                ))}
              </div>
            </div>
          )}
        </Section>
      ) : (
        <div className="py-4 text-center text-fg3 text-[11px]">No METAR available</div>
      )}

      {opsWeather?.length > 0 && (
        <Section title="Terminal Weather Alerts (ITWS)">
          {opsWeather.map((w, i) => (
            <div key={i} className={clsx('py-1 px-2 border-b border-white/5 text-[10px]', w.severity === 'CRITICAL' && 'bg-red/5')}>
              <div className="flex items-center gap-2">
                <span className={clsx('font-bold', w.severity === 'CRITICAL' ? 'text-red' : w.severity === 'HIGH' ? 'text-ylw' : 'text-fg2')}>
                  {w.event_type?.replace(/_/g, ' ')}
                </span>
                <span className="text-fg3 text-[9px]">{w.severity}</span>
              </div>
              {w.text && <div className="text-[9px] text-fg3 mt-0.5">{w.text}</div>}
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

// ── NOTAMs Tab ───────────────────────────────────────────────────────────────

const KW_COLORS = { RWY: 'text-red', TWY: 'text-ylw', APRON: 'text-ylw', AIRSPACE: 'text-red', SVC: 'text-cyn', NAV: 'text-cyn', OBST: 'text-mag' }
const KW_LABELS = { RWY: 'Runway', TWY: 'Taxiway', APRON: 'Apron', AIRSPACE: 'Airspace', SVC: 'Service', NAV: 'Navigation', OBST: 'Obstacle' }

function NotamsTab({ notams, airport }) {
  if (!notams || notams.length === 0) return <div className="py-6 text-center text-fg3 text-[11px]">No active NOTAMs for {airport}</div>

  return (
    <div className="divide-y divide-white/5">
      {notams.map((n, i) => (
        <div key={n.id || i} className={clsx('px-3 py-2', n.is_tfr && 'bg-red/5')}>
          <div className="flex items-center gap-2 text-[10px] mb-0.5">
            {n.is_tfr ? <span className="text-red font-bold">TFR</span>
              : n.keyword ? <span className={clsx('font-bold', KW_COLORS[n.keyword])}>{KW_LABELS[n.keyword] || n.keyword}</span>
              : <span className="text-fg3">General</span>}
            {n.classification && <span className="text-fg3/60 text-[9px]">{n.classification}</span>}
            <span className="ml-auto text-fg3/50 text-[9px]">
              {n.effective && <span>eff {n.effective.substring(5, 16).replace('T', ' ')}z</span>}
              {n.expiration ? <span> — exp {n.expiration.substring(5, 16).replace('T', ' ')}z</span> : n.permanent ? <span> — PERM</span> : null}
            </span>
          </div>
          <div className="text-[10px] text-fg2 font-mono leading-relaxed whitespace-pre-wrap">{n.text || n.full_text || '(no text)'}</div>
        </div>
      ))}
    </div>
  )
}

// ── Surface Tab ──────────────────────────────────────────────────────────────

const VERB = { OFF: 'Departed', ON: 'Landed', SPOT_OUT: 'Pushback', SPOT_IN: 'At gate' }
const SCOLOR = { OFF: 'text-grn', ON: 'text-cyn', SPOT_OUT: 'text-ylw', SPOT_IN: 'text-acc' }

function SurfaceTab({ surface, airport }) {
  if (!surface || surface.length === 0) return <div className="py-6 text-center text-fg3 text-[11px]">No recent surface events at {airport}</div>

  const oooi = surface.filter(e => ['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))
  const other = surface.filter(e => !['OFF', 'ON', 'SPOT_OUT', 'SPOT_IN'].includes(e.event_type))

  return (
    <div className="p-2">
      {oooi.length > 0 && (
        <Section title={`Flights (${oooi.length})`}>
          {oooi.map((e, i) => (
            <div key={e.id || i} className="flex items-center gap-2 text-[10px] py-0.5 border-b border-white/3">
              <span className="text-fg2 font-bold w-16 shrink-0">{e.callsign || '—'}</span>
              <span className={clsx('w-16 shrink-0', SCOLOR[e.event_type])}>{VERB[e.event_type]}</span>
              {e.runway && <span className="text-fg3">rwy {e.runway.split('/')[0]}</span>}
              {e.gate && <span className="text-fg3">gate {e.gate}</span>}
              <span className="ml-auto text-fg3/50 tabular-nums shrink-0">{e.received_at?.substring(11, 19)}z</span>
            </div>
          ))}
        </Section>
      )}
      {other.length > 0 && (
        <Section title={`Other Events (${other.length})`}>
          {other.slice(0, 20).map((e, i) => (
            <div key={e.id || i} className="flex items-center gap-2 text-[9px] text-fg3 py-0.5 border-b border-white/3">
              <span className="text-fg2 w-24 shrink-0">{e.event_type?.replace(/_/g, ' ')}</span>
              {e.callsign && <span className="text-fg2">{e.callsign}</span>}
              <span className="truncate flex-1">{e.text?.substring(0, 60) || ''}</span>
              <span className="ml-auto text-fg3/50 tabular-nums shrink-0">{e.received_at?.substring(11, 19)}z</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

// ── Flow Tab ─────────────────────────────────────────────────────────────────

const FTYPE = { GS: 'Ground Stop', GDP: 'Ground Delay', AFP: 'Airspace Flow', REROUTE: 'Reroute', RSTR: 'Restriction', CTOP: 'CTOP', FXA: 'Flow Area', GADV: 'Advisory' }
const FCOLOR = { GS: 'text-red', GDP: 'text-ylw', AFP: 'text-ylw', REROUTE: 'text-mag' }

function FlowTab({ flow, airport }) {
  if (!flow || flow.length === 0) return <div className="py-6 text-center text-fg3 text-[11px]">No flow events at {airport}</div>

  return (
    <div className="divide-y divide-white/5">
      {flow.map((e, i) => (
        <div key={e.id || i} className={clsx('px-3 py-1.5', e.event_type === 'GS' && 'bg-red/5', e.event_type === 'GDP' && 'bg-ylw/3')}>
          <div className="flex items-center gap-2 text-[10px]">
            <span className={clsx('font-bold', FCOLOR[e.event_type] || 'text-fg3')}>{FTYPE[e.event_type] || e.event_type}</span>
            {e.status && <span className="text-fg3 text-[9px]">{e.status}</span>}
            <span className="ml-auto text-fg3/50 tabular-nums text-[9px]">{e.received_at?.substring(11, 19)}z</span>
          </div>
          {e.reason && <div className="text-[9px] text-fg3 mt-0.5">Reason: {e.reason}</div>}
          {e.text && <div className="text-[9px] text-fg2 mt-0.5">{e.text}</div>}
          <div className="flex gap-3 text-[8px] text-fg3/50 mt-0.5">
            {e.delay_minutes && <span>Delay: {Math.round(e.delay_minutes)} min</span>}
            {e.start_time && <span>Start: {fmtTime(e.start_time)}</span>}
            {e.end_time && <span>End: {fmtTime(e.end_time)}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Shared UI ────────────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[9px] text-fg3/50 uppercase mb-1">{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, color, sub }) {
  return (
    <div>
      <div className="text-[8px] text-fg3/50">{label}</div>
      <div className={clsx('text-[11px] font-medium tabular-nums', color || 'text-fg2')}>{value}</div>
      {sub && <div className="text-[7px] text-fg3/40">{sub}</div>}
    </div>
  )
}
