// Fork addition (2026): gait directions on a body facing −Z; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { buildAsset, type BuiltAsset } from '@renderer/viewport/builders'
import { personDims, poseEffectors } from '@engine/skeleton'
import type { GaitId } from '@engine/types'

const PEOPLE = ['person.man', 'person.woman', 'person.child', 'person.elderly', 'person.mannequinMale', 'person.mannequinFemale']

function pose(assetId: string, gait: GaitId, phase = 0): { b: BuiltAsset; at: (name: string, x?: number, y?: number, z?: number) => Vector3 } {
  const b = buildAsset(assetId)
  b.animate!({ gait, phase, speed: gait === 'stand' || gait === 'sit' || gait === 'gesture' ? 0 : 2, distance: 1, time: 0.4 })
  b.group.updateMatrixWorld(true)
  const at = (name: string, x = 0, y = 0, z = 0): Vector3 => b.group.getObjectByName(name)!.localToWorld(new Vector3(x, y, z))
  return { b, at }
}

/** Head point minus torso base, world. */
function lean(assetId: string, gait: GaitId, phase = 0): Vector3 {
  const { at } = pose(assetId, gait, phase)
  return at('head').sub(at('torso'))
}

describe('gaits on a body facing −Z (forward is −Z)', () => {
  it('run leans the torso forward at every phase', () => {
    for (const id of PEOPLE) {
      for (const phase of [0, 0.25, 0.5, 0.75]) expect(lean(id, 'run', phase).z, `${id} @${phase}`).toBeLessThan(-0.04)
    }
  })

  it('crouch leans the torso forward over the bent knees', () => {
    for (const id of PEOPLE) {
      expect(lean(id, 'crouch').z, id).toBeLessThan(-0.1)
      const { at } = pose(id, 'crouch')
      expect(at('kneeL').z, id).toBeLessThan(at('hipL').z - 0.1)
    }
  })

  it('the elderly stoop forward at rest, in FK and in the rendered rig', () => {
    expect(lean('person.elderly', 'stand').z).toBeLessThan(-0.05)
    const fk = poseEffectors(personDims('person.elderly'), {})
    expect(fk.head.z).toBeLessThan(-0.05)
    expect(lean('person.man', 'stand').z).toBeCloseTo(0, 6)
  })

  it('sit puts the thighs forward and the shins straight down', () => {
    for (const id of PEOPLE) {
      const d = personDims(id)
      const { at } = pose(id, 'sit')
      for (const side of ['L', 'R']) {
        const hip = at(`hip${side}`)
        const knee = at(`knee${side}`)
        const ankle = at(`knee${side}`, 0, -d.lowerLegLen, 0)
        expect(knee.z, `${id} ${side}`).toBeLessThan(hip.z - 0.9 * d.upperLegLen)
        expect(Math.abs(knee.y - hip.y), `${id} ${side}`).toBeLessThan(0.02)
        expect(ankle.y, `${id} ${side}`).toBeLessThan(knee.y - 0.9 * d.lowerLegLen)
        expect(Math.abs(ankle.z - knee.z), `${id} ${side}`).toBeLessThan(0.02)
      }
    }
  })

  it('talk gestures with the right hand in front of the chest, below the shoulder, through the cycle', () => {
    for (const id of PEOPLE) {
      const d = personDims(id)
      const b = buildAsset(id)
      const at = (name: string, x = 0, y = 0, z = 0): Vector3 => b.group.getObjectByName(name)!.localToWorld(new Vector3(x, y, z))
      let lo = Infinity
      let hi = -Infinity
      for (let t = 0; t <= 4; t += 0.1) {
        b.animate!({ gait: 'gesture', phase: 0, speed: 0, distance: 0, time: t })
        b.group.updateMatrixWorld(true)
        const shoulderR = at('shoulderR')
        const shoulderL = at('shoulderL')
        const hand = at('elbowR', 0, -d.lowerArmLen, 0)
        const label = `${id} t=${t.toFixed(1)}`
        // Chest height: below the shoulder, above the bottom of the ribs.
        expect(hand.y, label).toBeLessThan(shoulderR.y - 0.05 * d.s)
        expect(hand.y, label).toBeGreaterThan(shoulderR.y - 0.45 * d.torsoLen)
        // In front of the chest, between the shoulders.
        expect(hand.z, label).toBeLessThan(shoulderR.z - 0.2 * d.s)
        expect(hand.x, label).toBeGreaterThan(shoulderL.x)
        expect(hand.x, label).toBeLessThan(shoulderR.x)
        lo = Math.min(lo, hand.y)
        hi = Math.max(hi, hand.y)
      }
      // A small, visible motion.
      expect(hi - lo, id).toBeGreaterThan(0.02 * d.s)
      expect(hi - lo, id).toBeLessThan(0.15 * d.s)
    }
  })

  it('walk, jog and run bend the elbows forward (anatomical flexion, never hyperextended)', () => {
    for (const id of PEOPLE) {
      const d = personDims(id)
      for (const gait of ['walk', 'jog', 'run'] as const) {
        for (const phase of [0, 0.25, 0.5, 0.75]) {
          const { b } = pose(id, gait, phase)
          for (const side of ['L', 'R']) {
            const shoulder = b.group.getObjectByName(`shoulder${side}`)!
            const elbow = b.group.getObjectByName(`elbow${side}`)!
            // In the upper arm's frame the elbow is at z = 0; flexion puts the hand in front (−z).
            const hand = shoulder.worldToLocal(elbow.localToWorld(new Vector3(0, -d.lowerArmLen, 0)))
            expect(hand.z, `${id} ${gait} @${phase} ${side}`).toBeLessThan(-0.05)
          }
        }
      }
    }
  })

  it('walk bends each knee backward, never forward', () => {
    for (const id of PEOPLE) {
      const d = personDims(id)
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        const { b } = pose(id, 'walk', phase)
        for (const side of ['L', 'R']) {
          const hip = b.group.getObjectByName(`hip${side}`)!
          const knee = b.group.getObjectByName(`knee${side}`)!
          const ankle = hip.worldToLocal(knee.localToWorld(new Vector3(0, -d.lowerLegLen, 0)))
          expect(ankle.z, `${id} @${phase} ${side}`).toBeGreaterThanOrEqual(-1e-9)
        }
      }
    }
  })
})
