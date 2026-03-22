import { useState, useMemo, useRef, useEffect } from 'react'
import clsx from 'clsx'
import { squawkLabel, squawkColor } from '../utils/squawk'
import { detectPhase, PHASE } from '../utils/anomaly'

const COLS = [
  { key: 'icao',     label: 'icao24' },
  { key: 'callsign', label: 'callsign' },
  { key: 'country',  label: 'country' },
  { key: 'alt',      label: 'alt (m)' },
  { key: 'vel',      label: 'spd (m/s)', hide: true },
  { key: 'hdg',      label: 'hdg',       hide: true },
  { key: 'squawk',   label: 'squawk',   hide: true },
  { key: 'status',   label: 'status' },
  { key: 'db',       label: 'db' },
]

// priority for takeoff sort — lower = closer to takeoff
const TAKEOFF_RANK = {
  [PHASE.GROUND]:   0,
  [PHASE.CLIMB]:    1,
  [PHASE.APPROACH]: 2,
  [PHASE.DESCENT]:  3,
  [PHASE.CRUISE]:   4,
  [PHASE.UNKNOWN]:  5,
}

export default function FlightTable({ flights, filter, selectedIcao, enrichCache, anomalies = {}, trackHistory = {}, openskyUsage, aeroSpend, onSelect, onArrived, onDeparted }) {
  const [sortKey, setSortKey] = useState('takeoff')
  const [sortDir, setSortDir] = useState(1)
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

      let va = a[sortKey], vb = b[sortKey]
      if (va == null) va = sortDir > 0 ? Infinity : -Infinity
      if (vb == null) vb = sortDir > 0 ? Infinity : -Infinity
      return va < vb ? -sortDir : va > vb ? sortDir : 0
    })
  }, [filtered, sortKey, sortDir, anomalies, trackHistory, anomalyHighlight, squawkHighlight])

  const limit = showAll ? sorted.length : 200
  const displayed = sorted.slice(0, limit)

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
      <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 shrink-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-fg">{filtered.length}</span>
          <span>records</span>
          {filtered.length > limit && (
            <button
              className="bg-transparent border-none text-acc text-[11px] cursor-pointer p-0 font-mono underline"
              onClick={() => setShowAll(s => !s)}
            >
              {showAll ? `show 200` : `show all ${filtered.length}`}
            </button>
          )}
          {!showAll && filtered.length > limit && (
            <span className="text-fg3">(showing {limit})</span>
          )}
          <button
            className={clsx(
              'text-[11px] cursor-pointer font-mono px-1.5 py-0 rounded border',
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
          {newIcaos.size > 0 && <span className="text-grn ml-1">+{newIcaos.size} new</span>}
          <button
            className={clsx(
              'text-[11px] cursor-pointer font-mono px-1.5 py-0 rounded border',
              anomalyHighlight
                ? 'bg-red/15 border-red/40 text-red'
                : anomalyCount > 0
                  ? 'bg-transparent border-border text-red hover:border-red/40'
                  : 'bg-transparent border-border text-fg3 hover:text-fg2 hover:border-fg3'
            )}
            onClick={() => setAnomalyHighlight(h => !h)}
            title={anomalyHighlight ? 'Stop highlighting anomalies' : 'Highlight anomalies'}
          >
            ! {anomalyCount}
          </button>
          <span className="flex items-center gap-0.5 ml-0.5 border border-border rounded overflow-hidden">
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
                    'text-[10px] cursor-pointer font-mono px-1.5 py-0 border-none',
                    squawkHighlight === f.id ? f.on : 'bg-transparent text-fg3 hover:text-fg2'
                  )}
                  onClick={() => setSquawkHighlight(prev => prev === f.id ? null : f.id)}
                  title={f.title}
                >
                  {f.label} {cnt}
                </button>
              )
            })}
          </span>
        </span>
        <span className="flex gap-3 items-center shrink-0">
          {openskyUsage && (
            <span>
              <span className="text-acc">opensky</span>{' '}
              <span className={openskyUsage.remaining < 400 ? 'text-red' : openskyUsage.remaining < 1000 ? 'text-ylw' : 'text-grn'}>
                {openskyUsage.remaining}
              </span>
              <span className="text-fg2">/{openskyUsage.daily_limit}</span>
            </span>
          )}
          {aeroSpend && (
            <span>
              <span className="text-mag">aero</span>{' '}
              <span className={aeroSpend.cap_reached ? 'text-red' : aeroSpend.cap_remaining < 1 ? 'text-ylw' : 'text-grn'}>
                ${aeroSpend.cap_remaining.toFixed(2)}
              </span>
              <span className="text-fg2">/${aeroSpend.cap.toFixed(2)}</span>
              {aeroSpend.cap_reached && <span className="text-red ml-1">CAP</span>}
            </span>
          )}
        </span>
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
                    'group py-0.5 px-2.5 text-left font-normal text-[11px] cursor-pointer select-none whitespace-nowrap font-mono bg-bg2 border-b border-border',
                    col.hide && 'hidden sm:table-cell',
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
          {displayed.map(f => {
            const isSel = f.icao === selectedIcao
            const cached = !!enrichCache[f.icao]
            const isNew = newIcaos.has(f.icao)
            const anomaly = anomalies[f.icao]
            const hlAnomaly = anomalyHighlight && anomaly
            const hlSquawk = squawkHighlight && f.squawk === squawkHighlight
            const dimmed = (anomalyHighlight || squawkHighlight) && !hlAnomaly && !hlSquawk
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
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg3">
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
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-ylw">
                  {f.callsign}
                  {f.mil && <span className="text-red text-[10px]"> [mil]</span>}
                </td>
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg3">{f.country}</td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs', f.grounded ? 'text-ylw' : 'text-cyn')}>
                  {f.alt ?? '—'}
                </td>
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg2 hidden sm:table-cell">{f.vel ?? '—'}</td>
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg3 hidden sm:table-cell">
                  {f.hdg != null ? `${f.hdg}°` : '—'}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs hidden sm:table-cell', squawkColor(f.squawk))}>
                  {squawkLabel(f.squawk)}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs', f.grounded ? 'text-ylw' : 'text-grn')}>
                  {f.grounded ? 'ground' : 'air'}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs', cached ? 'text-grn' : 'text-fg3')}>
                  {cached ? '✓' : '·'}
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
