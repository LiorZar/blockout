// Fork addition (2026): a retargeted mocap bot keeps a planted knee put on a travelling in-place loop; the clip's own bot plays it as captured (mocap-backlog; fixture skeleton, synthetic numbers); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearMocapClips, clipPose, clipSample, mocapClip, mocapClipPose, registerMocapClip } from '@engine/mocap/clip'
import { kneeCorrection, lockKnees } from '@engine/mocap/contact-lock'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { BONE_INDEX } from '@engine/mocap/rig'
import { personDims } from '@engine/skeleton'
import { fixtureSource } from './mocap-fixture'
import { syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

/**
 * One loop of a knee, 120 samples at 60 /s, the body travelling 0.5 m/s (a
 * 1 m stride): planted over samples 20…80, drifting back 0.3 mm and aside
 * 0.1 mm a sample over the ground; a swing forward to the next plant
 * elsewhere. `x`, `z` in the pose (the travel added back), plant 20 at 0.
 */
function knee(): { x: number[]; z: number[]; low: number[]; C: Float64Array } {
  const n = 120
  const rate = 60
  const S = 1
  const C = Float64Array.from({ length: n + 1 }, (_, i) => (0.5 * i) / rate)
  const x: number[] = []
  const z: number[] = []
  const low: number[] = []
  for (let k = 0; k <= n; k++) {
    const planted = k >= 20 && k <= 80
    // The swing's progress from the last plant's end (sample 80, or 80 a loop before) to the next plant.
    const f = k > 80 ? (k - 80) / 60 : (k + 40) / 60
    const ground = planted ? 0.0003 * (k - 20) : k > 80 ? 0.018 - (S + 0.018) * f : (S + 0.018) * (1 - f)
    z.push(ground + C[k]!)
    x.push(planted ? 0.0001 * (k - 20) : 0.006 * (1 - f))
    low.push(planted ? 0 : 0.05)
  }
  return { x, z, low, C }
}

describe('a retargeted bot keeps a planted knee put', () => {
  it('the correction undoes the drift over the plant and eases back to nothing over the swing', () => {
    const { x, z, low, C } = knee()
    const { dx, dz } = kneeCorrection(x, z, low, C, 60)
    for (let k = 20; k < 80; k++) {
      // The corrected knee stays where it planted.
      expect(z[k]! - C[k]! + dz[k]!, `k=${k}`).toBeCloseTo(z[20]! - C[20]!, 9)
      expect(x[k]! + dx[k]!, `k=${k}`).toBeCloseTo(x[20]!, 9)
    }
    expect(Math.abs(dz[79]!)).toBeGreaterThan(0.015)
    // Nothing at the plant, eased over the swing (no step bigger than the drift a sample makes).
    expect(dz[20]).toBe(0)
    for (let k = 0; k < 120; k++) expect(Math.abs(dz[k + 1]! - dz[k]!), `k=${k}`).toBeLessThan(0.002)
    expect(dz[120]).toBe(dz[0])
  })

  it('a knee that never plants, or never lifts, gets nothing', () => {
    const { x, z, C } = knee()
    for (const low of [new Array(121).fill(0.05), new Array(121).fill(0)]) {
      const still = z.map((_, i) => C[i]!)
      const { dx, dz } = kneeCorrection(x, low[0] === 0 ? still : z, low, C, 60)
      expect([...dx, ...dz].every((v) => v === 0)).toBe(true)
    }
  })

  describe('on the bots', () => {
    beforeAll(() => {
      registerMocapBody(MALE, fixtureSource())
      registerMocapBody(FEMALE, fixtureSource(0.9))
      // An in-place loop on the male bot: the thighs swing (a kneeling shuffle).
      const frames = Array.from({ length: 31 }, (_, f) => {
        const a = Math.sin((f / 30) * 2 * Math.PI)
        return { hipLX: 0.3 * a, hipRX: -0.3 * a, kneeL: 1.4, kneeR: 1.4 }
      })
      registerMocapClip('shuffle', syntheticClip(MALE, frames, { loop: true, inPlace: true, grounded: true }))
    })

    afterAll(() => {
      clearMocapClips()
      clearMocapBodies()
    })

    it('the clip’s own bot plays it as captured; another bot’s knees move only by the lock', () => {
      const clip = mocapClip('shuffle')!
      const male = personDims(MALE).mocap!
      const female = personDims(FEMALE).mocap!
      for (let t = 0; t < clip.duration; t += 0.05) {
        const own = clipPose(male, clipSample(clip, t))
        expect(lockKnees(male, clip, t, false, own)).toBe(own)
        const pose = clipPose(female, clipSample(clip, t))
        const locked = lockKnees(female, clip, t, false, pose)
        // The hips and everything above them stay; a knee joint moves level (a few mm up or down at most).
        expect(locked.P[BONE_INDEX.Hips]).toEqual(pose.P[BONE_INDEX.Hips])
        expect(locked.P[BONE_INDEX.Head]).toEqual(pose.P[BONE_INDEX.Head])
        for (const b of [BONE_INDEX.LeftLeg, BONE_INDEX.RightLeg]) expect(Math.abs(locked.P[b]!.y - pose.P[b]!.y), `t=${t.toFixed(2)}`).toBeLessThan(0.003)
      }
      // The pose a consumer sees goes through it.
      expect(mocapClipPose(male, { id: 'shuffle', t: 0.3 })).toEqual(mocapClipPose(male, { id: 'shuffle', t: 0.3 }))
    })
  })
})
