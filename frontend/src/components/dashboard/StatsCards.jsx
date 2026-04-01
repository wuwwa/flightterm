import clsx from 'clsx'

function Card({ value, label, colorClass = 'text-acc', small }) {
  return (
    <div className="bg-bg1 py-1.5 px-2.5 flex flex-col gap-0.5">
      <span className={clsx(small ? 'text-sm' : 'text-lg', 'font-medium', colorClass)}>{value ?? '—'}</span>
      <span className="text-[10px] text-fg3">{label}</span>
    </div>
  )
}

function fmt(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

const SEV_COLORS = {
  CRITICAL: 'text-red',
  HIGH: 'text-ylw',
  MEDIUM: 'text-fg2',
}

const CAT_LABELS = {
  SQUAWK: 'squawk',
  EMERGENCY: 'emergency',
  ALTITUDE: 'altitude',
  SPEED: 'speed',
  HEADING: 'heading',
  DIVERSION: 'diversion',
  PHASE: 'phase',
  INTENT: 'intent',
}

export default function StatsCards({ stats, anomalyStats, onSelectIcao }) {
  const as = anomalyStats || {}

  // anomaly rate: anomalies per 100 aircraft tracked
  const rate = stats?.unique_aircraft && as.total
    ? ((as.total / stats.unique_aircraft) * 100).toFixed(1)
    : null

  return (
    <div className="bg-border">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border">
        operational metrics (24h)
      </div>

      {/* Severity breakdown */}
      <div className="grid grid-cols-4 gap-px">
        <Card value={fmt(as.active)} label="active" colorClass="text-red" />
        <Card value={fmt(as.critical)} label="critical" colorClass="text-red" />
        <Card value={fmt(as.high)} label="high" colorClass="text-ylw" />
        <Card value={fmt(as.medium)} label="medium" colorClass="text-fg2" />
      </div>

      {/* Category breakdown */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-t border-b border-border">
        by category
      </div>
      <div className="grid grid-cols-4 gap-px">
        {Object.entries(CAT_LABELS).map(([key, label]) => (
          <Card key={key} value={fmt(as[`cat_${key.toLowerCase()}`])} label={label} colorClass="text-acc" small />
        ))}
      </div>

      {/* Operational health */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-t border-b border-border">
        health
      </div>
      <div className="grid grid-cols-3 gap-px">
        <Card
          value={as.mttr_minutes != null ? `${Math.round(as.mttr_minutes)}m` : '—'}
          label="mean time to resolve"
          colorClass="text-cyn"
          small
        />
        <Card
          value={rate ? `${rate}%` : '—'}
          label="anomaly rate"
          colorClass={rate && parseFloat(rate) > 5 ? 'text-ylw' : 'text-grn'}
          small
        />
        <Card
          value={fmt(as.unique_aircraft)}
          label="aircraft flagged"
          colorClass="text-mag"
          small
        />
      </div>

      {/* Repeat offenders */}
      {as.repeaters?.length > 0 && (
        <>
          <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-t border-b border-border">
            repeat offenders (24h)
          </div>
          <div className="bg-bg1 max-h-[100px] overflow-y-auto">
            {as.repeaters.map((r) => (
              <div
                key={r.icao}
                className="flex gap-2 py-0.5 px-2.5 text-[10px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors"
                onClick={() => onSelectIcao?.(r.icao, r.callsign)}
              >
                <span className="text-acc">{r.icao}</span>
                <span className="text-ylw">{r.callsign || '—'}</span>
                <span className="text-fg3">{r.count}x</span>
                <span className={clsx('ml-auto', SEV_COLORS[r.max_severity] || 'text-fg3')}>
                  peak {r.max_score}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
