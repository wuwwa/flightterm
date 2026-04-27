import clsx from 'clsx'
import { scoreAnomaly, ANOMALY_THRESHOLD, detectPhase, PHASE } from '../utils/anomaly'

const PHASE_LABEL = {
  [PHASE.CLIMB]: 'climbing', [PHASE.CRUISE]: 'cruise', [PHASE.DESCENT]: 'descending',
  [PHASE.APPROACH]: 'approach', [PHASE.GROUND]: 'ground', [PHASE.UNKNOWN]: 'unknown',
}
const PHASE_COLOR = {
  [PHASE.CLIMB]: 'text-grn', [PHASE.CRUISE]: 'text-cyn', [PHASE.DESCENT]: 'text-ylw',
  [PHASE.APPROACH]: 'text-mag', [PHASE.GROUND]: 'text-fg3', [PHASE.UNKNOWN]: 'text-fg3',
}

// Score each snapshot against its preceding history to find anomaly points
function detectAnomalyPoints(snapshots) {
  if (!snapshots || snapshots.length < 3) return []
  const flags = []
  for (let i = 2; i < snapshots.length; i++) {
    const hist = snapshots.slice(0, i)
    const curr = snapshots[i]
    const { score, reasons } = scoreAnomaly(hist, curr)
    if (score >= ANOMALY_THRESHOLD) {
      const hasAlt = reasons.some(r => r.includes('descent') || r.includes('climb'))
      const hasVel = reasons.some(r => r.includes('speed'))
      flags.push({ i, score, reasons, type: hasAlt ? 'alt' : hasVel ? 'vel' : 'other' })
    }
  }
  return flags
}

// Format timestamp to relative time or HH:MM
function fmtTs(ts, now) {
  if (!ts) return ''
  const sec = Math.round((now - ts) / 1000)
  if (sec < 60) return 'now'
  if (sec < 3600) return `-${Math.floor(sec / 60)}m`
  return new Date(ts).toISOString().substring(11, 16)
}

function Sparkline({ data, times, color, label, unit, convFn, anomalyIndices, now }) {
  if (!data || data.length < 2) return null

  const vals = data.map(d => d != null ? convFn(d) : null)
  const validVals = vals.filter(v => v != null)
  if (validVals.length < 2) return null

  const min = Math.min(...validVals)
  const max = Math.max(...validVals)
  const range = max - min || 1

  const W = 280
  const H = 44
  const padY = 3
  const padX = 2

  const points = vals.map((v, i) => {
    const x = padX + (i / (vals.length - 1)) * (W - padX * 2)
    const y = v != null ? H - padY - ((v - min) / range) * (H - padY * 2) : null
    return { x, y, val: v, ts: times?.[i] }
  }).filter(p => p.y != null)

  if (points.length < 2) return null

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  const latest = validVals[validVals.length - 1]
  const prev = validVals.length >= 2 ? validVals[validVals.length - 2] : latest
  const delta = latest - prev
  const anomalySet = new Set(anomalyIndices || [])

  // Time labels
  const firstTs = times?.[0]
  const lastTs = times?.[times.length - 1]

  return (
    <div className="px-2.5 py-1">
      <div className="flex justify-between items-center mb-0.5">
        <span className="text-fg3 text-[9px]">{label}</span>
        <span className="text-[9px] flex items-center gap-1.5">
          <span className={color}>{latest != null ? `${latest.toLocaleString(undefined, { maximumFractionDigits: 0 })}${unit}` : '—'}</span>
          {Math.abs(delta) > 0.5 && (
            <span className={clsx('text-[8px]', delta > 0 ? 'text-grn' : 'text-red')}>
              {delta > 0 ? '+' : ''}{delta.toFixed(0)}
            </span>
          )}
        </span>
      </div>
      <svg width={W} height={H} className="w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {/* Grid */}
        <line x1={padX} y1={padY} x2={W - padX} y2={padY} stroke="var(--color-border)" strokeWidth="0.5" />
        <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="var(--color-border)" strokeWidth="0.5" />
        <line x1={padX} y1={H / 2} x2={W - padX} y2={H / 2} stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="2,3" />

        {/* Main line — no area fill, just the stroke */}
        <path d={pathD} fill="none" stroke={`var(--color-${color.replace('text-', '')})`} strokeWidth="1.5" strokeLinejoin="round" />

        {/* Anomaly markers */}
        {points.map((p, i) =>
          anomalySet.has(i) ? (
            <g key={`a-${i}`}>
              <circle cx={p.x} cy={p.y} r="4" fill="var(--color-red)" opacity="0.2" />
              <circle cx={p.x} cy={p.y} r="2" fill="var(--color-red)" opacity="0.9" />
            </g>
          ) : null
        )}

        {/* Latest point */}
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="2.5"
          fill={`var(--color-${color.replace('text-', '')})`} stroke="var(--color-bg)" strokeWidth="1" />
      </svg>
      <div className="flex justify-between text-[8px] text-fg3/40 mt-0.5">
        <span>{firstTs ? fmtTs(firstTs, now) : ''}</span>
        <span className="text-fg3/30">{min.toLocaleString(undefined, { maximumFractionDigits: 0 })}{unit} — {max.toLocaleString(undefined, { maximumFractionDigits: 0 })}{unit}</span>
        <span>{lastTs ? fmtTs(lastTs, now) : ''}</span>
      </div>
    </div>
  )
}

