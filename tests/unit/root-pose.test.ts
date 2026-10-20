// Fork addition (2026): the root orientation channel (rootX / rootY / rootZ) for motion playback; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Mesh, Vector3, type Object3D } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { MOTION_PRESETS } from '@engine/motions'
import { personDims, poseEffectors, type Effector } from '@engine/skeleton'
import { bodyLowY, bodyShape, lowestY, motionRootY } from '@engine/floor'
import { mirrorJoints } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import type { ActorMark } from '@engine/types'

const PEOPLE = ['person.man', 'person.woman', 'person.child', 'person.elderly', 'person.mannequinMale', 'person.mannequinFemale']

/** Root orientations: prone, supine, rolled right, side-on and inverted, tipped. */
const ROOTS: Record<string, number>[] = [
  { rootX: Math.PI / 2 },
  { rootX: -Math.PI / 2 },
  { rootZ: Math.PI / 2 },
  { rootY: Math.PI / 2, rootZ: Math.PI },
  { rootX: 1.2, rootY: -0.4 },
  { rootX: -1.4, rootY: 0.3, rootZ: -0.6 }
]

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

describe('root channels: the rendered rig matches FK', () => {
  const poses = MOTION_PRESETS.filter((m) => m.category === 'stunt')
    .flatMap((m) => m.keyframes.map((k) => k.joints))
    .slice(0, 8)

  it('effectors within 1e-6 and the lowest point on the proxy (facets aside), six bodies', () => {
    for (const id of PEOPLE) {
      const built = buildAsset(id)
      const dims = personDims(id)
      const shape = bodyShape(id)
      const node = (name: string): Object3D => built.group.getObjectByName(name)!
      for (const root of ROOTS) {
        for (const base of poses) {
          const overrides = { ...base, ...root }
          built.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides })
          built.group.updateMatrixWorld(true)
          const world = (name: string, x = 0, y = 0, z = 0): Vector3 => node(name).localToWorld(new Vector3(x, y, z))
          const toe = [0, -dims.lowerLegLen + 0.03 * dims.s, -0.16 * dims.s] as const
          const expected: Record<Effector, Vector3> = {
            handL: world('elbowL', 0, -dims.lowerArmLen, 0),
            handR: world('elbowR', 0, -dims.lowerArmLen, 0),
            elbowL: world('elbowL'),
            elbowR: world('elbowR'),
            footL: world('kneeL', ...toe),
            footR: world('kneeR', ...toe),
            kneeL: world('kneeL'),
            kneeR: world('kneeR'),
            head: world('head', 0, dims.headR + 0.06 * dims.s, 0),
            chest: world('torso', 0, 0.55 * dims.torsoLen, 0),
            pelvis: world('pelvis'),
            shoulderL: world('shoulderL'),
            shoulderR: world('shoulderR')
          }
          const got = poseEffectors(dims, overrides)
          const at = `${id} ${JSON.stringify(root)}`
          for (const key of Object.keys(expected) as Effector[]) {
            expect(Math.abs(got[key].x - expected[key].x), `${at} ${key} x`).toBeLessThan(1e-6)
            expect(Math.abs(got[key].y - expected[key].y), `${at} ${key} y`).toBeLessThan(1e-6)
            expect(Math.abs(got[key].z - expected[key].z), `${at} ${key} z`).toBeLessThan(1e-6)
          }
          // Off its feet the proxy is a little coarser than the mesh: a turned
          // capsule's lowest facet vertex sits up to r·(1 − cos(π/8)) ≈ 1.3 cm
          // above the true surface, and the mannequin's curled fingertips are
          // two points (they sink under 8 mm). Inside the −2 cm floor tolerance.
          const err = lowestY(shape, overrides) - meshLow(built.group)
          expect(err, at).toBeLessThan(0.008)
          expect(err, at).toBeGreaterThan(-0.02)
        }
      }
    }
  }, 60_000)
})

