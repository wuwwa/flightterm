// ── MapQuadrants (v5.7.3 — clickable layer toggles + smart defaults) ──────
// User feedback after v5.7.2: "Too much showing. Certain things should be
// a filter and toggleable. Figure out what's important and be on by default."
//
// Approach:
//   1. Each panel has its own layer-on/off state (lifted to MapQuadrants).
//   2. Defaults: signal ON, noise OFF. See DEFAULT_ACTIVE below for the
//      reasoning per layer.
//   3. The count chips in the headline strip are now buttons. Click to
//      toggle. ON = colored, OFF = dimmed grey. Clicking flips visibility
//      on the underlying NasMap by recomputing its categoryFilter.
//   4. Named-item pills (line 2) stay informative-only — they're driven
//      by ranked data and don't need toggle UI.

import { useState, useCallback, useMemo } from 'react'
import NasMap from './NasMap'
import { useMapData } from '../../hooks/useMapData'

// All layers each category can show. Order = display order in the chip strip.
const LAYERS = {
  traffic:     ['anomalies', 'routeDevs', 'flights', 'ifr', 'tracon'],
  weather:     ['sigmets', 'wxCells', 'pireps'],
  constraints: ['tfrs', 'flowPrograms', 'notams', 'cascades'],
  geo:         ['quakes', 'volcanoes', 'fires', 'events', 'webcams'],
}

// Default ON: things you'd want flagged unprompted (anomalies, severe wx,
// active restrictions, significant geo events). Default OFF: things that
// drown the signal at CONUS scale (3K background flights, 200+ routine
// PIREPs, thousands of NOTAMs, 700 hotspots from FIRMS).
const DEFAULT_ACTIVE = {
  traffic:     { anomalies: true, routeDevs: true, flights: false, ifr: false, tracon: false },
  weather:     { sigmets: true, wxCells: true, pireps: false },
  constraints: { tfrs: true, flowPrograms: true, notams: false, cascades: false },
  geo:         { quakes: true, volcanoes: true, fires: false, events: false, webcams: false },
}

const CATEGORIES = {
  traffic:     { title: 'Traffic',     color: 'text-acc' },
  weather:     { title: 'Weather',     color: 'text-mag' },
  constraints: { title: 'Constraints', color: 'text-ylw' },
  geo:         { title: 'Geo events',  color: 'text-cyn' },
}

// Per-layer chip metadata — label and color used by the toggle chips
// in the headline strip. Color matches the on-map symbology so the chip
// reads as "this is the thing that controls those red circles."
const LAYER_META = {
  // traffic
  anomalies: { label: 'anomalies', color: 'red' },
  routeDevs: { label: 'off-route', color: 'ylw' },
  flights:   { label: 'flights',   color: 'fg3' },
  ifr:       { label: 'IFR',       color: 'grn' },
  tracon:    { label: 'tracon',    color: 'cyn' },
  // weather
  sigmets:   { label: 'SIGMETs', color: 'red' },
  wxCells:   { label: 'wx alerts', color: 'mag' },
  pireps:    { label: 'PIREPs', color: 'ylw' },
  // constraints
  tfrs:         { label: 'TFRs', color: 'red' },
  flowPrograms: { label: 'flow', color: 'ylw' },
  notams:       { label: 'NOTAMs', color: 'org' },
  cascades:     { label: 'cascades', color: 'red' },
  // geo
  quakes:    { label: 'quakes',    color: 'ylw' },
  volcanoes: { label: 'volcanoes', color: 'red' },
  fires:     { label: 'fires',     color: 'org' },
  events:    { label: 'events',    color: 'mag' },
  webcams:   { label: 'cams',      color: 'cyn' },
}

// Map color slug to background/text/border tailwind classes. Tailwind purges
// unused classes so we have to write them out literally — no string interp.
const COLOR_CLASS_ON = {
  red: 'bg-red/15 text-red border-red/40 hover:bg-red/25',
  ylw: 'bg-ylw/15 text-ylw border-ylw/40 hover:bg-ylw/25',
  grn: 'bg-grn/15 text-grn border-grn/40 hover:bg-grn/25',
  cyn: 'bg-cyn/15 text-cyn border-cyn/40 hover:bg-cyn/25',
  mag: 'bg-mag/15 text-mag border-mag/40 hover:bg-mag/25',
  org: 'bg-org/15 text-org border-org/40 hover:bg-org/25',
  fg3: 'bg-fg3/15 text-fg2 border-fg3/30 hover:bg-fg3/25',
  acc: 'bg-acc/15 text-acc border-acc/40 hover:bg-acc/25',
}
const CHIP_OFF = 'bg-transparent text-fg3/50 border-border/40 hover:text-fg3 hover:border-border/70'

