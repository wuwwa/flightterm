import { useState, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { fetchFlight } from '../services/aeroapi'
import { squawkLabel, squawkColor } from '../utils/squawk'
import TrackChart from './TrackChart'
import FlightMap from './FlightMap'
import ContextPanel from './ContextPanel'
import { fetchAircraftInfo } from '../services/adsbdb'
import { pickSector, goesImageUrl, goesLoopUrl, latLonToSectorPct } from '../utils/goes'
import { formatLocalTime } from '../utils/time'

// ── FlightInspectorPanel (file kept as ...Modal.jsx for import stability) ───
// Inline panel mounted next to the FlightTable in the main page grid. No
// overlay, no backdrop, no rounded card. The container in App.jsx supplies
// the size; this component just fills it. Layout stacks vertically because
// the panel is narrower than the old modal — map on top, sparklines, then
// the data tile grid (1 col on narrow, 2 col when wide enough).

function fmtTime(s) {
  if (!s) return '—'
  try { return formatLocalTime(s) } catch { return s }
}

function fmtSampleTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? formatLocalTime(date, { seconds: true }) : '—'
}

// Compact row inside a tile
function Row({ label, value, color = 'text-fg2', mono = true }) {
  const semanticColor = ['text-red', 'text-ylw', 'text-grn'].includes(color) ? color : 'text-fg2'
  return (
    <div className="inspector-record-row">
      <span>{label}</span>
      <strong className={clsx(mono && 'tabular-nums', semanticColor)}>
        {value ?? <span className="text-fg3/30">—</span>}
      </strong>
    </div>
  )
}

function Tile({ title, children, className }) {
  return (
    <section className={clsx('inspector-record-section', className)}>
      <h3>{title}</h3>
      <div>
        {children}
      </div>
    </section>
  )
}

const REGION_LABELS = {
  usa: 'US',
  global: 'Global',
  europe: 'Europe',
  asia: 'Asia',
  atlantic: 'Atlantic',
}

function sourceLabel(flights = []) {
  const sources = [...new Set(flights.map(flight => flight.src).filter(Boolean))]
  if (sources.length !== 1) return sources.length > 1 ? 'Mixed' : '—'
  return {
    opensky: 'OpenSky',
    apl: 'Airplanes.live',
    'airplanes.live': 'Airplanes.live',
    adsbx: 'ADSBexchange',
    'adsb.fi': 'ADS-B.fi',
  }[sources[0]] || sources[0]
}

function EmptyFlightInspector({ flights, region, lastUpdatedAt }) {
  return (
    <div className="h-full flex flex-col bg-bg1 min-h-0">
      <header className="flight-inspector__header">
        <h2>Flight index</h2>
      </header>

      <dl className="flight-inspector__vector" aria-label="Flight index context">
        <div><dt>Scope</dt><dd>{REGION_LABELS[region] || 'US'}</dd></div>
        <div><dt>Source</dt><dd>{sourceLabel(flights)}</dd></div>
        <div><dt>Sample</dt><dd>{fmtSampleTime(lastUpdatedAt)}</dd></div>
      </dl>

      <div className="flight-inspector__empty">
        <p>No flight selected</p>
      </div>
    </div>
  )
}

