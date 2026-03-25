import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { fetchSigmets, fetchPireps, summarizePireps, summarizeSigmets } from '../../services/weather'

const REGIONS = {
  usa:      { bbox: [24, -125, 49.5, -66], label: 'CONUS' },
  europe:   { bbox: [35, -10, 71, 40], label: 'Europe' },
  asia:     { bbox: [10, 70, 55, 145], label: 'Asia' },
  atlantic: { bbox: [10, -70, 60, -10], label: 'Atlantic' },
}

export default function WeatherStatus({ region = 'usa', backendOk }) {
  const [sigmets, setSigmets] = useState(null)
  const [pireps, setPireps] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    setLoading(true)

    const r = REGIONS[region] || REGIONS.usa
    Promise.all([
      fetchSigmets().catch(() => []),
      fetchPireps(r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3], { age: 2, inten: 'mod' }).catch(() => []),
    ]).then(([sigs, pirs]) => {
      if (cancelled) return
      setSigmets(summarizeSigmets(sigs))
      setPireps(summarizePireps(pirs))
      setLoading(false)
    })

    // Refresh every 5 min
    const id = setInterval(() => {
      Promise.all([
        fetchSigmets().catch(() => []),
        fetchPireps(r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3], { age: 2, inten: 'mod' }).catch(() => []),
      ]).then(([sigs, pirs]) => {
        if (cancelled) return
        setSigmets(summarizeSigmets(sigs))
        setPireps(summarizePireps(pirs))
      })
    }, 300_000)

    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk, region])

  return (
    <div className="bg-bg1">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between">
        <span>weather hazards</span>
        <span>{REGIONS[region]?.label || region} · aviationweather.gov</span>
      </div>

      {loading && !sigmets && (
        <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">loading weather data...</div>
      )}

      {sigmets && (
        <div className="px-2.5 py-1.5">
          {/* SIGMET summary */}
          <div className="flex gap-3 text-[10px] mb-1.5">
            <span className="text-fg3">SIGMETs:</span>
            {sigmets.count === 0 ? (
              <span className="text-grn">none active</span>
            ) : (
              <>
                {sigmets.convective > 0 && (
                  <span className="text-red font-bold">convective: {sigmets.convective}</span>
                )}
                {sigmets.turbulence > 0 && (
                  <span className="text-ylw">turbulence: {sigmets.turbulence}</span>
                )}
                {sigmets.icing > 0 && (
                  <span className="text-cyn">icing: {sigmets.icing}</span>
                )}
              </>
            )}
          </div>

          {/* PIREP summary */}
          <div className="flex gap-3 text-[10px]">
            <span className="text-fg3">PIREPs:</span>
            {!pireps || pireps.count === 0 ? (
              <span className="text-grn">no moderate+ reports</span>
            ) : (
              <>
                <span className={clsx(pireps.severe ? 'text-red font-bold' : 'text-ylw')}>
                  {pireps.count} report{pireps.count !== 1 ? 's' : ''}
                </span>
                {pireps.maxTurbulence && (
                  <span className="text-ylw">turb: {pireps.maxTurbulence}</span>
                )}
                {pireps.maxIcing && (
                  <span className="text-cyn">ice: {pireps.maxIcing}</span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Active SIGMET details */}
      {sigmets?.items?.length > 0 && (
        <div className="border-t border-border max-h-24 overflow-y-auto">
          {sigmets.items.map((s, i) => (
            <div key={i} className="flex gap-2 py-0.5 px-2.5 text-[9px] border-b border-white/3">
              <span className={clsx(
                'shrink-0 font-bold',
                s.hazard === 'CONVECTIVE' ? 'text-red' : s.hazard === 'TURB' ? 'text-ylw' : 'text-cyn'
              )}>
                {s.type}
              </span>
              <span className="text-fg2">{s.hazard}</span>
              <span className="text-fg3 ml-auto">
                valid {new Date(s.validTo * 1000).toISOString().substring(11, 16)}z
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
