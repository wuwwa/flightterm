import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchUsage, fetchCosts } from '../services/aeroapi'

const FREE_CREDIT = 5.00

export default function UsagePanel({ onClose, backendOk }) {
  const [usage, setUsage]     = useState(null)
  const [costs, setCosts]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [tab, setTab]         = useState('usage')

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
    <div className="fixed inset-0 bg-black/72 z-100 flex items-center justify-center" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-bg1 border border-border2 w-150 max-w-[95vw] max-h-[90vh] flex flex-col">
        <div className="bg-bg2 border-b border-border py-1.5 px-3 flex justify-between items-center text-[11px] text-fg2 shrink-0">
          <span className="text-acc">$ aeroapi usage & costs</span>
          <div className="flex gap-2 items-center">
            <button
              className="bg-transparent border border-border2 text-fg2 text-[11px] py-0.5 px-2 cursor-pointer font-mono"
              onClick={load}
              disabled={loading}
            >
              {loading ? 'loading...' : '↻ refresh'}
            </button>
            <button className="bg-transparent border-none text-fg3 text-[11px] cursor-pointer" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Tabs */}
          <div className="flex border-b border-border bg-bg2">
            {['usage', 'cost map'].map(t => {
              const tabKey = t === 'cost map' ? 'costs' : t
              return (
                <button
                  key={t}
                  onClick={() => setTab(tabKey)}
                  className={clsx(
                    'bg-transparent border-none border-b-2 py-1.5 px-4 text-[11px] cursor-pointer font-mono',
                    tab === tabKey ? 'border-b-acc text-acc' : 'border-b-transparent text-fg3'
                  )}
                >
                  {t}
                </button>
              )
            })}
          </div>

          {!backendOk && (
            <div className="p-6 text-center text-fg3 text-[11px]">
              backend offline — start the Express server and ensure AEROAPI_KEY is set in backend/.env
            </div>
          )}

          {backendOk && error && (
            <div className="p-6 text-center text-red text-[11px]">{error}</div>
          )}

          {backendOk && !error && tab === 'usage' && (
            <>
              {/* Summary cards */}
              <div className="py-1.5 px-3 text-[10px] text-fg3 bg-bg2 border-b border-border tracking-wide mt-px">this month</div>
              <div className="grid grid-cols-3 gap-px bg-border my-px">
                <div className="bg-bg1 py-2.5 px-3 flex flex-col gap-1">
                  <span className="text-xl text-acc font-medium">{usage?.total_calls ?? '—'}</span>
                  <span className="text-[10px] text-fg3">total calls</span>
                </div>
                <div className="bg-bg1 py-2.5 px-3 flex flex-col gap-1">
                  <span className="text-xl text-red font-medium">
                    ${(usage?.total_cost ?? 0).toFixed(4)}
                  </span>
                  <span className="text-[10px] text-fg3">total cost</span>
                </div>
                <div className="bg-bg1 py-2.5 px-3 flex flex-col gap-1">
                  <span className={clsx('text-xl font-medium', remaining != null && remaining < 1 ? 'text-red' : 'text-grn')}>
                    ${remaining != null ? remaining.toFixed(4) : '—'}
                  </span>
                  <span className="text-[10px] text-fg3">free credit remaining</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-px bg-border my-px">
                <div className="bg-bg1 py-2.5 px-3 flex flex-col gap-1">
                  <span className="text-xl text-grn font-medium">{usage?.total_successful_calls ?? '—'}</span>
                  <span className="text-[10px] text-fg3">successful calls</span>
                </div>
                <div className="bg-bg1 py-2.5 px-3 flex flex-col gap-1">
                  <span className="text-xl text-red font-medium">{usage?.total_failed_calls ?? '—'}</span>
                  <span className="text-[10px] text-fg3">failed calls</span>
                </div>
                <div className="bg-bg1 py-2.5 px-3 flex flex-col gap-1">
                  <span className="text-xl text-fg2 font-medium">{usage?.total_pages ?? '—'}</span>
                  <span className="text-[10px] text-fg3">result pages</span>
                </div>
              </div>

              <div className="mx-3 my-2 py-1.5 px-2.5 text-[10px] text-acc bg-acc/8 border-l-2 border-l-acc">
                data updated every 10 minutes by FlightAware · free tier: $5/mo credit ($10 for ADS-B feeders)
              </div>

              {/* Per-endpoint breakdown */}
              {usage?.resource_details?.length > 0 && (
                <>
                  <div className="py-1.5 px-3 text-[10px] text-fg3 bg-bg2 border-b border-border tracking-wide">breakdown by endpoint</div>
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr>
                        <th className="py-1 px-3 text-left text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">operation</th>
                        <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">calls</th>
                        <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">pages</th>
                        <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">cost/call</th>
                        <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">total cost</th>
                        <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.resource_details
                        .sort((a, b) => (b.resource_cost || 0) - (a.resource_cost || 0))
                        .map((d, i) => (
                          <tr key={i} className={clsx(i % 2 === 1 && 'bg-bg2')}>
                            <td className="py-0.5 px-3 border-b border-white/3 text-fg">{d.operation}</td>
                            <td className="py-0.5 px-3 border-b border-white/3 text-fg2 text-right">{d.total_resource_calls}</td>
                            <td className="py-0.5 px-3 border-b border-white/3 text-fg2 text-right">{d.num_pages}</td>
                            <td className="py-0.5 px-3 border-b border-white/3 text-fg3 text-right">
                              {d.unit_cost != null ? `$${d.unit_cost.toFixed(3)}` : '—'}
                            </td>
                            <td className={clsx('py-0.5 px-3 border-b border-white/3 text-right', (d.resource_cost || 0) > 0 ? 'text-ylw' : 'text-fg3')}>
                              ${(d.resource_cost || 0).toFixed(4)}
                            </td>
                            <td className={clsx('py-0.5 px-3 border-b border-white/3 text-right', d.failed_resource_calls > 0 ? 'text-red' : 'text-fg3')}>
                              {d.failed_resource_calls}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </>
              )}

              {usage && !usage.resource_details?.length && (
                <div className="p-6 text-center text-fg3 text-[11px]">no usage data yet — make your first AeroAPI query</div>
              )}
            </>
          )}

          {backendOk && !error && tab === 'costs' && costs && (
            <>
              <div className="mx-3 my-2 py-1.5 px-2.5 text-[10px] text-acc bg-acc/8 border-l-2 border-l-acc">
                pricing per result set (1 set = up to 15 records) · source: flightaware.com/commercial/aeroapi
              </div>
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr>
                    <th className="py-1 px-3 text-left text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">endpoint</th>
                    <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">cost / result set</th>
                    <th className="py-1 px-3 text-right text-fg3 font-normal bg-bg2 border-b border-border whitespace-nowrap">$5 free buys</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(costs)
                    .sort((a, b) => b[1] - a[1])
                    .map(([endpoint, cost], i) => (
                      <tr key={i} className={clsx(i % 2 === 1 && 'bg-bg2')}>
                        <td className="py-0.5 px-3 border-b border-white/3 text-fg2">{endpoint}</td>
                        <td className={clsx(
                          'py-0.5 px-3 border-b border-white/3 text-right',
                          cost === 0 ? 'text-grn' : cost >= 0.1 ? 'text-red' : cost >= 0.05 ? 'text-ylw' : 'text-fg2'
                        )}>
                          {cost === 0 ? 'free' : `$${cost.toFixed(3)}`}
                        </td>
                        <td className="py-0.5 px-3 border-b border-white/3 text-fg3 text-right">
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