export default function FlightInspectorModal({
  flight,
  flights,
  enrichData,
  aeroCache,
  aeroSpend,
  userAeroKey,
  trackHistory,
  onClose,
  onAeroFetched,
  backendOk,
  lastUpdatedAt,
  region,
  showMilitary = false,
}) {
  const [aeroLoading, setAeroLoading] = useState(false)
  const [aeroError, setAeroError] = useState(null)
  const [lazyAircraft, setLazyAircraft] = useState(null)
  const [lazyLoading, setLazyLoading] = useState(false)
  const aircraftRequestRef = useRef(0)
  const aeroRequestRef = useRef(0)
  // v5.6.2 — satellite lazy-load (same pattern as the aircraft detail page).
  const [satLoaded, setSatLoaded] = useState(false)
  useEffect(() => { setSatLoaded(false) }, [flight?.icao])

  const { aircraft: enrichAircraft, flightroute, adsbfi, apl } = enrichData || {}
  // v5.3.1 — aircraft metadata is no longer pre-fetched on row select.
  // `enrichAircraft` will always be null via enrichFlight; fall back to
  // the on-demand `lazyAircraft` which populates on button click.
  const aircraft = enrichAircraft || lazyAircraft

  // Reset lazy-loaded aircraft info when the selected flight changes.
  useEffect(() => {
    aircraftRequestRef.current += 1
    aeroRequestRef.current += 1
    setLazyAircraft(null)
    setLazyLoading(false)
    setAeroLoading(false)
    setAeroError(null)
  }, [flight?.icao])

  const loadAircraftInfo = async () => {
    if (!flight?.icao || lazyLoading) return
    const requestId = ++aircraftRequestRef.current
    setLazyLoading(true)
    try {
      const ac = await fetchAircraftInfo(flight.icao)
      if (aircraftRequestRef.current === requestId) setLazyAircraft(ac)
    } catch { /* silent — 404 is common */ }
    finally { if (aircraftRequestRef.current === requestId) setLazyLoading(false) }
  }
  const aeroData = flight ? aeroCache[flight.icao] : null

  if (!flight) return <EmptyFlightInspector flights={flights} region={region} lastUpdatedAt={lastUpdatedAt} />

  // Source tag
  const srcTag = ['apl', 'airplanes.live', 'adsb.fi'].includes(flight.src)
    ? { label: flight.src === 'adsb.fi' ? 'adsb.fi' : 'community ADS-B', color: 'text-fg3' }
    : flight.src === 'adsbx'
    ? { label: 'adsbx', color: 'text-fg3' }
    : { label: 'opensky', color: 'text-fg3' }

  // Try aeroapi
  const handleAeroQuery = async () => {
    if (!flight || aeroLoading || !flight.callsign || flight.callsign === '—') return
    if (aeroSpend?.cap_reached) return
    const icao = flight.icao
    const callsign = flight.callsign
    const requestId = ++aeroRequestRef.current
    setAeroLoading(true)
    setAeroError(null)
    try {
      const data = await fetchFlight(callsign, userAeroKey)
      if (aeroRequestRef.current === requestId) onAeroFetched(icao, data)
    } catch (err) {
      if (aeroRequestRef.current === requestId) setAeroError(err.response?.data?.error || err.message)
    } finally {
      if (aeroRequestRef.current === requestId) setAeroLoading(false)
    }
  }

  // Build header route summary
  const tfms = flight.tfms
  const headerRoute = tfms?.dep_arpt && tfms?.arr_arpt
    ? `${tfms.dep_arpt.replace(/^K/, '')} → ${tfms.arr_arpt.replace(/^K/, '')}`
    : flightroute?.origin && flightroute?.destination
    ? `${flightroute.origin.icao_code?.replace(/^K/, '') || '?'} → ${flightroute.destination.icao_code?.replace(/^K/, '') || '?'}`
    : null

  // Vertical rate from any source
  const vr = flight.vertRate != null ? Math.round(flight.vertRate * 196.85) : (adsbfi?.baroRate ?? null)

  return (
    <div className="h-full flex flex-col bg-bg1 min-h-0">
      {/* ── Header strip ─────────────────────────────────────────────── */}
      <header className="flight-inspector__header">
        <button
          onClick={onClose}
          className="flight-inspector__close"
          title="close inspector (esc)"
          aria-label="Close flight details"
        >
          <span className="lg:hidden text-[16px] leading-none">‹ back</span>
          <span className="hidden lg:inline text-[11px]">✕</span>
        </button>
        <span className="lg:hidden text-border2">|</span>
        <h2>{flight.callsign || flight.icao}</h2>
        {showMilitary && flight.mil && <span className="text-red text-[9px] uppercase">MIL</span>}
        {headerRoute && (
          <span className="text-fg2 text-[11px] tabular-nums">{headerRoute}</span>
        )}
        {tfms?.eta && (
          <span className="text-fg3 text-[10px] tabular-nums hidden sm:inline">eta {fmtTime(tfms.eta)}</span>
        )}
        <span className="text-fg3/40 text-[9px] tracking-wide hidden sm:inline">{flight.icao}</span>
        <span className="flex-1" />
        <span className={clsx('text-[9px]', srcTag.color)}>{srcTag.label}</span>
      </header>

      <dl className="flight-inspector__vector" aria-label="Current flight vector">
        <div><dt>Altitude</dt><dd>{flight.alt != null ? `${Math.round(flight.alt * 3.281).toLocaleString()} ft` : '—'}</dd></div>
        <div><dt>Speed</dt><dd>{flight.vel != null ? `${Math.round(flight.vel * 1.944)} kt` : '—'}</dd></div>
        <div><dt>Vertical rate</dt><dd className={Math.abs(vr || 0) > 2000 ? 'text-ylw' : ''}>{vr != null ? `${vr > 0 ? '+' : ''}${vr} fpm` : '—'}</dd></div>
        <div><dt>Heading</dt><dd>{flight.hdg != null ? `${flight.hdg}°` : '—'}</dd></div>
        <div><dt>Squawk</dt><dd className={squawkColor(flight.squawk)}>{squawkLabel(flight.squawk)}</dd></div>
        <div><dt>Status</dt><dd className={flight.grounded ? 'text-ylw' : 'text-grn'}>{flight.grounded ? 'Ground' : 'Airborne'}</dd></div>
      </dl>

      {/* ── Main: scrollable single column. Map → sparklines → tiles. ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Map — taller on mobile since it's full-screen */}
        <div className="relative h-48 lg:h-60">
          <FlightMap
            snapshots={trackHistory || []}
            flight={flight}
            flights={flights}
            fullscreen={false}
            fill
          />
        </div>

        {/* Track sparklines */}
        {trackHistory?.length > 1 && (
          <div className="border-t border-border">
            <TrackChart snapshots={trackHistory} />
          </div>
        )}

        {/* Data tiles — 1 column on narrow, 2 columns when there's room */}
        <div className="flight-inspector__records">
          <div className="flight-inspector__record-grid">

              {/* AIRCRAFT */}
              <Tile title="Aircraft" accent="text-acc">
                <Row label="type" value={aircraft?.type || flight.acType} />
                <Row label="icao" value={aircraft?.icao_type} color="text-fg3" />
                <Row label="mfr" value={aircraft?.manufacturer} color="text-acc" />
                <Row label="reg" value={aircraft?.registration || flight.acReg} color="text-ylw" />
                <Row label="owner" value={aircraft?.registered_owner} mono={false} />
                <Row label="ctry" value={aircraft?.registered_owner_country_name || flight.country} color="text-fg3" mono={false} />
              </Tile>

              {/* ROUTE */}
              <Tile title="Route" accent="text-grn">
                {tfms?.dep_arpt && tfms?.arr_arpt ? (
                  <>
                    <Row label="from" value={tfms.dep_arpt} color="text-acc" />
                    <Row label="to" value={tfms.arr_arpt} color="text-acc" />
                    <Row label="etd" value={fmtTime(tfms.etd)} color="text-fg3" />
                    <Row label="eta" value={fmtTime(tfms.eta)} color="text-fg3" />
                    {flight.routeDeviation > 0 && (
                      <Row label="deviation"
                        value={`${flight.routeDeviation}km${flight.routeDeviationMode === 'polyline' ? '*' : ''}`}
                        color={flight.routeDeviation > 100 ? 'text-red' : flight.routeDeviation > 50 ? 'text-ylw' : 'text-fg3'} />
                    )}
                    {tfms?.aircraft_type && <Row label="type" value={tfms.aircraft_type} color="text-fg3" />}
                  </>
                ) : flightroute ? (
                  <>
                    <Row label="airline" value={flightroute.airline?.name} mono={false} />
                    <Row label="from" value={flightroute.origin?.icao_code} color="text-acc" />
                    <Row label="to" value={flightroute.destination?.icao_code} color="text-acc" />
                    {flightroute.origin?.municipality && (
                      <Row label="origin" value={flightroute.origin.municipality} color="text-fg3" mono={false} />
                    )}
                    {flightroute.destination?.municipality && (
                      <Row label="dest" value={flightroute.destination.municipality} color="text-fg3" mono={false} />
                    )}
                  </>
                ) : (
                  <div className="text-[9px] text-fg3/40 text-center py-2">no route data</div>
                )}
              </Tile>

              <details className="inspector-disclosure">
                <summary>Data details</summary>
                <Tile title="Observation">
                  <Row label="vector" value={srcTag.label} mono={false} />
                  <Row label="sample" value={fmtSampleTime(lastUpdatedAt)} />
                  {tfms && <Row label="route" value="FAA TFMS" mono={false} />}
                </Tile>
              </details>

              {/* TELEMETRY (deep — combined adsb.fi + apl) */}
              <details className="inspector-disclosure">
                <summary>Additional telemetry</summary>
                <Tile title="Navigation and air data">
                {(adsbfi || apl) ? (
                  <>
                    {adsbfi?.emergency && <Row label="emerg" value={adsbfi.emergency} color="text-red" />}
                    <Row label="ias" value={apl?.ias != null ? `${apl.ias} kt` : null} color="text-cyn" />
                    <Row label="tas" value={apl?.tas != null ? `${apl.tas} kt` : null} color="text-cyn" />
                    <Row label="mach" value={apl?.mach != null ? `M${apl.mach}` : null} color="text-acc" />
                    <Row label="mcp alt" value={(adsbfi?.navAlt ?? apl?.navAltMcp) != null ? `${adsbfi?.navAlt ?? apl?.navAltMcp} ft` : null} color="text-cyn" />
                    <Row label="mcp hdg" value={(adsbfi?.navHdg ?? apl?.navHeading) != null ? `${adsbfi?.navHdg ?? apl?.navHeading}°` : null} color="text-fg3" />
                    <Row label="roll" value={apl?.roll != null ? `${apl.roll > 0 ? '+' : ''}${apl.roll}°` : null}
                      color={apl?.roll != null && Math.abs(apl.roll) > 25 ? 'text-ylw' : 'text-fg2'} />
                    {apl?.windDir != null && <Row label="wind" value={`${apl.windDir}° / ${apl.windSpeed ?? '—'} kt`} color="text-mag" />}
                    {apl?.oat != null && <Row label="oat" value={`${apl.oat}°C`} color="text-fg3" />}
                  </>
                ) : (
                  <div className="text-[9px] text-fg3/40 text-center py-2">enrichment pending</div>
                )}
                </Tile>
              </details>

              {/* v5.6.2 — SATELLITE tile (click-to-load; spans both columns).
                  GOES-16/18 GEOCOLOR of the aircraft's current sector with
                  a marker at its lat/lon. 5.9 MB fetch is gated behind a
                  click so it doesn't fire on every flight row-select. */}
              {flight?.lat != null && (() => {
                const sector = pickSector(flight.lat, flight.lon)
                const pos = latLonToSectorPct(sector, flight.lat, flight.lon)
                return (
                  <details className="inspector-disclosure">
                    <summary>Satellite context · {sector.name}</summary>
                    <Tile title={`${sector.sat}/${sector.sector} · ${sector.name}`}>
                    <div className="relative w-full" style={{ aspectRatio: '4 / 3', maxHeight: '10rem' }}>
                      {!satLoaded ? (
                        <button
                          onClick={() => setSatLoaded(true)}
                          className="w-full h-full rounded border border-dashed border-border2 hover:border-cyn bg-bg2/40 hover:bg-bg2 cursor-pointer flex flex-col items-center justify-center gap-0.5 text-[9px] transition-colors"
                          title="click to fetch GOES GEOCOLOR image (~6 MB)"
                        >
                          <span className="text-cyn text-[10px]">◎ load satellite</span>
                          <span className="text-fg3">GEOCOLOR · ~6 MB</span>
                          {pos && (
                            <span className="text-fg3/60 text-[8px] mt-0.5">
                              aircraft at {pos.xPct.toFixed(0)}% · {pos.yPct.toFixed(0)}% of frame
                            </span>
                          )}
                        </button>
                      ) : (
                        <a
                          href={goesLoopUrl(sector)}
                          target="_blank" rel="noopener noreferrer"
                          className="relative block w-full h-full"
                          title="open 24-frame NESDIS animation"
                        >
                          <img
                            src={goesImageUrl(sector)}
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
                                <span className="absolute inset-0 border border-ylw/60" style={{ width: 12, height: 12, margin: -2 }} />
                                <span className="block border-2 border-ylw" style={{ width: 8, height: 8, background: '#e2b45e' }} />
                              </span>
                            </span>
                          )}
                          <span className="absolute bottom-0.5 right-1 text-[8px] text-fg3/70 bg-bg1/60 px-1 rounded">
                            loop ↗
                          </span>
                        </a>
                      )}
                    </div>
                    </Tile>
                  </details>
                )
              })()}

              {/* AEROAPI section — spans both columns when data is loaded */}
              {/* Correlation Layer (v2.0.0) — external-source join */}
              <ContextPanel flight={flight} />
              <details className="inspector-disclosure">
                <summary>Flight lifecycle</summary>
                <div className="inspector-disclosure__body">

              {aeroData ? (
                <Tile title="FlightAware AeroAPI">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0">
                    <Row label="ident" value={aeroData.ident} color="text-ylw" />
                    <Row label="status" value={aeroData.status}
                      color={aeroData.status === 'En Route' ? 'text-grn' : aeroData.status?.includes('Delay') ? 'text-ylw' : 'text-fg2'} />
                    <Row label="from" value={aeroData.origin?.code_icao || aeroData.origin?.code} color="text-acc" />
                    <Row label="to" value={aeroData.destination?.code_icao || aeroData.destination?.code} color="text-acc" />
                    <Row label="sched out" value={fmtTime(aeroData.scheduled_out || aeroData.scheduled_off)} color="text-fg3" />
                    <Row label="actual out" value={fmtTime(aeroData.actual_out || aeroData.actual_off)} color={aeroData.actual_out || aeroData.actual_off ? 'text-grn' : 'text-fg3'} />
                    <Row label="est in" value={fmtTime(aeroData.estimated_in || aeroData.estimated_on)} color="text-fg3" />
                    <Row label="actual in" value={fmtTime(aeroData.actual_in || aeroData.actual_on)} color={aeroData.actual_in || aeroData.actual_on ? 'text-grn' : 'text-fg3'} />
                  </div>
                  {aeroData.progress_percent != null && (
                    <div className="mt-1.5 pt-1.5 border-t border-border">
                      <div className="flex justify-between text-[9px] mb-0.5">
                        <span className="text-fg3">progress</span>
                        <span className="text-acc tabular-nums">{aeroData.progress_percent}%</span>
                      </div>
                      <div className="h-1 bg-bg rounded-full overflow-hidden">
                        <div className="h-full bg-acc rounded-full transition-all duration-500" style={{ width: `${Math.min(100, aeroData.progress_percent)}%` }} />
                      </div>
                    </div>
                  )}
                </Tile>
              ) : (
                <div>
                  <button
                    className={clsx(
                      'w-full bg-bg2/40 border border-border hover:border-acc text-acc text-[11px] py-1.5 px-3 rounded cursor-pointer text-left font-mono flex justify-between items-center transition-colors',
                      (aeroLoading || flight.callsign === '—' || aeroSpend?.cap_reached) && 'opacity-40 cursor-default'
                    )}
                    onClick={handleAeroQuery}
                    disabled={aeroLoading || flight.callsign === '—' || aeroSpend?.cap_reached}
                  >
                    <span>{aeroLoading ? 'Loading FlightAware…' : aeroSpend?.cap_reached ? 'FlightAware limit reached' : 'Get FlightAware lifecycle'}</span>
                    <span className="text-ylw text-[10px]">~$0.005</span>
                  </button>
                  {aeroError && <div className="text-red text-[9px] mt-1 px-1">{aeroError}</div>}
                </div>
              )}
                </div>
              </details>
          </div>

          {/* v5.3.1 — Lazy aircraft photo. Only fetches adsbdb on explicit click. */}
          <details className="inspector-disclosure mt-2">
            <summary>Aircraft image</summary>
          {aircraft?.url_photo_thumbnail ? (
            <div className="mt-2">
              <img
                className="w-full block max-h-40 object-cover rounded border border-border filter-[saturate(0.5)_brightness(0.85)]"
                src={aircraft.url_photo_thumbnail}
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none' }}
              />
            </div>
          ) : (
            <div className="mt-2">
              <button
                onClick={loadAircraftInfo}
                disabled={lazyLoading || (lazyAircraft !== null && !lazyAircraft?.url_photo_thumbnail)}
                className={clsx(
                  'w-full bg-bg2/40 border border-border hover:border-acc text-fg3 hover:text-acc text-[10px] py-1 px-2 rounded cursor-pointer transition-colors',
                  (lazyLoading || (lazyAircraft !== null && !lazyAircraft?.url_photo_thumbnail)) && 'opacity-40 cursor-default'
                )}
              >
                {lazyLoading
                  ? 'Loading aircraft information…'
                  : lazyAircraft !== null
                    ? (lazyAircraft?.url_photo_thumbnail ? '' : 'No image available')
                    : 'Load aircraft image'}
              </button>
            </div>
          )}
          </details>
        </div>
      </div>

      {!backendOk && <div className="flight-inspector__offline">Backend offline</div>}
    </div>
  )
}
