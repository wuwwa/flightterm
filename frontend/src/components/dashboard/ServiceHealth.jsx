import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchServiceHealth, fetchArchiveHealth } from '../../services/dashboard'

const LABEL = {
  opensky:          'OpenSky',
  airplaneslive:    'Airplanes.live',
  adsbfi:           'adsb.fi',
  aviationweather:  'AvnWx',
  aeroapi:          'AeroAPI',
  faa_notam:        'FAA NOTAM',
}

const LIMITS = {
  opensky:         '4,000 credits/day (authenticated)',
  airplaneslive:   '1 req/sec · unfiltered · no credits',
  adsbfi:          '1 req/sec (public)',
  aviationweather: '100 req/min',
  aeroapi:         'pay-per-call ($0.005+)',
  faa_notam:       'gov API',
}

export default function ServiceHealth({ backendOk }) {
  const [health, setHealth] = useState(null)
  const [archive, setArchive] = useState(null)
  const [loading, setLoading] = useState(false)

  const refresh = () => {
    if (!backendOk) return
    setLoading(true)
    Promise.all([
      fetchServiceHealth().catch(() => null),
      fetchArchiveHealth().catch(() => null),
    ]).then(([h, a]) => {
      setHealth(h)
      setArchive(a)
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!backendOk) return
    refresh()
    const id = setInterval(refresh, 120_000)
    return () => clearInterval(id)
  }, [backendOk])

  return (
    <div className="bg-bg1">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>service health</span>
        <span>
          {health ? (
            <>
              <span className={health.healthy === health.total ? 'text-grn' : 'text-ylw'}>
                {health.healthy}/{health.total} healthy
              </span>
              {health.cached && <span className="ml-1.5 text-fg3">(cached)</span>}
            </>
          ) : loading ? 'checking...' : 'offline'}
        </span>
      </div>

      {health?.services && (
        <div className="grid grid-cols-2 gap-px p-px">
          {health.services.map((svc) => (
            <div
              key={svc.name}
              className={clsx(
                'px-2 py-1 text-[10px]',
                svc.status === 'ok' ? 'bg-bg1' :
                svc.status === 'unconfigured' ? 'bg-bg1 opacity-50' :
                svc.status === 'unknown' ? 'bg-bg1 opacity-60' :
                'bg-red/8'
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1.5">
                  <span className={clsx(
                    'inline-block w-1.5 h-1.5 rounded-full',
                    svc.status === 'ok' ? 'bg-grn' :
                    svc.status === 'unconfigured' ? 'bg-fg3' :
                    svc.status === 'unknown' ? 'bg-ylw' :
                    'bg-red'
                  )} />
                  <span className="text-fg1 font-bold">{LABEL[svc.name] || svc.name}</span>
                </div>
                {svc.latency != null && svc.status !== 'unconfigured' && (
                  <span className={clsx(
                    'text-[9px]',
                    svc.latency < 500 ? 'text-grn' :
                    svc.latency < 2000 ? 'text-ylw' :
                    'text-red'
                  )}>
                    {svc.latency}ms
                  </span>
                )}
              </div>
              <div className="text-[8px] text-fg3 mt-0.5 truncate">
                {svc.status === 'error' ? svc.error :
                 svc.status === 'unconfigured' ? 'not configured' :
                 svc.status === 'unknown' ? 'awaiting first call' :
                 LIMITS[svc.name] || 'ok'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* S3 archive status */}
      {archive && (
        <div className={clsx(
          'px-2.5 py-1 text-[10px] border-t border-border flex items-center gap-1.5',
          archive.totalFailures > 0 ? 'bg-red/8' : 'bg-bg1'
        )}>
          <span className={clsx(
            'inline-block w-1.5 h-1.5 rounded-full',
            !archive.enabled ? 'bg-fg3' :
            archive.totalFailures > 0 ? 'bg-red' :
            archive.lastSuccess ? 'bg-grn' :
            'bg-ylw'
          )} />
          <span className="text-fg1 font-bold">S3 Archive</span>
          <span className="text-fg3 ml-auto text-[9px] truncate max-w-50">
            {archive.message}
          </span>
        </div>
      )}

      {!health && !loading && (
        <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">
          backend offline — health checks unavailable
        </div>
      )}
    </div>
  )
}
