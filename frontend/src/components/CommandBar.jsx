import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'

const VIEWS = [
  ['flights', 'Flights'],
  ['airports', 'NAS'],
  ['private', 'Private'],
]

export default function CommandBar({
  activeView,
  onViewChange,
}) {
  const { status: swimStatus } = useSwim()
  const tfms = swimStatus?.tfms
  const notams = swimStatus?.notams
  const activeImpacts = (tfms?.active_gs || 0) + (tfms?.active_gdps || 0) + (notams?.active_tfrs || 0)
  return (
    <header className="masthead">
      <button
        type="button"
        className="masthead__brand"
        onClick={() => onViewChange('flights')}
        aria-label="Flightterm: return to Flights"
      >
        <span className="masthead__wordmark">FLIGHTTERM</span>
      </button>

      <nav className="masthead__views" aria-label="Primary workspaces">
        {VIEWS.map(([value, label]) => {
          const impactLabel = value === 'airports' && activeImpacts > 0
            ? `${activeImpacts} active NAS impact${activeImpacts === 1 ? '' : 's'}`
            : null
          return (
            <button
              key={value}
              className={clsx('masthead__view', activeView === value && 'is-active')}
              onClick={() => onViewChange(value)}
              aria-current={activeView === value ? 'page' : undefined}
              aria-label={impactLabel ? `${label}, ${impactLabel}` : undefined}
            >
              <span>{label}</span>
              {impactLabel && <span className="masthead__view-badge" aria-hidden="true">{activeImpacts}</span>}
            </button>
          )
        })}
      </nav>

    </header>
  )
}
