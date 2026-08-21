import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { searchAircraft } from '../services/search'

export default function AircraftSearchBox({ filter, onFilterChange, onLiveSelect, className }) {
  const [suggestions, setSuggestions] = useState([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [searchState, setSearchState] = useState('idle')
  const inputRef = useRef(null)
  const dropdownRef = useRef(null)
  const debounceTimerRef = useRef(null)
  const requestRef = useRef(0)
  const resultQueryRef = useRef('')
  const listboxId = useId()

  const openAircraftDetails = (icao, callsign) => {
    const suffix = callsign ? `&cs=${encodeURIComponent(callsign)}` : ''
    window.dispatchEvent(new CustomEvent('flightterm:open-overlay', { detail: { hash: `#flight=${icao}${suffix}` } }))
    setDropdownOpen(false)
  }

  const chooseResult = (result) => {
    if (result.live && onLiveSelect?.(result)) {
      setDropdownOpen(false)
      return
    }
    openAircraftDetails(result.icao, result.callsign)
  }

  useEffect(() => {
    const requestId = ++requestRef.current
    const query = filter.trim()
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    if (query.length < 2) {
      setSuggestions([])
      setSearchState('idle')
      resultQueryRef.current = ''
      return
    }
    setSuggestions([])
    setHighlighted(0)
    setSearchState('searching')
    debounceTimerRef.current = setTimeout(() => {
      searchAircraft(query, { limit: 10 })
        .then(d => {
          if (requestRef.current !== requestId) return
          const results = d.results || []
          resultQueryRef.current = query
          setSuggestions(results)
          setHighlighted(0)
          setSearchState(results.length ? 'ready' : 'empty')
        })
        .catch(() => {
          if (requestRef.current !== requestId) return
          setSuggestions([])
          resultQueryRef.current = ''
          setSearchState('error')
        })
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
        if (document.querySelector('[aria-modal="true"]')) return
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
      const query = filter.trim()
      if (query.length < 2) return
      const s = suggestions[highlighted]
      if (s && resultQueryRef.current === query) { chooseResult(s); return }
      const requestId = ++requestRef.current
      setSearchState('searching')
      searchAircraft(query, { limit: 1 })
        .then(d => {
          if (requestRef.current !== requestId) return
          const top = d.results?.[0]
          if (top) chooseResult(top)
          else setSearchState('empty')
        })
        .catch(() => { if (requestRef.current === requestId) setSearchState('error') })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!dropdownOpen) setDropdownOpen(true)
      if (suggestions.length) setHighlighted(h => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestions.length) setHighlighted(h => Math.max(h - 1, 0))
    } else if (e.key === 'Escape') {
      setDropdownOpen(false)
    }
  }

  const query = filter.trim()
  const popupOpen = dropdownOpen && query.length >= 2

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
        className="bg-transparent border-none outline-none text-fg text-[10px] flex-1 caret-acc font-mono min-w-0 placeholder:text-fg3/50 leading-none"
        value={filter}
        onChange={e => { onFilterChange(e.target.value); setDropdownOpen(true) }}
        onFocus={() => query && setDropdownOpen(true)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search live flights or aircraft records…"
        role="combobox"
        aria-label="Search live flights or aircraft records"
        aria-expanded={popupOpen}
        aria-controls={listboxId}
        aria-activedescendant={popupOpen && suggestions[highlighted] && resultQueryRef.current === query ? `${listboxId}-${highlighted}` : undefined}
        aria-autocomplete="list"
      />
      {filter ? (
        <button
          onClick={() => { onFilterChange(''); setDropdownOpen(false); setSearchState('idle'); inputRef.current?.focus() }}
          className="text-fg3 hover:text-fg text-[11px] cursor-pointer shrink-0 leading-none"
          title="clear"
          aria-label="Clear flight filter"
        >x</button>
      ) : (
        <kbd className="hidden sm:inline-block text-[9px] text-fg3 border border-border px-1 py-px bg-bg2/60 shrink-0 pointer-events-none leading-none"
             title="press / to focus search">/</kbd>
      )}
      {popupOpen && (
        <div
          ref={dropdownRef}
          id={listboxId}
          role="listbox"
          aria-label="Aircraft records"
          className="absolute top-full left-0 right-0 mt-0.5 z-50 bg-bg1 border border-border2 shadow-lg max-h-80 overflow-y-auto"
        >
          {searchState === 'searching' && <div className="px-2 py-2 text-[10px] text-fg3" role="status">Searching…</div>}
          {searchState === 'empty' && <div className="px-2 py-2 text-[10px] text-fg3" role="status">No results</div>}
          {searchState === 'error' && <div className="px-2 py-2 text-[10px] text-ylw" role="status">Search unavailable</div>}
          {searchState === 'ready' && suggestions.map((s, i) => {
            const active = i === highlighted
            return (
              <div
                key={s.icao}
                id={`${listboxId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={active}
                onMouseEnter={() => setHighlighted(i)}
                onMouseDown={(event) => { event.preventDefault(); chooseResult(s) }}
                className={clsx(
                  'w-full text-left px-2 py-1 border-b border-white/3 last:border-b-0 cursor-pointer flex items-start gap-2 text-[11px]',
                  active ? 'bg-acc/15' : 'hover:bg-bg2/60'
                )}
              >
                <span className={clsx('text-[9px] px-1 py-[1px] border tabular-nums shrink-0 mt-px',
                  s.live ? 'border-grn/50 text-grn' : 'border-border text-fg3')}>
                  {s.live ? 'select live' : 'open record'}
                </span>
                <div className="min-w-0 flex-1 flex flex-col sm:contents">
                  <span className="text-fg font-mono w-auto sm:w-20 shrink-0 truncate">{s.callsign || s.icao}</span>
                  <span className="sm:hidden text-fg3 text-[10px] truncate">{[s.acType, s.acReg, s.acOperator].filter(Boolean).join(' · ')}</span>
                </div>
                <span className="hidden sm:inline text-fg3 font-mono text-[10px] shrink-0">{s.icao}</span>
                <span className="hidden sm:inline text-fg2 text-[10px] shrink-0">{s.acType}</span>
                {s.acReg && <span className="hidden sm:inline text-fg3 text-[10px] shrink-0">{s.acReg}</span>}
                <span className="hidden sm:inline text-fg3 truncate text-[10px]">{s.acOperator}</span>
                {s.altFt != null && <span className="text-fg3 text-[9px] tabular-nums shrink-0 ml-auto">{s.altFt.toLocaleString()}ft</span>}
                <span className="hidden sm:inline text-fg3/40 text-[8px] shrink-0">{s.match}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
