import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'

async function fetchSwimStatus() {
  const res = await axios.get('/api/swim/status')
  return res.data
}

async function fetchFlowEvents() {
  const res = await axios.get('/api/swim/flow', { params: { limit: 20 } })
  return res.data
}

const EVENT_COLORS = {
  GDP: 'text-ylw', GS: 'text-red', AFP: 'text-ylw', REROUTE: 'text-mag',
  GADV: 'text-cyn', RSTR: 'text-ylw', FXA: 'text-mag', CTOP: 'text-ylw',
  APTC: 'text-grn', TMI_LIST: 'text-fg3',
}

const EVENT_LABELS = {
  GDP: 'Ground Delay', GS: 'Ground Stop', AFP: 'Arrival Flow', REROUTE: 'Reroute',
  GADV: 'Advisory', RSTR: 'Restriction', FXA: 'Flow Area', CTOP: 'CTOP',
  APTC: 'Apt Config', TMI_LIST: 'TMI List',
}

function FeedDot({ feed, label }) {
  if (!feed) return <span className="text-fg3/40 text-[9px]">{label}</span>
  return (
    <span className="flex items-center gap-0.5 text-[9px]">
      <span className={clsx('inline-block w-1.5 h-1.5 rounded-full', feed.connected ? 'bg-grn' : 'bg-red')} />
      <span className={feed.connected ? 'text-grn' : 'text-fg3/40'}>{label}</span>
      {feed.connected && feed.received > 0 && (
        <span className="text-fg3/50">{feed.received > 999 ? Math.round(feed.received / 1000) + 'k' : feed.received}</span>
      )}
    </span>
  )
}

export default function NasStatus({ backendOk }) {
  const [status, setStatus] = useState(null)
  const [flowEvents, setFlowEvents] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    setLoading(true)

    const refresh = () => {
      Promise.all([
        fetchSwimStatus().catch(() => null),
        fetchFlowEvents().catch(() => []),
      ]).then(([s, f]) => {
        if (cancelled) return
        setStatus(s)
        setFlowEvents(Array.isArray(f) ? f : [])
        setLoading(false)
      })
    }

    refresh()
    const id = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const feeds = status?.feeds || {}
  const tfmsStats = status?.tfms
  const activeFlights = tfmsStats?.active_flights || 0
  const totalPlans = tfmsStats?.recent_plans || 0
  const gdps = tfmsStats?.active_gdps || 0
  const groundStops = tfmsStats?.active_gs || 0
  const connectedCount = Object.values(feeds).filter(f => f?.connected).length

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      {/* Header with all feed indicators */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>NAS status · FAA SWIM</span>
        <span className="text-fg3">{connectedCount}/5 feeds</span>
      </div>

      {/* Feed connection indicators */}
      <div className="flex gap-3 px-2.5 py-1 border-b border-white/5">
        <FeedDot feed={feeds.fns} label="FNS" />
        <FeedDot feed={feeds.tfms} label="TFMS" />
        <FeedDot feed={feeds.sfdps} label="SFDPS" />
        <FeedDot feed={feeds.itws} label="ITWS" />
        <FeedDot feed={feeds.stdds} label="STDDS" />
      </div>

      {/* Key metrics */}
      {tfmsStats && (
        <div className="grid grid-cols-4 gap-px bg-border">
          <div className="bg-bg1 py-1 px-2 text-center">
            <div className="text-sm font-medium text-acc">{activeFlights.toLocaleString()}</div>
            <div className="text-[9px] text-fg3">active flights</div>
          </div>
          <div className="bg-bg1 py-1 px-2 text-center">
            <div className="text-sm font-medium text-fg2">{totalPlans.toLocaleString()}</div>
            <div className="text-[9px] text-fg3">plans (1h)</div>
          </div>
          <div className="bg-bg1 py-1 px-2 text-center">
            <div className={clsx('text-sm font-medium', groundStops > 0 ? 'text-red' : 'text-grn')}>
              {groundStops}
            </div>
            <div className="text-[9px] text-fg3">ground stops</div>
          </div>
          <div className="bg-bg1 py-1 px-2 text-center">
            <div className={clsx('text-sm font-medium', gdps > 0 ? 'text-ylw' : 'text-grn')}>
              {gdps}
            </div>
            <div className="text-[9px] text-fg3">GDPs</div>
          </div>
        </div>
      )}

      {/* Active flow events */}
      {flowEvents.length > 0 && (
        <div className="border-t border-border flex-1 min-h-0 overflow-y-auto">
          {flowEvents.map((ev, i) => (
            <div key={ev.id || i} className="flex items-start gap-2 py-0.5 px-2.5 text-[9px] border-b border-white/3">
              <span className={clsx('font-bold shrink-0 w-14', EVENT_COLORS[ev.event_type] || 'text-fg3')}>
                {EVENT_LABELS[ev.event_type] || ev.event_type}
              </span>
              {ev.airport && (
                <span className="text-acc font-bold shrink-0">{ev.airport}</span>
              )}
              {ev.reason && (
                <span className="text-fg3 shrink-0">{ev.reason}</span>
              )}
              <span className="text-fg2 truncate flex-1">
                {ev.text?.substring(0, 80) || '—'}
              </span>
              {ev.delay_minutes && (
                <span className="text-ylw shrink-0">{Math.round(ev.delay_minutes)}m delay</span>
              )}
              <span className="text-fg3/50 shrink-0">
                {ev.received_at?.substring(11, 16)}z
              </span>
            </div>
          ))}
        </div>
      )}

      {/* No feeds configured */}
      {connectedCount === 0 && !loading && (
        <div className="px-2.5 py-1.5 text-[9px] text-fg3/60">
          set SWIM_* env vars to enable FAA data feeds
        </div>
      )}
    </div>
  )
}
