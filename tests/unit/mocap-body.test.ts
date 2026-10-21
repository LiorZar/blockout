// Fork addition (2026): the mocap body kind on a hand-built fixture skeleton; see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assetSpec } from '@engine/assets'
import { bodyLowY, bodyShape, lowestY } from '@engine/floor'
import { torsoShape } from '@engine/fight/contact'
import { parseFightScript } from '@engine/fight/script'
import { solveFight } from '@engine/fight/solve'
import { subjectTargets } from '@engine/camera-clear'
import { solveShot } from '@engine/shot'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import { BONE_INDEX, MOCAP_BONES } from '@engine/mocap/rig'
import { clearMocapBodies, mocapRig, mocapStandIn, registerMocapBody } from '@engine/mocap/registry'
import { qrot } from '@engine/mocap/quat'
import { personDims, poseEffectors, poseFrames, type PersonDims } from '@engine/skeleton'
import { heldPointLocal, solveArmIK, weaponSpec } from '@engine/weapons'
import type { V3 } from '@engine/types'
import { FIXTURE_BONES, fixtureSource, fixtureSurfaces } from './mocap-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

/** Seeded uniform (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CHANNELS = ['rootX', 'rootY', 'rootZ', 'torsoX', 'torsoY', 'torsoZ', 'headX', 'headY', 'headZ', 'shoulderLX', 'shoulderRX', 'shoulderLZ', 'shoulderRZ', 'elbowL', 'elbowR', 'hipLX', 'hipRX', 'hipLZ', 'hipRZ', 'kneeL', 'kneeR', 'handL', 'handR']

function randomJoints(r: () => number, root = true): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of CHANNELS) {
    if (!root && c.startsWith('root')) continue
    if (r() < 0.3) continue
    out[c] = (r() * 2 - 1) * (c.startsWith('elbow') || c.startsWith('knee') ? 2.2 : 1.2)
  }
  return out
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
})

afterAll(() => clearMocapBodies())

describe('mocap body: fitting the A-rest', () => {
  it('stands at the catalog height with the soles on the floor, arms hanging and legs vertical', () => {
    for (const id of [MALE, FEMALE]) {
      const rig = mocapRig(id)!
      expect(rig.dims.H).toBe(assetSpec(id).height)
      expect(lowestY(bodyShape(id), undefined)).toBeCloseTo(0, 9)
      const r = (b: string): V3 => rig.rest[BONE_INDEX[b as (typeof MOCAP_BONES)[number]]]!
      for (const sd of ['Left', 'Right']) {
        expect(r(`${sd}Hand`).x).toBeCloseTo(r(`${sd}ForeArm`).x, 9)
        expect(r(`${sd}Hand`).z).toBeCloseTo(r(`${sd}ForeArm`).z, 9)
        expect(r(`${sd}ForeArm`).x).toBeCloseTo(r(`${sd}Arm`).x, 9)
        expect(r(`${sd}Hand`).y).toBeLessThan(r(`${sd}ForeArm`).y)
        expect(r(`${sd}Leg`).x).toBeCloseTo(r(`${sd}UpLeg`).x, 9)
        expect(r(`${sd}Foot`).z).toBeCloseTo(r(`${sd}UpLeg`).z, 9)
      }
      // Left is −X (the entity faces −Z), the pelvis right over the root.
      expect(r('LeftArm').x).toBeLessThan(0)
      expect(r('Hips').x).toBe(0)
      expect(r('Hips').z).toBe(0)
    }
  })

  it('measures the rig dims off the skeleton (fixture lengths × the height scale)', () => {
    const rig = mocapRig(MALE)!
    // The fixture's head top is at 1.77 m; vertical legs drop the soles 0.6 mm.
    const k = rig.scale
    expect(k).toBeCloseTo(1.8 / 1.77, 3)
    const d = rig.dims
    expect(d.upperArmLen).toBeCloseTo(0.28 * k, 9)
    expect(d.lowerArmLen).toBeCloseTo((0.27 + 0.065) * k, 9)
    expect(d.upperLegLen).toBeCloseTo(Math.hypot(0.005, 0.4, 0.005) * k, 9)
    expect(d.legLen).toBeCloseTo(d.upperLegLen + d.lowerLegLen, 12)
    expect(d.shoulderX).toBeCloseTo(0.18 * k, 9)
    expect(d.hipX).toBeCloseTo(0.09 * k, 9)
    expect(d.headR).toBeCloseTo(0.11 * k, 9)
  })

  it('a bot that is not registered stands in as its studio mannequin', () => {
    expect(mocapStandIn(MALE)).toBe(MALE)
    expect(mocapStandIn('person.man')).toBe('person.man')
    const keep = { male: fixtureSource(), female: fixtureSource(0.93) }
    clearMocapBodies()
    try {
      expect(mocapStandIn(FEMALE)).toBe('person.mannequinFemale')
      expect(personDims(FEMALE)).toEqual(personDims('person.mannequinFemale'))
      expect(bodyShape(MALE).balls).toEqual(bodyShape('person.mannequinMale').balls)
      expect(torsoShape(FEMALE, undefined, personDims(FEMALE))).toEqual(torsoShape('person.mannequinFemale', undefined, personDims('person.mannequinFemale')))
    } finally {
      registerMocapBody(MALE, keep.male)
      registerMocapBody(FEMALE, keep.female)
    }
  })
})

describe('mocap body: FK', () => {
  it('at rest every frame sits on its joint, unrotated but for the arms turned out', () => {
    const d = personDims(MALE)
    const rig = mocapRig(MALE)!
    const fr = poseFrames(d, undefined)
    for (const [f, b] of [['pelvis', 'Hips'], ['shoulderL', 'LeftArm'], ['hipL', 'LeftUpLeg'], ['kneeR', 'RightLeg']] as const) {
      expect(dist(fr[f].p, rig.rest[BONE_INDEX[b]]!)).toBeLessThan(1e-12)
      const a = f === 'shoulderL' ? -rig.armRest : 0
      fr[f].r.forEach((e, i) => expect(e).toBeCloseTo([Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1][i]!, 12))
    }
    // The fixture's hips are wider than its hanging hands: the arms turn out a little.
    expect(rig.armRest).toBeGreaterThan(0)
    expect(rig.armRest).toBeLessThan(0.2)
    const fx = poseEffectors(d, undefined)
    // The hand point is the palm: below the wrist, half way to the knuckles.
    const wrist = mocapPose(d.mocap!, jointLocals(undefined)).P[BONE_INDEX.LeftHand]!
    expect(dist(fx.handL, wrist)).toBeCloseTo(0.065 * rig.scale, 9)
    expect(fx.handL.x).toBeLessThan(wrist.x)
    // The head effector is the head's centre.
    expect(fx.head.y).toBeCloseTo((1.66 - rig.centre.y) * rig.scale, 9)
  })

  it('bends the elbow forward and raises the arm out, as the rig does', () => {
    const d = personDims(MALE)
    const rest = poseEffectors(d, undefined)
    const bent = poseEffectors(d, { elbowL: 1.2 })
    const L = d.lowerArmLen
    // The forearm swings forward (−Z) about the elbow, in the arm's turned-out plane.
    const r = poseFrames(d, undefined).elbowL.r
    const v = { x: 0, y: -L * Math.cos(1.2), z: -L * Math.sin(1.2) }
    const want = { x: rest.elbowL.x + r[0] * v.x + r[1] * v.y + r[2] * v.z, y: rest.elbowL.y + r[3] * v.x + r[4] * v.y + r[5] * v.z, z: rest.elbowL.z + r[6] * v.x + r[7] * v.y + r[8] * v.z }
    expect(dist(bent.handL, want)).toBeLessThan(1e-9)
    expect(bent.handL.z).toBeCloseTo(rest.elbowL.z - L * Math.sin(1.2), 9)
    const out = poseEffectors(d, { shoulderLZ: Math.PI / 2 - mocapRig(MALE)!.armRest })
    expect(out.elbowL.y).toBeCloseTo(rest.shoulderL.y, 9)
    expect(out.elbowL.x).toBeCloseTo(rest.shoulderL.x - d.upperArmLen, 9)
    // Negative hipRX raises the leg forward (−Z), as on the rig.
    expect(poseEffectors(d, { hipRX: -1 }).footR.z).toBeLessThan(rest.footR.z - 0.3)
  })

  it('spreads the torso over Spine / Spine1 / Spine2 and the head over Neck / Head', () => {
    const m = personDims(MALE).mocap!
    const pose = mocapPose(m, jointLocals({ torsoY: 0.9, headX: 0.6 }))
    const fwd = (b: (typeof MOCAP_BONES)[number]): V3 => qrot(pose.G[BONE_INDEX[b]]!, { x: 0, y: 0, z: -1 })
    const yaw = (v: V3): number => Math.atan2(-v.x, -v.z)
    expect(yaw(fwd('Spine'))).toBeCloseTo(0.3, 9)
    expect(yaw(fwd('Spine1'))).toBeCloseTo(0.6, 9)
    expect(yaw(fwd('Spine2'))).toBeCloseTo(0.9, 9)
    const up = (b: (typeof MOCAP_BONES)[number]): V3 => qrot(pose.G[BONE_INDEX[b]]!, { x: 0, y: 1, z: 0 })
    const tilt = (b: (typeof MOCAP_BONES)[number]): number => Math.acos(up(b).y)
    expect(tilt('Neck')).toBeCloseTo(0.3, 9)
    expect(tilt('Head')).toBeCloseTo(0.6, 9)
  })

  it('root pitch tips the whole body about the pelvis (prone at +90°)', () => {
    const d = personDims(MALE)
    const fx = poseEffectors(d, { rootX: Math.PI / 2 })
    const pelvis = poseEffectors(d, undefined).pelvis
    expect(dist(fx.pelvis, pelvis)).toBeLessThan(1e-12)
    expect(fx.head.y).toBeCloseTo(pelvis.y, 1)
    expect(fx.head.z).toBeLessThan(pelvis.z - 0.5)
  })

  it('height scales the whole body', () => {
    const a = poseEffectors(personDims(MALE), { elbowR: 0.7, kneeL: 0.4 })
    const b = poseEffectors(personDims(MALE, { height: 1.1 }), { elbowR: 0.7, kneeL: 0.4 })
    for (const e of ['handR', 'footL', 'head', 'chest'] as const) expect(dist(b[e], { x: a[e].x * 1.1, y: a[e].y * 1.1, z: a[e].z * 1.1 })).toBeLessThan(1e-12)
    expect(personDims(MALE, { build: 1.3 })).toEqual(personDims(MALE))
  })
})

describe('mocap body: proxies', () => {
  it('the floor proxy finds the lowest point of the rigidly posed surface within 3 mm', () => {
    const r = rng(7)
    const m = personDims(MALE).mocap!
    const rig = m.rig
    const coreOf = (name: string): number => {
      for (let n: string | null = name; n; n = FIXTURE_BONES.find((b) => b[0] === n)![1]) {
        const i = (MOCAP_BONES as readonly string[]).indexOf(n)
        if (i >= 0) return i
      }
      return 0
    }
    const shape = bodyShape(MALE)
    // Every fixture surface point, put in the A-rest independently of the fit, rides its core bone: P + G · (rest − joint).
    for (let trial = 0; trial < 60; trial++) {
      const joints = randomJoints(r)
      const pose = mocapPose(m, jointLocals(joints))
      let truth = Infinity
      for (const s of fixtureSurfaces()) {
        const i = coreOf(s.bone)
        for (const p0 of s.points) {
          const p = restPoint(rig, s.bone, p0)
          const w = { x: p.x - rig.rest[i]!.x, y: p.y - rig.rest[i]!.y, z: p.z - rig.rest[i]!.z }
          truth = Math.min(truth, pose.P[i]!.y + qrot(pose.G[i]!, w).y)
        }
      }
      expect(Math.abs(lowestY(shape, joints) - truth), JSON.stringify(joints)).toBeLessThan(0.003)
    }
  })

  it('bodyLowY of a bot is the lowest proxy point, scaled', () => {
    const j = { kneeL: 1.2, hipLX: 0.8 }
    expect(bodyLowY({ assetId: MALE, scale: 2 }, j)).toBeCloseTo(2 * lowestY(bodyShape(MALE), j), 12)
  })

  it('the torso is a loft cut from the chest and belly', () => {
    const t = torsoShape(MALE, undefined, personDims(MALE))
    expect(t.kind).toBe('loft')
    if (t.kind !== 'loft') return
    expect(t.rings.every((ring) => ring.length === 32)).toBe(true)
    // The fixture chest is 0.34 m wide: the widest ring reaches about 0.17 × the height scale.
    const wide = Math.max(...t.rings.flatMap((ring) => ring.map(([x]) => Math.abs(x))))
    expect(wide).toBeCloseTo(0.17 * (1.8 / 1.77), 2)
  })
})

describe('mocap body: consumers', () => {
  it('the Fight Director lands every blow between two bots within 3 cm', () => {
    const parsed = parseFightScript(`A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> hit power 1
B elbow to head -> hit power 0.8
A roundhouse to head -> ko power 1`, ['A', 'B'])
    if ('error' in parsed) throw new Error(parsed.error)
    const fight = { id: 'fight_m', name: 'Bots', fighterIds: ['ent_a', 'ent_b'] as [string, string], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
    const sol = solveFight(fight, [
      { entityId: 'ent_a', assetId: MALE, scale: 1, start: { x: -0.55, y: 0, z: 0 } },
      { entityId: 'ent_b', assetId: FEMALE, scale: 1, start: { x: 0.55, y: 0, z: 0 } }
    ], { duration: 30, fps: 24 })
    const errors = sol.report.beats.flatMap((b) => b.contactErrorM)
    expect(errors.length).toBeGreaterThan(4)
    for (const e of errors) expect(e).toBeLessThan(0.03)
  })

  it('shot words and the clear-view check aim at a bot by its own head and chest', () => {
    const bot = { id: 'a', assetId: FEMALE, scale: 1, position: { x: 0, y: 0, z: -4 }, heading: 0, joints: { torsoX: 0.6 } }
    const fx = poseEffectors(personDims(FEMALE), bot.joints)
    const targets = subjectTargets(bot)
    expect(dist(targets[0]!.p, { x: fx.head.x, y: fx.head.y, z: fx.head.z - 4 })).toBeLessThan(1e-12)
    expect(dist(targets[1]!.p, { x: fx.chest.x, y: fx.chest.y, z: fx.chest.z - 4 })).toBeLessThan(1e-12)
    const cam = solveShot({ size: 'CU', subjectIds: ['a'] }, [bot], { sensorId: 'super35', aspect: '16:9', focalLength: 35 })
    expect(Math.abs(cam.position.y - fx.head.y)).toBeLessThan(0.25)
  })

  it('a held pistol sits in the palm, and the arm IK reaches a target', () => {
    const d = personDims(MALE)
    const spec = weaponSpec('prop.pistol')!
    const joints = { shoulderRX: 1.2, elbowR: 0.3, torsoY: 0.2 }
    const grip = heldPointLocal(d, joints, 'R', spec, spec.grip, 1)
    expect(dist(grip, poseEffectors(d, joints).handR)).toBeLessThan(1e-9)
    const target = poseEffectors(d, { shoulderLX: 0.9, shoulderLZ: 0.3, elbowL: 1.1, torsoX: 0.3 }).handL
    const ik = solveArmIK(d, { torsoX: 0.3 }, 'L', target)
    expect(dist(poseEffectors(d, { torsoX: 0.3, ...ik }).handL, target)).toBeLessThan(1e-6)
  })
})

/* -------------------- the body call, bit-identical for the old bodies -------------------- */

