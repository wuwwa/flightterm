const RAD = Math.PI / 180
const EARTH_NM = 3440.065

export function validPoint(p) {
  return p && p.lat != null && p.lon != null && Number.isFinite(Number(p.lat))
    && Number.isFinite(Number(p.lon)) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180
}

function distance(a, b) {
  const h = Math.sin((b.lat - a.lat) * RAD / 2) ** 2
    + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lon - a.lon) * RAD / 2) ** 2
  return 2 * EARTH_NM * Math.asin(Math.sqrt(Math.min(1, h)))
}

// Keep longitude continuous across the date line instead of drawing around Earth.
export function mapLine(points, anchorLon) {
  let previous = anchorLon ?? points[0]?.lon
  return points.map(p => {
    let lon = Number(p.lon)
    while (lon - previous > 180) lon -= 360
    while (lon - previous < -180) lon += 360
    previous = lon
    return [Number(p.lat), lon]
  })
}

export function routePath(points, anchorLon) {
  const dense = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1]
    if (!validPoint(a) || !validPoint(b)) return []
    const angular = distance(a, b) / EARTH_NM
    if (angular < 1e-8) continue
    if (Math.abs(Math.sin(angular)) < 1e-8) return []
    const steps = Math.max(1, Math.ceil(angular / RAD))
    for (let j = 0; j < steps; j++) {
      const f = j / steps
      const left = Math.sin((1 - f) * angular) / Math.sin(angular)
      const right = Math.sin(f * angular) / Math.sin(angular)
      const x = left * Math.cos(a.lat * RAD) * Math.cos(a.lon * RAD) + right * Math.cos(b.lat * RAD) * Math.cos(b.lon * RAD)
      const y = left * Math.cos(a.lat * RAD) * Math.sin(a.lon * RAD) + right * Math.cos(b.lat * RAD) * Math.sin(b.lon * RAD)
      const z = left * Math.sin(a.lat * RAD) + right * Math.sin(b.lat * RAD)
      dense.push({ lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD })
    }
  }
  if (points.length) dense.push(points.at(-1))
  return mapLine(dense, anchorLon)
}

export function observedPaths(points, sampledAt, maxGapMinutes = 20) {
  const end = Date.parse(sampledAt)
  const sorted = points.filter(p => validPoint(p) && Number.isFinite(Date.parse(p.sampledAt))
    && Date.parse(p.sampledAt) <= end && end - Date.parse(p.sampledAt) <= 12 * 3600000)
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt))
    .filter((p, i, all) => i === all.length - 1 || p.sampledAt !== all[i + 1].sampledAt)
  let segments = [], segment = [], previous = null
  for (const p of sorted) {
    const gap = previous ? (Date.parse(p.sampledAt) - Date.parse(previous.sampledAt)) / 60000 : 0
    if (p.grounded || gap > 90) { segments = []; segment = []; previous = null }
    if (p.grounded) continue
    const jump = previous && gap > 0 && distance(previous, p) / (gap / 60) > 1000
    if (gap > maxGapMinutes || jump) { if (segment.length > 1) segments.push(segment); segment = [] }
    segment.push(p)
    previous = p
  }
  if (segment.length > 1) segments.push(segment)
  return segments.map(points => mapLine(points, sorted.at(-1)?.lon))
}

export function projectedPath(position, minutes = 10) {
  if (!validPoint(position) || position.heading == null || position.speedKt == null
    || !Number.isFinite(Number(position.heading)) || !Number.isFinite(Number(position.speedKt))
    || position.speedKt <= 0 || position.speedKt > 1000) return []
  const lat = position.lat * RAD, lon = position.lon * RAD, heading = position.heading * RAD
  const points = Array.from({ length: 21 }, (_, i) => {
    const d = position.speedKt * minutes / 60 * i / 20 / EARTH_NM
    const phi = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(heading))
    const lambda = lon + Math.atan2(Math.sin(heading) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(phi))
    return { lat: phi / RAD, lon: ((lambda / RAD + 540) % 360) - 180 }
  })
  return mapLine(points, position.lon)
}
