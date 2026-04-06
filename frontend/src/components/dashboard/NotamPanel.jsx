import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import { useSwim } from '../../contexts/SwimContext'

const KW_COLORS = {
  RWY: 'text-red', TWY: 'text-ylw', APRON: 'text-ylw',
  AIRSPACE: 'text-red', SVC: 'text-cyn', NAV: 'text-cyn', OBST: 'text-mag',
}

const KW_LABELS = {
  RWY: 'Runway', TWY: 'Taxiway', APRON: 'Apron/Ramp',
  AIRSPACE: 'Airspace', SVC: 'Service', NAV: 'Navigation', OBST: 'Obstacle',
}

function timeLabel(iso) {
  if (!iso) return null
  try {
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'))
    return d.toISOString().substring(5, 16).replace('T', ' ') + 'z'
  } catch { return null }
}

// ── NOTAM detail popup ──────────────────────────────────────────────────────

function NotamPopup({ location, onClose }) {
  const [notams, setNotams] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`/api/swim/notams/${encodeURIComponent(location)}`)
      .then(r => setNotams(r.data))
      .catch(() => setNotams([]))
      .finally(() => setLoading(false))
  }, [location])

  return (
    <div className="fixed inset-0 z-10000 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg1 border border-border rounded-lg shadow-xl w-full max-w-xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-bg2 border-b border-border rounded-t-lg shrink-0">
          <div>
            <span className="text-acc font-bold text-sm">{location}</span>
            <span className="text-fg3 text-[10px] ml-2">
              {notams ? `${notams.length} active NOTAM${notams.length !== 1 ? 's' : ''}` : ''}
            </span>
          </div>
          <button className="text-fg3 hover:text-fg text-sm px-2 cursor-pointer" onClick={onClose}>✕</button>
        </div>

        {/* NOTAM list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <div className="py-8 flex flex-col items-center justify-center gap-2">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
          )}
          {notams && notams.length === 0 && (
            <div className="py-8 text-center text-fg3 text-[11px]">No active NOTAMs for {location}</div>
          )}
          {notams && notams.map((n, i) => (
            <div key={n.id || i} className={clsx('px-3 py-2 border-b border-white/5', n.is_tfr && 'bg-red/5')}>
              {/* NOTAM header row */}
              <div className="flex items-center gap-2 text-[10px] mb-0.5">
                {n.is_tfr ? (
                  <span className="text-red font-bold">TFR</span>
                ) : n.keyword ? (
                  <span className={clsx('font-bold', KW_COLORS[n.keyword] || 'text-fg3')}>
                    {KW_LABELS[n.keyword] || n.keyword}
                  </span>
                ) : (
                  <span className="text-fg3">General</span>
                )}
                {n.classification && <span className="text-fg3/60">{n.classification}</span>}
                <span className="ml-auto text-fg3/50 text-[9px]">
                  {n.effective && <span>eff {timeLabel(n.effective)}</span>}
                  {n.expiration ? <span> — exp {timeLabel(n.expiration)}</span> : n.permanent ? <span> — PERM</span> : null}
                </span>
              </div>
              {/* NOTAM text */}
              <div className="text-[10px] text-fg2 font-mono leading-relaxed whitespace-pre-wrap wrap-break-word">
                {n.text || n.full_text || '(no text available)'}
              </div>
              {/* Altitude info for TFRs */}
              {n.is_tfr && (n.alt_lower != null || n.alt_upper != null) && (
                <div className="text-[9px] text-fg3 mt-0.5">
                  {n.alt_lower != null && <span>Floor: {n.alt_lower}ft </span>}
                  {n.alt_upper != null && <span>Ceiling: {n.alt_upper}ft</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main NotamPanel ─────────────────────────────────────────────────────────

export default function NotamPanel({ backendOk }) {
  const { status, tfrs, notamAirports: airports } = useSwim()
  const [selectedLocation, setSelectedLocation] = useState(null)

  const fns = status?.feeds?.fns
  const connected = fns?.connected
  const totalNotams = airports.reduce((s, a) => s + a.count, 0)

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      {/* Header */}
      <div className="py-0.5 px-2 text-[9px] bg-bg2 border-b border-border flex justify-between items-center shrink-0">
        <span className="text-fg3">NOTAMs & TFRs</span>
        <span className="flex items-center gap-1.5">
          {totalNotams > 0 && <span className="text-fg3">{totalNotams} notices</span>}
          {fns ? (
            <span className={connected ? 'text-grn' : 'text-red'}>{connected ? 'live' : 'off'}</span>
          ) : <span className="text-fg3/40">--</span>}
        </span>
      </div>

      {/* TFR summary if any active */}
      {tfrs.length > 0 && (
        <div className="px-2 py-0.5 bg-red/5 border-b border-red/15 shrink-0">
          <span className="text-red text-[9px] font-bold">{tfrs.length} TFR{tfrs.length !== 1 ? 's' : ''} active</span>
          <span className="text-fg3 text-[8px] ml-1">— temporary flight restrictions</span>
        </div>
      )}

      {/* Single scrollable list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* TFR entries */}
        {tfrs.slice(0, 5).map((tfr, i) => (
          <div
            key={tfr.id || `tfr-${i}`}
            className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-red/10 bg-red/3 cursor-pointer hover:bg-red/8"
            title={tfr.text || 'Click to view details'}
            onClick={() => tfr.location && setSelectedLocation(tfr.location)}
          >
            <span className="text-red font-bold shrink-0 w-6">TFR</span>
            <span className="text-acc font-bold shrink-0">{tfr.location || '—'}</span>
            <span className="text-fg2 truncate flex-1">{tfr.text?.substring(0, 60) || 'Restriction active'}</span>
          </div>
        ))}

        {/* Airport NOTAM entries */}
        {airports.map((ap, i) => {
          const issues = []
          if (ap.rwy) issues.push({ kw: 'RWY', n: ap.rwy })
          if (ap.airspace) issues.push({ kw: 'AIRSPACE', n: ap.airspace })
          if (ap.svc) issues.push({ kw: 'SVC', n: ap.svc })
          if (ap.twy) issues.push({ kw: 'TWY', n: ap.twy })
          if (ap.obst) issues.push({ kw: 'OBST', n: ap.obst })
          if (ap.apron) issues.push({ kw: 'APRON', n: ap.apron })
          const remainder = ap.count - issues.reduce((s, x) => s + x.n, 0)

          return (
            <div
              key={ap.location || i}
              className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer hover:bg-bg2"
              title={`Click to view ${ap.count} NOTAMs for ${ap.location}`}
              onClick={() => setSelectedLocation(ap.location)}
            >
              <span className="text-acc font-bold w-7 shrink-0">{ap.location}</span>
              <span className="text-fg3 w-3 text-right shrink-0">{ap.count}</span>
              <div className="flex gap-1 flex-1 overflow-hidden text-[7px]">
                {issues.map(x => (
                  <span key={x.kw} className={clsx(KW_COLORS[x.kw] || 'text-fg3')}>
                    {x.n}{x.kw}
                  </span>
                ))}
                {remainder > 0 && <span className="text-fg3">+{remainder}</span>}
              </div>
            </div>
          )
        })}

        {airports.length === 0 && tfrs.length === 0 && connected && (
          <div className="py-1.5 px-2 text-[8px] text-grn/80">No active NOTAMs</div>
        )}
        {!connected && airports.length === 0 && (
          <div className="py-1.5 px-2 text-[8px] text-fg3/50">FNS feed not connected</div>
        )}
      </div>

      {/* NOTAM detail popup */}
      {selectedLocation && (
        <NotamPopup
          location={selectedLocation}
          onClose={() => setSelectedLocation(null)}
        />
      )}
    </div>
  )
}
