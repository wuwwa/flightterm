import clsx from 'clsx'
import { scoreAnomaly, ANOMALY_THRESHOLD, detectPhase } from '../utils/anomaly'

// Score each snapshot against its preceding history to find anomaly points
function detectAnomalyPoints(snapshots) {
  if (!snapshots || snapshots.length < 3) return []
  const flags = []
  for (let i = 2; i < snapshots.length; i++) {
    const hist = snapshots.slice(0, i)
    const curr = snapshots[i]
    const { score, reasons } = scoreAnomaly(hist, curr)
    if (score >= ANOMALY_THRESHOLD) {
      // classify by dominant reason
      const hasAlt = reasons.some(r => r.includes('descent') || r.includes('climb'))
      const hasVel = reasons.some(r => r.includes('speed'))
      flags.push({ i, score, reasons, type: hasAlt ? 'alt' : hasVel ? 'vel' : 'other' })
    }
  }
  return flags
}

function Sparkline({ data, color, label, unit, anomalyIndices }) {
  if (!data || data.length < 2) return null

  const vals = data.map(d => d ?? 0)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1

  const W = 240
  const H = 36
  const padY = 2

  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W
    const y = H - padY - ((v - min) / range) * (H - padY * 2)
    return { x, y, val: v }
  })

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  const latest = vals[vals.length - 1]
  const prev = vals[vals.length - 2]
  const delta = latest - prev
  const deltaStr = delta >= 0 ? `+${delta.toFixed(0)}` : delta.toFixed(0)

  const anomalySet = new Set(anomalyIndices || [])

  return (
    <div className="px-2.5 py-1.5">
      <div className="flex justify-between items-center mb-1">
        <span className="text-fg3 text-[10px]">{label}</span>
        <span className="text-[10px] flex items-center gap-1.5">
          <span className={color}>{latest != null ? `${latest.toFixed(0)}${unit}` : '—'}</span>
          {delta !== 0 && (
            <span className={clsx('text-[9px]', delta > 0 ? 'text-grn' : 'text-red')}>
              {deltaStr}
            </span>
          )}
        </span>
      </div>
      <svg width={W} height={H} className="w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {/* grid lines */}
        <line x1="0" y1={padY} x2={W} y2={padY} stroke="var(--color-border)" strokeWidth="0.5" />
        <line x1="0" y1={H - padY} x2={W} y2={H - padY} stroke="var(--color-border)" strokeWidth="0.5" />
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="2,3" />

        {/* main line */}
        <path d={pathD} fill="none" stroke={`var(--color-${color.replace('text-', '')})`} strokeWidth="1.5" strokeLinejoin="round" />

        {/* anomaly markers */}
        {points.map((p, i) =>
          anomalySet.has(i) ? (
            <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="var(--color-red)" opacity="0.9" />
          ) : null
        )}

        {/* latest point */}
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="2" fill={`var(--color-${color.replace('text-', '')})`} />
      </svg>
      <div className="flex justify-between text-[9px] text-fg3 mt-0.5">
        <span>{min.toFixed(0)}{unit}</span>
        <span>{max.toFixed(0)}{unit}</span>
      </div>
    </div>
  )
}

export default function TrackChart({ snapshots }) {
  if (!snapshots || snapshots.length < 2) {
    return (
      <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">
        tracking — waiting for data (need 2+ fetches)
      </div>
    )
  }

  const phase = detectPhase(snapshots)
  const anomalies = detectAnomalyPoints(snapshots)
  const altAnomalies = anomalies.filter(a => a.type === 'alt').map(a => a.i)
  const velAnomalies = anomalies.filter(a => a.type === 'vel').map(a => a.i)

  const altData = snapshots.map(s => s.alt)
  const velData = snapshots.map(s => s.vel)
  const hdgData = snapshots.map(s => s.hdg)

  const hasAlt = altData.some(v => v != null)
  const hasVel = velData.some(v => v != null)
  const hasHdg = hdgData.some(v => v != null)

  return (
    <div>
      <div className="px-2.5 pt-1 pb-0.5 flex items-center gap-2">
        <span className="text-[10px] text-fg3">phase:</span>
        <span className={clsx('text-[10px] font-bold', phase === 'cruise' ? 'text-grn' : phase === 'approach' || phase === 'descent' ? 'text-ylw' : phase === 'climb' ? 'text-cyn' : 'text-fg3')}>
          {phase}
        </span>
      </div>
      {hasAlt && (
        <Sparkline data={altData} color="text-cyn" label="altitude" unit=" m" anomalyIndices={altAnomalies} />
      )}
      {hasVel && (
        <Sparkline data={velData} color="text-acc" label="speed" unit=" m/s" anomalyIndices={velAnomalies} />
      )}
      {hasHdg && (
        <Sparkline data={hdgData} color="text-fg2" label="heading" unit="°" anomalyIndices={[]} />
      )}
      {anomalies.length > 0 && (
        <div className="px-2.5 pb-1.5">
          {anomalies.slice(-3).map((a, i) => (
            <div key={i} className="text-[10px] flex items-center gap-1">
              <span className="text-red">!</span>
              <span className="text-fg3">[{a.score}]</span>
              <span className="text-fg3">{a.reasons[0]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
