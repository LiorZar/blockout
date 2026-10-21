// Fork addition (2026): the Fight Director on mocap bots with weapons — blade and club clips, the knife stab, guns' aim clips, the weapon on the hand bone, the keyframe fallback (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import type { FightDoc } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'
import { GUARD, registerFightClips } from './mocap-fight-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerFightClips(MALE)
  // A two-handed sword: a sweep across (its first cut by 0.8 s), then an overhead chop (by 1.5 s).
  const cut1 = { shoulderRX: -1.4, shoulderRZ: -0.3, elbowR: 0.4, shoulderLX: -1.3, elbowL: 0.6, torsoY: 0.5 }
  const up = { shoulderRX: -2.6, elbowR: 0.6, shoulderLX: -2.5, elbowL: 0.7 }
  const cut2 = { shoulderRX: -1.2, elbowR: 0.3, shoulderLX: -1.1, elbowL: 0.4, torsoX: 0.2 }
  registerMocapClip('greatSword', syntheticClip(MALE, [...sweep(GUARD, cut1, 24), ...sweep(cut1, up, 12).slice(1), ...sweep(up, cut2, 10).slice(1), ...sweep(cut2, GUARD, 12).slice(1)], { inPlace: false }))
  registerMocapClip('knifeStab', syntheticClip(MALE, [...sweep(GUARD, { ...GUARD, shoulderRX: -1.5, elbowR: 0.1 }, 13), ...sweep({ ...GUARD, shoulderRX: -1.5, elbowR: 0.1 }, GUARD, 13).slice(1)], { inPlace: false }))
  const aim = { shoulderRX: -1.5, elbowR: 0.05, shoulderLX: -1.4, elbowL: 0.4, shoulderLZ: -0.3 }
  registerMocapClip('pistolAim', syntheticClip(MALE, sweep(aim, { ...aim, torsoX: 0.02 }, 31), { loop: true, inPlace: false }))
  registerMocapClip('rifleAim', syntheticClip(MALE, sweep(aim, { ...aim, torsoX: 0.02 }, 31), { loop: true, inPlace: false }))
  registerMocapClip('rifleIdle', syntheticClip(MALE, sweep({ shoulderRX: -0.3, elbowR: 1.2 }, { shoulderRX: -0.3, elbowR: 1.25 }, 31), { loop: true, inPlace: false }))
  registerMocapClip('pistolIdle', syntheticClip(MALE, sweep({ shoulderRX: -0.5, elbowR: 1 }, { shoulderRX: -0.5, elbowR: 1.05 }, 31), { loop: true, inPlace: false }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

function solve(script: string, weapons: [string | null, string | null], hands: ['L' | 'R', 'L' | 'R'] = ['R', 'R']) {
  const parsed = parseFightScript(script, ['A', 'B'])
  if (!('beats' in parsed)) throw new Error(parsed.error)
  const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
  const f = (id: string, assetId: string, x: number, w: string | null, hand: 'L' | 'R'): FighterInput => ({ entityId: id, assetId, scale: 1, start: { x, y: 0, z: 0 }, ...(w ? { weapons: [{ assetId: w, hand, scale: 1 }] } : {}) })
  return solveFight(fight, [f('a', MALE, -0.6, weapons[0], hands[0]), f('b', FEMALE, 0.6, weapons[1], hands[1])], { duration: 20, fps: 24 })
}

describe('the Fight Director on mocap bots, armed', { timeout: 30_000 }, () => {
  it('a blade slashes with the great sword clip, both cuts landing with the blade', () => {
    const sol = solve('A slash to head -> hit, hit power 0.6', ['prop.sword', null])
    const b = sol.report.beats[0]!
    expect(b.plays).toBe('mocap:greatSword+greatSword')
    expect(b.effectors).toEqual(['handR', 'handR'])
    for (const e of b.contactErrorM) expect(e).toBeLessThan(0.001)
    // One clip run through both cuts: no crossfade between them.
    const run = sol.tracks[0].filter((m) => m.clip?.id === 'greatSword').map((m) => m.clip!.at)
    for (let i = 1; i < run.length; i++) expect(run[i]!).toBeGreaterThan(run[i - 1]!)
  })

  it('a sword in the left hand plays the clips mirrored, the blows from the left hand', () => {
    const sol = solve('A slash to body -> hit, hit power 0.6', ['prop.sword', null], ['L', 'R'])
    const b = sol.report.beats[0]!
    expect(b.effectors).toEqual(['handL', 'handL'])
    expect(sol.tracks[0].filter((m) => m.clip?.id === 'greatSword').every((m) => m.clip!.mirror)).toBe(true)
    for (const e of b.contactErrorM) expect(e).toBeLessThan(0.001)
  })

  it('a knife stabs; the same moves unarmed keep their keyframes', () => {
    expect(solve('A stab to body -> hit power 0.6', ['prop.knife', null]).report.beats[0]!.plays).toBe('mocap:knifeStab')
    const bare = solve('A slash to body -> hit, hit power 0.6', [null, null]).report.beats[0]!
    expect(bare.plays.startsWith('mocap:')).toBe(false)
    for (const e of bare.contactErrorM) expect(e).toBeLessThan(0.001)
  })

  it('a gun aims with its clip and the barrel line meets the target; a gunman idles on its gun ready', () => {
    for (const [gun, clip, idle] of [['prop.pistol', 'pistolAim', 'pistolIdle'], ['prop.rifle', 'rifleAim', 'rifleIdle']]) {
      const sol = solve('A shoot to body -> hit', [gun!, null])
      const b = sol.report.beats[0]!
      expect(b.plays).toBe(`mocap:${clip}`)
      expect(b.contactErrorM[0]).toBeLessThan(0.001)
      expect(sol.tracks[0][0]!.clip?.id).toBe(idle)
    }
  })
})
