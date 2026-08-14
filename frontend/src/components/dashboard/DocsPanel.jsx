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
      { term: 'CRITICAL', color: 'text-red', desc: 'Score 80+. Squawk emergencies, confirmed emergency field, hijack codes. Bypasses persistence gating — emitted immediately. Immediate attention required.' },
      { term: 'HIGH',     color: 'text-ylw', desc: 'Score 60+. Confirmed anomalies with multiple supporting signals, or high-scoring single events like rapid emergency descents. Also bypasses persistence gating.' },
      { term: 'MEDIUM',   color: 'text-fg2', desc: 'Score 35-59. Must persist for 2 consecutive poll cycles (90 seconds) before being emitted. A single-sample spike is held back as pending — only sustained anomalies are shown.' },
      { term: 'LOW',      color: 'text-fg3', desc: 'Below threshold. Logged but not displayed in the feed. Minor deviations that don\'t warrant attention.' },
    ],
  },
  {
    title: 'Scoring Intelligence',
    items: [
      { term: 'Route baselines',   color: 'text-grn', desc: 'Per-route statistical profiles learned from historical sightings. For routes with enough data (50+ data points, 3+ flights), the system uses the 95th percentile altitude rate actually observed on that route instead of generic phase norms. Rebuilt every 6 hours. Falls back to static norms for unknown routes.' },
      { term: 'Correlated scoring', color: 'text-grn', desc: 'When altitude, speed, heading, and phase all change simultaneously, it\'s almost certainly a single ATC instruction — not multiple independent anomalies. The system takes the strongest kinematic signal + 25% of the rest, instead of summing them. Prevents a routine ATC-directed descent from triple-counting as altitude + speed + heading.' },
      { term: 'Phase transition',   color: 'text-grn', desc: 'When the phase detector detects a phase change (e.g., cruise → descent), non-emergency scores are dampened by 60%. This is the exact boundary where the phase detector lags behind reality and would otherwise generate the most false positives.' },
      { term: 'Recent volatility',  color: 'text-grn', desc: 'Computes standard deviation of vertical rates across the aircraft\'s recent snapshot history. Smooth aircraft get strict norms. Aircraft that have been oscillating (turbulence, terminal area) get proportionally wider tolerances — up to 2.5x. Uses the aircraft\'s own behavior to define "normal," not a static table.' },
      { term: 'Persistence gating', color: 'text-grn', desc: 'MEDIUM severity anomalies must score above threshold for 2 consecutive poll cycles (90 seconds) before being emitted. A single noisy transponder reading or GPS jitter no longer triggers an alert. CRITICAL/HIGH and already-active anomalies bypass the gate entirely.' },
      { term: 'Position confidence', color: 'text-cyn', desc: 'Scores are weighted by data source quality. ADS-B = full confidence. MLAT with <3 receivers = skipped entirely. MLAT with 3-4 = half weight. ASTERIX/FLARM = 70%. Prevents noisy position data from generating false anomalies.' },
      { term: 'Aircraft class',  color: 'text-cyn', desc: 'Scoring thresholds scale by aircraft type. Heavy jets (A5, 777/A380) have tighter tolerances — they shouldn\'t maneuver aggressively. Light aircraft (A1, Cessnas) get 2x wider thresholds. Gliders/balloons get 2.5x. Skydivers get 3x.' },
      { term: 'Altitude bands',  color: 'text-cyn', desc: 'Dynamic tolerance scaling by altitude. FL350+ = tightest (0.7x, any deviation matters). FL100-FL350 = baseline. 3,000-10,000ft = 1.5x wider. Below 3,000ft = 2x widest (approach/departure chaos is normal).' },
      { term: 'TOD suppression', color: 'text-cyn', desc: 'Aircraft within 200nm of their destination get progressively wider tolerances (up to 3x at the airport). Top-of-descent is where normal flights begin altitude/speed changes — scoring this area tightly would flood false positives. Same logic for departure climb within 55nm of origin.' },
      { term: 'Spatial context',  color: 'text-acc', desc: 'Compares each aircraft against nearby traffic within 100km — both heading and vertical rate. If neighbors are all maneuvering similarly (heading or altitude) with weather present → dampen (routine avoidance). Group deviation WITHOUT weather → boost 1.4x (area event). Lone deviant while neighbors fly straight → boost 1.3x.' },
      { term: 'Weather correlation', color: 'text-acc', desc: 'Active SIGMETs and PIREPs reduce anomaly scores. Convective SIGMET nearby → 70% reduction. Turbulence SIGMET or severe PIREPs → 50%. Moderate PIREPs → 30%. Weather avoidance is normal — the scoring engine accounts for it.' },
      { term: 'Speed suppression', color: 'text-fg3', desc: 'Speed changes alone are suppressed entirely. Speed only contributes when paired with another category like altitude or heading — eliminates noise from routine ATC, wind, and turbulence.' },
      { term: 'Military dampening', color: 'text-fg3', desc: 'Reduced scoring for military aircraft on non-emergency anomalies. Military flights routinely perform maneuvers that look anomalous for civilian traffic.' },
      { term: 'Airport proximity', color: 'text-fg3', desc: 'Reduced scoring near airports. Rapid altitude/speed changes during approach/departure are normal and expected.' },
    ],
  },
  {
    title: 'Route Cache & Diversion',
    items: [
      { term: 'Route cache',    color: 'text-acc', desc: 'Persistent callsign→route mapping stored in the backend database. Grows over time as flights are enriched. Enables diversion detection for all tracked aircraft, not just the one you clicked on.' },
      { term: 'Route baselines', color: 'text-grn', desc: 'Statistical profiles per origin-destination pair, learned from historical sightings. Captures 95th percentile altitude rate, speed mean/stddev, and typical cruise altitude for each route. Used instead of static phase norms when available.' },
      { term: 'Background enrichment', color: 'text-acc', desc: 'Unknown callsigns are queued and looked up at 1 request/sec via ADSBdb and adsb.fi. Results are saved to the backend cache. Non-blocking — runs in the background during normal operation.' },
      { term: 'Enrichment logging', color: 'text-fg3', desc: 'Each poll cycle logs how many aircraft were scored with route data, APL data, or adsb.fi data vs. flying blind. Tracks data quality over time.' },
      { term: 'Stale detection', color: 'text-ylw', desc: 'Cruising aircraft with heading >60° from their cached destination are flagged. The stale cache entry is deleted and the callsign is re-queued for fresh enrichment. Self-correcting system.' },
      { term: 'Diversion signal', color: 'text-mag', desc: 'When route data is available, a 45°+ heading deviation from the great-circle bearing to the destination during cruise triggers a diversion flag. One of the strongest anomaly signals available.' },
    ],
  },
  {
    title: 'Anomaly Feedback',
    items: [
      { term: 'False positive',   color: 'text-ylw', desc: 'Mark an anomaly as a false positive from the drilldown modal. Stored in the database with timestamp. Tracks false positive rate over time to measure scoring accuracy.' },
      { term: 'Confirm real',     color: 'text-red', desc: 'Confirm that a detected anomaly was a genuine event. Provides ground truth for evaluating scoring quality.' },
      { term: 'Feedback stats',   color: 'text-fg3', desc: 'Available via API (GET /api/anomalies/feedback/stats). Shows total reviewed, false positive count, confirmed real count, and unreviewed count over 7 days.' },
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
    title: 'NOTAMs & TFRs (AIM FNS)',
    items: [
      { term: 'AIM FNS feed',    color: 'text-grn', desc: 'Real-time NOTAM feed from the FAA\'s System Wide Information Management (SWIM) Cloud Distribution Service. Connects via Solace messaging to receive NOTAMs as they are published — no polling delay. Messages arrive as AIXM 5.1 XML or JMS properties.' },
      { term: 'NOTAM types',     color: 'text-acc', desc: 'Notices to Air Missions. Includes runway closures (RWY), taxiway closures (TWY), apron restrictions (APRON), service outages (SVC/NAV), obstacle notifications (OBST), and airspace restrictions (AIRSPACE). Each shown with a colored keyword badge.' },
      { term: 'TFR',             color: 'text-red', desc: 'Temporary Flight Restrictions. Airspace closures for presidential movement, wildfires, security events, or military exercises. Includes geographic boundaries and altitude limits. Aircraft diverting around TFRs are not anomalous.' },
      { term: 'Affected airports', color: 'text-acc', desc: 'The NOTAM panel groups active NOTAMs by airport, showing keyword badges and timestamps. Airports with runway closures may see more holding patterns and approach anomalies — this context helps operators interpret the anomaly feed.' },
      { term: 'Connection status', color: 'text-grn', desc: 'Green dot = live SWIM connection. Shows message count since startup. SWIM reconnects automatically on disconnect with exponential backoff.' },
    ],
  },
  {
    title: 'TFMS (Flight Plans & Flow)',
    items: [
      { term: 'TFMS feed',        color: 'text-grn', desc: 'Traffic Flow Management System — real-time flight plan data for every IFR flight in the NAS. Connects via SWIM SCDS (Solace). High-volume: 1-3 million messages/day. Messages are TFMData v3.2 XML with namespaced elements (ds:, fdm:, nxcm:, nxce:).' },
      { term: 'Flight Data',      color: 'text-acc', desc: 'Flight plans, amendments, track updates (position reports every 1-4 min), departure/arrival notifications, boundary crossings, and beacon code assignments. Each message carries: callsign (acid), departure/arrival airports, speed (knots), altitude (flight level), position (DMS), ETA, aircraft category (JET/PROP), and source facility (ARTCC).' },
      { term: 'Flow Information',  color: 'text-ylw', desc: 'Traffic Management Initiatives (TMIs). Ground Delay Programs (GDPs), Ground Stops (GS), Arrival Flow Programs (AFPs), reroutes, CTOP, and ATCSCC advisories. Includes affected airport, reason (WEATHER/VOLUME), delay estimates, and start/end times.' },
      { term: 'Track updates',    color: 'text-cyn', desc: 'Position reports for airborne flights. Includes lat/lon (from DMS coordinates via ARTCC radar), assigned altitude (flight level), ground speed (knots), ETA to destination, RVSM compliance, arrival/departure fix times. Batched — a single XML message may contain multiple flights from the same ARTCC.' },
      { term: 'Flight status',    color: 'text-acc', desc: 'TFMS tracks the lifecycle of each flight: SCHEDULED → FILED → ACTIVE → ASCENDING → CRUISING → DESCENDING → COMPLETED → CANCELLED. Status is extracted from flight plan messages and stored per callsign.' },
      { term: 'Data volume',      color: 'text-ylw', desc: 'Estimated 1-3M messages/day across Flight Data and Flow Information. The FAA handles 45,000+ IFR flights/day. Track updates are the highest volume (~1,250-5,000/min during peak). Flight plans are upserted by callsign (acid) to keep database manageable. 24-hour auto-purge.' },
      { term: 'Queue behavior',   color: 'text-fg3', desc: 'SCDS uses durable guaranteed queues — messages accumulate if the consumer is offline. No consumption rate limits; the constraint is consuming fast enough. Messages are batched (flush every 5s or 50 msgs). Monitor Expired Messages in the SWIFT Portal to ensure you\'re keeping up.' },
    ],
  },
  {
    title: 'LADD Compliance',
    items: [
      { term: 'What is LADD',     color: 'text-red', desc: 'Limiting Aircraft Data Displayed. An FAA program that protects certain aircraft (general aviation, on-demand operators) from having their real-time position data publicly displayed. Compliance is legally required by the SCDS Service Access Agreement.' },
      { term: 'Requirements',     color: 'text-ylw', desc: 'Download the IndustryLADD list monthly (first Thursday) from adx.faa.gov. Filter any matching aircraft call signs or registrations from public displays. Update within 5 business days of each publication. Historical data produced while an aircraft was on the LADD list must remain protected even after removal.' },
      { term: 'Enforcement',      color: 'text-red', desc: 'The FAA can suspend or terminate SWIM data access for non-compliance. The program provides "greater enforcement capabilities" against third parties that violate LADD protections.' },
      { term: 'Scope',            color: 'text-fg3', desc: 'LADD applies to public display of real-time flight position data. Internal anomaly detection and stored data not shown publicly are lower risk, but filtering should be implemented before any public-facing deployment.' },
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
    title: 'Hourly Activity',
    items: [
      { term: 'Aircraft bars',  color: 'text-acc', desc: 'Blue bars show the number of unique aircraft tracked per hour over the last 24 hours. Provides baseline traffic volume context.' },
      { term: 'Anomaly line',   color: 'text-red', desc: 'Red line with dots overlaid on the aircraft bars. Shows anomaly count per hour. Yellow dots for normal anomalies, red dots when critical-severity events occurred in that hour.' },
      { term: 'Trend reading',  color: 'text-fg3', desc: 'Compare the anomaly line against the aircraft bars. If anomalies spike without a corresponding traffic increase, something real may be happening. If both spike together, it\'s likely just more traffic.' },
    ],
  },
  {
    title: 'Metrics',
    items: [
      { term: 'Score',       color: 'text-red', desc: 'Numeric severity (0-100). Composite of all triggered rules after position confidence, class, altitude, proximity, spatial, weather, correlated scoring, phase transition, and volatility adjustments. Higher = more anomalous.' },
      { term: 'MTTR',        color: 'text-fg3', desc: 'Mean Time To Resolution. Average minutes between anomaly detection and resolution (aircraft returns to normal behavior). Lower = more transient events.' },
      { term: 'Anomaly rate', color: 'text-fg3', desc: 'Anomalies per 100 tracked aircraft. Normalizes for fleet size — useful for comparing across regions or time periods.' },
    ],
  },
  {
    title: 'Data Sources',
    items: [
      { term: 'FAA SWIM',   color: 'text-grn', desc: 'System Wide Information Management. Real-time data direct from the FAA via Solace messaging. Active feeds: AIM FNS (NOTAMs/TFRs) and TFMS (filed flight plans, track updates, flow management — GDPs, ground stops, reroutes). Planned: SFDPS (en route track data from 20 ARTCCs), ITWS (terminal weather). Free access at portal.swim.faa.gov.' },
      { term: 'Airplanes.live', color: 'text-mag', desc: 'Default source for regional tracking. Unfiltered ADS-B/MLAT including military and blocked aircraft. Provides 50+ fields per aircraft: IAS, TAS, Mach, roll, wind, temperature, MCP/FMS altitudes, nav modes. 1 req/sec, no credits, no auth.' },
      { term: 'OpenSky',    color: 'text-acc', desc: 'Primary global source. ADS-B crowd-sourced network with bounding-box queries; OAuth credentials improve daily rate limits.' },
      { term: 'adsb.fi',    color: 'text-cyn', desc: 'Rate-limited community fallback used when OpenSky is unavailable or out of credits.' },
      { term: 'adsb.fi',    color: 'text-acc', desc: 'Aircraft enrichment. Registration, type, operator, year, MCP settings, emergency field, military flag, and emitter category (used for aircraft class normalization).' },
      { term: 'ADSBdb',     color: 'text-acc', desc: 'Aircraft database. Maps ICAO hex codes to aircraft details and callsigns to origin/destination routes. Primary source for the route cache.' },
      { term: 'AvnWx',      color: 'text-acc', desc: 'aviationweather.gov. FAA weather data — METARs, PIREPs, SIGMETs. Updated every minute. Feeds into weather correlation scoring.' },
      { term: 'AeroAPI',    color: 'text-acc', desc: 'FlightAware premium data. Detailed flight plans and historical tracks. On-demand, pay-per-call.' },
      { term: 'S3 Archive',  color: 'text-acc', desc: 'Sightings, anomalies, and daily summaries are archived to S3 before purge. Local SQLite retains only 3 hours of data. S3 provides long-term history for future analysis and route baseline computation.' },
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
            <span className="text-fg3 text-[10px] ml-2">scoring, detection, routes, weather, NOTAMs, TFMS, LADD & data sources</span>
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
