// ── "Now Showing" feed (v5.7.8) ───────────────────────────────────────────
// Primary surface — the single ranked list of what's worth looking at right
// now. Correlation, anomalies, callsigns, orbits, route deviation, and mil
// flag all feed into the backend score; this component just renders the
// result and lets the user click through to the full inspector.
//
// v5.7.8 — Filter chips. The classifier (backend/context/aircraft.js) tags
// each flight with categories (wide_body / helicopter / business_jet / …)
// and roles (military, news_media, helicopter_news, charter_fractional,
// private_jet, cargo_freighter, airline_commercial, …). The chip strip
// lets the user OR-filter the feed across these dimensions without a
// backend round-trip.

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { fetchInterestingFeed } from '../services/feed'

const REFRESH_MS = 20_000

// Chip catalogue. Each chip declares a `match(item)` predicate so we can
// chip on either a plain tag label OR a derived signal (squawk/orbit/etc.).
// Order matters — left-to-right in the strip. `tone` is a tailwind text
// color used both for the chip label when active and for the chip border
// when inactive but hovered, so the meaning is consistent with the
// row-tag colors.
const CHIPS = [
  { key: 'mil',      label: 'Military',  tone: 'grn',
    match: (it) => it.mil || (it.labels || []).includes('military') },
  { key: 'hos',      label: 'Head of State', tone: 'mag',
    match: (it) => (it.labels || []).includes('head_of_state') },
  { key: 'gov',      label: 'Government', tone: 'cyn',
    match: (it) => (it.labels || []).some(t => t === 'government_civil' || t === 'law_enforcement') },
  { key: 'news',     label: 'News Media', tone: 'mag',
    match: (it) => (it.labels || []).some(t => t === 'news_media' || t === 'helicopter_news') },
  { key: 'ems',      label: 'EMS / Police', tone: 'red',
    match: (it) => (it.labels || []).some(t => t === 'medevac' || t === 'helicopter_ems' || t === 'helicopter_police' || t === 'law_enforcement') },
  { key: 'helo',     label: 'Helicopters', tone: 'ylw',
    match: (it) => it.category === 'helicopter' || it.category === 'military_helo' },
  { key: 'biz',      label: 'Bizjets',   tone: 'acc',
    match: (it) => it.category === 'business_jet' || (it.labels || []).some(t => t === 'private_jet' || t === 'charter_fractional') },
  { key: 'cargo',    label: 'Cargo',     tone: 'cyn',
    match: (it) => (it.labels || []).includes('cargo_freighter') },
  { key: 'airline',  label: 'Airlines',  tone: 'fg2',
    match: (it) => (it.labels || []).some(t => t === 'airline_commercial' || t === 'airline_regional') },
  { key: 'wide',     label: 'Wide-body', tone: 'fg2',
    match: (it) => it.category === 'wide_body' },
  { key: 'anom',     label: 'Anomalies', tone: 'red',
    match: (it) => /^(7500|7600|7700)$/.test(it.squawk || '')
                 || (it.tags || []).some(t => t.source === 'anomaly' || t.source === 'orbit' || t.source === 'route') },
]

