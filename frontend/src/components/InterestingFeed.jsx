// ── Ranked signal feed ──────────────────────────────────────────────────────
// A focused secondary workspace for flights worth investigating. Correlation,
// anomalies, callsigns, orbits, route deviation, and military status feed the
// score; this component only presents the ranked result and opens the record.

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { fetchInterestingFeed } from '../services/feed'

const REFRESH_MS = 20_000

function scoreTone(score) {
  if (score >= 85) return 'text-red'
  if (score >= 65) return 'text-ylw'
  return 'text-fg2'
}

function signalLabel(value) {
  if (!value) return 'No ranked reason retained'
  return String(value)
    .replace(/[_:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())
    .trim()
}

function isMilitarySignal(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'military' || normalized === 'mil'
}

function Row({ item, selected, onClick, showMilitary }) {
  const primary = signalLabel(item.primary)
  const additionalSignals = new Set((item.tags || [])
    .map(tag => signalLabel(tag.label))
    .filter(label => label !== primary))
    .size
  return (
    <button
      onClick={onClick}
      className={clsx(
        'priority-row',
        selected && 'is-selected'
      )}
    >
      {/* Score badge */}
      <span className={clsx(
        'priority-score',
        scoreTone(item.score)
      )} title={`Signal score ${item.score}`} aria-label={`Signal score ${item.score}`}>
        {item.score}
      </span>

      {/* Callsign + type */}
      <span className="priority-flight">
        <span className="priority-callsign">{item.callsign || item.icao}</span>
        <span className="priority-type">
          {item.acType || ''}{showMilitary && item.mil ? ' · MIL' : ''}
        </span>
      </span>

      {/* Primary reason + tags */}
      <span className="flex-1 min-w-0 flex flex-col leading-tight">
        <span className="priority-reason" title={item.primary}>
          {primary}
        </span>
        {additionalSignals > 0 && <span className="priority-tag-count" title={`${additionalSignals} additional signal${additionalSignals === 1 ? '' : 's'}`}>+{additionalSignals}</span>}
      </span>

      {/* Altitude / speed */}
      <span className="priority-vitals">
        <span className="text-fg2">{item.altFt != null ? `${item.altFt.toLocaleString()}ft` : '—'}</span>
        <span className="text-fg3">{item.velKt != null ? `${item.velKt}kt` : '—'}</span>
      </span>
    </button>
  )
}

export default function InterestingFeed({ selectedIcao, onSelect, onClose, flights, backendOk, showMilitary = false }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  useEffect(() => {
    if (!backendOk) { setError('Backend unavailable'); return }
    let cancelled = false
    const refresh = async () => {
      try {
        const d = await fetchInterestingFeed({ limit: 20 })
        if (!cancelled) { setData(d); setError(null); setLastUpdated(d.generatedAt || Date.now()) }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message)
      }
    }
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const allItems = data?.items || []
  const items = showMilitary ? allItems : allItems.filter(item => !isMilitarySignal(item.primary))

  return (
    <div className="priority-panel">
      {/* Header strip */}
      <div className="section-heading">
        <div>
          <h2>Signals</h2>
        </div>
        <span className="section-heading__meta">
          {error ? (data ? 'Delayed' : 'Unavailable') : data ? `${items.length} of ${data.ranked}` : 'Loading'}
        </span>
        {lastUpdated && <span className="section-heading__meta">{new Date(lastUpdated).toISOString().substring(11, 16)}z</span>}
        {onClose && <button className="section-heading__action" onClick={onClose} aria-label="Close signal queue">Close</button>}
      </div>

      <div className="priority-columns" aria-hidden="true">
        <span>Score</span><span>Flight</span><span>Reason</span><span>Alt · speed</span>
      </div>

      {/* Feed rows */}
      <div className="priority-list">
          {error && (
            <div className="priority-availability" role="status">
              {data ? 'Ranking delayed' : 'Signals unavailable'}
            </div>
          )}
          {items.length === 0 && data && !error && (
            <div className="priority-empty">
              No signals in the current ranking.
            </div>
          )}
          {items.map(item => {
            // Click resolves to the full flight record from the primary flights list
            // (InterestingFeed items are a trimmed projection for display).
            const onRowClick = () => {
              const full = (flights || []).find(f => f.icao === item.icao)
              if (full) onSelect?.(full, item)
              else onSelect?.(item, item)  // fall back to the projection
            }
            return (
              <Row
                key={item.icao}
                item={item}
                selected={selectedIcao === item.icao}
                onClick={onRowClick}
                showMilitary={showMilitary}
              />
            )
          })}
      </div>
    </div>
  )
}
