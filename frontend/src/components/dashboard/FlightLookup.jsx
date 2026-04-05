import { useState, useEffect, useCallback } from 'react'
import clsx from 'clsx'
import axios from 'axios'

async function fetchFlightPlan(acid) {
  const res = await axios.get(`/api/swim/flights/${acid}`)
  return res.data
}

async function fetchActiveFlights(limit = 30) {
  const res = await axios.get('/api/swim/flights', { params: { limit } })
  return res.data
}

function fmtAlt(alt) {
  if (!alt) return '—'
  const s = String(alt).replace(/C$/, '')
  const n = Number(s)
  if (isNaN(n)) return alt
  return n >= 100 ? `FL${s.replace(/C$/, '')}` : `${n * 100}ft`
}

const STATUS_COLORS = {
  ACTIVE: 'text-grn', ASCENDING: 'text-cyn', CRUISING: 'text-acc',
  DESCENDING: 'text-ylw', COMPLETED: 'text-fg3', FILED: 'text-mag',
  PLANNED: 'text-mag', CANCELLED: 'text-red',
}

export default function FlightLookup({ backendOk }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [flights, setFlights] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    fetchActiveFlights(30).then(setFlights).catch(() => {})
    const id = setInterval(() => fetchActiveFlights(30).then(setFlights).catch(() => {}), 30_000)
    return () => clearInterval(id)
  }, [backendOk])

  const handleSearch = useCallback(async () => {
    const acid = query.trim().toUpperCase()
    if (!acid) return
    setLoading(true)
    setNotFound(false)
    try { setResult(await fetchFlightPlan(acid)) }
    catch { setResult(null); setNotFound(true) }
    setLoading(false)
  }, [query])

  const selectFlight = (acid) => {
    setQuery(acid)
    fetchFlightPlan(acid).then(p => { setResult(p); setNotFound(false) }).catch(() => { setResult(null); setNotFound(true) })
  }

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span>flight lookup · TFMS</span>
        <span>{flights.length} active</span>
      </div>

      {/* Search */}
      <div className="p-1.5 flex gap-1 shrink-0">
        <input
          type="text" value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="callsign"
          className="flex-1 bg-bg2 border border-border text-fg1 text-[10px] px-1.5 py-0.5 rounded outline-none focus:border-acc placeholder:text-fg3/40 min-w-0"
        />
        <button onClick={handleSearch} disabled={loading || !query.trim()}
          className="bg-bg2 border border-border hover:border-acc text-[9px] text-fg3 hover:text-acc px-2 py-0.5 rounded transition-colors disabled:opacity-40">
          {loading ? '...' : 'go'}
        </button>
      </div>

      {/* Search result — compact inline */}
      {result && (
        <div className="bg-bg2/30 border-t border-b border-border px-2.5 py-1 shrink-0 text-[10px]">
          <div className="flex items-center gap-2">
            <span className="text-acc font-bold">{result.acid}</span>
            <span className={clsx('font-bold', STATUS_COLORS[result.flight_status] || 'text-fg3')}>{result.flight_status || '—'}</span>
            <span className="text-fg2">{result.dep_arpt || '?'} → {result.arr_arpt || '?'}</span>
            <span className="text-cyn">{fmtAlt(result.altitude)}</span>
            <span className="text-fg3">{result.speed ? result.speed + 'kt' : ''}</span>
          </div>
          {result.route && (
            <div className="text-[8px] text-fg3 mt-0.5 truncate" title={result.route}>{result.route}</div>
          )}
        </div>
      )}
      {notFound && <div className="px-2.5 py-1 text-[9px] text-fg3 shrink-0">not found</div>}

      {/* Flight list — compact rows */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {flights.map((f, i) => (
          <div key={f.acid || i}
            className={clsx(
              'flex items-center gap-2 py-0.5 px-2.5 text-[10px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors',
              result?.acid === f.acid && 'bg-acc/8'
            )}
            onClick={() => selectFlight(f.acid)}>
            <span className="text-acc font-bold w-16 shrink-0 truncate">{f.acid}</span>
            <span className="text-fg2 w-10 shrink-0">{f.dep_arpt || '—'}</span>
            <span className="text-fg3">→</span>
            <span className="text-fg2 w-10 shrink-0">{f.arr_arpt || '—'}</span>
            <span className="text-cyn text-right w-10 shrink-0 tabular-nums">{fmtAlt(f.altitude)}</span>
            <span className={clsx('ml-auto', STATUS_COLORS[f.flight_status] || 'text-fg3')}>
              {f.flight_status || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
