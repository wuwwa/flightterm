// ── Flight Dossier — v5.3.0 ─────────────────────────────────────────────────
// Full-page deep dive for one aircraft. URL-addressable at #flight=<icao>.
// Aggregates every data source we have for this ICAO in parallel fetches and
// renders sections as they land. Reuses ContextPanel, FlightMap, TrackChart
// from the inspector modal; adds historical + weather-on-route + externals.

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { LineChart, Line, XAxis, YAxis, Tooltip as RTTooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import FlightMap from './FlightMap'
import ContextPanel from './ContextPanel'
import { squawkLabel, squawkColor } from '../utils/squawk'
import { fetchDossier, fetchMetar, fetchNearby, fetchByOperator, fetchByType, fetchCallsignHistory } from '../services/flight'
import { pickSector, goesImageUrl, goesLoopUrl, latLonToSectorPct } from '../utils/goes'

function fmtTime(s) {
  if (!s) return '—'
  try { return new Date(s).toISOString().substring(11, 16) + 'z' } catch { return s }
}
function fmtDate(s) {
  if (!s) return '—'
  try { return new Date(s).toISOString().substring(0, 10) } catch { return s }
}
function fmtNum(n, suffix = '') {
  if (n == null) return '—'
  return Number(n).toLocaleString() + suffix
}

function Row({ label, value, color = 'text-fg2', mono = true, onClick, active }) {
  const clickable = !!onClick
  return (
    <div className={clsx(
      'flex items-baseline justify-between gap-2 py-0.5 text-[11px] border-b border-white/3 last:border-b-0',
      clickable && 'cursor-pointer',
      active && 'bg-acc/10'
    )}
      onClick={onClick}
      title={clickable ? 'click to drill in' : undefined}
    >
      <span className="text-fg3 text-[10px] uppercase tracking-wide shrink-0">{label}</span>
      <span className={clsx('text-right truncate', mono && 'tabular-nums', color, clickable && 'border-b border-dotted border-current/40 hover:text-fg')}>
        {value ?? <span className="text-fg3/30">—</span>}
      </span>
    </div>
  )
}

// v5.4.0 — drill-in panel. Appears below a clickable Row, scoped to its tile.
function DrillIn({ title, loading, error, onClose, children }) {
  return (
    <div className="mt-1.5 pt-1.5 border-t border-acc/30 bg-acc/5 rounded p-1.5 relative">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-acc text-[9px] uppercase tracking-wide">{title}</span>
        <button onClick={onClose} className="text-fg3 hover:text-fg text-[10px] cursor-pointer">×</button>
      </div>
      {loading && <div className="text-fg3/50 text-[10px] py-1">loading…</div>}
      {error && <div className="text-red text-[10px] py-1">{error}</div>}
      {!loading && !error && children}
    </div>
  )
}

// Helper — a compact flight row that's clickable to open its dossier.
function SiblingRow({ f }) {
  const href = `#flight=${f.icao}${f.callsign ? '&cs=' + encodeURIComponent(f.callsign) : ''}`
  return (
    <a href={href} className="flex justify-between items-baseline text-[10px] py-0.5 border-b border-white/3 last:border-b-0 hover:bg-bg2/60 px-0.5 rounded cursor-pointer">
      <span className="flex items-baseline gap-1.5 truncate">
        <span className="text-ylw font-mono">{f.callsign || f.icao}</span>
        {f.acType && <span className="text-fg3">{f.acType}</span>}
        {f.mil && <span className="text-red text-[8px] uppercase">mil</span>}
      </span>
      <span className="shrink-0 text-fg3 tabular-nums">
        {f.distNm != null && <span className="text-cyn mr-1">{f.distNm}nm</span>}
        {f.altFt != null && `${f.altFt.toLocaleString()}ft`}
      </span>
    </a>
  )
}

function Tile({ title, accent, children, className, wide }) {
  return (
    <div className={clsx(
      'bg-bg2/40 border border-border rounded p-2.5 flex flex-col min-h-0',
      wide && 'md:col-span-2 xl:col-span-3',
      className
    )}>
      <div className={clsx('text-[10px] uppercase tracking-wide mb-1.5 pb-1 border-b border-border flex items-center justify-between', accent || 'text-fg2')}>
        <span>{title}</span>
      </div>
      <div className="flex-1 min-h-0">
        {children}
      </div>
    </div>
  )
}

function Chip({ children, tone = 'fg3', title }) {
  const cls = {
    red: 'border-red/60 text-red bg-red/10',
    ylw: 'border-ylw/50 text-ylw bg-ylw/5',
    acc: 'border-acc/50 text-acc bg-acc/5',
    grn: 'border-grn/50 text-grn bg-grn/5',
    mag: 'border-mag/50 text-mag bg-mag/5',
    cyn: 'border-cyn/50 text-cyn bg-cyn/5',
    fg3: 'border-border text-fg3 bg-bg2/40',
  }[tone] || 'border-border text-fg3 bg-bg2/40'
  return <span title={title} className={clsx('inline-block px-1.5 py-[1px] text-[9px] uppercase tracking-wide border rounded mr-1', cls)}>{children}</span>
}

// ── Profile chart (altitude + speed over time) ──────────────────────────────

function TrackProfile({ track }) {
  const data = useMemo(() => {
    if (!Array.isArray(track) || track.length === 0) return []
    return track.map(p => ({
      t: p.seen_at ? new Date(p.seen_at).getTime() : null,
      altFt: p.alt != null ? Math.round(p.alt * 3.281) : null,
      velKt: p.vel != null ? Math.round(p.vel * 1.944) : null,
    })).filter(p => p.t != null).sort((a, b) => a.t - b.t)
  }, [track])

  if (data.length < 2) {
    return <div className="text-fg3/40 text-[10px] text-center py-6">need ≥2 samples to plot (DB is fresh — will populate over next few polls)</div>
  }
  const t0 = data[0].t
  const rel = data.map(d => ({ ...d, tSec: Math.round((d.t - t0) / 1000) }))
  const peakAlt = Math.max(...rel.map(r => r.altFt).filter(v => v != null))
  const peakVel = Math.max(...rel.map(r => r.velKt).filter(v => v != null))

  return (
    <div className="space-y-2">
      <div>
        <div className="text-fg3 text-[9px] uppercase tracking-wide mb-1">
          altitude (ft) · peak {peakAlt.toLocaleString()}
        </div>
        <div className="w-full h-32">
          <ResponsiveContainer>
            <LineChart data={rel} margin={{ top: 4, right: 8, left: -22, bottom: 2 }}>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="2 2" />
              <XAxis dataKey="tSec" tick={{ fill: '#6b6b6b', fontSize: 9 }} tickFormatter={v => `${v}s`} />
              <YAxis tick={{ fill: '#6b6b6b', fontSize: 9 }} />
              <RTTooltip
                contentStyle={{ background: '#1a1a1a', border: '1px solid #333', fontSize: 10, fontFamily: 'monospace' }}
                labelFormatter={(v) => `+${v}s`}
                formatter={(v) => [v?.toLocaleString() + ' ft', 'alt']}
              />
              <Line type="monotone" dataKey="altFt" stroke="#8abeb7" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div>
        <div className="text-fg3 text-[9px] uppercase tracking-wide mb-1">
          speed (kt) · peak {peakVel}
        </div>
        <div className="w-full h-24">
          <ResponsiveContainer>
            <LineChart data={rel} margin={{ top: 4, right: 8, left: -22, bottom: 2 }}>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="2 2" />
              <XAxis dataKey="tSec" tick={{ fill: '#6b6b6b', fontSize: 9 }} tickFormatter={v => `${v}s`} />
              <YAxis tick={{ fill: '#6b6b6b', fontSize: 9 }} />
              <RTTooltip
                contentStyle={{ background: '#1a1a1a', border: '1px solid #333', fontSize: 10, fontFamily: 'monospace' }}
                labelFormatter={(v) => `+${v}s`}
                formatter={(v) => [v + ' kt', 'spd']}
              />
              <Line type="monotone" dataKey="velKt" stroke="#b5bd68" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

// ── External jump-out links ─────────────────────────────────────────────────

function ExternalLinks({ icao, callsign, reg }) {
  const links = [
    { label: 'adsb exchange',  url: `https://globe.adsbexchange.com/?icao=${icao}` },
    { label: 'airplanes.live', url: `https://globe.airplanes.live/?icao=${icao}` },
    { label: 'FlightAware',    url: callsign ? `https://www.flightaware.com/live/flight/${callsign}` : null },
    { label: 'FlightRadar24',  url: callsign ? `https://www.flightradar24.com/${callsign}` : null },
    { label: 'Jetphotos',      url: reg ? `https://www.jetphotos.com/registration/${reg}` : null },
    { label: 'Planespotters',  url: reg ? `https://www.planespotters.net/search?q=${reg}` : null },
    { label: 'OpenSky',        url: `https://opensky-network.org/aircraft-profile?icao24=${icao}` },
  ].filter(l => l.url)
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map(l => (
        <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer"
          className="px-2 py-1 text-[10px] border border-border bg-bg2/40 hover:border-acc hover:text-acc rounded transition-colors">
          {l.label} ↗
        </a>
      ))}
    </div>
  )
}

// ── Main dossier page ───────────────────────────────────────────────────────

export default function FlightDossier({ icao, callsign: initialCallsign, onClose, flights }) {
  const [sections, setSections] = useState({})
  const [loading, setLoading] = useState(true)
  const [metars, setMetars] = useState(null)

  // v5.4.0 — drill-in state. One active drill-in per tile at a time.
  // drillIn = { scope: 'identity-operator' | 'identity-type' | 'hist-callsign' | 'anomaly-<id>', data, error, loading }
  const [drillIn, setDrillIn] = useState(null)
  const [nearby, setNearby] = useState(null)
  const [expandedAnomalyId, setExpandedAnomalyId] = useState(null)
  // v5.6.2 — satellite image lazy-load. The GOES GEOCOLOR JPG is ~5.9 MB.
  // Don't fetch it on every dossier open — show a placeholder, let the user
  // opt in with a click. Resets when navigating to a new aircraft.
  const [satLoaded, setSatLoaded] = useState(false)
  useEffect(() => { setSatLoaded(false) }, [icao])

  const openDrillIn = async (scope, loader) => {
    if (drillIn?.scope === scope) { setDrillIn(null); return }
    setDrillIn({ scope, loading: true })
    try {
      const data = await loader()
      setDrillIn({ scope, loading: false, data })
    } catch (err) {
      setDrillIn({ scope, loading: false, error: err.response?.data?.error || err.message })
    }
  }
  const closeDrillIn = () => setDrillIn(null)

  // Escape closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Kick off the parallel dossier fetch.
  useEffect(() => {
    if (!icao) return
    let cancelled = false
    setLoading(true)
    setSections({})
    const accum = {}
    fetchDossier(icao, {
      callsign: initialCallsign,
      onSection: (key, result) => {
        if (cancelled) return
        accum[key] = result
        setSections({ ...accum })
      },
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [icao, initialCallsign])

  const liveFlight = sections.live?.data?.flight
  const isLive = !!sections.live?.data?.live
  const track = sections.track?.data || []
  const history = sections.history?.data
  const anomalies = sections.anomalies?.data || []
  const apl = sections.apl?.data?.ac?.[0] || sections.apl?.data
  const adsbfi = sections.adsbfi?.data?.aircraft?.[0]
  const route = sections.route?.data
  const context = sections.context?.data
  const sigmets = sections.sigmets?.data || []
  const tfms = liveFlight?.tfms

  // v5.4.0 — Pull nearby flights once we have the aircraft's position.
  useEffect(() => {
    if (!liveFlight?.lat || !liveFlight?.lon) { setNearby(null); return }
    let cancelled = false
    fetchNearby({ lat: liveFlight.lat, lon: liveFlight.lon, radiusNm: 25, excludeIcao: icao })
      .then(d => { if (!cancelled) setNearby(d) })
      .catch(() => { if (!cancelled) setNearby(null) })
    return () => { cancelled = true }
  }, [liveFlight?.lat, liveFlight?.lon, icao])

  // Pull dep/arr METARs once we know the airports.
  useEffect(() => {
    const ids = []
    if (tfms?.dep_arpt) ids.push(tfms.dep_arpt.replace(/^K/, ''))
    if (tfms?.arr_arpt) ids.push(tfms.arr_arpt.replace(/^K/, ''))
    if (route?.origin?.icao_code)      ids.push(route.origin.icao_code.replace(/^K/, ''))
    if (route?.destination?.icao_code) ids.push(route.destination.icao_code.replace(/^K/, ''))
    const uniq = [...new Set(ids)]
    if (uniq.length === 0) { setMetars(null); return }
    let cancelled = false
    fetchMetar(uniq.join(','))
      .then(data => { if (!cancelled) setMetars(data) })
      .catch(() => { if (!cancelled) setMetars(null) })
    return () => { cancelled = true }
  }, [tfms?.dep_arpt, tfms?.arr_arpt, route?.origin?.icao_code, route?.destination?.icao_code])

  if (!icao) return null

  const altFt = liveFlight?.alt != null ? Math.round(liveFlight.alt * 3.281) : null
  const velKt = liveFlight?.vel != null ? Math.round(liveFlight.vel * 1.944) : null
  const vrFpm = liveFlight?.vertRate != null ? Math.round(liveFlight.vertRate * 196.85) : null
  const reg   = liveFlight?.acReg || apl?.r
  const type  = liveFlight?.acType || apl?.t
  const oper  = liveFlight?.acOperator
  const cs    = liveFlight?.callsign || initialCallsign

  // Sections passed to the ContextPanel need a flight-shaped object.
  const flightForContext = liveFlight ? {
    icao: liveFlight.icao, callsign: cs,
    lat: liveFlight.lat, lon: liveFlight.lon,
    alt: liveFlight.alt, vel: liveFlight.vel, hdg: liveFlight.hdg,
    squawk: liveFlight.squawk,
  } : null

  return (
    <div className="fixed inset-0 z-[1000] bg-bg1 overflow-y-auto">
      {/* Header (sticky) */}
      <div className="sticky top-0 z-10 bg-bg2/95 backdrop-blur-sm border-b border-border px-3 py-1.5 flex items-center gap-2 flex-wrap">
        <button onClick={onClose} className="text-fg3 hover:text-fg text-[11px] cursor-pointer pr-1" title="close (esc)">‹ back</button>
        <span className="text-ylw text-[13px] font-mono">{cs || '—'}</span>
        <span className="text-fg3 text-[10px] font-mono">{icao}</span>
        {reg && <Chip tone="cyn">{reg}</Chip>}
        {type && <Chip tone="acc">{type}</Chip>}
        {isLive ? <Chip tone="grn">live</Chip> : <Chip tone="fg3">offline</Chip>}
        {liveFlight?.mil && <Chip tone="red">MIL</Chip>}
        {liveFlight?.squawk && <Chip tone={liveFlight.squawk === '7500' || liveFlight.squawk === '7600' || liveFlight.squawk === '7700' ? 'red' : 'fg3'} title="squawk">{squawkLabel(liveFlight.squawk)}</Chip>}
        <span className="flex-1" />
        {loading && <span className="text-fg3 text-[10px]">loading…</span>}
      </div>

      {/* Main grid */}
      <div className="p-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 auto-rows-min">

        {/* IDENTITY */}
        <Tile title="Identity" accent="text-acc">
          <Row label="icao24" value={icao} color="text-fg2" />
          <Row label="callsign" value={cs} color="text-ylw" />
          <Row
            label="type" value={type}
            onClick={type ? () => openDrillIn('identity-type', () => fetchByType(type)) : null}
            active={drillIn?.scope === 'identity-type'}
          />
          <Row label="registration" value={reg} color="text-cyn" />
          <Row
            label="operator" value={oper} mono={false}
            onClick={oper ? () => openDrillIn('identity-operator', () => fetchByOperator(oper)) : null}
            active={drillIn?.scope === 'identity-operator'}
          />
          <Row label="country" value={liveFlight?.country} mono={false} />
          <Row label="mil" value={liveFlight?.mil ? 'yes' : 'no'} color={liveFlight?.mil ? 'text-red' : 'text-fg3'} />
          <Row label="src" value={liveFlight?.src} />

          {drillIn?.scope === 'identity-operator' && (
            <DrillIn title={`other ${oper} flights airborne`} loading={drillIn.loading} error={drillIn.error} onClose={closeDrillIn}>
              {drillIn.data?.count === 0 && <div className="text-fg3/50 text-[10px]">none other</div>}
              {(drillIn.data?.flights || []).slice(0, 8).map(f => <SiblingRow key={f.icao} f={f} />)}
            </DrillIn>
          )}
          {drillIn?.scope === 'identity-type' && (
            <DrillIn title={`other ${type} airborne`} loading={drillIn.loading} error={drillIn.error} onClose={closeDrillIn}>
              {drillIn.data?.count === 0 && <div className="text-fg3/50 text-[10px]">none other</div>}
              {(drillIn.data?.flights || []).slice(0, 8).map(f => <SiblingRow key={f.icao} f={f} />)}
              {drillIn.data?.count > 8 && (
                <div className="text-fg3/60 text-[9px] mt-0.5">… and {drillIn.data.count - 8} more</div>
              )}
            </DrillIn>
          )}
        </Tile>

        {/* LIVE VECTOR */}
        <Tile title="Live Vector" accent="text-cyn">
          <Row label="altitude" value={altFt != null ? altFt.toLocaleString() + ' ft' : null} color="text-cyn" />
          <Row label="ground spd" value={velKt != null ? velKt + ' kt' : null} />
          <Row label="vert rate" value={vrFpm != null ? (vrFpm > 0 ? '+' : '') + vrFpm + ' fpm' : null} color={vrFpm > 250 ? 'text-grn' : vrFpm < -250 ? 'text-cyn' : 'text-fg2'} />
          <Row label="heading" value={liveFlight?.hdg != null ? liveFlight.hdg + '°' : null} />
          <Row label="squawk" value={liveFlight?.squawk ? squawkLabel(liveFlight.squawk) : null} color={squawkColor(liveFlight?.squawk)} />
          <Row label="lat/lon" value={liveFlight?.lat != null ? liveFlight.lat.toFixed(3) + ', ' + liveFlight.lon.toFixed(3) : null} />
          <Row label="phase" value={liveFlight?.grounded ? 'ground' : 'airborne'} color={liveFlight?.grounded ? 'text-ylw' : 'text-grn'} />
          {apl?.ias != null && <Row label="ias" value={apl.ias + ' kt'} color="text-cyn" />}
          {apl?.tas != null && <Row label="tas" value={apl.tas + ' kt'} color="text-cyn" />}
          {apl?.mach != null && <Row label="mach" value={'M' + apl.mach} color="text-acc" />}
          {apl?.roll != null && <Row label="roll" value={(apl.roll > 0 ? '+' : '') + apl.roll + '°'} color={Math.abs(apl.roll) > 25 ? 'text-ylw' : 'text-fg2'} />}
          {apl?.oat != null && <Row label="oat" value={apl.oat + '°C'} />}
        </Tile>

        {/* FILED ROUTE */}
        <Tile title="Route / Flight Plan" accent="text-grn">
          {tfms?.dep_arpt ? (
            <>
              <Row label="from" value={tfms.dep_arpt} color="text-acc" />
              <Row label="to" value={tfms.arr_arpt} color="text-acc" />
              <Row label="etd" value={fmtTime(tfms.etd)} />
              <Row label="eta" value={fmtTime(tfms.eta)} />
              {tfms.aircraft_type && <Row label="type" value={tfms.aircraft_type} />}
              {liveFlight?.routeDeviation > 0 && (
                <Row label="deviation" value={liveFlight.routeDeviation + ' km'} color={liveFlight.routeDeviation > 100 ? 'text-red' : liveFlight.routeDeviation > 50 ? 'text-ylw' : 'text-fg3'} />
              )}
            </>
          ) : route ? (
            <>
              <Row label="airline" value={route.airline?.name} mono={false} />
              <Row label="from" value={route.origin?.icao_code || route.origin?.iata_code} color="text-acc" />
              <Row label="to" value={route.destination?.icao_code || route.destination?.iata_code} color="text-acc" />
              {route.origin?.municipality && <Row label="origin" value={route.origin.municipality} mono={false} />}
              {route.destination?.municipality && <Row label="dest" value={route.destination.municipality} mono={false} />}
            </>
          ) : (
            <div className="text-fg3/40 text-[10px] text-center py-3">no filed route data</div>
          )}
        </Tile>

        {/* HISTORICAL */}
        <Tile title="Historical" accent="text-mag">
          <Row label="first seen" value={history?.firstSeen ? fmtDate(history.firstSeen) + ' ' + fmtTime(history.firstSeen) : null} />
          <Row label="last seen"  value={history?.lastSeen  ? fmtDate(history.lastSeen)  + ' ' + fmtTime(history.lastSeen)  : null} />
          <Row label="days seen"  value={history?.days} />
          <Row label="total sightings" value={history?.count?.toLocaleString()} />
          {history?.callsigns?.length > 0 && (
            <div className="mt-1.5 pt-1 border-t border-border">
              <div className="text-fg3 text-[9px] uppercase mb-0.5">callsigns observed</div>
              <div className="flex flex-wrap gap-1">
                {history.callsigns.slice(0, 6).map(c => {
                  const scope = `hist-cs-${c.value}`
                  return (
                    <button
                      key={c.value}
                      onClick={() => openDrillIn(scope, () => fetchCallsignHistory(c.value))}
                      className={clsx(
                        'text-[10px] font-mono border-b border-dotted border-fg3/40 hover:text-acc cursor-pointer px-0.5',
                        drillIn?.scope === scope && 'text-acc'
                      )}
                    >
                      {c.value}<span className="text-fg3"> ·{c.count}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {drillIn?.scope?.startsWith('hist-cs-') && (
            <DrillIn title={`callsign history · ${drillIn.scope.slice(8)}`} loading={drillIn.loading} error={drillIn.error} onClose={closeDrillIn}>
              <div className="text-[10px] text-fg2 mb-1">
                {drillIn.data?.totalRows} sightings across {drillIn.data?.uniqueIcaos} aircraft
              </div>
              {(drillIn.data?.icaos || []).slice(0, 6).map(hex => {
                const thisCs = drillIn.scope.slice(8)
                return (
                  <a key={hex} href={`#flight=${hex}&cs=${encodeURIComponent(thisCs)}`}
                     className="flex gap-2 text-[10px] py-0.5 text-fg2 hover:text-acc cursor-pointer">
                    <span className="font-mono">{hex}</span>
                    {hex === icao && <span className="text-acc">← this aircraft</span>}
                  </a>
                )
              })}
            </DrillIn>
          )}
        </Tile>

        {/* ANOMALY HISTORY */}
        <Tile title="Anomaly History" accent="text-red">
          {anomalies.length === 0 ? (
            <div className="text-fg3/40 text-[10px] text-center py-3">no anomalies on record</div>
          ) : (
            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {anomalies.map((a, i) => {
                const key = a.id || i
                const expanded = expandedAnomalyId === key
                return (
                  <div key={key} className="border-b border-white/3">
                    <button
                      onClick={() => setExpandedAnomalyId(expanded ? null : key)}
                      className={clsx(
                        'flex justify-between items-baseline gap-2 text-[10px] py-0.5 w-full cursor-pointer text-left',
                        expanded && 'text-acc'
                      )}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <Chip tone={a.severity === 'CRITICAL' ? 'red' : a.severity === 'HIGH' ? 'ylw' : 'fg3'}>{a.severity}</Chip>
                        <span className="text-fg2">{a.category}</span>
                        {a.score != null && <span className="text-fg3 tabular-nums">score {a.score}</span>}
                      </span>
                      <span className="text-fg3 tabular-nums shrink-0">{fmtDate(a.detected_at)} {fmtTime(a.detected_at)}</span>
                    </button>
                    {expanded && (
                      <div className="pl-1.5 pr-1 py-1 bg-bg2/30 text-[10px] space-y-0.5 border-l-2 border-acc/40">
                        {a.confirmed != null && <Row label="confirmed" value={a.confirmed ? 'yes' : 'no'} color={a.confirmed ? 'text-grn' : 'text-fg3'} />}
                        {a.resolved_at && <Row label="resolved" value={fmtDate(a.resolved_at) + ' ' + fmtTime(a.resolved_at)} color="text-grn" />}
                        {a.callsign && <Row label="callsign" value={a.callsign} color="text-ylw" />}
                        {a.squawk && <Row label="squawk" value={a.squawk} color={squawkColor(a.squawk)} />}
                        {a.lat != null && <Row label="lat/lon" value={`${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}`} />}
                        {a.alt != null && <Row label="altitude" value={Math.round(a.alt * 3.281).toLocaleString() + ' ft'} color="text-cyn" />}
                        {a.vel != null && <Row label="speed" value={Math.round(a.vel * 1.944) + ' kt'} />}
                        {a.hdg != null && <Row label="heading" value={a.hdg + '°'} />}
                        {a.reasons && (
                          <div className="pt-0.5 border-t border-white/5">
                            <div className="text-fg3 text-[9px] uppercase mb-0.5">reasons</div>
                            <ul className="list-disc pl-3 text-fg2 text-[10px] marker:text-fg3/50">
                              {(typeof a.reasons === 'string' ? a.reasons.split(/[;\n]/) : a.reasons).filter(Boolean).map((r, j) => <li key={j}>{String(r).trim()}</li>)}
                            </ul>
                          </div>
                        )}
                        {a.weather_context && (
                          <div className="pt-0.5 border-t border-white/5">
                            <div className="text-fg3 text-[9px] uppercase mb-0.5">weather at detection</div>
                            <div className="text-fg2 text-[10px] font-mono whitespace-pre-wrap break-all">
                              {typeof a.weather_context === 'string' ? a.weather_context.slice(0, 240) : JSON.stringify(a.weather_context).slice(0, 240)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Tile>

        {/* WEATHER ON ROUTE */}
        <Tile title="Weather on Route" accent="text-ylw">
          {metars?.length ? (
            <div className="space-y-1.5">
              {metars.map(m => (
                <div key={m.icaoId} className="border-l-2 border-ylw/30 pl-1.5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-ylw font-mono text-[11px]">{m.icaoId}</span>
                    <span className={clsx('text-[9px] uppercase', m.fltCat === 'VFR' ? 'text-grn' : m.fltCat === 'MVFR' ? 'text-acc' : m.fltCat === 'IFR' ? 'text-ylw' : 'text-red')}>
                      {m.fltCat}
                    </span>
                    {m.wspd != null && <span className="text-fg3 text-[9px] tabular-nums">wind {m.wspd}kt{m.wgst ? ` G${m.wgst}` : ''}</span>}
                    {m.visib != null && <span className="text-fg3 text-[9px] tabular-nums">vis {m.visib}SM</span>}
                  </div>
                  <div className="text-fg3 text-[9px] font-mono truncate" title={m.rawOb}>{m.rawOb}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-fg3/40 text-[10px] text-center py-3">
              {tfms?.dep_arpt || route?.origin ? 'fetching METARs…' : 'no dep/arr airports known'}
            </div>
          )}
          {sigmets?.length > 0 && (
            <div className="mt-2 pt-1.5 border-t border-border">
              <div className="text-fg3 text-[9px] uppercase mb-0.5">active SIGMETs</div>
              {sigmets.slice(0, 4).map((s, i) => (
                <div key={i} className="text-[10px] text-fg2 flex gap-1.5">
                  <Chip tone={s.hazard === 'CONVECTIVE' ? 'red' : s.hazard === 'TURB' ? 'ylw' : 'cyn'}>{s.hazard}</Chip>
                  <span className="truncate">{s.airSigmetType}</span>
                </div>
              ))}
            </div>
          )}
          {/* v5.5.0 — FAA WeatherCams jump-outs for dep/arr airports. */}
          {metars?.length > 0 && (
            <div className="mt-2 pt-1.5 border-t border-border">
              <div className="text-fg3 text-[9px] uppercase mb-0.5">live airport cams</div>
              <div className="flex flex-wrap gap-1">
                {metars.map(m => (
                  <a key={m.icaoId}
                    href={`https://weathercams.faa.gov/map/-1/site/${m.icaoId}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-[10px] border border-border hover:border-cyn text-fg3 hover:text-cyn px-1.5 py-[1px] rounded"
                    title={`FAA WeatherCams at ${m.icaoId}`}
                  >
                    {m.icaoId} cam ↗
                  </a>
                ))}
              </div>
            </div>
          )}
        </Tile>

        {/* v5.5.0 → v5.6.1 — GOES-16/18 SATELLITE IMAGE. Compact now
             (max-h-56 instead of max-h-96) with an aircraft marker
             overlaid at the computed (lat,lon) → sector pixel position.
             The right visual for aviation (cloud tops from geostationary
             orbit) but no longer a billboard. */}
        {liveFlight?.lat != null && (() => {
          const sector = pickSector(liveFlight.lat, liveFlight.lon)
          const imgUrl = goesImageUrl(sector)
          const loopUrl = goesLoopUrl(sector)
          const pos = latLonToSectorPct(sector, liveFlight.lat, liveFlight.lon)
          return (
            <Tile title={`Satellite · ${sector.sat}/${sector.sector} · ${sector.name}`} accent="text-cyn" className="md:col-span-2 xl:col-span-3">
              <div className="flex gap-2 items-start">
                <div
                  className="relative block shrink-0"
                  style={{ height: '14rem', aspectRatio: '4 / 3' }}
                >
                  {/* v5.6.2 — lazy-load gate. Placeholder by default; user
                      clicks to load the ~5.9 MB image. Keeps dossier open
                      fast and bandwidth-free for flights where you don't
                      care about the satellite context. */}
                  {!satLoaded ? (
                    <button
                      onClick={() => setSatLoaded(true)}
                      className="w-full h-full rounded border border-dashed border-border2 hover:border-cyn bg-bg2/40 hover:bg-bg2 cursor-pointer flex flex-col items-center justify-center gap-1 text-[10px] transition-colors group"
                      title="click to fetch GOES GEOCOLOR image (~6 MB)"
                    >
                      <span className="text-cyn text-[11px]">◎ load satellite</span>
                      <span className="text-fg3">{sector.sat}/{sector.sector} · {sector.name}</span>
                      <span className="text-fg3/50 text-[9px]">~6 MB · NOAA STAR CDN</span>
                      {pos && (
                        <span className="text-fg3/60 text-[9px] mt-1">
                          aircraft position on frame: {pos.xPct.toFixed(0)}% · {pos.yPct.toFixed(0)}%
                        </span>
                      )}
                    </button>
                  ) : (
                    <a
                      href={loopUrl}
                      target="_blank" rel="noopener noreferrer"
                      className="relative block w-full h-full group"
                      title="open 24-frame NESDIS animation"
                    >
                      <img
                        src={imgUrl}
                        alt={`GOES ${sector.name} GEOCOLOR`}
                        className="w-full h-full object-cover rounded border border-border bg-bg2"
                        loading="eager"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                      {pos && (
                        <span
                          className="absolute pointer-events-none"
                          style={{ left: `${pos.xPct}%`, top: `${pos.yPct}%`, transform: 'translate(-50%, -50%)' }}
                        >
                          <span className="block relative">
                            <span className="absolute inset-0 rounded-full bg-ylw/50 animate-ping" style={{ width: 14, height: 14, margin: -2 }} />
                            <span className="block rounded-full border-2 border-ylw shadow-lg" style={{ width: 10, height: 10, background: '#f0c674' }} />
                          </span>
                        </span>
                      )}
                      <span className="absolute bottom-0.5 right-1 text-[8px] text-fg3/70 bg-bg1/60 px-1 rounded">
                        GEOCOLOR loop ↗
                      </span>
                    </a>
                  )}
                </div>
                <div className="flex-1 min-w-0 text-[10px] space-y-0.5">
                  <div className="text-fg3 text-[9px] uppercase">aircraft</div>
                  <div className="text-ylw font-mono tabular-nums">{liveFlight.lat.toFixed(2)}, {liveFlight.lon.toFixed(2)}</div>
                  {pos ? (
                    <div className={clsx('text-[9px]', satLoaded ? 'text-grn' : 'text-fg3/70')}>
                      {satLoaded ? 'marked on frame' : 'will mark on load'}
                    </div>
                  ) : (
                    <div className="text-red/80 text-[9px]">outside sector bounds</div>
                  )}
                  <div className="text-fg3 text-[9px] uppercase pt-1">sector</div>
                  <div className="text-fg2 font-mono">{sector.sat}/{sector.sector}</div>
                  <div className="text-fg3/60 text-[9px]">{sector.name}</div>
                  <a href={loopUrl} target="_blank" rel="noopener noreferrer"
                     className="mt-1 inline-block text-acc hover:text-ylw text-[10px] border border-acc/50 hover:border-ylw px-1.5 py-[1px] rounded">
                    open full ↗
                  </a>
                </div>
              </div>
            </Tile>
          )
        })()}

        {/* v5.4.0 — PLANES NEARBY (radius 25nm around aircraft position) */}
        <Tile title={`Planes Nearby · ${nearby?.count ?? '—'} within 25nm`} accent="text-cyn">
          {!nearby ? (
            <div className="text-fg3/40 text-[10px] text-center py-3">
              {liveFlight?.lat == null ? 'no position' : 'loading nearby traffic…'}
            </div>
          ) : nearby.count === 0 ? (
            <div className="text-fg3/40 text-[10px] text-center py-3">no other aircraft in range</div>
          ) : (
            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {(nearby.flights || []).slice(0, 15).map(f => <SiblingRow key={f.icao} f={f} />)}
              {nearby.count > 15 && (
                <div className="text-fg3/60 text-[9px] mt-0.5">… and {nearby.count - 15} more</div>
              )}
            </div>
          )}
        </Tile>

        {/* EXTERNAL LINKS */}
        <Tile title="External" accent="text-fg2">
          <ExternalLinks icao={icao} callsign={cs} reg={reg} />
        </Tile>

        {/* FULL-WIDTH: TRACK MAP */}
        <div className="md:col-span-2 xl:col-span-3">
          <Tile title={`Track · ${track.length} samples`} accent="text-cyn">
            <div className="h-64 relative">
              {liveFlight ? (
                <FlightMap
                  snapshots={track}
                  flight={flightForContext}
                  flights={flights}
                  fullscreen={false}
                  onToggleFullscreen={() => {}}
                  fill
                />
              ) : (
                <div className="text-fg3/40 text-[10px] text-center py-12">no position data</div>
              )}
            </div>
          </Tile>
        </div>

        {/* FULL-WIDTH: PROFILE CHARTS */}
        <div className="md:col-span-2 xl:col-span-3">
          <Tile title="Altitude + Speed Profile" accent="text-mag">
            <TrackProfile track={track} />
          </Tile>
        </div>

        {/* FULL-WIDTH: CORRELATION */}
        <div className="md:col-span-2 xl:col-span-3">
          {flightForContext && <ContextPanel flight={flightForContext} />}
        </div>

      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 bg-bg2 border-t border-border text-[9px] text-fg3/60 flex justify-between sticky bottom-0">
        <span>esc to close · URL: #flight={icao}</span>
        <span>
          {Object.values(sections).filter(s => s?.error).length > 0 && (
            <span className="text-red/70">
              {Object.values(sections).filter(s => s?.error).length} source(s) errored
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
