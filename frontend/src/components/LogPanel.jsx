import { useEffect, useRef } from 'react'

const TYPE_COLOR = {
  ok:   'var(--grn)',
  info: 'var(--acc)',
  warn: 'var(--ylw)',
  err:  'var(--red)',
  '':   'var(--fg2)',
}

const s = {
  panel: {
    background: 'var(--bg)',
    borderBottom: '1px solid var(--border)',
    height: '72px',
    overflowY: 'auto',
    padding: '4px 10px',
    fontSize: '11px',
    flexShrink: 0,
  },
  line: { display: 'flex', gap: '8px' },
  time: { minWidth: '58px', color: 'var(--fg3)', flexShrink: 0 },
}

export default function LogPanel({ entries }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [entries])

  return (
    <div style={s.panel} ref={ref}>
      {entries.map((e, i) => (
        <div key={i} style={s.line}>
          <span style={s.time}>{e.time}</span>
          <span style={{ color: TYPE_COLOR[e.type] || TYPE_COLOR[''] }}>{e.msg}</span>
        </div>
      ))}
    </div>
  )
}
