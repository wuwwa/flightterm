// ── Cross-referenced SWIM analytics ─────────────────────────────────────────
// Computes real-time analytics by joining across flight_plans, flow_events,
// airport_configs, terminal_weather, and surface_events tables.
// All functions are self-contained and handle missing/empty data gracefully.

const { db } = require('./db')

// ── 1. Airport delay scores ────────────────────────────────────────────────

function getAirportDelayScores() {
  const activeStatuses = ['ACTIVE', 'ASCENDING', 'CRUISING', 'DESCENDING']
  const allStatuses = [...activeStatuses, 'FILED']

  // Active flight plans updated in the last 2 hours
  const flights = db.prepare(`
    SELECT acid, dep_arpt, arr_arpt, flight_status, etd, eta, atd, ata
    FROM flight_plans
    WHERE flight_status IN (${allStatuses.map(() => '?').join(',')})
      AND updated_at > datetime('now', '-2 hours')
  `).all(...allStatuses)

  // Surface OOOI events from last 2 hours
  const surfaceEvents = db.prepare(`
    SELECT callsign, airport, event_type, received_at
    FROM surface_events
    WHERE event_type IN ('SPOT_OUT', 'OFF', 'ON', 'SPOT_IN')
      AND received_at > datetime('now', '-2 hours')
  `).all()

  // Most recent flow event per airport
  const flowEvents = db.prepare(`
    SELECT airport, event_type, delay_minutes, status,
           ROW_NUMBER() OVER (PARTITION BY airport ORDER BY received_at DESC) AS rn
    FROM flow_events
    WHERE airport IS NOT NULL
      AND received_at > datetime('now', '-6 hours')
  `).all()

  const latestFlow = new Map()
  for (const fe of flowEvents) {
    if (fe.rn === 1) {
      latestFlow.set(fe.airport, fe)
    }
  }

  // Collect all airports
  const airports = new Set()
  for (const f of flights) {
    if (f.dep_arpt) airports.add(f.dep_arpt)
    if (f.arr_arpt) airports.add(f.arr_arpt)
  }

  const results = []

  for (const airport of airports) {
    const inboundFlights = flights.filter(
      f => f.arr_arpt === airport && activeStatuses.includes(f.flight_status)
    )
    const outboundFlights = flights.filter(
      f => f.dep_arpt === airport && (f.flight_status === 'ACTIVE' || f.flight_status === 'FILED')
    )

    // Average arrival delay (eta vs ata)
    let arrDelaySum = 0
    let arrDelayCount = 0
    for (const f of flights) {
      if (f.arr_arpt === airport && f.eta && f.ata) {
        const delay = (new Date(f.ata) - new Date(f.eta)) / 60000
        if (isFinite(delay)) {
          arrDelaySum += delay
          arrDelayCount++
        }
      }
    }

    // Average departure delay (etd vs atd)
    let depDelaySum = 0
    let depDelayCount = 0
    for (const f of flights) {
      if (f.dep_arpt === airport && f.etd && f.atd) {
        const delay = (new Date(f.atd) - new Date(f.etd)) / 60000
        if (isFinite(delay)) {
          depDelaySum += delay
          depDelayCount++
        }
      }
    }

    const flow = latestFlow.get(airport) || null

    results.push({
      airport,
      inbound: inboundFlights.length,
      outbound: outboundFlights.length,
      avgArrDelay: arrDelayCount > 0 ? Math.round((arrDelaySum / arrDelayCount) * 10) / 10 : null,
      avgDepDelay: depDelayCount > 0 ? Math.round((depDelaySum / depDelayCount) * 10) / 10 : null,
      flowEvent: flow ? flow.event_type : null,
      flowDelay: flow ? flow.delay_minutes : null,
    })
  }

  // Sort by worst delay (highest average of arr + dep delay first)
  results.sort((a, b) => {
    const worstA = Math.max(a.avgArrDelay || 0, a.avgDepDelay || 0)
    const worstB = Math.max(b.avgArrDelay || 0, b.avgDepDelay || 0)
    return worstB - worstA
  })

  return results
}

