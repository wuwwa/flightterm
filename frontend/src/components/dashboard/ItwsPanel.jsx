import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'

export default function ItwsPanel({ backendOk }) {
  const { status, weather: events } = useSwim()
  const stats = status?.terminalWeather

  const hazardEvents = events.filter(e =>
    e.severity === 'CRITICAL' || e.severity === 'HIGH' || e.severity === 'MEDIUM'
  )

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span>terminal weather · ITWS</span>
        <span>{stats?.sites || 0} sites</span>
      </div>

      {stats && stats.total > 0 ? (
        <div className="px-2 py-0.5 flex gap-2 text-[9px] flex-wrap shrink-0 border-b border-white/5">
          {stats.tornado > 0 && <span className="text-red font-bold" title={`${stats.tornado} tornado alerts`}>tornado: {stats.tornado}</span>}
          {stats.microburst > 0 && <span className="text-red font-bold" title={`${stats.microburst} microburst alerts`}>microburst: {stats.microburst}</span>}
          {stats.windshear > 0 && <span className="text-red" title={`${stats.windshear} windshear alerts`}>windshear: {stats.windshear}</span>}
          {stats.gust_front > 0 && <span className="text-ylw" title={`${stats.gust_front} gust front alerts`}>gust front: {stats.gust_front}</span>}
          {stats.precip > 0 && <span className="text-cyn" title={`${stats.precip} precipitation events`}>precip: {stats.precip}</span>}
          {stats.hazard_text > 0 && <span className="text-ylw" title={`${stats.hazard_text} hazard text alerts`}>hazard: {stats.hazard_text}</span>}
          {!stats.tornado && !stats.windshear && !stats.microburst && !stats.gust_front && (
            <span className="text-grn">no terminal hazards</span>
          )}
        </div>
      ) : (
        <div className="px-2 py-0.5 text-[9px] text-fg3 shrink-0">no terminal weather data yet</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {hazardEvents.map((e, i) => {
          const typeLabel = e.event_type === 'TORNADO' ? 'TRNDO' : e.event_type === 'MICROBURST' ? 'MBRST'
            : e.event_type === 'WINDSHEAR' ? 'WSHEAR' : e.event_type === 'GUST_FRONT' ? 'GUST'
            : e.event_type === 'HAZARD_TEXT' ? 'HAZRD' : e.event_type?.substring(0, 5) || '?'
          const tooltip = `${e.event_type || '?'} at ${e.airport || e.site || '?'} [${e.severity}]: ${e.text || ''}`
          return (
            <div key={e.id || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3" title={tooltip}>
              <span className={clsx(
                'font-bold shrink-0 w-10',
                e.severity === 'CRITICAL' ? 'text-red' : e.severity === 'HIGH' ? 'text-ylw' : 'text-fg2'
              )}>
                {typeLabel}
              </span>
              <span className="text-acc font-bold shrink-0 w-6">{e.airport || e.site || '—'}</span>
              <span className="text-fg2 truncate flex-1">{e.text || '—'}</span>
              <span className="text-fg3/50 shrink-0">{e.received_at?.substring(11, 16)}z</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
