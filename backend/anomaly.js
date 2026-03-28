// ── Flight anomaly scoring engine ───────────────────────────────────────────
// Uses live ADS-B data + optional enrichment (route, adsb.fi telemetry).

// ── Anomaly categories ──────────────────────────────────────────────────────
const CATEGORY = {
  SQUAWK:    'SQUAWK',     // emergency squawk codes (7700, 7600, 7500)
  EMERGENCY: 'EMERGENCY',  // adsb.fi emergency field (general, lifeguard, etc.)
  ALTITUDE:  'ALTITUDE',   // abnormal altitude rate for phase
  SPEED:     'SPEED',      // abnormal speed change
  HEADING:   'HEADING',    // unexpected heading change during cruise
  DIVERSION: 'DIVERSION',  // heading deviates from expected route
  PHASE:     'PHASE',      // abnormal phase transition (cruise→rapid descent)
  INTENT:    'INTENT',     // MCP altitude/heading signals imminent maneuver
}

// ── Severity tiers ──────────────────────────────────────────────────────────
const SEVERITY = {
  CRITICAL: 'CRITICAL',   // squawk 7700/7500, score 80+
  HIGH:     'HIGH',       // confirmed anomaly, score 60+
  MEDIUM:   'MEDIUM',     // score 35-59
  LOW:      'LOW',        // below threshold, not emitted
}

function deriveSeverity(score, category, confirmed) {
  if (category === CATEGORY.SQUAWK || category === CATEGORY.EMERGENCY) return SEVERITY.CRITICAL
  if (score >= 80) return SEVERITY.CRITICAL
  if (score >= 60 || confirmed) return SEVERITY.HIGH
  if (score >= ANOMALY_THRESHOLD) return SEVERITY.MEDIUM
  return SEVERITY.LOW
}

// ── Phase detection ─────────────────────────────────────────────────────────
// Infer flight phase from the last N snapshots

const PHASE = {
  GROUND:   'ground',
  CLIMB:    'climb',
  CRUISE:   'cruise',
  DESCENT:  'descent',
  APPROACH: 'approach',
  UNKNOWN:  'unknown',
}

function detectPhase(snapshots) {
  if (!snapshots || snapshots.length < 2) return PHASE.UNKNOWN

  const recent = snapshots.slice(-5)
  const last = recent[recent.length - 1]

  if (last.grounded) return PHASE.GROUND

  // compute altitude trend over recent snapshots
  const alts = recent.filter(s => s.alt != null).map(s => s.alt)
  if (alts.length < 2) return PHASE.UNKNOWN

  const altDeltas = []
  for (let i = 1; i < alts.length; i++) altDeltas.push(alts[i] - alts[i - 1])
  const avgAltDelta = altDeltas.reduce((a, b) => a + b, 0) / altDeltas.length

  const currentAlt = last.alt ?? 0
  const currentVel = last.vel ?? 0

  // low altitude + decelerating + descending = approach
  if (currentAlt < 3000 && avgAltDelta < -20 && currentVel < 120) return PHASE.APPROACH
  // low altitude + accelerating + climbing = climb-out
  if (currentAlt < 3000 && avgAltDelta > 20) return PHASE.CLIMB

  // consistent descent
  if (avgAltDelta < -30) return PHASE.DESCENT
  // consistent climb
  if (avgAltDelta > 30) return PHASE.CLIMB
  // stable altitude at speed = cruise
  if (Math.abs(avgAltDelta) < 50 && currentVel > 80) return PHASE.CRUISE

  return PHASE.UNKNOWN
}

