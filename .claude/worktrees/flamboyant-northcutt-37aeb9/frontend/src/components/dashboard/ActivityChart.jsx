export default function ActivityChart({ hourly = [], anomalyHourly = [] }) {
  if (!hourly.length && !anomalyHourly.length) {
    return (
      <div className="bg-bg1 py-6 px-2.5 text-center text-fg3 text-[10px]">
        no activity data
      </div>
    )
  }

  // Fill all 24 hours
  const byHour = new Array(24).fill(0)
  for (const h of hourly) byHour[h.hour] = h.unique_aircraft || 0

  const anomByHour = new Array(24).fill(0)
  const critByHour = new Array(24).fill(0)
  for (const h of anomalyHourly) {
    anomByHour[h.hour] = h.count || 0
    critByHour[h.hour] = h.critical || 0
  }

  const maxAc = Math.max(...byHour, 1)
  const maxAnom = Math.max(...anomByHour, 1)
  const W = 280, H = 120
  const padL = 24, padR = 4, padT = 14, padB = 16
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const barW = chartW / 24
  const barGap = 1

  return (
    <div className="bg-bg1">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>hourly activity</span>
        <span className="flex gap-2">
          <span className="text-acc">aircraft</span>
          <span className="text-red">anomalies</span>
        </span>
      </div>
      <div className="px-2.5 py-1.5">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 200 }}>
          {/* grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
            const y = padT + chartH * (1 - pct)
            return (
              <g key={pct}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-border)" strokeWidth={0.5} />
                {pct > 0 && (
                  <text x={padL - 2} y={y + 3} textAnchor="end" fill="var(--color-fg3)" fontSize={7}>
                    {Math.round(maxAc * pct)}
                  </text>
                )}
              </g>
            )
          })}

          {/* Aircraft bars */}
          {byHour.map((val, i) => {
            const barH = (val / maxAc) * chartH
            const x = padL + i * barW + barGap / 2
            const y = padT + chartH - barH
            return (
              <g key={`ac-${i}`}>
                <rect
                  x={x}
                  y={y}
                  width={Math.max(0, barW - barGap)}
                  height={barH}
                  fill="var(--color-acc)"
                  opacity={0.5}
                />
                {val > 0 && barH > 10 && (
                  <text x={x + (barW - barGap) / 2} y={y - 2} textAnchor="middle" fill="var(--color-fg3)" fontSize={6}>
                    {val}
                  </text>
                )}
              </g>
            )
          })}

          {/* Anomaly overlay dots + line */}
          {anomByHour.some(v => v > 0) && (
            <>
              {/* Connecting line */}
              <polyline
                fill="none"
                stroke="var(--color-red)"
                strokeWidth={1}
                opacity={0.8}
                points={anomByHour.map((val, i) => {
                  const x = padL + i * barW + barW / 2
                  const y = padT + chartH - (val / Math.max(maxAnom, 1)) * chartH
                  return `${x},${y}`
                }).join(' ')}
              />
              {/* Dots */}
              {anomByHour.map((val, i) => {
                if (val === 0) return null
                const x = padL + i * barW + barW / 2
                const y = padT + chartH - (val / maxAnom) * chartH
                const hasCrit = critByHour[i] > 0
                return (
                  <g key={`an-${i}`}>
                    <circle cx={x} cy={y} r={hasCrit ? 3 : 2} fill={hasCrit ? 'var(--color-red)' : 'var(--color-ylw)'} />
                    <text x={x} y={y - 5} textAnchor="middle" fill="var(--color-red)" fontSize={6} fontWeight="bold">
                      {val}
                    </text>
                  </g>
                )
              })}
            </>
          )}

          {/* hour labels */}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <text
              key={h}
              x={padL + h * barW + barW / 2}
              y={H - 2}
              textAnchor="middle"
              fill="var(--color-fg3)"
              fontSize={7}
            >
              {h.toString().padStart(2, '0')}
            </text>
          ))}
        </svg>
      </div>
    </div>
  )
}