type M3 = [number, number, number, number, number, number, number, number, number]
interface LFrame {
  p: V3
  r: M3
}
const LI: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
function lmul(a: M3, b: M3): M3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8]
  ]
}
function leuler(x: number, y: number, z: number): M3 {
  const cx = Math.cos(x)
  const sx = Math.sin(x)
  const cy = Math.cos(y)
  const sy = Math.sin(y)
  const cz = Math.cos(z)
  const sz = Math.sin(z)
  const rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  return lmul(lmul(rx, ry), rz)
}
function lapply(m: M3, v: V3): V3 {
  return { x: m[0] * v.x + m[1] * v.y + m[2] * v.z, y: m[3] * v.x + m[4] * v.y + m[5] * v.z, z: m[6] * v.x + m[7] * v.y + m[8] * v.z }
}
function lchild(parent: LFrame, offset: V3, rot: M3): LFrame {
  const o = lapply(parent.r, offset)
  return { p: { x: parent.p.x + o.x, y: parent.p.y + o.y, z: parent.p.z + o.z }, r: lmul(parent.r, rot) }
}
const lpoint = (f: LFrame, local: V3): V3 => {
  const o = lapply(f.r, local)
  return { x: f.p.x + o.x, y: f.p.y + o.y, z: f.p.z + o.z }
}
const lv = (x: number, y: number, z: number): V3 => ({ x, y, z })