// ── Major US airports (top 50) for proximity suppression ────────────────────
const AIRPORTS = [
  { icao: 'KATL', lat: 33.637, lon: -84.428 },
  { icao: 'KLAX', lat: 33.943, lon: -118.408 },
  { icao: 'KDFW', lat: 32.897, lon: -97.038 },
  { icao: 'KDEN', lat: 39.852, lon: -104.673 },
  { icao: 'KORD', lat: 41.974, lon: -87.907 },
  { icao: 'KJFK', lat: 40.641, lon: -73.778 },
  { icao: 'KMCO', lat: 28.429, lon: -81.309 },
  { icao: 'KLAS', lat: 36.084, lon: -115.152 },
  { icao: 'KCLT', lat: 35.214, lon: -80.943 },
  { icao: 'KMIA', lat: 25.796, lon: -80.287 },
  { icao: 'KSEA', lat: 47.449, lon: -122.309 },
  { icao: 'KEWR', lat: 40.693, lon: -74.169 },
  { icao: 'KSFO', lat: 37.619, lon: -122.379 },
  { icao: 'KPHX', lat: 33.434, lon: -112.012 },
  { icao: 'KIAH', lat: 29.984, lon: -95.341 },
  { icao: 'KBOS', lat: 42.366, lon: -71.010 },
  { icao: 'KFLL', lat: 26.073, lon: -80.153 },
  { icao: 'KMSP', lat: 44.882, lon: -93.222 },
  { icao: 'KLGA', lat: 40.777, lon: -73.873 },
  { icao: 'KDTW', lat: 42.212, lon: -83.353 },
  { icao: 'KBWI', lat: 39.176, lon: -76.669 },
  { icao: 'KDCA', lat: 38.852, lon: -77.038 },
  { icao: 'KIAD', lat: 38.945, lon: -77.456 },
  { icao: 'KPHL', lat: 39.872, lon: -75.241 },
  { icao: 'KSLC', lat: 40.788, lon: -111.978 },
  { icao: 'KSAN', lat: 32.734, lon: -117.190 },
  { icao: 'KBNA', lat: 36.124, lon: -86.678 },
  { icao: 'KAUS', lat: 30.195, lon: -97.670 },
  { icao: 'KRDU', lat: 35.880, lon: -78.788 },
  { icao: 'KTPA', lat: 27.975, lon: -82.533 },
  { icao: 'KSTL', lat: 38.748, lon: -90.370 },
  { icao: 'KPIT', lat: 40.492, lon: -80.233 },
  { icao: 'KPDX', lat: 45.589, lon: -122.597 },
  { icao: 'KMSY', lat: 29.993, lon: -90.258 },
  { icao: 'KMCI', lat: 39.298, lon: -94.714 },
  { icao: 'KCLE', lat: 41.412, lon: -81.850 },
  { icao: 'KSAT', lat: 29.534, lon: -98.470 },
  { icao: 'KIND', lat: 39.717, lon: -86.294 },
  { icao: 'KSDF', lat: 38.174, lon: -85.736 },
  { icao: 'KCVG', lat: 39.049, lon: -84.668 },
  { icao: 'KOAK', lat: 37.721, lon: -122.221 },
  { icao: 'KSJC', lat: 37.362, lon: -121.929 },
  { icao: 'KSMF', lat: 38.695, lon: -121.591 },
  { icao: 'KHNL', lat: 21.319, lon: -157.922 },
  { icao: 'KHOU', lat: 29.645, lon: -95.279 },
  { icao: 'KMDW', lat: 41.786, lon: -87.752 },
  { icao: 'KDAL', lat: 32.847, lon: -96.852 },
  { icao: 'KRSW', lat: 26.536, lon: -81.755 },
  { icao: 'KPBI', lat: 26.683, lon: -80.096 },
  { icao: 'KABQ', lat: 35.040, lon: -106.609 },
]

const AIRPORT_PROXIMITY_KM = 50 // suppress descent anomalies within this radius

const DEG = Math.PI / 180

function distKm(lat1, lon1, lat2, lon2) {
  // fast approximation — good enough for 50km checks
  const dLat = (lat2 - lat1) * 111.32
  const dLon = (lon2 - lon1) * 111.32 * Math.cos((lat1 + lat2) / 2 * DEG)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

function nearAirport(lat, lon) {
  if (lat == null || lon == null) return false
  for (const ap of AIRPORTS) {
    if (distKm(lat, lon, ap.lat, ap.lon) < AIRPORT_PROXIMITY_KM) return true
  }
  return false
}

/**
 * Compute great-circle initial bearing from point A to point B (in degrees 0-360).
 * Used for diversion detection: compare this bearing to the aircraft's actual heading.
 */
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG, φ2 = lat2 * DEG
  const Δλ = (lon2 - lon1) * DEG
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) / DEG + 360) % 360
}

/**
 * Smallest angular difference between two headings (0-180).
 */
function headingDelta(h1, h2) {
  const d = Math.abs(h1 - h2) % 360
  return d > 180 ? 360 - d : d
}

// ── Position confidence ──────────────────────────────────────────────────────
// ADS-B = reliable. MLAT with few receivers = noisy position data.
// posSrc: 0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM
// Returns a multiplier: 1.0 = full confidence, 0 = skip scoring entirely.

function positionConfidence(current, prev) {
  const src = current.posSrc ?? 0
  const ndb = current.ndb ?? null

  // ADS-B — fully trusted
  if (src === 0) return 1.0

  // MLAT — confidence depends on receiver count
  if (src === 2) {
    if (ndb != null && ndb < 3) return 0     // too few receivers, skip
    if (ndb != null && ndb < 5) return 0.5   // marginal — dampen by 50%
    return 0.8                                 // decent MLAT coverage
  }

  // ASTERIX/FLARM — reasonable but not ADS-B quality
  return 0.7
}

