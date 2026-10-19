import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { MOTION_PRESETS } from '@engine/motions'
import { personDims, poseEffectors, toWorld, type Effector } from '@engine/skeleton'
import { ASSET_CATALOG } from '@engine/assets'
import type { V3 } from '@engine/types'

const BASE: Record<string, number> = {
  'person.man': 1.78,
  'person.woman': 1.65,
  'person.child': 1.2,
  'person.elderly': 1.68
}

describe('personDims', () => {
  it('personDims matches the rig formulas for man/woman/child/elderly at params height 0.8/1/1.2', () => {
    for (const assetId of Object.keys(BASE)) {
      for (const height of [0.8, 1, 1.2]) {
        for (const build of [0.8, 1, 1.3]) {
          const H = BASE[assetId]! * height
          const s = H / 1.78
          const legLen = H * 0.47
          const headR = H * 0.13 * 0.5
          const torsoLen = H - legLen - headR * 2
          const d = personDims(assetId, { height, build })
          expect(d.H).toBeCloseTo(H, 12)
          expect(d.s).toBeCloseTo(s, 12)
          expect(d.legLen).toBeCloseTo(legLen, 12)
          expect(d.headR).toBeCloseTo(headR, 12)
          expect(d.torsoLen).toBeCloseTo(torsoLen, 12)
          expect(d.bodyW).toBeCloseTo(0.34 * s * build, 12)
          expect(d.shoulderY).toBeCloseTo(torsoLen * 0.92, 12)
          expect(d.upperArmLen).toBeCloseTo(torsoLen * 0.5, 12)
          expect(d.lowerArmLen).toBeCloseTo(torsoLen * 0.48, 12)
          expect(d.upperLegLen).toBeCloseTo(legLen * 0.52, 12)
          expect(d.lowerLegLen).toBeCloseTo(legLen * 0.48, 12)
          expect(d.baseLean).toBe(assetId === 'person.elderly' ? -0.18 : 0)
        }
      }
    }
  })

  it('classic people put the shoulder and hip joints at bodyW × 0.55 and × 0.28', () => {
    for (const assetId of Object.keys(BASE)) {
      const d = personDims(assetId, { build: 1.2 })
      expect(d.shoulderX).toBeCloseTo(d.bodyW * 0.55, 12)
      expect(d.hipX).toBeCloseTo(d.bodyW * 0.28, 12)
    }
  })

  it('mannequins use anatomical proportions; the head top lands at their height', () => {
    const widths: Record<string, { H: number; bodyW: number; shoulderX: number; hipX: number }> = {
      'person.mannequinMale': { H: 1.8, bodyW: 0.36, shoulderX: 0.2, hipX: 0.09 },
      'person.mannequinFemale': { H: 1.7, bodyW: 0.31, shoulderX: 0.165, hipX: 0.1 }
    }
    for (const [assetId, w] of Object.entries(widths)) {
      for (const height of [0.8, 1, 1.2]) {
        for (const build of [0.8, 1, 1.3]) {
          const H = w.H * height
          const s = H / 1.78
          const headR = H * 0.13 * 0.5
          const d = personDims(assetId, { height, build })
          expect(d.H).toBeCloseTo(H, 12)
          expect(d.s).toBeCloseTo(s, 12)
          expect(d.headR).toBeCloseTo(headR, 12)
          expect(d.legLen).toBeCloseTo(H * 0.51, 12)
          expect(d.upperLegLen).toBeCloseTo(H * 0.235, 12)
          expect(d.lowerLegLen).toBeCloseTo(d.legLen - d.upperLegLen, 12)
          expect(d.upperArmLen).toBeCloseTo(H * 0.185, 12)
          expect(d.lowerArmLen).toBeCloseTo(H * 0.195, 12)
          expect(d.shoulderY).toBeCloseTo(d.torsoLen * 0.92, 12)
          // pelvis (legLen) + torso offset 0.08 s + torso + head offset 0.06 s + head = H
          expect(d.legLen + 0.08 * s + d.torsoLen + 0.06 * s + 2 * d.headR).toBeCloseTo(H, 12)
          expect(d.bodyW).toBeCloseTo(w.bodyW * s * build, 12)
          expect(d.shoulderX).toBeCloseTo(w.shoulderX * s * build, 12)
          expect(d.hipX).toBeCloseTo(w.hipX * s * build, 12)
          expect(d.baseLean).toBe(0)
        }
      }
    }
    // Silhouette: the male's shoulders are broader, the female's hip joints wider.
    const m = personDims('person.mannequinMale')
    const f = personDims('person.mannequinFemale')
    expect(m.shoulderX).toBeGreaterThan(f.shoulderX + 0.03)
    expect(f.hipX).toBeGreaterThan(m.hipX)
  })

  it('clamps height to 0.8..1.2 and build to 0.8..1.3', () => {
    expect(personDims('person.man', { height: 2 }).H).toBeCloseTo(1.78 * 1.2, 12)
    expect(personDims('person.man', { height: 0.1 }).H).toBeCloseTo(1.78 * 0.8, 12)
    expect(personDims('person.man', { build: 9 }).bodyW).toBeCloseTo(0.34 * 1.3, 12)
    expect(personDims('person.man', { build: 0 }).bodyW).toBeCloseTo(0.34 * 0.8, 12)
    expect(personDims('person.man').H).toBeCloseTo(1.78, 12)
  })
})

