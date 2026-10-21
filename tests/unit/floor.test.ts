// Fork addition (2026): the person floor-contact proxy; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Mesh, Vector3, type Object3D } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { MOTION_PRESETS } from '@engine/motions'
import { bodyLowY, bodyShape, lowestY, motionRootY } from '@engine/floor'

const PEOPLE = ['person.man', 'person.woman', 'person.child', 'person.elderly', 'person.mannequinMale', 'person.mannequinFemale']

/** Lowest rendered vertex, world y. */
function meshLow(root: Object3D): number {
  let low = Infinity
  const v = new Vector3()
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const pos = o.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).y)
  })
  return low
}

describe('floor proxy (lowest surface point of a posed body)', () => {
  it('matches the rendered mesh within 5 mm on every library keyframe, six bodies', () => {
    for (const id of PEOPLE) {
      const b = buildAsset(id)
      const shape = bodyShape(id)
      let worst = 0
      let where = ''
      for (const p of MOTION_PRESETS) {
        for (const kf of p.keyframes) {
          b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: kf.joints })
          const err = lowestY(shape, kf.joints) - meshLow(b.group)
          if (Math.abs(err) > Math.abs(worst)) {
            worst = err
            where = `${p.id}@${kf.t}`
          }
        }
      }
      expect(Math.abs(worst), `${id} worst ${where}`).toBeLessThan(0.005)
    }
    // Six bodies posed on every library keyframe: 15 s under a loaded gate (mocap-fights ruling).
  }, 15_000)

  it('follows height and build params', () => {
    for (const id of ['person.man', 'person.mannequinFemale']) {
      for (const params of [{ height: 1.2, build: 1.3 }, { height: 0.8, build: 0.8 }]) {
        const b = buildAsset(id, params)
        const joints = MOTION_PRESETS.find((p) => p.id === 'kneel-tie-shoe')!.keyframes[2]!.joints
        b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
        expect(Math.abs(lowestY(bodyShape(id, params), joints) - meshLow(b.group)), `${id} ${JSON.stringify(params)}`).toBeLessThan(0.005)
      }
    }
  })

  it('stands on its soles at rest', () => {
    for (const id of PEOPLE) expect(Math.abs(lowestY(bodyShape(id), {})), id).toBeLessThan(1e-9)
  })

  it('scales with the entity and defaults to the man', () => {
    const joints = { hipLX: -1.2, kneeL: 1.4 }
    expect(bodyLowY({ assetId: 'person.child', scale: 2 }, joints)).toBeCloseTo(2 * lowestY(bodyShape('person.child'), joints), 9)
    expect(bodyLowY(undefined, joints)).toBeCloseTo(lowestY(bodyShape('person.man'), joints), 9)
  })
})

describe('motion floor rule', () => {
  it('rests a keyframe that does not lift the body on the floor; a lifted one keeps its height unless it would sink', () => {
    expect(motionRootY(0, -0.45, 0.7)).toBeCloseTo(-0.7, 9)
    expect(motionRootY(0, -0.85, 0)).toBe(0)
    expect(motionRootY(0, 0, 0.36)).toBeCloseTo(-0.36, 9)
    expect(motionRootY(0, 0, 0)).toBe(0)
    expect(motionRootY(0, 0, -0.05)).toBeCloseTo(0.05, 9)
    expect(motionRootY(0, 0.7, 0.2)).toBeCloseTo(0.7, 9)
    expect(motionRootY(0, 0.1, -0.3)).toBeCloseTo(0.3, 9)
    expect(motionRootY(1, -0.3, 0.4)).toBeCloseTo(0.6, 9)
  })
})
