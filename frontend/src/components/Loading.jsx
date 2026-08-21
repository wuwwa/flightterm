import clsx from 'clsx'
import PulseMark from './PulseMark'

// Loading uses the same telemetry pulse as feed state, instead of a generic
// spinner or a text cursor. Keeps copy terse and motion local to active work.
//
//   <Loading label="warming up" />   // centered, fills its container
//   <Loading inline />               // pulse only, for header chips
//
export default function Loading({ label = 'loading', inline = false, color = 'fg3', className }) {
  const mark = <PulseMark state="loading" tone={color} />

  if (inline) {
    return <span className={clsx('inline-flex items-center', className)} aria-label={label}>{mark}</span>
  }

  return (
    <div
      className={clsx('flex-1 flex items-center justify-center gap-1.5 py-6 text-fg3 text-[10px]', className)}
      role="status"
      aria-live="polite"
    >
      {mark}
      {label && <span>{label}…</span>}
    </div>
  )
}
