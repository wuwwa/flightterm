import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import { useSwim } from '../../contexts/SwimContext'
import SwimWarming from '../SwimWarming'

// Color semantics:
//   red    = critical (airspace restrictions, TFRs, life-safety)
//   ylw    = warning  (runway/taxiway closures, service degradation)
//   cyn    = info     (navigation, advisories)
//   mag    = obstacle (categorical, attention-grabbing but not danger)
const KW_COLORS = {
  RWY: 'text-ylw', TWY: 'text-ylw', APRON: 'text-ylw',
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

// Display order: most-disruptive categories first
const KW_ORDER = ['RWY', 'AIRSPACE', 'NAV', 'SVC', 'TWY', 'APRON', 'OBST']

export default function NotamPanel({ backendOk }) {
  const { status, tfrs, notamAirports: airports } = useSwim()
  const [selectedLocation, setSelectedLocation] = useState(null)

  const fns = status?.feeds?.fns
  const connected = fns?.connected
  const totalNotams = airports.reduce((s, a) => s + a.count, 0)

  // Group airports by keyword: { RWY: ['JFK', 'LAX', ...], AIRSPACE: [...] }
  const groups = {}
  for (const ap of airports || []) {
    const apt = (ap.location || '').replace(/^K/, '')
    if (!apt) continue
    if (ap.rwy)      (groups.RWY      = groups.RWY      || new Set()).add(apt)
    if (ap.airspace) (groups.AIRSPACE = groups.AIRSPACE || new Set()).add(apt)
    if (ap.nav)      (groups.NAV      = groups.NAV      || new Set()).add(apt)
    if (ap.svc)      (groups.SVC      = groups.SVC      || new Set()).add(apt)
    if (ap.twy)      (groups.TWY      = groups.TWY      || new Set()).add(apt)
    if (ap.apron)    (groups.APRON    = groups.APRON    || new Set()).add(apt)
    if (ap.obst)     (groups.OBST     = groups.OBST     || new Set()).add(apt)
  }

  const activeGroups = KW_ORDER
    .filter(k => groups[k] && groups[k].size > 0)
    .map(k => ({ kw: k, airports: Array.from(groups[k]).sort() }))

  // Unique TFR locations
  const tfrLocs = Array.from(new Set((tfrs || []).map(t => (t.location || '').replace(/^K/, '')).filter(Boolean))).sort()

  const hasAny = activeGroups.length > 0 || tfrLocs.length > 0

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      {/* Header */}
      <div className="py-0.5 px-2 text-[9px] bg-bg2 border-b border-border flex justify-between items-center shrink-0">
        <span className="ft-chip ft-chip--red">notams + tfrs</span>
        <span className="flex items-center gap-1.5">
          {totalNotams > 0 && <span className="text-fg3">{totalNotams} notices</span>}
          {fns ? (
            <span className={connected ? 'text-grn' : 'text-red'}>{connected ? 'live' : 'off'}</span>
          ) : <span className="text-fg3/40">--</span>}
        </span>
      </div>

      {!hasAny ? (
        <SwimWarming fallback={
          <div className="flex-1 flex items-center justify-center text-[9px] text-grn/70">
            {connected ? 'no active NOTAMs' : 'FNS feed not connected'}
          </div>
        } />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {/* TFRs first — most critical */}
          {tfrLocs.length > 0 && (
            <div className="px-2 py-1 border-b border-red/15 bg-red/3">
              <div className="flex items-baseline gap-1.5 mb-0.5">
                <span className="font-bold text-[10px] uppercase tracking-wide text-red">TFR</span>
                <span className="text-fg3/50 text-[9px] tabular-nums">{tfrLocs.length}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tfrLocs.slice(0, 24).map(apt => (
                  <button
                    key={apt}
                    onClick={() => setSelectedLocation('K' + apt)}
                    className="text-[9px] tabular-nums bg-red/15 hover:bg-red/25 text-red px-1 py-0 rounded cursor-pointer font-bold"
                    title={`view TFRs at ${apt}`}
                  >
                    {apt}
                  </button>
                ))}
                {tfrLocs.length > 24 && (
                  <span className="text-[9px] text-fg3/40 px-1">+{tfrLocs.length - 24}</span>
                )}
              </div>
            </div>
          )}

          {/* NOTAM keyword groups */}
          {activeGroups.map(g => (
            <div key={g.kw} className="px-2 py-1 border-b border-white/3">
              <div className="flex items-baseline gap-1.5 mb-0.5">
                <span className={clsx('font-bold text-[10px] uppercase tracking-wide', KW_COLORS[g.kw] || 'text-fg2')}>
                  {KW_LABELS[g.kw]?.toLowerCase() || g.kw.toLowerCase()}
                </span>
                <span className="text-fg3/50 text-[9px] tabular-nums">{g.airports.length}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {g.airports.slice(0, 24).map(apt => (
                  <button
                    key={apt}
                    onClick={() => setSelectedLocation('K' + apt)}
                    className="text-[9px] tabular-nums bg-bg2 hover:bg-bg2/60 text-fg2 px-1 py-0 rounded cursor-pointer"
                    title={`view NOTAMs at ${apt}`}
                  >
                    {apt}
                  </button>
                ))}
                {g.airports.length > 24 && (
                  <span className="text-[9px] text-fg3/40 px-1">+{g.airports.length - 24}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

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
