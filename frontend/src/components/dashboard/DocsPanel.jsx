import { useEffect } from 'react'
import clsx from 'clsx'

const SECTIONS = [
  {
    title: 'Anomaly Categories',
    items: [
      { term: 'SQUAWK',    color: 'text-red', desc: 'Aircraft broadcasting emergency squawk codes — 7700 (general emergency), 7600 (radio failure/NORDO), 7500 (hijack/unlawful interference).' },
      { term: 'EMERGENCY', color: 'text-red', desc: 'Aircraft declaring an emergency state — general, lifeguard, minimum fuel, NORDO, unlawful interference, or downed. Catches emergencies that don\'t use traditional squawk codes.' },
      { term: 'ALTITUDE',  color: 'text-cyn', desc: 'Rapid or abnormal altitude changes. Rate-normalized against phase of flight — a 5,000 ft/min descent during cruise is scored higher than during approach.' },
      { term: 'SPEED',     color: 'text-ylw', desc: 'Sudden velocity changes. Scored by percentage deviation from recent average. Speed alone never triggers an anomaly — it only contributes when another category is also present, since speed changes are often caused by wind, ATC, or turbulence.' },
      { term: 'HEADING',   color: 'text-mag', desc: 'Sharp heading discontinuity during cruise phase. A 60°+ heading change at altitude suggests an unplanned maneuver or avoidance.' },
      { term: 'DIVERSION', color: 'text-mag', desc: 'Route-aware detection. Compares great-circle bearing to filed destination against actual heading. A 45°+ deviation during cruise = likely diversion.' },
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
    title: 'Scoring & Detection',
    items: [
      { term: 'Confirmed',   color: 'text-grn', desc: 'Anomaly persists across 2+ consecutive observation cycles. A single spike might be data noise; confirmed means the behavior is sustained.' },
      { term: 'Score',       color: 'text-red', desc: 'Numeric severity (0-100+). Composite of all triggered rules. Higher = more anomalous. Multiple categories stack.' },
      { term: 'Military dampening', color: 'text-fg3', desc: 'Reduced scoring for military aircraft on non-emergency anomalies. Military flights routinely perform maneuvers that look anomalous for civilian traffic.' },
      { term: 'Airport proximity', color: 'text-fg3', desc: 'Reduced scoring near airports. Rapid altitude/speed changes during approach/departure are normal and expected.' },
      { term: 'Speed suppression', color: 'text-fg3', desc: 'Speed changes alone are suppressed entirely. Speed only contributes to an anomaly score when paired with another category like altitude or heading — this eliminates noise from routine ATC, wind, and turbulence events.' },
      { term: 'MTTR',        color: 'text-fg3', desc: 'Mean Time To Resolution. Average minutes between anomaly detection and resolution (aircraft returns to normal behavior). Lower = more transient events.' },
      { term: 'Anomaly rate', color: 'text-fg3', desc: 'Anomalies per 100 tracked aircraft. Normalizes for fleet size — useful for comparing across regions or time periods.' },
    ],
  },
  {
    title: 'Data Sources',
    items: [
      { term: 'OpenSky',    color: 'text-acc', desc: 'Primary flight data source. ADS-B crowd-sourced network providing position, altitude, velocity, heading, squawk, and callsign.' },
      { term: 'adsb.fi',    color: 'text-acc', desc: 'Aircraft enrichment. Registration, type, operator, year, MCP settings, emergency field, military flag.' },
      { term: 'ADSBdb',     color: 'text-acc', desc: 'Aircraft database. Maps ICAO hex codes to aircraft details and callsigns to origin/destination routes.' },
      { term: 'hexdb.io',   color: 'text-acc', desc: 'Route lookup fallback. Provides origin-destination pairs when primary route data is unavailable.' },
      { term: 'AvnWx',      color: 'text-acc', desc: 'aviationweather.gov. FAA weather data — METARs, PIREPs, SIGMETs. Updated every minute.' },
      { term: 'AeroAPI',    color: 'text-acc', desc: 'FlightAware premium data. Detailed flight plans and historical tracks. On-demand, pay-per-call.' },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-bg1 border border-border rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-bg2 border-b border-border py-2 px-4 flex items-center justify-between shrink-0">
          <div>
            <span className="text-acc text-[12px] font-bold tracking-wider uppercase">documentation</span>
            <span className="text-fg3 text-[10px] ml-2">terms, categories, map & data sources</span>
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
