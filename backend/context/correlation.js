// ── Correlation engine — v2.0.0 ─────────────────────────────────────────────
// Given an aircraft (by ICAO or raw lat/lon), assemble a context bundle that
// turns kinematic inferences (orbit / descent / emergency squawk) into
// corroborated ones by joining external data sources.
//
// Design contract:
//   - Every adapter is fire-and-forget via Promise.allSettled — one failure
//     never sinks the whole response.
//   - Missing keys return a soft { error } stub instead of throwing.
//   - The engine emits a list of `inferences`, each with a label + confidence
//     score + cited reasons, so the UI can show "why" alongside "what."

const firms = require('./firms')
const eonet = require('./eonet')
const openaq = require('./openaq')
const owm = require('./owm')
const openMeteo = require('./openMeteo')
const nps = require('./nps')
const mapillary = require('./mapillary')
const swpc = require('./swpc')
const usgsEvents = require('./usgsEvents')
const { haversineKm } = require('./geo')
const { classifyCallsign, classifySquawk } = require('./callsign')
const { detectOrbit } = require('./orbit')

function settled(promise, fallback) {
  return promise.then(v => v).catch(err => ({ error: err.message || String(err), ...fallback }))
}

// ── Inference rules ─────────────────────────────────────────────────────────
// Each rule: inputs → ({ label, confidence, reasons }) or null.
//
// confidence scale:
//   1.00 — deterministic (emergency squawk, SIGMET polygon intersects)
//   0.80 — two independent signals agree
//   0.60 — one strong signal
//   0.40 — weak prior
//
// Rules below corroborate the kinematics with external signals.