// ── Aircraft class normalization ─────────────────────────────────────────────
// adsb.fi category field maps to ADS-B emitter categories.
// Heavier aircraft have tighter tolerances (they shouldn't maneuver aggressively).
// Lighter aircraft get wider thresholds (normal handling looks more erratic).
// Returns a multiplier applied to PHASE_NORMS tolerances.

const CLASS_TOLERANCE = {
  A0: 1.5,   // No category info — be lenient
  A1: 2.0,   // Light (< 15,500 lbs) — Cessna, Piper, etc.
  A2: 1.5,   // Small (15,500 - 75,000 lbs) — regional jets
  A3: 1.0,   // Large (75,000 - 300,000 lbs) — 737, A320
  A4: 1.0,   // High vortex large — 757
  A5: 0.9,   // Heavy (> 300,000 lbs) — 777, A380, tight tolerances
  A6: 0.9,   // High performance — military jets
  A7: 1.0,   // Rotorcraft
  B0: 1.5,   // No category info
  B1: 2.5,   // Glider — very erratic flight profile
  B2: 2.5,   // Lighter than air — balloon, blimp
  B4: 3.0,   // Skydiver / parachutist — extreme maneuvers expected
  B6: 2.0,   // UAV / drone
}

function classMultiplier(enrich, current) {
  const cat = enrich?.adsbfi?.category || enrich?.apl?.category || current?.category
  if (!cat) return 1.0
  return CLASS_TOLERANCE[cat] ?? 1.0
}

// ── Scoring ─────────────────────────────────────────────────────────────────

// Normal rates by phase (m/s vertical, m/s horizontal change)
// Base norms — adjusted by altitude band below.
const PHASE_NORMS = {
  [PHASE.CLIMB]:    { altRate: [5, 20],  velChange: 15 },   // 5-20 m/s climb
  [PHASE.CRUISE]:   { altRate: [-2, 2],  velChange: 5 },    // nearly flat
  [PHASE.DESCENT]:  { altRate: [-20, -3], velChange: 15 },  // 3-20 m/s descent
  [PHASE.APPROACH]: { altRate: [-15, -1], velChange: 20 },  // slower descent, speed varies
  [PHASE.GROUND]:   { altRate: [0, 0],   velChange: 5 },
  [PHASE.UNKNOWN]:  { altRate: [-15, 15], velChange: 20 },  // wide tolerance
}

// ── Altitude-aware norm scaling ──────────────────────────────────────────────
// Aircraft behavior varies dramatically by altitude band. High altitude cruise
// is tightly controlled; low altitude is chaotic with ATC vectors, terrain,
// approach procedures. Returns a multiplier applied to PHASE_NORMS tolerances.
//
//   FL350+ (10,668m+)  → tightest: any deviation is meaningful
//   FL100-FL350         → moderate: transitional altitudes
//   3,000-FL100 (914m)  → wide: lots of normal maneuvering
//   Below 3,000ft (914m)→ widest: approach/departure, everything varies

function altitudeBandMultiplier(altMeters) {
  if (altMeters == null) return 1.0
  if (altMeters >= 10668) return 0.7   // FL350+ — tighten norms (anomalies matter more)
  if (altMeters >= 3048)  return 1.0   // FL100-FL350 — baseline
  if (altMeters >= 914)   return 1.5   // 3,000-10,000ft — wider tolerance
  return 2.0                            // below 3,000ft — very wide (approach/departure)
}

// ── TOD / departure proximity ────────────────────────────────────────────────
// If we know the aircraft's origin/destination, compute distance to each.
// Aircraft near their destination (TOD zone) or origin (departure climb) get
// wider tolerances for altitude/phase changes — these are expected maneuvers.
//
// TOD typically starts 100-150nm from destination. We use 370km (~200nm) as
// the outer boundary of "expected descent zone" and scale linearly.
// Departure climb zone is ~100km (~55nm) from origin.

const NM_TO_KM = 1.852
const TOD_ZONE_KM = 200 * NM_TO_KM    // ~370km from destination
const DEPARTURE_ZONE_KM = 55 * NM_TO_KM // ~100km from origin

