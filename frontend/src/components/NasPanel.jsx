import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'
import NasStatus from './dashboard/NasStatus'
import NotamPanel from './dashboard/NotamPanel'
import ItwsPanel from './dashboard/ItwsPanel'
import LiveFeed from './dashboard/LiveFeed'

export default function NasPanel({ backendOk, region }) {
  const [collapsed, setCollapsed] = useState(false)
  const { status, wakeSwim, wakeState } = useSwim()
  const feeds = status?.feeds || {}
  const connectedCount = Object.values(feeds).filter(f => f?.connected).length
  const totalFeeds = Object.keys(feeds).length
  const workerConnected = Boolean(status?.workerConnected)
  const wakeBusy = ['starting', 'cooldown'].includes(wakeState?.state)
  const wakeLabel = wakeState?.state === 'cooldown' ? 'wake pending' : wakeBusy ? 'starting swim' : 'wake swim'
  const showWake = backendOk && !workerConnected

  return (
    <div className="bg-bg1 border-t-2 border-grn/40">
      {/* Header */}
      <div
        className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="text-grn text-[9px] tracking-wider uppercase font-bold">FAA SWIM</span>

        {totalFeeds > 0 && (
          <span className={clsx(
            'text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border',
            connectedCount === totalFeeds ? 'bg-grn/15 text-grn border-grn/40'
              : connectedCount > 0 ? 'bg-ylw/15 text-ylw border-ylw/40'
              : 'bg-red/15 text-red border-red/40'
          )}>
            {connectedCount}/{totalFeeds} feeds
          </span>
        )}

        <span className="text-fg3 text-[9px]">NAS health · NOTAMs · live feed · terminal weather</span>
        {showWake && (
          <button
            className={clsx(
              'ml-auto text-[9px] uppercase tracking-wide px-2 py-0.5 border transition-colors',
              wakeBusy ? 'text-ylw border-ylw/40 cursor-wait' : 'text-cyn border-cyn/40 hover:bg-cyn/10'
            )}
            onClick={(e) => {
              e.stopPropagation()
              if (!wakeBusy) wakeSwim().catch(() => {})
            }}
            disabled={wakeBusy}
            title="Start the stopped SWIM worker machine"
          >
            {wakeLabel}
          </button>
        )}
        <span className={clsx('text-fg3 text-[9px]', !showWake && 'ml-auto')}>{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1.5fr] md:grid-rows-1 gap-px bg-border md:h-48">
          <NasStatus backendOk={backendOk} />
          <NotamPanel backendOk={backendOk} />
          <LiveFeed backendOk={backendOk} />
          <ItwsPanel backendOk={backendOk} />
        </div>
      )}
    </div>
  )
}
