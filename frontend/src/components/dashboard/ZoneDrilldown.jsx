import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchAnomaliesByZone } from '../../services/dashboard'

const SEV_COLORS = {
  CRITICAL: 'text-red',
  HIGH: 'text-ylw',
  MEDIUM: 'text-fg3',
}

export default function ZoneDrilldown({ zone, onSelectAnomaly, onClose }) {
  const [anomalies, setAnomalies] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!zone) return
    setLoading(true)
    fetchAnomaliesByZone(zone.lat, zone.lon, 168, 30)
      .then(setAnomalies)
      .catch(() => setAnomalies([]))
      .finally(() => setLoading(false))
  }, [zone?.lat, zone?.lon])

  if (!zone) return null

  const label = zone.label || 'Zone'

  return (
    <div className="bg-bg1 border border-border">
      <div className="bg-bg2 border-b border-border py-1 px-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-mag text-[11px] font-bold tracking-wider uppercase">zone</span>
          <span className="text-acc text-[11px] font-bold">{label}</span>
          <span className="text-fg3 text-[10px]">{zone.count} events (7d)</span>
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
        <button onClick={onClose} className="text-fg3 hover:text-fg1 text-[11px] px-1">x</button>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-4 gap-px bg-border text-center">
        <div className="bg-bg1 py-1 px-2">
          <div className="text-sm font-medium text-acc">{zone.count}</div>
          <div className="text-[9px] text-fg3">events</div>
        </div>
        <div className="bg-bg1 py-1 px-2">
          <div className="text-sm font-medium text-mag">{zone.unique_aircraft}</div>
          <div className="text-[9px] text-fg3">aircraft</div>
        </div>
        <div className="bg-bg1 py-1 px-2">
          <div className={clsx('text-sm font-medium', zone.deviation >= 3 ? 'text-red' : zone.deviation >= 1.5 ? 'text-ylw' : 'text-grn')}>
            {zone.deviation != null ? `${zone.deviation}x` : '—'}
          </div>
          <div className="text-[9px] text-fg3">vs baseline</div>
        </div>
        <div className="bg-bg1 py-1 px-2">
          <div className="text-sm font-medium text-fg2">{zone.baseline_avg ?? '—'}</div>
          <div className="text-[9px] text-fg3">avg/day</div>
        </div>
      </div>

      {/* Categories */}
      {zone.categories?.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2.5 py-1 border-t border-white/5">
          {zone.categories.map(c => (
            <span key={c} className="text-[9px] text-mag border border-mag/30 px-1 rounded">{c}</span>
          ))}
        </div>
      )}

      {/* Recent anomalies in this zone */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-t border-b border-border">
        recent anomalies in zone ({anomalies.length})
      </div>
      <div className="max-h-[180px] overflow-y-auto">
        {anomalies.length === 0 && !loading && (
          <div className="text-[10px] text-fg3/40 px-2.5 py-2 text-center">no anomalies found</div>
        )}
        {anomalies.map((a) => (
          <div
            key={a.id}
            className="flex gap-2 py-0.5 px-2.5 text-[10px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors"
            onClick={() => onSelectAnomaly?.(a)}
          >
            <span className={clsx('shrink-0 w-[52px]', SEV_COLORS[a.severity])}>
              {a.severity?.substring(0, 4)}
            </span>
            <span className="text-acc shrink-0 w-[52px]">{a.icao}</span>
            <span className="text-ylw shrink-0 w-[56px] truncate">{a.callsign || '—'}</span>
            <span className="text-mag shrink-0 w-[56px] truncate">{a.category || '—'}</span>
            <span className="text-fg3 truncate flex-1">{a.reasons?.[0] || '—'}</span>
            <span className="text-fg3 shrink-0">{a.detected_at?.substring(11, 16)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