function runInferences({ aircraft, orbit, callsignTags, squawkTag, nearby, env }) {
  const out = []

  // 1. Emergency squawk (dispositive)
  if (squawkTag) {
    out.push({
      label: squawkTag.tag,
      confidence: squawkTag.confidence,
      severity: squawkTag.severity,
      reasons: [`squawk ${aircraft.squawk} is the reserved ${squawkTag.tag} code`],
    })
  }

  // 2. Firefighting — low-alt orbit + active fire pixels < 10km
  const lowAlt = aircraft.altitude != null && aircraft.altitude < 12000
  const nearFire = nearby.fires?.nearest && nearby.fires.nearest.distanceKm < 10
  if (orbit?.circling && lowAlt && nearFire) {
    out.push({
      label: 'firefighting_orbit',
      confidence: 0.90,
      reasons: [
        `circling (${orbit.totalTurnDeg}° cumulative turn, compactness ${orbit.compactness})`,
        `altitude ${Math.round(aircraft.altitude)}ft below 12k`,
        `FIRMS active fire pixel ${nearby.fires.nearest.distanceKm.toFixed(1)}km away (FRP ${nearby.fires.nearest.frp})`,
      ],
    })
  } else if (orbit?.circling && lowAlt && nearby.eonetWildfireNear) {
    out.push({
      label: 'firefighting_orbit',
      confidence: 0.75,
      reasons: [
        `circling at low altitude`,
        `EONET wildfire event "${nearby.eonetWildfireNear.title}" ${nearby.eonetWildfireNear.distanceKm.toFixed(1)}km away`,
      ],
    })
  }

  // 3. Callsign priors (medevac / SAR / LE / CBP / military / etc.)
  for (const tag of callsignTags) {
    out.push({
      label: tag.tag,
      confidence: tag.confidence,
      reasons: [`callsign prefix matches ${tag.tag} pattern`],
    })
  }

  // 4. SAR corroboration: search_rescue callsign + circling near water/coast
  //    (we can't detect "coast" without coastline data, so we just boost the
  //    confidence when circling overlaps the SAR callsign tag.)
  const hasSar = callsignTags.some(t => t.tag === 'search_rescue')
  if (hasSar && orbit?.circling) {
    out.push({
      label: 'sar_active_search',
      confidence: 0.85,
      reasons: [
        'SAR callsign prefix',
        `circling (${orbit.totalTurnDeg}° cumulative turn)`,
      ],
    })
  }

  // 5. Persistent loiter (surveillance pattern) — high-altitude circling
  //    with no callsign prior.
  const highAlt = aircraft.altitude != null && aircraft.altitude >= 15000
  if (orbit?.circling && highAlt && callsignTags.length === 0 && !squawkTag) {
    out.push({
      label: 'surveillance_loiter',
      confidence: 0.60,
      reasons: [
        `sustained circling (${orbit.totalTurnDeg}°) at ${Math.round(aircraft.altitude)}ft`,
        'no callsign prior — generic loiter pattern',
      ],
    })
  }

  // 6. Volcano overflight / avoidance — within 150km of an elevated-alert volcano
  if (nearby.volcanoNear) {
    const v = nearby.volcanoNear
    // Boost confidence when the aircraft is low + close to a RED/ORANGE volcano;
    // ash cloud interactions are a hard aviation-safety constraint.
    const highRisk = (v.colorCode === 'RED' || v.colorCode === 'ORANGE')
    out.push({
      label: 'volcano_vicinity',
      confidence: highRisk ? 0.85 : 0.70,
      reasons: [
        `${v.name} on ${v.colorCode}/${v.alertLevel} (${v.observatory})`,
        `${v.distanceKm.toFixed(0)}km from aircraft position`,
      ],
    })
  }

  // 7. Post-quake response — large recent quake near route
  const quake = nearby.quakes?.nearest
  if (quake && quake.mag >= 4.5 && quake.distanceKm < 150 && (Date.now() - quake.time) < 24 * 3600_000) {
    out.push({
      label: 'possible_post_quake_response',
      confidence: 0.55,
      reasons: [
        `M${quake.mag} quake ${quake.distanceKm.toFixed(0)}km away`,
        `occurred ${Math.round((Date.now() - quake.time) / 3600_000)}h ago`,
      ],
    })
  }

  // 8. IMC weather — strong wind/low vis/tstorm at aircraft point
  if (env.openMeteo?.visibilityM != null && env.openMeteo.visibilityM < 3000) {
    out.push({
      label: 'low_visibility_environment',
      confidence: 0.80,
      reasons: [`Open-Meteo visibility ${env.openMeteo.visibilityM}m at aircraft position`],
    })
  }
  const wxCode = env.openMeteo?.weatherCode
  if (wxCode >= 95 && wxCode <= 99) {
    out.push({
      label: 'thunderstorm_environment',
      confidence: 0.85,
      reasons: [`Open-Meteo weather code ${wxCode} (${env.openMeteo.weather}) at aircraft position`],
    })
  }

  // 9. Space weather degraded ops
  const kp = env.spaceWeather?.kp ?? env.spaceWeather?.kpEstimated
  if (kp != null && kp >= 5) {
    out.push({
      label: 'space_weather_impact',
      confidence: 0.70,
      reasons: [`Kp = ${kp} (${env.spaceWeather.classification}) — HF/GPS degradation possible`],
    })
  }

  // 10. Air-quality corroboration — PM2.5 spike + nearby fire
  //
  // bug_006 — `latest.readings` is a parallel array to `closest.sensors`
  // keyed by sensorId. We must pick the reading whose sensor's parameter is
  // `pm25`; previously we grabbed readings[0], which could be O3 / NO2 /
  // PM10 / temperature / anything, triggering false smoke-plume inferences.
  const sensors = env.airQuality?.closest?.sensors || []
  const pm25SensorId = sensors.find(s => s.parameter === 'pm25')?.id
  const pm25 = pm25SensorId != null
    ? env.airQuality?.latest?.readings?.find(r => r.sensorId === pm25SensorId)?.value
    : null
  if (nearby.fires?.count >= 3 && pm25 != null && pm25 >= 35) {
    out.push({
      label: 'fire_related_smoke_plume',
      confidence: 0.85,
      reasons: [
        `${nearby.fires.count} FIRMS fire pixels nearby`,
        `PM2.5 ${pm25} µg/m³ at nearest OpenAQ monitor`,
      ],
    })
  }

  // Deduplicate by label — keep highest-confidence instance.
  const byLabel = new Map()
  for (const inf of out) {
    const prev = byLabel.get(inf.label)
    if (!prev || inf.confidence > prev.confidence) byLabel.set(inf.label, inf)
  }
  return [...byLabel.values()].sort((a, b) => b.confidence - a.confidence)
}

