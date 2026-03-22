import clsx from 'clsx'

const REGIONS = ['global', 'usa', 'europe', 'asia', 'atlantic']

function Btn({ children, active, danger, pulse, onClick, disabled }) {
  return (
    <button
      className={clsx(
        'bg-transparent border text-[11px] py-0.5 px-2 whitespace-nowrap',
        danger
          ? 'border-border text-red'
          : active
            ? 'border-grn text-grn'
            : 'border-border2 text-fg2',
        disabled && 'opacity-50',
        pulse && 'animate-pulse-border'
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export default function ControlBar({
  filter, onFilterChange,
  onFetch, fetching, hasFetched,
  autoOn, onToggleAuto,
  onClearLog,
  onOpenSettings,
  onOpenUsage,
  region, onRegionChange,
  interval,
}) {
  return (
    <div className="bg-bg1 border-b border-border py-1 px-2.5 flex gap-1.5 items-center flex-nowrap overflow-x-auto shrink-0">
      <div className="flex items-center gap-1.5 flex-1 min-w-40">
        <span className="text-grn select-none">❯</span>
        <input
          className="bg-transparent border-none outline-none text-fg text-xs flex-1 caret-fg font-mono"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="filter callsign / icao / country"
        />
      </div>

      <span className="text-border2 select-none">|</span>

      <Btn onClick={onFetch} disabled={fetching} pulse={!hasFetched && !fetching}>
        {fetching ? 'fetching...' : 'fetch'}
      </Btn>

      <Btn active={autoOn} onClick={onToggleAuto}>
        {autoOn ? `auto [${interval}s]` : 'auto-refresh'}
      </Btn>

      <Btn danger onClick={onClearLog}>clear log</Btn>

      <Btn onClick={onOpenSettings}>⚙ settings</Btn>

      <Btn onClick={onOpenUsage}>$ usage</Btn>

      <span className="text-border2 select-none">|</span>
      <span className="text-fg3 text-[11px]">region:</span>

      {REGIONS.map(r => (
        <Btn key={r} active={region === r} onClick={() => onRegionChange(r)}>
          {r}
        </Btn>
      ))}
    </div>
  )
}