function routeProximityMultiplier(lat, lon, route) {
  if (!route || lat == null || lon == null) return 1.0

  let mult = 1.0

  // Check distance to destination
  const destLat = route.destination?.latitude ?? route.destination?.lat
  const destLon = route.destination?.longitude ?? route.destination?.lon
  if (destLat != null && destLon != null) {
    const distToDest = distKm(lat, lon, destLat, destLon)
    if (distToDest < TOD_ZONE_KM) {
      // Linear scale: at destination = 3.0x (very wide), at TOD boundary = 1.0x
      mult = Math.max(mult, 1.0 + 2.0 * (1 - distToDest / TOD_ZONE_KM))
    }
  }

  // Check distance to origin
  const origLat = route.origin?.latitude ?? route.origin?.lat
  const origLon = route.origin?.longitude ?? route.origin?.lon
  if (origLat != null && origLon != null) {
    const distToOrig = distKm(lat, lon, origLat, origLon)
    if (distToOrig < DEPARTURE_ZONE_KM) {
      mult = Math.max(mult, 1.0 + 2.0 * (1 - distToOrig / DEPARTURE_ZONE_KM))
    }
  }

  return mult
}

// ── Spatial context ──────────────────────────────────────────────────────────
// Compare an aircraft's behavior against nearby traffic. If neighbors are doing
// the same thing (all turning, all descending), it's likely ATC or weather —
// not an anomaly. If one aircraft deviates while neighbors fly straight, that's
// genuinely unusual.
//
// Returns a multiplier: <1.0 = neighbors doing the same (dampen),
//                       >1.0 = aircraft is the outlier (boost),
//                       1.0  = not enough neighbors to compare.

function spatialContextMultiplier(current, allFlights) {
  if (!allFlights || allFlights.length < 10 || current.lat == null || current.hdg == null) return 1.0

  // Find neighbors within 100km, same altitude band (±3000m), airborne
  const RADIUS_KM = 100
  const ALT_BAND = 3000 // meters
  const neighbors = []

  for (const f of allFlights) {
    if (f.icao === current.icao) continue
    if (f.grounded || f.lat == null || f.hdg == null) continue
    if (current.alt != null && f.alt != null && Math.abs(f.alt - current.alt) > ALT_BAND) continue
    const d = distKm(current.lat, current.lon, f.lat, f.lon)
    if (d < RADIUS_KM) {
      neighbors.push(f)
    }
    if (neighbors.length >= 20) break // cap for performance
  }

  if (neighbors.length < 3) return 1.0 // not enough to compare

  // Compare heading changes: compute mean neighbor heading, then see if
  // this aircraft's heading is an outlier vs the group
  const neighborHdgs = neighbors.map(n => n.hdg)

  // Circular mean heading (handles wrapping)
  const sinSum = neighborHdgs.reduce((s, h) => s + Math.sin(h * DEG), 0)
  const cosSum = neighborHdgs.reduce((s, h) => s + Math.cos(h * DEG), 0)
  const meanHdg = (Math.atan2(sinSum, cosSum) / DEG + 360) % 360

  // How much does this aircraft deviate from the local traffic flow?
  const myDeviation = headingDelta(current.hdg, meanHdg)
  // How much does the average neighbor deviate? (spread of the group)
  const neighborDeviations = neighborHdgs.map(h => headingDelta(h, meanHdg))
  const avgNeighborDev = neighborDeviations.reduce((a, b) => a + b, 0) / neighborDeviations.length

  // If neighbors are all deviating similarly (ATC reroute / weather):
  // everyone turning ~30° → avgNeighborDev ≈ 30, myDeviation ≈ 30 → dampen
  if (avgNeighborDev > 15 && myDeviation < avgNeighborDev * 1.5) {
    // Group is maneuvering together — this aircraft is following the herd
    return 0.4
  }

  // If this aircraft is the outlier:
  // neighbors flying straight (avgDev ≈ 5°), this aircraft turning 40° → boost
  if (avgNeighborDev < 10 && myDeviation > 25) {
    // Lone deviant — more suspicious
    return 1.3
  }

  return 1.0
}

/**
 * Score a single aircraft's anomaly level.
 *
 * @param {Array}  snapshots  - last N snapshots [{ ts, alt, vel, hdg, grounded, vertRate, geoAlt, posSrc, ndb }]
 * @param {Object} current    - current flight object { alt, vel, hdg, lat, lon, grounded, squawk, mil, vertRate, geoAlt, posSrc, ndb }
 * @param {Object} [enrich]   - optional enrichment data:
 *   enrich.flightroute  - { origin: { latitude, longitude }, destination: { latitude, longitude } }
 *   enrich.adsbfi       - { navAlt, navHdg, baroRate, emergency, mil, category }
 * @param {Object} [weather]  - optional weather context:
 *   weather.sigmets  - { count, convective, turbulence, icing }
 *   weather.pireps   - { count, severe, maxTurbulence, maxIcing }
 * @param {Array}  [allFlights] - all current flights for spatial context comparison
 * @returns {{ score, phase, reasons[], confirmed, category, severity, categories[] }}
 */