/** skeleton.ts `poseFrames` / `poseEffectors` before the mocap body kind (frozen copy). */
function legacyFrames(dims: PersonDims, joints: Record<string, number> | undefined): Record<string, LFrame> {
  const j = (k: string): number => joints?.[k] ?? 0
  const root: LFrame = { p: lv(0, 0, 0), r: LI }
  const pelvis = lchild(root, lv(0, dims.legLen, 0), leuler(-j('rootX'), j('rootY'), -j('rootZ')))
  const torso = lchild(pelvis, lv(0, 0.08 * dims.s, 0), leuler(dims.baseLean - j('torsoX'), j('torsoY'), -j('torsoZ')))
  const head = lchild(torso, lv(0, dims.torsoLen, 0), leuler(-j('headX'), j('headY'), -j('headZ')))
  const shoulderL = lchild(torso, lv(-dims.shoulderX, dims.shoulderY, 0), leuler(-j('shoulderLX'), 0, -j('shoulderLZ')))
  const shoulderR = lchild(torso, lv(dims.shoulderX, dims.shoulderY, 0), leuler(-j('shoulderRX'), 0, j('shoulderRZ')))
  const elbowL = lchild(shoulderL, lv(0, -dims.upperArmLen, 0), leuler(j('elbowL'), 0, 0))
  const elbowR = lchild(shoulderR, lv(0, -dims.upperArmLen, 0), leuler(j('elbowR'), 0, 0))
  const hipL = lchild(pelvis, lv(-dims.hipX, 0, 0), leuler(-j('hipLX'), 0, -j('hipLZ')))
  const hipR = lchild(pelvis, lv(dims.hipX, 0, 0), leuler(-j('hipRX'), 0, j('hipRZ')))
  const kneeL = lchild(hipL, lv(0, -dims.upperLegLen, 0), leuler(-j('kneeL'), 0, 0))
  const kneeR = lchild(hipR, lv(0, -dims.upperLegLen, 0), leuler(-j('kneeR'), 0, 0))
  return { pelvis, torso, head, shoulderL, shoulderR, elbowL, elbowR, hipL, hipR, kneeL, kneeR }
}

