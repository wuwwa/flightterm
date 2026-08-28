import { useSwim } from '../contexts/SwimContext'
import PulseMark from './PulseMark'

export default function NasPanel({ backendOk }) {
  const { status, nasSummary, wakeSwim, wakeState, availability } = useSwim()
  const workerConnected = Boolean(status?.workerConnected)
  const wakeBusy = ['starting', 'cooldown'].includes(wakeState?.state)
  const groundStops = nasSummary?.groundStops || status?.tfms?.active_gs || 0
  const delayPrograms = nasSummary?.gdps || status?.tfms?.active_gdps || 0
  const tfrs = status?.notams?.active_tfrs || 0
  const congestion = nasSummary?.congestionBuilding || 0
  // Keep the last verified NAS summary visible while a live feed reconnects.
  // A worker reconnect is transient; hiding all known values makes it look
  // like the NAS itself has gone offline.
  const verified = Boolean(!availability?.fastError && (nasSummary || status?.tfms || status?.notams))
  const shown = value => verified ? value : '—'
  const feedState = availability?.fastError
    ? 'Feeds delayed'
    : workerConnected
      ? null
      : backendOk
        ? 'Restoring live feeds'
        : 'Backend unavailable'
  const stateLabel = feedState || (!verified ? (backendOk ? 'Verification pending' : 'Data unavailable') : null)

  return (
    <section className="nas-impact-strip" aria-labelledby="nas-impact-title" data-testid="faa-swim-panel">
      <div className="nas-impact-strip__title">
        <PulseMark
          state={workerConnected ? 'live' : backendOk ? 'loading' : 'offline'}
          tone={workerConnected ? 'grn' : backendOk ? 'ylw' : 'red'}
        />
        <div>
          <h1 id="nas-impact-title">National airspace</h1>
          {stateLabel && <p>{stateLabel}</p>}
        </div>
      </div>

      <dl className="nas-impact-strip__counts">
        <div className={groundStops > 0 ? 'is-critical' : ''}><dt>Ground stops</dt><dd>{shown(groundStops)}</dd></div>
        <div className={delayPrograms > 0 ? 'is-caution' : ''}><dt>Delay programs</dt><dd>{shown(delayPrograms)}</dd></div>
        <div className={tfrs > 0 ? 'is-critical' : ''}><dt>Active TFRs</dt><dd>{shown(tfrs)}</dd></div>
        <div className={congestion > 0 ? 'is-caution' : ''}><dt>Congestion</dt><dd>{shown(congestion)}</dd></div>
      </dl>

      {backendOk && !workerConnected && (
        <button
          className="nas-impact-strip__action"
          onClick={() => { if (!wakeBusy) wakeSwim().catch(() => {}) }}
          disabled={wakeBusy}
        >
          {wakeBusy ? 'Connecting…' : 'Reconnect'}
        </button>
      )}
    </section>
  )
}
