import { useState, useEffect, useCallback } from 'react'
import AnomalyFeed from './dashboard/AnomalyFeed'
import StatsCards from './dashboard/StatsCards'
import WeatherStatus from './dashboard/WeatherStatus'
import ServiceHealth from './dashboard/ServiceHealth'
import DocsPanel from './dashboard/DocsPanel'
import HeatMap from './dashboard/HeatMap'
import AnomalyDrilldown from './dashboard/AnomalyDrilldown'
import ZoneMetrics from './dashboard/ZoneMetrics'
import ZoneDrilldown from './dashboard/ZoneDrilldown'
import {
  fetchAnomalyFeed,
  fetchAnomalyStats,
  fetchAnomalyHotspots,
  fetchSightingStats,
  fetchDbMetrics,
} from '../services/dashboard'

const POLL_INTERVAL = 30_000

export default function DashboardPanel({ backendOk, region: appRegion, lastFetchAt }) {
  const [anomalies, setAnomalies] = useState([])
  const [anomalyStats, setAnomalyStats] = useState(null)
  const [sightingStats, setSightingStats] = useState(null)
  const [dbMetrics, setDbMetrics] = useState(null)
  const [hotspots, setHotspots] = useState([])
  const [showDocs, setShowDocs] = useState(false)
  const [selectedAnomaly, setSelectedAnomaly] = useState(null)
  const [selectedZone, setSelectedZone] = useState(null)

  const refresh = useCallback(async () => {
    if (!backendOk) return
    try {
      const [a, as2, ss, dbm, hs] = await Promise.all([
        fetchAnomalyFeed(50),
        fetchAnomalyStats(),
        fetchSightingStats(),
        fetchDbMetrics(),
        fetchAnomalyHotspots(168, 2),
      ])
      setAnomalies(a)
      setAnomalyStats(as2)
      setSightingStats(ss)
      setDbMetrics(dbm)
      setHotspots(hs)
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
    setSelectedZone(null)
    setSelectedAnomaly(prev => prev?.icao === anomaly.icao ? null : anomaly)
  }, [])

  // Select by ICAO (from repeat offenders) — find most recent anomaly for this aircraft
  const handleSelectIcao = useCallback((icao, callsign) => {
    setSelectedZone(null)
    const match = anomalies.find(a => a.icao === icao)
    if (match) {
      setSelectedAnomaly(prev => prev?.icao === icao ? null : match)
    } else {
      setSelectedAnomaly(prev => prev?.icao === icao ? null : { icao, callsign })
    }
  }, [anomalies])

  const handleSelectZone = useCallback((zone) => {
    setSelectedAnomaly(null)
    setSelectedZone(prev => prev?.lat === zone.lat && prev?.lon === zone.lon ? null : zone)
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
      <HeatMap backendOk={backendOk} region={appRegion || 'usa'} lastFetchAt={lastFetchAt} onSelect={handleAnomalyClick} />

      {/* Main content: feed sidebar + drilldown/stats right */}
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] md:grid-rows-[1fr] gap-px bg-border">
        {/* Left: anomaly feed — matches right column height */}
        <div className="relative">
          <div className="md:absolute md:inset-0">
            <AnomalyFeed anomalies={anomalies} onSelect={handleAnomalyClick} selectedIcao={selectedAnomaly?.icao} />
          </div>
        </div>

        {/* Right: investigation panel + stats — drives row height */}
        <div className="bg-bg1">
          <AnomalyDrilldown anomaly={selectedAnomaly} onClose={() => setSelectedAnomaly(null)} />
          <ZoneMetrics hotspots={hotspots} onSelectZone={handleSelectZone} selectedZone={selectedZone} />
          {selectedZone && (
            <ZoneDrilldown zone={selectedZone} onSelectAnomaly={handleAnomalyClick} onClose={() => setSelectedZone(null)} />
          )}
          <StatsCards stats={sightingStats} anomalyStats={anomalyStats} dbMetrics={dbMetrics} onSelectIcao={handleSelectIcao} />
        </div>
      </div>

      {showDocs && <DocsPanel onClose={() => setShowDocs(false)} />}
    </div>
  )
}