// ── 2. Capacity vs demand ──────────────────────────────────────────────────

function getCapacityDemand() {
  const configs = db.prepare(`
    SELECT airport, arr_rate, dep_rate, weather, arr_runway, dep_runway
    FROM airport_configs
  `).all()

  if (configs.length === 0) return []

  const activeStatuses = ['ACTIVE', 'ASCENDING', 'CRUISING', 'DESCENDING', 'FILED']

  const flights = db.prepare(`
    SELECT dep_arpt, arr_arpt
    FROM flight_plans
    WHERE flight_status IN (${activeStatuses.map(() => '?').join(',')})
      AND updated_at > datetime('now', '-2 hours')
  `).all(...activeStatuses)

  // Count demand per airport
  const arrDemandMap = new Map()
  const depDemandMap = new Map()
  for (const f of flights) {
    if (f.arr_arpt) arrDemandMap.set(f.arr_arpt, (arrDemandMap.get(f.arr_arpt) || 0) + 1)
    if (f.dep_arpt) depDemandMap.set(f.dep_arpt, (depDemandMap.get(f.dep_arpt) || 0) + 1)
  }

  const results = []

  for (const cfg of configs) {
    const arrDemand = arrDemandMap.get(cfg.airport) || 0
    const depDemand = depDemandMap.get(cfg.airport) || 0
    const arrCapacity = cfg.arr_rate || 0
    const depCapacity = cfg.dep_rate || 0

    results.push({
      airport: cfg.airport,
      arrDemand,
      depDemand,
      arrCapacity,
      depCapacity,
      arrLoad: arrCapacity > 0 ? Math.round((arrDemand / arrCapacity) * 100) / 100 : null,
      depLoad: depCapacity > 0 ? Math.round((depDemand / depCapacity) * 100) / 100 : null,
      weather: cfg.weather || null,
      arrRunway: cfg.arr_runway || null,
      depRunway: cfg.dep_runway || null,
    })
  }

  // Sort by maximum load factor descending
  results.sort((a, b) => {
    const maxA = Math.max(a.arrLoad || 0, a.depLoad || 0)
    const maxB = Math.max(b.arrLoad || 0, b.depLoad || 0)
    return maxB - maxA
  })

  return results
}

// ── 3. Cascade impact ──────────────────────────────────────────────────────

function getCascadeImpact() {
  const flowEvents = db.prepare(`
    SELECT id, event_type, airport, delay_minutes, status, start_time, end_time
    FROM flow_events
    WHERE event_type IN ('GS', 'GDP')
      AND received_at > datetime('now', '-6 hours')
      AND airport IS NOT NULL
  `).all()

  if (flowEvents.length === 0) return []

  const airborneStatuses = ['ACTIVE', 'ASCENDING', 'CRUISING', 'DESCENDING']

  const stmtAirborne = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM flight_plans
    WHERE arr_arpt = ?
      AND flight_status IN (${airborneStatuses.map(() => '?').join(',')})
  `)

  const stmtGroundHeld = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM flight_plans
    WHERE dep_arpt = ?
      AND flight_status = 'FILED'
  `)

  const stmtDelaySum = db.prepare(`
    SELECT COALESCE(SUM(fe.delay_minutes), 0) AS total_delay
    FROM flow_events fe
    WHERE fe.airport = ?
      AND fe.received_at > datetime('now', '-6 hours')
  `)

  const results = []

  for (const evt of flowEvents) {
    const airborne = stmtAirborne.get(evt.airport, ...airborneStatuses)
    const ground = stmtGroundHeld.get(evt.airport)
    const delayInfo = stmtDelaySum.get(evt.airport)

    const airborneAffected = airborne ? airborne.cnt : 0
    const groundHeld = ground ? ground.cnt : 0
    const totalAffected = airborneAffected + groundHeld
    const delayMin = evt.delay_minutes || 0
    const estimatedTotalDelayMin = Math.round(delayMin * totalAffected)

    results.push({
      airport: evt.airport,
      eventType: evt.event_type,
      delayMinutes: delayMin,
      airborneAffected,
      groundHeld,
      totalAffected,
      estimatedTotalDelayMin,
    })
  }

  // Sort by total affected descending
  results.sort((a, b) => b.totalAffected - a.totalAffected)

  return results
}

