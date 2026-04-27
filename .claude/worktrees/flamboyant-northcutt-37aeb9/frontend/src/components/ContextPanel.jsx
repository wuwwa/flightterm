// ── ContextPanel — v2.0.0 Correlation Layer UI ─────────────────────────────
// Mounted inside the FlightInspectorModal. Pulls /api/context/aircraft/:icao
// when a flight is selected and renders the inference bundle in the existing
// tile visual language.

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { fetchAircraftContext } from '../services/context'

function Chip({ label, tone = 'acc', title }) {
  const palette = {
    acc: 'border-acc/50 text-acc bg-acc/5',
    grn: 'border-grn/50 text-grn bg-grn/5',
    ylw: 'border-ylw/50 text-ylw bg-ylw/5',
    red: 'border-red/60 text-red bg-red/10',
    mag: 'border-mag/50 text-mag bg-mag/5',
    fg3: 'border-border text-fg3 bg-bg2/40',
  }[tone] || 'border-border text-fg3 bg-bg2/40'
  return (
    <span className={clsx('inline-block px-1.5 py-[1px] text-[9px] uppercase tracking-wide border rounded', palette)} title={title}>
      {label}
    </span>
  )
}

function toneForConfidence(c, severity) {
  if (severity === 'critical' || c >= 0.95) return 'red'
  if (c >= 0.8) return 'ylw'
  if (c >= 0.6) return 'acc'
  if (c >= 0.4) return 'mag'
  return 'fg3'
}

