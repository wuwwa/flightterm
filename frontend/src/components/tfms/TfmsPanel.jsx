import { useState } from 'react'
import AirportBoard from './AirportBoard'

export default function TfmsPanel({ backendOk }) {
  const [selectedAirport, setSelectedAirport] = useState(() => {
    try { return localStorage.getItem('ft_airport') || 'KJFK' } catch { return 'KJFK' }
  })

  const setAirport = (icao) => {
    setSelectedAirport(icao)
    try { localStorage.setItem('ft_airport', icao) } catch {}
  }

  return (
    <section className="airport-operations" aria-label="Selected-airport operations" data-testid="airport-ops-panel">
      <div className="airport-operations__board">
        <AirportBoard backendOk={backendOk} airport={selectedAirport} onAirportChange={setAirport} />
      </div>
    </section>
  )
}
