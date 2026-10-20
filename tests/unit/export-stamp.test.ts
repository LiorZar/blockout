/**
 * Fork (fix-env): export folder and file stamps are the local wall-clock
 * time, not UTC, in the same YYYY-MM-DD-HH-mm-ss shape.
 */

import { describe, expect, it } from 'vitest'
import { exportStamp } from '@renderer/export/stamp'

describe('exportStamp', () => {
  it('formats the local time, zero-padded', () => {
    expect(exportStamp(new Date(2026, 9, 19, 22, 32, 1))).toBe('2026-10-19-22-32-01')
    expect(exportStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02-03-04-05')
  })

  it('matches the local clock fields, not the UTC ones', () => {
    const d = new Date(Date.UTC(2026, 9, 19, 19, 32, 1))
    const pad = (n: number): string => String(n).padStart(2, '0')
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    expect(exportStamp(d)).toBe(local)
  })

  it('keeps the shape the export names use', () => {
    expect(exportStamp(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/)
  })
})
