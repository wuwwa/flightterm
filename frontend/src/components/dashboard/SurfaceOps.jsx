import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'

const EVENT_COLORS = {
  SPOT_OUT: 'text-ylw', OFF: 'text-grn', ON: 'text-cyn',
  SPOT_IN: 'text-acc', DEPARTURE: 'text-grn',
}

const EVENT_LABELS = {
  OFF: 'DEPART', ON: 'ARRIVE', SPOT_OUT: 'PUSH', SPOT_IN: 'GATE',
}

export default function SurfaceOps({ backendOk }) {
  const [oooi, setOooi] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    setLoading(true)
    const refresh = () => {
      Promise.all([
        axios.get('/api/swim/oooi', { params: { limit: 30 } }).then(r => r.data).catch(() => []),
        axios.get('/api/swim/status').then(r => r.data?.surface).catch(() => null),
      ]).then(([o, s]) => {
        if (cancelled) return
        setOooi(Array.isArray(o) ? o : [])
        setStats(s)
        setLoading(false)
      })
    }
    refresh()
    const id = setInterval(refresh, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span>departures & arrivals · STDDS</span>
        <span className="flex gap-2">
          {stats?.airports > 0 && <span>{stats.airports} apt</span>}
          {stats?.oooi > 0 && <span className="text-grn">{stats.oooi} mvmt</span>}
        </span>
      </div>

      {/* Event feed — compact rows */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {oooi.length > 0 ? oooi.map((e, i) => {
          const parts = (e.text || '').split(' ')
          const acType = parts.length >= 3 && parts[2] !== 'rwy' ? parts[2] : null
          return (
            <div key={e.id || i} className="flex items-center gap-2 py-0.5 px-2.5 text-[10px] border-b border-white/3">
              <span className={clsx('font-bold w-12 shrink-0', EVENT_COLORS[e.event_type] || 'text-fg3')}>
                {EVENT_LABELS[e.event_type] || e.event_type || '?'}
              </span>
              <span className="text-acc w-7 shrink-0">{e.airport?.replace(/^K/, '') || '—'}</span>
              <span className="text-fg2 font-bold w-16 shrink-0 truncate">{e.callsign || '—'}</span>
              {acType && <span className="text-fg3 w-8 shrink-0">{acType}</span>}
              <span className="text-fg3 truncate">{e.runway || ''}</span>
              <span className="text-fg3/50 ml-auto shrink-0">{e.received_at?.substring(11, 16)}z</span>
            </div>
          )
        }) : (
          <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">
            {loading ? 'loading...' : 'waiting for events'}
          </div>
        )}
      </div>
    </div>
  )
}
