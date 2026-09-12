import { useState } from 'react'
import { activityPlot } from '../utils/privateActivityChart'

function clock(at) {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
}

export default function PrivateActivityChart({ samples, selectedIndex, onSelect }) {
  const [hovered, setHovered] = useState(null)
  const { points, gaps, ceiling, start, end } = activityPlot(samples)
  if (!points.length) return null
  const active = hovered ?? selectedIndex ?? points.at(-1).index
  return (
    <div className="private-activity" role="group" aria-label="Observed aircraft over time">
      <span className="private-activity__scale">{ceiling}</span>
      <span className="private-activity__zero">0</span>
      <div className="private-activity__plot">
        <div className="private-activity__grid" aria-hidden="true" />
        {gaps.map((gap, i) => <div key={i} className="private-activity__gap" aria-hidden="true"
          style={{ left: `${gap.left}%`, width: `${gap.width}%` }} />)}
        {points.map(point => {
          const label = `${clock(point.at)} UTC, ${point.count} aircraft observed`
          const Tag = onSelect ? 'button' : 'div'
          return <Tag key={point.at} className={`private-activity__sample${active === point.index ? ' is-active' : ''}`}
            style={{ left: `${point.x}%`, '--bar-height': `${point.height}%` }}
            type={onSelect ? 'button' : undefined} role={onSelect ? undefined : 'img'}
            tabIndex={onSelect ? undefined : 0} aria-label={label}
            aria-pressed={onSelect ? selectedIndex === point.index : undefined} title={label}
            onClick={onSelect ? () => onSelect(point.index) : undefined}
            onMouseEnter={() => setHovered(point.index)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(point.index)} onBlur={() => setHovered(null)}>
            <span className="private-activity__bar" aria-hidden="true"><span>{point.count}</span></span>
          </Tag>
        })}
      </div>
      <div className={`private-activity__times${start === end ? ' is-single' : ''}`} aria-hidden="true">
        <time dateTime={new Date(start).toISOString()}>{clock(start)}</time>
        {end !== start && <time dateTime={new Date(end).toISOString()}>{clock(end)}</time>}
      </div>
    </div>
  )
}
