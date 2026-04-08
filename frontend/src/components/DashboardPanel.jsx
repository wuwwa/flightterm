import { Component, useRef, useState, useEffect, lazy, Suspense } from 'react'
import NasMap from './dashboard/NasMap'

const LiveCharts = lazy(() => import('./dashboard/LiveCharts'))

class ChartErrorBoundary extends Component {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) return <div className="px-3 py-2 text-[10px] text-fg3">Charts failed to load — <button className="text-acc underline cursor-pointer" onClick={() => this.setState({ hasError: false })}>retry</button></div>
    return this.props.children
  }
}

function LazyVisible({ children, fallback }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!ref.current) return
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); obs.disconnect() }
    }, { rootMargin: '200px' })
    obs.observe(ref.current)
    return () => obs.disconnect()
  }, [])

  return <div ref={ref}>{visible ? children : fallback}</div>
}

function LoadingDots() {
  return (
    <div className="py-12 flex justify-center gap-1">
      <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '0ms' }} />
      <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '150ms' }} />
      <div className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

export default function DashboardPanel({ backendOk, flights, trackHistory, enrichCache }) {
  return (
    <div className="bg-bg1 border-t-2 border-acc/40">
      {/* US airspace map */}
      <NasMap backendOk={backendOk} />

      {/* Live charts — lazy loaded when scrolled into view */}
      <LazyVisible fallback={<LoadingDots />}>
        <ChartErrorBoundary>
          <Suspense fallback={<LoadingDots />}>
            <LiveCharts flights={flights} trackHistory={trackHistory} enrichCache={enrichCache} />
          </Suspense>
        </ChartErrorBoundary>
      </LazyVisible>
    </div>
  )
}
