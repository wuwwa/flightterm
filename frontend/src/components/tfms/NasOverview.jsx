import clsx from 'clsx'
import AIRPORTS from '../../data/airports'

function delayColor(v) {
  if (v == null) return 'text-fg3/30'
  if (v > 15) return 'text-red'
  if (v > 5) return 'text-ylw'
  return 'text-grn'
}

export default function NasOverview({ analytics, selectedAirport, onSelectAirport }) {
  if (!analytics) return null
  const { airports } = analytics

  const active = airports.filter(a => a.inbound + a.outbound >= 2 || a.severity > 0)

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Header */}
      <div className="py-0.5 px-2 text-[8px] bg-bg2 border-b border-border shrink-0 flex justify-between">
        <span className="text-fg3">select an airport</span>
        <span className="text-fg3/50">{active.length} active</span>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-1 py-0 px-2 text-[7px] text-fg3/40 border-b border-white/3 shrink-0">
        <span className="w-20 shrink-0">Airport</span>
        <span className="flex-1 text-right">Status</span>
      </div>

      {/* Ranked list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {active.map(a => {
          const known = AIRPORTS[a.airport]
          const code = a.airport.replace(/^K/, '').replace(/^C/, '')
          const isSelected = selectedAirport === a.airport
          const flags = []
          if (a.hasGS) flags.push({ label: 'GS', color: 'text-red' })
          if (a.hasGDP) flags.push({ label: 'GDP', color: 'text-ylw' })
          if (a.congestion === 'CONGESTION_BUILDING') flags.push({ label: 'CONG', color: 'text-red' })
          else if (a.congestion === 'ELEVATED') flags.push({ label: 'ELEV', color: 'text-ylw' })

          const total = a.inbound + a.outbound

          const tooltip = [
            known ? `${a.airport} — ${known.city}, ${known.state}` : a.airport,
            `${a.inbound} inbound, ${a.outbound} outbound`,
            a.depDelay != null ? `Avg departure delay: ${a.depDelay > 0 ? '+' : ''}${a.depDelay} min` : null,
            a.arrDelay != null ? `Avg arrival delay: ${a.arrDelay > 0 ? '+' : ''}${a.arrDelay} min` : null,
            a.taxiOut != null ? `Avg taxi out: ${a.taxiOut} min` : null,
            flags.length > 0 ? flags.map(f => f.label).join(', ') : null,
            a.cascade ? `${a.cascade.affectedFlights} flights held at ${a.cascade.originAirports} other airports` : null,
          ].filter(Boolean).join('\n')

          return (
            <div
              key={a.airport}
              onClick={() => onSelectAirport?.(a.airport)}
              title={tooltip}
              className={clsx(
                'flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer transition-colors',
                isSelected ? 'bg-acc/10 border-l-2 border-l-acc' : 'hover:bg-bg2',
                a.hasGS && !isSelected && 'bg-red/5',
              )}
            >
              {/* Airport code + city */}
              <div className="w-20 shrink-0 min-w-0">
                <span className={clsx('font-bold', isSelected ? 'text-acc' : a.hasGS ? 'text-red' : a.hasGDP ? 'text-ylw' : 'text-fg2')}>
                  {code}
                </span>
                {known && (
                  <span className="text-fg3/50 text-[7px] ml-1 truncate">{known.city}</span>
                )}
              </div>

              {/* Traffic count + delay + flags */}
              <div className="flex-1 flex items-center justify-end gap-1.5 min-w-0">
                <span className="text-fg3/50 tabular-nums text-[7px]">{total} flights</span>
                {a.depDelay != null && (
                  <span className={clsx('tabular-nums text-[7px]', delayColor(a.depDelay))}>
                    {a.depDelay > 0 ? '+' : ''}{a.depDelay}m
                  </span>
                )}
                {flags.map(f => (
                  <span key={f.label} className={clsx('font-bold text-[7px]', f.color)}>{f.label}</span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
