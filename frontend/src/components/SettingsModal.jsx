import { useState } from 'react'
import { testAdsbxKey } from '../services/adsbx'

const s = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
    zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  box: {
    background: 'var(--bg1)', border: '1px solid var(--border2)',
    width: '480px', maxWidth: '95vw', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column',
  },
  head: {
    background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
    padding: '6px 12px', display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', fontSize: '11px', color: 'var(--fg2)', flexShrink: 0,
  },
  title: { color: 'var(--acc)' },
  body: { padding: '16px', overflowY: 'auto', flex: 1 },
  foot: {
    padding: '10px 16px', borderTop: '1px solid var(--border)',
    display: 'flex', justifyContent: 'flex-end', gap: '8px', flexShrink: 0,
  },
  sec: { marginBottom: '16px' },
  secTitle: {
    color: 'var(--fg3)', fontSize: '10px', letterSpacing: '0.1em',
    borderBottom: '1px solid var(--border)', paddingBottom: '4px', marginBottom: '10px',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' },
  label: { color: 'var(--fg3)', fontSize: '11px' },
  input: {
    background: 'var(--bg)', border: '1px solid var(--border2)',
    color: 'var(--fg)', fontSize: '12px', padding: '5px 8px',
    outline: 'none', width: '100%', fontFamily: 'inherit',
  },
  hint: { color: 'var(--fg3)', fontSize: '10px', lineHeight: 1.6 },
  srcSel: { display: 'flex', gap: '6px' },
  srcOpt: {
    flex: 1, border: '1px solid var(--border2)', padding: '8px',
    cursor: 'pointer', color: 'var(--fg2)', fontSize: '11px',
    textAlign: 'center', background: 'none', fontFamily: 'inherit',
  },
  srcOptActive: { borderColor: 'var(--acc)', color: 'var(--acc)' },
  srcName: { fontSize: '12px', marginBottom: '3px' },
  srcDesc: { fontSize: '10px', color: 'var(--fg3)', lineHeight: 1.4 },
  btn: {
    background: 'none', border: '1px solid var(--border2)', color: 'var(--fg2)',
    fontSize: '11px', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit',
  },
  btnOn: { borderColor: 'var(--grn)', color: 'var(--grn)' },
  btnDanger: { borderColor: 'var(--border)', color: 'var(--red)' },
  closeBtn: {
    background: 'none', border: 'none', color: 'var(--fg3)',
    fontSize: '11px', cursor: 'pointer',
  },
}

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
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.box}>
        <div style={s.head}>
          <span style={s.title}>⚙ settings</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.body}>

          {/* Source selector */}
          <div style={s.sec}>
            <div style={s.secTitle}>live data source</div>
            <div style={s.srcSel}>
              {SOURCE_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  style={{ ...s.srcOpt, ...(local.sourcePref === opt.key ? s.srcOptActive : {}) }}
                  onClick={() => set('sourcePref', opt.key)}
                >
                  <div style={s.srcName}>{opt.name}</div>
                  <div style={s.srcDesc}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ADS-B Exchange */}
          <div style={s.sec}>
            <div style={s.secTitle}>ads-b exchange — rapidapi</div>
            <div style={s.field}>
              <label style={s.label}>x-rapidapi-key</label>
              <input
                type="password" style={s.input}
                value={local.adsbxKey}
                onChange={e => set('adsbxKey', e.target.value)}
                placeholder="paste key here"
              />
              <span style={s.hint}>
                subscribe at rapidapi.com/adsbx/api/adsbexchange-com1
                <br />~$10/mo · 10,000 req/month · unfiltered incl. military
              </span>
            </div>
            <div style={s.field}>
              <label style={s.label}>search radius (nm, 1–100)</label>
              <input
                type="number" style={s.input} min={1} max={100}
                value={local.adsbxRadius}
                onChange={e => set('adsbxRadius', Math.min(100, Math.max(1, Number(e.target.value))))}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button style={s.btn} onClick={handleTest} disabled={testing}>
                {testing ? 'testing...' : 'test connection'}
              </button>
              {testResult && (
                <span style={{ fontSize: '11px', color: testResult.ok ? 'var(--grn)' : 'var(--red)' }}>
                  {testResult.msg}
                </span>
              )}
            </div>
          </div>

          {/* OpenSky */}
          <div style={s.sec}>
            <div style={s.secTitle}>opensky network — oauth2</div>
            <div style={{ ...s.hint, padding: '8px', border: '1px solid var(--border)' }}>
              credentials are stored in <span style={{ color: 'var(--ylw)' }}>backend/.env</span> as{' '}
              <span style={{ color: 'var(--ylw)' }}>OS_CLIENT_ID</span> and{' '}
              <span style={{ color: 'var(--ylw)' }}>OS_CLIENT_SECRET</span>
              <br />create a client at opensky-network.org → account → API clients
              <br />authenticated: 4,000 credits/day · anonymous: 400 credits/day
            </div>
          </div>

          {/* AeroAPI — key lives in backend .env, reminder only */}
          <div style={s.sec}>
            <div style={s.secTitle}>flightaware aeroapi</div>
            <div style={s.hint} style={{ ...s.hint, padding: '8px', border: '1px solid var(--border)', color: 'var(--fg3)' }}>
              the aeroapi key is stored in <span style={{ color: 'var(--ylw)' }}>backend/.env</span> as{' '}
              <span style={{ color: 'var(--ylw)' }}>AEROAPI_KEY=your_key_here</span>
              <br />it never touches the browser — this is intentional (no CORS issues, no key exposure).
              <br />restart the backend after changing it.
            </div>
          </div>

          {/* Behaviour */}
          <div style={s.sec}>
            <div style={s.secTitle}>behaviour</div>
            <div style={s.field}>
              <label style={s.label}>auto-refresh interval (seconds, min 15)</label>
              <input
                type="number" style={s.input} min={15} max={300}
                value={local.interval}
                onChange={e => set('interval', Math.max(15, Number(e.target.value)))}
              />
            </div>
          </div>

        </div>

        <div style={s.foot}>
          <button style={{ ...s.btn, ...s.btnDanger }} onClick={onClose}>cancel</button>
          <button style={{ ...s.btn, ...s.btnOn }} onClick={() => onSave(local)}>save & close</button>
        </div>
      </div>
    </div>
  )
}
