import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { fetchAircraftContext } from '../services/context'

function fmtKm(value) {
  if (value == null) return '—'
  if (value < 1) return `${Math.round(value * 1000)} m`
  return `${value.toFixed(1)} km`
}

function confidenceLabel(value) {
  if (value >= 0.9) return 'High'
  if (value >= 0.7) return 'Moderate'
  return 'Low'
}

function EvidenceRow({ title, detail, meta, critical = false, caution = false }) {
  return (
    <article className="corroboration-row">
      <div>
        <strong className={clsx(critical && 'text-red', caution && 'text-ylw')}>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {meta && <small>{meta}</small>}
    </article>
  )
}

export default function ContextPanel({ flight }) {
  const [ctx, setCtx] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestRef.current
    if (!flight?.icao) {
      setCtx(null)
      setError(null)
      setLoading(false)
      return
    }
    setCtx(null)
    setError(null)
    setLoading(true)
    fetchAircraftContext(flight.icao, {
      lat: flight.lat,
      lon: flight.lon,
      altitude: flight.alt != null ? Math.round(flight.alt * 3.281) : null,
      velocity: flight.vel,
      heading: flight.hdg,
      callsign: flight.callsign,
      squawk: flight.squawk,
    })
      .then(data => { if (requestRef.current === requestId) setCtx(data) })
      .catch(err => { if (requestRef.current === requestId) setError(err.response?.data?.error || err.message) })
      .finally(() => { if (requestRef.current === requestId) setLoading(false) })
    return () => { if (requestRef.current === requestId) requestRef.current += 1 }
  }, [flight?.icao])

  if (!flight) return null

  const inferences = ctx?.inferences || []
  const circling = Boolean(ctx?.orbit?.circling)
  const events = ctx?.nearby?.events?.events || []
  const quakes = ctx?.nearby?.quakes?.quakes || []
  const volcanoes = ctx?.nearby?.volcanoAlerts?.alerts || []
  const fireCount = ctx?.nearby?.fires?.count || 0
  const evidenceCount = inferences.length + (circling ? 1 : 0) + events.length + quakes.length + volcanoes.length + (fireCount > 0 ? 1 : 0)
  const actionable = evidenceCount > 0

  return (
    <details key={flight.icao} className="inspector-disclosure corroboration" defaultOpen={actionable}>
      <summary>
        <span>Corroboration</span>
        <span className={clsx('corroboration__state', error && 'text-ylw', actionable && 'text-acc')}>
          {loading ? 'Checking'
            : error ? 'Unavailable'
              : !ctx ? '—'
                : actionable ? `${evidenceCount} match${evidenceCount === 1 ? '' : 'es'}`
                  : 'No matches'}
        </span>
      </summary>

      <div className="corroboration__body">
        {error && <p className="corroboration__note">External context unavailable.</p>}

        {inferences.map((inference, index) => (
          <EvidenceRow
            key={`${inference.label}-${index}`}
            title={inference.label.replace(/_/g, ' ')}
            detail={(inference.reasons || []).join(' · ')}
            meta={confidenceLabel(inference.confidence || 0)}
            critical={inference.severity === 'critical'}
            caution={inference.severity === 'high'}
          />
        ))}

        {circling && (
          <EvidenceRow title="Circling pattern" detail={`${ctx.orbit.totalTurnDeg}° cumulative turn across ${ctx.orbit.samples} samples`} meta={`Compactness ${ctx.orbit.compactness}`} caution />
        )}
        {events.slice(0, 3).map(event => (
          <EvidenceRow key={event.id} title={event.title} detail={(event.categories || []).join(', ')} meta={fmtKm(event.distanceKm)} />
        ))}
        {quakes.slice(0, 2).map(quake => (
          <EvidenceRow key={quake.id} title={`Earthquake M${quake.mag?.toFixed(1)}`} detail={quake.place} meta={fmtKm(quake.distanceKm)} caution />
        ))}
        {volcanoes.slice(0, 2).map(volcano => (
          <EvidenceRow key={volcano.vnum} title={volcano.name} detail={`${volcano.alertLevel} · ${volcano.observatory}`} meta={volcano.colorCode} caution />
        ))}
        {fireCount > 0 && (
          <EvidenceRow title="Satellite fire detections" detail={`${fireCount} detection pixel${fireCount === 1 ? '' : 's'} in the search area`} meta={ctx.nearby.fires.nearest ? `Nearest ${fmtKm(ctx.nearby.fires.nearest.distanceKm)}` : null} caution={fireCount >= 3} />
        )}
      </div>
    </details>
  )
}
