import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchAnomaliesByZone } from '../../services/dashboard'

const SEV_COLORS = {
  CRITICAL: 'text-red',
  HIGH: 'text-ylw',
  MEDIUM: 'text-fg3',
}

function Row({ label, value, color = 'text-fg' }) {
  const empty = value == null || value === ''
  return (
    <div className="flex justify-between py-px px-2 gap-2">
      <span className="text-fg3 text-[10px] shrink-0">{label}</span>
      <span className={clsx('text-right text-[10px]', empty ? 'text-fg3/40' : color)}>
        {empty ? '—' : value}
      </span>
    </div>
  )
}

function Group({ title, color = 'text-fg3', children }) {
  return (
    <div className="mb-1">
      <div className={clsx('text-[9px] tracking-wider uppercase px-2 py-0.5 border-b border-white/5', color)}>
        {title}
      </div>
      {children}
    </div>
  )
}

export default function ZoneDrilldown({ zone, onSelectAnomaly, onClose }) {
  const [anomalies, setAnomalies] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!zone) return
    setLoading(true)
    fetchAnomaliesByZone(zone.lat, zone.lon, 24, 50)
      .then(setAnomalies)
      .catch(() => setAnomalies([]))
      .finally(() => setLoading(false))
  }, [zone?.lat, zone?.lon])

  // ESC to close
  useEffect(() => {
    if (!zone) return
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [zone, onClose])

  if (!zone) return null

  const label = zone.label || 'Zone'

  // Derive unique aircraft from anomaly list
  const uniqueIcaos = [...new Set(anomalies.map(a => a.icao))]

  // Severity breakdown from zone hotspot data
  const critical = zone.critical || 0
  const high = zone.high || 0
  const medium = zone.medium || 0
  const total = critical + high + medium

  // Time range
  const firstSeen = zone.first_seen?.substring(0, 16)?.replace('T', ' ')
  const lastSeen = zone.last_seen?.substring(0, 16)?.replace('T', ' ')

  // Derived analytics from anomaly list
  const resolvedCount = anomalies.filter(a => a.resolved).length
  const unresolvedCount = anomalies.filter(a => !a.resolved).length
  const confirmedCount = anomalies.filter(a => a.confirmed).length

  // Repeat offenders — aircraft with 2+ anomalies in this zone
  const icaoCounts = {}
  for (const a of anomalies) {
    icaoCounts[a.icao] = (icaoCounts[a.icao] || 0) + 1
  }
  const repeaters = Object.entries(icaoCounts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])

  // Phase distribution
  const phaseCounts = {}
  for (const a of anomalies) {
    if (a.phase) phaseCounts[a.phase] = (phaseCounts[a.phase] || 0) + 1
  }
  const phases = Object.entries(phaseCounts).sort((a, b) => b[1] - a[1])

  // Altitude stats
  const alts = anomalies.map(a => a.alt).filter(a => a != null)
  const avgAlt = alts.length > 0 ? Math.round(alts.reduce((s, v) => s + v, 0) / alts.length) : null
  const minAlt = alts.length > 0 ? Math.min(...alts) : null
  const maxAlt = alts.length > 0 ? Math.max(...alts) : null

  // Time-of-day clustering (hour distribution)
  const hourCounts = new Array(24).fill(0)
  for (const a of anomalies) {
    const h = parseInt(a.detected_at?.substring(11, 13), 10)
    if (!isNaN(h)) hourCounts[h]++
  }
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts))
  const peakHourCount = hourCounts[peakHour]

  return (
    <div className="fixed inset-0 z-200 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-bg1 border border-border w-[95vw] sm:w-[90vw] max-w-215 max-h-[90vh] sm:max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="bg-bg2 border-b border-border py-1 px-2.5 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <span className="text-mag text-[11px] font-bold tracking-wider uppercase">zone</span>
            <span className="text-acc text-[11px] font-bold">{label}</span>
            <span className="text-fg3 text-[10px]">{zone.count} events (24h)</span>
            {zone.deviation != null && (
              <span className={clsx(
                'text-[10px] font-bold',
                zone.deviation >= 3 ? 'text-red' : zone.deviation >= 1.5 ? 'text-ylw' : 'text-grn'
              )}>
                {zone.deviation}x baseline
              </span>
            )}
            {loading && <span className="text-fg3 text-[9px]">loading...</span>}
          </div>
          <button onClick={onClose} className="text-fg3 hover:text-fg1 text-[11px] px-1">✕</button>
        </div>

        {/* 3-column investigation grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
          {/* Column 1: zone overview + severity breakdown */}
          <div className="bg-bg1 py-1">
            <Group title="zone overview" color="text-mag">
              <Row label="location" value={label} color="text-acc" />
              <Row label="lat" value={zone.lat?.toFixed(4)} color="text-cyn" />
              <Row label="lon" value={zone.lon?.toFixed(4)} color="text-cyn" />
              <Row label="nearest apt" value={zone.nearest_airport} color="text-acc" />
              <Row label="apt distance" value={zone.airport_dist_km != null ? `${zone.airport_dist_km} km` : null} />
              <Row label="city" value={zone.airport_city} />
              <Row label="state" value={zone.airport_state} />
            </Group>
            <Group title="severity breakdown" color="text-red">
              <Row label="total events" value={total || zone.count} color="text-fg2" />
              <Row label="critical" value={critical} color="text-red" />
              <Row label="high" value={high} color="text-ylw" />
              <Row label="medium" value={medium} color="text-fg3" />
              <Row label="max score" value={zone.max_score} color="text-red" />
              <Row label="avg score" value={zone.avg_score} color="text-ylw" />
            </Group>
            <Group title="categories" color="text-mag">
              <div className="flex flex-wrap gap-1 px-2 py-1">
                {zone.categories?.length > 0
                  ? zone.categories.map(c => (
                      <span key={c} className="text-[9px] text-mag border border-mag/30 px-1 rounded">{c}</span>
                    ))
                  : <span className="text-[9px] text-fg3/40">—</span>
                }
              </div>
            </Group>
          </div>

          {/* Column 2: baseline + time context */}
          <div className="bg-bg1 py-1">
            <Group title="baseline analysis" color="text-grn">
              <Row label="current rate" value={zone.count != null ? `${(zone.count / 7).toFixed(1)} /day` : null} color="text-fg2" />
              <Row label="baseline avg" value={zone.baseline_avg != null ? `${zone.baseline_avg} /day` : null} color="text-grn" />
              <Row label="baseline max" value={zone.baseline_max != null ? `${zone.baseline_max} /day` : null} color="text-fg3" />
              <Row label="baseline days" value={zone.baseline_days} color="text-fg3" />
              <Row label="deviation" value={zone.deviation != null ? `${zone.deviation}x` : null}
                color={zone.deviation >= 3 ? 'text-red' : zone.deviation >= 1.5 ? 'text-ylw' : 'text-grn'} />
            </Group>
            <Group title="time range" color="text-cyn">
              <Row label="first seen" value={firstSeen} color="text-fg3" />
              <Row label="last seen" value={lastSeen} color="text-cyn" />
              <Row label="peak hour" value={peakHourCount > 0 ? `${String(peakHour).padStart(2, '0')}:00 UTC (${peakHourCount} events)` : null} color="text-ylw" />
            </Group>
            <Group title="resolution" color="text-grn">
              <Row label="resolved" value={resolvedCount} color="text-grn" />
              <Row label="unresolved" value={unresolvedCount} color={unresolvedCount > 0 ? 'text-red' : 'text-fg3'} />
              <Row label="confirmed" value={confirmedCount} color={confirmedCount > 0 ? 'text-ylw' : 'text-fg3'} />
            </Group>
            <Group title="altitude profile" color="text-cyn">
              <Row label="avg alt" value={avgAlt != null ? `${avgAlt} m` : null} color="text-cyn" />
              <Row label="min alt" value={minAlt != null ? `${minAlt} m` : null} color="text-fg3" />
              <Row label="max alt" value={maxAlt != null ? `${maxAlt} m` : null} color="text-fg3" />
            </Group>
            <Group title="flight phases" color="text-fg3">
              {phases.length > 0
                ? phases.map(([phase, count]) => (
                    <Row key={phase} label={phase} value={count} color="text-fg2" />
                  ))
                : <Row label="—" value={null} />
              }
            </Group>
            <Group title="aircraft" color="text-acc">
              <Row label="unique aircraft" value={zone.unique_aircraft} color="text-acc" />
              <Row label="repeat offenders" value={repeaters.length || null} color={repeaters.length > 0 ? 'text-ylw' : 'text-fg3'} />
              {repeaters.length > 0 && (
                <div className="px-2 py-0.5 flex flex-wrap gap-1">
                  {repeaters.slice(0, 12).map(([icao, count]) => (
                    <span key={icao} className="text-[9px] text-ylw border border-ylw/30 px-1 rounded">{icao} ×{count}</span>
                  ))}
                </div>
              )}
              {uniqueIcaos.length > 0 && repeaters.length === 0 && (
                <div className="px-2 py-0.5 flex flex-wrap gap-1">
                  {uniqueIcaos.slice(0, 15).map(icao => (
                    <span key={icao} className="text-[9px] text-acc border border-acc/30 px-1 rounded">{icao}</span>
                  ))}
                  {uniqueIcaos.length > 15 && (
                    <span className="text-[9px] text-fg3">+{uniqueIcaos.length - 15} more</span>
                  )}
                </div>
              )}
            </Group>
          </div>

          {/* Column 3: recent anomalies in zone */}
          <div className="bg-bg1 py-1">
            <Group title={`recent anomalies (${anomalies.length})`} color="text-ylw">
              <div className="max-h-100 overflow-y-auto">
                {anomalies.length === 0 && !loading && (
                  <div className="text-[10px] text-fg3/40 px-2 py-2 text-center">no anomalies found</div>
                )}
                {anomalies.map((a) => (
                  <div
                    key={a.id}
                    className="py-0.5 px-2 border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors"
                    onClick={() => onSelectAnomaly?.(a)}
                  >
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className={clsx('shrink-0 font-bold', SEV_COLORS[a.severity])}>
                        {a.severity?.substring(0, 4)}
                      </span>
                      <span className="text-red shrink-0">{a.score}</span>
                      <span className="text-acc shrink-0">{a.icao}</span>
                      <span className="text-ylw truncate">{a.callsign || '—'}</span>
                      <span className="text-fg3 ml-auto shrink-0">{a.detected_at?.substring(11, 16)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[9px] text-fg3">
                      <span className="text-mag">{a.category || '—'}</span>
                      <span className="truncate">{a.reasons?.[0] || '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Group>
          </div>
        </div>
      </div>
    </div>
  )
}
