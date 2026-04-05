import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'

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
  const [swimStatus, setSwimStatus] = useState(null)
  const [remaining, setRemaining] = useState(null)

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

  // SWIM status (light poll)
  useEffect(() => {
    if (!backendOk) return
    const refresh = () => axios.get('/api/swim/status').then(r => setSwimStatus(r.data)).catch(() => {})
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [backendOk])

  const tfms = swimStatus?.tfms
  const notams = swimStatus?.notams
  const feeds = swimStatus?.feeds || {}
  const connectedFeeds = Object.entries(feeds).filter(([, f]) => f?.connected).map(([k]) => k)

  return (
    <div className="bg-bg2 border-b border-border py-0.5 px-1.5 sm:px-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] shrink-0">
      {/* Left: branding + key stats */}
      <span className="text-acc font-bold text-[11px]">flightterm</span>
      <span className="text-border2 hidden sm:inline">|</span>
      <span className="text-fg2">{stats.total ?? '--'} <span className="text-fg3">ac</span></span>
      <span className="text-grn hidden sm:inline">{stats.airborne ?? '--'} <span className="text-fg3">air</span></span>

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
        <span className="text-fg2 hidden sm:inline text-[10px]">{tfms.active_flights} <span className="text-fg3">flights</span></span>
      )}
      {tfms?.active_gs > 0 && <span className="text-red font-bold text-[10px]">{tfms.active_gs} GS</span>}
      {tfms?.active_gdps > 0 && <span className="text-ylw text-[10px]">{tfms.active_gdps} GDP</span>}
      {notams?.active_tfrs > 0 && <span className="text-red text-[10px]">{notams.active_tfrs} TFR</span>}

      {/* Filter — grows to fill */}
      <div className="flex items-center gap-1 flex-1 min-w-24 sm:min-w-32 ml-1">
        <span className="text-grn select-none text-[11px]">❯</span>
        <input
          className="bg-transparent border-none outline-none text-fg text-[11px] flex-1 caret-fg font-mono min-w-0"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="filter"
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
