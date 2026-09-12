export const FRESH_MS = 5 * 60_000
export const MAX_GAP_MS = 45 * 60_000

export function sampleState(sampledAt, now = Date.now()) {
  if (!sampledAt) return 'warming'
  const age = now - new Date(sampledAt).getTime()
  return !Number.isFinite(age) ? 'warming' : age > FRESH_MS || age < -60_000 ? 'saved' : 'live'
}

export function sampleAge(sampledAt, now = Date.now()) {
  if (!sampledAt) return 'No sample yet'
  const minutes = Math.max(0, Math.floor((now - new Date(sampledAt).getTime()) / 60_000))
  if (!Number.isFinite(minutes)) return 'Unknown age'
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes} min ago`
  if (minutes < 1440) return `Recorded ${Math.floor(minutes / 60)}h ago`
  return `Recorded ${Math.floor(minutes / 1440)} days ago`
}

export function comparable(previous, current) {
  if (!previous || !current) return false
  const gap = new Date(current.sampledAt) - new Date(previous.sampledAt)
  return gap > 0 && gap <= MAX_GAP_MS && previous.source === current.source && previous.cohortVersion === current.cohortVersion
}

export function segmentedPath(points, x, y, field, maxGapMs = MAX_GAP_MS) {
  let previousAt = null
  let path = ''
  for (const point of points) {
    if (point[field] == null || !Number.isFinite(point.at) || !Number.isFinite(Number(point[field]))) {
      previousAt = null
      continue
    }
    const command = previousAt == null || point.at - previousAt > maxGapMs ? 'M' : 'L'
    path += `${command}${x(point.at).toFixed(1)},${y(Number(point[field])).toFixed(1)} `
    previousAt = point.at
  }
  return path.trim()
}
