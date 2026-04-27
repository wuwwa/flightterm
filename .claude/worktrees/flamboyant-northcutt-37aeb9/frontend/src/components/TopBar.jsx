import { useState, useEffect } from 'react'
import clsx from 'clsx'

export default function TopBar({ stats, backendOk, lastFetchAt }) {
  const [time, setTime] = useState('')

  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().substring(11, 19) + ' utc')
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="bg-bg2 border-b border-border py-0.5 px-1.5 sm:px-2.5 flex justify-between items-center flex-nowrap overflow-x-auto gap-1 text-[10px] sm:text-[11px] text-fg2 shrink-0">
      <div className="flex gap-2 sm:gap-3.5 items-center shrink-0">
        <span className="text-acc">flightterm</span>
        <span className="text-fg3 hidden sm:inline">by wuwwa</span>
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
        {backendOk && lastFetchAt ? (
          <span className="animate-blink text-grn text-[10px]">● live</span>
        ) : (
          <span className={clsx('text-[10px]', backendOk ? 'text-ylw' : 'text-red')}>
            {backendOk ? '○ connecting' : '○ offline'}
          </span>
        )}
        <span className="text-fg2">{time}</span>
      </div>
    </div>
  )
}