// ── 4. Flight lifecycle ────────────────────────────────────────────────────

function getFlightLifecycle(acid) {
  if (!acid) return null

  const plan = db.prepare(`
    SELECT acid, dep_arpt, arr_arpt, aircraft_type, flight_status,
           etd, eta, atd, ata, route, altitude, speed, beacon_code,
           lat, lon, reported_alt, msg_type, received_at, updated_at
    FROM flight_plans
    WHERE acid = ?
  `).get(acid)

  const surfaceEvents = db.prepare(`
    SELECT event_type, airport, received_at, gate, runway, taxiway
    FROM surface_events
    WHERE callsign = ?
      AND received_at > datetime('now', '-6 hours')
    ORDER BY received_at ASC
  `).all(acid)

  // Build timeline
  const timeline = []

  if (plan) {
    if (plan.etd) {
      timeline.push({ phase: 'FILED', timestamp: plan.etd, source: 'flight_plan' })
      timeline.push({ phase: 'ETD', timestamp: plan.etd, source: 'flight_plan' })
    }
    if (plan.eta) {
      timeline.push({ phase: 'ETA', timestamp: plan.eta, source: 'flight_plan' })
    }
    if (plan.atd) {
      timeline.push({ phase: 'ATD', timestamp: plan.atd, source: 'flight_plan' })
    }
    if (plan.ata) {
      timeline.push({ phase: 'ATA', timestamp: plan.ata, source: 'flight_plan' })
    }
  }

  // Surface events: SPOT_OUT, OFF, ON, SPOT_IN
  const surfaceTimes = {}
  for (const evt of surfaceEvents) {
    timeline.push({ phase: evt.event_type, timestamp: evt.received_at, source: 'surface_event' })
    // Keep the first occurrence for taxi calculations
    if (!surfaceTimes[evt.event_type]) {
      surfaceTimes[evt.event_type] = new Date(evt.received_at)
    }
  }

  // Add current flight status as a phase marker
  if (plan && plan.flight_status) {
    timeline.push({
      phase: plan.flight_status,
      timestamp: plan.updated_at,
      source: 'flight_plan_status',
    })
  }

  // Sort timeline chronologically
  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

  // Compute taxi times
  let taxiOutMin = null
  let taxiInMin = null
  let gateToGateMin = null

  if (surfaceTimes.SPOT_OUT && surfaceTimes.OFF) {
    taxiOutMin = Math.round(((surfaceTimes.OFF - surfaceTimes.SPOT_OUT) / 60000) * 10) / 10
  }
  if (surfaceTimes.ON && surfaceTimes.SPOT_IN) {
    taxiInMin = Math.round(((surfaceTimes.SPOT_IN - surfaceTimes.ON) / 60000) * 10) / 10
  }

  // Gate-to-gate: prefer SPOT_IN - SPOT_OUT, fallback to ATA - ATD
  if (surfaceTimes.SPOT_IN && surfaceTimes.SPOT_OUT) {
    gateToGateMin = Math.round(((surfaceTimes.SPOT_IN - surfaceTimes.SPOT_OUT) / 60000) * 10) / 10
  } else if (plan && plan.ata && plan.atd) {
    const diff = (new Date(plan.ata) - new Date(plan.atd)) / 60000
    if (isFinite(diff)) {
      gateToGateMin = Math.round(diff * 10) / 10
    }
  }

  return {
    acid,
    depArpt: plan ? plan.dep_arpt : null,
    arrArpt: plan ? plan.arr_arpt : null,
    status: plan ? plan.flight_status : null,
    timeline,
    taxiOutMin,
    taxiInMin,
    gateToGateMin,
    plan: plan || null,
  }
}

