import { useState, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'
import { searchAircraft } from '../services/search'

const REGIONS = ['global', 'usa', 'europe', 'asia', 'atlantic']

function Pill({ children, active, danger, onClick }) {
  return (
    <button
      className={clsx(
        'text-[10px] py-0 px-1.5 border transition-colors',
        danger ? 'border-border text-red hover:border-red/50'
          : active ? 'border-acc/60 text-acc'
          : 'border-border text-fg3 hover:text-fg2 hover:border-border2',
      )}
      onClick={onClick}
    >{children}</button>
  )
}

export default function CommandBar({
  stats, backendOk, lastFetchAt, pollInterval,
  filter, onFilterChange,
  onClearLog, onOpenSettings, onOpenUsage,
  region, onRegionChange,
}) {
  const [time, setTime] = useState('')
  const [remaining, setRemaining] = useState(null)
  // mobileExpanded: when true on < sm, the region/settings/usage/clear/clock
  // cluster slides into a second row. Default collapsed so the bar stays at
  // ~24 px on phones instead of wrapping to 4 rows of ~120 px total.
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const { status: swimStatus } = useSwim()

  // v5.6.0 — suggestions dropdown. Debounced search + keyboard-nav open-dossier.
  const [suggestions, setSuggestions] = useState([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef(null)
  const dropdownRef = useRef(null)
  const debounceTimerRef = useRef(null)

  const openDossier = (icao, callsign) => {
    const suffix = callsign ? `&cs=${encodeURIComponent(callsign)}` : ''
    window.location.hash = `flight=${icao}${suffix}`
    setDropdownOpen(false)
    // Defocus the input so the dossier's esc-to-close works naturally.
    inputRef.current?.blur()
  }

  // Debounced search on input change.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    if (!filter || filter.trim().length < 2) {
      setSuggestions([])
      return
    }
    debounceTimerRef.current = setTimeout(() => {
      searchAircraft(filter, { limit: 10 })
        .then(d => { setSuggestions(d.results || []); setHighlighted(0) })
        .catch(() => setSuggestions([]))
    }, 180)
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current) }
  }, [filter])

  // Close dropdown on outside click.
  useEffect(() => {
    if (!dropdownOpen) return
    const onDocClick = (e) => {
      if (!dropdownRef.current) return
      if (!dropdownRef.current.contains(e.target) && e.target !== inputRef.current) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [dropdownOpen])

  // Global "/" focuses the search input (unless already focused in a field).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // 1) If a suggestion is highlighted, open it.
      const s = suggestions[highlighted]
      if (s) { openDossier(s.icao, s.callsign); return }
      // 2) If query is exactly a 6-char hex, treat it as an ICAO directly.
      const q = (filter || '').trim().toLowerCase()
      if (/^[0-9a-f]{6}$/.test(q)) { openDossier(q); return }
      // 3) Otherwise do a one-shot search and open the top result if any.
      searchAircraft(filter, { limit: 1 }).then(d => {
        const top = d.results?.[0]
        if (top) openDossier(top.icao, top.callsign)
      })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!dropdownOpen) setDropdownOpen(true)
      setHighlighted(h => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, 0))
    } else if (e.key === 'Escape') {
      setDropdownOpen(false)
      inputRef.current?.blur()
    }
  }

  // UTC clock
  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().substring(11, 19) + 'z')
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Poll countdown
  useEffect(() => {
    if (!lastFetchAt) { setRemaining(null); return }
    const intervalSec = Math.round((pollInterval || 45000) / 1000)
    const tick = () => setRemaining(Math.max(0, intervalSec - Math.floor((Date.now() - lastFetchAt) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastFetchAt, pollInterval])

  const tfms = swimStatus?.tfms
  const notams = swimStatus?.notams
  const feeds = swimStatus?.feeds || {}
  const connectedFeeds = Object.entries(feeds).filter(([, f]) => f?.connected).map(([k]) => k)

  return (
    <div className="bg-bg2 border-b border-border py-1 px-1.5 sm:px-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] shrink-0">
      {/* Left: branding + headline counts */}
      <span className="text-acc text-[13px] tracking-tight">flightterm</span>
      <span className="text-border2 hidden sm:inline">|</span>
      <span className="flex items-baseline gap-0.5">
        <span className="text-fg tabular-nums text-[12px]">{(stats.total ?? 0).toLocaleString()}</span>
        <span className="text-fg3 text-[8px] uppercase tracking-wide">ac</span>
      </span>
      <span className="hidden sm:flex items-baseline gap-0.5">
        <span className="text-grn tabular-nums text-[12px]">{(stats.airborne ?? 0).toLocaleString()}</span>
        <span className="text-fg3 text-[8px] uppercase tracking-wide">air</span>
      </span>

      {/* SWIM feed indicators — individual dots per feed */}
      <span className="text-border2 hidden sm:inline">|</span>
      <div className="hidden sm:flex items-center gap-1.5 text-[9px]">
        {['fns', 'tfms', 'sfdps', 'itws', 'stdds'].map(name => {
          const f = feeds[name]
          const on = f?.connected
          return (
            <span key={name} className="flex items-center gap-0.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? 'bg-grn' : f?.enabled ? 'bg-red' : 'bg-fg3/30'}`} />
              <span className={on ? 'text-fg3' : 'text-fg3/30'}>{name.toUpperCase()}</span>
            </span>
          )
        })}
      </div>
      {tfms?.active_flights > 0 && (
        <span className="hidden sm:flex items-baseline gap-0.5">
          <span className="text-fg2 tabular-nums text-[11px]">{tfms.active_flights.toLocaleString()}</span>
          <span className="text-fg3 text-[8px] uppercase tracking-wide">flights</span>
        </span>
      )}
      {tfms?.active_gs > 0 && (
        <span className="bg-red/15 text-red text-[9px] uppercase px-1.5 py-px rounded border border-red/40 animate-pulse">
          {tfms.active_gs} GS
        </span>
      )}
      {tfms?.active_gdps > 0 && (
        <span className="bg-ylw/15 text-ylw text-[9px] uppercase px-1.5 py-px rounded border border-ylw/40">
          {tfms.active_gdps} GDP
        </span>
      )}
      {notams?.active_tfrs > 0 && (
        <span className="bg-red/10 text-red text-[9px] uppercase px-1.5 py-px rounded border border-red/30">
          {notams.active_tfrs} TFR
        </span>
      )}

      {/* Search / filter — grows to fill. v5.6.0 adds a dropdown of
          matching live + historical aircraft and Enter-to-open-dossier.
          v5.6.3 gives the field its own visual weight: distinct border,
          magnifier icon, kbd hint, clear button — so it reads as a real
          search box rather than another chip in the toolbar. */}
      <div className={clsx(
        'flex items-center gap-1.5 flex-1 min-w-32 sm:min-w-48 ml-1 relative',
        'px-2 py-[3px] rounded border bg-bg1/80 transition-colors',
        dropdownOpen ? 'border-acc/60 bg-bg1' : 'border-border2 hover:border-border2/80 focus-within:border-acc/60 focus-within:bg-bg1'
      )}>
        <svg className="w-3 h-3 text-fg3 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="bg-transparent border-none outline-none text-fg text-[12px] flex-1 caret-acc font-mono min-w-0 placeholder:text-fg3/50"
          value={filter}
          onChange={e => { onFilterChange(e.target.value); setDropdownOpen(true) }}
          onFocus={() => filter && setDropdownOpen(true)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search aircraft — callsign, ICAO, operator, type…"
        />
        {filter ? (
          <button
            onClick={() => { onFilterChange(''); setDropdownOpen(false); inputRef.current?.focus() }}
            className="text-fg3 hover:text-fg text-[12px] cursor-pointer shrink-0 leading-none"
            title="clear"
          >×</button>
        ) : (
          <kbd className="hidden sm:inline-block text-[9px] text-fg3 border border-border px-1 py-[1px] rounded bg-bg2/60 shrink-0 pointer-events-none"
               title="press / to focus search">/</kbd>
        )}
        {dropdownOpen && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 right-0 mt-0.5 z-50 bg-bg1 border border-border2 shadow-lg rounded max-h-80 overflow-y-auto"
          >
            {suggestions.map((s, i) => {
              const active = i === highlighted
              return (
                <button
                  key={s.icao}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => openDossier(s.icao, s.callsign)}
                  className={clsx(
                    'w-full text-left px-2 py-1 border-b border-white/3 last:border-b-0 cursor-pointer flex items-center gap-2 text-[11px]',
                    active ? 'bg-acc/15' : 'hover:bg-bg2/60'
                  )}
                >
                  <span className={clsx('text-[9px] px-1 py-[1px] border rounded tabular-nums shrink-0',
                    s.live ? 'border-grn/50 text-grn bg-grn/5' : 'border-border text-fg3 bg-bg2/60')}>
                    {s.live ? 'live' : 'db'}
                  </span>
                  <span className="text-ylw font-mono w-20 shrink-0 truncate">{s.callsign || s.icao}</span>
                  <span className="text-fg3 font-mono text-[10px] shrink-0">{s.icao}</span>
                  <span className="text-acc text-[10px] shrink-0">{s.acType}</span>
                  {s.acReg && <span className="text-cyn text-[10px] shrink-0">{s.acReg}</span>}
                  <span className="text-fg3 truncate text-[10px]">{s.acOperator}</span>
                  {s.altFt != null && <span className="text-fg3 text-[9px] tabular-nums shrink-0 ml-auto">{s.altFt.toLocaleString()}ft</span>}
                  <span className="text-fg3/40 text-[8px] shrink-0">{s.match}</span>
                </button>
              )
            })}
            <div className="text-fg3/40 text-[9px] px-2 py-0.5 border-t border-border bg-bg2/30">
              ↑↓ navigate · enter opens dossier · esc closes
            </div>
          </div>
        )}
      </div>

      {/* Region selector — desktop only (mobile shows in expanded panel below) */}
      <div className="hidden sm:flex gap-0.5 items-center">
        {REGIONS.map(r => (
          <Pill key={r} active={region === r} onClick={() => onRegionChange(r)}>{r}</Pill>
        ))}
      </div>

      {/* Controls — desktop only */}
      <span className="text-border2 hidden sm:inline">|</span>
      <span className="hidden sm:inline-flex gap-2 items-center">
        <Pill onClick={onOpenSettings}>settings</Pill>
        <Pill onClick={onOpenUsage}>usage</Pill>
        <Pill danger onClick={onClearLog}>clear</Pill>
      </span>

      {/* Right: live status + clock — desktop only */}
      <div className="hidden sm:flex items-center gap-1.5 ml-auto shrink-0">
        {remaining != null && (
          <span className={clsx(
            'tabular-nums',
            remaining > 0 ? 'text-grn' : 'text-ylw animate-pulse'
          )}>
            {remaining > 0 ? `${remaining}s` : 'now'}
          </span>
        )}
        {backendOk && lastFetchAt ? (
          <span className="animate-blink text-grn">●</span>
        ) : (
          <span className={backendOk ? 'text-ylw' : 'text-red'}>○</span>
        )}
        <span className="text-fg3 tabular-nums">{time}</span>
      </div>

      {/* Mobile-only: a single live dot + disclosure toggle. Tapping opens
          the second row with regions/settings/usage/clear/clock. */}
      <div className="sm:hidden flex items-center gap-1 ml-auto shrink-0">
        {backendOk && lastFetchAt ? (
          <span className="animate-blink text-grn">●</span>
        ) : (
          <span className={backendOk ? 'text-ylw' : 'text-red'}>○</span>
        )}
        <button
          className="text-fg3 hover:text-fg2 px-1.5 border border-border text-[12px] leading-none"
          onClick={() => setMobileExpanded(v => !v)}
          aria-label={mobileExpanded ? 'collapse controls' : 'expand controls'}
        >
          {mobileExpanded ? '×' : '⋯'}
        </button>
      </div>

      {/* Mobile expanded row — full-width second line containing every control
          we hid above. Stacked vertically when narrow so nothing overflows. */}
      {mobileExpanded && (
        <div className="sm:hidden basis-full flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 mt-1 border-t border-border">
          <div className="flex gap-0.5 items-center flex-wrap">
            {REGIONS.map(r => (
              <Pill key={r} active={region === r} onClick={() => { onRegionChange(r); setMobileExpanded(false) }}>{r}</Pill>
            ))}
          </div>
          <span className="text-border2">|</span>
          <Pill onClick={() => { onOpenSettings(); setMobileExpanded(false) }}>settings</Pill>
          <Pill onClick={() => { onOpenUsage(); setMobileExpanded(false) }}>usage</Pill>
          <Pill danger onClick={() => { onClearLog(); setMobileExpanded(false) }}>clear</Pill>
          <div className="flex items-center gap-1.5 ml-auto shrink-0">
            {remaining != null && (
              <span className={clsx('tabular-nums', remaining > 0 ? 'text-grn' : 'text-ylw animate-pulse')}>
                {remaining > 0 ? `${remaining}s` : 'now'}
              </span>
            )}
            <span className="text-fg3 tabular-nums">{time}</span>
          </div>
        </div>
      )}
    </div>
  )
}
