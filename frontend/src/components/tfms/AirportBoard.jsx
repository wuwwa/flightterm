import { useMemo } from 'react'
import clsx from 'clsx'
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

export default function AirportBoard({ flights, airport, onChangeAirport, onSelectFlight }) {
  const { airportConfigs, flowEvents: allFlowEvents } = useSwim()

  const config = useMemo(() =>
    airportConfigs.find(c => c.airport === airport) || null,
    [airportConfigs, airport]
  )

  const flowEvents = useMemo(() =>
    allFlowEvents.filter(e => e.airport === airport),
    [allFlowEvents, airport]
  )

  const arrivals = useMemo(() =>
    flights.filter(f => f.arr_arpt === airport).sort((a, b) => (a.eta || '').localeCompare(b.eta || '')),
    [flights, airport]
  )

  const departures = useMemo(() =>
    flights.filter(f => f.dep_arpt === airport).sort((a, b) => (a.etd || '').localeCompare(b.etd || '')),
    [flights, airport]
  )

  const activeGS = flowEvents.find(e => e.event_type === 'GS')
  const activeGDP = flowEvents.find(e => e.event_type === 'GDP')

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Airport selector */}
      <div className="flex items-center gap-2 px-2 py-1 bg-bg2 border-b border-border shrink-0">
        <select
          value={airport || ''}
          onChange={(e) => onChangeAirport(e.target.value)}
          className="bg-bg1 border border-border text-fg text-[10px] px-1.5 py-0.5 rounded outline-none focus:border-acc"
        >
          <option value="">select airport</option>
          {Object.entries(AIRPORTS)
            .sort((a, b) => a[1].city.localeCompare(b[1].city))
            .map(([icao, ap]) => (
              <option key={icao} value={icao}>{icao.replace(/^K/, '')} — {ap.city}</option>
            ))}
        </select>

        {/* Runway config */}
        {config && (
          <div className="flex gap-3 text-[8px] text-fg3">
            <span>Arr: <span className="text-cyn">{config.arr_runway || '—'}</span> <span className="text-fg3/50">{config.arr_rate || '?'}/hr</span></span>
            <span>Dep: <span className="text-grn">{config.dep_runway || '—'}</span> <span className="text-fg3/50">{config.dep_rate || '?'}/hr</span></span>
            {config.weather && <span className="text-ylw">{config.weather}</span>}
          </div>
        )}

        {/* Active restrictions */}
        {activeGS && <span className="text-[8px] text-red font-bold ml-auto">GROUND STOP</span>}
        {activeGDP && !activeGS && <span className="text-[8px] text-ylw font-bold ml-auto">GDP {activeGDP.delay_minutes ? `${Math.round(activeGDP.delay_minutes)}m` : ''}</span>}
      </div>

      {!airport ? (
        <div className="flex-1 flex items-center justify-center text-fg3 text-[10px]">select an airport above</div>
      ) : (
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
                  className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer hover:bg-bg2"
                  onClick={() => onSelectFlight?.(f)}
                  title={`${f.acid} from ${f.dep_arpt || '?'} — ${f.flight_status}${f.eta ? ' ETA ' + fmtTime(f.eta) : ''}${f.route ? '\n' + f.route : ''}`}
                >
                  <span className="text-acc font-bold w-14 shrink-0 truncate">{f.acid}</span>
                  <span className="text-fg2 w-8 shrink-0">{f.dep_arpt?.replace(/^K/, '') || '?'}</span>
                  <span className={clsx('w-12 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3')}>{f.flight_status?.substring(0, 5) || '—'}</span>
                  <span className="text-cyn tabular-nums shrink-0">{fmtTime(f.eta)}</span>
                </div>
              )) : (
                <div className="py-2 text-center text-fg3 text-[8px]">no arrivals</div>
              )}
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
                  className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer hover:bg-bg2"
                  onClick={() => onSelectFlight?.(f)}
                  title={`${f.acid} to ${f.arr_arpt || '?'} — ${f.flight_status}${f.etd ? ' ETD ' + fmtTime(f.etd) : ''}${f.route ? '\n' + f.route : ''}`}
                >
                  <span className="text-acc font-bold w-14 shrink-0 truncate">{f.acid}</span>
                  <span className="text-fg2 w-8 shrink-0">{f.arr_arpt?.replace(/^K/, '') || '?'}</span>
                  <span className={clsx('w-12 shrink-0', STATUS_COLORS[f.flight_status] || 'text-fg3')}>{f.flight_status?.substring(0, 5) || '—'}</span>
                  <span className="text-grn tabular-nums shrink-0">{fmtTime(f.etd || f.atd)}</span>
                </div>
              )) : (
                <div className="py-2 text-center text-fg3 text-[8px]">no departures</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
