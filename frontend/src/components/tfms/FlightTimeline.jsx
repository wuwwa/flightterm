import clsx from 'clsx'
import { formatLocalTime } from '../../utils/time'

const STATUS_COLORS = {
  ACTIVE: 'bg-grn', ASCENDING: 'bg-cyn', CRUISING: 'bg-acc',
  DESCENDING: 'bg-ylw', COMPLETED: 'bg-fg3', FILED: 'bg-mag', CANCELLED: 'bg-red',
}

const STATUS_TEXT = {
  ACTIVE: 'text-grn', ASCENDING: 'text-cyn', CRUISING: 'text-acc',
  DESCENDING: 'text-ylw', COMPLETED: 'text-fg3', FILED: 'text-mag', CANCELLED: 'text-red',
}

function fmtTime(ts) {
  return formatLocalTime(ts)
}

function fmtAlt(alt) {
  if (!alt) return null
  const s = String(alt).replace(/C$/, '')
  const n = Number(s)
  if (isNaN(n)) return alt
  return n >= 100 ? `FL${s}` : `${n * 100}ft`
}

export default function FlightTimeline({ flight }) {
  if (!flight) {
    return <div className="h-full flex items-center justify-center text-fg3 text-[10px]">select a flight to view timeline</div>
  }

  const etd = fmtTime(flight.etd)
  const atd = fmtTime(flight.atd)
  const eta = fmtTime(flight.eta)
  const ata = fmtTime(flight.ata)

  // Build phase milestones
  const phases = []
  if (flight.dep_arpt) phases.push({ label: flight.dep_arpt.replace(/^K/, ''), type: 'airport', time: atd || etd })
  if (atd) phases.push({ label: 'DEPARTED', type: 'event', time: atd })
  else if (etd) phases.push({ label: 'ETD', type: 'estimate', time: etd })

  if (flight.flight_status && flight.flight_status !== 'FILED' && flight.flight_status !== 'COMPLETED') {
    phases.push({ label: flight.flight_status, type: 'status' })
  }

  if (ata) phases.push({ label: 'ARRIVED', type: 'event', time: ata })
  else if (eta) phases.push({ label: 'ETA', type: 'estimate', time: eta })
  if (flight.arr_arpt) phases.push({ label: flight.arr_arpt.replace(/^K/, ''), type: 'airport', time: ata || eta })

  return (
    <div className="h-full flex flex-col bg-bg1">
      {/* Flight header */}
      <div className="flex items-center gap-2 px-2 py-1 bg-bg2 border-b border-border shrink-0">
        <span className="text-acc font-bold text-[11px]">{flight.acid}</span>
        <span className={clsx('text-[9px] font-bold', STATUS_TEXT[flight.flight_status] || 'text-fg3')}>{flight.flight_status}</span>
        <span className="text-fg2 text-[9px]">{flight.dep_arpt || '?'} → {flight.arr_arpt || '?'}</span>
        {flight.aircraft_type && <span className="text-fg3 text-[8px]">{flight.aircraft_type}</span>}
        {flight.beacon_code && <span className="text-fg3 text-[8px]">sq:{flight.beacon_code}</span>}
      </div>

      {/* Timeline visualization */}
      <div className="px-3 py-2 shrink-0">
        <div className="relative flex items-center h-8">
          {/* Track line */}
          <div className="absolute inset-x-0 top-1/2 h-px bg-border2" />

          {/* Phase dots */}
          {phases.map((p, i) => (
            <div
              key={i}
              className="relative flex-1 flex flex-col items-center"
              title={p.time ? `${p.label} ${p.time}` : p.label}
            >
              <div className={clsx(
                'w-2.5 h-2.5 rounded-full border z-10',
                p.type === 'airport' ? 'bg-acc border-acc' :
                p.type === 'event' ? 'bg-grn border-grn' :
                p.type === 'status' ? clsx(STATUS_COLORS[p.label] || 'bg-fg3', 'border-current') :
                'bg-bg2 border-border2'
              )} />
              <span className={clsx(
                'text-[7px] mt-0.5 whitespace-nowrap',
                p.type === 'airport' ? 'text-acc font-bold' :
                p.type === 'event' ? 'text-grn' :
                p.type === 'status' ? (STATUS_TEXT[p.label] || 'text-fg3') :
                'text-fg3'
              )}>
                {p.label}
              </span>
              {p.time && <span className="text-[7px] text-fg3/60">{p.time}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Detail fields */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[9px]">
          <Field label="callsign" value={flight.acid} color="text-acc" />
          <Field label="GUFI" value={flight.gufi} />
          <Field label="departure" value={flight.dep_arpt} color="text-acc" />
          <Field label="arrival" value={flight.arr_arpt} color="text-acc" />
          <Field label="ETD" value={etd} />
          <Field label="ETA" value={eta} />
          <Field label="ATD" value={atd} color="text-grn" />
          <Field label="ATA" value={ata} color="text-grn" />
          <Field label="altitude" value={fmtAlt(flight.altitude)} color="text-cyn" />
          <Field label="reported alt" value={fmtAlt(flight.reported_alt)} color="text-cyn" />
          <Field label="speed" value={flight.speed ? `${flight.speed}kt` : null} />
          <Field label="beacon" value={flight.beacon_code} />
          <Field label="type" value={flight.aircraft_type} />
          <Field label="position" value={flight.lat != null ? `${flight.lat.toFixed(3)}, ${flight.lon.toFixed(3)}` : null} />
        </div>
        {flight.route && (
          <div className="mt-1 pt-1 border-t border-white/5">
            <span className="text-[8px] text-fg3">route: </span>
            <span className="text-[8px] text-fg2 break-all">{flight.route}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, color }) {
  if (!value) return (
    <div className="flex justify-between">
      <span className="text-fg3/40">{label}</span>
      <span className="text-fg3/30">—</span>
    </div>
  )
  return (
    <div className="flex justify-between">
      <span className="text-fg3">{label}</span>
      <span className={color || 'text-fg2'}>{value}</span>
    </div>
  )
}
