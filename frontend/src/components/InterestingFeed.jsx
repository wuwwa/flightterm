// ── "Now Showing" feed (v5.2.0) ───────────────────────────────────────────
// Primary surface — the single ranked list of what's worth looking at right
// now. Correlation, anomalies, callsigns, orbits, route deviation, and mil
// flag all feed into the backend score; this component just renders the
// result and lets the user click through to the full inspector.

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { fetchInterestingFeed } from '../services/feed'

const REFRESH_MS = 20_000

function scoreTone(score) {
  if (score >= 100) return 'bg-red/30 text-red border-red/60'
  if (score >= 60)  return 'bg-red/15 text-red border-red/40'
  if (score >= 40)  return 'bg-ylw/15 text-ylw border-ylw/40'
  if (score >= 25)  return 'bg-acc/15 text-acc border-acc/40'
  return 'bg-bg2 text-fg3 border-border'
}

function tagTone(source) {
  return source === 'squawk'   ? 'text-red'
       : source === 'anomaly'  ? 'text-red'
       : source === 'callsign' ? 'text-mag'
       : source === 'orbit'    ? 'text-ylw'
       : source === 'route'    ? 'text-cyn'
       : source === 'mil'      ? 'text-grn'
       : 'text-fg3'
}

function Row({ item, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full flex items-center gap-2 px-2 py-1 border-b border-border text-left cursor-pointer transition-colors',
        selected ? 'bg-acc/10' : 'hover:bg-bg2/60'
      )}
    >
      {/* Score badge */}
      <span className={clsx(
        'shrink-0 inline-flex items-center justify-center w-9 h-6 text-[10px] tabular-nums border rounded font-mono',
        scoreTone(item.score)
      )}>
        {item.score}
      </span>

      {/* Callsign + type */}
      <span className="shrink-0 w-24 flex flex-col leading-tight">
        <span className="text-ylw text-[11px] font-mono">{item.callsign || item.icao}</span>
        <span className="text-fg3 text-[8px] tabular-nums">
          {item.acType || ''}{item.mil ? ' · MIL' : ''}
        </span>
      </span>

      {/* Primary reason + tags */}
      <span className="flex-1 min-w-0 flex flex-col leading-tight">
        <span className="text-fg2 text-[11px] truncate" title={item.primary}>
          {item.primary || '—'}
        </span>
        <span className="text-[9px] flex gap-1.5 overflow-hidden whitespace-nowrap">
          {(item.tags || []).slice(0, 4).map((t, i) => (
            <span key={i} className={tagTone(t.source)} title={`+${t.weight} from ${t.source}`}>
              {t.label}
            </span>
          ))}
        </span>
      </span>

      {/* Altitude / speed */}
      <span className="shrink-0 flex flex-col text-right leading-tight text-[9px] tabular-nums">
        <span className="text-cyn">{item.altFt != null ? `${item.altFt.toLocaleString()}ft` : '—'}</span>
        <span className="text-fg3">{item.velKt != null ? `${item.velKt}kt` : '—'}</span>
      </span>
    </button>
  )
}

export default function InterestingFeed({ selectedIcao, onSelect, flights, backendOk }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    const refresh = async () => {
      try {
        const d = await fetchInterestingFeed({ limit: 20 })
        if (!cancelled) { setData(d); setError(null) }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message)
      }
    }
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const items = data?.items || []
  const visible = collapsed ? [] : items

  return (
    <div className="border-b border-border bg-bg1 shrink-0">
      {/* Header strip */}
      <div className="flex items-center gap-2 px-2.5 py-1 bg-bg2/60 border-b border-border">
        <span className="text-acc text-[10px] uppercase tracking-wide">Now Showing</span>
        <span className="text-fg3 text-[9px] tabular-nums">
          {data ? `${data.ranked} ranked · ${data.candidatePool} candidates · ${data.totalFlights} total` : 'loading…'}
        </span>
        {error && <span className="text-red text-[9px]">{error}</span>}
        <span className="flex-1" />
        <button
          className="text-fg3 hover:text-fg text-[10px] cursor-pointer"
          onClick={() => setCollapsed(v => !v)}
          title={collapsed ? 'expand' : 'collapse'}
        >
          {collapsed ? `▸ show ${items.length}` : '▾ hide'}
        </button>
      </div>

      {/* Feed rows */}
      {!collapsed && (
        <div className="max-h-52 overflow-y-auto">
          {visible.length === 0 && data && (
            <div className="text-fg3/50 text-[10px] py-3 text-center">
              Nothing interesting right now — everything looks routine.
            </div>
          )}
          {visible.map(item => {
            // Click resolves to the full flight record from the primary flights list
            // (InterestingFeed items are a trimmed projection for display).
            const onRowClick = () => {
              const full = (flights || []).find(f => f.icao === item.icao)
              if (full) onSelect?.(full)
              else onSelect?.(item)  // fall back to the projection
            }
            return (
              <Row
                key={item.icao}
                item={item}
                selected={selectedIcao === item.icao}
                onClick={onRowClick}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
