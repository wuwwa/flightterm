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
  GDP: 'text-ylw',
  GS: 'text-red',
  AFP: 'text-ylw',
  REROUTE: 'text-mag',
  ADVISORY: 'text-cyn',
  CTOP: 'text-ylw',
}

const EVENT_LABELS = {
  GDP: 'Ground Delay',
  GS: 'Ground Stop',
  AFP: 'Arrival Flow',
  REROUTE: 'Reroute',
  ADVISORY: 'Advisory',
  CTOP: 'CTOP',
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

  const tfmsStats = status?.tfms
  const tfmsFeed = status?.feeds?.tfms
  const connected = tfmsFeed?.connected
  const activeFlights = tfmsStats?.active_flights || 0
  const totalPlans = tfmsStats?.recent_plans || 0
  const gdps = tfmsStats?.active_gdps || 0
  const groundStops = tfmsStats?.active_gs || 0
  const flowCount = tfmsStats?.recent_flow_events || 0

  return (
    <div className="bg-bg1">
      {/* Header */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>NAS status · TFMS</span>
        <span className="flex items-center gap-1.5">
          {tfmsFeed ? (
            <>
              <span className={clsx(
                'inline-block w-1.5 h-1.5 rounded-full',
                connected ? 'bg-grn' : 'bg-red'
              )} />
              <span className={connected ? 'text-grn' : 'text-red'}>
                {connected ? 'live' : 'disconnected'}
              </span>
              {tfmsFeed.received > 0 && (
                <span className="text-fg3">{tfmsFeed.received.toLocaleString()} msgs</span>
              )}
            </>
          ) : loading ? 'loading...' : (
            <span className="text-fg3">not configured</span>
          )}
        </span>
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
        <div className="border-t border-border max-h-28 overflow-y-auto">
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

      {/* No TFMS */}
      {!tfmsFeed && !loading && (
        <div className="px-2.5 py-1.5 text-[9px] text-fg3/60">
          set SWIM_TFMS_QUEUE in .env to enable
        </div>
      )}
    </div>
  )
}
