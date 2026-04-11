import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'

const REGIONS = ['global', 'usa', 'europe', 'asia', 'atlantic']

function Pill({ children, active, danger, onClick }) {
  return (
    <button
      className={clsx(
        'text-[10px] py-0 px-1.5 border transition-colors',
        danger ? 'border-border text-red hover:border-red/50'
          : active ? 'border-acc/60 text-acc'
          : 'border-border text-fg3 hover:text-fg2 hover:border-border2',
      )}
      onClick={onClick}
    >{children}</button>
  )
}

export default function CommandBar({
  stats, backendOk, lastFetchAt, pollInterval,
  filter, onFilterChange,
  onClearLog, onOpenSettings, onOpenUsage,
  region, onRegionChange,
}) {
  const [time, setTime] = useState('')
  const [remaining, setRemaining] = useState(null)
  const { status: swimStatus } = useSwim()

  // UTC clock
  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().substring(11, 19) + 'z')
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Poll countdown
  useEffect(() => {
    if (!lastFetchAt) { setRemaining(null); return }
    const intervalSec = Math.round((pollInterval || 45000) / 1000)
    const tick = () => setRemaining(Math.max(0, intervalSec - Math.floor((Date.now() - lastFetchAt) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastFetchAt, pollInterval])

  const tfms = swimStatus?.tfms
  const notams = swimStatus?.notams
  const feeds = swimStatus?.feeds || {}
  const connectedFeeds = Object.entries(feeds).filter(([, f]) => f?.connected).map(([k]) => k)

  return (
    <div className="bg-bg2 border-b border-border py-1 px-1.5 sm:px-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] shrink-0">
      {/* Left: branding + headline counts */}
      <span className="text-acc text-[13px] tracking-tight">flightterm</span>
      <span className="text-border2 hidden sm:inline">|</span>
      <span className="flex items-baseline gap-0.5">
        <span className="text-fg tabular-nums text-[12px]">{(stats.total ?? 0).toLocaleString()}</span>
        <span className="text-fg3 text-[8px] uppercase tracking-wide">ac</span>
      </span>
      <span className="hidden sm:flex items-baseline gap-0.5">
        <span className="text-grn tabular-nums text-[12px]">{(stats.airborne ?? 0).toLocaleString()}</span>
        <span className="text-fg3 text-[8px] uppercase tracking-wide">air</span>
      </span>

      {/* SWIM feed indicators — individual dots per feed */}
      <span className="text-border2 hidden sm:inline">|</span>
      <div className="hidden sm:flex items-center gap-1.5 text-[9px]">
        {['fns', 'tfms', 'sfdps', 'itws', 'stdds'].map(name => {
          const f = feeds[name]
          const on = f?.connected
          return (
            <span key={name} className="flex items-center gap-0.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? 'bg-grn' : f?.enabled ? 'bg-red' : 'bg-fg3/30'}`} />
              <span className={on ? 'text-fg3' : 'text-fg3/30'}>{name.toUpperCase()}</span>
            </span>
          )
        })}
      </div>
      {tfms?.active_flights > 0 && (
        <span className="hidden sm:flex items-baseline gap-0.5">
          <span className="text-fg2 tabular-nums text-[11px]">{tfms.active_flights.toLocaleString()}</span>
          <span className="text-fg3 text-[8px] uppercase tracking-wide">flights</span>
        </span>
      )}
      {tfms?.active_gs > 0 && (
        <span className="bg-red/15 text-red text-[9px] uppercase px-1.5 py-px rounded border border-red/40 animate-pulse">
          {tfms.active_gs} GS
        </span>
      )}
      {tfms?.active_gdps > 0 && (
        <span className="bg-ylw/15 text-ylw text-[9px] uppercase px-1.5 py-px rounded border border-ylw/40">
          {tfms.active_gdps} GDP
        </span>
      )}
      {notams?.active_tfrs > 0 && (
        <span className="bg-red/10 text-red text-[9px] uppercase px-1.5 py-px rounded border border-red/30">
          {notams.active_tfrs} TFR
        </span>
      )}

      {/* Filter — grows to fill */}
      <div className="flex items-center gap-1 flex-1 min-w-24 sm:min-w-32 ml-1">
        <span className="text-grn select-none text-[11px]">❯</span>
        <input
          className="bg-transparent border-none outline-none text-fg text-[11px] flex-1 caret-fg font-mono min-w-0 placeholder:text-fg3/30"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="callsign, icao, airline, type, airport…"
        />
      </div>

      {/* Region selector */}
      <div className="flex gap-0.5 items-center">
        {REGIONS.map(r => (
          <Pill key={r} active={region === r} onClick={() => onRegionChange(r)}>{r}</Pill>
        ))}
      </div>

      {/* Controls */}
      <span className="text-border2">|</span>
      <Pill onClick={onOpenSettings}>settings</Pill>
      <Pill onClick={onOpenUsage}>usage</Pill>
      <Pill danger onClick={onClearLog}>clear</Pill>

      {/* Right: live status + clock */}
      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        {remaining != null && (
          <span className={clsx(
            'tabular-nums',
            remaining > 0 ? 'text-grn' : 'text-ylw animate-pulse'
          )}>
            {remaining > 0 ? `${remaining}s` : 'now'}
          </span>
        )}
        {backendOk && lastFetchAt ? (
          <span className="animate-blink text-grn">●</span>
        ) : (
          <span className={backendOk ? 'text-ylw' : 'text-red'}>○</span>
        )}
        <span className="text-fg3 tabular-nums">{time}</span>
      </div>
    </div>
  )
}
