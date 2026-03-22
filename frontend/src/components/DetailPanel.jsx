import { useState } from 'react'
import { fetchFlight } from '../services/aeroapi'

const s = {
  panel: {
    background: 'var(--bg1)',
    borderLeft: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column',
    overflowY: 'auto', width: '300px', flexShrink: 0,
  },
  head: {
    background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
    padding: '3px 10px', display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', fontSize: '11px', color: 'var(--fg3)',
    position: 'sticky', top: 0, zIndex: 1, flexShrink: 0,
  },
  title: { color: 'var(--acc)' },
  closeBtn: {
    background: 'none', border: 'none', color: 'var(--fg3)',
    fontSize: '11px', cursor: 'pointer', padding: '2px 4px',
  },
  sec: {
    padding: '5px 10px 3px', fontSize: '10px', color: 'var(--fg3)',
    background: 'var(--bg2)', borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)', marginTop: '1px',
    letterSpacing: '0.08em',
  },
  row: {
    display: 'flex', justifyContent: 'space-between',
    padding: '3px 10px', gap: '8px',
    borderBottom: '1px solid rgba(255,255,255,0.025)',
  },
  key: { color: 'var(--fg3)', fontSize: '11px', flexShrink: 0 },
  val: { color: 'var(--fg)', textAlign: 'right', fontSize: '11px', wordBreak: 'break-all' },
  photo: {
    width: '100%', display: 'block', maxHeight: '130px',
    objectFit: 'cover', filter: 'saturate(0.4) brightness(0.85)',
    borderBottom: '1px solid var(--border)',
  },
  empty: { padding: '40px 20px', textAlign: 'center', color: 'var(--fg3)', fontSize: '11px' },
  aeroBtn: {
    width: '100%', background: 'none', border: '1px solid var(--border2)',
    color: 'var(--fg3)', fontSize: '11px', padding: '5px 10px',
    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
}

function DRow({ label, value, color }) {
  return (
    <div style={s.row}>
      <span style={s.key}>{label}</span>
      <span style={{ ...s.val, color: color || 'var(--fg)' }}>{value ?? '—'}</span>
    </div>
  )
}

function Section({ title, srcTag }) {
  return (
    <div style={s.sec}>
      {title}
      {srcTag && <span style={{ float: 'right', fontSize: '10px', color: srcTag.color }}>[{srcTag.label}]</span>}
    </div>
  )
}

function fmtTime(s) {
  if (!s) return '—'
  try { return new Date(s).toISOString().substring(11, 16) + ' utc' } catch { return s }
}

