import { useState } from 'react'
import NasStatus from './dashboard/NasStatus'
import NotamPanel from './dashboard/NotamPanel'
import ItwsPanel from './dashboard/ItwsPanel'
import SurfaceOps from './dashboard/SurfaceOps'

export default function NasPanel({ backendOk }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="bg-bg1 border-t border-border">
      {/* Header */}
      <div
        className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="text-grn text-[9px] tracking-wider uppercase font-bold">FAA SWIM</span>
        <span className="text-fg3 text-[9px]">NAS health · NOTAMs · surface ops · terminal weather</span>
        <span className="ml-auto text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1.5fr] md:grid-rows-1 gap-px bg-border md:h-48">
          <NasStatus backendOk={backendOk} />
          <NotamPanel backendOk={backendOk} />
          <SurfaceOps backendOk={backendOk} />
          <ItwsPanel backendOk={backendOk} />
        </div>
      )}
    </div>
  )
}