// ── Main entry: build a full context bundle ────────────────────────────────

async function buildContext({ aircraft, track = null, radii = {} }) {
  const { lat, lon, altitude, velocity, heading, callsign, squawk, icao } = aircraft
  if (lat == null || lon == null) {
    throw new Error('aircraft context requires { lat, lon }')
  }

  const R = {
    fires:    radii.fires    ?? 50,
    events:   radii.events   ?? 200,
    aq:       radii.aq       ?? 15,
    cams:     radii.cams     ?? 75,
    quakes:   radii.quakes   ?? 500,
    streetlv: radii.streetlv ?? 0.25,
  }

  const [
    fires, events, aq, weather, meteo, webcams, street, space, quakes, volcanoes,
  ] = await Promise.all([
    settled(firms.fetchFires({ lat, lon, radiusKm: R.fires }),         { fires: [] }),
    settled(eonet.fetchEvents({ lat, lon, radiusKm: R.events }),       { events: [] }),
    settled(openaq.fetchNearbyAQ({ lat, lon, radiusKm: R.aq }),        { locations: [] }),
    settled(owm.fetchCurrent({ lat, lon }),                             {}),
    settled(openMeteo.fetchCurrent({ lat, lon }),                       {}),
    settled(nps.fetchNearby({ lat, lon, radiusKm: R.cams }),           { webcams: [] }),
    settled(mapillary.fetchNearest({ lat, lon, radiusKm: R.streetlv }),{ images: [] }),
    settled(swpc.fetchStatus(),                                         {}),
    settled(usgsEvents.fetchQuakes({ lat, lon, radiusKm: R.quakes }),  { quakes: [] }),
    settled(usgsEvents.fetchVolcanoAlerts(),                            { alerts: [] }),
  ])

  // Find nearest elevated-alert volcano within 150km.
  // v5.1.1 bug_018 — HANS alerts don't carry coords; usgsEvents.js now enriches
  // each alert via backend/context/volcanoCoords.js so we can do real distance
  // math here. Alerts whose vnum isn't in the table keep lat/lon=null and are
  // just skipped rather than breaking the loop.
  let volcanoNear = null
  if (volcanoes.alerts?.length) {
    let best = null
    for (const v of volcanoes.alerts) {
      if (v.lat == null || v.lon == null) continue
      const d = haversineKm(lat, lon, v.lat, v.lon)
      if (d <= 150 && (!best || d < best.distanceKm)) {
        best = { ...v, distanceKm: d }
      }
    }
    if (best) volcanoNear = best
  }
  // EONET wildfire near (within a few km)
  const eonetWildfireNear = events.events?.find(e =>
    e.categories.includes('wildfires') && e.distanceKm < 10
  )

  const orbit = track ? detectOrbit(track) : null
  const callsignTags = classifyCallsign(callsign)
  const squawkTag = classifySquawk(squawk)

  const nearby = {
    fires,
    events,
    quakes,
    volcanoAlerts: volcanoes,
    volcanoNear,
    eonetWildfireNear,
    webcams,
    streetLevel: street,
  }
  const env = {
    weather, openMeteo: meteo, airQuality: aq, spaceWeather: space,
  }

  const inferences = runInferences({
    aircraft: { altitude, velocity, heading, callsign, squawk, icao, lat, lon },
    orbit, callsignTags, squawkTag, nearby, env,
  })

  return {
    v: 2,
    generatedAt: new Date().toISOString(),
    aircraft: { icao, callsign, squawk, lat, lon, altitude, velocity, heading },
    orbit,
    priors: { callsignTags, squawkTag },
    nearby,
    env,
    inferences,
  }
}

module.exports = { buildContext }
