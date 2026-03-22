import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchNotams } from '../services/notams'

// Region → airports to query
const REGION_AIRPORTS = {
  usa:      ['KJFK', 'KLAX', 'KORD', 'KATL', 'KDFW', 'KDEN', 'KSFO', 'KMIA', 'KSEA', 'KEWR'],
  europe:   ['EGLL', 'LFPG', 'EDDF', 'EHAM', 'LEMD', 'LIRF', 'LSZH', 'EIDW', 'EKCH', 'ENGM'],
  asia:     ['RJTT', 'VHHH', 'WSSS', 'RKSI', 'VTBS', 'RPLL', 'VIDP', 'ZBAA', 'ZSPD', 'WMKK'],
  atlantic: ['KJFK', 'EGLL', 'LFPG', 'KEWR', 'KBOS', 'BIKF', 'LPPT', 'LEMD'],
}

function fmtDate(s) {
  if (!s) return '—'
  try {
    const d = new Date(s)
    return `${d.toISOString().substring(5, 10)} ${d.toISOString().substring(11, 16)}z`
  } catch { return s }
}

// Classify NOTAM text for color coding
function notamSeverity(text) {
  if (!text) return 'info'
  const t = text.toUpperCase()
  if (t.includes('CLSD') || t.includes('CLOSED') || t.includes('OUT OF SERVICE') || t.includes('INOP')) return 'warn'
  if (t.includes('HAZARD') || t.includes('DANGER') || t.includes('EMERGENCY') || t.includes('TFR')) return 'err'
  if (t.includes('RWY') || t.includes('TWY') || t.includes('APRON')) return 'ops'
  return 'info'
}

function NotamItem({ notam }) {
  const [expanded, setExpanded] = useState(false)
  const severity = notamSeverity(notam.text)

  return (
    <div
      className={clsx(
        'border-b border-white/5 cursor-pointer',
        severity === 'err' && 'border-l-2 border-l-red bg-red/5',
        severity === 'warn' && 'border-l-2 border-l-ylw bg-ylw/5',
        severity === 'ops' && 'border-l-2 border-l-cyn',
      )}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="py-1 px-2.5 flex items-start gap-2">
        <span className={clsx(
          'text-[10px] shrink-0 mt-0.5',
          severity === 'err' ? 'text-red' : severity === 'warn' ? 'text-ylw' : severity === 'ops' ? 'text-cyn' : 'text-fg3'
        )}>
          {severity === 'err' ? '!' : severity === 'warn' ? '~' : '·'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-acc">{notam.number || notam.id}</span>
            <span className="text-fg3">{notam.location}</span>
            <span className="text-fg3 ml-auto shrink-0">{fmtDate(notam.effectiveStart)}</span>
          </div>
          <div className={clsx('text-[10px] text-fg2 mt-0.5', !expanded && 'line-clamp-2')}>
            {notam.text || '(no text)'}
          </div>
          {expanded && (
            <div className="text-[9px] text-fg3 mt-1 flex gap-3">
              <span>eff: {fmtDate(notam.effectiveStart)}</span>
              <span>exp: {fmtDate(notam.effectiveEnd)}</span>
              <span>type: {notam.type || '—'}</span>
              <span>{notam.classification || ''}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function NotamPanel({ region, onClose }) {
  const [notams, setNotams] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeAirport, setActiveAirport] = useState(null)

  const airports = REGION_AIRPORTS[region] || REGION_AIRPORTS.usa

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchNotams(airports)
      .then(data => {
        setNotams(data.notams || {})
        // auto-select first airport with NOTAMs
        const first = airports.find(c => (data.notams?.[c] || []).length > 0)
        setActiveAirport(first || airports[0])
      })
      .catch(err => {
        setError(err.response?.data?.error || err.message)
      })
      .finally(() => setLoading(false))
  }, [region])

  const activeNotams = activeAirport ? (notams[activeAirport] || []) : []
  const totalCount = Object.values(notams).reduce((sum, arr) => sum + arr.length, 0)

  return (
    <div className="fixed inset-0 bg-black/72 z-100 flex items-center justify-center" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-bg1 border border-border2 w-160 max-w-[95vw] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="bg-bg2 border-b border-border py-1.5 px-3 flex justify-between items-center text-[11px] text-fg2 shrink-0">
          <span className="flex items-center gap-2">
            <span className="text-acc">NOTAMs</span>
            <span className="text-fg3">— {region}</span>
            {!loading && <span className="text-fg3">{totalCount} notices</span>}
          </span>
          <button className="bg-transparent border-none text-fg3 text-[11px] cursor-pointer" onClick={onClose}>✕</button>
        </div>

        {/* Airport tabs */}
        <div className="bg-bg2 border-b border-border px-2 py-1 flex gap-0.5 overflow-x-auto shrink-0">
          {airports.map(code => {
            const count = (notams[code] || []).length
            const isActive = code === activeAirport
            return (
              <button
                key={code}
                className={clsx(
                  'text-[10px] font-mono px-2 py-0.5 cursor-pointer border rounded-sm whitespace-nowrap',
                  isActive
                    ? 'bg-acc/15 border-acc/40 text-acc'
                    : count > 0
                      ? 'bg-transparent border-border text-fg2 hover:text-acc hover:border-acc/30'
                      : 'bg-transparent border-border text-fg3 hover:text-fg2'
                )}
                onClick={() => setActiveAirport(code)}
              >
                {code.replace(/^K/, '')}
                {count > 0 && <span className="ml-1 text-[9px] text-fg3">({count})</span>}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="p-8 text-center text-fg3 text-[11px]">fetching NOTAMs...</div>
          ) : error ? (
            <div className="p-8 text-center text-red text-[11px]">{error}</div>
          ) : activeNotams.length === 0 ? (
            <div className="p-8 text-center text-fg3 text-[11px]">no active NOTAMs for {activeAirport}</div>
          ) : (
            activeNotams.map((n, i) => <NotamItem key={n.id || i} notam={n} />)
          )}
        </div>

        {/* Footer */}
        <div className="bg-bg2 border-t border-border py-1 px-3 text-[10px] text-fg3 shrink-0 flex justify-between">
          <span>source: FAA NOTAM API</span>
          <span>cached 15 min</span>
        </div>
      </div>
    </div>
  )
}
