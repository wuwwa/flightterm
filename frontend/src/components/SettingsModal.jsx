import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { testAdsbfi } from '../services/adsbfi'
import { fetchKeyStatus } from '../services/aeroapi'

function StatusDot({ ok, label }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px]">
      <span className={ok ? 'text-grn' : 'text-fg3'}>{ok ? '●' : '○'}</span>
      <span className={ok ? 'text-grn' : 'text-fg3'}>{label}</span>
    </span>
  )
}

export default function SettingsModal({ settings, onSave, onClose }) {
  const [local, setLocal] = useState({ ...settings })
  const [adsbfiResult, setAdsbfiResult] = useState(null)
  const [testingAdsbfi, setTestingAdsbfi] = useState(false)
  const [serverKeys, setServerKeys] = useState(null)

  useEffect(() => {
    fetchKeyStatus().then(setServerKeys).catch(() => {})
  }, [])

  const set = (key, val) => setLocal(prev => ({ ...prev, [key]: val }))

  const handleTestAdsbfi = async () => {
    setTestingAdsbfi(true); setAdsbfiResult(null)
    try {
      await testAdsbfi()
      setAdsbfiResult({ ok: true, msg: '✓ adsb.fi reachable' })
    } catch {
      setAdsbfiResult({ ok: false, msg: '✗ adsb.fi unreachable' })
    } finally {
      setTestingAdsbfi(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/72 z-100 flex items-center justify-center" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-bg1 border border-border2 w-120 max-w-[95vw] max-h-[90vh] flex flex-col">
        <div className="bg-bg2 border-b border-border py-1.5 px-3 flex justify-between items-center text-[11px] text-fg2 shrink-0">
          <span className="text-acc">settings</span>
          <button className="bg-transparent border-none text-fg3 text-[11px] cursor-pointer" onClick={onClose}>✕</button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">

          {/* API health status */}
          {serverKeys && (
            <div className="mb-4">
              <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">api status</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
                <StatusDot ok={serverKeys.opensky_id && serverKeys.opensky_secret} label="opensky (server)" />
                <StatusDot ok={!!local.userOsClientId && !!local.userOsClientSecret} label="opensky (yours)" />
                <StatusDot ok={serverKeys.aeroapi} label="aeroapi (server)" />
                <StatusDot ok={!!local.userAeroKey} label="aeroapi (yours)" />
                <StatusDot ok={true} label="adsb.fi community feed" />
                <StatusDot ok={serverKeys.faa_notam} label="faa notam (server)" />
                <StatusDot ok={serverKeys.s3_archive?.enabled} label={
                  serverKeys.s3_archive?.enabled
                    ? `s3 archive (${serverKeys.s3_archive.lastResult || 'pending'})`
                    : 's3 archive (off)'
                } />
              </div>
              {serverKeys.s3_archive?.enabled && serverKeys.s3_archive.lastRun && (
                <div className="text-[9px] text-fg3 mt-1.5 px-1">
                  last run: {new Date(serverKeys.s3_archive.lastRun).toLocaleString()}
                  {serverKeys.s3_archive.lastArchived > 0 && ` · ${serverKeys.s3_archive.lastArchived} rows archived`}
                  {serverKeys.s3_archive.totalArchived > 0 && ` · ${serverKeys.s3_archive.totalArchived} total`}
                  {serverKeys.s3_archive.lastError && (
                    <span className="text-red"> · error: {serverKeys.s3_archive.lastError}</span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* adsb.fi enrichment */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">adsb.fi — aircraft enrichment</div>
            <div className="flex items-center gap-2">
              <button
                className="bg-transparent border border-border2 text-fg2 text-[11px] py-0.5 px-2 cursor-pointer font-mono"
                onClick={handleTestAdsbfi}
                disabled={testingAdsbfi}
              >
                {testingAdsbfi ? 'testing...' : 'test connection'}
              </button>
              {adsbfiResult && (
                <span className={clsx('text-[11px]', adsbfiResult.ok ? 'text-grn' : 'text-red')}>
                  {adsbfiResult.msg}
                </span>
              )}
            </div>
          </div>

          {/* User API keys — stored client-side in localStorage */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">your api keys</div>
            <span className="text-fg3 text-[10px] block mb-2">paste your own keys to override the server defaults. stored in your browser only.</span>

            <div className="flex flex-col gap-1 mb-2.5">
              <label className="text-fg3 text-[11px]">opensky client id</label>
              <input
                type="password"
                className="bg-bg border border-border2 text-fg text-xs py-1.5 px-2 outline-none w-full font-mono"
                value={local.userOsClientId}
                onChange={e => set('userOsClientId', e.target.value)}
                placeholder={local.userOsClientId ? '••••••• (set)' : 'optional'}
              />
            </div>
            <div className="flex flex-col gap-1 mb-2.5">
              <label className="text-fg3 text-[11px]">opensky client secret</label>
              <input
                type="password"
                className="bg-bg border border-border2 text-fg text-xs py-1.5 px-2 outline-none w-full font-mono"
                value={local.userOsClientSecret}
                onChange={e => set('userOsClientSecret', e.target.value)}
                placeholder={local.userOsClientSecret ? '••••••• (set)' : 'optional'}
              />
            </div>
            <div className="flex flex-col gap-1 mb-2.5">
              <label className="text-fg3 text-[11px]">flightaware aeroapi key</label>
              <input
                type="password"
                className="bg-bg border border-border2 text-fg text-xs py-1.5 px-2 outline-none w-full font-mono"
                value={local.userAeroKey}
                onChange={e => set('userAeroKey', e.target.value)}
                placeholder={local.userAeroKey ? '••••••• (set)' : 'optional — bypasses $5 cap'}
              />
            </div>
          </div>


        </div>

        <div className="py-2.5 px-4 border-t border-border flex justify-end gap-2 shrink-0">
          <button className="bg-transparent border border-border text-red text-[11px] py-0.5 px-2 cursor-pointer font-mono" onClick={onClose}>cancel</button>
          <button className="bg-transparent border border-grn text-grn text-[11px] py-0.5 px-2 cursor-pointer font-mono" onClick={() => onSave(local)}>save & close</button>
        </div>
      </div>
    </div>
  )
}
