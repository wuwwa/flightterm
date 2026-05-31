import clsx from 'clsx'

// Cold-start loading affordance in the terminal's own idiom: a blinking block
// cursor (▮) — the same pattern HeatMap already uses ("▮ searching…") — instead
// of a generic bouncing-dot spinner. Keeps copy terse and lowercase to match the
// rest of the UI.
//
//   <Loading label="warming up" />   // centered, fills its container
//   <Loading inline />               // cursor only, for header chips
//
// `color` tints the cursor via a theme text token.
const CURSOR = {
  acc: 'text-acc',
  grn: 'text-grn',
  ylw: 'text-ylw',
  red: 'text-red',
  mag: 'text-mag',
  fg3: 'text-fg3',
}

export default function Loading({ label = 'loading', inline = false, color = 'fg3', className }) {
  const tint = CURSOR[color] || CURSOR.fg3
  const cursor = <span className={clsx('animate-blink', tint)}>▮</span>

  if (inline) {
    return <span className={clsx('inline-flex items-center', className)} aria-label={label}>{cursor}</span>
  }

  return (
    <div
      className={clsx('flex-1 flex items-center justify-center gap-1.5 py-6 text-fg3 text-[10px]', className)}
      role="status"
      aria-live="polite"
    >
      {cursor}
      {label && <span>{label}…</span>}
    </div>
  )
}