/** Seeded random poses over every override channel the renderer maps. */
function randomPoses(n: number, seed: number): Record<string, number>[] {
  let a = seed >>> 0
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const keys = [
    'shoulderLX', 'shoulderRX', 'shoulderLZ', 'shoulderRZ', 'elbowL', 'elbowR', 'hipLX', 'hipRX',
    'hipLZ', 'hipRZ', 'kneeL', 'kneeR', 'torsoX', 'torsoY', 'torsoZ', 'headX', 'headY', 'headZ'
  ]
  const out: Record<string, number>[] = []
  for (let i = 0; i < n; i++) {
    const pose: Record<string, number> = {}
    for (const k of keys) pose[k] = (rnd() - 0.5) * 3
    out.push(pose)
  }
  return out
}

describe('mannequin catalog', () => {
  it('lists the male and female mannequins as people', () => {
    const male = ASSET_CATALOG.find((a) => a.id === 'person.mannequinMale')
    const female = ASSET_CATALOG.find((a) => a.id === 'person.mannequinFemale')
    expect(male).toMatchObject({ name: 'Mannequin (male)', category: 'people', height: 1.8, motion: 'biped', promptNoun: 'a man' })
    expect(female).toMatchObject({ name: 'Mannequin (female)', category: 'people', height: 1.7, motion: 'biped', promptNoun: 'a woman' })
  })
})

describe('poseEffectors', () => {
  it('FK matches three.js for random poses', () => {
    const fightKeyframes = MOTION_PRESETS.filter((m) => m.category === 'fight')
      .flatMap((m) => m.keyframes.map((k) => k.joints))
      .slice(0, 20)
    expect(fightKeyframes.length).toBe(20)
    const poses: (Record<string, number> | undefined)[] = [undefined, ...fightKeyframes, ...randomPoses(20, 7)]
    const rigs: [string, Record<string, number>][] = [
      ['person.man', { height: 1.1, build: 1.2 }],
      ['person.elderly', { height: 0.9, build: 0.8 }],
      ['person.child', {}],
      ['person.mannequinMale', {}],
      ['person.mannequinFemale', { height: 0.9, build: 1.3 }]
    ]
    for (const [assetId, params] of rigs) {
      const built = buildAsset(assetId, params)
      const dims = personDims(assetId, params)
      const node = (name: string) => {
        const o = built.group.getObjectByName(name)
        if (!o) throw new Error(`rig has no ${name} group`)
        return o
      }
      for (const overrides of poses) {
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
        for (const key of Object.keys(expected) as Effector[]) {
          const e = expected[key]
          const g = got[key]
          expect(Math.abs(g.x - e.x), `${assetId} ${key} x`).toBeLessThan(1e-6)
          expect(Math.abs(g.y - e.y), `${assetId} ${key} y`).toBeLessThan(1e-6)
          expect(Math.abs(g.z - e.z), `${assetId} ${key} z`).toBeLessThan(1e-6)
        }
      }
    }
  }, 30_000)
})

