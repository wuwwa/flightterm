// ── Group Dossier — v5.7.0 ──────────────────────────────────────────────────
// Aggregate view for a subset of planes. URL-addressable at #group=<kind>:<id>.
// Mirrors FlightDossier's tile layout but aggregates rather than drilling into
// a single aircraft. Refreshes every 20s to stay in sync with the backend
// memoized /api/groups/:groupId endpoint.

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { fetchGroup } from '../services/flight'

const KIND_ACCENT = {
  airline: 'text-cyn',
  family:  'text-ylw',
  class:   'text-ylw',
  role:    'text-grn',
  gov:     'text-red',
  entity:  'text-mag',
}

function Tile({ title, accent, children, wide }) {
  return (
    <div className={clsx(
      'bg-bg2/40 border border-border rounded p-2.5 flex flex-col min-h-0',
      wide && 'md:col-span-2 xl:col-span-3',
    )}>
      <div className={clsx(
        'text-[10px] uppercase tracking-wide mb-1.5 pb-1 border-b border-border flex items-center justify-between',
        accent || 'text-fg2',
      )}>
        <span>{title}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto no-scrollbar">
        {children}
      </div>
    </div>
  )
}

function BarRow({ id, n, maxN, label, href }) {
  const pct = maxN > 0 ? Math.round((n / maxN) * 100) : 0
  const inner = (
    <div className="flex items-center gap-1.5 text-[11px] py-0.5 border-b border-white/3 last:border-b-0">
      <span className="font-mono text-ylw truncate shrink-0 w-16">{label || id}</span>
      <div className="flex-1 bg-bg2/50 rounded-sm h-1.5 overflow-hidden min-w-0">
        <div className="h-full bg-acc/60" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-fg3 tabular-nums w-10 text-right shrink-0">{n}</span>
    </div>
  )
  if (href) return <a href={href} className="block hover:bg-bg2/50 rounded px-1">{inner}</a>
  return inner
}

function FlightRow({ f }) {
  const dep = f.tfms?.dep_arpt
  const arr = f.tfms?.arr_arpt
  const href = `#flight=${f.icao}${f.callsign ? '&cs=' + encodeURIComponent(f.callsign) : ''}`
  return (
    <a
      href={href}
      className="flex items-baseline gap-2 text-[11px] py-0.5 border-b border-white/3 last:border-b-0 hover:bg-bg2/50 rounded px-1"
    >
      <span className="font-mono text-ylw w-16 shrink-0 truncate">{f.callsign || f.icao}</span>
      <span className="text-fg3 w-12 shrink-0 truncate">{f.acType || '—'}</span>
      <span className="text-fg3 tabular-nums w-14 shrink-0 text-right">
        {f.altFt != null ? `${f.altFt.toLocaleString()}ft` : '—'}
      </span>
      <span className="text-fg3 tabular-nums w-10 shrink-0 text-right">
        {f.velKt != null ? `${f.velKt}kt` : ''}
      </span>
      <span className="text-fg3 truncate flex-1 text-right">
        {dep && arr ? `${dep}→${arr}` : ''}
      </span>
    </a>
  )
}

export default function GroupDossier({ groupId, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        setError(null)
        const d = await fetchGroup(groupId, 100)
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.error || e.message)
          setLoading(false)
        }
      }
    }
    load()
    const id = setInterval(load, 20_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [groupId])

  if (!groupId) return null

  const kind = groupId.split(':')[0]
  const accent = KIND_ACCENT[kind] || 'text-fg2'

  return (
    <div className="fixed inset-0 z-[1000] bg-bg1 flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-3 py-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className={clsx('text-[10px] uppercase tracking-wide', accent)}>{kind}</span>
          <span className="font-mono text-fg text-sm">{data?.label || groupId}</span>
          {data && (
            <span className="text-fg3 text-[11px]">
              {data.count} flights — {data.airborne} airborne / {data.grounded} on ground
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-fg3 hover:text-fg text-lg cursor-pointer px-2"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {loading && <div className="flex-1 flex items-center justify-center text-fg3 text-[11px]">loading…</div>}
      {error && <div className="flex-1 flex items-center justify-center text-red text-[11px]">{error}</div>}

      {data && !loading && !error && (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 p-2 overflow-auto min-h-0">
          <Tile title="Aircraft types" accent={accent}>
            {data.types.length === 0 && <div className="text-fg3 text-[11px]">no type data</div>}
            {(() => {
              const max = data.types[0]?.n || 0
              return data.types.map(t => (
                <BarRow key={t.id} id={t.id} n={t.n} maxN={max} label={t.id} />
              ))
            })()}
          </Tile>

          <Tile title="Top departures" accent={accent}>
            {data.topDep.length === 0 && <div className="text-fg3 text-[11px]">no flight-plan data in current window</div>}
            {(() => {
              const max = data.topDep[0]?.n || 0
              return data.topDep.map(a => (
                <BarRow key={a.id} id={a.id} n={a.n} maxN={max} label={a.id} />
              ))
            })()}
          </Tile>

          <Tile title="Top arrivals" accent={accent}>
            {data.topArr.length === 0 && <div className="text-fg3 text-[11px]">no flight-plan data in current window</div>}
            {(() => {
              const max = data.topArr[0]?.n || 0
              return data.topArr.map(a => (
                <BarRow key={a.id} id={a.id} n={a.n} maxN={max} label={a.id} />
              ))
            })()}
          </Tile>

          <Tile title={`Flights (${data.flights.length})`} accent={accent} wide>
            {data.flights.length === 0 && <div className="text-fg3 text-[11px]">no matching flights</div>}
            {data.flights.map(f => <FlightRow key={f.icao} f={f} />)}
          </Tile>
        </div>
      )}
    </div>
  )
}
