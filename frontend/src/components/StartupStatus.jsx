import PulseMark from './PulseMark'
// Service availability belongs in a compact status strip. Startup mechanics and
// dependent-feed progress are operational internals, not workspace content.
export default function StartupStatus({ phase, backendOk, onRetry }) {
  if (backendOk) return null
  const unavailable = phase === 'offline'
  return (
    <section className="startup-status" aria-label="Service status" aria-live="polite">
      <PulseMark state={unavailable ? 'offline' : 'loading'} tone={unavailable ? 'ylw' : 'acc'} />
      <strong>{unavailable ? 'Service unavailable' : 'Connecting to Flightterm'}</strong>
      {unavailable && <button type="button" className="startup-status__retry" onClick={onRetry}>Retry</button>}
    </section>
  )
}
