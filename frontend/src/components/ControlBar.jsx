import { useState, useEffect } from 'react'
import clsx from 'clsx'

const REGIONS = ['global', 'usa', 'europe', 'asia', 'atlantic']

function Btn({ children, active, danger, pulse, onClick, disabled, fill }) {
  return (
    <button
      className={clsx(
        'bg-transparent border text-[11px] py-0.5 px-2 whitespace-nowrap text-center',
        fill && 'flex-1 sm:flex-none',
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
  onOpenNotams,
  region, onRegionChange,
  interval,
  lastFetchAt,
}) {
  const [countdown, setCountdown] = useState(null)

  useEffect(() => {
    if (!autoOn || !lastFetchAt) { setCountdown(null); return }

    const tick = () => {
      const elapsed = Math.floor((Date.now() - lastFetchAt) / 1000)
      const remaining = Math.max(0, interval - elapsed)
      setCountdown(remaining)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [autoOn, lastFetchAt, interval])

  return (
    <div className="bg-bg1 border-b border-border py-1 px-1.5 sm:px-2.5 flex flex-wrap gap-1 sm:gap-1.5 items-center shrink-0">
      <div className="flex items-center gap-1.5 w-full sm:w-auto sm:flex-1 sm:min-w-40">
        <span className="text-grn select-none">❯</span>
        <input
          className="bg-transparent border-none outline-none text-fg text-xs flex-1 caret-fg font-mono"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="filter callsign / icao"
        />
      </div>

      <div className="flex gap-1 items-center w-full sm:w-auto sm:shrink-0">
        <Btn onClick={onFetch} disabled={fetching} pulse={!hasFetched && !fetching} fill>
          {fetching ? '...' : 'fetch'}
        </Btn>
        <Btn active={autoOn} onClick={onToggleAuto} fill pulse={!autoOn && !hasFetched}>
          {autoOn
            ? countdown != null
              ? `auto [${countdown}s]`
              : `auto [${interval}s]`
            : 'auto'}
        </Btn>
        <Btn danger onClick={onClearLog} fill>clear</Btn>
        <Btn onClick={onOpenSettings} fill>⚙</Btn>
        <Btn onClick={onOpenUsage} fill>$</Btn>
        <Btn onClick={onOpenNotams} fill>NOTAMs</Btn>
      </div>

      <div className="flex gap-1 items-center w-full sm:w-auto sm:shrink-0">
        {REGIONS.map(r => (
          <Btn key={r} active={region === r} onClick={() => onRegionChange(r)} fill>
            {r}
          </Btn>
        ))}
      </div>
    </div>
  )
}
