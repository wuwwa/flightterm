import { useState, useEffect } from 'react'
import { fetchUsage, fetchCosts } from '../services/aeroapi'

const s = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
    zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  box: {
    background: 'var(--bg1)', border: '1px solid var(--border2)',
    width: '600px', maxWidth: '95vw', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column',
  },
  head: {
    background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
    padding: '6px 12px', display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', fontSize: '11px', color: 'var(--fg2)', flexShrink: 0,
  },
  title: { color: 'var(--acc)' },
  body: { padding: '0', overflowY: 'auto', flex: 1 },
  closeBtn: {
    background: 'none', border: 'none', color: 'var(--fg3)',
    fontSize: '11px', cursor: 'pointer',
  },
  sec: {
    padding: '5px 12px 3px', fontSize: '10px', color: 'var(--fg3)',
    background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
    letterSpacing: '0.08em',
  },
  summaryGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '1px', background: 'var(--border)', margin: '1px 0',
  },
  summaryCell: {
    background: 'var(--bg1)', padding: '10px 12px',
    display: 'flex', flexDirection: 'column', gap: '4px',
  },
  bigNum: { fontSize: '20px', color: 'var(--acc)', fontWeight: 500 },
  smallLabel: { fontSize: '10px', color: 'var(--fg3)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
  th: {
    padding: '4px 12px', textAlign: 'left', color: 'var(--fg3)',
    fontWeight: 400, background: 'var(--bg2)',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  thR: {
    padding: '4px 12px', textAlign: 'right', color: 'var(--fg3)',
    fontWeight: 400, background: 'var(--bg2)',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  td: {
    padding: '3px 12px', borderBottom: '1px solid rgba(255,255,255,0.025)',
    color: 'var(--fg2)',
  },
  tdR: {
    padding: '3px 12px', borderBottom: '1px solid rgba(255,255,255,0.025)',
    color: 'var(--fg2)', textAlign: 'right',
  },
  noKey: { padding: '24px', textAlign: 'center', color: 'var(--fg3)', fontSize: '11px' },
  refreshBtn: {
    background: 'none', border: '1px solid var(--border2)', color: 'var(--fg2)',
    fontSize: '11px', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit',
  },
  info: {
    margin: '8px 12px', padding: '6px 10px', fontSize: '10px',
    color: 'var(--acc)', background: 'rgba(129,162,190,0.08)',
    borderLeft: '2px solid var(--acc)',
  },
}

const FREE_CREDIT = 5.00

export default function UsagePanel({ onClose, backendOk }) {
  const [usage, setUsage]     = useState(null)
  const [costs, setCosts]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [tab, setTab]         = useState('usage') // 'usage' | 'costs'

  const load = async () => {
    if (!backendOk) return
    setLoading(true)
    setError(null)
    try {
      const [u, c] = await Promise.all([fetchUsage(), fetchCosts()])
      setUsage(u)
      setCosts(c)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [backendOk])

  const remaining = usage ? Math.max(0, FREE_CREDIT - (usage.total_cost || 0)) : null

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.box}>
        <div style={s.head}>
          <span style={s.title}>$ aeroapi usage & costs</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button style={s.refreshBtn} onClick={load} disabled={loading}>
              {loading ? 'loading...' : '↻ refresh'}
            </button>
            <button style={s.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        <div style={s.body}>
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
            {['usage', 'cost map'].map(t => (
              <button
                key={t}
                onClick={() => setTab(t === 'cost map' ? 'costs' : t)}
                style={{
                  background: 'none', border: 'none', borderBottom: tab === (t === 'cost map' ? 'costs' : t) ? '2px solid var(--acc)' : '2px solid transparent',
                  color: tab === (t === 'cost map' ? 'costs' : t) ? 'var(--acc)' : 'var(--fg3)',
                  padding: '6px 16px', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {!backendOk && (
            <div style={s.noKey}>
              backend offline — start the Express server and ensure AEROAPI_KEY is set in backend/.env
            </div>
          )}

          {backendOk && error && (
            <div style={{ ...s.noKey, color: 'var(--red)' }}>{error}</div>
          )}

          {backendOk && !error && tab === 'usage' && (
            <>
              {/* Summary cards */}
              <div style={{ ...s.sec, marginTop: '1px' }}>this month</div>
              <div style={s.summaryGrid}>
                <div style={s.summaryCell}>
                  <span style={s.bigNum}>{usage?.total_calls ?? '—'}</span>
                  <span style={s.smallLabel}>total calls</span>
                </div>
                <div style={s.summaryCell}>
                  <span style={{ ...s.bigNum, color: 'var(--red)' }}>
                    ${(usage?.total_cost ?? 0).toFixed(4)}
                  </span>
                  <span style={s.smallLabel}>total cost</span>
                </div>
                <div style={s.summaryCell}>
                  <span style={{ ...s.bigNum, color: remaining != null && remaining < 1 ? 'var(--red)' : 'var(--grn)' }}>
                    ${remaining != null ? remaining.toFixed(4) : '—'}
                  </span>
                  <span style={s.smallLabel}>free credit remaining</span>
                </div>
              </div>

              <div style={s.summaryGrid}>
                <div style={s.summaryCell}>
                  <span style={{ ...s.bigNum, color: 'var(--grn)' }}>{usage?.total_successful_calls ?? '—'}</span>
                  <span style={s.smallLabel}>successful calls</span>
                </div>
                <div style={s.summaryCell}>
                  <span style={{ ...s.bigNum, color: 'var(--red)' }}>{usage?.total_failed_calls ?? '—'}</span>
                  <span style={s.smallLabel}>failed calls</span>
                </div>
                <div style={s.summaryCell}>
                  <span style={{ ...s.bigNum, color: 'var(--fg2)' }}>{usage?.total_pages ?? '—'}</span>
                  <span style={s.smallLabel}>result pages</span>
                </div>
              </div>

              <div style={s.info}>
                data updated every 10 minutes by FlightAware · free tier: $5/mo credit ($10 for ADS-B feeders)
              </div>

              {/* Per-endpoint breakdown */}
              {usage?.resource_details?.length > 0 && (
                <>
                  <div style={s.sec}>breakdown by endpoint</div>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>operation</th>
                        <th style={s.thR}>calls</th>
                        <th style={s.thR}>pages</th>
                        <th style={s.thR}>cost/call</th>
                        <th style={s.thR}>total cost</th>
                        <th style={s.thR}>failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.resource_details
                        .sort((a, b) => (b.resource_cost || 0) - (a.resource_cost || 0))
                        .map((d, i) => (
                          <tr key={i} style={i % 2 === 1 ? { background: 'var(--bg2)' } : {}}>
                            <td style={{ ...s.td, color: 'var(--fg)', fontStyle: 'normal' }}>{d.operation}</td>
                            <td style={s.tdR}>{d.total_resource_calls}</td>
                            <td style={s.tdR}>{d.num_pages}</td>
                            <td style={{ ...s.tdR, color: 'var(--fg3)' }}>
                              {d.unit_cost != null ? `$${d.unit_cost.toFixed(3)}` : '—'}
                            </td>
                            <td style={{ ...s.tdR, color: (d.resource_cost || 0) > 0 ? 'var(--ylw)' : 'var(--fg3)' }}>
                              ${(d.resource_cost || 0).toFixed(4)}
                            </td>
                            <td style={{ ...s.tdR, color: d.failed_resource_calls > 0 ? 'var(--red)' : 'var(--fg3)' }}>
                              {d.failed_resource_calls}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </>
              )}

              {usage && !usage.resource_details?.length && (
                <div style={s.noKey}>no usage data yet — make your first AeroAPI query</div>
              )}
            </>
          )}

          {backendOk && !error && tab === 'costs' && costs && (
            <>
              <div style={s.info}>
                pricing per result set (1 set = up to 15 records) · source: flightaware.com/commercial/aeroapi
              </div>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>endpoint</th>
                    <th style={s.thR}>cost / result set</th>
                    <th style={s.thR}>$5 free buys</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(costs)
                    .sort((a, b) => b[1] - a[1])
                    .map(([endpoint, cost], i) => (
                      <tr key={i} style={i % 2 === 1 ? { background: 'var(--bg2)' } : {}}>
                        <td style={s.td}>{endpoint}</td>
                        <td style={{
                          ...s.tdR,
                          color: cost === 0 ? 'var(--grn)' : cost >= 0.1 ? 'var(--red)' : cost >= 0.05 ? 'var(--ylw)' : 'var(--fg2)'
                        }}>
                          {cost === 0 ? 'free' : `$${cost.toFixed(3)}`}
                        </td>
                        <td style={{ ...s.tdR, color: 'var(--fg3)' }}>
                          {cost === 0 ? '∞' : `~${Math.floor(FREE_CREDIT / cost).toLocaleString()}`}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
