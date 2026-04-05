import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'

export default function ItwsPanel({ backendOk }) {
  const [stats, setStats] = useState(null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    setLoading(true)

    const refresh = () => {
      Promise.all([
        axios.get('/api/swim/status').then(r => r.data?.terminalWeather).catch(() => null),
        axios.get('/api/swim/weather', { params: { limit: 50 } }).then(r => r.data).catch(() => []),
      ]).then(([s, e]) => {
        if (cancelled) return
        setStats(s)
        setEvents(Array.isArray(e) ? e : [])
        setLoading(false)
      })
    }

    refresh()
    const id = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const hazardEvents = events.filter(e =>
    e.severity === 'CRITICAL' || e.severity === 'HIGH' || e.severity === 'MEDIUM'
  )

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>terminal weather · ITWS</span>
        <span>{stats?.sites || 0} sites</span>
      </div>

      {/* Summary counts */}
      {stats && stats.total > 0 ? (
        <div className="px-2.5 py-1 flex gap-2 text-[10px] flex-wrap">
          {stats.tornado > 0 && <span className="text-red font-bold">tornado: {stats.tornado}</span>}
          {stats.microburst > 0 && <span className="text-red font-bold">microburst: {stats.microburst}</span>}
          {stats.windshear > 0 && <span className="text-red">windshear: {stats.windshear}</span>}
          {stats.gust_front > 0 && <span className="text-ylw">gust front: {stats.gust_front}</span>}
          {stats.precip > 0 && <span className="text-cyn">precip: {stats.precip}</span>}
          {stats.hazard_text > 0 && <span className="text-ylw">hazard: {stats.hazard_text}</span>}
          {!stats.tornado && !stats.windshear && !stats.microburst && !stats.gust_front && (
            <span className="text-grn">no terminal hazards</span>
          )}
        </div>
      ) : (
        <div className="px-2.5 py-1 text-[10px] text-fg3">
          {loading ? 'loading...' : 'no terminal weather data yet'}
        </div>
      )}

      {/* Per-event drilldown — always expanded */}
      {hazardEvents.length > 0 && (
        <div className="border-t border-border flex-1 min-h-0 overflow-y-auto">
          {hazardEvents.map((e, i) => (
            <div key={e.id || i} className="flex items-center gap-1.5 py-0.5 px-2.5 text-[9px] border-b border-white/3">
              <span className={clsx(
                'font-bold shrink-0 w-10',
                e.severity === 'CRITICAL' ? 'text-red' : e.severity === 'HIGH' ? 'text-ylw' : 'text-fg2'
              )}>
                {e.event_type === 'TORNADO' ? 'TRNDO' : e.event_type === 'MICROBURST' ? 'MBRST'
                  : e.event_type === 'WINDSHEAR' ? 'WSHEAR' : e.event_type === 'GUST_FRONT' ? 'GUST'
                  : e.event_type === 'HAZARD_TEXT' ? 'HAZRD' : e.event_type?.substring(0, 5) || '?'}
              </span>
              <span className="text-acc font-bold shrink-0 w-7">{e.airport || e.site || '—'}</span>
              <span className="text-fg2 truncate flex-1">{e.text || '—'}</span>
              <span className="text-fg3/50 shrink-0">{e.received_at?.substring(11, 16)}z</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
