import { useMemo } from 'react'
import clsx from 'clsx'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import { detectPhase, PHASE } from '../../utils/anomaly'

// ── Airline prefixes for classification ──────────────────────────────────────
const CARGO_PREFIXES = ['FDX', 'UPS', 'GTI', 'ATN', 'ABX', 'CLX', 'CKS', 'BOX', 'MPH', 'KAL', 'CAL']  // FedEx, UPS, Atlas, Amazon, ABX, Cargolux, Kalitta, AirBridgeCargo
const AIRLINE_PREFIXES = ['AAL', 'DAL', 'UAL', 'SWA', 'JBU', 'NKS', 'FFT', 'ASA', 'HAL', 'SKW', 'RPA', 'ENY', 'PDT', 'JIA', 'QXE', 'ASH', 'EDV', 'GJS', 'ACA', 'WJA', 'BAW', 'DLH', 'AFR', 'EIN', 'KLM', 'UAE']
const BIZ_AIRPORTS = ['KTEB', 'KVNY', 'KSDL', 'KPBI', 'KBED', 'KHPN', 'KASH', 'KFXE', 'KAPA', 'KOPF', 'KLUK', 'KDPA'] // Teterboro, Van Nuys, Scottsdale, Palm Beach, Bedford, White Plains, etc.

function isBizJet(f, enrichCache) {
  // Non-airline, small/light aircraft with N-registration or no standard callsign
  const cs = f.callsign || ''
  const isAirline = AIRLINE_PREFIXES.some(p => cs.startsWith(p)) || CARGO_PREFIXES.some(p => cs.startsWith(p))
  if (isAirline) return false
  const cat = f.category || enrichCache[f.icao]?.adsbfi?.category || enrichCache[f.icao]?.apl?.category || ''
  // A1 (light), A2 (small), or unknown with N-registration pattern
  return cat === 'A1' || cat === 'A2' || (!cat && cs.startsWith('N'))
}

function isCargo(f) {
  return CARGO_PREFIXES.some(p => (f.callsign || '').startsWith(p))
}

// ── Detect holding patterns from heading history ────────────────────────────
function isHolding(snapshots) {
  if (!snapshots || snapshots.length < 6) return false
  const recent = snapshots.slice(-8)
  let totalTurn = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].hdg == null || recent[i - 1].hdg == null) continue
    let d = recent[i].hdg - recent[i - 1].hdg
    if (d > 180) d -= 360
    if (d < -180) d += 360
    totalTurn += Math.abs(d)
  }
  return totalTurn > 270 // >270° of cumulative heading change = likely holding
}

// ── Detect go-arounds from altitude profile near airports ───────────────────
const MAJOR_AIRPORTS = [
  { icao: 'KATL', lat: 33.637, lon: -84.428 }, { icao: 'KLAX', lat: 33.943, lon: -118.408 },
  { icao: 'KORD', lat: 41.974, lon: -87.907 }, { icao: 'KDFW', lat: 32.897, lon: -97.038 },
  { icao: 'KDEN', lat: 39.852, lon: -104.673 }, { icao: 'KJFK', lat: 40.641, lon: -73.778 },
  { icao: 'KSFO', lat: 37.619, lon: -122.379 }, { icao: 'KLAS', lat: 36.084, lon: -115.152 },
  { icao: 'KMIA', lat: 25.796, lon: -80.287 }, { icao: 'KSEA', lat: 47.449, lon: -122.309 },
  { icao: 'KEWR', lat: 40.693, lon: -74.169 }, { icao: 'KBOS', lat: 42.366, lon: -71.010 },
]

function distKm(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
  const dy = (lat2 - lat1) * 111.32
  return Math.sqrt(dx * dx + dy * dy)
}

