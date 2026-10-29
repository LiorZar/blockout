// Fork test (shared-camera-moves T1, docs/plans/2026-10-29-shared-camera-moves.md): the camera-move table Blockout
// shares with Ebook Studio, its ids, names and prompt sentences.
import { describe, expect, it } from 'vitest'
import { SHARED_MOVES, SHARED_MOVE_CATEGORIES, SHARED_MOVES_VERSION, sharedMove, sharedMoveSentence } from '@engine/camera-move-names'

const IDS: Record<string, string[]> = {
  tripod: ['static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down'],
  dolly: ['dolly-in', 'dolly-out', 'crash-in', 'dolly-zoom'],
  slider: ['truck-left', 'truck-right'],
  orbit: ['orbit', 'orbit-360', 'arc-left', 'arc-right'],
  vertical: ['pedestal-up', 'pedestal-down', 'crane-up', 'crane-down'],
  optical: ['zoom-in', 'zoom-out', 'snap-zoom', 'snap-zoom-out'],
  focus: ['focus-reveal', 'rack-focus'],
  obstacle: ['reveal-from-behind', 'fly-through'],
  scale: ['macro-zoom', 'cosmic-zoom'],
  aerial: ['drone-flyover', 'drone-reveal', 'drone-orbit', 'top-down', 'fpv-dive'],
  stylized: ['handheld', 'whip-pan', 'dutch-roll'],
  tracking: ['lead', 'follow', 'side-track-left', 'side-track-right', 'pov-walk']
}

describe('shared camera moves', () => {
  it('is version 1 with the 42 shared ids, in table order by category', () => {
    expect(SHARED_MOVES_VERSION).toBe(1)
    expect(SHARED_MOVES).toHaveLength(42)
    expect(SHARED_MOVE_CATEGORIES.map((c) => c.id)).toEqual(Object.keys(IDS))
    expect(SHARED_MOVES.map((m) => m.id)).toEqual(Object.values(IDS).flat())
    for (const [category, ids] of Object.entries(IDS))
      for (const id of ids) expect(sharedMove(id)?.category, id).toBe(category)
  })

  it('looks a move up by its shared id only', () => {
    expect(sharedMove('dolly-in')?.name).toBe('Dolly in')
    expect(sharedMove('orbit')?.name).toBe('Orbit 180')
    expect(sharedMove('handheld')?.blockout).toBe('rig')
    expect(sharedMove('macro-zoom')?.blockout).toBe('prompt')
    expect(sharedMove('slow-push-in')).toBeUndefined()
  })

  it('a move is speed-able exactly when its sentence has {speed}', () => {
    expect(sharedMove('dolly-in')?.speedable).toBe(true)
    expect(sharedMove('crash-in')?.speedable).toBe(false)
    for (const m of SHARED_MOVES) expect(m.speedable, m.id).toBe(m.prompt.includes('{speed}'))
  })

  it('drops {speed} and its space from the sentence', () => {
    expect(sharedMoveSentence('dolly-in')).toBe('The camera dollies forward toward the subject on a smooth track; the subject and the background stay in place.')
    expect(sharedMoveSentence('crash-in')).toBe(sharedMove('crash-in')!.prompt)
    for (const m of SHARED_MOVES) {
      const s = sharedMoveSentence(m.id)
      expect(s, m.id).not.toContain('{speed}')
      expect(s, m.id).not.toContain('  ')
      expect(s.length, m.id).toBeLessThanOrEqual(200)
    }
    expect(sharedMoveSentence('slow-push-in')).toBe('')
  })
})
