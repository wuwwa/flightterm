import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { fetchCosts, fetchKeyStatus, fetchUsage } from '../services/aeroapi'
import { testAdsbfi } from '../services/adsbfi'
import { formatLocalDateTime, formatLocalTime, localTimeZone } from '../utils/time'
import Loading from './Loading'

const MONTHLY_CREDIT = 5

function SourceRow({ name, description, configured, provenance, action, statusLabel }) {
  const resolvedStatus = statusLabel || (configured == null ? 'Not checked' : configured ? 'Configured' : 'Not configured')
  return (
    <div className="data-source-row">
      <div>
        <strong>{name}</strong>
        <span>{description}</span>
      </div>
      <span className="data-source-row__provenance">{provenance}</span>
      <span className={clsx('data-source-row__state', configured === true && 'is-live', configured === false && 'is-offline')}>
        {resolvedStatus}
      </span>
      {action || <span />}
    </div>
  )
}

export default function DataAccountPanel({ settings, backendOk, onSave, onClose }) {
  const [local, setLocal] = useState({ ...settings })
  const [keys, setKeys] = useState(null)
  const [usage, setUsage] = useState(null)
  const [costs, setCosts] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastChecked, setLastChecked] = useState(null)
  const [adsbfiState, setAdsbfiState] = useState('idle')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const panelRef = useRef(null)
  const returnFocusRef = useRef(null)
  const requestRef = useRef(0)

  const dirty = useMemo(() => JSON.stringify(local) !== JSON.stringify(settings), [local, settings])
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const set = (key, value) => {
    setConfirmDiscard(false)
    setLocal(previous => ({ ...previous, [key]: value }))
  }
  const setCredential = (key, value) => {
    // A configured provider credential may be rotated by replacing the field,
    // but never cleared from the normal UI. This avoids silently disabling a
    // live provider when an account sheet is saved.
    if (settings[key] && !value.trim()) return
    set(key, value)
  }
  const requestClose = useCallback(() => {
    if (dirtyRef.current) { setConfirmDiscard(true); return }
    onClose()
  }, [onClose])

  const load = async () => {
    const requestId = ++requestRef.current
    if (!backendOk) {
      setError('Backend unavailable. Source health and usage cannot be checked.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const [keyResult, usageResult, costResult] = await Promise.allSettled([
      fetchKeyStatus(),
      fetchUsage(),
      fetchCosts(),
    ])
    if (requestRef.current !== requestId) return
    if (keyResult.status === 'fulfilled') setKeys(keyResult.value)
    if (usageResult.status === 'fulfilled') setUsage(usageResult.value)
    if (costResult.status === 'fulfilled') setCosts(costResult.value)
    const failures = [keyResult, usageResult, costResult].filter(result => result.status === 'rejected').length
    setError(failures ? `${failures} data source${failures === 1 ? '' : 's'} could not be checked. Available results are shown.` : null)
    setLastChecked(Date.now())
    setLoading(false)
  }

  useEffect(() => {
    load()
    return () => { requestRef.current += 1 }
  }, [backendOk])

  useEffect(() => {
    returnFocusRef.current = document.activeElement
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () => Array.from(panelRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') || [])
    requestAnimationFrame(() => panelRef.current?.querySelector('.data-account__close')?.focus())
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); requestClose(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus() }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = priorOverflow
      returnFocusRef.current?.focus?.()
    }
  }, [requestClose])

  const testCommunityFeed = async () => {
    setAdsbfiState('testing')
    try {
      await testAdsbfi()
      setAdsbfiState('live')
    } catch {
      setAdsbfiState('error')
    }
  }

  const used = usage?.total_cost ?? null
  const remaining = used == null ? null : Math.max(0, MONTHLY_CREDIT - used)
  const budgetRatio = used == null ? 0 : Math.min(100, (used / MONTHLY_CREDIT) * 100)
  const personalOpenSky = Boolean(local.userOsClientId && local.userOsClientSecret)
  const personalAero = Boolean(local.userAeroKey)
  const archive = keys?.s3_archive

  return (
    <div className="data-account-overlay">
      <button className="data-account-overlay__backdrop" onClick={requestClose} aria-label="Close Data and account" />
      <aside ref={panelRef} className="data-account" role="dialog" aria-modal="true" aria-labelledby="data-account-title">
        <header className="data-account__header">
          <div>
            <span>Utilities</span>
            <h1 id="data-account-title">Data &amp; account</h1>
          </div>
          <div className="data-account__header-actions">
            {lastChecked && <span>Checked {formatLocalTime(lastChecked)}</span>}
            <button onClick={load} disabled={loading || !backendOk}>{loading ? 'Checking…' : 'Check now'}</button>
            <button className="data-account__close" onClick={requestClose} aria-label="Close Data and account">✕</button>
          </div>
        </header>

        <div className="data-account__body">
          {error && <div className="data-account__notice" role="status">{error}</div>}
          {confirmDiscard && (
            <div className="data-account__discard" role="alert">
              <span>Discard unsaved credential changes?</span>
              <div>
                <button onClick={() => setConfirmDiscard(false)}>Keep editing</button>
                <button onClick={onClose}>Discard</button>
              </div>
            </div>
          )}

          <section className="data-account__section" aria-labelledby="source-health-title">
            <div className="data-account__section-heading">
              <h2 id="source-health-title">Source health</h2>
              <span>Credential provenance and current availability</span>
            </div>
            {!keys && loading ? <Loading label="Checking data sources" /> : (
              <div className="data-source-list">
                <SourceRow name="OpenSky" description="Primary aircraft state vectors" configured={personalOpenSky ? true : keys ? Boolean(keys.opensky_id && keys.opensky_secret) : null} provenance={personalOpenSky ? 'Personal credential' : !keys ? 'Status unavailable' : keys.opensky_id && keys.opensky_secret ? 'Server credential' : 'No credential'} />
                <SourceRow name="AeroAPI" description="Optional paid flight lifecycle records" configured={personalAero ? true : keys ? Boolean(keys.aeroapi) : null} provenance={personalAero ? 'Personal credential' : !keys ? 'Status unavailable' : keys.aeroapi ? 'Server credential' : 'No credential'} />
                <SourceRow
                  name="ADS-B.fi"
                  description="Community aircraft enrichment"
                  configured={adsbfiState === 'live' ? true : adsbfiState === 'error' ? false : null}
                  provenance="Community feed"
                  statusLabel={adsbfiState === 'testing' ? 'Checking…' : adsbfiState === 'live' ? 'Verified live' : adsbfiState === 'error' ? 'Check failed' : 'Available on demand'}
                  action={<button onClick={testCommunityFeed} disabled={adsbfiState === 'testing'}>Test</button>}
                />
                <SourceRow name="FAA NOTAM" description="Restriction and airport notice source" configured={keys ? Boolean(keys.faa_notam) : null} provenance={!keys ? 'Status unavailable' : keys.faa_notam ? 'Server credential' : 'No server credential'} />
                <SourceRow name="Archive" description="Long-term observation storage" configured={keys ? Boolean(archive?.enabled) : null} provenance={!keys ? 'Status unavailable' : archive?.enabled ? 'Server managed' : 'Disabled'} />
              </div>
            )}
          </section>

          <section className="data-account__section" aria-labelledby="budget-title">
            <div className="data-account__section-heading">
              <h2 id="budget-title">Budget &amp; usage</h2>
              <span>AeroAPI monthly account usage</span>
            </div>
            {usage ? (
              <>
                <div className="data-budget">
                  <div className="data-budget__lead">
                    <strong>${used.toFixed(2)} used</strong>
                    <span>/ ${MONTHLY_CREDIT.toFixed(2)} monthly credit</span>
                    <small>${remaining.toFixed(2)} remaining</small>
                  </div>
                  <div className="data-budget__meter" aria-label={`${budgetRatio.toFixed(0)} percent of monthly credit used`}><span style={{ width: `${budgetRatio}%` }} /></div>
                  <dl>
                    <div><dt>Calls</dt><dd>{usage.total_calls?.toLocaleString() ?? '—'}</dd></div>
                    <div><dt>Failures</dt><dd className={(usage.total_failed_calls || 0) > 0 ? 'text-ylw' : ''}>{usage.total_failed_calls?.toLocaleString() ?? '—'}</dd></div>
                    <div><dt>Successful</dt><dd>{usage.total_successful_calls?.toLocaleString() ?? '—'}</dd></div>
                  </dl>
                </div>
                <details className="data-account__disclosure">
                  <summary>View endpoint detail</summary>
                  <div className="data-account__table-wrap">
                    <table>
                      <thead><tr><th>Endpoint</th><th>Calls</th><th>Failures</th><th>Cost</th></tr></thead>
                      <tbody>
                        {(usage.resource_details || []).slice().sort((a, b) => (b.resource_cost || 0) - (a.resource_cost || 0)).map(detail => (
                          <tr key={detail.operation}><td>{detail.operation}</td><td>{detail.total_resource_calls}</td><td>{detail.failed_resource_calls}</td><td>${(detail.resource_cost || 0).toFixed(3)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : loading ? <Loading label="Loading account usage" /> : <p className="data-account__empty">Usage has not been verified.</p>}
          </section>

          <section className="data-account__section" aria-labelledby="time-display-title">
            <div className="data-account__section-heading">
              <h2 id="time-display-title">Time display</h2>
              <span>Used across flight, airport, and NAS views</span>
            </div>
            <div className="time-preference">
              <div>
                <strong>{local.timeMode === 'utc' ? 'UTC' : 'Local time'}</strong>
                <span>{local.timeMode === 'utc' ? 'Coordinated Universal Time' : localTimeZone()}</span>
              </div>
              <div className="time-preference__choices" role="group" aria-label="Time display preference">
                <button className={clsx(local.timeMode !== 'utc' && 'is-selected')} onClick={() => set('timeMode', 'local')} aria-pressed={local.timeMode !== 'utc'}>Local time</button>
                <button className={clsx(local.timeMode === 'utc' && 'is-selected')} onClick={() => set('timeMode', 'utc')} aria-pressed={local.timeMode === 'utc'}>UTC</button>
              </div>
            </div>
          </section>

          <details className="data-account__disclosure data-account__section">
            <summary>Personal credentials <span>{personalOpenSky || personalAero ? 'Overrides active' : 'Using server defaults'}</span></summary>
            <div className="data-credentials">
              <p>Personal credentials override server defaults and are stored only in this browser. Configured credentials can be replaced, but not cleared here.</p>
              <label htmlFor="data-os-id">OpenSky client ID</label>
              <input id="data-os-id" value={local.userOsClientId} onChange={event => setCredential('userOsClientId', event.target.value)} autoComplete="off" />
              <label htmlFor="data-os-secret">OpenSky client secret</label>
              <input id="data-os-secret" type="password" value={local.userOsClientSecret} onChange={event => setCredential('userOsClientSecret', event.target.value)} autoComplete="off" />
              <label htmlFor="data-aero-key">AeroAPI key</label>
              <input id="data-aero-key" type="password" value={local.userAeroKey} onChange={event => setCredential('userAeroKey', event.target.value)} autoComplete="off" />
            </div>
          </details>

          <details className="data-account__disclosure data-account__section">
            <summary>Archive &amp; diagnostics</summary>
            <dl className="data-diagnostics">
              <div><dt>Archive state</dt><dd>{!keys ? 'Not checked' : archive?.enabled ? 'Enabled' : 'Disabled'}</dd></div>
              <div><dt>Last run</dt><dd>{!keys ? 'Not checked' : archive?.lastRun ? formatLocalDateTime(archive.lastRun) : 'No completed run'}</dd></div>
              <div><dt>Rows archived</dt><dd>{archive?.totalArchived?.toLocaleString() ?? '—'}</dd></div>
              <div><dt>Failures</dt><dd>{archive?.totalFailures?.toLocaleString() ?? '—'}</dd></div>
              {archive?.lastError && <div className="is-error"><dt>Last error</dt><dd>{archive.lastError}</dd></div>}
              {costs && <div><dt>Published endpoint prices</dt><dd>{Object.keys(costs).length}</dd></div>}
            </dl>
          </details>
        </div>

        <footer className="data-account__footer">
          <span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>
          <button onClick={requestClose}>Close</button>
          <button className="is-primary" disabled={!dirty} onClick={() => onSave(local)}>Save changes</button>
        </footer>
      </aside>
    </div>
  )
}