function legacyEffectors(dims: PersonDims, joints: Record<string, number> | undefined): Record<string, V3> {
  const f = legacyFrames(dims, joints)
  const toe = lv(0, -dims.lowerLegLen + 0.03 * dims.s, -0.16 * dims.s)
  return {
    handL: lpoint(f.elbowL!, lv(0, -dims.lowerArmLen, 0)),
    handR: lpoint(f.elbowR!, lv(0, -dims.lowerArmLen, 0)),
    elbowL: f.elbowL!.p,
    elbowR: f.elbowR!.p,
    footL: lpoint(f.kneeL!, toe),
    footR: lpoint(f.kneeR!, toe),
    kneeL: f.kneeL!.p,
    kneeR: f.kneeR!.p,
    head: lpoint(f.head!, lv(0, dims.headR + 0.06 * dims.s, 0)),
    chest: lpoint(f.torso!, lv(0, 0.55 * dims.torsoLen, 0)),
    pelvis: f.pelvis!.p,
    shoulderL: f.shoulderL!.p,
    shoulderR: f.shoulderR!.p
  }
}

/** Every number equal by Object.is (bit-identical, −0 included). */
function same(a: unknown, b: unknown, path: string): void {
  if (typeof a === 'number' || typeof b === 'number') {
    if (!Object.is(a, b)) throw new Error(`${path}: ${String(a)} !== ${String(b)}`)
    return
  }
  const ka = Object.keys(a as object).sort()
  const kb = Object.keys(b as object).sort()
  expect(ka, path).toEqual(kb)
  for (const k of ka) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
}

