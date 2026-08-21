import clsx from 'clsx'

// A compact, in-product state mark: three telemetry samples. The middle sample
// stays tall when a feed is live; loading sweeps a single pulse across the mark.
// It is always paired with visible status text, so the motion is confirmation,
// not the sole carrier of meaning.
export default function PulseMark({ state = 'loading', tone = 'fg3', className }) {
  return (
    <span className={clsx('pulse-mark', `is-${state}`, `pulse-mark--${tone}`, className)} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}
