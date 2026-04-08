import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import AirportBoard from './AirportBoard'

export default function TfmsPanel({ backendOk }) {
  const { nasSummary } = useSwim()
  const [collapsed, setCollapsed] = useState(false)
  const [selectedAirport, setSelectedAirport] = useState('KJFK')

  const health = nasSummary?.health ?? null
  const gs = nasSummary?.groundStops || 0
  const gdps = nasSummary?.gdps || 0
  const congestion = nasSummary?.congestionBuilding || 0
  const elevated = nasSummary?.elevated || 0
  const totalAirports = nasSummary?.totalAirports || 0

  const healthLabel = health >= 80 ? 'NORMAL' : health >= 50 ? 'DEGRADED' : 'IMPACTED'

  return (
    <div className="bg-bg1 border-t border-border">
      {/* Header */}
      <div className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2">
        <div className="flex items-center gap-2 cursor-pointer select-none" onClick={() => setCollapsed(c => !c)}>
          <span className="text-cyn text-[9px] tracking-wider uppercase font-bold">airport ops</span>
          <span className="text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
        </div>

        {health != null && (
          <div className="flex items-center gap-1.5" title={`Airspace health: ${health}/100 — ${gs} GS, ${gdps} GDP, ${congestion} congestion, ${totalAirports} airports`}>
            <div className="w-12 h-1.5 bg-bg rounded-full overflow-hidden">
              <div className={clsx('h-full rounded-full transition-all', health >= 80 ? 'bg-grn' : health >= 50 ? 'bg-ylw' : 'bg-red')} style={{ width: `${health}%` }} />
            </div>
            <span className={clsx('text-[8px] font-bold', health >= 80 ? 'text-grn' : health >= 50 ? 'text-ylw' : 'text-red')}>{healthLabel}</span>
          </div>
        )}

        {gs > 0 && <span className="text-[8px] text-red font-bold animate-pulse">{gs} ground stop{gs !== 1 ? 's' : ''}</span>}
        {gdps > 0 && <span className="text-[8px] text-ylw font-bold">{gdps} delay pgm{gdps !== 1 ? 's' : ''}</span>}
        {congestion > 0 && <span className="text-[8px] text-red">{congestion} congested</span>}
        {elevated > 0 && <span className="text-[8px] text-ylw">{elevated} elevated</span>}
        <span className="ml-auto text-fg3/50 text-[8px]">{totalAirports} airports</span>
      </div>

      {!collapsed && (
        <div className="bg-bg1" style={{ height: '260px' }}>
          <AirportBoard backendOk={backendOk} airport={selectedAirport} onAirportChange={setSelectedAirport} />
        </div>
      )}
    </div>
  )
}
