/**
 * Fork: the MiniMax H3 Max export profile, its file-size cap and the limit
 * warnings shown in Deliver and returned by export_shot.
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_PROFILES, getProfile } from '@engine/profiles'
import { encoderMaxKbps, profileWarnings } from '@engine/profile-limits'

describe('MiniMax H3 Max profile', () => {
  const h3 = getProfile('minimax-h3-max')

  it('is a 1080p video profile capped at 15 s and 50 MB', () => {
    expect(h3.id).toBe('minimax-h3-max')
    expect(h3.kind).toBe('video')
    expect(h3.maxDuration).toBe(15)
    expect(h3.recommendedDuration).toBeLessThanOrEqual(15)
    expect(h3.exportWidth).toBe(1920)
    expect(h3.maxFileMB).toBe(50)
    expect(h3.maxPromptChars).toBe(2000)
    expect(h3.refModes[0]).toBe('referenceVideo')
    expect(h3.aspects).toContain('16:9')
    expect(h3.attachHint).toMatch(/video/)
    expect(h3.adherenceClause.length).toBeGreaterThan(80)
  })

  it('leaves the default profile alone', () => {
    expect(BUILTIN_PROFILES[0]!.id).toBe('seedance-2')
    expect(BUILTIN_PROFILES.filter((p) => p.id === 'minimax-h3-max')).toHaveLength(1)
  })
})

describe('encoderMaxKbps', () => {
  const h3 = getProfile('minimax-h3-max')

  it('is undefined for profiles without a file cap', () => {
    expect(encoderMaxKbps(getProfile('seedance-2'), 15)).toBeUndefined()
  })

  it('keeps the worst case (maxrate over duration + a 2 s buffer) under the cap with room for the container', () => {
    for (const d of [1, 5, 10, 15, 30]) {
      const k = encoderMaxKbps(h3, d)!
      expect(k).toBeGreaterThan(0)
      const worstMB = (k * 1000 * (d + 2)) / 8 / 1e6
      expect(worstMB).toBeLessThanOrEqual(50 * 0.92)
    }
  })

  it('allows a generous rate for a 15 s clip (well above CRF 18 grey-box rates)', () => {
    expect(encoderMaxKbps(h3, 15)!).toBeGreaterThan(15000)
  })
})

describe('profileWarnings', () => {
  const h3 = getProfile('minimax-h3-max')

  it('says nothing for a shot inside the limits', () => {
    expect(profileWarnings(h3, { duration: 10, aspect: '16:9' })).toEqual([])
  })

  it('names the cap when the shot is too long', () => {
    const w = profileWarnings(h3, { duration: 18, aspect: '16:9' })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('18.0 s')
    expect(w[0]).toContain('15 s')
    expect(w[0]).toContain('MiniMax H3 Max')
  })

  it('names an aspect the model does not list', () => {
    const w = profileWarnings(h3, { duration: 8, aspect: '2.39:1' })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('2.39:1')
    expect(w[0]).toContain('16:9')
  })

  it('names the cap of every capped profile for a shot one second over it', () => {
    for (const p of BUILTIN_PROFILES.filter((x) => x.maxDuration !== undefined)) {
      const w = profileWarnings(p, { duration: p.maxDuration! + 1, aspect: p.aspects[0]! })
      expect(w).toHaveLength(1)
      expect(w[0]).toContain(`${p.name} takes at most ${p.maxDuration} s`)
    }
    expect(profileWarnings(getProfile('seedance-2'), { duration: 15, aspect: '16:9' })[0]).toContain('Seedance 2.0 takes at most 10 s')
  })

  it('works for upstream profiles too', () => {
    expect(profileWarnings(getProfile('veo-3.1'), { duration: 9, aspect: '16:9' })[0]).toContain('8 s')
  })
})
