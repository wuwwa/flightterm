import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import clsx from 'clsx'

import CommandBar from './components/CommandBar'
import FlightTable from './components/FlightTable'
import { emptyFilters } from './components/FilterBar'
import InterestingFeed from './components/InterestingFeed'
const FlightDossier = lazy(() => import('./components/FlightDossier'))
const GroupDossier = lazy(() => import('./components/GroupDossier'))
import DataAccountPanel from './components/DataAccountPanel'
import NasPanel from './components/NasPanel'
const TfmsPanel = lazy(() => import('./components/tfms/TfmsPanel'))
const BusinessJetTracker = lazy(() => import('./components/BusinessJetTracker'))
import FlightInspectorModal from './components/FlightInspectorModal'
import { SwimProvider } from './contexts/SwimContext'
import StartupStatus from './components/StartupStatus'
import usePageVisible from './hooks/usePageVisible'

import axios from 'axios'
import { fetchStates } from './services/opensky'
import { fetchAplByHex } from './services/airplaneslive'
import { enrichFlight, fetchRouteOnly } from './services/adsbdb'
import { enrichByHex } from './services/adsbfi'
import { checkHealth, fetchAeroSpend } from './services/aeroapi'

import { fetchOpenSkyUsageToday, fetchAircraftTrack, lookupRoutes, saveRoutes } from './services/sightings'

// ── default settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  userAeroKey: '',
  userOsClientId: '',
  userOsClientSecret: '',
  timeMode: 'local',
}

function loadSettings() {
  try {
    const s = localStorage.getItem('ft_cfg')
    return s
      ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) }
      : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem('ft_cfg', JSON.stringify(s))
  } catch {}
}

function isMilitarySignal(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'military' || normalized === 'mil'
}

// ── log helper ────────────────────────────────────────────────────────────────
function makeEntry(msg, type = '') {
  return {
    msg,
    type,
    time: new Date().toISOString().substring(11, 19),
    ts: Date.now(),
  }
}

