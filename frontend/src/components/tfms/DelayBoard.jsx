import { useMemo } from 'react'
import clsx from 'clsx'
import AIRPORTS from '../../data/airports'
import { formatLocalTime } from '../../utils/time'

const EVENT_COLORS = {
  GS: 'text-red', GDP: 'text-ylw', AFP: 'text-ylw', REROUTE: 'text-mag',
  RSTR: 'text-ylw', CTOP: 'text-ylw', GADV: 'text-cyn', FXA: 'text-mag',
}

const EVENT_LABELS = {
  GS: 'Ground Stop', GDP: 'Ground Delay', AFP: 'Arrival Flow', REROUTE: 'Reroute',
  RSTR: 'Restriction', CTOP: 'CTOP', GADV: 'Advisory', FXA: 'Flow Area',
}

function fmtTime(ts) {
  return formatLocalTime(ts)
}

export default function DelayBoard({ flowEvents, flights, onSelectAirport }) {
  // Aggregate delays by airport
  const airportDelays = useMemo(() => {
    const map = {}
    if (!flowEvents) return []
    for (const e of flowEvents) {
      if (!e.airport) continue
      if (!map[e.airport]) {
        map[e.airport] = { airport: e.airport, events: [], maxDelay: 0, hasGS: false, hasGDP: false }
      }
      map[e.airport].events.push(e)
      if (e.delay_minutes && e.delay_minutes > map[e.airport].maxDelay) {
        map[e.airport].maxDelay = e.delay_minutes
      }
      if (e.event_type === 'GS') map[e.airport].hasGS = true
      if (e.event_type === 'GDP') map[e.airport].hasGDP = true
    }
    return Object.values(map).sort((a, b) => {
      if (a.hasGS !== b.hasGS) return a.hasGS ? -1 : 1
      if (a.hasGDP !== b.hasGDP) return a.hasGDP ? -1 : 1
      return b.maxDelay - a.maxDelay
    })
  }, [flowEvents])

  // Flight counts by airport
  const flightCounts = useMemo(() => {
    const map = {}
    if (!flights) return map
    for (const f of flights) {
      if (f.arr_arpt) map[f.arr_arpt] = (map[f.arr_arpt] || 0) + 1
      if (f.dep_arpt) map[f.dep_arpt] = (map[f.dep_arpt] || 0) + 1
    }
    return map
  }, [flights])

  // Non-airport events (FXA, RSTR without airport)
  const areaEvents = useMemo(() =>
    (flowEvents || []).filter(e => !e.airport && (e.event_type === 'FXA' || e.event_type === 'RSTR')),
    [flowEvents]
  )

  return (
    <div className="h-full flex flex-col bg-bg1">
      <div className="px-2 py-0.5 text-[9px] bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="text-ylw font-bold">DELAYS & RESTRICTIONS</span>
        <span className="text-fg3">{airportDelays.length} airports affected</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {airportDelays.length === 0 && areaEvents.length === 0 ? (
          <div className="py-3 text-center text-grn text-[10px]">no active delays or restrictions</div>
        ) : (
          <>
            {/* Airport delays */}
            {airportDelays.map(ad => {
              const ap = AIRPORTS[ad.airport]
              const maxBar = Math.min(100, (ad.maxDelay / 120) * 100) // 120m = full bar
              return (
                <div
                  key={ad.airport}
                  className="border-b border-white/3 px-2 py-1 cursor-pointer hover:bg-bg2 transition-colors"
                  onClick={() => onSelectAirport?.(ad.airport)}
                  title={ad.events.map(e => `${e.event_type}${e.delay_minutes ? ` ${Math.round(e.delay_minutes)}m` : ''}: ${e.text || ''}`).join('\n')}
                >
                  <div className="flex items-center gap-2 text-[9px]">
                    <span className="text-acc font-bold w-8">{ad.airport.replace(/^K/, '')}</span>
                    {ap && <span className="text-fg3 text-[8px] w-20 truncate">{ap.city}</span>}
                    <div className="flex gap-1">
                      {ad.events.map((e, i) => (
                        <span key={i} className={clsx('font-bold', EVENT_COLORS[e.event_type] || 'text-fg3')}>
                          {e.event_type}
                        </span>
                      ))}
                    </div>
                    {ad.maxDelay > 0 && (
                      <span className="text-ylw font-bold ml-auto">{Math.round(ad.maxDelay)}m</span>
                    )}
                    <span className="text-fg3/50 text-[8px]">{flightCounts[ad.airport] || 0} flt</span>
                  </div>
                  {/* Delay bar */}
                  {ad.maxDelay > 0 && (
                    <div className="mt-0.5 h-1 bg-bg2 rounded overflow-hidden">
                      <div
                        className={clsx('h-full rounded', ad.hasGS ? 'bg-red' : 'bg-ylw')}
                        style={{ width: `${maxBar}%` }}
                      />
                    </div>
                  )}
                </div>
              )
            })}

            {/* Area restrictions */}
            {areaEvents.length > 0 && (
              <>
                <div className="px-2 py-0.5 text-[8px] text-mag bg-bg2/50 border-t border-border">AREA RESTRICTIONS</div>
                {areaEvents.map((e, i) => (
                  <div key={e.id || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3" title={e.text || ''}>
                    <span className={clsx('font-bold shrink-0', EVENT_COLORS[e.event_type] || 'text-fg3')}>{e.event_type}</span>
                    {e.facility && <span className="text-fg3">{e.facility}</span>}
                    {e.ceiling && <span className="text-cyn">FL{e.floor || '?'}-{e.ceiling}</span>}
                    <span className="text-fg2 truncate flex-1">{e.text?.substring(0, 50) || '—'}</span>
                    <span className="text-fg3/50 shrink-0">{fmtTime(e.received_at)}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
