import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/core/Config.js', () => ({
  loadConfig: () => ({ timeZone: 'Asia/Shanghai' }),
}))

describe('configured time helpers', () => {
  it('formats UTC instants in configured timezone', async () => {
    const { formatIsoDisplay, formatCompactTimestamp } = await import('../../src/core/time.js')

    expect(formatIsoDisplay('2026-05-19T01:02:03.000Z')).toBe('2026-05-19 09:02')
    expect(formatCompactTimestamp('2026-05-19T01:02:03.000Z')).toBe('20260519-090203')
  })

  it('parses date-only boundaries in configured timezone', async () => {
    const { parseDateOnlyInConfiguredTimeZone } = await import('../../src/core/time.js')

    expect(new Date(parseDateOnlyInConfiguredTimeZone('2026-05-19')).toISOString()).toBe('2026-05-18T16:00:00.000Z')
    expect(new Date(parseDateOnlyInConfiguredTimeZone('2026-05-19', true)).toISOString()).toBe('2026-05-19T15:59:59.999Z')
  })
})
