import { useState, useEffect, useCallback } from 'react'
import AnomalyFeed from './dashboard/AnomalyFeed'
import StatsCards from './dashboard/StatsCards'
import WeatherStatus from './dashboard/WeatherStatus'
import DocsPanel from './dashboard/DocsPanel'
import NasMap from './dashboard/NasMap'
import AnomalyDrilldown from './dashboard/AnomalyDrilldown'
import ZoneMetrics from './dashboard/ZoneMetrics'
import ZoneDrilldown from './dashboard/ZoneDrilldown'
import ActivityChart from './dashboard/ActivityChart'
import {
  fetchAnomalyFeed,
  fetchAnomalyStats,
  fetchAnomalyHotspots,
  fetchSightingStats,
  fetchHourlyActivity,
} from '../services/dashboard'

const POLL_INTERVAL = 30_000

export default function DashboardPanel({ backendOk, region: appRegion, lastFetchAt }) {
  const [anomalies, setAnomalies] = useState([])
  const [anomalyStats, setAnomalyStats] = useState(null)
  const [sightingStats, setSightingStats] = useState(null)
  const [hotspots, setHotspots] = useState([])
  const [hourlyActivity, setHourlyActivity] = useState([])
  const [showDocs, setShowDocs] = useState(false)
  const [selectedAnomaly, setSelectedAnomaly] = useState(null)
  const [selectedZone, setSelectedZone] = useState(null)

  const refresh = useCallback(async () => {
    if (!backendOk) return
    try {
      const [a, as2, ss, hs, ha] = await Promise.all([
        fetchAnomalyFeed(50),
        fetchAnomalyStats(),
        fetchSightingStats(),
        fetchAnomalyHotspots(168, 2),
        fetchHourlyActivity(),
      ])
      setAnomalies(a)
      setAnomalyStats(as2)
      setSightingStats(ss)
      setHotspots(hs)
      setHourlyActivity(ha || [])
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
        <span className="text-red text-[11px] font-bold tracking-wider uppercase">anomaly analytics</span>
        <span className="text-fg3 text-[10px]">weather · detection · 24h window</span>
        <button
          onClick={() => setShowDocs(true)}
          className="ml-auto text-[10px] text-fg3 hover:text-acc border border-border hover:border-acc/50 px-2 py-0.5 rounded transition-colors"
        >
          DOCS
        </button>
      </div>

      {/* Weather hazards (aviationweather.gov) */}
      <WeatherStatus region={appRegion || 'usa'} backendOk={backendOk} />

      {/* US airspace map */}
      <NasMap backendOk={backendOk} />

      {/* Anomaly feed + charts/stats */}
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] md:grid-rows-[1fr] gap-px bg-border">
        <div className="relative">
          <div className="md:absolute md:inset-0">
            <AnomalyFeed anomalies={anomalies} onSelect={handleAnomalyClick} selectedIcao={selectedAnomaly?.icao} />
          </div>
        </div>
        <div className="bg-bg1">
          <ActivityChart hourly={hourlyActivity} anomalyHourly={anomalyStats?.hourly || []} />
          <ZoneMetrics hotspots={hotspots} onSelectZone={handleSelectZone} selectedZone={selectedZone} />
          <StatsCards stats={sightingStats} anomalyStats={anomalyStats} onSelectIcao={handleSelectIcao} />
        </div>
      </div>

      {/* Popout overlays */}
      {selectedAnomaly && <AnomalyDrilldown anomaly={selectedAnomaly} onClose={() => setSelectedAnomaly(null)} />}
      {selectedZone && <ZoneDrilldown zone={selectedZone} onSelectAnomaly={handleAnomalyClick} onClose={() => setSelectedZone(null)} />}
      {showDocs && <DocsPanel onClose={() => setShowDocs(false)} />}
    </div>
  )
}
