import { loadConfig } from '../core/Config.js'

type DateInput = Date | number | string

export interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function toDate(input: DateInput = Date.now()): Date {
  return input instanceof Date ? input : new Date(input)
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return true
  } catch {
    return false
  }
}

export function getConfiguredTimeZone(): string | undefined {
  try {
    const timeZone = loadConfig().timeZone?.trim()
    if (!timeZone) return undefined
    return isValidTimeZone(timeZone) ? timeZone : undefined
  } catch {
    return undefined
  }
}

export function getConfiguredTimeZoneLabel(): string {
  return getConfiguredTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'system'
}

export function getZonedDateParts(input: DateInput = Date.now(), timeZone = getConfiguredTimeZone()): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(toDate(input))

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

export function getZonedDayOfWeek(input: DateInput = Date.now(), timeZone = getConfiguredTimeZone()): number {
  const p = getZonedDateParts(input, timeZone)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

export function zonedDateTimeToTimestamp(
  parts: ZonedDateParts & { millisecond?: number },
  timeZone = getConfiguredTimeZone(),
): number {
  if (!timeZone) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond ?? 0,
    ).getTime()
  }

  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond ?? 0,
  )
  const actual = getZonedDateParts(utcGuess, timeZone)
  const desiredAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
  return utcGuess + (desiredAsUtc - actualAsUtc)
}

export function parseDateOnlyInConfiguredTimeZone(date: string, endOfDay = false): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!match) return new Date(date).getTime()
  const [, y, m, d] = match
  return zonedDateTimeToTimestamp({
    year: Number(y),
    month: Number(m),
    day: Number(d),
    hour: endOfDay ? 23 : 0,
    minute: endOfDay ? 59 : 0,
    second: endOfDay ? 59 : 0,
    millisecond: endOfDay ? 999 : 0,
  })
}

export function formatDateTime(
  input: DateInput = Date.now(),
  options: Intl.DateTimeFormatOptions = {},
): string {
  const timeZone = getConfiguredTimeZone()
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...options,
  }).format(toDate(input))
}

export function formatDate(input: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const timeZone = getConfiguredTimeZone()
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    ...options,
  }).format(toDate(input))
}

export function formatCompactTimestamp(input: DateInput = Date.now()): string {
  const p = getZonedDateParts(input)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`
}

export function formatIsoDisplay(input: DateInput): string {
  const p = getZonedDateParts(input)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}
