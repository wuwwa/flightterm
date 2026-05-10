import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { searchAircraft } from '../services/search'

export default function AircraftSearchBox({ filter, onFilterChange, className }) {
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
    inputRef.current?.blur()
  }

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
      const s = suggestions[highlighted]
      if (s) { openDossier(s.icao, s.callsign); return }
      const q = (filter || '').trim().toLowerCase()
      if (/^[0-9a-f]{6}$/.test(q)) { openDossier(q); return }
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

  return (
    <div className={clsx(
      'h-5 flex items-center gap-1.5 relative',
      'px-2 border bg-bg1/80 transition-colors',
      dropdownOpen ? 'border-acc/60 bg-bg1' : 'border-border2 hover:border-border2/80 focus-within:border-acc/60 focus-within:bg-bg1',
      className
    )}>
      <svg className="w-2.5 h-2.5 text-fg3 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7" cy="7" r="5" />
        <line x1="11" y1="11" x2="14.5" y2="14.5" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="bg-transparent border-none outline-none text-fg text-[11px] flex-1 caret-acc font-mono min-w-0 placeholder:text-fg3/50 leading-none"
        value={filter}
        onChange={e => { onFilterChange(e.target.value); setDropdownOpen(true) }}
        onFocus={() => filter && setDropdownOpen(true)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search aircraft — callsign, ICAO, operator, type..."
      />
      {filter ? (
        <button
          onClick={() => { onFilterChange(''); setDropdownOpen(false); inputRef.current?.focus() }}
          className="text-fg3 hover:text-fg text-[11px] cursor-pointer shrink-0 leading-none"
          title="clear"
        >x</button>
      ) : (
        <kbd className="hidden sm:inline-block text-[8px] text-fg3 border border-border px-1 py-px bg-bg2/60 shrink-0 pointer-events-none leading-none"
             title="press / to focus search">/</kbd>
      )}
      {dropdownOpen && suggestions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute top-full left-0 right-0 mt-0.5 z-50 bg-bg1 border border-border2 shadow-lg max-h-80 overflow-y-auto"
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
                <span className={clsx('text-[9px] px-1 py-[1px] border tabular-nums shrink-0',
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
            up/down navigate · enter opens dossier · esc closes
          </div>
        </div>
      )}
    </div>
  )
}
