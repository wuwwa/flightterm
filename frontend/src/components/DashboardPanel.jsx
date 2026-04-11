import NasMap from './dashboard/NasMap'

export default function DashboardPanel({ backendOk, flights, trackedIcaos, trackHistory }) {
  return (
    <div className="bg-bg1 border-t-2 border-acc/40">
      <NasMap backendOk={backendOk} flights={flights} trackedIcaos={trackedIcaos} trackHistory={trackHistory} />
    </div>
  )
}
