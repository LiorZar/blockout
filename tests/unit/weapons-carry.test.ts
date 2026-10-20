// Fork addition (2026): long guns at rest are carried low, muzzle down across the body; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Group, Vector3 } from 'three'
import { mirrorJoints } from '@engine/choreography'
import { MOTION_PRESETS } from '@engine/motions'
import { personDims } from '@engine/skeleton'
import type { V3 } from '@engine/types'
import { aimDirectionLocal, handFrame, heldPointLocal, holdJoints, supportReach, weaponRotation, weaponSpec, type Hand } from '@engine/weapons'
import { buildAsset } from '@renderer/viewport/builders'
import { heldWeaponMatrix, steadyArm } from '@renderer/viewport/hold'

const LONG_GUNS = ['prop.rifle', 'prop.shotgun']
const BODIES = ['person.man', 'person.woman', 'person.mannequinMale', 'person.mannequinFemale', 'person.child', 'person.elderly']

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z)
const deg = (rad: number): number => (rad * 180) / Math.PI

/** Degrees below level, and degrees off forward (−Z) toward the off side, of a barrel direction. */
function carryAngles(dir: V3, hand: Hand): { down: number; across: number } {
  const off = hand === 'R' ? -dir.x : dir.x
  return { down: deg(Math.asin(-dir.y)), across: deg(Math.atan2(off, -dir.z)) }
}

function atRest(body: string, gun: string, hand: Hand): { dims: ReturnType<typeof personDims>; joints: Record<string, number> } {
  const dims = personDims(body)
  return { dims, joints: holdJoints(dims, {}, [{ spec: weaponSpec(gun)!, hand, scale: 1 }])! }
}

describe('long guns at rest: carried low, muzzle down across the body', () => {
  for (const gun of LONG_GUNS) {
    for (const hand of ['R', 'L'] as Hand[]) {
      it(`${gun} in the ${hand} hand: muzzle 35–45° down, forward and across to the off side (six bodies)`, () => {
        const spec = weaponSpec(gun)!
        for (const body of BODIES) {
          const { dims, joints } = atRest(body, gun, hand)
          const a = carryAngles(aimDirectionLocal(dims, joints, hand, spec), hand)
          expect(a.down, `${body} down`).toBeGreaterThanOrEqual(35)
          expect(a.down, `${body} down`).toBeLessThanOrEqual(45)
          expect(a.across, `${body} across`).toBeGreaterThanOrEqual(30)
          expect(a.across, `${body} across`).toBeLessThanOrEqual(80)
        }
      })

      it(`${gun} in the ${hand} hand: grip in the hand at the waist, in front of the body; the support hand on the fore-end`, () => {
        const spec = weaponSpec(gun)!
        const off: Hand = hand === 'R' ? 'L' : 'R'
        for (const body of BODIES) {
          const { dims, joints } = atRest(body, gun, hand)
          const f = handFrame(dims, joints, hand)
          const grip = heldPointLocal(dims, joints, hand, spec, spec.grip, 1)
          expect(len(sub(grip, f.p)), `${body} grip`).toBeLessThan(1e-9)
          // Low: past halfway from the shoulder down to the hip joint (the old carry sat at the chest, 18 %).
          const low = (f.shoulder.y - grip.y) / (f.shoulder.y - dims.legLen)
          expect(low, `${body} grip height`).toBeGreaterThanOrEqual(0.55)
          expect(low, `${body} grip height`).toBeLessThanOrEqual(0.85)
          expect(grip.z, `${body} grip in front`).toBeLessThan(-0.1 * dims.s)
          const support = heldPointLocal(dims, joints, hand, spec, spec.support!, 1)
          const offHand = handFrame(dims, joints, off).p
          if (body !== 'person.child') {
            expect(len(sub(offHand, support)), `${body} support hand`).toBeLessThanOrEqual(0.02)
            continue
          }
          // A child can't reach an adult gun's fore-end: the hand slides back along it, and the slide is reported.
          const reach = supportReach(dims, joints, hand, spec, 1)
          expect(len(sub(offHand, reach.point)), 'child support hand').toBeLessThanOrEqual(0.01)
          expect(reach.slideM, 'child slide').toBeGreaterThan(0)
        }
      })
    }
  }

  it('the shouldered aim keeps the stock rule: rifle-aim-fire plays exactly as before on every body', () => {
    const k = MOTION_PRESETS.find((m) => m.id === 'rifle-aim-fire')!.keyframes
    for (const gun of LONG_GUNS) {
      const spec = weaponSpec(gun)!
      for (const hand of ['R', 'L'] as Hand[]) {
        for (const body of BODIES) {
          const dims = personDims(body)
          for (const kf of k) {
            const joints = holdJoints(dims, hand === 'R' ? kf.joints : mirrorJoints(kf.joints), [{ spec, hand, scale: 1 }])
            const f = handFrame(dims, joints, hand)
            const carried = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder, torso: f.torso })
            const shouldered = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder })
            expect(carried, `${gun} ${hand} ${body} t=${kf.t}`).toEqual(shouldered)
          }
        }
      }
    }
  })

  it('the rendered gun equals the engine gun at rest, and a walking holder carries it the same way', () => {
    for (const body of ['person.man', 'person.mannequinMale', 'person.elderly']) {
      const dims = personDims(body)
      for (const gun of LONG_GUNS) {
        const spec = weaponSpec(gun)!
        for (const hand of ['R', 'L'] as Hand[]) {
          const joints = holdJoints(dims, {}, [{ spec, hand, scale: 1 }])!
          const person = buildAsset(body)
          const root = new Group()
          root.add(person.group)
          root.rotation.y = 0.6
          for (const [gait, phase] of [['stand', 0], ['walk', 0], ['walk', 0.3], ['walk', 0.55], ['walk', 0.8]] as const) {
            person.animate!({ gait, phase, speed: gait === 'walk' ? 1.4 : 0, distance: phase, time: phase, overrides: joints })
            if (gait === 'walk') {
              steadyArm(person.group, 'L', joints)
              steadyArm(person.group, 'R', joints)
            }
            root.updateMatrixWorld(true)
            const m = heldWeaponMatrix(person.group, dims, spec, hand, 1)!
            const at = (p: V3): Vector3 => new Vector3(p.x, p.y, p.z).applyMatrix4(m)
            const dir = at({ ...spec.tip, z: spec.tip.z - 1 }).sub(at(spec.tip)).applyAxisAngle(new Vector3(0, 1, 0), -0.6)
            const a = carryAngles(dir, hand)
            expect(a.down, `${body} ${gun} ${hand} ${gait} @${phase}`).toBeGreaterThanOrEqual(35)
            expect(a.down, `${body} ${gun} ${hand} ${gait} @${phase}`).toBeLessThanOrEqual(45)
            if (gait !== 'stand') continue
            const engine = aimDirectionLocal(dims, joints, hand, spec)
            expect(len(sub(dir, engine)), `${body} ${gun} ${hand} render = engine`).toBeLessThan(1e-6)
          }
        }
      }
    }
  })
})
