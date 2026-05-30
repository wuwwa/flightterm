// v5.7.0 — single big NasMap replaced with MapQuadrants (2x2 category grid
// on lg+, single map on mobile). The wrapper div / border styling stays so
// the visual seam below the rest of the page is preserved.
import MapQuadrants from './dashboard/MapQuadrants'

export default function DashboardPanel({ backendOk, flights, trackedIcaos, trackHistory }) {
  return (
    <MapQuadrants backendOk={backendOk} flights={flights} trackedIcaos={trackedIcaos} trackHistory={trackHistory} />
  )
}
