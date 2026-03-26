import { useState, useEffect } from 'react'
import clsx from 'clsx'

const BADGE_CLASSES = {
  opensky:  'text-grn border border-grn',
  apl:      'text-mag border border-mag',
  adsbx:    'text-acc border border-acc',
  fallback: 'text-ylw border border-ylw',
}

function fmtElapsed(ms) {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m ago`
}

export default function TopBar({ stats, source, backendOk, autoOn, lastFetchAt }) {
  const [time, setTime] = useState('')
  const [elapsed, setElapsed] = useState(null)

  useEffect(() => {
    const tick = () => {
      setTime(new Date().toISOString().substring(11, 19) + ' utc')
      if (lastFetchAt) setElapsed(Date.now() - lastFetchAt)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastFetchAt])

  const badgeClass = BADGE_CLASSES[source] || BADGE_CLASSES.opensky

  return (
    <div className="bg-bg2 border-b border-border py-0.5 px-1.5 sm:px-2.5 flex justify-between items-center flex-nowrap overflow-x-auto gap-1 text-[10px] sm:text-[11px] text-fg2 shrink-0">
      <div className="flex gap-2 sm:gap-3.5 items-center shrink-0">
        <span className="text-acc">flightterm</span>
        <span className="text-fg3 hidden sm:inline">by <a href="https://github.com/wuwwa" target="_blank" rel="noopener noreferrer" className="text-fg3 hover:text-acc hover:underline">wuwwa</a></span>
        <span className="text-border2 hidden sm:inline">|</span>
        <span>aircraft: <span className="text-fg">{stats.total ?? '--'}</span></span>
        <span className="hidden sm:inline">airborne: <span className="text-grn">{stats.airborne ?? '--'}</span></span>
        <span className="hidden sm:inline">grounded: <span className="text-ylw">{stats.grounded ?? '--'}</span></span>
        <span className="hidden sm:inline">region: <span className="text-fg">{stats.region ?? 'global'}</span></span>
        <span className="hidden md:inline">enriched: <span className="text-fg">{stats.enriched ?? 0}</span></span>
      </div>
      <div className="flex gap-1.5 sm:gap-2.5 items-center shrink-0">
        {stats.lastUpdate && (
          <span className="text-fg3 hidden sm:inline">updated {stats.lastUpdate}</span>
        )}
        <span className={clsx('px-1.5 py-px text-[10px]', badgeClass)}>{source}</span>
        {autoOn ? (
          <span className="animate-blink text-grn text-[10px]">● live</span>
        ) : (
          <>
            <span className={clsx('text-[10px]', backendOk ? 'text-grn' : 'text-red')}>
              {backendOk ? '●' : '○'}
            </span>
            <span className="text-[10px] text-fg3">
              {elapsed != null ? fmtElapsed(elapsed) : 'idle'}
            </span>
          </>
        )}
        <span className="text-fg2">{time}</span>
      </div>
    </div>
  )
}
