import { useState, useEffect } from 'react'
import clsx from 'clsx'
import axios from 'axios'
import Loading from '../Loading'

export default function TopTraffic({ backendOk }) {
  const [aircraft, setAircraft] = useState([])
  const [countries, setCountries] = useState([])
  const [routeCount, setRouteCount] = useState(null)
  const [tab, setTab] = useState('aircraft')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false

    Promise.all([
      axios.get('/api/sightings/top/aircraft', { params: { limit: 10 } }).then(r => r.data).catch(() => []),
      axios.get('/api/sightings/top/countries', { params: { limit: 10 } }).then(r => r.data).catch(() => []),
      axios.get('/api/routes/stats').then(r => r.data).catch(() => null),
    ]).then(([ac, co, rt]) => {
      if (cancelled) return
      setAircraft(ac)
      setCountries(co)
      setRouteCount(rt?.total ?? null)
      setLoaded(true)
    })

    const id = setInterval(() => {
      Promise.all([
        axios.get('/api/sightings/top/aircraft', { params: { limit: 10 } }).then(r => r.data).catch(() => []),
        axios.get('/api/sightings/top/countries', { params: { limit: 10 } }).then(r => r.data).catch(() => []),
        axios.get('/api/routes/stats').then(r => r.data).catch(() => null),
      ]).then(([ac, co, rt]) => {
        if (cancelled) return
        setAircraft(ac)
        setCountries(co)
        setRouteCount(rt?.total ?? null)
      })
    }, 60_000)

    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const maxAc = aircraft[0]?.times_seen || 1
  const maxCo = countries[0]?.unique_aircraft || 1

  return (
    <div className="bg-bg1">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex items-center gap-2">
        <button
          onClick={() => setTab('aircraft')}
          className={clsx('hover:text-acc transition-colors', tab === 'aircraft' ? 'text-acc font-bold' : 'text-fg3')}
        >
          top aircraft
        </button>
        <button
          onClick={() => setTab('countries')}
          className={clsx('hover:text-acc transition-colors', tab === 'countries' ? 'text-acc font-bold' : 'text-fg3')}
        >
          countries
        </button>
        {routeCount != null && (
          <span className="ml-auto text-mag">{routeCount.toLocaleString()} routes cached</span>
        )}
      </div>

      {tab === 'aircraft' && (
        <div className="max-h-[200px] overflow-y-auto">
          {!loaded ? (
            <Loading label="tallying traffic" />
          ) : aircraft.length === 0 ? (
            <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">no data yet</div>
          ) : aircraft.map((ac, i) => (
            <div key={ac.icao} className="flex items-center gap-1.5 py-0.5 px-2.5 text-[10px] border-b border-white/3 group">
              <span className="text-fg3 w-3 text-right shrink-0">{i + 1}</span>
              <span className="text-acc font-bold w-16 shrink-0">{ac.icao}</span>
              <span className="text-ylw w-16 shrink-0 truncate">{ac.callsign || '—'}</span>
              <div className="flex-1 h-1 bg-bg2 rounded overflow-hidden">
                <div
                  className="h-full bg-acc/40 rounded"
                  style={{ width: `${(ac.times_seen / maxAc) * 100}%` }}
                />
              </div>
              <span className="text-fg3 text-[9px] w-10 text-right shrink-0">{ac.times_seen}x</span>
              {ac.country && (
                <span className="text-fg3 text-[9px] w-6 shrink-0">{ac.country}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'countries' && (
        <div className="max-h-[200px] overflow-y-auto">
          {!loaded ? (
            <Loading label="tallying countries" />
          ) : countries.length === 0 ? (
            <div className="py-3 px-2.5 text-center text-fg3 text-[10px]">no data yet</div>
          ) : countries.map((co, i) => (
            <div key={co.country} className="flex items-center gap-1.5 py-0.5 px-2.5 text-[10px] border-b border-white/3">
              <span className="text-fg3 w-3 text-right shrink-0">{i + 1}</span>
              <span className="text-acc font-bold w-14 shrink-0">{co.country}</span>
              <div className="flex-1 h-1 bg-bg2 rounded overflow-hidden">
                <div
                  className="h-full bg-mag/40 rounded"
                  style={{ width: `${(co.unique_aircraft / maxCo) * 100}%` }}
                />
              </div>
              <span className="text-fg3 text-[9px] shrink-0">{co.unique_aircraft} aircraft · {co.sightings.toLocaleString()} sightings</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
