import { useState } from 'react'
import clsx from 'clsx'
import { fetchFlight } from '../services/aeroapi'
import { squawkLabel, squawkColor } from '../utils/squawk'
import TrackChart from './TrackChart'
import FlightMap from './FlightMap'

function DRow({ label, value, colorClass = 'text-fg' }) {
  return (
    <div className="flex justify-between py-0.5 px-2.5 gap-2 border-b border-white/3">
      <span className="text-fg3 text-[11px] shrink-0">{label}</span>
      <span className={clsx('text-right text-[11px] break-all', colorClass)}>{value ?? '—'}</span>
    </div>
  )
}

function Section({ title, srcTag, right }) {
  return (
    <div className="py-1.5 px-2.5 text-[10px] text-fg3 bg-bg2 border-t border-b border-border mt-px tracking-wide shrink-0 flex justify-between items-center">
      <span>{title}</span>
      {srcTag && (
        <span className={clsx('text-[10px]', srcTag.colorClass)}>
          [{srcTag.label}]
        </span>
      )}
      {right}
    </div>
  )
}

function fmtTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toISOString().substring(11, 16) + ' utc'
  } catch {
    return s
  }
}

export default function DetailPanel({
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
  mobile,
}) {
  const [aeroLoading, setAeroLoading] = useState(false)
  const [aeroError, setAeroError] = useState(null)
  const [mapFullscreen, setMapFullscreen] = useState(false)

  if (!flight) {
    return (
      <div className="bg-bg1 border-l border-border flex flex-col min-h-0 overflow-y-auto">
        {!mobile && (
          <div className="bg-bg2 border-b border-border py-0.5 px-2.5 flex justify-between items-center text-[11px] text-fg3 sticky top-0 z-1 shrink-0">
            <span className="text-acc">aircraft intel</span>
          </div>
        )}
        <div className="py-10 px-5 text-center text-fg3 text-[11px]">select a row to inspect</div>
      </div>
    )
  }

  const { aircraft, flightroute, adsbfi } = enrichData || {}
  const aeroData = aeroCache[flight.icao]
  const srcTag =
    flight.src === 'adsbx'
      ? { label: 'adsbx', colorClass: 'text-acc' }
      : { label: 'opensky', colorClass: 'text-grn' }

  const handleAeroQuery = async () => {
    if (aeroLoading || !flight.callsign || flight.callsign === '—') return
    if (aeroSpend?.cap_reached) return
    setAeroLoading(true)
    setAeroError(null)
    try {
      const data = await fetchFlight(flight.callsign, userAeroKey)
      onAeroFetched(flight.icao, data)
    } catch (err) {
      setAeroError(err.response?.data?.error || err.message)
    } finally {
      setAeroLoading(false)
    }
  }

  return (
    <div className={clsx('bg-bg1 flex flex-col min-h-0', !mobile && 'border-l border-border overflow-y-auto')}>
      {/* sticky header — hidden in mobile sheet (sheet has its own) */}
      {!mobile && (
        <div className="bg-bg2 border-b border-border py-0.5 px-2.5 flex justify-between items-center text-[11px] text-fg3 sticky top-0 z-1 shrink-0">
          <span className="text-acc">aircraft intel</span>
          <button className="bg-transparent border-none text-fg3 text-[11px] cursor-pointer py-0.5 px-1" onClick={onClose}>
            ✕
          </button>
        </div>
      )}

      {/* Photo */}
      {aircraft?.url_photo_thumbnail && (
        <img
          className="w-full block max-h-32.5 object-cover border-b border-border filter-[saturate(0.4)_brightness(0.85)]"
          src={aircraft.url_photo_thumbnail}
          alt=""
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      )}

      {/* Live vector */}
      <Section title="live vector" srcTag={srcTag} />
      <DRow label="icao24" value={flight.icao} colorClass="text-acc" />
      <DRow
        label="callsign"
        value={flight.callsign + (flight.mil ? ' · military' : '')}
        colorClass="text-ylw"
      />
      <DRow
        label="altitude"
        value={flight.alt != null ? `${flight.alt} m` : null}
        colorClass="text-cyn"
      />
      <DRow
        label="speed"
        value={flight.vel != null ? `${flight.vel} m/s` : null}
      />
      <DRow
        label="heading"
        value={flight.hdg != null ? `${flight.hdg}°` : null}
        colorClass="text-fg3"
      />
      <DRow
        label="position"
        value={flight.lat != null ? `${flight.lat}, ${flight.lon}` : null}
        colorClass="text-fg3"
      />
      <DRow
        label="squawk"
        value={squawkLabel(flight.squawk)}
        colorClass={squawkColor(flight.squawk)}
      />
      <DRow
        label="status"
        value={flight.grounded ? 'ground' : 'airborne'}
        colorClass={flight.grounded ? 'text-ylw' : 'text-grn'}
      />

      {/* adsb.fi telemetry — extra fields not in OpenSky/ADSBx */}
      <Section title="adsb.fi telemetry" srcTag={{ label: 'adsb.fi', colorClass: 'text-cyn' }} />
      {adsbfi === undefined ? (
        <DRow label="status" value="loading..." colorClass="text-fg3" />
      ) : adsbfi === null ? (
        <DRow label="status" value="no data available" colorClass="text-fg3" />
      ) : (
        <>
          {adsbfi.emergency && (
            <DRow label="⚠ emergency" value={adsbfi.emergency} colorClass="text-red" />
          )}
          <DRow
            label="vert rate"
            value={adsbfi.baroRate != null ? `${adsbfi.baroRate > 0 ? '+' : ''}${adsbfi.baroRate} ft/min` : 'N/A'}
            colorClass={adsbfi.baroRate != null && Math.abs(adsbfi.baroRate) > 2000 ? 'text-ylw' : adsbfi.baroRate != null ? 'text-fg' : 'text-fg3'}
          />
          <DRow
            label="MCP alt"
            value={adsbfi.navAlt != null ? `${adsbfi.navAlt} ft` : 'N/A'}
            colorClass={adsbfi.navAlt != null ? 'text-cyn' : 'text-fg3'}
          />
          <DRow
            label="MCP hdg"
            value={adsbfi.navHdg != null ? `${adsbfi.navHdg}°` : 'N/A'}
            colorClass="text-fg3"
          />
          <DRow label="reg" value={adsbfi.reg || 'N/A'} colorClass={adsbfi.reg ? 'text-ylw' : 'text-fg3'} />
          <DRow
            label="type"
            value={adsbfi.type ? `${adsbfi.type}${adsbfi.typeDesc ? ` — ${adsbfi.typeDesc}` : ''}` : 'N/A'}
            colorClass={adsbfi.type ? 'text-fg' : 'text-fg3'}
          />
          <DRow label="operator" value={adsbfi.operator || 'N/A'} colorClass={adsbfi.operator ? 'text-fg' : 'text-fg3'} />
          {adsbfi.year && <DRow label="year" value={adsbfi.year} colorClass="text-fg3" />}
          {adsbfi.mil && <DRow label="military" value="yes" colorClass="text-red" />}
          {adsbfi.category && <DRow label="category" value={adsbfi.category} colorClass="text-fg3" />}
        </>
      )}

      {/* Flight map */}
      <Section title="map" />
      <FlightMap
        snapshots={trackHistory}
        flight={flight}
        flights={flights}
        fullscreen={mapFullscreen}
        onToggleFullscreen={() => setMapFullscreen(p => !p)}
      />

      {/* Track history sparklines */}
      <Section title="track" />
      <TrackChart snapshots={trackHistory} />

      {/* Aircraft */}
      <Section title="aircraft" />
      {aircraft ? (
        <>
          <DRow label="type" value={aircraft.type} />
          <DRow label="icao type" value={aircraft.icao_type} colorClass="text-fg3" />
          <DRow label="manufacturer" value={aircraft.manufacturer} colorClass="text-acc" />
          <DRow label="registration" value={aircraft.registration} colorClass="text-ylw" />
          <DRow label="owner" value={aircraft.registered_owner} />
          <DRow label="country" value={aircraft.registered_owner_country_name} colorClass="text-fg3" />
        </>
      ) : adsbfi && (adsbfi.reg || adsbfi.type || adsbfi.operator) ? (
        <>
          {adsbfi.type && <DRow label="type" value={`${adsbfi.type}${adsbfi.typeDesc ? ` — ${adsbfi.typeDesc}` : ''}`} />}
          {adsbfi.reg && <DRow label="registration" value={adsbfi.reg} colorClass="text-ylw" />}
          {adsbfi.operator && <DRow label="owner" value={adsbfi.operator} />}
          {adsbfi.year && <DRow label="year" value={adsbfi.year} colorClass="text-fg3" />}
          <DRow label="source" value="adsb.fi" colorClass="text-cyn" />
        </>
      ) : enrichData ? (
        <DRow label="status" value="not in adsbdb" colorClass="text-fg3" />
      ) : (
        <DRow label="status" value="loading..." colorClass="text-fg3" />
      )}

      {/* Route */}
      <Section title="route" />
      {flightroute ? (
        <>
          {flightroute.airline?.name && (
            <DRow label="airline" value={flightroute.airline.name} />
          )}
          {flightroute.origin && (
            <>
              <DRow
                label="origin"
                value={`${flightroute.origin.icao_code} ${flightroute.origin.name}`}
                colorClass="text-acc"
              />
              <DRow
                label=""
                value={`${flightroute.origin.municipality}, ${flightroute.origin.country_name}`}
                colorClass="text-fg3"
              />
            </>
          )}
          {flightroute.midpoint && (
            <DRow
              label="via"
              value={`${flightroute.midpoint.icao_code} ${flightroute.midpoint.name}`}
              colorClass="text-acc"
            />
          )}
          {flightroute.destination && (
            <>
              <DRow
                label="dest"
                value={`${flightroute.destination.icao_code} ${flightroute.destination.name}`}
                colorClass="text-acc"
              />
              <DRow
                label=""
                value={`${flightroute.destination.municipality}, ${flightroute.destination.country_name}`}
                colorClass="text-fg3"
              />
            </>
          )}
        </>
      ) : enrichData ? (
        <DRow label="status" value="unknown" colorClass="text-fg3" />
      ) : (
        <DRow label="status" value="loading..." colorClass="text-fg3" />
      )}

      {/* AeroAPI */}
      <Section title="flightaware aeroapi" />
      {!backendOk ? (
        <DRow label="status" value="backend offline" colorClass="text-red" />
      ) : aeroSpend?.cap_reached && !aeroData ? (
        <DRow label="status" value={`cap reached ($${aeroSpend.total_spend.toFixed(2)} / $${aeroSpend.cap.toFixed(2)})`} colorClass="text-red" />
      ) : aeroData ? (
        <>
          {/* Route banner: ORIGIN → DESTINATION */}
          <div className="bg-bg2 py-1.5 px-2.5 flex items-center justify-between border-b border-border">
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="text-acc font-bold">{aeroData.origin?.code_icao || aeroData.origin?.code || '???'}</span>
              <span className="text-fg3">→</span>
              <span className="text-acc font-bold">{aeroData.destination?.code_icao || aeroData.destination?.code || '???'}</span>
            </div>
            <span className={clsx('text-[10px] px-1.5 py-px border',
              aeroData.status === 'En Route' ? 'border-grn text-grn' :
              aeroData.status?.includes('Delay') ? 'border-ylw text-ylw' :
              aeroData.status?.includes('Arrived') || aeroData.status?.includes('Landed') ? 'border-acc text-acc' :
              'border-border2 text-fg2'
            )}>
              {aeroData.status || 'unknown'}
            </span>
          </div>

          {/* Progress bar */}
          {aeroData.progress_percent != null && (
            <div className="px-2.5 py-1.5 border-b border-white/3">
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-fg3">progress</span>
                <span className="text-acc">{aeroData.progress_percent}%</span>
              </div>
              <div className="h-1 bg-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-acc rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, aeroData.progress_percent)}%` }}
                />
              </div>
            </div>
          )}

          <DRow label="ident" value={aeroData.ident} colorClass="text-ylw" />
          <DRow label="operator" value={aeroData.operator} colorClass="text-fg" />
          <DRow label="aircraft" value={aeroData.aircraft_type} />

          {/* Departure group */}
          <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg/50 border-t border-white/3 mt-0.5 tracking-wider">DEPARTURE</div>
          <DRow
            label="scheduled"
            value={fmtTime(aeroData.scheduled_out || aeroData.scheduled_off)}
            colorClass="text-fg3"
          />
          <DRow
            label="actual"
            value={fmtTime(aeroData.actual_out || aeroData.actual_off)}
            colorClass={aeroData.actual_out || aeroData.actual_off ? 'text-grn' : 'text-fg3'}
          />

          {/* Arrival group */}
          <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg/50 border-t border-white/3 mt-0.5 tracking-wider">ARRIVAL</div>
          <DRow
            label="estimated"
            value={fmtTime(aeroData.estimated_in || aeroData.estimated_on)}
            colorClass="text-fg3"
          />
          <DRow
            label="actual"
            value={fmtTime(aeroData.actual_in || aeroData.actual_on)}
            colorClass={aeroData.actual_in || aeroData.actual_on ? 'text-grn' : 'text-fg3'}
          />

          {/* Filed plan */}
          <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg/50 border-t border-white/3 mt-0.5 tracking-wider">FILED</div>
          <DRow
            label="altitude"
            value={aeroData.filed_altitude ? `${aeroData.filed_altitude * 100} ft` : null}
            colorClass="text-cyn"
          />
          <DRow
            label="speed"
            value={aeroData.filed_speed ? `${aeroData.filed_speed} kt` : null}
            colorClass="text-fg"
          />
        </>
      ) : aeroError ? (
        <DRow label="error" value={aeroError} colorClass="text-red" />
      ) : (
        <button
          className={clsx(
            'w-full border border-border2 text-acc text-[11px] py-2 px-2.5 cursor-pointer text-left font-mono flex justify-between items-center m-0 transition-colors duration-150',
            'bg-acc/6 hover:bg-acc/14',
            !aeroLoading && flight.callsign !== '—' && 'animate-pulse-border',
            (aeroLoading || flight.callsign === '—') && 'opacity-40 cursor-default'
          )}
          onClick={handleAeroQuery}
          disabled={aeroLoading || flight.callsign === '—'}
        >
          <span>{aeroLoading ? 'querying...' : '❯ query aeroapi'}</span>
          <span className="text-ylw text-[10px]">~$0.005</span>
        </button>
      )}
    </div>
  )
}