describe('the body call is bit-identical for the old bodies', () => {
  it('frames and effectors of the six procedural bodies match the frozen copy exactly', () => {
    const r = rng(42)
    for (const id of ['person.man', 'person.woman', 'person.child', 'person.elderly', 'person.mannequinMale', 'person.mannequinFemale']) {
      for (const params of [undefined, { height: 0.85, build: 1.2 }, { height: 1.15, build: 0.9 }]) {
        const d = personDims(id, params)
        expect(d.mocap).toBeUndefined()
        for (let n = 0; n < 60; n++) {
          const joints = n === 0 ? undefined : randomJoints(r)
          same(poseFrames(d, joints), legacyFrames(d, joints), `${id} frames`)
          same(poseEffectors(d, joints), legacyEffectors(d, joints), `${id} effectors`)
        }
      }
    }
  }, 15_000)
})

let REST_CACHE: Map<string, (p: V3) => V3> | null = null

/** A fixture surface point in the A-rest, rigid with its bone. */
function restPoint(rig: NonNullable<ReturnType<typeof mocapRig>>, bone: string, p: V3): V3 {
  if (!REST_CACHE) REST_CACHE = buildRest(rig)
  return REST_CACHE.get(bone)!(p)
}

/** Independent A-rest: swing the fixture's limbs down about their joints, then centre and scale like the fit. */
function buildRest(rig: NonNullable<ReturnType<typeof mocapRig>>): Map<string, (p: V3) => V3> {
  const def = new Map(FIXTURE_BONES.map((b) => [b[0], b]))
  const pos = (n: string): V3 => ({ x: def.get(n)![2], y: def.get(n)![3], z: def.get(n)![4] })
  const SW: Record<string, string> = {
    LeftArm: 'LeftForeArm',
    LeftForeArm: 'LeftHand',
    LeftHand: 'LeftHandMiddle1',
    RightArm: 'RightForeArm',
    RightForeArm: 'RightHand',
    RightHand: 'RightHandMiddle1',
    LeftUpLeg: 'LeftLeg',
    LeftLeg: 'LeftFoot',
    RightUpLeg: 'RightLeg',
    RightLeg: 'RightFoot'
  }
  // Rotation that takes a → down, as an axis-angle applied with Rodrigues.
  const swing = (from: V3): ((v: V3) => V3) => {
    const l = Math.hypot(from.x, from.y, from.z)
    const a = { x: from.x / l, y: from.y / l, z: from.z / l }
    const axis = { x: a.y * 0 - a.z * -1, y: a.z * 0 - a.x * 0, z: a.x * -1 - a.y * 0 }
    const s = Math.hypot(axis.x, axis.y, axis.z)
    const c = -a.y
    if (s < 1e-12) return (v) => v
    const k = { x: axis.x / s, y: axis.y / s, z: axis.z / s }
    return (v) => {
      const kv = k.x * v.x + k.y * v.y + k.z * v.z
      const cr = { x: k.y * v.z - k.z * v.y, y: k.z * v.x - k.x * v.z, z: k.x * v.y - k.y * v.x }
      return { x: v.x * c + cr.x * s + k.x * kv * (1 - c), y: v.y * c + cr.y * s + k.y * kv * (1 - c), z: v.z * c + cr.z * s + k.z * kv * (1 - c) }
    }
  }
  // World-space A-rest: each bone's (rotation about its joint, joint) from the root down.
  const rest = new Map<string, { rot: (v: V3) => V3; at: V3 }>()
  for (const [name, parent] of FIXTURE_BONES) {
    const own = SW[name] ? swing({ x: pos(SW[name]).x - pos(name).x, y: pos(SW[name]).y - pos(name).y, z: pos(SW[name]).z - pos(name).z }) : null
    if (!parent) {
      rest.set(name, { rot: own ?? ((v) => v), at: pos(name) })
      continue
    }
    const pr = rest.get(parent)!
    const d = pr.rot({ x: pos(name).x - pos(parent).x, y: pos(name).y - pos(parent).y, z: pos(name).z - pos(parent).z })
    const at = { x: pr.at.x + d.x, y: pr.at.y + d.y, z: pr.at.z + d.z }
    const core = (MOCAP_BONES as readonly string[]).includes(name)
    rest.set(name, { rot: own ?? (core ? (v) => v : pr.rot), at })
  }
  const k = rig.scale
  const c = rig.centre
  const out = new Map<string, (p: V3) => V3>()
  for (const [name, r] of rest) {
    out.set(name, (p) => {
      const w = r.rot({ x: p.x - pos(name).x, y: p.y - pos(name).y, z: p.z - pos(name).z })
      return { x: (r.at.x + w.x - c.x) * k, y: (r.at.y + w.y - c.y) * k, z: (r.at.z + w.z - c.z) * k }
    })
  }
  return out
}
