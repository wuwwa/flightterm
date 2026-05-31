import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'

// Cold-start feedback for SWIM-backed panels. The SWIM worker scales to zero and
// takes a moment to wake and connect its FAA feeds; this surfaces that progress
// in the terminal's own voice (blinking cursor + terse status, n/5 feed counter)
// so an empty panel reads as "spinning up" rather than "no data" / "broken".
//
//   <SwimWarming />                       // full centered block for empty panels
//   <SwimWarming inline />                // compact status for panel headers
//   <SwimWarming fallback={<…/>} />       // shown once feeds are live
//
// Renders `fallback` (default null) when feeds are live, so callers can drop it
// straight into their existing empty branch.
export default function SwimWarming({ inline = false, fallback = null, className }) {
  const swim = useSwim()
  // No provider, or already live → defer to the panel's own empty state.
  if (!swim || !swim.warming) return fallback

  const { warmupPhase, feedsConnected, feedsTotal, warmupLabel } = swim
  const tint = warmupPhase === 'waking' ? 'text-ylw' : 'text-acc'
  const cursor = <span className={clsx('animate-blink', tint)}>▮</span>

  // Once connecting, show a terse "n/5" feed counter rather than a progress bar.
  const counter = warmupPhase !== 'waking' && feedsTotal > 0
    ? ` ${feedsConnected}/${feedsTotal}`
    : ''

  if (inline) {
    return (
      <span className={clsx('inline-flex items-center gap-1 text-fg3/70 text-[9px]', className)}>
        {cursor}{warmupLabel}{counter && <span className="tabular-nums">{counter}</span>}
      </span>
    )
  }

  return (
    <div
      className={clsx('flex-1 flex items-center justify-center gap-1.5 py-6 px-4 text-fg3 text-[10px]', className)}
      role="status"
      aria-live="polite"
    >
      {cursor}
      <span>{warmupLabel}{counter && <span className="tabular-nums">{counter}</span>}</span>
    </div>
  )
}
