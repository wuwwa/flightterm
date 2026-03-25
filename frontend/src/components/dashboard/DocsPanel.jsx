import { useEffect } from 'react'
import clsx from 'clsx'

const SECTIONS = [
  {
    title: 'Anomaly Categories',
    items: [
      { term: 'SQUAWK',    color: 'text-red', desc: 'Aircraft broadcasting emergency squawk codes — 7700 (general emergency), 7600 (radio failure/NORDO), 7500 (hijack/unlawful interference).' },
      { term: 'EMERGENCY', color: 'text-red', desc: 'Aircraft declaring an emergency state — general, lifeguard, minimum fuel, NORDO, unlawful interference, or downed. Catches emergencies that don\'t use traditional squawk codes.' },
      { term: 'ALTITUDE',  color: 'text-cyn', desc: 'Rapid or abnormal altitude changes. Rate-normalized against phase of flight — a 5,000 ft/min descent during cruise is scored higher than during approach. Uses transponder-reported vertical rate when available for higher accuracy.' },
      { term: 'SPEED',     color: 'text-ylw', desc: 'Sudden velocity changes. Scored by percentage deviation from recent average. Speed alone never triggers an anomaly — it only contributes when another category is also present, since speed changes are often caused by wind, ATC, or turbulence.' },
      { term: 'HEADING',   color: 'text-mag', desc: 'Sharp heading discontinuity during cruise phase. A 60°+ heading change at altitude suggests an unplanned maneuver or avoidance.' },
      { term: 'DIVERSION', color: 'text-mag', desc: 'Route-aware detection powered by persistent route cache. Compares great-circle bearing to filed destination against actual heading. A 45°+ deviation during cruise = likely diversion. Works across all tracked aircraft, not just selected ones.' },
      { term: 'PHASE',     color: 'text-acc', desc: 'Unexpected phase transitions — e.g., aircraft re-entering climb after reaching cruise altitude, or sudden transition from cruise to rapid descent.' },
      { term: 'INTENT',    color: 'text-cyn', desc: 'MCP (Mode Control Panel) intent signals. Detects what the pilot has dialed into the autopilot before the maneuver shows in position data. A 10,000+ ft gap between MCP altitude and current altitude = emergency descent intent.' },
    ],
  },
  {
    title: 'Severity Tiers',
    items: [
      { term: 'CRITICAL', color: 'text-red', desc: 'Score 80+. Squawk emergencies, confirmed emergency field, hijack codes. Immediate attention required.' },
      { term: 'HIGH',     color: 'text-ylw', desc: 'Score 60+. Confirmed anomalies with multiple supporting signals, or high-scoring single events like rapid emergency descents.' },
      { term: 'MEDIUM',   color: 'text-fg2', desc: 'Score 35-59. Anomalous behavior detected but not yet confirmed across multiple fetch cycles. Most altitude/speed deviations start here.' },
      { term: 'LOW',      color: 'text-fg3', desc: 'Below threshold. Logged but not displayed in the feed. Minor deviations that don\'t warrant attention.' },
    ],
  },
  {
    title: 'Scoring Intelligence',
    items: [
      { term: 'Position confidence', color: 'text-cyn', desc: 'Scores are weighted by data source quality. ADS-B = full confidence. MLAT with <3 receivers = skipped entirely. MLAT with 3-4 = half weight. ASTERIX/FLARM = 70%. Prevents noisy position data from generating false anomalies.' },
      { term: 'Aircraft class',  color: 'text-cyn', desc: 'Scoring thresholds scale by aircraft type. Heavy jets (A5, 777/A380) have tighter tolerances — they shouldn\'t maneuver aggressively. Light aircraft (A1, Cessnas) get 2x wider thresholds. Gliders/balloons get 2.5x. Skydivers get 3x.' },
      { term: 'Altitude bands',  color: 'text-cyn', desc: 'Dynamic tolerance scaling by altitude. FL350+ = tightest (0.7x, any deviation matters). FL100-FL350 = baseline. 3,000-10,000ft = 1.5x wider. Below 3,000ft = 2x widest (approach/departure chaos is normal).' },
      { term: 'TOD suppression', color: 'text-cyn', desc: 'Aircraft within 200nm of their destination get progressively wider tolerances (up to 3x at the airport). Top-of-descent is where normal flights begin altitude/speed changes — scoring this area tightly would flood false positives. Same logic for departure climb within 55nm of origin.' },
      { term: 'Spatial context',  color: 'text-acc', desc: 'Compares each aircraft against nearby traffic within 100km and same altitude band. If neighbors are all maneuvering similarly with weather present → dampen (routine avoidance). If neighbors are deviating WITHOUT weather → boost 1.4x (area event signal). If one aircraft deviates while neighbors fly straight → boost 1.3x (lone outlier).' },
      { term: 'Weather correlation', color: 'text-acc', desc: 'Active SIGMETs and PIREPs reduce anomaly scores. Convective SIGMET nearby → 70% reduction. Turbulence SIGMET or severe PIREPs → 50%. Moderate PIREPs → 30%. Weather avoidance is normal — the scoring engine accounts for it.' },
      { term: 'Multi-fetch confirm', color: 'text-grn', desc: 'Anomaly must persist across 2+ consecutive observation cycles. A single spike might be data noise; confirmed means the behavior is sustained.' },
      { term: 'Speed suppression', color: 'text-fg3', desc: 'Speed changes alone are suppressed entirely. Speed only contributes when paired with another category like altitude or heading — eliminates noise from routine ATC, wind, and turbulence.' },
      { term: 'Military dampening', color: 'text-fg3', desc: 'Reduced scoring for military aircraft on non-emergency anomalies. Military flights routinely perform maneuvers that look anomalous for civilian traffic.' },
      { term: 'Airport proximity', color: 'text-fg3', desc: 'Reduced scoring near airports. Rapid altitude/speed changes during approach/departure are normal and expected.' },
    ],
  },
  {
    title: 'Route Cache & Diversion',
    items: [
      { term: 'Route cache',    color: 'text-acc', desc: 'Persistent callsign→route mapping stored in the backend database. Grows over time as flights are enriched. Enables diversion detection for all tracked aircraft, not just the one you clicked on.' },
      { term: 'Background enrichment', color: 'text-acc', desc: 'Unknown callsigns are queued and looked up at 1 request/sec via ADSBdb and hexdb.io. Results are saved to the backend cache. Non-blocking — runs in the background during normal operation.' },
      { term: 'Stale detection', color: 'text-ylw', desc: 'Cruising aircraft with heading >60° from their cached destination are flagged. The stale cache entry is deleted and the callsign is re-queued for fresh enrichment. Self-correcting system.' },
      { term: 'Diversion signal', color: 'text-mag', desc: 'When route data is available, a 45°+ heading deviation from the great-circle bearing to the destination during cruise triggers a diversion flag. One of the strongest anomaly signals available.' },
    ],
  },
  {
    title: 'Weather Hazards',
    items: [
      { term: 'SIGMET',     color: 'text-red', desc: 'Significant Meteorological Information. Urgent FAA/NWS advisories for conditions dangerous to all aircraft — convective (thunderstorms), turbulence, or icing in a defined area with a validity window.' },
      { term: 'Convective', color: 'text-red', desc: 'SIGMET subtype. Active thunderstorm activity — severe storms, hail, tornadoes. The most dangerous weather category.' },
      { term: 'PIREP',      color: 'text-ylw', desc: 'Pilot Report. Real-time reports from pilots in the air about actual conditions experienced — turbulence intensity, icing, flight level. Ground truth, not forecasts.' },
      { term: 'Turbulence',  color: 'text-ylw', desc: 'Scaled LGT → MOD → SEV → EXTREME. We filter for MOD+ to reduce noise. Includes type: CAT (clear air), chop, mountain wave.' },
      { term: 'Icing',      color: 'text-cyn', desc: 'Ice accumulation on aircraft surfaces. Scaled NEG → TRC → LGT → MOD → SEV. Types: rime, clear, mixed. Dangerous above MOD.' },
      { term: 'WX tag',     color: 'text-fg3', desc: 'Shown on anomaly feed entries when weather data was captured at detection time. Provides context — an altitude anomaly near a convective SIGMET likely indicates weather avoidance, not something suspicious.' },
    ],
  },
  {
    title: 'Anomaly Map',
    items: [
      { term: 'Plane icons',  color: 'text-red', desc: 'Each anomaly appears as an aircraft icon on the map, rotated to match heading. Icon size and color reflect severity — red (critical), yellow (high), gray (medium).' },
      { term: 'SIGMET areas', color: 'text-red', desc: 'Dashed polygon outlines showing active SIGMET boundaries. Red = convective (thunderstorms), yellow = turbulence, cyan = icing. Semi-transparent fill shows affected area.' },
      { term: 'PIREP markers', color: 'text-ylw', desc: 'Small diamond markers showing pilot-reported conditions. Color indicates intensity — red for severe, yellow for moderate. Diamonds are used because PIREPs are point observations, not area coverage.' },
      { term: 'WX toggle',   color: 'text-acc', desc: 'The WX ON/OFF button in the map header controls weather overlay visibility. SIGMETs and PIREPs can be toggled off to focus on anomalies alone.' },
      { term: 'Region',      color: 'text-fg3', desc: 'Map auto-fits to the cluster of active anomalies on first load. Drag and zoom to explore. Weather data is filtered to the selected region bounding box.' },
    ],
  },
  {
    title: 'Service Health',
    items: [
      { term: 'Status dots',  color: 'text-grn', desc: 'Green = last request succeeded. Yellow = no traffic yet (awaiting first call). Red = last request failed. Gray = not configured.' },
      { term: 'Passive tracking', color: 'text-fg3', desc: 'Health is determined from actual data requests, not synthetic probes. If you haven\'t searched for anything using a particular service, it shows as unknown until real traffic flows through.' },
      { term: 'Latency',     color: 'text-fg3', desc: 'Response time of the last successful request to each service. Helps identify slow or degraded APIs before they fully fail.' },
    ],
  },
  {
    title: 'Metrics',
    items: [
      { term: 'Score',       color: 'text-red', desc: 'Numeric severity (0-100+). Composite of all triggered rules after position confidence, class, altitude, proximity, spatial, and weather adjustments. Higher = more anomalous.' },
      { term: 'MTTR',        color: 'text-fg3', desc: 'Mean Time To Resolution. Average minutes between anomaly detection and resolution (aircraft returns to normal behavior). Lower = more transient events.' },
      { term: 'Anomaly rate', color: 'text-fg3', desc: 'Anomalies per 100 tracked aircraft. Normalizes for fleet size — useful for comparing across regions or time periods.' },
    ],
  },
  {
    title: 'Data Sources',
    items: [
      { term: 'OpenSky',    color: 'text-acc', desc: 'Primary flight data source. ADS-B crowd-sourced network providing position, altitude, velocity, heading, squawk, callsign, vertical rate, position source, and receiver count.' },
      { term: 'adsb.fi',    color: 'text-acc', desc: 'Aircraft enrichment. Registration, type, operator, year, MCP settings, emergency field, military flag, and emitter category (used for aircraft class normalization).' },
      { term: 'ADSBdb',     color: 'text-acc', desc: 'Aircraft database. Maps ICAO hex codes to aircraft details and callsigns to origin/destination routes. Primary source for the route cache.' },
      { term: 'hexdb.io',   color: 'text-acc', desc: 'Route lookup fallback. Provides origin-destination pairs when ADSBdb doesn\'t have route data.' },
      { term: 'AvnWx',      color: 'text-acc', desc: 'aviationweather.gov. FAA weather data — METARs, PIREPs, SIGMETs. Updated every minute. Feeds into weather correlation scoring.' },
      { term: 'AeroAPI',    color: 'text-acc', desc: 'FlightAware premium data. Detailed flight plans and historical tracks. On-demand, pay-per-call.' },
      { term: 'S3 Archive',  color: 'text-acc', desc: 'Sightings, anomalies, and daily summaries are archived to S3 before purge. Local SQLite retains only 3 hours of data. S3 provides long-term history for future analysis.' },
    ],
  },
]

export default function DocsPanel({ onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-1100 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-bg1 border border-border rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-bg2 border-b border-border py-2 px-4 flex items-center justify-between shrink-0">
          <div>
            <span className="text-acc text-[12px] font-bold tracking-wider uppercase">documentation</span>
            <span className="text-fg3 text-[10px] ml-2">scoring, detection, routes, weather & data sources</span>
          </div>
          <button className="text-fg3 hover:text-fg1 text-sm px-2" onClick={onClose}>ESC</button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-4 space-y-4">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="text-[11px] text-acc font-bold tracking-wider uppercase mb-2 border-b border-border pb-1">
                {section.title}
              </div>
              <div className="space-y-1.5">
                {section.items.map((item) => (
                  <div key={item.term} className="flex gap-2 text-[10px]">
                    <span className={clsx('shrink-0 font-bold w-28 text-right', item.color)}>
                      {item.term}
                    </span>
                    <span className="text-fg2">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