const KIND_TONE = {
  critical:    'bg-red/20 text-red border-red/40',
  high:        'bg-ylw/15 text-ylw border-ylw/40',
  medium:      'bg-bg2 text-fg2 border-border',
  'off-route': 'bg-ylw/10 text-ylw border-ylw/30',
  convective:  'bg-red/20 text-red border-red/40',
  ice:         'bg-cyn/15 text-cyn border-cyn/40',
  turb:        'bg-ylw/15 text-ylw border-ylw/40',
  sigmet:      'bg-bg2 text-fg2 border-border',
}

const THUMBNAIL_VIEW = { center: [38.5, -96], zoom: 3 }
const PRIMARY_DEFAULT_VIEW = { center: [39, -96], zoom: 4 }

function ToggleChip({ layer, count, active, onToggle }) {
  const meta = LAYER_META[layer] || { label: layer, color: 'fg3' }
  const cls = active ? COLOR_CLASS_ON[meta.color] : CHIP_OFF
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(layer) }}
      className={`inline-flex items-baseline gap-1 px-1 py-px border rounded cursor-pointer transition-colors ${cls}`}
      title={active ? `Hide ${meta.label}` : `Show ${meta.label}`}
    >
      <span className="tabular-nums">{(count || 0).toLocaleString()}</span>
      <span className="opacity-90">{meta.label}</span>
    </button>
  )
}

