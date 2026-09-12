export function activityPlot(samples) {
  const valid = samples.map((sample, index) => ({
    index, at: Date.parse(sample.sampledAt), count: sample.airborneCount,
  })).filter(p => Number.isFinite(p.at) && p.count != null && Number.isFinite(Number(p.count)) && Number(p.count) >= 0)
    .map(p => ({ ...p, count: Number(p.count) }))
    .sort((a, b) => a.at - b.at)
  if (!valid.length) return { points: [], gaps: [], ceiling: 5 }
  const start = valid[0].at, end = valid.at(-1).at
  const ceiling = Math.max(5, Math.ceil(Math.max(...valid.map(p => p.count)) / 5) * 5)
  const points = valid.map(p => ({ ...p, x: end === start ? 50 : (p.at - start) / (end - start) * 100, height: p.count / ceiling * 100 }))
  const gaps = points.slice(1).flatMap((p, i) => p.at - points[i].at > 45 * 60000
    ? [{ left: points[i].x, width: p.x - points[i].x }] : [])
  return { points, gaps, ceiling, start, end }
}
