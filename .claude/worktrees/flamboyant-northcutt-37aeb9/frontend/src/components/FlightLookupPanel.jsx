import { useState } from 'react'
import FlightLookup from './dashboard/FlightLookup'

export default function FlightLookupPanel({ backendOk }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="bg-bg1 border-t border-border">
      {/* Header */}
      <div
        className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="text-acc text-[9px] tracking-wider uppercase font-bold">flight lookup</span>
        <span className="text-fg3 text-[9px]">TFMS flight plans · search by callsign</span>
        <span className="ml-auto text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div className="md:h-72">
          <FlightLookup backendOk={backendOk} />
        </div>
      )}
    </div>
  )
}
