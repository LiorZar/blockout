/**
 * Fork (export-look T3): export profiles for the other video-input models on
 * Scenario (CLAUDE.md): LTX 2.3 Render to Real, Kling V3 Omni and Seedance
 * 2.5, with the limit fields they need (minDuration, maxFrames,
 * resolutionCaps) and their warnings.
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_PROFILES, getProfile } from '@engine/profiles'
import { profileWarnings } from '@engine/profile-limits'
import { generatePrompt } from '@engine/prompt'
import { createProject } from '@engine/schema'

const ltx = getProfile('ltx-2.3-render-to-real')
const kling = getProfile('kling-v3-omni')
const seedance = getProfile('seedance-2.5')

describe('the new model profiles', () => {
  it('exist once each and leave the default and the upstream profiles alone', () => {
    for (const id of ['ltx-2.3-render-to-real', 'kling-v3-omni', 'seedance-2.5']) {
      expect(BUILTIN_PROFILES.filter((p) => p.id === id)).toHaveLength(1)
      expect(getProfile(id).kind).toBe('video')
    }
    expect(BUILTIN_PROFILES[0]!.id).toBe('seedance-2')
    expect(getProfile('ltx-2.3').maxDuration).toBe(10)
    expect(getProfile('kling-2').maxDuration).toBe(10)
  })

  it('LTX 2.3 Render to Real: 720p up to ~6 s, 480p up to ~15 s, 361 frames, the clip in as the render', () => {
    expect(ltx.maxDuration).toBe(15)
    expect(ltx.maxFrames).toBe(361)
    expect(ltx.resolutionCaps).toEqual([
      { label: '720p', maxDuration: 6 },
      { label: '480p', maxDuration: 15 }
    ])
    expect(ltx.exportWidth).toBe(1280)
    expect(ltx.refModes).toEqual(['referenceVideo'])
    expect(ltx.promptStyle).toBe('previs')
    expect(ltx.attachHint).toMatch(/480p/)
  })

  it('Kling V3 Omni: 3–10 s base video, a 2500-character prompt', () => {
    expect(kling.minDuration).toBe(3)
    expect(kling.maxDuration).toBe(10)
    expect(kling.maxPromptChars).toBe(2500)
    expect(kling.refModes).toEqual(['referenceVideo'])
    expect(kling.promptStyle).toBe('previs')
    expect(kling.attachHint).toMatch(/base/)
    // It follows the camera loosely: the clause asks for the camera outright.
    expect(kling.adherenceClause).toMatch(/camera/)
  })

  it('Seedance 2.5: a guiding reference video at 720p, the generic motion-reference prompt', () => {
    expect(seedance.minDuration).toBe(4)
    expect(seedance.maxDuration).toBe(15)
    expect(seedance.exportWidth).toBe(1280)
    expect(seedance.refModes).toEqual(['referenceVideo'])
    expect(seedance.promptStyle).toBeUndefined()
    expect(seedance.attachHint).toMatch(/3/)
  })
})

describe('profileWarnings with the new limits', () => {
  it('says nothing inside every limit', () => {
    expect(profileWarnings(ltx, { duration: 5, aspect: '16:9', fps: 24 })).toEqual([])
    expect(profileWarnings(kling, { duration: 5, aspect: '16:9', fps: 24 })).toEqual([])
    expect(profileWarnings(seedance, { duration: 10, aspect: '9:16', fps: 24 })).toEqual([])
  })

  it('names the minimum for a shot that is too short', () => {
    const w = profileWarnings(kling, { duration: 2, aspect: '16:9', fps: 24 })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('2.0 s')
    expect(w[0]).toContain('Kling V3 Omni')
    expect(w[0]).toContain('at least 3 s')
    expect(profileWarnings(seedance, { duration: 3, aspect: '16:9' })[0]).toContain('at least 4 s')
  })

  it('points a shot past the 720p tier to 480p', () => {
    const w = profileWarnings(ltx, { duration: 10, aspect: '16:9', fps: 24 })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('720p')
    expect(w[0]).toContain('480p')
    expect(w[0]).toContain('10.0 s')
  })

  it('names the frame cap when the duration fits but the frame rate does not', () => {
    const w = profileWarnings(ltx, { duration: 14, aspect: '16:9', fps: 30 })
    expect(w.some((x) => x.includes('420 frames') && x.includes('361'))).toBe(true)
    expect(profileWarnings(ltx, { duration: 15, aspect: '16:9', fps: 24 }).some((x) => x.includes('frames'))).toBe(false)
  })

  it('gives one warning, the duration cap, for a shot past the longest tier', () => {
    const w = profileWarnings(ltx, { duration: 16, aspect: '16:9', fps: 24 })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('at most 15 s')
  })
})

describe('the prompt for the new profiles', () => {
  it('ends with the profile clause for the previs models and the motion-reference directive for Seedance 2.5', () => {
    const doc = createProject('P')
    const scene = doc.scenes[0]!
    const shot = scene.shots[0]!
    for (const p of [ltx, kling]) expect(generatePrompt(scene, shot, p).trim().endsWith(p.adherenceClause)).toBe(true)
    expect(generatePrompt(scene, shot, seedance)).toContain('motion reference')
    expect(generatePrompt(scene, shot, kling).length).toBeLessThanOrEqual(2500)
  })
})