describe('joint conventions (motions.ts header) on a body facing −Z', () => {
  const dims = personDims('person.man')
  const rest = poseEffectors(dims, {})

  it('negative shoulderX raises the arm forward, toward −Z', () => {
    const p = poseEffectors(dims, { shoulderLX: -1.5, shoulderRX: -1.5 })
    expect(p.handL.z).toBeLessThan(rest.shoulderL.z - 0.4)
    expect(p.handR.z).toBeLessThan(rest.shoulderR.z - 0.4)
  })

  it('positive shoulderZ swings each arm outward from the midline', () => {
    const p = poseEffectors(dims, { shoulderLZ: 1, shoulderRZ: 1 })
    expect(p.handL.x).toBeLessThan(rest.handL.x - 0.2)
    expect(p.handR.x).toBeGreaterThan(rest.handR.x + 0.2)
  })

  it('positive elbow flexes the forearm forward, toward −Z', () => {
    const p = poseEffectors(dims, { elbowL: 1.5, elbowR: 1.5 })
    expect(p.handL.z).toBeLessThan(rest.handL.z - 0.2)
    expect(p.handR.z).toBeLessThan(rest.handR.z - 0.2)
  })

  it('the guard pose puts both fists up in front of the face', () => {
    const p = poseEffectors(dims, { shoulderLX: -0.9, shoulderRX: -0.9, elbowL: 1.8, elbowR: 1.8, torsoX: 0.15 })
    for (const h of [p.handL, p.handR]) {
      expect(h.z).toBeLessThan(p.head.z)
      expect(h.y).toBeGreaterThan(rest.shoulderL.y)
    }
  })

  it('negative hipX raises the leg forward; positive knee bends the shin backward', () => {
    const kick = poseEffectors(dims, { hipRX: -1.5, kneeR: 0.15 })
    expect(kick.footR.z).toBeLessThan(-0.6)
    const chamber = poseEffectors(dims, { hipRX: -1.0, kneeR: 1.6 })
    expect(chamber.kneeR.z).toBeLessThan(-0.3)
    expect(chamber.footR.z).toBeGreaterThan(chamber.kneeR.z)
    expect(chamber.footR.y).toBeLessThan(chamber.kneeR.y)
  })

  it('positive hipZ swings each leg outward', () => {
    const p = poseEffectors(dims, { hipLZ: 0.5, hipRZ: 0.5 })
    expect(p.footL.x).toBeLessThan(rest.footL.x - 0.2)
    expect(p.footR.x).toBeGreaterThan(rest.footR.x + 0.2)
  })

  it('positive torsoX leans forward, positive torsoZ leans right, positive torsoY turns the right shoulder forward', () => {
    expect(poseEffectors(dims, { torsoX: 0.4 }).head.z).toBeLessThan(rest.head.z - 0.2)
    expect(poseEffectors(dims, { torsoZ: 0.3 }).head.x).toBeGreaterThan(rest.head.x + 0.1)
    expect(poseEffectors(dims, { torsoY: 0.5 }).shoulderR.z).toBeLessThan(rest.shoulderR.z - 0.05)
  })

  it('negative headX tips the head back', () => {
    expect(poseEffectors(dims, { headX: -0.4 }).head.z).toBeGreaterThan(rest.head.z + 0.03)
  })
})