function isGoAround(snapshots) {
  if (!snapshots || snapshots.length < 5) return false
  const recent = snapshots.slice(-6)
  // Check if near an airport
  const last = recent[recent.length - 1]
  if (!last.lat || !last.lon) return false
  const nearApt = MAJOR_AIRPORTS.some(a => distKm(last.lat, last.lon, a.lat, a.lon) < 20)
  if (!nearApt) return false
  // Check for descent then climb pattern below 3000ft
  const alts = recent.map(s => s.alt).filter(a => a != null)
  if (alts.length < 4) return false
  const altFt = alts.map(a => a * 3.281)
  // Find a local minimum below 3000ft followed by climb
  for (let i = 1; i < altFt.length - 1; i++) {
    if (altFt[i] < 3000 && altFt[i] < altFt[i - 1] && altFt[i + 1] > altFt[i] + 200) return true
  }
  return false
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function Signals({ flights = [], trackHistory = {}, enrichCache = {} }) {
  const signals = useMemo(() => {
    if (!flights.length) return null

    const airborne = flights.filter(f => !f.grounded)
    const total = flights.length

    // ── Business jet signal ─────────────────────────────────────────────
    const bizJets = flights.filter(f => isBizJet(f, enrichCache))
    const bizJetsToBizAirports = bizJets.filter(f => {
      const arr = f.tfms?.arr_arpt
      return arr && BIZ_AIRPORTS.includes(arr)
    })
    const bizPct = total > 0 ? ((bizJets.length / total) * 100).toFixed(1) : 0

    // ── Cargo pulse ─────────────────────────────────────────────────────
    const cargoFlights = flights.filter(f => isCargo(f))
    const cargoAirborne = cargoFlights.filter(f => !f.grounded).length

    // ── Military signal ─────────────────────────────────────────────────
    const milFlights = flights.filter(f => f.mil)
    // Rough geographic clustering
    const milRegions = { east: 0, central: 0, west: 0, other: 0 }
    for (const f of milFlights) {
      if (f.lon == null) { milRegions.other++; continue }
      if (f.lon > -80) milRegions.east++
      else if (f.lon > -100) milRegions.central++
      else milRegions.west++
    }

    // ── Diversion rate ──────────────────────────────────────────────────
    const withRoute = airborne.filter(f => f.routeDeviation != null)
    const diverting = withRoute.filter(f => f.routeDeviation > 50)
    const diversionRate = withRoute.length > 0 ? ((diverting.length / withRoute.length) * 100).toFixed(1) : 0

    // ── Holding patterns ────────────────────────────────────────────────
    let holdingCount = 0
    for (const f of airborne) {
      if (isHolding(trackHistory[f.icao])) holdingCount++
    }

    // ── Go-arounds ──────────────────────────────────────────────────────
    let goAroundCount = 0
    for (const f of airborne) {
      if (isGoAround(trackHistory[f.icao])) goAroundCount++
    }

    // ── Cruise altitude trend (fuel price proxy) ────────────────────────
    const cruising = airborne.filter(f => {
      const hist = trackHistory[f.icao]
      return hist?.length >= 2 && detectPhase(hist) === PHASE.CRUISE && f.alt != null
    })
    const avgCruiseAlt = cruising.length > 10
      ? Math.round(cruising.reduce((s, f) => s + f.alt * 3.281, 0) / cruising.length)
      : null

    // ── Network stress (airports with delays) ───────────────────────────
    // Count airports where flights are diverting or holding
    const stressedAirports = new Set()
    for (const f of diverting) {
      if (f.tfms?.arr_arpt) stressedAirports.add(f.tfms.arr_arpt)
    }

    // ── Biz jet destination breakdown ───────────────────────────────────
    const bizDests = {}
    for (const f of bizJets) {
      const arr = f.tfms?.arr_arpt?.replace(/^K/, '') || null
      if (arr) bizDests[arr] = (bizDests[arr] || 0) + 1
    }
    const topBizDests = Object.entries(bizDests)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([apt, count]) => ({ apt, count }))

    return {
      bizJets: bizJets.length, bizPct, bizJetsToBizAirports: bizJetsToBizAirports.length,
      cargoFlights: cargoFlights.length, cargoAirborne,
      milFlights: milFlights.length, milRegions,
      diversionRate, divertingCount: diverting.length, withRouteCount: withRoute.length,
      holdingCount, goAroundCount,
      avgCruiseAlt,
      stressedAirports: stressedAirports.size,
      topBizDests,
    }
  }, [flights, trackHistory, enrichCache])

  if (!signals) return null

  return (
    <div className="space-y-px bg-border">
      {/* Signal cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">

        {/* Business aviation signal */}
        <SignalCard
          title="Business Aviation"
          headline={`${signals.bizJets} private/biz jets tracked`}
          detail={`${signals.bizPct}% of all traffic · ${signals.bizJetsToBizAirports} heading to executive airports`}
          severity={signals.bizJetsToBizAirports > 20 ? 'high' : signals.bizJetsToBizAirports > 10 ? 'medium' : 'normal'}
          hint="Spike in biz jet traffic to TEB/VNY/SDL signals M&A activity, conferences, or deal flow"
        >
          {signals.topBizDests.length > 0 && (
            <div className="mt-1.5">
              <div className="text-[8px] text-fg3/40 mb-0.5">Top destinations</div>
              <div className="flex gap-1.5 flex-wrap">
                {signals.topBizDests.map(d => (
                  <span key={d.apt} className="text-[8px] text-fg2">
                    <span className="text-acc">{d.apt}</span> <span className="text-fg3">{d.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </SignalCard>

        {/* Cargo pulse */}
        <SignalCard
          title="Cargo Pulse"
          headline={`${signals.cargoFlights} cargo flights · ${signals.cargoAirborne} airborne`}
          detail="FedEx, UPS, Atlas, Amazon Prime Air, Kalitta, Cargolux"
          severity={signals.cargoAirborne > 100 ? 'high' : signals.cargoAirborne > 40 ? 'medium' : 'normal'}
          hint="Cargo volume correlates with e-commerce demand and supply chain throughput"
        />

        {/* Military activity */}
        <SignalCard
          title="Military Activity"
          headline={`${signals.milFlights} military aircraft`}
          detail={`East: ${signals.milRegions.east} · Central: ${signals.milRegions.central} · West: ${signals.milRegions.west}`}
          severity={signals.milFlights > 200 ? 'high' : signals.milFlights > 50 ? 'medium' : 'normal'}
          hint="Unusual military concentration in a region may signal exercises, deployments, or real-world events"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-px bg-border">
        {/* Diversion rate */}
        <SignalCard
          title="Diversion Rate"
          headline={`${signals.diversionRate}%`}
          detail={`${signals.divertingCount} of ${signals.withRouteCount} flights >50km off route`}
          severity={parseFloat(signals.diversionRate) > 5 ? 'high' : parseFloat(signals.diversionRate) > 2 ? 'medium' : 'normal'}
          hint="Diversions spike before weather models update — a leading indicator of conditions worse than forecast"
        />

        {/* Holding patterns */}
        <SignalCard
          title="Holding Patterns"
          headline={`${signals.holdingCount} aircraft`}
          detail="Detected from >270° cumulative heading change"
          severity={signals.holdingCount > 20 ? 'high' : signals.holdingCount > 5 ? 'medium' : 'normal'}
          hint="Holding builds before delays show in official statistics — early congestion warning"
        />

        {/* Go-arounds */}
        <SignalCard
          title="Go-Arounds"
          headline={`${signals.goAroundCount} detected`}
          detail="Descent below 3000ft then climb near major airport"
          severity={signals.goAroundCount > 10 ? 'high' : signals.goAroundCount > 3 ? 'medium' : 'normal'}
          hint="Elevated go-around rate = wind shear, low visibility, or runway issues at the airport"
        />

        {/* Cruise altitude (fuel proxy) */}
        <SignalCard
          title="Avg Cruise Altitude"
          headline={signals.avgCruiseAlt ? `FL${Math.round(signals.avgCruiseAlt / 100)}` : '—'}
          detail={signals.avgCruiseAlt ? `${signals.avgCruiseAlt.toLocaleString()}ft average` : 'Not enough data'}
          severity="normal"
          hint="Airlines fly higher when fuel is expensive — altitude trends proxy jet fuel prices"
        />
      </div>
    </div>
  )
}

function SignalCard({ title, headline, detail, severity, hint, children }) {
  const borderColor = severity === 'high' ? 'border-l-red' : severity === 'medium' ? 'border-l-ylw' : 'border-l-border'
  return (
    <div className={clsx('bg-bg1 p-2 border-l-2', borderColor)}>
      <div className="text-[9px] text-fg3/50 uppercase">{title}</div>
      <div className={clsx('text-[12px] font-bold tabular-nums mt-0.5',
        severity === 'high' ? 'text-red' : severity === 'medium' ? 'text-ylw' : 'text-fg2'
      )}>{headline}</div>
      <div className="text-[8px] text-fg3 mt-0.5">{detail}</div>
      {children}
      <div className="text-[7px] text-fg3/30 mt-1 italic">{hint}</div>
    </div>
  )
}