export default function App() {
  const pageVisible = usePageVisible()
  const [privateRecorded, setPrivateRecorded] = useState(false)
  // ── core state ──────────────────────────────────────────────────────────────
  const [flights, setFlights] = useState([])
  const [, setLogEntries] = useState([])
  const [settings, setSettings] = useState(loadSettings)
  const [region, setRegion] = useState('usa')
  const [filter, setFilter] = useState('')
  const [tableFilters, setTableFilters] = useState(emptyFilters)
  const [showMilitary, setShowMilitary] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [backendOk, setBackendOk] = useState(false)
  const [lastFetchAt, setLastFetchAt] = useState(null)
  const [flightDataStatus, setFlightDataStatus] = useState('loading')
  const [flightDataError, setFlightDataError] = useState(null)
  const [openskyUsage, setOpenskyUsage] = useState(null)
  const [aeroSpend, setAeroSpend] = useState(null)

  // ── UI overlay state ────────────────────────────────────────────────────────
  const [showDataAccount, setShowDataAccount] = useState(false)
  const closeDataAccount = useCallback(() => setShowDataAccount(false), [])
  const [showSignalsDrawer, setShowSignalsDrawer] = useState(false)
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.matchMedia('(max-width: 1023px)').matches)
  const [activeView, setActiveView] = useState(() => {
    try {
      const linked = new URL(window.location.href).searchParams.get('view')
      if (linked === 'alerts') return 'flights'
      if (['flights', 'airports', 'private'].includes(linked)) return linked
      return 'flights'
    } catch {
      return 'flights'
    }
  })
  useEffect(() => {
    try { localStorage.setItem('ft_view', activeView) } catch {}
    const url = new URL(window.location.href)
    if (url.searchParams.get('view') !== activeView) {
      url.searchParams.set('view', activeView)
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [activeView])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)')
    const update = () => {
      setIsMobileLayout(query.matches)
      if (!query.matches) setShowMobileInspector(false)
    }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // ── detail / enrichment state ───────────────────────────────────────────────
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [selectedAlert, setSelectedAlert] = useState(null)
  const selectedAlertRef = useRef(selectedAlert)
  selectedAlertRef.current = selectedAlert
  const [showMobileInspector, setShowMobileInspector] = useState(false)
  const mobileDialogRef = useRef(null)
  const mobileReturnFocusRef = useRef(null)

  const handleViewChange = useCallback((nextView, { replace = false } = {}) => {
    if (!['flights', 'airports', 'private'].includes(nextView)) return
    if (nextView === activeView) return
    setShowMobileInspector(false)
    setShowSignalsDrawer(false)
    if (nextView !== 'flights') {
      setSelectedFlight(null)
      setSelectedAlert(null)
    }
    setActiveView(nextView)
    const url = new URL(window.location.href)
    url.searchParams.set('view', nextView)
    window.history[replace ? 'replaceState' : 'pushState'](null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [activeView])

  useEffect(() => {
    const onPopState = () => {
      const url = new URL(window.location.href)
      const rawView = url.searchParams.get('view')
      const linked = rawView === 'alerts' ? 'flights' : rawView
      if (!['flights', 'airports', 'private'].includes(linked)) return
      if (rawView === 'alerts') {
        url.searchParams.set('view', 'flights')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      }
      setActiveView(linked)
      setShowSignalsDrawer(false)
      if (linked !== 'flights') {
        setSelectedFlight(null)
        setSelectedAlert(null)
      }
      setShowMobileInspector(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const mobileInspectorOpen = Boolean(isMobileLayout && selectedFlight && showMobileInspector && activeView === 'flights')
  const closeMobileInspector = useCallback(() => {
    setShowMobileInspector(false)
    if (activeView === 'flights') setSelectedFlight(null)
  }, [activeView])

  const clearSelectedFlight = useCallback(() => {
    setSelectedFlight(null)
    setSelectedAlert(null)
    setShowMobileInspector(false)
  }, [])

  const handleMilitaryVisibility = useCallback((visible) => {
    setShowMilitary(visible)
    if (!visible && isMilitarySignal(selectedAlertRef.current?.primary)) {
      clearSelectedFlight()
    }
  }, [clearSelectedFlight])

  useEffect(() => {
    if (!mobileInspectorOpen) return
    mobileReturnFocusRef.current = document.activeElement
    const dialog = mobileDialogRef.current
    const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog?.querySelectorAll(selector) || [])
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    requestAnimationFrame(() => focusables()[0]?.focus())

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMobileInspector()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { event.preventDefault(); dialog?.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = priorOverflow
      mobileReturnFocusRef.current?.focus?.()
    }
  }, [mobileInspectorOpen, closeMobileInspector])

  // v5.3.0 — hash-based routing for the full-page FlightDossier.
  // #flight=<icao> (optionally with &cs=<callsign>) opens the dossier overlay.
  // v5.7.0 — #group=<kind>:<id> opens the group dossier.
  const [dossier, setDossier] = useState(null)  // { icao, callsign, returnGroup? } | null
  const [groupDossier, setGroupDossier] = useState(null)  // string groupId or null
  const overlayReturnFocusRef = useRef(null)
  useEffect(() => {
    const openOverlay = (hash) => {
      if (!/^#(?:flight|group)=/.test(hash) || hash === window.location.hash) return
      const state = { ...(window.history.state || {}), flighttermOverlay: true }
      window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`)
      window.dispatchEvent(new Event('hashchange'))
    }
    const parseHash = () => {
      const h = window.location.hash.slice(1)  // strip leading #
      if (h.startsWith('flight=')) {
        const params = new URLSearchParams(h)
        const icao = (params.get('flight') || '').toLowerCase()
        if (!icao) return { flight: null, group: null }
        return {
          flight: {
            icao,
            callsign: params.get('cs') || null,
            returnGroup: params.get('fromGroup') || null,
          },
          group: null,
        }
      }
      if (h.startsWith('group=')) {
        const params = new URLSearchParams(h)
        const gid = (params.get('group') || '').toLowerCase()
        if (!gid.includes(':')) return { flight: null, group: null }
        return { flight: null, group: gid }
      }
      return { flight: null, group: null }
    }
    const onOverlayLinkClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element
        ? event.target.closest('a[href^="#flight="], a[href^="#group="]')
        : null
      if (!anchor) return
      const hash = anchor.getAttribute('href')
      if (!hash) return
      event.preventDefault()
      openOverlay(hash)
    }
    const onOpenOverlay = (event) => openOverlay(event.detail?.hash || '')
    const apply = () => {
      const { flight, group } = parseHash()
      if (flight || group) {
        overlayReturnFocusRef.current = document.activeElement
        setShowMobileInspector(false)
        setShowDataAccount(false)
      }
      setDossier(flight)
      setGroupDossier(group)
    }
    apply()
    window.addEventListener('hashchange', apply)
    window.addEventListener('popstate', apply)
    document.addEventListener('click', onOverlayLinkClick)
    window.addEventListener('flightterm:open-overlay', onOpenOverlay)
    return () => {
      window.removeEventListener('hashchange', apply)
      window.removeEventListener('popstate', apply)
      document.removeEventListener('click', onOverlayLinkClick)
      window.removeEventListener('flightterm:open-overlay', onOpenOverlay)
    }
  }, [])
  const closeDossier = () => {
    if (window.history.state?.flighttermOverlay) {
      window.history.back()
      return
    }
    if (dossier?.returnGroup) {
      const groupHash = `#group=${encodeURIComponent(dossier.returnGroup)}`
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${groupHash}`)
      setDossier(null)
      setGroupDossier(dossier.returnGroup)
      return
    }
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search)
    setDossier(null)
  }
  const closeGroupDossier = () => {
    if (window.history.state?.flighttermOverlay) {
      window.history.back()
      return
    }
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search)
    setGroupDossier(null)
  }

  useEffect(() => {
    if (!selectedFlight || isMobileLayout || showDataAccount || dossier || groupDossier) return
    const onKeyDown = (event) => {
      if (event.key === 'Escape') clearSelectedFlight()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedFlight, isMobileLayout, showDataAccount, dossier, groupDossier, clearSelectedFlight])
  const [enrichCache, setEnrichCache] = useState({})
  const [aeroCache, setAeroCache] = useState({})

  // ── flight tracking history (per-icao, last N snapshots) ────────────────────
  const [trackHistory, setTrackHistory] = useState({})
  const trackHistoryRef = useRef({})
  trackHistoryRef.current = trackHistory

  // ── anomalies: icaos with sudden alt/vel changes ──────────────────────────
  const [anomalies, setAnomalies] = useState({}) // { icao: { score, phase, reasons[], confirmed, label } }

  // ── route cache: callsign → { destination_lat, destination_lon, destination_icao, ... }
  const flightDemandRef = useRef(false)
  flightDemandRef.current = pageVisible && activeView === 'flights'
  const routeCacheRef = useRef({})    // in-memory mirror of backend cache
  const enrichQueueRef = useRef([])   // callsigns waiting for route enrichment
  const enrichingRef = useRef(false)

  // ── slow route enrichment queue (1 req / 15s to avoid 429s) ────────────────
  const startEnrichQueue = useCallback(() => {
    if (enrichingRef.current) return
    enrichingRef.current = true

    async function processQueue() {
      while (enrichQueueRef.current.length > 0 && flightDemandRef.current) {
        const cs = enrichQueueRef.current.shift()
        try {
          const route = await fetchRouteOnly(cs)
          if (route?.destination) {
            const destLat = route.destination.latitude ?? route.destination.lat
            const destLon = route.destination.longitude ?? route.destination.lon
            const originLat = route.origin?.latitude ?? route.origin?.lat
            const originLon = route.origin?.longitude ?? route.origin?.lon

            if (destLat != null && destLon != null) {
              const entry = {
                callsign: cs,
                origin_icao: route.origin?.icao_code || route.origin?.iata_code || null,
                origin_lat: originLat ?? null,
                origin_lon: originLon ?? null,
                destination_icao: route.destination?.icao_code || route.destination?.iata_code || null,
                destination_lat: destLat,
                destination_lon: destLon,
                source: route._source || 'adsbdb',
              }
              saveRoutes([entry]).catch(() => {})
              routeCacheRef.current[cs] = entry
            }
          }
        } catch (err) {
          // Stop queue on rate limit
          if (err?.response?.status === 429) {
            enrichQueueRef.current = []
            break
          }
        }
        if (enrichQueueRef.current.length > 0) {
          await new Promise(r => setTimeout(r, 15000))
        }
      }
      enrichingRef.current = false
    }

    processQueue()
  }, [])

  const fetchFlightsRef = useRef(null)
  const openskyUsageRef = useRef(null)
  openskyUsageRef.current = openskyUsage


  // ── logging ──────────────────────────────────────────────────────────────────
  const log = useCallback((msg, type = '') => {
    setLogEntries((prev) => [...prev.slice(-199), makeEntry(msg, type)])
  }, [])

  // ── refresh usage from backend ───────────────────────────────────────────────
  const refreshAeroSpend = useCallback(() => {
    fetchAeroSpend()
      .then(setAeroSpend)
      .catch(() => {})
  }, [])

  const refreshOpenskyUsage = useCallback(() => {
    fetchOpenSkyUsageToday()
      .then(setOpenskyUsage)
      .catch(() => {})
  }, [])

  // ── loading state for initial boot ──────────────────────────────────────────
  const [booting, setBooting] = useState(true)
  const [bootPhase, setBootPhase] = useState('connecting')
  const [bootAttempt, setBootAttempt] = useState(0)
  const [bootStartedAt, setBootStartedAt] = useState(() => Date.now())
  const [bootRun, setBootRun] = useState(0)

  const retryBoot = useCallback(() => {
    setBooting(true)
    setBootPhase('connecting')
    setBootAttempt(0)
    setBootStartedAt(Date.now())
    setFlightDataError(null)
    setFlightDataStatus(previous => flights.length ? 'stale' : 'loading')
    setBootRun(previous => previous + 1)
  }, [flights.length])

  // ── backend health check → initial fetch → auto ────────────────────────────
  useEffect(() => {
    const isProd = !window.location.hostname.includes('localhost')
    let cancelled = false

    log('flightterm v4 booting…', 'info')
    console.log('[boot] starting — isProd:', isProd)

    // Retry health check up to 10 times (covers Fly cold start)
    async function waitForBackend(retries = 18, delay = 2500) {
      for (let i = 0; i < retries; i++) {
        if (cancelled || document.visibilityState === 'hidden') return null
        try {
          console.log(`[boot] health check attempt ${i + 1}/${retries}`)
          setBootAttempt(i + 1)
          setBootPhase('connecting')
          if (i > 0) log(`backend: retrying… (${i + 1}/${retries})`, 'warn')
          const d = await checkHealth()
          if (cancelled) return null
          setBootPhase('traffic')
          setBackendOk(true)
          log(`backend ok · opensky: ${d.opensky_configured ? '✓' : '✗'} · aeroapi: ${d.aeroapi_configured ? '✓' : '✗'} · notam: ${d.faa_notam_configured ? '✓' : '✗'}`, 'ok')
          console.log('[boot] backend ready:', {
            opensky: d.opensky_configured, aeroapi: d.aeroapi_configured, notam: d.faa_notam_configured,
            poller: d.poller_running ? `running (${d.poller_region}, ${d.poller_aircraft} aircraft)` : 'disabled',
            db: d.db_size,
          })
          return d
        } catch {
          if (cancelled) return null
          if (i < retries - 1) {
            console.log(`[boot] backend not ready, retrying in ${delay}ms`)
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
      setBackendOk(false)
      setBootPhase('offline')
      log('backend offline — start the Express server (cd backend && npm run dev)', 'warn')
      console.log('[boot] backend unreachable after retries')
      return null
    }

    async function boot() {
      log('connecting to backend…', 'info')
      const health = await waitForBackend()
      if (cancelled) return

      if (health) {
        log('loading usage data…', 'info')
        console.log('[boot] refreshing usage data')
        // Usage is secondary to the first usable workspace. Refresh it in the
        // background instead of making a cold visitor wait for it.
        Promise.allSettled([refreshAeroSpend(), refreshOpenskyUsage()])
          .then(() => { if (!cancelled) log('usage data loaded', 'ok') })

        log('fetching initial flight data…', 'info')
        setBootPhase('traffic')
        console.log('[boot] initial fetch')
        await Promise.race([
          fetchFlightsRef.current?.() || Promise.resolve(),
          new Promise(resolve => setTimeout(resolve, 10000)),
        ])
        if (cancelled) return
        const intervalSec = pollInterval ? Math.round(pollInterval / 1000) : '?'
        log(`live sync enabled (${intervalSec}s)`, 'ok')
        console.log('[boot] live sync enabled')
      }

      setBooting(false)
      log('flightterm v4 ready', 'ok')
      console.log('[boot] complete')
    }

    boot()
    return () => { cancelled = true }
  }, [bootRun])

  useEffect(() => {
    if (!booting || !backendOk || flights.length === 0) return
    setBooting(false)
  }, [booting, backendOk, flights.length])

  // Once a verified traffic sample lands, startup timing is no longer relevant.
  // Later feed staleness uses the normal inline recovery state instead.
  useEffect(() => {
    if (flightDataStatus === 'live') setBootPhase('ready')
  }, [flightDataStatus])

  // Backend health is live state, not a boot-time latch. This lets every
  // workspace recover after an outage (and stop claiming live data during one).
  useEffect(() => {
    if (!pageVisible || (activeView === 'private' && privateRecorded)) return
    let cancelled = false
    const refreshHealth = async () => {
      try {
        await axios.get('/api/health/live', { timeout: 5000 })
        if (!cancelled) setBackendOk(true)
      } catch {
        if (!cancelled) {
          setBackendOk(false)
          setFlightDataError('Backend health check failed')
          setFlightDataStatus(previous => previous === 'live' ? 'stale' : previous === 'loading' ? 'unavailable' : previous)
        }
      }
    }
    refreshHealth()
    const id = setInterval(refreshHealth, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [pageVisible, activeView, privateRecorded])

  // ── fetch flights ─────────────────────────────────────────────────────────────
  // Primary path: read from backend poller cache (GET /api/flights).
  // All users see the same data. Backend records sightings + scores anomalies.
  // Fallback: direct OpenSky fetch if poller region doesn't match.
  const lastServerFetchRef = useRef(null) // tracks when poller last fetched (to detect new cycles)
  const fetchingRef = useRef(false)
  const flightsRequestRef = useRef(0)
  const regionRef = useRef(region)
  const [pollInterval, setPollInterval] = useState(null) // poll interval from backend (ms)

  const fetchFlights = useCallback(async () => {
    if (fetchingRef.current || !pageVisible || activeView !== 'flights') return

    const requestId = ++flightsRequestRef.current
    const requestedRegion = region
    const isCurrent = () => flightsRequestRef.current === requestId && regionRef.current === requestedRegion
    fetchingRef.current = true
    setFetching(true)
    setFlightDataStatus(prev => flights.length ? prev : 'loading')
    const t0 = performance.now()

    let result = null
    let serverFetchedAt = null
    let responsePollInterval = pollInterval || 45_000

    try {
      const resp = await axios.get('/api/flights')
      const pollerRegion = resp.data?.region
      const pollerFlights = Array.isArray(resp.data?.flights) ? resp.data.flights : null
      const pollerHasData = (pollerFlights?.length || 0) > 0
      serverFetchedAt = resp.data?.fetchedAt || null
      console.log('[fetch] /api/flights →', { pollerRegion, pollerHasData, flightCount: resp.data?.flights?.length, serverFetchedAt, clientRegion: region })
      if (resp.data?.pollInterval) {
        responsePollInterval = resp.data.pollInterval
        if (resp.data.pollInterval !== pollInterval) setPollInterval(resp.data.pollInterval)
      }

      if (pollerFlights && pollerRegion === requestedRegion) {
        result = pollerFlights
        for (const f of result) {
          if (!f.callsign) f.callsign = '—'
        }
      } else if (pollerRegion && pollerRegion !== requestedRegion) {
        log(`flights: poller region is ${pollerRegion}, need ${requestedRegion} — fetching direct`, 'info')
        const direct = await fetchStates(requestedRegion, {
          osClientId: settings.userOsClientId,
          osClientSecret: settings.userOsClientSecret,
        })
        result = direct.flights
        serverFetchedAt = Date.now()
        const ms = Math.round(performance.now() - t0)
        log(`opensky: ${result.length} state vectors received (${ms}ms)`, 'ok')
      } else {
        result = []
      }
    } catch (err) {
      console.error('[fetch] backend error:', err.message)
      log(`flights: backend error (${err.message})`, 'err')
      result = null
      if (isCurrent()) {
        setFlightDataError(err.message || 'Flight records unavailable')
        setFlightDataStatus(flights.length ? 'stale' : 'unavailable')
      }
    }

    if (!isCurrent()) return
    console.log('[fetch] result:', result?.length ?? 0, 'flights')
    if (result !== null) {
      const verifiedFetchMs = serverFetchedAt ? new Date(serverFetchedAt).getTime() : NaN
      const hasVerifiedFetch = Number.isFinite(verifiedFetchMs)
      const isStaleFetch = hasVerifiedFetch && Date.now() - verifiedFetchMs > Math.max(120_000, responsePollInterval * 2.5)

      // A 200 response without a completed poller sample is not a verified
      // empty result. Keep warming (or retain the last good data as stale).
      if (!hasVerifiedFetch) {
        setFlightDataError(flights.length ? 'Waiting for a new verified flight sample' : null)
        setFlightDataStatus(flights.length ? 'stale' : 'loading')
        fetchingRef.current = false
        setFetching(false)
        return
      }

      setFlights(result)
      setSelectedFlight(previous => {
        if (!previous?.icao) return previous
        const refreshed = result.find(flight => flight.icao === previous.icao)
        return refreshed ? { ...previous, ...refreshed } : previous
      })
      setLastFetchAt(verifiedFetchMs)
      setFlightDataError(isStaleFetch ? 'The flight feed has not completed a recent polling cycle' : null)
      setFlightDataStatus(isStaleFetch ? 'stale' : 'live')

      // Detect new poller cycle (fetchedAt changed) vs enrichment refresh
      const isNewCycle = serverFetchedAt !== lastServerFetchRef.current
      lastServerFetchRef.current = serverFetchedAt

      if (isNewCycle && result.length > 0) {
        const ms = Math.round(performance.now() - t0)
        const age = serverFetchedAt ? Math.round((Date.now() - serverFetchedAt) / 1000) : '?'
        log(`flights: ${result.length} aircraft from poller (${ms}ms, ${age}s old)`, 'ok')
        refreshOpenskyUsage()

        // ── track history snapshots per aircraft ──────────────────────────
        const MAX_SNAPSHOTS = 30
        const now = Date.now()
        setTrackHistory((prev) => {
          const next = { ...prev }
          for (const f of result) {
            if (f.alt == null && f.vel == null) continue
            const arr = next[f.icao] ? [...next[f.icao]] : []
            arr.push({ ts: now, lat: f.lat, lon: f.lon, alt: f.alt, vel: f.vel, hdg: f.hdg, grounded: f.grounded, vertRate: f.vertRate, geoAlt: f.geoAlt, posSrc: f.posSrc, ndb: f.ndb })
            if (arr.length > MAX_SNAPSHOTS) arr.shift()
            next[f.icao] = arr
          }
          return next
        })

        // ── route lookup for diversion detection ──────────────────────────
        const allCallsigns = [...new Set(result.map(f => f.callsign).filter(cs => cs && cs !== '—'))]
        const uncached = allCallsigns.filter(cs => !routeCacheRef.current[cs])

        if (uncached.length > 0) {
          try {
            const { routes, unknown } = await lookupRoutes(uncached)
            for (const [cs, route] of Object.entries(routes)) {
              routeCacheRef.current[cs] = route
            }
            if (unknown.length > 0) {
              const queued = new Set(enrichQueueRef.current)
              const toAdd = unknown.filter(cs => !queued.has(cs)).slice(0, 50)
              enrichQueueRef.current.push(...toAdd)
              startEnrichQueue()
            }
            if (Object.keys(routes).length > 0 || unknown.length > 0) {
              const cached = Object.keys(routeCacheRef.current).length
              log(`routes: ${Object.keys(routes).length} new from cache, ${unknown.length} queued · ${cached} total`, 'info')
            }
          } catch {}
        }

        const airborne = result.filter((f) => !f.grounded)
        const grounded = result.length - airborne.length
        log(`  airborne: ${airborne.length} · grounded: ${grounded}`, 'info')
      }
      // else: silent refresh — just updates flight data (picks up new enrichment)
      if (result.length === 0 && isNewCycle) {
        log(`flights: successful ${requestedRegion} response contained no aircraft`, 'info')
      }
    }

    fetchingRef.current = false
    setFetching(false)
  }, [settings, region, log, pollInterval, refreshOpenskyUsage, flights.length, pageVisible, activeView])

  useEffect(() => {
    fetchFlightsRef.current = fetchFlights
  }, [fetchFlights])

  const previousRegionRef = useRef(region)
  useEffect(() => {
    if (previousRegionRef.current === region) return
    previousRegionRef.current = region
    fetchFlightsRef.current?.()
  }, [region])

  // ── SSE: receive anomalies from backend poller ──────────────────────────────
  useEffect(() => {
    if (!pageVisible || activeView !== 'flights') return
    const baseUrl = import.meta.env.VITE_API_URL || ''
    const es = new EventSource(`${baseUrl}/api/anomalies/stream`)

    es.addEventListener('anomaly', (e) => {
      try {
        const a = JSON.parse(e.data)
        setAnomalies((prev) => ({
          ...prev,
          [a.icao]: {
            score: a.score, phase: a.phase, reasons: a.reasons,
            confirmed: a.confirmed, category: a.category,
            severity: a.severity, categories: a.categories,
            label: a.reasons?.[0] || 'anomaly',
          },
        }))
      } catch {}
    })

    es.addEventListener('critical', (e) => {
      try {
        const a = JSON.parse(e.data)
        log(`anomaly: CRITICAL ${a.icao} ${a.callsign || ''} — ${a.reasons?.[0] || 'emergency'}`, 'warn')
      } catch {}
    })

    es.addEventListener('resolved', (e) => {
      try {
        const icaos = JSON.parse(e.data)
        setAnomalies((prev) => {
          const next = { ...prev }
          for (const icao of icaos) delete next[icao]
          return next
        })
        log(`anomalies: ${icaos.length} resolved by backend poller`, 'info')
      } catch {}
    })

    es.onerror = () => {
      // SSE will auto-reconnect; no action needed
    }

    return () => es.close()
  }, [log, pageVisible, activeView])

  // ── auto-refresh ──────────────────────────────────────────────────────────────
  // Polls backend cache at half the poller interval (floor 5s). This is cheap
  // (memory + SQLite read, no external API calls). Picks up enrichment (type/reg)
  // as it trickles in between poller cycles, and new flight positions as soon as
  // the poller fetches.
  useEffect(() => {
    if (!pageVisible || activeView !== 'flights' || !backendOk) return
    fetchFlightsRef.current?.()
    const interval = Math.max(5000, Math.round((pollInterval || 45000) / 2))
    const id = setInterval(() => {
      fetchFlightsRef.current?.()
    }, interval)
    return () => clearInterval(id)
  }, [pollInterval, pageVisible, activeView, backendOk])

  // ── region change ─────────────────────────────────────────────────────────────
  const handleRegionChange = (r) => {
    if (r === region) return
    regionRef.current = r
    flightsRequestRef.current += 1
    fetchingRef.current = false
    setFetching(false)
    setFlights([])
    setLastFetchAt(null)
    setFlightDataError(null)
    setFlightDataStatus('loading')
    lastServerFetchRef.current = null
    setSelectedFlight(null)
    setSelectedAlert(null)
    setShowMobileInspector(false)
    setShowSignalsDrawer(false)
    setTableFilters(emptyFilters())
    setFilter('')
    setRegion(r)
    log(`region → ${r}`, 'info')
  }

  // ── row selection + adsbdb enrichment + backend track pre-fill ───────────────
  const handleSelectFlight = useCallback(
    async (flight, alert = null) => {
      if (!flight) {
        setSelectedFlight(null)
        setSelectedAlert(null)
        setShowMobileInspector(false)
        return
      }
      setSelectedFlight(flight)
      setSelectedAlert(alert)
      setShowMobileInspector(false)
      setShowSignalsDrawer(false)

      // Pre-fill track history from backend if we don't have much in-memory
      // Backend rows lack lat/lon, so only use them for chart data — never overwrite
      // in-memory snapshots that have positions
      const existing = trackHistoryRef.current[flight.icao]
      if (!existing || existing.length < 3) {
        fetchAircraftTrack(flight.icao, 60)
          .then((rows) => {
            if (rows.length > 0) {
              const backendSnaps = rows.map((r) => ({
                ts: new Date(r.seen_at).getTime(),
                lat: r.lat, lon: r.lon,
                alt: r.alt, vel: r.vel, hdg: r.hdg, grounded: !!r.grounded,
              }))
              setTrackHistory((prev) => {
                const mem = prev[flight.icao] || []
                const seen = new Set(mem.map((s) => s.ts))
                const merged = [...backendSnaps.filter((s) => !seen.has(s.ts)), ...mem]
                merged.sort((a, b) => a.ts - b.ts)
                return { ...prev, [flight.icao]: merged.slice(-60) }
              })
            }
          })
          .catch(() => {})
      }

      // Skip if fully enriched (has adsbdb + adsbfi + apl)
      const cached = enrichCache[flight.icao]
      if (cached?.aircraft !== undefined && cached?.adsbfi && cached?.apl) return

      // Only fetch what's missing
      log(`enriching ${flight.icao} / ${flight.callsign}`, 'info')
      const needsAdsbdb = cached?.aircraft === undefined && cached?.flightroute === undefined
      const needsAdsbfi = !cached?.adsbfi
      const needsApl = !cached?.apl

      const [adsbdbResult, adsbfiResult, aplResult] = await Promise.allSettled([
        needsAdsbdb ? enrichFlight(flight.icao, flight.callsign) : Promise.resolve(cached ? { aircraft: cached.aircraft, flightroute: cached.flightroute } : { aircraft: null, flightroute: null }),
        needsAdsbfi ? enrichByHex(flight.icao) : Promise.resolve(cached?.adsbfi),
        needsApl ? fetchAplByHex(flight.icao) : Promise.resolve(cached?.apl),
      ])

      const adsbdb = adsbdbResult.status === 'fulfilled' ? adsbdbResult.value : { aircraft: null, flightroute: null }
      const adsbfi = adsbfiResult.status === 'fulfilled' ? adsbfiResult.value : null
      const aplData = aplResult.status === 'fulfilled' ? aplResult.value : null

      setEnrichCache((prev) => ({ ...prev, [flight.icao]: { ...prev[flight.icao], ...adsbdb, adsbfi: adsbfi || prev[flight.icao]?.adsbfi, apl: aplData } }))

      const parts = []
      if (adsbdb.aircraft) parts.push('aircraft=found')
      if (adsbdb.flightroute) parts.push(`route=${adsbdb.flightroute._source || 'adsbdb'}`)
      if (adsbfi) parts.push(`adsb.fi=${[adsbfi.type, adsbfi.reg, adsbfi.operator].filter(Boolean).join('/') || 'ok'}`)
      if (aplData) parts.push(`apl=${[aplData.ias ? `IAS:${aplData.ias}` : null, aplData.mach ? `M${aplData.mach}` : null, aplData.windSpeed ? `wind:${aplData.windDir}°/${aplData.windSpeed}kt` : null].filter(Boolean).join('/') || 'ok'}`)
      log(`enrich: ${flight.icao} — ${parts.join(' · ') || 'no data'}`, parts.length ? 'ok' : 'warn')
    },
    [enrichCache, log]
  )


  // ── arrived / departed aircraft log ──────────────────────────────────────────
  const handleArrived = useCallback(
    (callsigns) => {
      const list = callsigns.slice(0, 8).join(', ')
      const overflow =
        callsigns.length > 8 ? ` +${callsigns.length - 8} more` : ''
      log(`arrived: ${callsigns.length} aircraft (${list}${overflow})`, 'ok')
    },
    [log]
  )

  const handleDeparted = useCallback(
    (callsigns) => {
      const list = callsigns.slice(0, 8).join(', ')
      const overflow =
        callsigns.length > 8 ? ` +${callsigns.length - 8} more` : ''
      log(`departed: ${callsigns.length} aircraft (${list}${overflow})`, 'warn')
    },
    [log]
  )

  // ── aero cache update ─────────────────────────────────────────────────────────
  const handleAeroFetched = useCallback(
    (icao, data) => {
      setAeroCache((prev) => ({ ...prev, [icao]: data }))
      log(
        `aeroapi: ${icao} — ${data ? 'data received' : 'no flight data'}`,
        data ? 'ok' : 'warn'
      )
      refreshAeroSpend()
    },
    [log, refreshAeroSpend]
  )

  // ── settings save ─────────────────────────────────────────────────────────────
  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings)
    saveSettings(newSettings)
    log('settings saved', 'ok')
    setShowDataAccount(false)
  }

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <SwimProvider backendOk={backendOk} active={pageVisible && activeView === 'airports'}>
    <Suspense fallback={<p className="workspace-loading" role="status">Opening workspace…</p>}>
      <div className="app-shell flex flex-col min-h-screen" inert={mobileInspectorOpen || showDataAccount || dossier || groupDossier ? true : undefined} aria-hidden={mobileInspectorOpen || showDataAccount || dossier || groupDossier ? 'true' : undefined}>
        <CommandBar
          activeView={activeView}
          onViewChange={handleViewChange}
        />

        {activeView === 'flights' && <StartupStatus
          booting={booting}
          phase={bootPhase}
          attempt={bootAttempt}
          startedAt={bootStartedAt}
          backendOk={backendOk}
          flightDataStatus={flightDataStatus}
          flightDataError={flightDataError}
          onRetry={retryBoot}
        />}

        {activeView === 'flights' && (
          <main className="view-frame view-frame--flights" aria-label="Flights workspace">
            <div className="flight-record-shell relative min-h-0 flex">
              <section className="traffic-surface flex-1 min-w-0" aria-label="All flight records">
                <FlightTable
                  key={`flights-${region}`}
                  flights={flights}
                  filter={filter}
                  onFilterChange={setFilter}
                  filters={tableFilters}
                  onFiltersChange={setTableFilters}
                  selectedIcao={selectedFlight?.icao}
                  enrichCache={enrichCache}
                  anomalies={anomalies}
                  trackHistory={trackHistory}
                  onSelect={(flight) => { handleSelectFlight(flight); if (flight && isMobileLayout) setShowMobileInspector(true) }}
                  onArrived={handleArrived}
                  onDeparted={handleDeparted}
                  onSync={fetchFlights}
                  isSyncing={fetching}
                  dataStatus={flightDataStatus}
                  dataError={flightDataError}
                  lastUpdatedAt={lastFetchAt}
                  region={region}
                  onRegionChange={handleRegionChange}
                  showMilitary={showMilitary}
                  onShowMilitaryChange={handleMilitaryVisibility}
                  signalsOpen={showSignalsDrawer}
                  onToggleSignals={() => setShowSignalsDrawer(open => !open)}
                />
              </section>
              <aside className="inspector-surface hidden lg:block" aria-label="Flight details">
                <FlightInspectorModal
                  flight={selectedFlight}
                  flights={flights}
                  enrichData={selectedFlight ? enrichCache[selectedFlight.icao] : null}
                  aeroCache={aeroCache}
                  aeroSpend={aeroSpend}
                  userAeroKey={settings.userAeroKey}
                  trackHistory={selectedFlight ? trackHistory[selectedFlight.icao] : null}
                  onClose={clearSelectedFlight}
                  onAeroFetched={handleAeroFetched}
                  backendOk={backendOk}
                  lastUpdatedAt={lastFetchAt}
                  region={region}
                  showMilitary={showMilitary}
                />
              </aside>
              {showSignalsDrawer && (
                <aside className="flight-signals-drawer" aria-label="Ranked signal queue">
                  <InterestingFeed
                    flights={flights}
                    selectedIcao={selectedFlight?.icao}
                    onSelect={(flight, alert) => {
                      handleSelectFlight(flight, alert)
                      if (flight && isMobileLayout) setShowMobileInspector(true)
                    }}
                    onClose={() => setShowSignalsDrawer(false)}
                    backendOk={backendOk}
                    showMilitary={showMilitary}
                  />
                </aside>
              )}
            </div>
          </main>
        )}

        {activeView === 'airports' && (
          <main className="view-frame operations-workspace" aria-label="Airport and national airspace operations">
            <NasPanel backendOk={backendOk && pageVisible} />
            <TfmsPanel backendOk={backendOk && pageVisible} />
          </main>
        )}

        {activeView === 'private' && (
          <main className="view-frame private-jet-workspace" aria-label="Private jet activity workspace">
            <BusinessJetTracker backendOk={backendOk} onRecordedChange={setPrivateRecorded} />
          </main>
        )}

        <footer className="app-source-footer">
          <a href="https://github.com/wuwwa/flightterm" target="_blank" rel="noreferrer" aria-label="View FlightTerm by @wuwwa on GitHub">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2a6.8 6.8 0 0 0-2.15 13.25c.34.06.46-.15.46-.33v-1.3c-1.88.4-2.27-.8-2.27-.8-.3-.78-.75-.99-.75-.99-.61-.42.05-.41.05-.41.68.05 1.03.69 1.03.69.6 1.03 1.58.73 1.97.56.06-.44.24-.73.43-.9-1.5-.17-3.08-.75-3.08-3.34 0-.74.26-1.34.69-1.81-.07-.17-.3-.86.07-1.79 0 0 .57-.18 1.86.69a6.47 6.47 0 0 1 3.39 0c1.29-.87 1.86-.69 1.86-.69.37.93.14 1.62.07 1.79.43.47.69 1.07.69 1.81 0 2.6-1.58 3.17-3.09 3.34.24.21.46.62.46 1.25v1.85c0 .18.12.39.46.33A6.8 6.8 0 0 0 8 1.2Z" fill="currentColor" /></svg>
            <span className="app-source-footer__credit">Built by <strong>@wuwwa</strong></span>
            <span className="app-source-footer__divider" aria-hidden="true">·</span>
            <span className="app-source-footer__brand">GitHub</span>
          </a>
        </footer>

      </div>

      {/* U.S. airspace map is shelved for now.
          DashboardPanel/NasMap remain in the codebase if we need to bring it back. */}

      {/* Mobile flight inspector — bottom sheet with backdrop */}
      {mobileInspectorOpen && (
        <div ref={mobileDialogRef} className="lg:hidden fixed inset-0 z-[1200] flex flex-col" role="dialog" aria-modal="true" aria-label="Selected flight details" tabIndex={-1}>
          {/* Backdrop — tap to close */}
          <button
            className="shrink-0 bg-black/70"
            style={{ height: '48px' }}
            onClick={closeMobileInspector}
            aria-label="Close selected flight details"
          >
            <div className="flex items-center justify-center h-full gap-2">
              <span className="text-fg/60 text-[11px]">Close flight detail</span>
            </div>
          </button>
          {/* Sheet */}
          <div className="flex-1 min-h-0 animate-slide-up rounded-t-lg overflow-hidden border-t border-acc/30">
            <FlightInspectorModal
              flight={selectedFlight}
              flights={flights}
              enrichData={enrichCache[selectedFlight.icao]}
              aeroCache={aeroCache}
              aeroSpend={aeroSpend}
              userAeroKey={settings.userAeroKey}
              trackHistory={trackHistory[selectedFlight.icao]}
              onClose={closeMobileInspector}
              onAeroFetched={handleAeroFetched}
              backendOk={backendOk}
              lastUpdatedAt={lastFetchAt}
              showMilitary={showMilitary}
            />
          </div>
        </div>
      )}

      {showDataAccount && (
        <DataAccountPanel
          settings={settings}
          backendOk={backendOk}
          onSave={handleSaveSettings}
          onClose={closeDataAccount}
        />
      )}

      {/* v5.3.0 Flight Dossier — URL-addressable at #flight=<icao> */}
      {dossier && (
        <FlightDossier
          icao={dossier.icao}
          callsign={dossier.callsign}
          flights={flights}
          returnGroup={dossier.returnGroup}
          returnFocusTarget={overlayReturnFocusRef.current}
          onClose={closeDossier}
          showMilitary={showMilitary}
        />
      )}

      {/* v5.7.0 Group Dossier — URL-addressable at #group=<kind>:<id> */}
      {groupDossier && (
        <GroupDossier
          groupId={groupDossier}
          returnFocusTarget={overlayReturnFocusRef.current}
          onClose={closeGroupDossier}
        />
      )}

    </Suspense>
    </SwimProvider>
  )
}