function HeadlineStrip({ category, counts = {}, headlines = [], activeLayers, onToggleLayer, compactSize }) {
  const layerKeys = LAYERS[category] || []
  const cards = headlines.filter(h => h.cat === category).slice(0, compactSize ? 2 : 3)

  return (
    <div className="shrink-0 px-2 py-0.5 bg-bg2/60 border-b border-border space-y-0.5">
      {/* Line 1 — toggle chips. Always render every available layer so the
          OFF chips are still visible (and clickable to turn them on). */}
      <div className="flex items-center gap-1 flex-wrap text-[9px]">
        {layerKeys.map(k => (
          <ToggleChip
            key={k}
            layer={k}
            count={counts[k]}
            active={!!activeLayers[k]}
            onToggle={onToggleLayer}
          />
        ))}
      </div>
      {/* Line 2 — top-N named items. Only render if anything's noteworthy. */}
      {cards.length > 0 && (
        <div className={`flex items-center ${compactSize ? 'gap-1' : 'gap-1.5'} flex-wrap text-[9px]`}>
          {cards.map((h, i) => (
            <span
              key={i}
              className={`inline-flex items-baseline gap-1 px-1 py-px border rounded ${KIND_TONE[h.kind] || KIND_TONE.medium}`}
              title={h.detail}
            >
              <span className="font-mono">{h.label}</span>
              {!compactSize && h.detail && <span className="opacity-70 truncate max-w-32">{h.detail}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function PanelHeader({ category, color, interactive }) {
  return (
    <div className={`shrink-0 py-0.5 px-2 text-[9px] uppercase tracking-wider bg-bg2 border-b border-border flex items-baseline gap-1.5 ${color}`}>
      <span className="font-bold">{CATEGORIES[category].title}</span>
      <span className="ml-auto text-fg3/40 text-[8px] normal-case tracking-normal">
        {interactive ? '' : 'click to focus'}
      </span>
    </div>
  )
}

export default function MapQuadrants({ backendOk, flights, trackedIcaos, trackHistory, onSelectAirport }) {
  const [categoryOrder, setCategoryOrder] = useState(['traffic', 'weather', 'constraints', 'geo'])
  const [primaryView, setPrimaryView] = useState(PRIMARY_DEFAULT_VIEW)

  // Per-category active-layer state. Defaults are the curated "show signal,
  // hide noise" set above. Toggles are session-only — refresh resets to
  // defaults so a user who turned everything on doesn't get burned later.
  const [activeLayers, setActiveLayers] = useState(DEFAULT_ACTIVE)

  const toggleLayer = useCallback((catKey) => (layerKey) => {
    setActiveLayers((prev) => ({
      ...prev,
      [catKey]: { ...prev[catKey], [layerKey]: !prev[catKey][layerKey] },
    }))
  }, [])

  // Per-category {counts, headlines} reported by each NasMap.
  const [summaries, setSummaries] = useState({})
  const makeSummaryHandler = useCallback((catKey) => (data) => {
    setSummaries((prev) => {
      const cur = prev[catKey]
      if (cur && JSON.stringify(cur.counts) === JSON.stringify(data.counts) &&
          JSON.stringify(cur.headlines) === JSON.stringify(data.headlines)) {
        return prev
      }
      return { ...prev, [catKey]: data }
    })
  }, [])

  const promoteToPrimary = (categoryKey) => {
    setCategoryOrder((order) => {
      const idx = order.indexOf(categoryKey)
      if (idx <= 0) return order
      const next = [...order]
      ;[next[0], next[idx]] = [next[idx], next[0]]
      return next
    })
  }

  // Derive the categoryFilter array passed to each NasMap from the active
  // layers in that category. Memoized per-category so identity stability
  // keeps NasMap's filter-sync useEffect from churning.
  const categoryFilters = useMemo(() => {
    const out = {}
    for (const cat of Object.keys(LAYERS)) {
      out[cat] = LAYERS[cat].filter(k => activeLayers[cat]?.[k])
    }
    return out
  }, [activeLayers])

  const primaryKey = categoryOrder[0]
  const thumbKeys = categoryOrder.slice(1)
  const primary = CATEGORIES[primaryKey]

  // Lifted data fetch — runs ONCE for all NasMap instances on the page.
  // Geo layers are gated on whether any panel currently wants them, so a
  // user with all geo toggles off doesn't waste FIRMS/USGS quota.
  const mapData = useMapData({
    backendOk,
    geoLayers: {
      fires:     activeLayers.geo?.fires,
      events:    activeLayers.geo?.events,
      quakes:    activeLayers.geo?.quakes,
      volcanoes: activeLayers.geo?.volcanoes,
      webcams:   activeLayers.geo?.webcams,
    },
  })

  const sharedProps = {
    backendOk, flights, trackedIcaos, trackHistory, onSelectAirport,
    compact: true,
    mapData,
  }

  return (
    <div className="bg-bg1 border-t-2 border-acc/40">
      {/* Mobile fallback unchanged. */}
      <div className="lg:hidden" style={{ height: 'min(78vh, 760px)', minHeight: 520 }}>
        <NasMap {...sharedProps} compact={false} />
      </div>

      {/* Desktop: primary + thumbnail strip */}
      <div
        className="hidden lg:grid lg:grid-cols-[1fr_18rem] lg:gap-px lg:bg-border"
        style={{ height: 'min(82vh, 820px)', minHeight: 600 }}
      >
        {/* Primary */}
        <div className="flex flex-col min-h-0 bg-bg1 overflow-hidden">
          <PanelHeader category={primaryKey} color={primary.color} interactive />
          <HeadlineStrip
            category={primaryKey}
            counts={summaries[primaryKey]?.counts}
            headlines={summaries[primaryKey]?.headlines}
            activeLayers={activeLayers[primaryKey]}
            onToggleLayer={toggleLayer(primaryKey)}
          />
          <div className="flex-1 min-h-0">
            <NasMap
              {...sharedProps}
              categoryFilter={categoryFilters[primaryKey]}
              viewState={primaryView}
              onViewChange={setPrimaryView}
              onSummaryChange={makeSummaryHandler(primaryKey)}
            />
          </div>
        </div>

        {/* Thumbnails */}
        <div className="hidden lg:grid lg:grid-rows-3 lg:gap-px lg:bg-border">
          {thumbKeys.map((key) => {
            const cat = CATEGORIES[key]
            return (
              <div
                key={key}
                className="group flex flex-col min-h-0 bg-bg1 overflow-hidden border border-transparent hover:border-acc/60 transition-colors"
              >
                {/* Header acts as the click-target for promoting this panel.
                    Putting the click on the header (not the whole tile) lets
                    the headline-strip toggle chips be clickable without
                    fighting for the tap. */}
                <button
                  type="button"
                  onClick={() => promoteToPrimary(key)}
                  className="text-left cursor-pointer"
                  title={`Focus ${cat.title}`}
                >
                  <PanelHeader category={key} color={cat.color} />
                </button>
                <HeadlineStrip
                  category={key}
                  counts={summaries[key]?.counts}
                  headlines={summaries[key]?.headlines}
                  activeLayers={activeLayers[key]}
                  onToggleLayer={toggleLayer(key)}
                  compactSize
                />
                {/* Map is non-interactive — clicks slide off into the parent's
                    promote button. The dim opacity hints "this is a glance,
                    not a workspace." */}
                <button
                  type="button"
                  onClick={() => promoteToPrimary(key)}
                  className="flex-1 min-h-0 cursor-pointer text-left"
                  title={`Focus ${cat.title}`}
                >
                  <div className="h-full pointer-events-none opacity-90 group-hover:opacity-100">
                    <NasMap
                      {...sharedProps}
                      categoryFilter={categoryFilters[key]}
                      viewState={THUMBNAIL_VIEW}
                      staticView
                      onSummaryChange={makeSummaryHandler(key)}
                    />
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
