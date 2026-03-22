import { useState, useMemo, useRef, useEffect } from 'react'
import clsx from 'clsx'

const COLS = [
  { key: 'icao',     label: 'icao24' },
  { key: 'callsign', label: 'callsign' },
  { key: 'country',  label: 'country' },
  { key: 'alt',      label: 'alt (m)' },
  { key: 'vel',      label: 'spd (m/s)', hide: true },
  { key: 'hdg',      label: 'hdg',       hide: true },
  { key: 'status',   label: 'status' },
  { key: 'db',       label: 'db' },
]

export default function FlightTable({ flights, filter, selectedIcao, enrichCache, onSelect, onArrived, onDeparted }) {
  const [sortKey, setSortKey] = useState('callsign')
  const [sortDir, setSortDir] = useState(1)
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
    return flights.filter(f =>
      f.callsign.toLowerCase().includes(q) ||
      f.country.toLowerCase().includes(q) ||
      f.icao.toLowerCase().includes(q)
    )
  }, [flights, q])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey]
      if (va == null) va = sortDir > 0 ? Infinity : -Infinity
      if (vb == null) vb = sortDir > 0 ? Infinity : -Infinity
      return va < vb ? -sortDir : va > vb ? sortDir : 0
    })
  }, [filtered, sortKey, sortDir])

  const displayed = sorted.slice(0, 200)

  const handleSort = key => {
    if (sortKey === key) setSortDir(d => d * -1)
    else { setSortKey(key); setSortDir(1) }
  }

  if (!displayed.length) {
    return (
      <div className="flex flex-col bg-bg flex-1 min-h-0">
        <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 shrink-0">
          <span><span className="text-fg2">0</span> records</span>
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
        <span>
          <span className="text-fg2">{filtered.length}</span>
          {filtered.length > 200 ? ' (showing 200)' : ''} records
          {newIcaos.size > 0 && <span className="text-grn ml-2">+{newIcaos.size} new</span>}
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
            return (
              <tr
                key={f.icao + f.callsign}
                className={clsx(
                  'border-b border-white/3 cursor-pointer',
                  isNew
                    ? 'animate-row-arrive'
                    : isSel
                      ? 'bg-acc/8 border-l-2 border-l-acc'
                      : 'hover:bg-bg2'
                )}
                onClick={() => onSelect(f)}
              >
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg3">{f.icao}</td>
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
