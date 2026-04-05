import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'

const EVENT_COLORS = {
  SPOT_OUT: 'text-ylw', OFF: 'text-grn', ON: 'text-cyn',
  SPOT_IN: 'text-acc', DEPARTURE: 'text-grn',
}

const EVENT_LABELS = {
  OFF: 'DEPART', ON: 'ARRIVE', SPOT_OUT: 'PUSH', SPOT_IN: 'GATE',
}

export default function SurfaceOps({ backendOk }) {
  const { status, oooi } = useSwim()
  const stats = status?.surface

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span>departures & arrivals</span>
        <span className="flex gap-2">
          {stats?.airports > 0 && <span>{stats.airports} apt</span>}
          {stats?.oooi > 0 && <span className="text-grn">{stats.oooi} mvmt</span>}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {oooi.length > 0 ? oooi.map((e, i) => {
          const parts = (e.text || '').split(' ')
          const acType = parts.length >= 3 && parts[2] !== 'rwy' ? parts[2] : null
          const label = EVENT_LABELS[e.event_type] || e.event_type || '?'
          const tooltip = `${label} ${e.callsign || '?'} at ${e.airport || '?'}${acType ? ' (' + acType + ')' : ''}${e.runway ? ' rwy ' + e.runway : ''}`
          return (
            <div key={e.id || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3" title={tooltip}>
              <span className={clsx('font-bold w-10 shrink-0', EVENT_COLORS[e.event_type] || 'text-fg3')}>
                {label}
              </span>
              <span className="text-acc w-6 shrink-0">{e.airport?.replace(/^K/, '') || '—'}</span>
              <span className="text-fg2 font-bold truncate flex-1">{e.callsign || '—'}</span>
              {acType && <span className="text-fg3 shrink-0">{acType}</span>}
              <span className="text-fg3/50 shrink-0">{e.received_at?.substring(11, 16)}z</span>
            </div>
          )
        }) : (
          <div className="py-2 px-2 text-center text-fg3 text-[9px]">waiting for events</div>
        )}
      </div>
    </div>
  )
}
