import { useState, useMemo, useRef, useEffect } from 'react'
import clsx from 'clsx'
import { squawkLabel, squawkColor } from '../utils/squawk'
import { detectPhase, PHASE } from '../utils/anomaly'

const COLS = [
  { key: 'icao',     label: 'icao24' },
  { key: 'callsign', label: 'callsign' },
  { key: 'type',     label: 'type', hideMobile: true },
  { key: 'reg',      label: 'reg', hideMobile: true },
  { key: 'country',  label: 'ctry', hideMobile: true },
  { key: 'pos',      label: 'pos', hideMobile: true },
  { key: 'alt',      label: 'alt (m)' },
  { key: 'vrate',    label: 'vrate', hideMobile: true },
  { key: 'phase',    label: 'phase' },
  { key: 'squawk',   label: 'squawk', hide: true },
  { key: 'vel',      label: 'spd (m/s)', hide: true },
  { key: 'hdg',      label: 'hdg', hide: true },
]

// Abbreviate common country names to 2-3 chars
const COUNTRY_SHORT = {
  'united states': 'US', 'canada': 'CA', 'united kingdom': 'UK', 'germany': 'DE',
  'france': 'FR', 'italy': 'IT', 'spain': 'ES', 'netherlands': 'NL', 'belgium': 'BE',
  'switzerland': 'CH', 'austria': 'AT', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
  'finland': 'FI', 'ireland': 'IE', 'portugal': 'PT', 'poland': 'PL', 'greece': 'GR',
  'turkey': 'TR', 'russia': 'RU', 'china': 'CN', 'japan': 'JP', 'south korea': 'KR',
  'india': 'IN', 'australia': 'AU', 'new zealand': 'NZ', 'brazil': 'BR', 'mexico': 'MX',
  'argentina': 'AR', 'colombia': 'CO', 'chile': 'CL', 'israel': 'IL', 'egypt': 'EG',
  'south africa': 'ZA', 'saudi arabia': 'SA', 'united arab emirates': 'AE',
  'thailand': 'TH', 'singapore': 'SG', 'malaysia': 'MY', 'indonesia': 'ID',
  'philippines': 'PH', 'taiwan': 'TW', 'hong kong': 'HK', 'czech republic': 'CZ',
  'czechia': 'CZ', 'romania': 'RO', 'hungary': 'HU', 'iceland': 'IS', 'luxembourg': 'LU',
  'unknown': '—',
}
function shortCountry(c) {
  if (!c) return '—'
  return COUNTRY_SHORT[c.toLowerCase()] || c.slice(0, 3).toUpperCase()
}

const PHASE_LABEL = {
  [PHASE.CLIMB]:    'climb',
  [PHASE.CRUISE]:   'cruise',
  [PHASE.DESCENT]:  'descent',
  [PHASE.APPROACH]: 'approach',
  [PHASE.GROUND]:   'ground',
  [PHASE.UNKNOWN]:  '—',
}

const PHASE_COLOR = {
  [PHASE.CLIMB]:    'text-grn',
  [PHASE.CRUISE]:   'text-cyn',
  [PHASE.DESCENT]:  'text-ylw',
  [PHASE.APPROACH]: 'text-mag',
  [PHASE.GROUND]:   'text-fg3',
  [PHASE.UNKNOWN]:  'text-fg3',
}

// priority for takeoff sort — airborne first, then by phase
const TAKEOFF_RANK = {
  [PHASE.CLIMB]:    0,
  [PHASE.APPROACH]: 1,
  [PHASE.DESCENT]:  2,
  [PHASE.CRUISE]:   3,
  [PHASE.UNKNOWN]:  4,
  [PHASE.GROUND]:   5,
}