// Tailwind needs literal class strings; map tone → active/inactive classes.
const TONE_CLASSES = {
  grn:  { active: 'bg-grn/20 text-grn border-grn/60',  hover: 'hover:border-grn/60 hover:text-grn' },
  mag:  { active: 'bg-mag/20 text-mag border-mag/60',  hover: 'hover:border-mag/60 hover:text-mag' },
  cyn:  { active: 'bg-cyn/20 text-cyn border-cyn/60',  hover: 'hover:border-cyn/60 hover:text-cyn' },
  ylw:  { active: 'bg-ylw/20 text-ylw border-ylw/60',  hover: 'hover:border-ylw/60 hover:text-ylw' },
  red:  { active: 'bg-red/20 text-red border-red/60',  hover: 'hover:border-red/60 hover:text-red' },
  acc:  { active: 'bg-acc/20 text-acc border-acc/60',  hover: 'hover:border-acc/60 hover:text-acc' },
  fg2:  { active: 'bg-fg2/15 text-fg border-fg2/60',   hover: 'hover:border-fg2/60 hover:text-fg' },
}

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

      {/* Primary reason + tags. On mobile, allow the reason to wrap to a
          second line instead of truncating mid-word ("diversion anomaly
          (critic…"). On desktop the natural width is wide enough that
          truncation rarely fires; clamp to 2 lines just in case. */}
      <span className="flex-1 min-w-0 flex flex-col leading-tight">
        <span
          className="text-fg2 text-[11px] sm:truncate"
          style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}
          title={item.primary}
        >
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
  // Set of active chip keys. Empty = no filter (show everything).
  const [activeChips, setActiveChips] = useState(() => new Set())

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

  // Compute per-chip counts from the full item set so the chip strip can
  // show "Military 3" / "News Media 2" — useful at a glance to know which
  // filters will actually return rows. Only chips with > 0 matches render.
  const chipCounts = useMemo(() => {
    const m = new Map()
    for (const c of CHIPS) m.set(c.key, items.filter(c.match).length)
    return m
  }, [items])

  // Apply active chips with OR semantics — show items matching any selected
  // chip. Empty selection = pass-through.
  const filtered = useMemo(() => {
    if (activeChips.size === 0) return items
    return items.filter(item => {
      for (const c of CHIPS) {
        if (activeChips.has(c.key) && c.match(item)) return true
      }
      return false
    })
  }, [items, activeChips])

  const visible = collapsed ? [] : filtered
  const filtersActive = activeChips.size > 0

  const toggleChip = (key) => {
    setActiveChips(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="border-b border-border bg-bg1 shrink-0">
      {/* Header strip */}
      <div className="flex items-center gap-2 px-2.5 py-1 bg-bg2/60 border-b border-border">
        <span className="text-acc text-[10px] uppercase tracking-wide">Now Showing</span>
        <span className="text-fg3 text-[9px] tabular-nums">
          {/* Show data if we have it (even with a transient error from a later
              refresh — the data is still real). Only show 'loading…' when we
              have neither data nor an error yet. The error text renders to
              the right of this span. */}
          {data
            ? filtersActive
              ? `${filtered.length} of ${items.length} shown · ${data.candidatePool} candidates · ${data.totalFlights} total`
              : `${data.ranked} ranked · ${data.candidatePool} candidates · ${data.totalFlights} total`
            : error
              ? '—'
              : 'loading…'}
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

      {/* Filter chip strip — only render chips that match at least one item
          right now, so the strip doesn't bloat with zero-count noise. */}
      {!collapsed && items.length > 0 && (
        <div className="flex items-center gap-1 px-2.5 py-1 bg-bg1 border-b border-border overflow-x-auto whitespace-nowrap">
          <span className="text-fg3 text-[9px] uppercase tracking-wide shrink-0">Filter</span>
          {CHIPS.map(chip => {
            const count = chipCounts.get(chip.key) || 0
            if (count === 0) return null
            const active = activeChips.has(chip.key)
            const tone = TONE_CLASSES[chip.tone] || TONE_CLASSES.fg2
            return (
              <button
                key={chip.key}
                onClick={() => toggleChip(chip.key)}
                className={clsx(
                  'shrink-0 px-1.5 py-0.5 text-[9px] border rounded font-mono cursor-pointer transition-colors',
                  active
                    ? tone.active
                    : `bg-bg2/40 text-fg3 border-border ${tone.hover}`
                )}
                title={`${active ? 'remove' : 'add'} ${chip.label} filter`}
              >
                {chip.label} <span className="opacity-60">{count}</span>
              </button>
            )
          })}
          {filtersActive && (
            <button
              onClick={() => setActiveChips(new Set())}
              className="shrink-0 ml-1 px-1.5 py-0.5 text-[9px] text-fg3 hover:text-fg cursor-pointer"
              title="clear all filters"
            >
              clear ✕
            </button>
          )}
        </div>
      )}

      {/* Feed rows */}
      {!collapsed && (
        <div className="max-h-52 overflow-y-auto">
          {visible.length === 0 && data && (
            <div className="text-fg3/50 text-[10px] py-3 text-center">
              {filtersActive
                ? 'No items match the active filters.'
                : 'Nothing interesting right now — everything looks routine.'}
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
