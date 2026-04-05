import { useMemo } from 'react'
import clsx from 'clsx'

function scoreTier(score) {
  if (score >= 80) return { color: 'text-grn', bg: 'bg-grn', tint: 'rgba(181,189,104,0.06)', label: 'NORMAL' }
  if (score >= 60) return { color: 'text-ylw', bg: 'bg-ylw', tint: 'rgba(240,198,116,0.06)', label: 'MODERATE' }
  if (score >= 40) return { color: 'text-red', bg: 'bg-red', tint: 'rgba(204,102,102,0.06)', label: 'STRESSED' }
  return { color: 'text-red', bg: 'bg-red', tint: 'rgba(204,102,102,0.10)', label: 'SEVERE', pulse: true }
}

export default function NasHealthBar({ health }) {
  const tier = useMemo(() => {
    if (!health || health.score == null) return null
    return scoreTier(health.score)
  }, [health])

  if (!health || health.score == null) {
    return (
      <div className="w-full h-7 bg-bg2 flex items-center px-2 text-[9px] text-fg3">
        NAS health data unavailable
      </div>
    )
  }

  const { score, activeGroundStops, activeGDPs, totalDelayMin, affectedAirports, criticalWeather } = health

  const stats = [
    activeGroundStops != null && `${activeGroundStops} GS`,
    activeGDPs != null && `${activeGDPs} GDP`,
    totalDelayMin != null && `${Math.round(totalDelayMin)}m delay`,
    affectedAirports != null && `${affectedAirports} apt`,
    criticalWeather != null && `${criticalWeather} wx`,
  ].filter(Boolean)

  return (
    <div
      className="w-full h-7 flex items-center px-2 gap-2 border-b border-border"
      style={{ background: tier.tint }}
    >
      {/* Score badge */}
      <div
        className={clsx(
          'flex items-center gap-1.5 shrink-0',
          tier.pulse && 'animate-pulse'
        )}
      >
        <span
          className={clsx(
            'inline-flex items-center justify-center w-6 h-5 rounded-sm text-[11px] font-bold text-bg',
            tier.bg
          )}
          title={`NAS health score: ${score}`}
        >
          {score}
        </span>
        <span className={clsx('text-[9px] font-bold tracking-wide', tier.color)}>
          {health.label || tier.label}
        </span>
      </div>

      {/* Separator */}
      <div className="w-px h-3 bg-border shrink-0" />

      {/* Inline stats */}
      <div className="flex items-center gap-1 text-[9px] text-fg2 min-w-0 truncate">
        {stats.map((s, i) => (
          <span key={i} className="shrink-0">
            {i > 0 && <span className="text-fg3 mx-0.5">&middot;</span>}
            <span
              className={clsx(
                s.includes('GS') && activeGroundStops > 0 && 'text-red font-bold',
                s.includes('GDP') && activeGDPs > 0 && 'text-ylw font-bold',
                s.includes('delay') && totalDelayMin > 300 && 'text-ylw',
              )}
              title={s}
            >
              {s}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