function InferenceRow({ inference }) {
  const tone = toneForConfidence(inference.confidence, inference.severity)
  return (
    <div className="border border-border rounded p-1.5 mb-1 last:mb-0 bg-bg2/30">
      <div className="flex justify-between items-center gap-2 mb-1">
        <span className="flex items-center gap-1.5">
          <Chip label={inference.label.replace(/_/g, ' ')} tone={tone} />
          <span className="text-fg3 text-[9px] tabular-nums">
            {(inference.confidence * 100).toFixed(0)}% confidence
          </span>
        </span>
        {inference.severity && (
          <Chip label={inference.severity} tone="red" />
        )}
      </div>
      <ul className="text-[10px] text-fg2 leading-tight pl-3 list-disc marker:text-fg3/50">
        {inference.reasons.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </div>
  )
}

function fmtKm(n) {
  if (n == null) return '—'
  if (n < 1) return `${(n * 1000).toFixed(0)} m`
  return `${n.toFixed(1)} km`
}

export default function ContextPanel({ flight }) {
  const [ctx, setCtx] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!flight?.icao) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAircraftContext(flight.icao, {
      lat: flight.lat,
      lon: flight.lon,
      altitude: flight.alt != null ? Math.round(flight.alt * 3.281) : null,
      velocity: flight.vel,
      heading: flight.hdg,
      callsign: flight.callsign,
      squawk: flight.squawk,
    })
      .then(data => { if (!cancelled) setCtx(data) })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [flight?.icao])

  if (!flight) return null

  return (
    <div className="bg-bg2/40 border border-border rounded p-2 xl:col-span-2">
      <div className="flex items-center justify-between mb-1.5 pb-1 border-b border-border">
        <span className="text-mag text-[9px] uppercase tracking-wide">Correlation Layer · v2</span>
        {loading && <span className="text-fg3 text-[9px]">loading…</span>}
        {error && <span className="text-red text-[9px]">{error}</span>}
        {ctx && (
          <span className="text-fg3 text-[9px] tabular-nums">
            {ctx.inferences?.length || 0} signals
          </span>
        )}
      </div>

      {!ctx && !loading && !error && (
        <div className="text-fg3/50 text-[10px] py-3 text-center">
          Select a live aircraft to pull fire/weather/event/webcam correlations.
        </div>
      )}

      {ctx && (
        <>
          {/* ── Inferences ─────────────────────────────────────────────── */}
          {ctx.inferences?.length > 0 ? (
            <div className="mb-2">
              {ctx.inferences.map((inf, i) => <InferenceRow key={i} inference={inf} />)}
            </div>
          ) : (
            <div className="text-fg3/40 text-[10px] text-center py-2">
              No corroborated inferences — kinematics and environment look routine.
            </div>
          )}

          {/* ── Orbit flag ─────────────────────────────────────────────── */}
          {ctx.orbit && (
            <div className="mb-2 text-[10px]">
              <span className="text-fg3 uppercase tracking-wide mr-1.5">orbit</span>
              {ctx.orbit.circling ? (
                <Chip label={`circling · ${ctx.orbit.totalTurnDeg}° · compactness ${ctx.orbit.compactness}`} tone="ylw" />
              ) : (
                <span className="text-fg3/50">transit profile ({ctx.orbit.totalTurnDeg}° turn over {ctx.orbit.samples} samples)</span>
              )}
            </div>
          )}

          {/* ── Environmental strip ────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-1.5 mb-2 text-[10px]">
            {ctx.env?.openMeteo && !ctx.env.openMeteo.error && (
              <div className="bg-bg1/60 border border-border rounded p-1">
                <div className="text-fg3 text-[9px] uppercase">weather (meteo)</div>
                <div className="text-fg2">{ctx.env.openMeteo.weather} · {ctx.env.openMeteo.tempC?.toFixed(0)}°C</div>
                <div className="text-fg3/80">
                  wind {ctx.env.openMeteo.windKts?.toFixed(0)}kt
                  {ctx.env.openMeteo.windGustKts ? ` gust ${ctx.env.openMeteo.windGustKts.toFixed(0)}kt` : ''}
                </div>
                {ctx.env.openMeteo.visibilityM != null && (
                  <div className="text-fg3/80">vis {(ctx.env.openMeteo.visibilityM / 1000).toFixed(1)}km</div>
                )}
              </div>
            )}
            {ctx.env?.airQuality?.closest && (
              <div className="bg-bg1/60 border border-border rounded p-1">
                <div className="text-fg3 text-[9px] uppercase">air quality</div>
                <div className="text-fg2 truncate" title={ctx.env.airQuality.closest.name}>{ctx.env.airQuality.closest.name}</div>
                <div className="text-fg3/80">
                  {ctx.env.airQuality.closest.sensors?.map(s => s.parameter).filter(Boolean).slice(0, 3).join(' · ') || '—'}
                </div>
              </div>
            )}
            {ctx.env?.spaceWeather && (
              <div className="bg-bg1/60 border border-border rounded p-1">
                <div className="text-fg3 text-[9px] uppercase">space wx</div>
                <div className="text-fg2">Kp {ctx.env.spaceWeather.kp ?? ctx.env.spaceWeather.kpEstimated ?? '—'}</div>
                <div className={clsx('text-fg3/80', ctx.env.spaceWeather.kp >= 5 && 'text-ylw')}>
                  {ctx.env.spaceWeather.classification}
                </div>
              </div>
            )}
            {ctx.nearby?.fires?.count > 0 && (
              <div className="bg-bg1/60 border border-border rounded p-1">
                <div className="text-fg3 text-[9px] uppercase">FIRMS fires</div>
                <div className="text-fg2">{ctx.nearby.fires.count} pixels</div>
                {ctx.nearby.fires.nearest && (
                  <div className="text-fg3/80">nearest {fmtKm(ctx.nearby.fires.nearest.distanceKm)}</div>
                )}
              </div>
            )}
          </div>

          {/* ── Nearby events ──────────────────────────────────────────── */}
          {(ctx.nearby?.events?.count > 0 || ctx.nearby?.quakes?.count > 0 || ctx.nearby?.volcanoAlerts?.count > 0) && (
            <div className="mb-2">
              <div className="text-fg3 text-[9px] uppercase mb-1">nearby events</div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-1 text-[10px]">
                {ctx.nearby.events?.events?.slice(0, 3).map(ev => (
                  <div key={ev.id} className="bg-bg1/40 border border-border rounded p-1">
                    <div className="flex justify-between gap-1">
                      <span className="text-fg2 truncate" title={ev.title}>{ev.title}</span>
                      <span className="text-fg3 shrink-0 tabular-nums">{fmtKm(ev.distanceKm)}</span>
                    </div>
                    <div className="text-fg3/70 truncate">
                      {ev.categories.join(', ')}
                      {ev.magnitude != null && ` · ${ev.magnitude} ${ev.magnitudeUnit}`}
                    </div>
                  </div>
                ))}
                {ctx.nearby.quakes?.quakes?.slice(0, 2).map(q => (
                  <div key={q.id} className="bg-bg1/40 border border-border rounded p-1">
                    <div className="flex justify-between gap-1">
                      <span className="text-red">M{q.mag?.toFixed(1)}</span>
                      <span className="text-fg3 tabular-nums">{fmtKm(q.distanceKm)}</span>
                    </div>
                    <div className="text-fg3/80 truncate" title={q.place}>{q.place}</div>
                  </div>
                ))}
                {ctx.nearby.volcanoAlerts?.alerts?.slice(0, 2).map(v => (
                  <div key={v.vnum} className="bg-bg1/40 border border-border rounded p-1">
                    <div className="flex justify-between gap-1">
                      <span className="text-ylw">{v.name}</span>
                      <span className="text-fg3">{v.colorCode}</span>
                    </div>
                    <div className="text-fg3/80 truncate">{v.alertLevel} · {v.observatory}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* v5.5.0 — When FIRMS shows fires nearby, link to ALERTWildfire's
              regional PTZ cam network (likely has a camera pointing at the
              same fire). Aviation-relevant; replaces random street-level
              photos. */}
          {ctx.nearby?.fires?.count >= 3 && ctx.aircraft?.lat != null && (
            <div className="mb-2">
              <div className="text-fg3 text-[9px] uppercase mb-0.5">fire cams nearby</div>
              <a
                href={`https://www.alertwildfire.org/?camera=&view=${ctx.aircraft.lat.toFixed(3)},${ctx.aircraft.lon.toFixed(3)},9`}
                target="_blank" rel="noopener noreferrer"
                className="inline-block text-[10px] border border-red/50 hover:border-red text-red/80 hover:text-red px-2 py-[2px] rounded"
              >
                ALERTWildfire · {ctx.nearby.fires.count} FIRMS pixels in area ↗
              </a>
            </div>
          )}

          {/* ── Visual corroboration ───────────────────────────────────── */}
          {/* v5.5.0 — Mapillary street-level removed (wrong perspective for
              aviation: 360° road-level photos of streets the aircraft is
              500-35,000 ft above). NPS cams retained because they are
              landscape-oriented and useful when aircraft is near a park. */}
          {ctx.nearby?.webcams?.webcams?.length > 0 && (
            <div>
              <div className="text-fg3 text-[9px] uppercase mb-1">nearby NPS cams</div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-1">
                {ctx.nearby.webcams.webcams.slice(0, 4).map(cam => (
                  <a key={cam.id} href={cam.url} target="_blank" rel="noopener noreferrer"
                     className="block bg-bg1/40 border border-border rounded overflow-hidden hover:border-acc">
                    {cam.image ? (
                      <img src={cam.image} alt="" className="w-full h-16 object-cover"
                           onError={(e) => { e.currentTarget.style.display = 'none' }} />
                    ) : (
                      <div className="w-full h-16 grid place-items-center text-fg3/40 text-[9px]">no preview</div>
                    )}
                    <div className="p-1 text-[9px]">
                      <div className="text-fg2 truncate" title={cam.title}>{cam.title}</div>
                      <div className="text-fg3/70">{cam.park} · {fmtKm(cam.distanceKm)}</div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* v5.5.0 — Mapillary section removed: wrong perspective for
              aviation (360° road-level photos). Backend adapter retained
              only for possible future low-altitude helicopter-ops use. */}
        </>
      )}
    </div>
  )
}
