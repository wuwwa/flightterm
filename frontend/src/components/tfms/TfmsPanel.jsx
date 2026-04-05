import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import AirportBoard from './AirportBoard'

export default function TfmsPanel({ backendOk }) {
  const { nasSummary, flights } = useSwim()
  const [collapsed, setCollapsed] = useState(false)

  const health = nasSummary?.health ?? null
  const gs = nasSummary?.groundStops || 0
  const gdps = nasSummary?.gdps || 0
  const affected = nasSummary?.affectedAirports || 0
  const totalDelay = nasSummary?.totalDelayMin || 0

  const healthLabel = health >= 80 ? 'NORMAL' : health >= 50 ? 'DEGRADED' : 'IMPACTED'

  return (
    <div className="bg-bg1 border-t border-border">
      {/* Header */}
      <div
        className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="text-cyn text-[9px] tracking-wider uppercase font-bold">airport ops</span>
        <span className="text-fg3 text-[9px]">arrivals · departures · delays · capacity</span>

        {/* NAS health indicator */}
        {health != null && (
          <div className="flex items-center gap-1.5 ml-2" title={`NAS health: ${health}/100 — ${gs} ground stops, ${gdps} GDPs, ${totalDelay}m total delay, ${affected} airports affected`}>
            <div className="w-12 h-1.5 bg-bg rounded-full overflow-hidden">
              <div
                className={clsx('h-full rounded-full transition-all', health >= 80 ? 'bg-grn' : health >= 50 ? 'bg-ylw' : 'bg-red')}
                style={{ width: `${health}%` }}
              />
            </div>
            <span className={clsx('text-[8px] font-bold', health >= 80 ? 'text-grn' : health >= 50 ? 'text-ylw' : 'text-red')}>
              {healthLabel}
            </span>
          </div>
        )}

        {/* Inline alert badges */}
        {gs > 0 && <span className="text-[8px] text-red font-bold animate-pulse">GS:{gs}</span>}
        {gdps > 0 && <span className="text-[8px] text-ylw font-bold">GDP:{gdps}</span>}
        {affected > 0 && <span className="text-[8px] text-fg3">{affected} apt affected</span>}

        <span className="ml-auto text-fg3 text-[9px] flex items-center gap-1.5">
          <span className="text-fg3/50">{flights.length} flight plans</span>
          {collapsed ? '▸' : '▾'}
        </span>
      </div>

      {!collapsed && (
        <div style={{ height: '280px' }}>
          <AirportBoard backendOk={backendOk} />
        </div>
      )}
    </div>
  )
}
