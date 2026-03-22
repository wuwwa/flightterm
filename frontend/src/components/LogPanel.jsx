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
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [entries])

  const onMouseDown = useCallback(
    (e) => {
      e.preventDefault()
      dragging.current = true
      startY.current = e.clientY
      startH.current = height
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [height]
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

  return (
    <div className="relative shrink-0">
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
