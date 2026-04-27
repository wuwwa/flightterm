import { useMemo, useState } from 'react'
import clsx from 'clsx'

function loadColor(ratio) {
  if (ratio > 1.0) return 'bg-red'
  if (ratio >= 0.7) return 'bg-ylw'
  return 'bg-grn'
}

function loadTextColor(ratio) {
  if (ratio > 1.0) return 'text-red'
  if (ratio >= 0.7) return 'text-ylw'
  return 'text-grn'
}

function Bar({ demand, capacity, label }) {
  const ratio = capacity > 0 ? demand / capacity : 0
  const pct = Math.min(ratio * 100, 100)
  const overflow = ratio > 1.0

  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <span className="text-[7px] text-fg3 w-3 shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-bg relative rounded-sm overflow-hidden">
        <div
          className={clsx('h-full rounded-sm transition-all', loadColor(ratio))}
          style={{ width: `${pct}%`, opacity: 0.7 }}
        />
        {overflow && (
          <div
            className="absolute top-0 right-0 h-full bg-red animate-pulse rounded-r-sm"
            style={{ width: `${Math.min((ratio - 1.0) * 100, 30)}%`, opacity: 0.5 }}
          />
        )}
        {/* Capacity mark at 100% */}
        <div className="absolute top-0 right-0 w-px h-full bg-fg3/30" />
      </div>
      <span
        className={clsx('text-[8px] tabular-nums w-10 text-right shrink-0', loadTextColor(ratio))}
        title={`demand: ${demand}, capacity: ${capacity}, load: ${(ratio * 100).toFixed(0)}%`}
      >
        {demand}/{capacity}
      </span>
    </div>
  )
}

export default function CapacityGauges({ capacityData }) {
  const [hoveredAirport, setHoveredAirport] = useState(null)

  const sorted = useMemo(() => {
    if (!capacityData || !capacityData.length) return []
    return [...capacityData]
      .sort((a, b) => Math.max(b.arrLoad || 0, b.depLoad || 0) - Math.max(a.arrLoad || 0, a.depLoad || 0))
      .slice(0, 8)
  }, [capacityData])

  if (!sorted.length) {
    return (
      <div className="h-full flex flex-col bg-bg1">
        <div className="px-2 py-0.5 text-[9px] bg-bg2 border-b border-border text-ylw font-bold shrink-0">
          CAPACITY vs DEMAND
        </div>
        <div className="flex-1 flex items-center justify-center text-fg3 text-[9px]">
          no capacity data available
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg1">
      <div className="px-2 py-0.5 text-[9px] bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="text-ylw font-bold">CAPACITY vs DEMAND</span>
        <span className="text-fg3">{sorted.length} airports</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {sorted.map(ap => {
          const arrRatio = ap.arrCapacity > 0 ? ap.arrDemand / ap.arrCapacity : 0
          const depRatio = ap.depCapacity > 0 ? ap.depDemand / ap.depCapacity : 0
          const maxRatio = Math.max(arrRatio, depRatio)
          const isHovered = hoveredAirport === ap.airport

          return (
            <div
              key={ap.airport}
              className={clsx(
                'flex items-center gap-2 px-2 py-0.5 border-b border-white/3 transition-colors',
                isHovered && 'bg-bg2'
              )}
              onMouseEnter={() => setHoveredAirport(ap.airport)}
              onMouseLeave={() => setHoveredAirport(null)}
              title={[
                `${ap.airport}`,
                `Arr: ${ap.arrDemand}/${ap.arrCapacity} (${(arrRatio * 100).toFixed(0)}%)${ap.arrRunway ? ' rwy ' + ap.arrRunway : ''}`,
                `Dep: ${ap.depDemand}/${ap.depCapacity} (${(depRatio * 100).toFixed(0)}%)${ap.depRunway ? ' rwy ' + ap.depRunway : ''}`,
                ap.weather ? `Weather: ${ap.weather}` : null,
              ].filter(Boolean).join('\n')}
            >
              {/* Airport code */}
              <span
                className={clsx(
                  'text-[9px] font-bold w-7 shrink-0',
                  maxRatio > 1.0 ? 'text-red' : maxRatio >= 0.7 ? 'text-ylw' : 'text-acc'
                )}
                title={ap.airport}
              >
                {ap.airport.replace(/^K/, '')}
              </span>

              {/* Gauges */}
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                <Bar demand={ap.arrDemand} capacity={ap.arrCapacity} label="A" />
                <Bar demand={ap.depDemand} capacity={ap.depCapacity} label="D" />
              </div>

              {/* Weather indicator */}
              {ap.weather && (
                <span className="text-[7px] text-ylw shrink-0" title={`Weather: ${ap.weather}`}>
                  {ap.weather.substring(0, 3)}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
