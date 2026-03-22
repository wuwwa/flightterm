import { useState, useMemo } from 'react'

const s = {
  wrap: { overflow: 'auto', background: 'var(--bg)', flex: 1 },
  tbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '3px 10px', background: 'var(--bg2)',
    borderBottom: '1px solid var(--border)',
    fontSize: '11px', color: 'var(--fg3)',
    position: 'sticky', top: 0, zIndex: 2,
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  thead: { position: 'sticky', top: '24px', zIndex: 1 },
  theadTr: { background: 'var(--bg2)', borderBottom: '1px solid var(--border)' },
  th: {
    padding: '3px 10px', textAlign: 'left',
    color: 'var(--fg3)', fontWeight: 400,
    fontSize: '11px', cursor: 'pointer',
    userSelect: 'none', whiteSpace: 'nowrap',
    fontFamily: 'inherit',
  },
  thActive: { color: 'var(--acc)' },
  tr: { borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' },
  trSel: { background: 'rgba(129,162,190,0.08)', borderLeft: '2px solid var(--acc)' },
  td: { padding: '3px 10px', whiteSpace: 'nowrap', color: 'var(--fg2)', fontSize: '12px' },
  empty: { padding: '30px', textAlign: 'center', color: 'var(--fg3)' },
}

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

function fmtVal(f, key) {
  if (key === 'hdg') return f.hdg != null ? `${f.hdg}°` : '—'
  if (key === 'alt') return f.alt != null ? f.alt : '—'
  if (key === 'vel') return f.vel != null ? f.vel : '—'
  if (key === 'status') return f.grounded ? 'ground' : 'air'
  return f[key] ?? '—'
}

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
      <div style={s.wrap}>
        <div style={s.tbar}>
          <span><span style={{ color: 'var(--fg2)' }}>0</span> records</span>
        </div>
        <div style={s.empty}>
          {flights.length ? 'no matches' : 'no data — press fetch'}
        </div>
      </div>
    )
  }

  return (
    <div style={s.wrap}>
      <div style={s.tbar}>
        <span>
          <span style={{ color: 'var(--fg2)' }}>{filtered.length}</span>
          {filtered.length > 200 ? ' (showing 200)' : ''} records
        </span>
      </div>
      <table style={s.table}>
        <thead style={s.thead}>
          <tr style={s.theadTr}>
            {COLS.map(col => (
              <th
                key={col.key}
                style={{
                  ...s.th,
                  ...(sortKey === col.key ? s.thActive : {}),
                  display: col.hide ? undefined : undefined, // handled by CSS media query in App
                }}
                className={col.hide ? 'hide-sm' : ''}
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
                style={{ ...s.tr, ...(isSel ? s.trSel : {}) }}
                onClick={() => onSelect(f)}
                onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--bg2)' }}
                onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = '' }}
              >
                <td style={{ ...s.td, color: 'var(--fg3)' }}>{f.icao}</td>
                <td style={{ ...s.td, color: 'var(--ylw)' }}>
                  {f.callsign}
                  {f.mil && <span style={{ color: 'var(--red)', fontSize: '10px' }}> [mil]</span>}
                </td>
                <td style={{ ...s.td, color: 'var(--fg3)' }}>{f.country}</td>
                <td style={{ ...s.td, color: f.grounded ? 'var(--ylw)' : 'var(--cyn)' }}>
                  {f.alt ?? '—'}
                </td>
                <td className="hide-sm" style={s.td}>{f.vel ?? '—'}</td>
                <td className="hide-sm" style={{ ...s.td, color: 'var(--fg3)' }}>
                  {f.hdg != null ? `${f.hdg}°` : '—'}
                </td>
                <td style={{ ...s.td, color: f.grounded ? 'var(--ylw)' : 'var(--grn)' }}>
                  {f.grounded ? 'ground' : 'air'}
                </td>
                <td style={{ ...s.td, color: cached ? 'var(--grn)' : 'var(--fg3)' }}>
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
