import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import { useSwim } from '../../contexts/SwimContext'

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
  if (!feed) return <span className="text-fg3/40 text-[8px]">{label}</span>
  return (
    <span className="flex items-center gap-0.5 text-[8px]" title={`${label}: ${feed.connected ? 'connected' : 'disconnected'}${feed.received ? `, ${feed.received} msgs` : ''}`}>
      <span className={clsx('inline-block w-1 h-1 rounded-full', feed.connected ? 'bg-grn' : 'bg-red')} />
      <span className={feed.connected ? 'text-grn' : 'text-fg3/40'}>{label}</span>
    </span>
  )
}

export default function NasStatus({ backendOk }) {
  const { status, flowEvents } = useSwim()

  const feeds = status?.feeds || {}
  const tfmsStats = status?.tfms
  const activeFlights = tfmsStats?.active_flights || 0
  const totalPlans = tfmsStats?.recent_plans || 0
  const gdps = tfmsStats?.active_gdps || 0
  const groundStops = tfmsStats?.active_gs || 0
  const connectedCount = Object.values(feeds).filter(f => f?.connected).length

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span>NAS status</span>
        <span>{connectedCount}/5</span>
      </div>

      <div className="flex gap-2 px-2 py-0.5 border-b border-white/5 shrink-0">
        <FeedDot feed={feeds.fns} label="FNS" />
        <FeedDot feed={feeds.tfms} label="TFMS" />
        <FeedDot feed={feeds.sfdps} label="SFDPS" />
        <FeedDot feed={feeds.itws} label="ITWS" />
        <FeedDot feed={feeds.stdds} label="STDDS" />
      </div>

      {tfmsStats && (
        <div className="grid grid-cols-4 gap-px bg-border shrink-0">
          <div className="bg-bg1 py-0.5 px-1.5 text-center">
            <div className="text-[11px] font-medium text-acc">{activeFlights.toLocaleString()}</div>
            <div className="text-[7px] text-fg3">flights</div>
          </div>
          <div className="bg-bg1 py-0.5 px-1.5 text-center">
            <div className="text-[11px] font-medium text-fg2">{totalPlans.toLocaleString()}</div>
            <div className="text-[7px] text-fg3">plans/1h</div>
          </div>
          <div className="bg-bg1 py-0.5 px-1.5 text-center">
            <div className={clsx('text-[11px] font-medium', groundStops > 0 ? 'text-red' : 'text-grn')}>{groundStops}</div>
            <div className="text-[7px] text-fg3">gnd stop</div>
          </div>
          <div className="bg-bg1 py-0.5 px-1.5 text-center">
            <div className={clsx('text-[11px] font-medium', gdps > 0 ? 'text-ylw' : 'text-grn')}>{gdps}</div>
            <div className="text-[7px] text-fg3">GDPs</div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {flowEvents.length > 0 ? flowEvents.map((ev, i) => {
          const fullText = `${EVENT_LABELS[ev.event_type] || ev.event_type}${ev.airport ? ' ' + ev.airport : ''}${ev.reason ? ' — ' + ev.reason : ''}: ${ev.text || ''}`
          return (
            <div key={ev.id || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3" title={fullText}>
              <span className={clsx('font-bold shrink-0 w-8', EVENT_COLORS[ev.event_type] || 'text-fg3')}>
                {ev.event_type || '?'}
              </span>
              {ev.airport && <span className="text-acc font-bold shrink-0">{ev.airport}</span>}
              <span className="text-fg2 truncate flex-1">{ev.text?.substring(0, 40) || '—'}</span>
              {ev.delay_minutes && <span className="text-ylw shrink-0">{Math.round(ev.delay_minutes)}m</span>}
            </div>
          )
        }) : connectedCount === 0 ? (
          <div className="px-2 py-1 text-[8px] text-fg3/60">SWIM not configured</div>
        ) : null}
      </div>
    </div>
  )
}