// ── 5. Aggregate taxi times ────────────────────────────────────────────────

function getTaxiTimes() {
  const events = db.prepare(`
    SELECT callsign, airport, event_type, received_at
    FROM surface_events
    WHERE event_type IN ('SPOT_OUT', 'OFF', 'ON', 'SPOT_IN')
      AND received_at > datetime('now', '-2 hours')
      AND callsign IS NOT NULL
      AND airport IS NOT NULL
    ORDER BY callsign, received_at ASC
  `).all()

  if (events.length === 0) return []

  // Group events by callsign+airport
  const grouped = new Map()
  for (const evt of events) {
    const key = `${evt.callsign}|${evt.airport}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(evt)
  }

  // For each callsign/airport pair, compute taxi out (SPOT_OUT -> OFF) and taxi in (ON -> SPOT_IN)
  // airportData: airport -> { taxiOuts: number[], taxiIns: number[] }
  const airportData = new Map()

  for (const [key, evts] of grouped) {
    const airport = evts[0].airport
    if (!airportData.has(airport)) {
      airportData.set(airport, { taxiOuts: [], taxiIns: [] })
    }
    const data = airportData.get(airport)

    let spotOut = null
    let onTime = null

    for (const evt of evts) {
      if (evt.event_type === 'SPOT_OUT') {
        spotOut = new Date(evt.received_at)
      } else if (evt.event_type === 'OFF' && spotOut) {
        const minutes = (new Date(evt.received_at) - spotOut) / 60000
        if (isFinite(minutes) && minutes > 0 && minutes < 180) {
          data.taxiOuts.push(minutes)
        }
        spotOut = null
      } else if (evt.event_type === 'ON') {
        onTime = new Date(evt.received_at)
      } else if (evt.event_type === 'SPOT_IN' && onTime) {
        const minutes = (new Date(evt.received_at) - onTime) / 60000
        if (isFinite(minutes) && minutes > 0 && minutes < 180) {
          data.taxiIns.push(minutes)
        }
        onTime = null
      }
    }
  }

  const results = []

  for (const [airport, data] of airportData) {
    const samples = data.taxiOuts.length + data.taxiIns.length
    if (samples === 0) continue

    const avgTaxiOut = data.taxiOuts.length > 0
      ? data.taxiOuts.reduce((a, b) => a + b, 0) / data.taxiOuts.length
      : null
    const avgTaxiIn = data.taxiIns.length > 0
      ? data.taxiIns.reduce((a, b) => a + b, 0) / data.taxiIns.length
      : null
    const maxTaxiOut = data.taxiOuts.length > 0 ? Math.max(...data.taxiOuts) : null
    const maxTaxiIn = data.taxiIns.length > 0 ? Math.max(...data.taxiIns) : null

    results.push({
      airport,
      avgTaxiOutMin: avgTaxiOut !== null ? Math.round(avgTaxiOut * 10) / 10 : null,
      avgTaxiInMin: avgTaxiIn !== null ? Math.round(avgTaxiIn * 10) / 10 : null,
      samples,
      maxTaxiOut: maxTaxiOut !== null ? Math.round(maxTaxiOut * 10) / 10 : null,
      maxTaxiIn: maxTaxiIn !== null ? Math.round(maxTaxiIn * 10) / 10 : null,
    })
  }

  results.sort((a, b) => b.samples - a.samples)

  return results
}

// ── 6. Weather–flow correlation ────────────────────────────────────────────

function getWeatherCorrelation() {
  const weatherEvents = db.prepare(`
    SELECT id, event_type, airport, severity, received_at
    FROM terminal_weather
    WHERE severity IN ('CRITICAL', 'HIGH')
      AND received_at > datetime('now', '-2 hours')
      AND airport IS NOT NULL
    ORDER BY received_at DESC
  `).all()

  if (weatherEvents.length === 0) return []

  const flowEvents = db.prepare(`
    SELECT event_type, airport, delay_minutes, received_at
    FROM flow_events
    WHERE received_at > datetime('now', '-2 hours')
      AND airport IS NOT NULL
    ORDER BY received_at ASC
  `).all()

  const results = []

  for (const wx of weatherEvents) {
    const wxTime = new Date(wx.received_at)

    // Find a flow event at the same airport within 15 minutes after the weather event
    let matchedFlow = null
    let correlationMinutes = null

    for (const fe of flowEvents) {
      if (fe.airport !== wx.airport) continue
      const feTime = new Date(fe.received_at)
      const diffMin = (feTime - wxTime) / 60000
      // Flow event must be 0-15 minutes after the weather event
      if (diffMin >= 0 && diffMin <= 15) {
        matchedFlow = fe
        correlationMinutes = Math.round(diffMin * 10) / 10
        break
      }
    }

    results.push({
      airport: wx.airport,
      weatherEvent: wx.event_type,
      weatherSeverity: wx.severity,
      weatherTime: wx.received_at,
      flowEvent: matchedFlow ? matchedFlow.event_type : null,
      flowType: matchedFlow ? matchedFlow.event_type : null,
      flowDelay: matchedFlow ? matchedFlow.delay_minutes : null,
      correlationMinutes: matchedFlow ? correlationMinutes : null,
    })
  }

  return results
}

// ── 7. NAS health index ────────────────────────────────────────────────────

function getNasHealthIndex() {
  // Active flow events
  const flowEvents = db.prepare(`
    SELECT event_type, airport, delay_minutes
    FROM flow_events
    WHERE received_at > datetime('now', '-2 hours')
  `).all()

  // Critical/high weather events
  const criticalWeather = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM terminal_weather
    WHERE severity IN ('CRITICAL', 'HIGH')
      AND received_at > datetime('now', '-2 hours')
  `).get()

  const criticalWeatherCount = criticalWeather ? criticalWeather.cnt : 0

  // Compute weighted flow score
  let weightedFlowScore = 0
  let totalDelayMinutes = 0
  let activeGroundStops = 0
  let activeGDPs = 0
  const affectedAirportsSet = new Set()

  for (const fe of flowEvents) {
    if (fe.airport) affectedAirportsSet.add(fe.airport)

    switch (fe.event_type) {
      case 'GS':
        weightedFlowScore += 10
        activeGroundStops++
        break
      case 'GDP':
        weightedFlowScore += 5
        activeGDPs++
        break
      default:
        weightedFlowScore += 2
        break
    }

    if (fe.delay_minutes && isFinite(fe.delay_minutes)) {
      totalDelayMinutes += fe.delay_minutes
    }
  }

  const delayPenalty = Math.min(30, totalDelayMinutes / 100)
  const weatherPenalty = Math.min(20, criticalWeatherCount * 5)

  const rawScore = 100 - (weightedFlowScore + delayPenalty + weatherPenalty)
  const score = Math.max(0, Math.min(100, Math.round(rawScore * 10) / 10))

  let label
  if (score >= 80) label = 'NORMAL'
  else if (score >= 60) label = 'MODERATE'
  else if (score >= 40) label = 'STRESSED'
  else label = 'SEVERE'

  return {
    score,
    label,
    activeGroundStops,
    activeGDPs,
    totalDelayMin: Math.round(totalDelayMinutes),
    affectedAirports: affectedAirportsSet.size,
    criticalWeather: criticalWeatherCount,
    details: {
      weightedFlowScore,
      delayPenalty: Math.round(delayPenalty * 10) / 10,
      weatherPenalty,
      flowEventCount: flowEvents.length,
    },
  }
}

// ── exports ────────────────────────────────────────────────────────────────

module.exports = {
  getAirportDelayScores,
  getCapacityDemand,
  getCascadeImpact,
  getFlightLifecycle,
  getTaxiTimes,
  getWeatherCorrelation,
  getNasHealthIndex,
}
