import { useState, useEffect, useRef } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import Loading from '../Loading'
import SwimWarming from '../SwimWarming'

const TYPE_COLOR = {
  flow:    'text-red',
  weather: 'text-mag',
  anomaly: 'text-acc',
  surface: 'text-grn',
  tfr:     'text-org',
}

const SEV_BG = {
  critical: 'bg-red/8 border-l-2 border-l-red',
  high:     'bg-ylw/5 border-l-2 border-l-ylw',
  info:     'border-l-2 border-l-transparent',
}

const TYPE_LABEL = {
  flow:    'FLOW',
  weather: 'WX',
  anomaly: 'ANOM',
  surface: 'OPS',
  tfr:     'TFR',
}

const ALL_TYPES = ['flow', 'weather', 'anomaly', 'surface', 'tfr']

function timeAgo(ts) {
  if (!ts) return ''
  try {
    const t = new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime()
    const sec = Math.round((Date.now() - t) / 1000)
    if (sec < 5) return 'now'
    if (sec < 60) return `${sec}s`
    if (sec < 3600) return `${Math.floor(sec / 60)}m`
    return `${Math.floor(sec / 3600)}h`
  } catch { return '' }
}

export default function LiveFeed({ backendOk }) {
  const [events, setEvents] = useState([])
  const [filter, setFilter] = useState({ flow: true, weather: true, anomaly: true, surface: true, tfr: true })
  const [paused, setPaused] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const newKeysRef = useRef(new Set())
  const seenKeysRef = useRef(new Set())
  const [highlight, setHighlight] = useState(new Set())

  // Poll every 5s
  useEffect(() => {
    if (!backendOk || paused) return
    let cancelled = false
    const refresh = () => {
      axios.get('/api/swim/live-feed', { params: { limit: 80 } })
        .then(r => {
          if (cancelled) return
          const data = r.data || []
          // Detect new events for highlight animation
          const fresh = new Set()
          for (const e of data) {
            const key = `${e.type}:${e.time}:${e.title}`
            if (!seenKeysRef.current.has(key)) {
              fresh.add(key)
              seenKeysRef.current.add(key)
            }
          }
          if (seenKeysRef.current.size > 500) {
            // Trim to prevent unbounded growth
            seenKeysRef.current = new Set(Array.from(seenKeysRef.current).slice(-300))
          }
          setEvents(data)
          setLoaded(true)
          if (fresh.size > 0) {
            newKeysRef.current = fresh
            setHighlight(fresh)
            setTimeout(() => setHighlight(new Set()), 2500)
          }
        })
        .catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk, paused])

  const filtered = events.filter(e => filter[e.type])
  const counts = {}
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col border-l-2 border-l-acc/40">
      {/* Header */}
      <div className="py-0.5 px-2 text-[9px] bg-bg2 border-b border-border flex justify-between items-center shrink-0">
        <span className="ft-chip ft-chip--accent">live feed</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPaused(p => !p)}
            className={clsx('text-[8px] px-1 cursor-pointer', paused ? 'text-ylw' : 'text-fg3 hover:text-fg2')}
            title={paused ? 'resume polling' : 'pause polling'}
          >
            {paused ? '⏸ paused' : '● live'}
          </button>
          <span className="text-fg3/40">{filtered.length}</span>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex gap-px bg-border shrink-0">
        {ALL_TYPES.map(t => (
          <button
            key={t}
            onClick={() => setFilter(f => ({ ...f, [t]: !f[t] }))}
            className={clsx(
              'flex-1 text-[7px] py-0.5 cursor-pointer transition-colors',
              filter[t] ? `bg-bg1 ${TYPE_COLOR[t]} font-bold` : 'bg-bg2 text-fg3/30'
            )}
          >
            {TYPE_LABEL[t]}{counts[t] ? ` ${counts[t]}` : ''}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <SwimWarming fallback={
            !loaded ? (
              <Loading label="awaiting events" />
            ) : (
              <div className="py-3 px-2 text-center text-fg3/50 text-[9px]">
                {events.length === 0 ? 'waiting for events...' : 'no events match filter'}
              </div>
            )
          } />
        ) : filtered.map((e, i) => {
          const key = `${e.type}:${e.time}:${e.title}`
          const isNew = highlight.has(key)
          return (
            <div
              key={`${i}-${key}`}
              className={clsx(
                'flex items-start gap-1 py-0.5 px-2 text-[8px] border-b border-white/3',
                SEV_BG[e.sev] || SEV_BG.info,
                isNew && 'animate-row-arrive'
              )}
            >
              <span className={clsx('font-bold w-7 shrink-0', TYPE_COLOR[e.type])}>
                {TYPE_LABEL[e.type]}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-fg2 truncate">{e.title}</div>
                {e.detail && <div className="text-fg3/60 text-[7px] truncate">{e.detail}</div>}
              </div>
              <span className="text-fg3/40 tabular-nums shrink-0 text-[7px]">{timeAgo(e.time)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
