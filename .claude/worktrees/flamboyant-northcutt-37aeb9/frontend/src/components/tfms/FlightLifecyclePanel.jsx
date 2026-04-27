import { useMemo } from 'react'
import clsx from 'clsx'

const PHASE_COLORS = {
  SPOT_OUT: { dot: 'bg-ylw', text: 'text-ylw', border: 'border-ylw' },
  OFF: { dot: 'bg-grn', text: 'text-grn', border: 'border-grn' },
  ASCENDING: { dot: 'bg-cyn', text: 'text-cyn', border: 'border-cyn' },
  CRUISING: { dot: 'bg-cyn', text: 'text-cyn', border: 'border-cyn' },
  DESCENDING: { dot: 'bg-ylw', text: 'text-ylw', border: 'border-ylw' },
  ON: { dot: 'bg-cyn', text: 'text-cyn', border: 'border-cyn' },
  SPOT_IN: { dot: 'bg-acc', text: 'text-acc', border: 'border-acc' },
}

const DEFAULT_PHASE = { dot: 'bg-fg3', text: 'text-fg3', border: 'border-fg3' }

function fmtTime(ts) {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d)) return typeof ts === 'string' ? ts.substring(11, 16) : null
  return d.toISOString().substring(11, 16) + 'z'
}

function fmtDuration(min) {
  if (min == null) return '--'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function FlightLifecyclePanel({ lifecycle }) {
  if (!lifecycle) {
    return (
      <div className="h-full flex flex-col bg-bg1">
        <div className="px-2 py-0.5 text-[9px] bg-bg2 border-b border-border text-mag font-bold shrink-0">
          FLIGHT LIFECYCLE
        </div>
        <div className="flex-1 flex items-center justify-center text-fg3 text-[10px]">
          search a flight to view lifecycle
        </div>
      </div>
    )
  }

  const { acid, depArpt, arrArpt, status, timeline, taxiOutMin, taxiInMin, gateToGateMin } = lifecycle

  const phases = useMemo(() => {
    if (!timeline || !timeline.length) return []
    return timeline.map(t => ({
      ...t,
      colors: PHASE_COLORS[t.phase] || DEFAULT_PHASE,
      time: fmtTime(t.timestamp),
    }))
  }, [timeline])

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-0.5 bg-bg2 border-b border-border shrink-0">
        <span className="text-mag font-bold text-[9px]">FLIGHT LIFECYCLE</span>
        <span className="text-acc font-bold text-[10px]">{acid}</span>
        <span className="text-fg2 text-[9px]">
          {depArpt?.replace(/^K/, '') || '?'} → {arrArpt?.replace(/^K/, '') || '?'}
        </span>
        {status && (
          <span className={clsx(
            'text-[8px] font-bold ml-auto',
            status === 'COMPLETED' ? 'text-grn' :
            status === 'ACTIVE' ? 'text-cyn' :
            'text-fg3'
          )}>
            {status}
          </span>
        )}
      </div>

      {/* Timeline visualization */}
      <div className="px-3 py-3 shrink-0">
        {phases.length > 0 ? (
          <div className="relative flex items-start">
            {/* Connecting line */}
            <div className="absolute top-[7px] left-4 right-4 h-px bg-border2" />

            {phases.map((p, i) => (
              <div
                key={i}
                className="relative flex-1 flex flex-col items-center min-w-0"
                title={`${p.phase}${p.time ? ' at ' + p.time : ''}${p.source ? ' (via ' + p.source + ')' : ''}`}
              >
                {/* Dot */}
                <div className={clsx(
                  'w-3.5 h-3.5 rounded-full border-2 z-10',
                  p.colors.dot,
                  p.colors.border
                )} />
                {/* Phase label */}
                <span className={clsx(
                  'text-[7px] mt-1 whitespace-nowrap font-bold',
                  p.colors.text
                )}>
                  {p.phase.replace(/_/g, ' ')}
                </span>
                {/* Timestamp */}
                {p.time && (
                  <span className="text-[7px] text-fg3/60 tabular-nums">{p.time}</span>
                )}
                {/* Source */}
                {p.source && (
                  <span className="text-[6px] text-fg3/40">{p.source}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[9px] text-fg3 text-center py-1">no timeline data</div>
        )}
      </div>

      {/* Metrics row */}
      <div className="px-2 py-1 border-t border-border flex items-center gap-1 text-[9px] shrink-0">
        <Metric label="taxi out" value={fmtDuration(taxiOutMin)} color="text-ylw" />
        <span className="text-fg3">&middot;</span>
        <Metric label="gate-to-gate" value={fmtDuration(gateToGateMin)} color="text-cyn" />
        <span className="text-fg3">&middot;</span>
        <Metric label="taxi in" value={fmtDuration(taxiInMin)} color="text-acc" />
      </div>
    </div>
  )
}

function Metric({ label, value, color }) {
  return (
    <span className="flex items-center gap-1" title={`${label}: ${value}`}>
      <span className="text-fg3">{label}:</span>
      <span className={clsx('font-bold tabular-nums', color)}>{value}</span>
    </span>
  )
}
