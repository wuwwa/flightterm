/** Display source timestamps in the timezone selected by the visitor. */
export const TIME_MODES = Object.freeze({
  LOCAL: 'local',
  UTC: 'utc',
})

export function getTimeMode() {
  try {
    return JSON.parse(localStorage.getItem('ft_cfg') || '{}').timeMode === TIME_MODES.UTC
      ? TIME_MODES.UTC
      : TIME_MODES.LOCAL
  } catch {
    return TIME_MODES.LOCAL
  }
}

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
}

export function localTimeZoneLabel(value = new Date(), mode = getTimeMode()) {
  if (mode === TIME_MODES.UTC) return 'UTC'
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(value instanceof Date ? value : new Date(value))
    .find(({ type }) => type === 'timeZoneName')
  return part?.value || localTimeZone()
}

export function formatLocalTime(value, { seconds = false, zone = true, mode = getTimeMode() } = {}) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value.substring?.(11, 16) || '—' : '—'
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false,
    ...(mode === TIME_MODES.UTC ? { timeZone: 'UTC' } : {}),
  }).format(date)
  return zone ? `${time} ${localTimeZoneLabel(date, mode)}` : time
}

export function formatLocalDateTime(value, { mode = getTimeMode() } = {}) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    ...(mode === TIME_MODES.UTC ? { timeZone: 'UTC' } : {}),
  }).format(date)
}
