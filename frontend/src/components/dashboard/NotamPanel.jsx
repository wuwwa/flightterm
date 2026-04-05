import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'

async function fetchSwimStatus() {
  const res = await axios.get('/api/swim/status')
  return res.data
}

async function fetchActiveTfrs() {
  const res = await axios.get('/api/swim/tfrs')
  return res.data
}

async function fetchAirports() {
  const res = await axios.get('/api/swim/notams/airports', { params: { limit: 12 } })
  return res.data
}

async function fetchRecent() {
  const res = await axios.get('/api/swim/notams/recent', { params: { limit: 8 } })
  return res.data
}

const KW_COLORS = {
  RWY: 'text-red',
  TWY: 'text-ylw',
  APRON: 'text-ylw',
  AIRSPACE: 'text-red',
  SVC: 'text-cyn',
  NAV: 'text-cyn',
  OBST: 'text-mag',
}

function Badge({ keyword }) {
  if (!keyword) return null
  return (
    <span className={clsx('text-[8px] border px-0.5 rounded', KW_COLORS[keyword] || 'text-fg3', 'border-current/30')}>
      {keyword}
    </span>
  )
}

export default function NotamPanel({ backendOk }) {
  const [status, setStatus] = useState(null)
  const [tfrs, setTfrs] = useState([])
  const [airports, setAirports] = useState([])
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    setLoading(true)

    const refresh = () => {
      Promise.all([
        fetchSwimStatus().catch(() => null),
        fetchActiveTfrs().catch(() => []),
        fetchAirports().catch(() => []),
        fetchRecent().catch(() => []),
      ]).then(([s, t, a, r]) => {
        if (cancelled) return
        setStatus(s)
        setTfrs(Array.isArray(t) ? t : [])
        setAirports(Array.isArray(a) ? a : [])
        setRecent(Array.isArray(r) ? r : [])
        setLoading(false)
      })
    }

    refresh()
    const id = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const fns = status?.feeds?.fns
  const connected = fns?.connected
  const received = fns?.received || 0

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      {/* Header */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>notams · FAA SWIM</span>
        <span className="flex items-center gap-1.5">
          {fns ? (
            <>
              <span className={clsx(
                'inline-block w-1.5 h-1.5 rounded-full',
                connected ? 'bg-grn' : 'bg-red'
              )} />
              <span className={connected ? 'text-grn' : 'text-red'}>
                {connected ? 'live' : 'disconnected'}
              </span>
              {received > 0 && (
                <span className="text-fg3">{received.toLocaleString()} msgs</span>
              )}
            </>
          ) : loading ? 'loading...' : (
            <span className="text-fg3">not configured</span>
          )}
        </span>
      </div>

      {/* TFR summary */}
      <div className="px-2.5 py-1 flex gap-3 text-[10px]">
        <span className="text-fg3">TFRs:</span>
        {tfrs.length === 0 ? (
          <span className="text-grn">none active</span>
        ) : (
          <span className="text-red font-bold">{tfrs.length} active</span>
        )}
        {airports.length > 0 && (
          <>
            <span className="text-fg3">airports:</span>
            <span className="text-acc">{airports.length} with NOTAMs</span>
          </>
        )}
      </div>

      {/* Active TFRs */}
      {tfrs.length > 0 && (
        <div className="border-t border-border max-h-16 overflow-y-auto">
          {tfrs.slice(0, 3).map((tfr, i) => (
            <div key={tfr.id || i} className="flex gap-2 py-0.5 px-2.5 text-[9px] border-b border-white/3">
              <span className="text-red font-bold shrink-0">TFR</span>
              <span className="text-acc shrink-0">{tfr.location || '—'}</span>
              <span className="text-fg2 truncate flex-1">
                {tfr.text?.substring(0, 60) || 'restriction active'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Affected airports */}
      {airports.length > 0 && (
        <div className="border-t border-border flex-1 min-h-0 overflow-y-auto">
          {airports.map((ap, i) => (
            <div key={ap.location || i} className="flex items-center gap-1.5 py-0.5 px-2.5 text-[9px] border-b border-white/3">
              <span className="text-acc font-bold w-8 shrink-0">{ap.location}</span>
              <span className="text-fg3 w-4 text-right shrink-0">{ap.count}</span>
              <div className="flex gap-1 flex-1 overflow-hidden">
                {ap.rwy > 0 && <Badge keyword="RWY" />}
                {ap.twy > 0 && <Badge keyword="TWY" />}
                {ap.apron > 0 && <Badge keyword="APRON" />}
                {ap.airspace > 0 && <Badge keyword="AIRSPACE" />}
                {ap.svc > 0 && <Badge keyword="SVC" />}
                {ap.obst > 0 && <Badge keyword="OBST" />}
              </div>
              <span className="text-fg3/50 text-[8px] shrink-0">
                {ap.latest?.substring(11, 16)}z
              </span>
            </div>
          ))}
        </div>
      )}

      {/* No data hint */}
      {!fns && !loading && (
        <div className="px-2.5 pb-1.5 text-[9px] text-fg3/60">
          set SWIM_USERNAME + SWIM_PASSWORD in .env to enable
        </div>
      )}
    </div>
  )
}
