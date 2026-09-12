const { parseRoute, resolveWaypoint } = require('./route-parser')

function timestamp(value) {
  if (!value) return NaN
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z')
}

// Only a recent, active plan matched to this aircraft's current callsign is usable.
// Resolved fixes are a route sketch, not a reconstruction of airways or procedures.
function filedRoute(plan, callsign, sampledAt) {
  const at = timestamp(sampledAt)
  const updated = timestamp(plan?.updated_at)
  if (!plan || !callsign || plan.acid !== callsign.toUpperCase()
    || !Number.isFinite(at) || !Number.isFinite(updated)
    || at - updated > 2 * 3600000 || updated - at > 60000
    || plan.ata || /arriv|land|cancel|complet/i.test(plan.flight_status || '')) return null
  const origin = resolveWaypoint(plan.dep_arpt)
  const destination = resolveWaypoint(plan.arr_arpt)
  if (!origin || !destination) return null
  const fixes = parseRoute(plan.route)
    .filter(p => p.name !== origin.name && p.name !== destination.name)
  return {
    label: fixes.length ? 'Filed fixes' : 'Destination estimate',
    origin: plan.dep_arpt, destination: plan.arr_arpt,
    points: [origin, ...fixes, destination],
    updatedAt: plan.updated_at,
  }
}

module.exports = { filedRoute }
