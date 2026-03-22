const REGIONS = ['global', 'usa', 'europe', 'asia', 'atlantic']

const s = {
  bar: {
    background: 'var(--bg1)',
    borderBottom: '1px solid var(--border)',
    padding: '4px 10px',
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  prompt: {
    display: 'flex', alignItems: 'center', gap: '5px',
    flex: 1, minWidth: '160px',
  },
  sym: { color: 'var(--grn)', userSelect: 'none' },
  input: {
    background: 'none', border: 'none', outline: 'none',
    color: 'var(--fg)', fontSize: '12px', flex: 1,
    caretColor: 'var(--fg)', fontFamily: 'inherit',
  },
  sep: { color: 'var(--border2)', userSelect: 'none' },
  label: { color: 'var(--fg3)', fontSize: '11px' },
}

function Btn({ children, active, danger, onClick, disabled }) {
  const base = {
    background: 'none',
    border: `1px solid ${danger ? 'var(--border)' : 'var(--border2)'}`,
    color: danger ? 'var(--red)' : active ? 'var(--grn)' : 'var(--fg2)',
    borderColor: active ? 'var(--grn)' : danger ? 'var(--border)' : 'var(--border2)',
    fontSize: '11px',
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    opacity: disabled ? 0.5 : 1,
  }
  return (
    <button style={base} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export default function ControlBar({
  filter, onFilterChange,
  onFetch, fetching,
  autoOn, onToggleAuto,
  onClearLog,
  onOpenSettings,
  onOpenUsage,
  region, onRegionChange,
  interval,
}) {
  return (
    <div style={s.bar}>
      <div style={s.prompt}>
        <span style={s.sym}>❯</span>
        <input
          style={s.input}
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="filter callsign / icao / country"
        />
      </div>

      <span style={s.sep}>|</span>

      <Btn onClick={onFetch} disabled={fetching}>
        {fetching ? 'fetching...' : 'fetch'}
      </Btn>

      <Btn active={autoOn} onClick={onToggleAuto}>
        {autoOn ? `auto [${interval}s]` : 'auto-refresh'}
      </Btn>

      <Btn danger onClick={onClearLog}>clear log</Btn>

      <Btn onClick={onOpenSettings}>⚙ settings</Btn>

      <Btn onClick={onOpenUsage}>$ usage</Btn>

      <span style={s.sep}>|</span>
      <span style={s.label}>region:</span>

      {REGIONS.map(r => (
        <Btn key={r} active={region === r} onClick={() => onRegionChange(r)}>
          {r}
        </Btn>
      ))}
    </div>
  )
}
