import { useEffect, useRef, useState, useCallback } from 'react'
import clsx from 'clsx'

const TYPE_CLASS = {
  ok: 'text-grn',
  info: 'text-acc',
  warn: 'text-ylw',
  err: 'text-red',
  '': 'text-fg2',
}

const MIN_HEIGHT = 36
const MAX_HEIGHT = 400
const DEFAULT_HEIGHT = 104

export default function LogPanel({ entries }) {
  const ref = useRef(null)
  const [mountedAt] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState(true)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  useEffect(() => {
    if (ref.current && !collapsed) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [entries, collapsed])

  const onMouseDown = useCallback(
    (e) => {
      if (collapsed) return
      e.preventDefault()
      dragging.current = true
      startY.current = e.clientY
      startH.current = height
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [height, collapsed]
  )

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return
      const delta = e.clientY - startY.current
      setHeight(
        Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH.current + delta))
      )
    }

    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null
  const errCount = entries.filter(e => e.type === 'err').length
  const warnCount = entries.filter(e => e.type === 'warn').length

  // Collapsed: single thin bar showing last message + expand button
  if (collapsed) {
    return (
      <div
        className="bg-bg border-b border-border py-0.5 px-2.5 flex items-center gap-2 text-[10px] cursor-pointer hover:bg-bg1 transition-colors"
        onClick={() => setCollapsed(false)}
      >
        <span className="text-fg3 shrink-0">log</span>
        {errCount > 0 && <span className="text-red shrink-0">{errCount} err</span>}
        {warnCount > 0 && <span className="text-ylw shrink-0">{warnCount} warn</span>}
        <span className="text-fg3 shrink-0">·</span>
        {lastEntry ? (
          <>
            <span className="text-fg3 shrink-0">{lastEntry.time}</span>
            <span className={clsx('truncate', TYPE_CLASS[lastEntry.type] || TYPE_CLASS[''])}>
              {lastEntry.msg}
            </span>
          </>
        ) : (
          <span className="text-fg3">no messages</span>
        )}
        <span className="ml-auto text-fg3 shrink-0">▼</span>
      </div>
    )
  }

  // Expanded: full log panel with resize handle
  return (
    <div className="relative shrink-0">
      <div
        className="bg-bg border-b border-border py-0.5 px-2.5 flex items-center gap-2 text-[10px] cursor-pointer hover:bg-bg1 transition-colors"
        onClick={() => setCollapsed(true)}
      >
        <span className="text-fg3">log</span>
        <span className="text-fg3">{entries.length} messages</span>
        {errCount > 0 && <span className="text-red">{errCount} err</span>}
        {warnCount > 0 && <span className="text-ylw">{warnCount} warn</span>}
        <span className="ml-auto text-fg3">▲</span>
      </div>
      <div
        className="bg-bg overflow-y-auto py-1 px-2.5 text-[11px]"
        style={{ height }}
        ref={ref}
      >
        {entries.map((e, i) => (
          <div
            key={`${e.ts}-${i}`}
            className={clsx(
              'flex gap-2',
              e.ts > mountedAt && 'animate-log-flash'
            )}
          >
            <span className="min-w-14.5 text-fg3 shrink-0">{e.time}</span>
            <span className={TYPE_CLASS[e.type] || TYPE_CLASS['']}>
              {e.msg}
            </span>
          </div>
        ))}
      </div>
      {/* drag handle */}
      <div
        className="h-1 cursor-row-resize bg-border hover:bg-acc/30 active:bg-acc/50 transition-colors"
        onMouseDown={onMouseDown}
      />
    </div>
  )
}