export default function TrackChart({ snapshots }) {
  if (!snapshots || snapshots.length < 2) {
    return (
      <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">
        tracking — waiting for data (need 2+ samples)
      </div>
    )
  }

  const now = Date.now()
  const phase = detectPhase(snapshots)
  const anomalies = detectAnomalyPoints(snapshots)
  const altAnomalies = anomalies.filter(a => a.type === 'alt').map(a => a.i)
  const velAnomalies = anomalies.filter(a => a.type === 'vel').map(a => a.i)

  const altData = snapshots.map(s => s.alt)
  const velData = snapshots.map(s => s.vel)
  const hdgData = snapshots.map(s => s.hdg)
  const vrateData = snapshots.map(s => s.vertRate ?? null)
  const times = snapshots.map(s => s.ts)

  const hasAlt = altData.some(v => v != null)
  const hasVel = velData.some(v => v != null)
  const hasHdg = hdgData.some(v => v != null)
  const hasVrate = vrateData.some(v => v != null)

  // Compute some derived signals
  const lastSnap = snapshots[snapshots.length - 1]
  const altFt = lastSnap.alt != null ? Math.round(lastSnap.alt * 3.281) : null
  const spdKt = lastSnap.vel != null ? Math.round(lastSnap.vel * 1.944) : null
  const vrateFpm = lastSnap.vertRate != null ? Math.round(lastSnap.vertRate * 196.85) : null

  return (
    <div>
      {/* Status bar */}
      <div className="px-2.5 py-1 flex items-center gap-3 text-[9px] border-b border-white/5">
        <span className="text-fg3">Phase:</span>
        <span className={clsx('font-bold', PHASE_COLOR[phase])}>{PHASE_LABEL[phase]}</span>
        {altFt != null && <span className="text-cyn tabular-nums">{altFt.toLocaleString()}ft</span>}
        {spdKt != null && <span className="text-acc tabular-nums">{spdKt}kt</span>}
        {vrateFpm != null && (
          <span className={clsx('tabular-nums', Math.abs(vrateFpm) > 2000 ? 'text-ylw' : vrateFpm > 0 ? 'text-grn' : vrateFpm < 0 ? 'text-cyn' : 'text-fg3')}>
            {vrateFpm > 0 ? '+' : ''}{vrateFpm}fpm
          </span>
        )}
        {anomalies.length > 0 && <span className="text-red font-bold">{anomalies.length} triggers</span>}
      </div>

      {/* Charts */}
      {hasAlt && (
        <Sparkline data={altData} times={times} color="text-cyn" label="Altitude" unit="ft"
          convFn={m => Math.round(m * 3.281)} anomalyIndices={altAnomalies} now={now} />
      )}
      {hasVel && (
        <Sparkline data={velData} times={times} color="text-acc" label="Ground Speed" unit="kt"
          convFn={ms => Math.round(ms * 1.944)} anomalyIndices={velAnomalies} now={now} />
      )}
      {hasVrate && (
        <Sparkline data={vrateData} times={times} color="text-grn" label="Vertical Rate" unit="fpm"
          convFn={ms => Math.round(ms * 196.85)} anomalyIndices={[]} now={now} />
      )}
      {hasHdg && (
        <Sparkline data={hdgData} times={times} color="text-fg2" label="Heading" unit="°"
          convFn={v => v} anomalyIndices={[]} now={now} />
      )}

      {/* Anomaly triggers */}
      {anomalies.length > 0 && (
        <div className="px-2.5 py-1 border-t border-white/5">
          <div className="text-[8px] text-fg3/50 mb-0.5">ANOMALY TRIGGERS</div>
          {anomalies.slice(-5).map((a, i) => (
            <div key={i} className="text-[9px] flex items-center gap-1 py-0.5">
              <span className="text-red">!</span>
              <span className="text-fg3 tabular-nums w-6">[{a.score}]</span>
              <span className="text-fg2">{a.reasons[0]}</span>
              {a.reasons.length > 1 && <span className="text-fg3/40">+{a.reasons.length - 1}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
