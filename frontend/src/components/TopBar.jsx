import { useState, useEffect } from 'react'

const styles = {
  bar: {
    background: 'var(--bg2)',
    borderBottom: '1px solid var(--border)',
    padding: '3px 10px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflowX: 'auto',
    gap: '4px',
    fontSize: '11px',
    color: 'var(--fg2)',
    flexShrink: 0,
  },
  left: { display: 'flex', gap: '14px', alignItems: 'center', flexShrink: 0 },
  right: { display: 'flex', gap: '10px', alignItems: 'center' },
  brand: { color: 'var(--acc)' },
  sep: { color: 'var(--border2)' },
  val: { color: 'var(--fg)' },
  ok: { color: 'var(--grn)' },
  warn: { color: 'var(--ylw)' },
  blink: { animation: 'blink .9s step-end infinite', color: 'var(--grn)' },
}

const BADGE_STYLES = {
  opensky:  { color: 'var(--grn)', border: '1px solid var(--grn)', padding: '1px 5px', fontSize: '10px' },
  adsbx:    { color: 'var(--acc)', border: '1px solid var(--acc)', padding: '1px 5px', fontSize: '10px' },
  fallback: { color: 'var(--ylw)', border: '1px solid var(--ylw)', padding: '1px 5px', fontSize: '10px' },
}

function fmtElapsed(ms) {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m ago`
}

export default function TopBar({ stats, source, backendOk, autoOn, lastFetchAt }) {
  const [time, setTime] = useState('')
  const [elapsed, setElapsed] = useState(null)

  useEffect(() => {
    const tick = () => {
      setTime(new Date().toISOString().substring(11, 19) + ' utc')
      if (lastFetchAt) setElapsed(Date.now() - lastFetchAt)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastFetchAt])

  const badge = BADGE_STYLES[source] || BADGE_STYLES.opensky

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <span style={styles.brand}>flightterm</span>
        <span style={styles.sep}>|</span>
        <span>aircraft: <span style={styles.val}>{stats.total ?? '--'}</span></span>
        <span>airborne: <span style={styles.ok}>{stats.airborne ?? '--'}</span></span>
        <span>grounded: <span style={styles.warn}>{stats.grounded ?? '--'}</span></span>
        <span>region: <span style={styles.val}>{stats.region ?? 'global'}</span></span>
        <span>enriched: <span style={styles.val}>{stats.enriched ?? 0}</span></span>
      </div>
      <div style={styles.right}>
        {stats.lastUpdate && (
          <span style={{ color: 'var(--fg3)' }}>updated {stats.lastUpdate}</span>
        )}
        <span style={styles.sep}>|</span>
        <span style={badge}>{source}</span>
        <span style={styles.sep}>|</span>
        <span style={{ fontSize: '10px', color: backendOk ? 'var(--grn)' : 'var(--red)' }}>
          {backendOk ? '● backend' : '○ backend'}
        </span>
        <span style={styles.sep}>|</span>
        {autoOn ? (
          <span style={styles.blink}>● live</span>
        ) : (
          <span style={{ fontSize: '10px', color: 'var(--fg3)' }}>
            {elapsed != null ? fmtElapsed(elapsed) : '○ idle'}
          </span>
        )}
        <span style={styles.sep}>|</span>
        <span style={{ color: 'var(--fg2)' }}>{time}</span>
      </div>
    </div>
  )
}
