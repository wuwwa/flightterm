import { useState, useEffect, useCallback } from 'react'
import AnomalyFeed from './dashboard/AnomalyFeed'
import StatsCards from './dashboard/StatsCards'
import WeatherStatus from './dashboard/WeatherStatus'
import ServiceHealth from './dashboard/ServiceHealth'
import DocsPanel from './dashboard/DocsPanel'
import HeatMap from './dashboard/HeatMap'
import AnomalyDrilldown from './dashboard/AnomalyDrilldown'
import {
  fetchAnomalyFeed,
  fetchAnomalyStats,
  fetchSightingStats,
} from '../services/dashboard'

const POLL_INTERVAL = 30_000

export default function DashboardPanel({ backendOk, activeSource, region: appRegion, lastFetchAt }) {
  const [anomalies, setAnomalies] = useState([])
  const [anomalyStats, setAnomalyStats] = useState(null)
  const [sightingStats, setSightingStats] = useState(null)
  const [showDocs, setShowDocs] = useState(false)
  const [selectedAnomaly, setSelectedAnomaly] = useState(null)

  const refresh = useCallback(async () => {
    if (!backendOk) return
    try {
      const [a, as2, ss] = await Promise.all([
        fetchAnomalyFeed(50),
        fetchAnomalyStats(),
        fetchSightingStats(),
      ])
      setAnomalies(a)
      setAnomalyStats(as2)
      setSightingStats(ss)
    } catch {}
  }, [backendOk])

  useEffect(() => {
    if (!backendOk) return
    refresh()
    const id = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [backendOk, refresh])

  const handleAnomalyClick = useCallback((anomaly) => {
    if (!anomaly?.icao) return
    setSelectedAnomaly(prev => prev?.icao === anomaly.icao ? null : anomaly)
  }, [])

  return (
    <div className="min-h-screen bg-bg1 border-t border-border">
      {/* Header */}
      <div className="bg-bg2 border-b border-border py-1.5 px-3 flex items-center gap-2">
        <span className="text-acc text-[11px] font-bold tracking-wider uppercase">dashboard</span>
        <span className="text-fg3 text-[10px]">anomaly analytics · 24h window</span>
        <button
          onClick={() => setShowDocs(true)}
          className="ml-auto text-[10px] text-fg3 hover:text-acc border border-border hover:border-acc/50 px-2 py-0.5 rounded transition-colors"
        >
          DOCS
        </button>
      </div>

      {/* Status bars — weather + service health side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        <WeatherStatus region={appRegion || 'usa'} backendOk={backendOk} />
        <ServiceHealth backendOk={backendOk} />
      </div>

      {/* Heatmap — full width */}
      <HeatMap backendOk={backendOk} region={appRegion || 'usa'} activeSource={activeSource} lastFetchAt={lastFetchAt} onSelect={handleAnomalyClick} />

      {/* Main content: feed sidebar + drilldown/stats right */}
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-px bg-border">
        {/* Left: anomaly feed */}
        <AnomalyFeed anomalies={anomalies} onSelect={handleAnomalyClick} selectedIcao={selectedAnomaly?.icao} />

        {/* Right: investigation panel + stats */}
        <div className="bg-bg1">
          <AnomalyDrilldown anomaly={selectedAnomaly} onClose={() => setSelectedAnomaly(null)} />
          <StatsCards stats={sightingStats} anomalyStats={anomalyStats} />
        </div>
      </div>

      {showDocs && <DocsPanel onClose={() => setShowDocs(false)} />}
    </div>
  )
}
