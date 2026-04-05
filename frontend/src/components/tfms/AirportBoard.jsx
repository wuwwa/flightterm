import { useState, useEffect, useMemo } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import AIRPORTS from '../../data/airports'
import { useSwim } from '../../contexts/SwimContext'

const STATUS_COLORS = {
  ACTIVE: 'text-grn', ASCENDING: 'text-cyn', CRUISING: 'text-acc',
  DESCENDING: 'text-ylw', COMPLETED: 'text-fg3', FILED: 'text-mag', CANCELLED: 'text-red',
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d)) return ts.substring?.(11, 16) || '—'
  return d.toISOString().substring(11, 16) + 'z'
}

function Metric({ label, value, color, unit, sub }) {
  return (
    <div className="bg-bg1 py-0.5 px-1.5 text-center" title={sub || ''}>
      <div className={clsx('text-[12px] font-medium tabular-nums', color || 'text-fg2')}>
        {value != null ? value : '—'}{unit && <span className="text-[8px] text-fg3">{unit}</span>}
      </div>
      <div className="text-[7px] text-fg3 leading-tight">{label}</div>
    </div>
  )
}

export default function AirportBoard({ backendOk }) {
  const { flights } = useSwim()
  const [airport, setAirport] = useState('')
  const [ops, setOps] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!airport || !backendOk) { setOps(null); return }
    let cancelled = false
    const refresh = () => {
      setLoading(true)
      axios.get(`/api/swim/airport/${airport}/ops`)
        .then(r => { if (!cancelled) setOps(r.data) })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false) })
    }
    refresh()
    const id = setInterval(refresh, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [airport, backendOk])

  // Flights for this airport from shared context
  const arrivals = useMemo(() =>
    flights.filter(f => f.arr_arpt === airport).sort((a, b) => (a.eta || '').localeCompare(b.eta || '')),
    [flights, airport]
  )
  const departures = useMemo(() =>
    flights.filter(f => f.dep_arpt === airport).sort((a, b) => (a.etd || '').localeCompare(b.etd || '')),
    [flights, airport]
  )

  const cfg = ops?.config
  const flow = ops?.flow
  const delays = ops?.delays
  const taxi = ops?.taxi
  const cap = ops?.capacity

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Airport selector + status bar */}
      <div className="flex items-center gap-2 px-2 py-1 bg-bg2 border-b border-border shrink-0 flex-wrap">
        <select
          value={airport}
          onChange={(e) => setAirport(e.target.value)}
          className="bg-bg1 border border-border text-fg text-[10px] px-1.5 py-0.5 rounded outline-none focus:border-acc"
        >
          <option value="">select airport</option>
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
        <div className="flex-1 flex items-center justify-center text-fg3 text-[10px]">select an airport above</div>
      ) : (
        <>
          {/* Metrics row — computed cross-referenced data */}
          {ops && (
            <div className="grid grid-cols-8 gap-px bg-border shrink-0">
              <Metric label="inbound" value={cap?.inbound} color={cap?.arrOverflow > 0 ? 'text-red' : 'text-cyn'} sub={`${cap?.arrRate || '?'}/hr capacity`} />
              <Metric label="outbound" value={cap?.outbound} color={cap?.depOverflow > 0 ? 'text-red' : 'text-grn'} sub={`${cap?.depRate || '?'}/hr capacity`} />
              <Metric label="arr rate" value={cap?.arrRate} unit="/hr" />
              <Metric label="dep rate" value={cap?.depRate} unit="/hr" />
              <Metric label="dep delay" value={delays?.departures?.avg} unit="m" color={delays?.departures?.avg > 15 ? 'text-red' : delays?.departures?.avg > 5 ? 'text-ylw' : 'text-grn'} sub={`${delays?.departures?.count || 0} samples`} />
              <Metric label="arr delay" value={delays?.arrivals?.avg} unit="m" color={delays?.arrivals?.avg > 15 ? 'text-red' : delays?.arrivals?.avg > 5 ? 'text-ylw' : 'text-grn'} sub={`${delays?.arrivals?.count || 0} samples`} />
              <Metric label="taxi out" value={taxi?.out?.avg} unit="m" color={taxi?.out?.avg > 20 ? 'text-ylw' : 'text-fg2'} sub={`${taxi?.out?.count || 0} samples`} />
              <Metric label="taxi in" value={taxi?.in?.avg} unit="m" color={taxi?.in?.avg > 15 ? 'text-ylw' : 'text-fg2'} sub={`${taxi?.in?.count || 0} samples`} />
            </div>
          )}

          {/* Weather alerts */}
          {ops?.weather?.length > 0 && (
            <div className="px-2 py-0.5 flex gap-2 text-[8px] border-b border-border shrink-0 flex-wrap">
              {ops.weather.slice(0, 5).map((w, i) => (
                <span key={i} className={clsx(
                  w.severity === 'CRITICAL' ? 'text-red font-bold' : w.severity === 'HIGH' ? 'text-ylw' : 'text-fg3'
                )} title={w.text || ''}>
                  {w.event_type?.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}

          {/* Arrivals + Departures split */}
          <div className="flex-1 min-h-0 grid grid-cols-2 gap-px bg-border">
            {/* Arrivals */}
            <div className="bg-bg1 flex flex-col min-h-0">
              <div className="px-2 py-0.5 text-[8px] text-cyn bg-bg2 border-b border-border shrink-0 flex justify-between">
                <span>ARRIVALS</span>
                <span className="text-fg3">{arrivals.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {arrivals.length > 0 ? arrivals.map(f => (
                  <div
                    key={f.acid}
                    className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3"
                    title={`${f.acid} from ${f.dep_arpt || '?'} — ${f.flight_status}${f.eta ? ' ETA ' + fmtTime(f.eta) : ''}${f.route ? '\nRoute: ' + f.route : ''}`}
                  >
                    <span className="text-acc font-bold w-14 shrink-0 truncate">{f.acid}</span>
                    <span className="text-fg2 w-8 shrink-0">{f.dep_arpt?.replace(/^K/, '') || '?'}</span>
                    <span className={clsx('w-12 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3')}>{f.flight_status?.substring(0, 5) || '—'}</span>
                    <span className="text-cyn tabular-nums ml-auto shrink-0">{fmtTime(f.eta)}</span>
                  </div>
                )) : <div className="py-2 text-center text-fg3 text-[8px]">no arrivals</div>}
              </div>
            </div>

            {/* Departures */}
            <div className="bg-bg1 flex flex-col min-h-0">
              <div className="px-2 py-0.5 text-[8px] text-grn bg-bg2 border-b border-border shrink-0 flex justify-between">
                <span>DEPARTURES</span>
                <span className="text-fg3">{departures.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {departures.length > 0 ? departures.map(f => (
                  <div
                    key={f.acid}
                    className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3"
                    title={`${f.acid} to ${f.arr_arpt || '?'} — ${f.flight_status}${f.etd ? ' ETD ' + fmtTime(f.etd) : ''}${f.route ? '\nRoute: ' + f.route : ''}`}
                  >
                    <span className="text-acc font-bold w-14 shrink-0 truncate">{f.acid}</span>
                    <span className="text-fg2 w-8 shrink-0">{f.arr_arpt?.replace(/^K/, '') || '?'}</span>
                    <span className={clsx('w-12 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3')}>{f.flight_status?.substring(0, 5) || '—'}</span>
                    <span className="text-grn tabular-nums ml-auto shrink-0">{fmtTime(f.etd || f.atd)}</span>
                  </div>
                )) : <div className="py-2 text-center text-fg3 text-[8px]">no departures</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
