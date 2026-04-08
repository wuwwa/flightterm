import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'
import NasStatus from './dashboard/NasStatus'
import NotamPanel from './dashboard/NotamPanel'
import ItwsPanel from './dashboard/ItwsPanel'
import LiveFeed from './dashboard/LiveFeed'

export default function NasPanel({ backendOk, region }) {
  const [collapsed, setCollapsed] = useState(false)
  const { status } = useSwim()
  const feeds = status?.feeds || {}
  const connectedCount = Object.values(feeds).filter(f => f?.connected).length
  const totalFeeds = Object.keys(feeds).length

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
        <span className="ml-auto text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
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
