import clsx from 'clsx'

// A source-coverage mark, not a loader: a continuous telemetry path means the
// source is present; a broken path means it is unavailable. The label supplies
// the source name and accessible state.
export default function DataLinkMark({ state = 'available', className }) {
  return <span className={clsx('data-link-mark', `is-${state}`, className)} aria-hidden="true" />
}
