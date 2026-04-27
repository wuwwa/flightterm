import { useMemo } from 'react'
import clsx from 'clsx'

const TYPE_COLORS = { GS: 'text-red', GDP: 'text-ylw' }
const TYPE_BG = { GS: 'rgba(204,102,102,0.08)', GDP: 'rgba(240,198,116,0.06)' }
const TYPE_LABELS = { GS: 'GROUND STOP', GDP: 'GROUND DELAY' }

export default function CascadePanel({ cascades }) {
  const events = useMemo(() => {
    if (!cascades || !cascades.length) return []
    return [...cascades].sort((a, b) => (b.totalAffected || 0) - (a.totalAffected || 0))
  }, [cascades])

  return (
    <div className="h-full flex flex-col bg-bg1">
      <div className="px-2 py-0.5 text-[9px] bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="text-red font-bold">CASCADE IMPACT</span>
        <span className="text-fg3">{events.length} active</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {events.length === 0 ? (
          <div className="py-3 text-center text-grn text-[10px]">
            no active ground programs
          </div>
        ) : (
          events.map((ev, i) => (
            <div
              key={`${ev.airport}-${ev.eventType}-${i}`}
              className="px-2 py-1.5 border-b border-white/3"
              style={{ background: TYPE_BG[ev.eventType] || 'transparent' }}
              title={[
                `${ev.airport} — ${TYPE_LABELS[ev.eventType] || ev.eventType}`,
                `Delay: ${ev.delayMinutes || 0} min avg`,
                `Airborne affected: ${ev.airborneAffected || 0}`,
                `Ground held: ${ev.groundHeld || 0}`,
                `Total affected: ${ev.totalAffected || 0}`,
                `Est. total delay: ~${ev.estimatedTotalDelayMin || 0} min`,
              ].join('\n')}
            >
              {/* Header: airport + event type */}
              <div className="flex items-center gap-2">
                <span className="text-acc font-bold text-[10px]">
                  {ev.airport?.replace(/^K/, '') || '???'}
                </span>
                <span
                  className={clsx(
                    'text-[8px] font-bold px-1 py-px rounded-sm',
                    TYPE_COLORS[ev.eventType] || 'text-fg3',
                    ev.eventType === 'GS' && 'bg-red/15',
                    ev.eventType === 'GDP' && 'bg-ylw/10'
                  )}
                >
                  {TYPE_LABELS[ev.eventType] || ev.eventType}
                </span>
                {ev.delayMinutes > 0 && (
                  <span className="text-[9px] text-ylw font-bold ml-auto">
                    {Math.round(ev.delayMinutes)}m avg
                  </span>
                )}
              </div>

              {/* Stats row */}
              <div className="flex items-center gap-1 mt-0.5 text-[8px] text-fg2">
                <span title={`${ev.airborneAffected || 0} airborne flights affected`}>
                  <span className="text-cyn">{ev.airborneAffected || 0}</span>
                  <span className="text-fg3"> airborne</span>
                </span>
                <span className="text-fg3">&middot;</span>
                <span title={`${ev.groundHeld || 0} flights held on ground`}>
                  <span className="text-ylw">{ev.groundHeld || 0}</span>
                  <span className="text-fg3"> held</span>
                </span>
                <span className="text-fg3">&middot;</span>
                <span title={`Estimated total delay: ~${ev.estimatedTotalDelayMin || 0} minutes`}>
                  <span className="text-red">~{ev.estimatedTotalDelayMin || 0}</span>
                  <span className="text-fg3"> min total</span>
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