describe('root channel conventions (pivot at the pelvis, motions.ts signs)', () => {
  const dims = personDims('person.man')
  const rest = poseEffectors(dims, {})

  it('turns the whole body about the pelvis joint', () => {
    for (const root of ROOTS) {
      const p = poseEffectors(dims, root)
      expect(p.pelvis.x).toBeCloseTo(rest.pelvis.x, 9)
      expect(p.pelvis.y).toBeCloseTo(rest.pelvis.y, 9)
      expect(p.pelvis.z).toBeCloseTo(rest.pelvis.z, 9)
    }
  })

  it('positive rootX tips the body forward (prone), negative backward (supine)', () => {
    const prone = poseEffectors(dims, { rootX: Math.PI / 2 })
    expect(prone.head.z).toBeLessThan(rest.pelvis.z - 0.7)
    expect(prone.head.y).toBeCloseTo(rest.pelvis.y, 1)
    const supine = poseEffectors(dims, { rootX: -Math.PI / 2 })
    expect(supine.head.z).toBeGreaterThan(rest.pelvis.z + 0.7)
  })

  it('positive rootZ rolls the head to the right; positive rootY turns the body to face −X', () => {
    expect(poseEffectors(dims, { rootZ: Math.PI / 2 }).head.x).toBeGreaterThan(0.7)
    const turned = poseEffectors(dims, { rootY: Math.PI / 2, shoulderLX: -1.5, shoulderRX: -1.5 })
    expect(turned.handL.x).toBeLessThan(-0.4)
  })

  it('grounding counts every body point: a body tipped onto its outstretched hands rests on them', () => {
    const j = { rootX: 2.2, shoulderLX: -2.8, shoulderRX: -2.8, elbowL: 0, elbowR: 0 }
    const low = bodyLowY({ assetId: 'person.man' }, j)
    const p = poseEffectors(dims, j)
    expect(low).toBeLessThan(p.footL.y - 0.1)
    expect(Math.abs(low - Math.min(p.handL.y, p.handR.y))).toBeLessThan(0.06)
  })

  it('mirrorJoints negates yaw and roll and keeps pitch', () => {
    expect(mirrorJoints({ rootX: 0.4, rootY: 0.3, rootZ: -1.2, hipLX: -0.5 })).toEqual({ rootX: 0.4, rootY: -0.3, rootZ: 1.2, hipRX: -0.5 })
  })
})

/** One person with posed marks (motion playback), evaluated. */
function posedScene(marks: Omit<ActorMark, 'id'>[], duration: number): ShotEvaluator {
  const doc = createProject('Root')
  const scene = doc.scenes[0]!
  const e = createEntity('person.man', 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks: marks.map((m, i) => ({ id: `m${i}`, ...m })) })
  return new ShotEvaluator(scene, { ...scene.shots[0]!, duration })
}

function posedMark(time: number, joints: Record<string, number>): Omit<ActorMark, 'id'> {
  const y = motionRootY(0, 0, bodyLowY({ assetId: 'person.man' }, joints))
  return { time, position: { x: 0, y, z: 0 }, gait: 'stand', easeIn: 0, easeOut: 0, hold: 0, joints, arriveHeading: 0, posedMove: true }
}

describe('root channels in playback', () => {
  it('interpolate on the shortest arc, so a full roll never spins back', () => {
    const ev = posedScene([posedMark(0, { rootZ: 3 }), posedMark(1, { rootZ: -3 })], 1)
    const mid = ev.evaluate(0.5).entities[0]!.joints!.rootZ!
    expect(Math.abs(Math.cos(mid) - Math.cos(Math.PI))).toBeLessThan(1e-9)
  })

  it('a posed leg between two grounded keyframes keeps the body on the floor at every frame', () => {
    const ev = posedScene([posedMark(0, {}), posedMark(1, { rootX: 3 })], 1)
    for (let t = 0; t <= 1; t += 1 / 24) {
      const st = ev.evaluate(t).entities[0]!
      expect(Math.abs(st.position.y + bodyLowY({ assetId: 'person.man' }, st.joints)), `@${t.toFixed(2)}`).toBeLessThan(1e-6)
    }
  })
})
