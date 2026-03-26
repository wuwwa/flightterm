import clsx from 'clsx'

const SEV_COLORS = {
  CRITICAL: 'bg-red/15 border-red/30',
  HIGH:     'bg-ylw/10 border-ylw/20',
  MEDIUM:   'bg-white/3 border-white/5',
}

const SEV_BADGE = {
  CRITICAL: 'bg-red text-bg',
  HIGH:     'bg-ylw text-bg',
  MEDIUM:   'bg-fg3/30 text-fg2',
}

const CAT_COLORS = {
  SQUAWK:    'text-red',
  EMERGENCY: 'text-red',
  ALTITUDE:  'text-cyn',
  SPEED:     'text-ylw',
  HEADING:   'text-mag',
  DIVERSION: 'text-mag',
  PHASE:     'text-acc',
  INTENT:    'text-cyn',
}

function fmtTime(iso) {
  if (!iso) return '—'
  try { return iso.substring(11, 19) } catch { return iso }
}

function weatherTags(wx) {
  if (!wx) return null
  const tags = []
  const sig = wx.sigmets
  const pir = wx.pireps
  if (sig?.convective > 0)  tags.push({ label: `SIGMET convective x${sig.convective}`, cls: 'text-red' })
  if (sig?.turbulence > 0)  tags.push({ label: `SIGMET turb x${sig.turbulence}`, cls: 'text-ylw' })
  if (sig?.icing > 0)       tags.push({ label: `SIGMET ice x${sig.icing}`, cls: 'text-cyn' })
  if (pir?.severe)          tags.push({ label: `PIREP severe: ${pir.maxTurbulence || pir.maxIcing}`, cls: 'text-red' })
  else if (pir?.count > 0)  tags.push({ label: `${pir.count} PIREP${pir.count !== 1 ? 's' : ''} nearby`, cls: 'text-fg3' })
  return tags.length ? tags : null
}

export default function AnomalyFeed({ anomalies = [], onSelect, selectedIcao }) {
  if (!anomalies.length) {
    return (
      <div className="bg-bg1 py-6 px-2.5 text-center text-fg3 text-[10px]">
        no anomalies detected
      </div>
    )
  }

  return (
    <div className="bg-bg1 overflow-y-auto max-h-[70vh]">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border sticky top-0 z-10 flex justify-between">
        <span>anomaly feed</span>
        <span>{anomalies.length} events</span>
      </div>
      {anomalies.map((a) => (
        <div
          key={a.id}
          onClick={() => onSelect?.(a)}
          className={clsx(
            'border-b px-2.5 py-1',
            onSelect && 'cursor-pointer hover:brightness-125',
            a.icao === selectedIcao && 'ring-1 ring-acc ring-inset',
            a.resolved ? 'opacity-40 bg-bg1 border-white/3' : (SEV_COLORS[a.severity] || SEV_COLORS.MEDIUM),
          )}
        >
          {/* Row 1: severity + icao + score */}
          <div className="flex items-center gap-1.5 text-[10px]">
            {!a.resolved && a.severity && (
              <span className={clsx('text-[8px] px-1 py-px rounded font-bold tracking-wider shrink-0', SEV_BADGE[a.severity] || SEV_BADGE.MEDIUM)}>
                {a.severity}
              </span>
            )}
            <span className="text-acc">{a.icao}</span>
            <span className="text-ylw truncate">{a.callsign || '—'}</span>
            <span className="ml-auto shrink-0 flex items-center gap-1.5">
              <span className="text-fg3 text-[9px]">{fmtTime(a.detected_at)}</span>
              {a.resolved ? (
                <span className="text-grn text-[9px]">resolved</span>
              ) : (
                <span className="text-red font-bold">{a.score}</span>
              )}
            </span>
          </div>
          {/* Row 2: category */}
          {!a.resolved && a.category && (
            <div className="text-[9px] mt-0.5 pl-1">
              <span className={CAT_COLORS[a.category] || 'text-fg3'}>{a.category}</span>
              {a.categories?.length > 1 && a.categories.slice(1).map((cat) => (
                <span key={cat} className={clsx('ml-1', CAT_COLORS[cat] || 'text-fg3')}>+{cat}</span>
              ))}
            </div>
          )}
          {/* Reason line */}
          {!a.resolved && a.reasons?.length > 0 && (
            <div className="text-[9px] text-fg3 mt-0.5 truncate pl-1">
              {a.reasons[0]}
            </div>
          )}
          {/* Weather context */}
          {!a.resolved && weatherTags(a.weather_context) && (
            <div className="flex gap-1.5 mt-0.5 pl-1 items-center">
              <span className="text-[8px] text-fg3">WX:</span>
              {weatherTags(a.weather_context).map((t, i) => (
                <span key={i} className={clsx('text-[8px]', t.cls)}>{t.label}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
