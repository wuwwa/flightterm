import { useState, useMemo } from 'react'
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

export default function FlightTable({ flights, filter, selectedIcao, enrichCache, onSelect }) {
  const [sortKey, setSortKey] = useState('callsign')
  const [sortDir, setSortDir] = useState(1)

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
      <div className="overflow-auto bg-bg flex-1">
        <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 sticky top-0 z-2">
          <span><span className="text-fg2">0</span> records</span>
        </div>
        <div className="p-8 text-center text-fg3">
          {flights.length ? 'no matches' : 'no data — press fetch'}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-auto bg-bg flex-1">
      <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 sticky top-0 z-2">
        <span>
          <span className="text-fg2">{filtered.length}</span>
          {filtered.length > 200 ? ' (showing 200)' : ''} records
        </span>
      </div>
      <table className="w-full border-collapse">
        <thead className="sticky top-6 z-1">
          <tr className="bg-bg2 border-b border-border">
            {COLS.map(col => (
              <th
                key={col.key}
                className={clsx(
                  'py-0.5 px-2.5 text-left font-normal text-[11px] cursor-pointer select-none whitespace-nowrap font-mono',
                  col.hide && 'hidden sm:table-cell',
                  sortKey === col.key ? 'text-acc' : 'text-fg3'
                )}
                onClick={() => handleSort(col.key)}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayed.map(f => {
            const isSel = f.icao === selectedIcao
            const cached = !!enrichCache[f.icao]
            return (
              <tr
                key={f.icao + f.callsign}
                className={clsx(
                  'border-b border-white/3 cursor-pointer',
                  isSel ? 'bg-acc/8 border-l-2 border-l-acc' : 'hover:bg-bg2'
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
  )
}
