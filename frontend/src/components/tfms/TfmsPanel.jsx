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
  const positioned = flights.filter(f => f.lat != null && f.lon != null).length

  return (
    <div className="bg-bg1 border-t border-border">
      {/* Header with NAS health bar */}
      <div
        className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="text-acc text-[9px] tracking-wider uppercase font-bold">TFMS</span>
        <span className="text-fg3 text-[9px]">{flights.length} plans{positioned > 0 ? ` · ${positioned} tracked` : ''}</span>

        {/* NAS health indicator */}
        {health != null && (
          <div className="flex items-center gap-1.5 ml-2">
            <span className="text-[8px] text-fg3">NAS</span>
            <div className="w-16 h-1.5 bg-bg rounded-full overflow-hidden" title={`NAS health: ${health}/100`}>
              <div
                className={clsx('h-full rounded-full transition-all', health >= 80 ? 'bg-grn' : health >= 50 ? 'bg-ylw' : 'bg-red')}
                style={{ width: `${health}%` }}
              />
            </div>
            <span className={clsx('text-[9px] font-bold tabular-nums', health >= 80 ? 'text-grn' : health >= 50 ? 'text-ylw' : 'text-red')}>
              {health}
            </span>
          </div>
        )}

        {/* Inline alert badges */}
        {gs > 0 && <span className="text-[8px] text-red font-bold animate-pulse ml-1">GS:{gs}</span>}
        {gdps > 0 && <span className="text-[8px] text-ylw font-bold ml-1">GDP:{gdps}</span>}
        {totalDelay > 0 && <span className="text-[8px] text-fg3 ml-1">{totalDelay}m delay</span>}
        {affected > 0 && <span className="text-[8px] text-fg3">{affected} apt</span>}

        <span className="ml-auto text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div style={{ height: '280px' }}>
          <AirportBoard backendOk={backendOk} />
        </div>
      )}
    </div>
  )
}