export default function DetailPanel({ flight, enrichData, aeroCache, onClose, onAeroFetched, backendOk }) {
  const [aeroLoading, setAeroLoading] = useState(false)
  const [aeroError, setAeroError] = useState(null)

  if (!flight) {
    return (
      <div style={s.panel}>
        <div style={s.head}><span style={s.title}>aircraft intel</span></div>
        <div style={s.empty}>select a row to inspect</div>
      </div>
    )
  }

  const { aircraft, flightroute } = enrichData || {}
  const aeroData = aeroCache[flight.icao]
  const srcTag = flight.src === 'adsbx'
    ? { label: 'adsbx', color: 'var(--acc)' }
    : { label: 'opensky', color: 'var(--grn)' }

  const handleAeroQuery = async () => {
    if (aeroLoading || !flight.callsign || flight.callsign === '—') return
    setAeroLoading(true)
    setAeroError(null)
    try {
      const data = await fetchFlight(flight.callsign)
      onAeroFetched(flight.icao, data)
    } catch (err) {
      setAeroError(err.response?.data?.error || err.message)
    } finally {
      setAeroLoading(false)
    }
  }

  return (
    <div style={s.panel}>
      <div style={s.head}>
        <span style={s.title}>aircraft intel</span>
        <button style={s.closeBtn} onClick={onClose}>✕</button>
      </div>

      {/* Photo */}
      {aircraft?.url_photo_thumbnail && (
        <img
          style={s.photo}
          src={aircraft.url_photo_thumbnail}
          alt=""
          onError={e => { e.currentTarget.style.display = 'none' }}
        />
      )}

      {/* Live vector */}
      <Section title="live vector" srcTag={srcTag} />
      <DRow label="icao24"   value={flight.icao}     color="var(--acc)" />
      <DRow label="callsign" value={flight.callsign + (flight.mil ? ' · military' : '')} color="var(--ylw)" />
      <DRow label="altitude" value={flight.alt != null ? `${flight.alt} m` : null} color="var(--cyn)" />
      <DRow label="speed"    value={flight.vel != null ? `${flight.vel} m/s` : null} />
      <DRow label="heading"  value={flight.hdg != null ? `${flight.hdg}°` : null} color="var(--fg3)" />
      <DRow label="position" value={flight.lat != null ? `${flight.lat}, ${flight.lon}` : null} color="var(--fg3)" />
      <DRow label="status"   value={flight.grounded ? 'ground' : 'airborne'} color={flight.grounded ? 'var(--ylw)' : 'var(--grn)'} />

      {/* Aircraft */}
      <Section title="aircraft" />
      {aircraft ? (
        <>
          <DRow label="type"         value={aircraft.type} />
          <DRow label="icao type"    value={aircraft.icao_type}    color="var(--fg3)" />
          <DRow label="manufacturer" value={aircraft.manufacturer} color="var(--acc)" />
          <DRow label="registration" value={aircraft.registration} color="var(--ylw)" />
          <DRow label="owner"        value={aircraft.registered_owner} />
          <DRow label="country"      value={aircraft.registered_owner_country_name} color="var(--fg3)" />
        </>
      ) : enrichData ? (
        <DRow label="status" value="not in adsbdb" color="var(--fg3)" />
      ) : (
        <DRow label="status" value="loading..." color="var(--fg3)" />
      )}

      {/* Route */}
      <Section title="route" />
      {flightroute ? (
        <>
          {flightroute.airline?.name && <DRow label="airline" value={flightroute.airline.name} />}
          {flightroute.origin && (
            <>
              <DRow label="origin" value={`${flightroute.origin.icao_code} ${flightroute.origin.name}`} color="var(--acc)" />
              <DRow label="" value={`${flightroute.origin.municipality}, ${flightroute.origin.country_name}`} color="var(--fg3)" />
            </>
          )}
          {flightroute.midpoint && (
            <DRow label="via" value={`${flightroute.midpoint.icao_code} ${flightroute.midpoint.name}`} color="var(--acc)" />
          )}
          {flightroute.destination && (
            <>
              <DRow label="dest" value={`${flightroute.destination.icao_code} ${flightroute.destination.name}`} color="var(--acc)" />
              <DRow label="" value={`${flightroute.destination.municipality}, ${flightroute.destination.country_name}`} color="var(--fg3)" />
            </>
          )}
        </>
      ) : enrichData ? (
        <DRow label="status" value="unknown" color="var(--fg3)" />
      ) : (
        <DRow label="status" value="loading..." color="var(--fg3)" />
      )}

      {/* AeroAPI */}
      <Section title="flightaware aeroapi" />
      {!backendOk ? (
        <DRow label="status" value="backend offline" color="var(--red)" />
      ) : aeroData ? (
        <>
          <DRow label="ident"        value={aeroData.ident}          color="var(--ylw)" />
          <DRow label="status"       value={aeroData.status}         color={aeroData.status === 'En Route' ? 'var(--grn)' : aeroData.status?.includes('Delay') ? 'var(--ylw)' : 'var(--fg)'} />
          <DRow label="progress"     value={aeroData.progress_percent != null ? `${aeroData.progress_percent}%` : null} color="var(--acc)" />
          <DRow label="origin"       value={aeroData.origin?.code_icao || aeroData.origin?.code}      color="var(--acc)" />
          <DRow label="destination"  value={aeroData.destination?.code_icao || aeroData.destination?.code} color="var(--acc)" />
          <DRow label="dep scheduled" value={fmtTime(aeroData.scheduled_out || aeroData.scheduled_off)} color="var(--fg3)" />
          <DRow label="dep actual"   value={fmtTime(aeroData.actual_out || aeroData.actual_off)}     color={aeroData.actual_out ? 'var(--grn)' : 'var(--fg3)'} />
          <DRow label="arr estimated" value={fmtTime(aeroData.estimated_in || aeroData.estimated_on)} color="var(--fg3)" />
          <DRow label="arr actual"   value={fmtTime(aeroData.actual_in || aeroData.actual_on)}       color={aeroData.actual_in ? 'var(--grn)' : 'var(--fg3)'} />
          <DRow label="aircraft"     value={aeroData.aircraft_type}  />
          <DRow label="operator"     value={aeroData.operator}       color="var(--fg3)" />
          <DRow label="filed alt"    value={aeroData.filed_altitude ? `${aeroData.filed_altitude * 100} ft` : null} color="var(--fg3)" />
          <DRow label="filed speed"  value={aeroData.filed_speed ? `${aeroData.filed_speed} kt` : null} color="var(--fg3)" />
        </>
      ) : aeroError ? (
        <DRow label="error" value={aeroError} color="var(--red)" />
      ) : (
        <button
          style={{
            ...s.aeroBtn,
            opacity: aeroLoading || flight.callsign === '—' ? 0.5 : 1,
            cursor: aeroLoading || flight.callsign === '—' ? 'default' : 'pointer',
          }}
          onClick={handleAeroQuery}
          disabled={aeroLoading || flight.callsign === '—'}
        >
          <span>{aeroLoading ? 'querying...' : '❯ query aeroapi for scheduled data'}</span>
          <span style={{ color: 'var(--fg3)', fontSize: '10px' }}>~$0.005</span>
        </button>
      )}
    </div>
  )
}
