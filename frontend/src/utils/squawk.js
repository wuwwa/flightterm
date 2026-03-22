const SQUAWK_CODES = {
  '7700': { label: 'EMERGENCY',    color: 'text-red' },
  '7600': { label: 'RADIO FAIL',   color: 'text-ylw' },
  '7500': { label: 'HIJACK',       color: 'text-red' },
  '1200': { label: 'VFR',          color: 'text-cyn' },
  '1000': { label: 'IFR (EU)',     color: 'text-fg3' },
  '2000': { label: 'OCEANIC',      color: 'text-fg3' },
  '0000': { label: 'UNASSIGNED',   color: 'text-fg3' },
}

export function squawkInfo(code) {
  if (!code) return null
  return SQUAWK_CODES[code] || null
}

export function squawkLabel(code) {
  if (!code) return '—'
  const info = SQUAWK_CODES[code]
  return info ? `${code} ${info.label}` : code
}

export function squawkColor(code) {
  if (!code) return 'text-fg3'
  return SQUAWK_CODES[code]?.color || 'text-fg3'
}
