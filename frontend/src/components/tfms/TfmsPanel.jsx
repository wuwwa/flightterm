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
    <div className="bg-bg1 border-t-2 border-cyn/40" data-testid="airport-ops-panel">
      {/* Header */}
      <div className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2">
        <div className="flex items-center gap-2 cursor-pointer select-none" onClick={() => setCollapsed(c => !c)}>
          <span className="ft-chip ft-chip--cyan">airport ops</span>
          <span className="text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
        </div>

        {health != null && (
          <span
            className={clsx(
              'flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border',
              health >= 80 ? 'bg-grn/15 text-grn border-grn/40'
                : health >= 50 ? 'bg-ylw/15 text-ylw border-ylw/40'
                : 'bg-red/15 text-red border-red/40'
            )}
            title={`Airspace health: ${health}/100 — ${gs} GS, ${gdps} GDP, ${congestion} congestion, ${totalAirports} airports`}
          >
            <span className="w-10 h-1 bg-bg/40 rounded-full overflow-hidden">
              <span className={clsx('block h-full rounded-full transition-all', health >= 80 ? 'bg-grn' : health >= 50 ? 'bg-ylw' : 'bg-red')} style={{ width: `${health}%` }} />
            </span>
            {healthLabel}
          </span>
        )}

        {gs > 0 && <span className="text-[8px] text-red font-bold animate-pulse">{gs} ground stop{gs !== 1 ? 's' : ''}</span>}
        {gdps > 0 && <span className="text-[8px] text-ylw font-bold">{gdps} delay pgm{gdps !== 1 ? 's' : ''}</span>}
        {congestion > 0 && <span className="text-[8px] text-red">{congestion} congested</span>}
        {elevated > 0 && <span className="text-[8px] text-ylw">{elevated} elevated</span>}
        <span className="ml-auto text-fg3/50 text-[8px]">{totalAirports} airports</span>
      </div>

      {!collapsed && (
        <div className="bg-bg1 h-[420px] sm:h-[360px] overflow-y-auto sm:overflow-hidden">
          <AirportBoard backendOk={backendOk} airport={selectedAirport} onAirportChange={setSelectedAirport} />
        </div>
      )}
    </div>
  )
}
