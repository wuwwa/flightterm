import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchSigmets, fetchPireps } from '../../services/weather'
import Loading from '../Loading'

const REGIONS = {
  usa:      { bbox: [24, -125, 49.5, -66] },
  europe:   { bbox: [35, -10, 71, 40] },
  asia:     { bbox: [10, 70, 55, 145] },
  atlantic: { bbox: [10, -70, 60, -10] },
  global:   { bbox: [-90, -180, 90, 180] },
}

export default function HazardsPanel({ backendOk, region = 'usa' }) {
  const [sigmets, setSigmets] = useState([])
  const [pireps, setPireps] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    const bbox = REGIONS[region]?.bbox || REGIONS.usa.bbox
    setLoaded(false)

    Promise.allSettled([
      fetchSigmets('conv').catch(() => []),
      fetchPireps(bbox, 2, 'mod').catch(() => []),
    ]).then(([sigR, pirR]) => {
      if (cancelled) return
      if (sigR.status === 'fulfilled') setSigmets(Array.isArray(sigR.value) ? sigR.value : [])
      if (pirR.status === 'fulfilled') setPireps(Array.isArray(pirR.value) ? pirR.value : [])
      setLoaded(true)
    })

    const id = setInterval(() => {
      Promise.allSettled([
        fetchSigmets('conv').catch(() => []),
        fetchPireps(bbox, 2, 'mod').catch(() => []),
      ]).then(([sigR, pirR]) => {
        if (cancelled) return
        if (sigR.status === 'fulfilled') setSigmets(Array.isArray(sigR.value) ? sigR.value : [])
        if (pirR.status === 'fulfilled') setPireps(Array.isArray(pirR.value) ? pirR.value : [])
      })
    }, 60_000)

    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk, region])

  const convSigmets = sigmets.filter(s => s.hazard === 'CONVECTIVE' || s.hazard === 'conv')
  const turbSigmets = sigmets.filter(s => s.hazard === 'TURB' || s.hazard === 'turbulence')
  const iceSigmets = sigmets.filter(s => s.hazard === 'ICE' || s.hazard === 'icing')
  const sevPireps = pireps.filter(p => p.intensity === 'SEV' || p.intensity === 'EXTREME')
  const modPireps = pireps.filter(p => p.intensity === 'MOD')

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="text-fg3">SIGMETs & PIREPs</span>
        <span className="text-fg3/50">{sigmets.length + pireps.length}</span>
      </div>

      {/* Summary */}
      <div className="px-2 py-0.5 flex gap-2 text-[9px] flex-wrap border-b border-white/5 shrink-0">
        {convSigmets.length > 0 && <span className="text-red font-bold">{convSigmets.length} convective</span>}
        {turbSigmets.length > 0 && <span className="text-ylw">{turbSigmets.length} turbulence</span>}
        {iceSigmets.length > 0 && <span className="text-cyn">{iceSigmets.length} icing</span>}
        {sevPireps.length > 0 && <span className="text-red">{sevPireps.length} severe PIREP</span>}
        {modPireps.length > 0 && <span className="text-ylw">{modPireps.length} moderate PIREP</span>}
        {loaded
          ? (sigmets.length === 0 && pireps.length === 0 && <span className="text-grn">no hazards</span>)
          : <span className="text-fg3/50">checking…</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loaded && sigmets.length === 0 && pireps.length === 0 && (
          <Loading label="scanning hazards" color="ylw" />
        )}
        {sigmets.slice(0, 10).map((s, i) => (
          <div key={s.id || i} className={clsx('flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3',
            s.hazard === 'CONVECTIVE' || s.hazard === 'conv' ? 'bg-red/3' : ''
          )}>
            <span className={clsx('font-bold shrink-0 w-8',
              s.hazard === 'CONVECTIVE' || s.hazard === 'conv' ? 'text-red' : s.hazard === 'TURB' ? 'text-ylw' : 'text-cyn'
            )}>SIGMET</span>
            <span className="text-fg2 truncate flex-1">{s.rawSigmet?.substring(0, 60) || s.hazard || '—'}</span>
          </div>
        ))}
        {pireps.slice(0, 10).map((p, i) => (
          <div key={p.id || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3">
            <span className={clsx('font-bold shrink-0 w-8', p.intensity === 'SEV' ? 'text-red' : 'text-ylw')}>PIREP</span>
            <span className="text-fg2 truncate flex-1">{p.rawOb?.substring(0, 60) || `${p.intensity} ${p.wxString || ''}` || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
