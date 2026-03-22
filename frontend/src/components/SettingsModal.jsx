import { useState } from 'react'
import clsx from 'clsx'
import { testAdsbxKey } from '../services/adsbx'

const SOURCE_OPTIONS = [
  { key: 'auto',    name: 'auto',          desc: 'use adsbx if key\nset, else opensky' },
  { key: 'opensky', name: 'opensky only',  desc: 'free · no key\nrate limited (anon)' },
  { key: 'adsbx',   name: 'adsbx only',   desc: 'requires key\nunfiltered · ~$10/mo' },
]

export default function SettingsModal({ settings, onSave, onClose }) {
  const [local, setLocal] = useState({ ...settings })
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)

  const set = (key, val) => setLocal(prev => ({ ...prev, [key]: val }))

  const handleTest = async () => {
    if (!local.adsbxKey) { setTestResult({ ok: false, msg: 'no key entered' }); return }
    setTesting(true); setTestResult(null)
    try {
      await testAdsbxKey(local.adsbxKey)
      setTestResult({ ok: true, msg: '✓ connection ok' })
    } catch {
      setTestResult({ ok: false, msg: '✗ connection failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/72 z-100 flex items-center justify-center" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-bg1 border border-border2 w-120 max-w-[95vw] max-h-[90vh] flex flex-col">
        <div className="bg-bg2 border-b border-border py-1.5 px-3 flex justify-between items-center text-[11px] text-fg2 shrink-0">
          <span className="text-acc">⚙ settings</span>
          <button className="bg-transparent border-none text-fg3 text-[11px] cursor-pointer" onClick={onClose}>✕</button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">

          {/* Source selector */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">live data source</div>
            <div className="flex gap-1.5">
              {SOURCE_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  className={clsx(
                    'flex-1 border py-2 px-2 cursor-pointer text-[11px] text-center bg-transparent font-mono',
                    local.sourcePref === opt.key ? 'border-acc text-acc' : 'border-border2 text-fg2'
                  )}
                  onClick={() => set('sourcePref', opt.key)}
                >
                  <div className="text-xs mb-0.5">{opt.name}</div>
                  <div className="text-[10px] text-fg3 leading-snug">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ADS-B Exchange */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">ads-b exchange — rapidapi</div>
            <div className="flex flex-col gap-1 mb-2.5">
              <label className="text-fg3 text-[11px]">x-rapidapi-key</label>
              <input
                type="password"
                className="bg-bg border border-border2 text-fg text-xs py-1.5 px-2 outline-none w-full font-mono"
                value={local.adsbxKey}
                onChange={e => set('adsbxKey', e.target.value)}
                placeholder="paste key here"
              />
              <span className="text-fg3 text-[10px] leading-relaxed">
                subscribe at rapidapi.com/adsbx/api/adsbexchange-com1
                <br />~$10/mo · 10,000 req/month · unfiltered incl. military
              </span>
            </div>
            <div className="flex flex-col gap-1 mb-2.5">
              <label className="text-fg3 text-[11px]">search radius (nm, 1–100)</label>
              <input
                type="number"
                className="bg-bg border border-border2 text-fg text-xs py-1.5 px-2 outline-none w-full font-mono"
                min={1} max={100}
                value={local.adsbxRadius}
                onChange={e => set('adsbxRadius', Math.min(100, Math.max(1, Number(e.target.value))))}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                className="bg-transparent border border-border2 text-fg2 text-[11px] py-0.5 px-2 cursor-pointer font-mono"
                onClick={handleTest}
                disabled={testing}
              >
                {testing ? 'testing...' : 'test connection'}
              </button>
              {testResult && (
                <span className={clsx('text-[11px]', testResult.ok ? 'text-grn' : 'text-red')}>
                  {testResult.msg}
                </span>
              )}
            </div>
          </div>

          {/* OpenSky */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">opensky network — oauth2</div>
            <div className="text-fg3 text-[10px] leading-relaxed p-2 border border-border">
              credentials are stored in <span className="text-ylw">backend/.env</span> as{' '}
              <span className="text-ylw">OS_CLIENT_ID</span> and{' '}
              <span className="text-ylw">OS_CLIENT_SECRET</span>
              <br />create a client at opensky-network.org → account → API clients
              <br />authenticated: 4,000 credits/day · anonymous: 400 credits/day
            </div>
          </div>

          {/* AeroAPI */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">flightaware aeroapi</div>
            <div className="text-fg3 text-[10px] leading-relaxed p-2 border border-border">
              the aeroapi key is stored in <span className="text-ylw">backend/.env</span> as{' '}
              <span className="text-ylw">AEROAPI_KEY=your_key_here</span>
              <br />it never touches the browser — this is intentional (no CORS issues, no key exposure).
              <br />restart the backend after changing it.
            </div>
          </div>

          {/* Behaviour */}
          <div className="mb-4">
            <div className="text-fg3 text-[10px] tracking-widest border-b border-border pb-1 mb-2.5">behaviour</div>
            <div className="flex flex-col gap-1 mb-2.5">
              <label className="text-fg3 text-[11px]">auto-refresh interval (seconds, min 15)</label>
              <input
                type="number"
                className="bg-bg border border-border2 text-fg text-xs py-1.5 px-2 outline-none w-full font-mono"
                min={15} max={300}
                value={local.interval}
                onChange={e => set('interval', Math.max(15, Number(e.target.value)))}
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