describe('per-channel directions (motions.ts header is the spec), FK and three.js rig agree', () => {
  const dims = personDims('person.man')
  const built = buildAsset('person.man')
  /** The same landmarks from FK and from the rendered rig, for a one-channel pose. */
  const pose = (joints: Record<string, number>): { fk: Record<string, V3>; rig: Record<string, V3> } => {
    built.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
    built.group.updateMatrixWorld(true)
    const at = (name: string, x = 0, y = 0, z = 0): V3 => {
      const v = built.group.getObjectByName(name)!.localToWorld(new Vector3(x, y, z))
      return { x: v.x, y: v.y, z: v.z }
    }
    const toe = [0, -dims.lowerLegLen + 0.03 * dims.s, -0.16 * dims.s] as const
    const rig: Record<string, V3> = {
      handL: at('elbowL', 0, -dims.lowerArmLen, 0),
      handR: at('elbowR', 0, -dims.lowerArmLen, 0),
      elbowL: at('elbowL'),
      elbowR: at('elbowR'),
      shoulderL: at('shoulderL'),
      shoulderR: at('shoulderR'),
      footL: at('kneeL', ...toe),
      footR: at('kneeR', ...toe),
      kneeL: at('kneeL'),
      kneeR: at('kneeR'),
      head: at('head', 0, dims.headR + 0.06 * dims.s, 0),
      // A point on the face (front of the head, −Z in the head frame).
      face: at('head', 0, dims.headR + 0.06 * dims.s, -dims.headR)
    }
    return { fk: poseEffectors(dims, joints) as unknown as Record<string, V3>, rig }
  }
  const rest = pose({})
  /** Run a direction check on both the FK and the rendered rig. */
  const both = (joints: Record<string, number>, check: (p: Record<string, V3>, r: Record<string, V3>) => void, rigOnly = false): void => {
    const p = pose(joints)
    if (!rigOnly) check(p.fk, rest.fk)
    check(p.rig, rest.rig)
  }

  for (const side of ['L', 'R'] as const) {
    const out = side === 'L' ? -1 : 1
    it(`shoulder${side}X −1.5 raises the arm forward (hand z < shoulder z)`, () =>
      both({ [`shoulder${side}X`]: -1.5 }, (p) => expect(p[`hand${side}`]!.z).toBeLessThan(p[`shoulder${side}`]!.z - 0.4)))
    it(`shoulder${side}Z +1 swings the arm outward`, () =>
      both({ [`shoulder${side}Z`]: 1 }, (p, r) => expect((p[`hand${side}`]!.x - r[`hand${side}`]!.x) * out).toBeGreaterThan(0.2)))
    it(`elbow${side} +1.9 folds the forearm toward the front of the upper arm`, () =>
      both({ [`elbow${side}`]: 1.9 }, (p) => expect(p[`hand${side}`]!.z).toBeLessThan(p[`elbow${side}`]!.z - 0.2)))
    it(`hip${side}X −1 raises the leg forward`, () =>
      both({ [`hip${side}X`]: -1 }, (p) => expect(p[`foot${side}`]!.z).toBeLessThan(-0.4)))
    it(`hip${side}Z +0.5 swings the leg outward`, () =>
      both({ [`hip${side}Z`]: 0.5 }, (p, r) => expect((p[`foot${side}`]!.x - r[`foot${side}`]!.x) * out).toBeGreaterThan(0.2)))
    it(`knee${side} +1 bends the shin backward (foot z > knee z)`, () =>
      both({ [`knee${side}`]: 1 }, (p) => expect(p[`foot${side}`]!.z).toBeGreaterThan(p[`knee${side}`]!.z + 0.2)))
  }
  it('torsoX +0.4 leans the torso forward', () => both({ torsoX: 0.4 }, (p, r) => expect(p.head!.z).toBeLessThan(r.head!.z - 0.2)))
  it('torsoY +0.5 twists counterclockwise from above (right shoulder comes forward)', () =>
    both({ torsoY: 0.5 }, (p, r) => expect(p.shoulderR!.z).toBeLessThan(r.shoulderR!.z - 0.05)))
  it('torsoZ +0.3 leans the torso to the right', () => both({ torsoZ: 0.3 }, (p, r) => expect(p.head!.x).toBeGreaterThan(r.head!.x + 0.1)))
  it('headX +0.4 nods the chin down (positive = down, our call: the header gives no direction)', () =>
    both({ headX: 0.4 }, (p, r) => expect(p.head!.z).toBeLessThan(r.head!.z - 0.03)))
  it('headY +0.5 turns the face to the left (counterclockwise from above, like torsoY)', () =>
    both({ headY: 0.5 }, (p, r) => expect(p.face!.x).toBeLessThan(r.face!.x - 0.03), true))
  it('headZ +0.3 tilts the head to the right', () => both({ headZ: 0.3 }, (p, r) => expect(p.head!.x).toBeGreaterThan(r.head!.x + 0.02)))
})

describe('toWorld', () => {
  it('toWorld rotates by heading', () => {
    const p = toWorld({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 }, Math.PI / 2, 1)
    expect(p.x).toBeCloseTo(-1, 12)
    expect(p.y).toBeCloseTo(0, 12)
    expect(p.z).toBeCloseTo(0, 12)
  })

  it('toWorld scales then rotates then translates', () => {
    const p = toWorld({ x: 1, y: 2, z: 0 }, { x: 10, y: 0.5, z: -3 }, Math.PI, 2)
    expect(p.x).toBeCloseTo(10 - 2, 12)
    expect(p.y).toBeCloseTo(0.5 + 4, 12)
    expect(p.z).toBeCloseTo(-3, 12)
  })
})
