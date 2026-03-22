import { useEffect, useRef } from 'react'

const TYPE_CLASS = {
  ok:   'text-grn',
  info: 'text-acc',
  warn: 'text-ylw',
  err:  'text-red',
  '':   'text-fg2',
}

export default function LogPanel({ entries }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [entries])

  return (
    <div className="bg-bg border-b border-border h-18 overflow-y-auto py-1 px-2.5 text-[11px] shrink-0" ref={ref}>
      {entries.map((e, i) => (
        <div key={i} className="flex gap-2">
          <span className="min-w-14.5 text-fg3 shrink-0">{e.time}</span>
          <span className={TYPE_CLASS[e.type] || TYPE_CLASS['']}>{e.msg}</span>
        </div>
      ))}
    </div>
  )
}