export default function FlightTable({ flights, filter, selectedIcao, enrichCache, anomalies = {}, trackHistory = {}, openskyUsage, aeroSpend, onSelect, onArrived, onDeparted }) {
  const PAGE_SIZE = 50
  const [sortKey, setSortKey] = useState('takeoff')
  const [sortDir, setSortDir] = useState(1)
  const [page, setPage] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [anomalyHighlight, setAnomalyHighlight] = useState(false)
  const [squawkHighlight, setSquawkHighlight] = useState(null) // null | '7700' | '7600' | '7500' | '1200'
  const [newIcaos, setNewIcaos] = useState(new Set())
  const prevIcaosRef = useRef(new Set())
  const prevFlightsRef = useRef(new Map())
  const initialLoad = useRef(true)

  // ── diff flights on each update ───────────────────────────────────────────
  useEffect(() => {
    const currentIcaos = new Set(flights.map(f => f.icao))
    const prevIcaos = prevIcaosRef.current

    if (initialLoad.current) {
      initialLoad.current = false
      prevIcaosRef.current = currentIcaos
      const flightMap = new Map()
      flights.forEach(f => flightMap.set(f.icao, f))
      prevFlightsRef.current = flightMap
      return
    }

    // new arrivals
    const arrived = new Set()
    for (const icao of currentIcaos) {
      if (!prevIcaos.has(icao)) arrived.add(icao)
    }

    // departed — collect callsigns for the log
    const departedList = []
    for (const icao of prevIcaos) {
      if (!currentIcaos.has(icao)) {
        const prev = prevFlightsRef.current.get(icao)
        departedList.push(prev?.callsign || icao)
      }
    }

    // update refs
    prevIcaosRef.current = currentIcaos
    const flightMap = new Map()
    flights.forEach(f => flightMap.set(f.icao, f))
    prevFlightsRef.current = flightMap

    // notify parent of arrivals
    if (arrived.size > 0 && onArrived) {
      const arrivedList = []
      for (const icao of arrived) {
        const f = flightMap.get(icao)
        arrivedList.push(f?.callsign || icao)
      }
      onArrived(arrivedList)
    }

    // notify parent of departures
    if (departedList.length > 0 && onDeparted) {
      onDeparted(departedList)
    }

    // highlight arrivals
    if (arrived.size > 0) {
      setNewIcaos(arrived)
    }

    const timer = arrived.size > 0
      ? setTimeout(() => setNewIcaos(new Set()), 2500)
      : null
    return () => { if (timer) clearTimeout(timer) }
  }, [flights])

  const q = filter.toLowerCase()

  const filtered = useMemo(() => {
    setPage(0) // reset to first page on filter change
    let list = flights.filter(f =>
      f.callsign.toLowerCase().includes(q) ||
      f.country.toLowerCase().includes(q) ||
      f.icao.toLowerCase().includes(q)
    )
    return list
  }, [flights, q])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      // highlighted rows float to top
      const aHl = (anomalyHighlight && anomalies[a.icao] ? 1 : 0) + (squawkHighlight && a.squawk === squawkHighlight ? 1 : 0)
      const bHl = (anomalyHighlight && anomalies[b.icao] ? 1 : 0) + (squawkHighlight && b.squawk === squawkHighlight ? 1 : 0)
      if (aHl !== bHl) return bHl - aHl

      // special takeoff sort: ground/climb first, then by altitude ascending
      if (sortKey === 'takeoff') {
        const aHist = trackHistory[a.icao]
        const bHist = trackHistory[b.icao]
        const aPhase = aHist?.length >= 2 ? detectPhase(aHist) : (a.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
        const bPhase = bHist?.length >= 2 ? detectPhase(bHist) : (b.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
        const aRank = TAKEOFF_RANK[aPhase] ?? 5
        const bRank = TAKEOFF_RANK[bPhase] ?? 5
        if (aRank !== bRank) return (aRank - bRank) * sortDir
        const aAlt = a.alt ?? 99999
        const bAlt = b.alt ?? 99999
        return (aAlt - bAlt) * sortDir
      }

      // computed columns
      let va, vb
      if (sortKey === 'phase') {
        const aHist = trackHistory[a.icao]
        const bHist = trackHistory[b.icao]
        va = TAKEOFF_RANK[aHist?.length >= 2 ? detectPhase(aHist) : (a.grounded ? PHASE.GROUND : PHASE.UNKNOWN)] ?? 5
        vb = TAKEOFF_RANK[bHist?.length >= 2 ? detectPhase(bHist) : (b.grounded ? PHASE.GROUND : PHASE.UNKNOWN)] ?? 5
      } else if (sortKey === 'vrate') {
        va = a.vertRate ?? null
        vb = b.vertRate ?? null
      } else if (sortKey === 'type') {
        va = enrichCache[a.icao]?.adsbfi?.type || enrichCache[a.icao]?.aircraft?.icao_type || a.acType || ''
        vb = enrichCache[b.icao]?.adsbfi?.type || enrichCache[b.icao]?.aircraft?.icao_type || b.acType || ''
      } else if (sortKey === 'reg') {
        va = enrichCache[a.icao]?.adsbfi?.reg || enrichCache[a.icao]?.aircraft?.registration || a.acReg || ''
        vb = enrichCache[b.icao]?.adsbfi?.reg || enrichCache[b.icao]?.aircraft?.registration || b.acReg || ''
      } else if (sortKey === 'country') {
        va = a.country || ''
        vb = b.country || ''
      } else {
        va = a[sortKey]; vb = b[sortKey]
      }
      if (va == null) va = sortDir > 0 ? Infinity : -Infinity
      if (vb == null) vb = sortDir > 0 ? Infinity : -Infinity
      return va < vb ? -sortDir : va > vb ? sortDir : 0
    })
  }, [filtered, sortKey, sortDir, anomalies, trackHistory, enrichCache, anomalyHighlight, squawkHighlight])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const displayed = showAll ? sorted : sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const anomalyCount = Object.keys(anomalies).length
  const squawkCounts = useMemo(() => {
    const counts = {}
    for (const f of filtered) { if (f.squawk) counts[f.squawk] = (counts[f.squawk] || 0) + 1 }
    return counts
  }, [filtered])

  const handleSort = key => {
    if (sortKey === key) setSortDir(d => d * -1)
    else { setSortKey(key); setSortDir(1) }
  }

  if (!displayed.length) {
    return (
      <div className="flex flex-col bg-bg flex-1 min-h-0">
        <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 shrink-0">
          <span className="flex items-center gap-1.5">
            <span className="text-fg2">0</span> records
          </span>
        </div>
        <div className="p-8 text-center text-fg3">
          {flights.length ? 'no matches' : 'no data — press fetch'}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-bg flex-1 min-h-0">
      <div className="shrink-0 bg-bg2 border-b border-border text-[10px] sm:text-[11px] text-fg3">
        {/* Row 1: records, filters, squawk */}
        <div className="flex flex-wrap justify-between items-center py-0.5 px-1.5 sm:px-2.5 gap-y-0.5">
          <span className="flex items-center gap-1 sm:gap-1.5 min-w-0 shrink-0">
            <span className="text-fg">{filtered.length}</span>
            <span>records</span>
            {!showAll && totalPages > 1 && (
              <>
                <button
                  className="bg-transparent border border-border text-fg3 hover:text-fg2 text-[10px] cursor-pointer px-1 py-0 font-mono rounded disabled:opacity-30 disabled:cursor-default"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                >
                  ‹
                </button>
                <span className="text-fg3 text-[10px]">{safePage + 1}/{totalPages}</span>
                <button
                  className="bg-transparent border border-border text-fg3 hover:text-fg2 text-[10px] cursor-pointer px-1 py-0 font-mono rounded disabled:opacity-30 disabled:cursor-default"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                >
                  ›
                </button>
              </>
            )}
            {filtered.length > PAGE_SIZE && (
              <button
                className="bg-transparent border-none text-acc text-[10px] sm:text-[11px] cursor-pointer p-0 font-mono underline"
                onClick={() => { setShowAll(s => !s); setPage(0) }}
              >
                {showAll ? `page (${PAGE_SIZE})` : `show all ${filtered.length}`}
              </button>
            )}
            {newIcaos.size > 0 && <span className="text-grn ml-1">+{newIcaos.size} new</span>}
          </span>
          <div className="flex gap-1 items-center w-full sm:w-auto">
            <button
              className={clsx(
                'text-[10px] sm:text-[11px] cursor-pointer font-mono px-1.5 py-0.5 sm:py-0 rounded border flex-1 sm:flex-none text-center',
                sortKey === 'takeoff'
                  ? 'bg-acc/15 border-acc/40 text-acc'
                  : 'bg-transparent border-border text-fg3 hover:text-fg2 hover:border-fg3'
              )}
              onClick={() => {
                if (sortKey === 'takeoff') setSortDir(d => d * -1)
                else { setSortKey('takeoff'); setSortDir(1) }
              }}
              title="Sort by takeoff proximity (ground → climb → cruise)"
            >
              {sortKey === 'takeoff' ? `takeoff ${sortDir > 0 ? '▲' : '▼'}` : 'takeoff'}
            </button>
            <button
              className={clsx(
                'text-[10px] sm:text-[11px] cursor-pointer font-mono px-1.5 py-0.5 sm:py-0 rounded border flex-1 sm:flex-none text-center',
                anomalyHighlight
                  ? 'bg-red/15 border-red/40 text-red'
                  : anomalyCount > 0
                    ? 'bg-transparent border-border text-red hover:border-red/40'
                    : 'bg-transparent border-border text-fg3 hover:text-fg2 hover:border-fg3'
              )}
              onClick={() => setAnomalyHighlight(h => !h)}
              title={anomalyHighlight ? 'Stop highlighting anomalies' : 'Highlight anomalies'}
            >
              anomaly ({anomalyCount})
            </button>
          </div>
          <div className="flex gap-0 items-center w-full sm:w-auto border border-border sm:ml-0.5 rounded overflow-hidden">
            <span className="text-[9px] text-fg3 px-1 border-r border-border shrink-0">squawk</span>
            {[
              { id: '7700', label: '7700', on: 'bg-red/20 text-red', title: 'Emergency' },
              { id: '7600', label: '7600', on: 'bg-ylw/20 text-ylw', title: 'Radio failure' },
              { id: '7500', label: '7500', on: 'bg-red/20 text-red', title: 'Hijack' },
              { id: '1200', label: 'VFR',  on: 'bg-cyn/20 text-cyn', title: 'VFR traffic' },
            ].map(f => {
              const cnt = squawkCounts[f.id] || 0
              return (
                <button
                  key={f.id}
                  className={clsx(
                    'text-[10px] cursor-pointer font-mono px-1.5 py-0.5 sm:py-0 border-none flex-1 text-center',
                    squawkHighlight === f.id ? f.on : 'bg-transparent text-fg3 hover:text-fg2'
                  )}
                  onClick={() => setSquawkHighlight(prev => prev === f.id ? null : f.id)}
                  title={f.title}
                >
                  {f.label} ({cnt})
                </button>
              )
            })}
          </div>
        </div>
        {/* Row 2: API usage */}
        {(openskyUsage || (aeroSpend && aeroSpend.source !== 'unconfigured')) && (
          <div className="flex gap-3 items-center py-0.5 px-1.5 sm:px-2.5 border-t border-white/3">
            {openskyUsage && (
              <span>
                <span className="text-acc">opensky</span>{' '}
                <span className={openskyUsage.remaining < 400 ? 'text-red' : openskyUsage.remaining < 1000 ? 'text-ylw' : 'text-grn'}>
                  {openskyUsage.remaining}
                </span>
                <span className="text-fg2">/{openskyUsage.daily_limit}</span>
              </span>
            )}
            {aeroSpend && aeroSpend.source !== 'unconfigured' && (
              <span>
                <span className="text-mag">aero</span>{' '}
                <span className={aeroSpend.cap_reached ? 'text-red' : aeroSpend.cap_remaining < 1 ? 'text-ylw' : 'text-grn'}>
                  ${aeroSpend.cap_remaining.toFixed(2)}
                </span>
                <span className="text-fg2">/${aeroSpend.cap.toFixed(2)}</span>
                {aeroSpend.cap_reached && <span className="text-red ml-1">CAP</span>}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="overflow-auto flex-1 min-h-0">
      <table className="w-full border-separate border-spacing-0">
        <thead className="sticky top-0 z-1">
          <tr>
            {COLS.map(col => {
              const isActive = sortKey === col.key
              return (
                <th
                  key={col.key}
                  className={clsx(
                    'group py-0.5 px-1.5 sm:px-2.5 text-left font-normal text-[10px] sm:text-[11px] cursor-pointer select-none whitespace-nowrap font-mono bg-bg2 border-b border-border',
                    col.hide && 'hidden sm:table-cell',
                    col.hideMobile && 'hidden sm:table-cell',
                    isActive ? 'text-acc' : 'text-fg3 hover:text-fg2'
                  )}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {isActive ? (
                    <span className="ml-1 text-[9px]">{sortDir > 0 ? '▲' : '▼'}</span>
                  ) : (
                    <span className="ml-1 text-[9px] opacity-0 group-hover:opacity-40">▲</span>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {displayed.length === 0 && (
            <tr>
              <td colSpan={COLS.length} className="text-center py-8 text-fg3 text-[11px]">
                {flights.length === 0
                  ? 'waiting for poller — first data arrives in ~45s'
                  : 'no flights match current filters'}
              </td>
            </tr>
          )}
          {displayed.map(f => {
            const isSel = f.icao === selectedIcao
            const enrich = enrichCache[f.icao]
            const isNew = newIcaos.has(f.icao)
            const anomaly = anomalies[f.icao]
            const hlAnomaly = anomalyHighlight && anomaly
            const hlSquawk = squawkHighlight && f.squawk === squawkHighlight
            const dimmed = (anomalyHighlight || squawkHighlight) && !hlAnomaly && !hlSquawk
            const hist = trackHistory[f.icao]
            const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
            const acType = enrich?.adsbfi?.type || enrich?.aircraft?.icao_type || f.acType || null
            const acReg = enrich?.adsbfi?.reg || enrich?.aircraft?.registration || f.acReg || null
            const vr = f.vertRate != null ? Math.round(f.vertRate * 196.85) : (enrich?.adsbfi?.baroRate ?? null) // m/s → ft/min
            return (
              <tr
                key={f.icao + f.callsign}
                className={clsx(
                  'border-b cursor-pointer',
                  dimmed && 'opacity-30',
                  hlAnomaly
                    ? 'bg-red/8 border-b-red/20 border-l-2 border-l-red'
                    : hlSquawk
                      ? 'bg-ylw/8 border-b-ylw/20 border-l-2 border-l-ylw'
                      : isNew
                        ? 'animate-row-arrive border-white/3'
                        : isSel
                          ? 'bg-acc/8 border-l-2 border-l-acc border-white/3'
                          : 'hover:bg-bg2 border-white/3'
                )}
                onClick={() => onSelect(f)}
              >
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-fg3">
                  {anomaly && (
                    <span
                      className={clsx('mr-1', anomaly.confirmed ? 'text-red font-bold' : 'text-red')}
                      title={`[${anomaly.score}] ${anomaly.phase} — ${anomaly.reasons.join('; ')}`}
                    >
                      {anomaly.confirmed ? '!!' : '!'}
                    </span>
                  )}
                  {f.icao}
                </td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-ylw">
                  {f.callsign}
                  {f.mil && <span className="text-red text-[10px]"> [mil]</span>}
                </td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-fg3 hidden sm:table-cell">
                  {acType || '—'}
                </td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-ylw hidden sm:table-cell">
                  {acReg || '—'}
                </td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-fg3 hidden sm:table-cell" title={f.country}>
                  {shortCountry(f.country)}
                </td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-fg3 hidden sm:table-cell">
                  {f.lat != null ? `${f.lat.toFixed(1)},${f.lon.toFixed(1)}` : '—'}
                </td>
                <td className={clsx('py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs', f.grounded ? 'text-ylw' : 'text-cyn')}>
                  {f.alt ?? '—'}
                </td>
                <td className={clsx('py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs hidden sm:table-cell',
                  vr == null ? 'text-fg3' : Math.abs(vr) > 2000 ? 'text-ylw' : vr > 0 ? 'text-grn' : vr < 0 ? 'text-cyn' : 'text-fg3'
                )}>
                  {vr != null ? `${vr > 0 ? '+' : ''}${vr}` : '—'}
                </td>
                <td className={clsx('py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs', PHASE_COLOR[phase])}>
                  {PHASE_LABEL[phase]}
                </td>
                <td className={clsx('py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs hidden sm:table-cell', squawkColor(f.squawk))}>
                  {squawkLabel(f.squawk)}
                </td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-fg2 hidden sm:table-cell">{f.vel ?? '—'}</td>
                <td className="py-0.5 px-1.5 sm:px-2.5 whitespace-nowrap text-[10px] sm:text-xs text-fg3 hidden sm:table-cell">
                  {f.hdg != null ? `${f.hdg}°` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}
