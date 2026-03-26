import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchAplByHex } from '../../services/airplaneslive'
import { enrichByHex } from '../../services/adsbfi'
import { fetchAnomaliesByIcao } from '../../services/dashboard'

function Row({ label, value, color = 'text-fg' }) {
  const empty = value == null || value === ''
  return (
    <div className="flex justify-between py-px px-2 gap-2">
      <span className="text-fg3 text-[10px] shrink-0">{label}</span>
      <span className={clsx('text-right text-[10px]', empty ? 'text-fg3/40' : color)}>
        {empty ? '—' : value}
      </span>
    </div>
  )
}

function Group({ title, color = 'text-fg3', children }) {
  return (
    <div className="mb-1">
      <div className={clsx('text-[9px] tracking-wider uppercase px-2 py-0.5 border-b border-white/5', color)}>
        {title}
      </div>
      {children}
    </div>
  )
}

function fmt(v, suffix = '') {
  if (v == null) return null
  return `${v}${suffix}`
}

function fmtSigned(v, suffix = '') {
  if (v == null) return null
  return `${v > 0 ? '+' : ''}${v}${suffix}`
}

export default function AnomalyDrilldown({ anomaly, onClose }) {
  const [apl, setApl] = useState(null)
  const [adsbfi, setAdsbfi] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!anomaly?.icao) return
    setLoading(true)
    setApl(null)
    setAdsbfi(null)
    setHistory([])

    Promise.allSettled([
      fetchAplByHex(anomaly.icao),
      enrichByHex(anomaly.icao),
      fetchAnomaliesByIcao(anomaly.icao, 10),
    ]).then(([aplRes, fiRes, histRes]) => {
      if (aplRes.status === 'fulfilled') setApl(aplRes.value)
      if (fiRes.status === 'fulfilled') setAdsbfi(fiRes.value)
      if (histRes.status === 'fulfilled') setHistory(histRes.value || [])
      setLoading(false)
    })
  }, [anomaly?.icao])

  const a = anomaly ? (apl || {}) : {}
  const fi = anomaly ? (adsbfi || {}) : {}

  const severityColor = anomaly?.severity === 'CRITICAL' ? 'text-red'
    : anomaly?.severity === 'HIGH' ? 'text-ylw' : 'text-fg3'

  return (
    <div className="bg-bg1 border border-border">
      {/* Header */}
      <div className="bg-bg2 border-b border-border py-1 px-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-acc text-[11px] font-bold tracking-wider uppercase">investigation</span>
          {anomaly ? (
            <>
              <span className={clsx('text-[10px] font-bold', severityColor)}>{anomaly.severity}</span>
              <span className="text-acc text-[11px] font-bold">{anomaly.icao}</span>
              <span className="text-ylw text-[10px]">{anomaly.callsign || '—'}</span>
              {anomaly.category && <span className="text-mag text-[9px]">{anomaly.category}</span>}
              <span className="text-red text-[10px] font-bold">{anomaly.score}</span>
              {loading && <span className="text-fg3 text-[9px]">enriching...</span>}
            </>
          ) : (
            <span className="text-fg3 text-[10px]">select an anomaly to investigate</span>
          )}
        </div>
        {anomaly && <button onClick={onClose} className="text-fg3 hover:text-fg1 text-[11px] px-1">✕</button>}
      </div>

      {!anomaly && (
        <div className="py-8 text-center text-fg3/40 text-[10px]">
          click an anomaly in the feed or on the map
        </div>
      )}

      {anomaly && <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
        {/* Column 1: detection + aircraft identity */}
        <div className="bg-bg1 py-1">
          <Group title="detection" color="text-red">
            <Row label="score" value={anomaly.score} color="text-red" />
            <Row label="severity" value={anomaly.severity} color={severityColor} />
            <Row label="category" value={anomaly.category} color="text-mag" />
            <Row label="confirmed" value={anomaly.confirmed ? 'YES' : 'no'} color={anomaly.confirmed ? 'text-grn' : 'text-fg3'} />
            <Row label="phase" value={anomaly.phase} />
            <Row label="squawk" value={anomaly.squawk} color={anomaly.squawk === '7700' || anomaly.squawk === '7600' || anomaly.squawk === '7500' ? 'text-red' : 'text-fg'} />
          </Group>
          <Group title="reasons" color="text-ylw">
            {anomaly.reasons?.length > 0
              ? anomaly.reasons.map((r, i) => (
                  <div key={i} className="text-[10px] text-fg2 px-2 py-px">{r}</div>
                ))
              : <div className="text-[10px] text-fg3/40 px-2 py-px">—</div>
            }
          </Group>
          <Group title="all categories" color="text-mag">
            <div className="flex flex-wrap gap-1 px-2 py-0.5">
              {anomaly.categories?.length > 0
                ? anomaly.categories.map(c => (
                    <span key={c} className="text-[9px] text-mag border border-mag/30 px-1 rounded">{c}</span>
                  ))
                : <span className="text-[9px] text-fg3/40">—</span>
              }
            </div>
          </Group>
          <Group title="aircraft" color="text-acc">
            <Row label="reg" value={fi.reg} color="text-acc" />
            <Row label="type" value={fi.type || a.type} color="text-acc" />
            <Row label="operator" value={fi.operator} />
            <Row label="serial" value={fi.serial} color="text-fg3" />
            <Row label="year" value={fi.year} color="text-fg3" />
            <Row label="country" value={a.country} />
            <Row label="military" value={a.mil ? 'YES' : a.mil === false ? 'no' : null} color={a.mil ? 'text-red' : 'text-fg3'} />
            <Row label="category" value={a.category} color="text-fg3" />
          </Group>
          <Group title={`history (${history.length})`} color="text-fg3">
            {history.length > 0
              ? history.slice(0, 8).map((h, i) => (
                  <div key={i} className="flex justify-between px-2 py-px text-[9px]">
                    <span className={h.resolved ? 'text-fg3' : 'text-red'}>{h.score}</span>
                    <span className="text-fg3">{h.category || '—'}</span>
                    <span className="text-fg3">{h.detected_at?.substring(11, 19) || '—'}</span>
                    <span className={h.resolved ? 'text-grn' : 'text-red'}>{h.resolved ? 'resolved' : 'active'}</span>
                  </div>
                ))
              : <div className="text-[10px] text-fg3/40 px-2 py-px">—</div>
            }
          </Group>
        </div>

        {/* Column 2: position + signal */}
        <div className="bg-bg1 py-1">
          <Group title="position" color="text-cyn">
            <Row label="lat" value={anomaly.lat?.toFixed(4)} color="text-cyn" />
            <Row label="lon" value={anomaly.lon?.toFixed(4)} color="text-cyn" />
            <Row label="alt" value={fmt(anomaly.alt, ' m')} color="text-cyn" />
            <Row label="vel" value={fmt(anomaly.vel, ' m/s')} />
            <Row label="hdg" value={fmt(anomaly.hdg, '°')} />
          </Group>
          <Group title="airspeed" color="text-cyn">
            <Row label="IAS" value={fmt(a.ias, ' kt')} color="text-cyn" />
            <Row label="TAS" value={fmt(a.tas, ' kt')} color="text-cyn" />
            <Row label="mach" value={a.mach != null ? `M${a.mach}` : null} color="text-acc" />
            <Row label="GS" value={a.vel != null ? `${Math.round(a.vel / 0.5144)} kt` : null} color="text-fg3" />
          </Group>
          <Group title="attitude" color="text-ylw">
            <Row label="roll" value={fmtSigned(a.roll, '°')} color={a.roll != null && Math.abs(a.roll) > 25 ? 'text-ylw' : 'text-fg'} />
            <Row label="turn rate" value={fmtSigned(a.trackRate, '°/s')} />
            <Row label="mag hdg" value={fmt(a.magHeading, '°')} color="text-fg3" />
            <Row label="true hdg" value={fmt(a.trueHeading, '°')} color="text-fg3" />
            <Row label="vert rate" value={fmt(a.vertRate, ' m/s')} />
          </Group>
          <Group title="signal" color="text-fg3">
            <Row label="RSSI" value={fmt(a.rssi, ' dB')} color={a.rssi != null && a.rssi > -10 ? 'text-grn' : 'text-ylw'} />
            <Row label="msgs" value={a.messages} color="text-fg3" />
            <Row label="last seen" value={a.seen != null ? `${a.seen}s ago` : null} color={a.seen > 10 ? 'text-ylw' : 'text-fg3'} />
            <Row label="last pos" value={a.seenPos != null ? `${a.seenPos}s ago` : null} color={a.seenPos > 30 ? 'text-red' : 'text-fg3'} />
            <Row label="pos source" value={a.posSrc === 0 ? 'ADS-B' : a.posSrc === 1 ? 'TIS-B' : a.posSrc === 2 ? 'MLAT' : null} />
          </Group>
        </div>

        {/* Column 3: autopilot + environment + flags */}
        <div className="bg-bg1 py-1">
          <Group title="autopilot / FMS" color="text-grn">
            <Row label="MCP alt" value={fmt(a.navAltMcp, ' ft')} color="text-cyn" />
            <Row label="FMS alt" value={fmt(a.navAltFms, ' ft')} color="text-cyn" />
            <Row label="sel hdg" value={fmt(a.navHeading, '°')} />
            <Row label="nav modes" value={a.navModes?.length > 0 ? a.navModes.join(', ') : null} color="text-grn" />
          </Group>
          <Group title="environment" color="text-mag">
            <Row label="wind dir" value={fmt(a.windDir, '°')} color="text-mag" />
            <Row label="wind spd" value={fmt(a.windSpeed, ' kt')} color="text-mag" />
            <Row label="OAT" value={fmt(a.oat, '°C')} />
            <Row label="TAT" value={fmt(a.tat, '°C')} color="text-fg3" />
          </Group>
          <Group title="flags" color="text-red">
            <Row label="emergency" value={a.emergency && a.emergency !== 'none' ? a.emergency : a.emergency === 'none' ? 'none' : null} color={a.emergency && a.emergency !== 'none' ? 'text-red' : 'text-grn'} />
            <Row label="alert" value={a.alert ? 'ACTIVE' : a.alert === false ? 'no' : null} color={a.alert ? 'text-red' : 'text-fg3'} />
            <Row label="SPI" value={a.spi ? 'ACTIVE' : a.spi === false ? 'no' : null} color={a.spi ? 'text-red' : 'text-fg3'} />
          </Group>
          <Group title="weather context" color="text-cyn">
            {anomaly.weather_context ? (
              <>
                {anomaly.weather_context.sigmets && (
                  <>
                    <Row label="convective" value={anomaly.weather_context.sigmets.convective || 0} color={anomaly.weather_context.sigmets.convective > 0 ? 'text-red' : 'text-fg3'} />
                    <Row label="turbulence" value={anomaly.weather_context.sigmets.turbulence || 0} color={anomaly.weather_context.sigmets.turbulence > 0 ? 'text-ylw' : 'text-fg3'} />
                    <Row label="icing" value={anomaly.weather_context.sigmets.icing || 0} color={anomaly.weather_context.sigmets.icing > 0 ? 'text-cyn' : 'text-fg3'} />
                  </>
                )}
                {anomaly.weather_context.pireps && (
                  <>
                    <Row label="PIREPs" value={anomaly.weather_context.pireps.count || 0} />
                    <Row label="severe" value={anomaly.weather_context.pireps.severe ? 'YES' : 'no'} color={anomaly.weather_context.pireps.severe ? 'text-red' : 'text-fg3'} />
                    <Row label="max turb" value={anomaly.weather_context.pireps.maxTurbulence} color="text-ylw" />
                    <Row label="max ice" value={anomaly.weather_context.pireps.maxIcing} color="text-cyn" />
                  </>
                )}
              </>
            ) : (
              <div className="text-[10px] text-fg3/40 px-2 py-px">—</div>
            )}
          </Group>
        </div>
      </div>}
    </div>
  )
}