function scoreAnomaly(snapshots, current, enrich = null, weather = null, allFlights = null) {
  const result = {
    score: 0, phase: PHASE.UNKNOWN, reasons: [], confirmed: false,
    category: null, severity: SEVERITY.LOW, categories: [],
  }

  if (!snapshots || snapshots.length < 2 || !current) return result

  // ── Position confidence check ──────────────────────────────────────────
  const posConf = positionConfidence(current, snapshots[snapshots.length - 1])
  if (posConf === 0) {
    // Data too unreliable to score — MLAT with <3 receivers
    return result
  }

  const phase = detectPhase(snapshots)
  result.phase = phase

  const prev = snapshots[snapshots.length - 1]
  const prevPrev = snapshots.length >= 3 ? snapshots[snapshots.length - 2] : null
  const route = enrich?.flightroute || null
  // Merge adsb.fi + airplanes.live enrichment + live flight fields for MCP/nav data.
  // Prefer adsb.fi where available, then apl enrichment, then live flight fields (apl source).
  const adsbfi = enrich?.adsbfi || null
  const aplEnrich = enrich?.apl || null
  const fi = adsbfi ? {
    ...adsbfi,
    // Fill gaps from airplanes.live if adsb.fi doesn't have them
    navAlt: adsbfi.navAlt ?? aplEnrich?.navAltMcp ?? current.navAltMcp ?? null,
    navHdg: adsbfi.navHdg ?? aplEnrich?.navHeading ?? current.navHeading ?? null,
    emergency: adsbfi.emergency ?? aplEnrich?.emergency ?? current.emergency ?? null,
    mil: adsbfi.mil ?? aplEnrich?.mil ?? current.mil ?? false,
    category: adsbfi.category ?? aplEnrich?.category ?? current.category ?? null,
  } : aplEnrich ? {
    navAlt: aplEnrich.navAltMcp ?? current.navAltMcp ?? null,
    navHdg: aplEnrich.navHeading ?? current.navHeading ?? null,
    baroRate: aplEnrich.vertRate != null ? Math.round(aplEnrich.vertRate / 0.00508) : null, // convert m/s → ft/min
    emergency: aplEnrich.emergency ?? current.emergency ?? null,
    mil: aplEnrich.mil ?? current.mil ?? false,
    category: aplEnrich.category ?? current.category ?? null,
  } : current.navAltMcp != null ? {
    // Live flight data from airplanes.live primary source
    navAlt: current.navAltMcp ?? null,
    navHdg: current.navHeading ?? null,
    emergency: current.emergency ?? null,
    mil: current.mil ?? false,
    category: current.category ?? null,
  } : null

  // Combined tolerance multiplier: aircraft class × altitude band × route proximity
  // Light aircraft at low altitude near destination = very wide tolerances
  // Heavy jet at FL350+ mid-route = tight tolerances — deviations matter
  const routeMult = routeProximityMultiplier(current.lat, current.lon, route)
  const classMult = classMultiplier(enrich, current) * altitudeBandMultiplier(current.alt) * routeMult

  // track per-category scores to determine primary category
  const catScores = {}
  function addScore(cat, pts, reason) {
    // Apply position confidence to non-emergency scores
    const adjusted = (cat === CATEGORY.SQUAWK || cat === CATEGORY.EMERGENCY) ? pts : pts * posConf
    result.score += adjusted
    result.reasons.push(reason)
    catScores[cat] = (catScores[cat] || 0) + adjusted
    if (!result.categories.includes(cat)) result.categories.push(cat)
  }

  // ── 1. Rate-normalized altitude change ────────────────────────────────
  // Prefer transponder-reported vertical rate when available (more accurate
  // than computing from altitude deltas over 90s sample gaps).
  if (prev.alt != null && current.alt != null && prev.ts) {
    const dtSec = Math.max(1, (Date.now() - prev.ts) / 1000)

    // Use transponder vertRate if available (m/s), else compute from deltas.
    // Transponder vertRate is instantaneous — peaks higher than snapshot averages
    // for the same maneuver, so we widen norms by 1.5x to compensate.
    let altRate, vertRateWidener = 1.0
    if (current.vertRate != null) {
      altRate = current.vertRate  // direct from transponder — real-time
      vertRateWidener = 1.25
    } else {
      altRate = (current.alt - prev.alt) / dtSec  // computed — averaged over sample interval
    }

    const norms = PHASE_NORMS[phase] || PHASE_NORMS[PHASE.UNKNOWN]
    // Apply aircraft class multiplier and vertRate source adjustment
    const normLow = norms.altRate[0] * classMult * vertRateWidener
    const normHigh = norms.altRate[1] * classMult * vertRateWidener

    let altDeviation = 0
    if (altRate < normLow) altDeviation = Math.abs(altRate - normLow)
    else if (altRate > normHigh) altDeviation = Math.abs(altRate - normHigh)

    if (altDeviation > 0) {
      const altScore = Math.min(80, altDeviation * 4)
      const src = current.vertRate != null ? 'transponder' : 'computed'
      const dir = altRate < normLow ? 'descent' : 'climb'
      addScore(CATEGORY.ALTITUDE, altScore, `${dir} ${altRate.toFixed(1)} m/s [${src}] (expected ${normLow.toFixed(0)} to ${normHigh.toFixed(0)} in ${phase})`)
    }
  }

  // ── 2. Speed anomaly ──────────────────────────────────────────────────
  if (prev.vel != null && current.vel != null && prev.ts) {
    const dtSec = Math.max(1, (Date.now() - prev.ts) / 1000)
    const velDelta = Math.abs(current.vel - prev.vel)
    const norms = PHASE_NORMS[phase] || PHASE_NORMS[PHASE.UNKNOWN]
    // Scale threshold to actual sample interval (norms calibrated for ~90s gaps)
    const velThreshold = norms.velChange * classMult * (dtSec / 90)
    const velDeviation = Math.max(0, velDelta - velThreshold)

    if (velDeviation > 10) {
      const velScore = Math.min(40, velDeviation * 1.5)
      addScore(CATEGORY.SPEED, velScore, `speed change ${(current.vel - prev.vel).toFixed(1)} m/s in ${dtSec.toFixed(0)}s`)
    }
  }

  // ── 3. Heading discontinuity (only meaningful in cruise) ──────────────
  if (phase === PHASE.CRUISE && prev.hdg != null && current.hdg != null) {
    // Detect holding pattern / orbit: if cumulative heading change over recent
    // snapshots exceeds 270°, the aircraft is likely in a hold — suppress.
    // Standard rate hold = 360° in 2 min; at 90s intervals this accumulates fast.
    let cumulativeHdg = 0
    const recentSnaps = snapshots.slice(-4)
    for (let i = 1; i < recentSnaps.length; i++) {
      if (recentSnaps[i].hdg != null && recentSnaps[i - 1].hdg != null) {
        cumulativeHdg += headingDelta(recentSnaps[i].hdg, recentSnaps[i - 1].hdg)
      }
    }
    cumulativeHdg += headingDelta(current.hdg, prev.hdg)
    const inHold = cumulativeHdg > 270

    if (!inHold) {
      const hdgThreshold = 45 * classMult
      const hdgDelta = headingDelta(current.hdg, prev.hdg)

      if (hdgDelta > hdgThreshold) {
        const hdgScore = Math.min(25, (hdgDelta - hdgThreshold) * 0.5)
        addScore(CATEGORY.HEADING, hdgScore, `heading change ${hdgDelta}° during cruise`)
      }
    }
  }

  // ── 4. Phase transition anomaly ───────────────────────────────────────
  if (snapshots.length >= 5) {
    const olderPhase = detectPhase(snapshots.slice(0, -1))
    if (olderPhase === PHASE.CRUISE && phase === PHASE.DESCENT) {
      if (result.score > 10) {
        addScore(CATEGORY.PHASE, 15, `phase transition: cruise → descent`)
      }
    }
  }

  // ── 5. Squawk codes ───────────────────────────────────────────────────
  if (current.squawk === '7700') {
    result.score = Math.max(result.score, 80)
    result.score = Math.min(100, result.score * 1.5)
    catScores[CATEGORY.SQUAWK] = 100
    if (!result.categories.includes(CATEGORY.SQUAWK)) result.categories.unshift(CATEGORY.SQUAWK)
    result.reasons.unshift('SQUAWK 7700 — EMERGENCY')
  } else if (current.squawk === '7600') {
    addScore(CATEGORY.SQUAWK, 20, 'SQUAWK 7600 — RADIO FAILURE')
  } else if (current.squawk === '7500') {
    result.score = 100
    catScores[CATEGORY.SQUAWK] = 100
    if (!result.categories.includes(CATEGORY.SQUAWK)) result.categories.unshift(CATEGORY.SQUAWK)
    result.reasons.unshift('SQUAWK 7500 — HIJACK')
  }

  // ── 6. adsb.fi emergency field (catches emergencies beyond squawk) ────
  if (fi?.emergency) {
    const em = fi.emergency.toLowerCase()
    if (em === 'general' || em === 'lifeguard' || em === 'minfuel' || em === 'nordo' || em === 'unlawful' || em === 'downed') {
      const emScore = em === 'unlawful' ? 100 : em === 'general' ? 60 : 40
      result.score = Math.max(result.score, emScore)
      catScores[CATEGORY.EMERGENCY] = emScore
      if (!result.categories.includes(CATEGORY.EMERGENCY)) result.categories.unshift(CATEGORY.EMERGENCY)
      result.reasons.unshift(`EMERGENCY: ${fi.emergency.toUpperCase()}`)
    }
  }

  // ── 7. Route-aware diversion detection ────────────────────────────────
  // If we know the destination, compare actual heading to the bearing toward it.
  // Only meaningful during cruise (approach/descent heading changes are expected).
  if (route?.destination && current.lat != null && current.lon != null && current.hdg != null && phase === PHASE.CRUISE) {
    const destLat = route.destination.latitude ?? route.destination.lat
    const destLon = route.destination.longitude ?? route.destination.lon
    if (destLat != null && destLon != null) {
      const expectedBearing = bearingTo(current.lat, current.lon, destLat, destLon)
      const deviation = headingDelta(current.hdg, expectedBearing)

      // >45° deviation during cruise is noteworthy, >90° is major
      if (deviation > 45) {
        const divScore = Math.min(50, (deviation - 45) * 0.7)
        const destCode = route.destination.icao_code || route.destination.iata_code || '???'
        addScore(CATEGORY.DIVERSION, divScore, `heading ${current.hdg}° deviates ${Math.round(deviation)}° from ${destCode} (bearing ${Math.round(expectedBearing)}°)`)
      }
    }
  }

  // ── 8. MCP intent signals (autopilot set altitude/heading) ────────────
  // If adsb.fi gives us what the pilot has dialed into the MCP, we can detect
  // imminent maneuvers before they show up in position data.
  if (fi && current.alt != null && phase === PHASE.CRUISE) {
    // MCP altitude intent: large gap between current alt and MCP target
    if (fi.navAlt != null) {
      const currentFt = current.alt * 3.28084 // convert m to ft for comparison
      const altGap = fi.navAlt - currentFt

      // Pilot set MCP altitude >10,000ft below current — emergency descent imminent
      if (altGap < -10000) {
        addScore(CATEGORY.INTENT, 35, `MCP alt ${fi.navAlt} ft — ${Math.abs(Math.round(altGap))} ft below current (emergency descent intent)`)
      }
      // Pilot set MCP altitude >5,000ft below during cruise — unusual
      else if (altGap < -5000 && !nearAirport(current.lat, current.lon)) {
        addScore(CATEGORY.INTENT, 15, `MCP alt ${fi.navAlt} ft — ${Math.abs(Math.round(altGap))} ft below current`)
      }
    }

    // MCP heading intent: pilot dialed heading diverges from current track
    if (fi.navHdg != null && current.hdg != null) {
      const mcpDelta = headingDelta(fi.navHdg, current.hdg)
      if (mcpDelta > 60) {
        addScore(CATEGORY.INTENT, Math.min(20, (mcpDelta - 60) * 0.5), `MCP hdg ${fi.navHdg}° — ${Math.round(mcpDelta)}° from current track (turn intent)`)
      }
    }
  }

  // ── 9. Speed-only suppression ─────────────────────────────────────────
  // Speed changes alone are too noisy (wind, ATC, turbulence). Only keep
  // speed score when another category is also present.
  if (result.categories.length === 1 && result.categories[0] === CATEGORY.SPEED) {
    result.score = 0
    result.reasons = []
    result.categories = []
    for (const k of Object.keys(catScores)) catScores[k] = 0
  }

  // ── 10. Weather correlation ──────────────────────────────────────────
  // If active SIGMETs or severe PIREPs are nearby, altitude/heading/speed
  // anomalies are likely weather avoidance — not suspicious. Dampen the score.
  // Emergency squawk/declarations are never dampened by weather.
  if (weather && result.score > 0) {
    const hasEmergency = result.categories.includes(CATEGORY.SQUAWK) || result.categories.includes(CATEGORY.EMERGENCY)
    if (!hasEmergency) {
      const sig = weather.sigmets
      const pir = weather.pireps

      // Convective SIGMET = severe thunderstorms — strong dampening
      if (sig?.convective > 0) {
        result.score = Math.round(result.score * 0.3)
        result.reasons.push(`(convective SIGMET active — likely weather avoidance)`)
      }
      // Turbulence SIGMET or severe PIREPs — moderate dampening
      else if (sig?.turbulence > 0 || pir?.severe) {
        result.score = Math.round(result.score * 0.5)
        result.reasons.push(`(turbulence/severe PIREPs nearby — possible weather avoidance)`)
      }
      // Moderate PIREPs nearby — slight dampening
      else if (pir?.count > 3) {
        result.score = Math.round(result.score * 0.7)
        result.reasons.push(`(${pir.count} PIREPs nearby — possible weather factor)`)
      }
    }
  }

  // ── 11. Spatial context — compare against nearby traffic ─────────────
  // If neighbors are all deviating AND weather explains it → dampen (routine avoidance).
  // If neighbors are all deviating with NO weather → boost (something is happening
  // in that area — airspace closure, security event, ground incident).
  // If this aircraft is the lone deviant → boost (genuinely unusual).
  // Never affects emergency scores.
  if (result.score > 0 && allFlights) {
    const hasEmergency = result.categories.includes(CATEGORY.SQUAWK) || result.categories.includes(CATEGORY.EMERGENCY)
    if (!hasEmergency) {
      const spatialMult = spatialContextMultiplier(current, allFlights)
      if (spatialMult < 1.0) {
        // Group is maneuvering together — but WHY?
        const hasWxExplanation = weather && (
          weather.sigmets?.convective > 0 ||
          weather.sigmets?.turbulence > 0 ||
          weather.pireps?.severe ||
          (weather.pireps?.count || 0) > 3
        )
        if (hasWxExplanation) {
          // Weather explains the group behavior — dampen
          result.score = Math.round(result.score * spatialMult)
          result.reasons.push('(neighbors maneuvering similarly — weather avoidance)')
        } else {
          // No weather explanation — multiple aircraft deviating is a SIGNAL
          result.score = Math.round(result.score * 1.4)
          result.reasons.push('(multiple aircraft deviating without weather — area event)')
        }
      } else if (spatialMult > 1.0) {
        result.score = Math.round(result.score * spatialMult)
        result.reasons.push('(lone deviant — neighbors flying straight)')
      }
    }
  }

  // ── 12. Military suppression ──────────────────────────────────────────
  // Military aircraft routinely maneuver in ways that look anomalous.
  // Dampen their scores unless it's a squawk/emergency event.
  if (current.mil || fi?.mil) {
    const hasEmergency = result.categories.includes(CATEGORY.SQUAWK) || result.categories.includes(CATEGORY.EMERGENCY)
    if (!hasEmergency && result.score > 0) {
      result.score = Math.round(result.score * 0.3)
      result.reasons.push('(military — dampened)')
    }
  }

  // ── 13. Airport proximity dampener ────────────────────────────────────
  if (nearAirport(current.lat, current.lon)) {
    const isDescentOnly = result.categories.every(c => c === CATEGORY.ALTITUDE || c === CATEGORY.PHASE || c === CATEGORY.INTENT)
    if (isDescentOnly && phase !== PHASE.CRUISE) {
      result.score = Math.round(result.score * 0.25)
      result.reasons.push('(near airport — dampened)')
    } else if (!result.categories.includes(CATEGORY.SQUAWK) && !result.categories.includes(CATEGORY.EMERGENCY)) {
      result.score = Math.round(result.score * 0.6)
      result.reasons.push('(near airport)')
    }
  }

  // ── 14. Multi-fetch confirmation ──────────────────────────────────────
  if (prevPrev && prev.alt != null && prevPrev.alt != null && current.alt != null) {
    const prevDelta = prev.alt - prevPrev.alt
    const currDelta = current.alt - prev.alt
    if (prevDelta < -300 && currDelta < -300) {
      result.confirmed = true
      result.score = Math.min(100, Math.round(result.score * 1.3))
      result.reasons.push('confirmed (2 consecutive fetches)')
    }
    if (Math.abs(prevDelta) > 500 && Math.abs(currDelta) < 100) {
      result.score = Math.round(result.score * 0.3)
      result.reasons.push('(recovered — likely data noise)')
    }
  }

  // clamp
  result.score = Math.round(Math.min(100, Math.max(0, result.score)))

  // ── Determine primary category + severity ─────────────────────────────
  let maxCat = null, maxCatScore = 0
  for (const [cat, pts] of Object.entries(catScores)) {
    if (pts > maxCatScore) { maxCat = cat; maxCatScore = pts }
  }
  result.category = maxCat
  result.severity = deriveSeverity(result.score, result.category, result.confirmed)

  return result
}

// ── Threshold ───────────────────────────────────────────────────────────────
const ANOMALY_THRESHOLD = 35

module.exports = {
  CATEGORY,
  SEVERITY,
  PHASE,
  ANOMALY_THRESHOLD,
  deriveSeverity,
  detectPhase,
  scoreAnomaly,
}
