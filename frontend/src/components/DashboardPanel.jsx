import { useState, useEffect, useCallback } from 'react'
import AnomalyFeed from './dashboard/AnomalyFeed'
import StatsCards from './dashboard/StatsCards'
import ActivityChart from './dashboard/ActivityChart'
import WeatherStatus from './dashboard/WeatherStatus'
import ServiceHealth from './dashboard/ServiceHealth'
import DocsPanel from './dashboard/DocsPanel'
import HeatMap from './dashboard/HeatMap'
import TopTraffic from './dashboard/TopTraffic'
import {
  fetchAnomalyFeed,
  fetchAnomalyStats,
  fetchSightingStats,
  fetchHourlyActivity,
} from '../services/dashboard'

const POLL_INTERVAL = 30_000

export default function DashboardPanel({ backendOk }) {
  const [anomalies, setAnomalies] = useState([])
  const [anomalyStats, setAnomalyStats] = useState(null)
  const [sightingStats, setSightingStats] = useState(null)
  const [hourly, setHourly] = useState([])
  const [showDocs, setShowDocs] = useState(false)

  const refresh = useCallback(async () => {
    if (!backendOk) return
    try {
      const [a, as2, ss, h] = await Promise.all([
        fetchAnomalyFeed(50),
        fetchAnomalyStats(),
        fetchSightingStats(),
        fetchHourlyActivity(),
      ])
      setAnomalies(a)
      setAnomalyStats(as2)
      setSightingStats(ss)
      setHourly(h)
    } catch {}
  }, [backendOk])

  useEffect(() => {
    if (!backendOk) return
    refresh()
    const id = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [backendOk, refresh])

  const anomalyHourly = anomalyStats?.hourly || []

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
        <WeatherStatus region="usa" backendOk={backendOk} />
        <ServiceHealth backendOk={backendOk} />
      </div>

      {/* Heatmap — full width */}
      <HeatMap backendOk={backendOk} region="usa" />

      {/* Content — 3 columns on desktop, stacked on mobile */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border p-px">
        <AnomalyFeed anomalies={anomalies} />
        <StatsCards stats={sightingStats} anomalyStats={anomalyStats} />
        <ActivityChart hourly={hourly} anomalyHourly={anomalyHourly} />
      </div>

      {/* Bottom row — top traffic */}
      <TopTraffic backendOk={backendOk} />

      {showDocs && <DocsPanel onClose={() => setShowDocs(false)} />}
    </div>
  )
}
