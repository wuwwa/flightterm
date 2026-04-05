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
  if (n >= 100) return `FL${s.replace(/C$/, '')}`
  return `${n * 100} ft`
}

function fmtCoord(lat, lon) {
  if (lat == null || lon == null) return '—'
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`
}

function fmtTime(iso) {
  if (!iso) return '—'
  return iso.substring(11, 16) + 'z'
}

const STATUS_COLORS = {
  ACTIVE: 'text-grn',
  ASCENDING: 'text-cyn',
  CRUISING: 'text-acc',
  DESCENDING: 'text-ylw',
  COMPLETED: 'text-fg3',
  FILED: 'text-mag',
  PLANNED: 'text-mag',
  SCHEDULED: 'text-fg3',
  CANCELLED: 'text-red',
}

export default function FlightLookup({ backendOk }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [flights, setFlights] = useState([])
  const [loading, setLoading] = useState(false)

  // Load recent active flights on mount
  useEffect(() => {
    if (!backendOk) return
    fetchActiveFlights(30).then(setFlights).catch(() => {})
    const id = setInterval(() => {
      fetchActiveFlights(30).then(setFlights).catch(() => {})
    }, 30_000)
    return () => clearInterval(id)
  }, [backendOk])

  const handleSearch = useCallback(async () => {
    const acid = query.trim().toUpperCase()
    if (!acid) return
    setLoading(true)
    setNotFound(false)
    try {
      const plan = await fetchFlightPlan(acid)
      setResult(plan)
      setNotFound(false)
    } catch {
      setResult(null)
      setNotFound(true)
    }
    setLoading(false)
  }, [query])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch()
  }

  const selectFlight = (acid) => {
    setQuery(acid)
    fetchFlightPlan(acid).then(p => { setResult(p); setNotFound(false) }).catch(() => { setResult(null); setNotFound(true) })
  }

  return (
    <div className="bg-border">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>flight lookup · TFMS</span>
        <span className="text-fg3">{flights.length} active</span>
      </div>

      {/* Search bar */}
      <div className="bg-bg1 p-2 flex gap-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          placeholder="callsign (e.g. UAL1752)"
          className="flex-1 bg-bg2 border border-border text-fg1 text-[11px] px-2 py-1 rounded outline-none focus:border-acc placeholder:text-fg3/40"
        />
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="bg-bg2 border border-border hover:border-acc text-[10px] text-fg3 hover:text-acc px-3 py-1 rounded transition-colors disabled:opacity-40"
        >
          {loading ? '...' : 'search'}
        </button>
      </div>

      {/* Search result */}
      {result && (
        <div className="bg-bg1 border-t border-border p-2">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-acc text-[13px] font-bold">{result.acid}</span>
            <span className={clsx('text-[10px] font-bold', STATUS_COLORS[result.flight_status] || 'text-fg3')}>
              {result.flight_status || '—'}
            </span>
            {result.aircraft_type && <span className="text-fg3 text-[9px]">{result.aircraft_type}</span>}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
            <div className="flex justify-between">
              <span className="text-fg3">from</span>
              <span className="text-acc font-bold">{result.dep_arpt || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg3">to</span>
              <span className="text-acc font-bold">{result.arr_arpt || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg3">altitude</span>
              <span className="text-cyn">{fmtAlt(result.altitude)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg3">speed</span>
              <span className="text-cyn">{result.speed ? `${result.speed} kt` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg3">position</span>
              <span className="text-fg2">{fmtCoord(result.lat, result.lon)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg3">ETA</span>
              <span className="text-fg2">{fmtTime(result.eta)}</span>
            </div>
            {result.beacon_code && (
              <div className="flex justify-between">
                <span className="text-fg3">squawk</span>
                <span className={clsx(
                  result.beacon_code === '7700' || result.beacon_code === '7500' || result.beacon_code === '7600' ? 'text-red font-bold' : 'text-fg2'
                )}>{result.beacon_code}</span>
              </div>
            )}
            {result.route && (
              <div className="flex justify-between col-span-2">
                <span className="text-fg3">route</span>
                <span className="text-fg2 text-[9px] truncate max-w-[200px]" title={result.route}>{result.route}</span>
              </div>
            )}
          </div>
          <div className="text-[8px] text-fg3/40 mt-1">
            updated {result.updated_at?.substring(11, 19)}z · msg: {result.msg_type || '—'}
          </div>
        </div>
      )}

      {notFound && (
        <div className="bg-bg1 border-t border-border py-2 px-2.5 text-[10px] text-fg3">
          no flight plan found for "{query}"
        </div>
      )}

      {/* Active flights list */}
      <div className="border-t border-border max-h-[240px] overflow-y-auto">
        <div className="grid grid-cols-[70px_55px_25px_55px_40px_40px_1fr] gap-1 py-0.5 px-2.5 text-[8px] text-fg3 bg-bg2/50 border-b border-white/5 sticky top-0">
          <span>callsign</span>
          <span>from</span>
          <span></span>
          <span>to</span>
          <span className="text-right">alt</span>
          <span className="text-right">spd</span>
          <span className="text-right">status</span>
        </div>
        {flights.map((f, i) => (
          <div
            key={f.acid || i}
            className={clsx(
              'grid grid-cols-[70px_55px_25px_55px_40px_40px_1fr] gap-1 py-0.5 px-2.5 text-[10px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors',
              result?.acid === f.acid && 'bg-acc/8'
            )}
            onClick={() => selectFlight(f.acid)}
          >
            <span className="text-acc font-bold truncate">{f.acid}</span>
            <span className="text-fg2">{f.dep_arpt || '—'}</span>
            <span className="text-fg3">→</span>
            <span className="text-fg2">{f.arr_arpt || '—'}</span>
            <span className="text-cyn text-right tabular-nums">{fmtAlt(f.altitude)}</span>
            <span className="text-fg3 text-right tabular-nums">{f.speed || '—'}</span>
            <span className={clsx('text-right', STATUS_COLORS[f.flight_status] || 'text-fg3')}>
              {f.flight_status || '—'}
            </span>
          </div>
        ))}
        {flights.length === 0 && (
          <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">
            {backendOk ? 'no active flights — TFMS data loading...' : 'backend offline'}
          </div>
        )}
      </div>
    </div>
  )
}
