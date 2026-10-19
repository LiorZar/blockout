import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3 } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { MOTION_PRESETS } from '@engine/motions'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { assetSpec } from '@engine/assets'
import {
  WEAPON_SPECS,
  weaponSpec,
  handFrame,
  holdTransform,
  heldPointLocal,
  aimDirectionLocal,
  idleJoints,
  solveArmIK,
  type Hand
} from '@engine/weapons'
import type { V3 } from '@engine/types'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KEYS = [
  'shoulderLX', 'shoulderRX', 'shoulderLZ', 'shoulderRZ', 'elbowL', 'elbowR', 'hipLX', 'hipRX',
  'hipLZ', 'hipRZ', 'kneeL', 'kneeR', 'torsoX', 'torsoY', 'torsoZ', 'headX', 'headY', 'headZ'
]

function randomPoses(n: number, seed: number): Record<string, number>[] {
  const rnd = rng(seed)
  const out: Record<string, number>[] = []
  for (let i = 0; i < n; i++) {
    const pose: Record<string, number> = {}
    for (const k of KEYS) pose[k] = (rnd() - 0.5) * 3
    out.push(pose)
  }
  return out
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z

const WEAPON_POSES = MOTION_PRESETS.filter((m) =>
  ['sword-slash-combo', 'sword-thrust', 'pistol-aim-fire', 'rifle-aim-sweep', 'bow-draw-loose', 'shield-brace'].includes(m.id)
).flatMap((m) => m.keyframes.map((k) => k.joints))

describe('weapon catalog', () => {
  it('covers every weapon from the brief, each with a catalog asset', () => {
    const ids = WEAPON_SPECS.map((w) => w.assetId).sort()
    expect(ids).toEqual(
      [
        'prop.axe', 'prop.baseballBat', 'prop.bow', 'prop.katana', 'prop.knife', 'prop.pistol', 'prop.rifle',
        'prop.shield', 'prop.shotgun', 'prop.spear', 'prop.staff', 'prop.sword'
      ].sort()
    )
    for (const w of WEAPON_SPECS) {
      const spec = assetSpec(w.assetId)
      expect(spec.category, w.assetId).not.toBe('custom')
      expect(spec.motion).toBe('static')
    }
    expect(weaponSpec('person.man')).toBeUndefined()
    expect(weaponSpec('prop.cup')).toBeUndefined()
  })

  it('bow and shield default to the left hand; two-handers carry a support point', () => {
    expect(weaponSpec('prop.bow')!.defaultHand).toBe('L')
    expect(weaponSpec('prop.shield')!.defaultHand).toBe('L')
    expect(weaponSpec('prop.sword')!.defaultHand).toBe('R')
    for (const id of ['prop.rifle', 'prop.shotgun', 'prop.spear', 'prop.staff', 'prop.baseballBat', 'prop.katana']) {
      expect(weaponSpec(id)!.twoHanded, id).toBe(true)
      expect(weaponSpec(id)!.support, id).toBeDefined()
    }
    expect(weaponSpec('prop.bow')!.twoHanded).toBe(true)
    expect(weaponSpec('prop.bow')!.support).toBeUndefined()
    expect(weaponSpec('prop.pistol')!.twoHanded).toBe(false)
  })

  it('every hold is a proper rotation in both hands', () => {
    for (const w of WEAPON_SPECS) {
      for (const hand of ['L', 'R'] as Hand[]) {
        const { r } = holdTransform(w, hand, 1)
        const c0 = { x: r[0], y: r[3], z: r[6] }
        const c1 = { x: r[1], y: r[4], z: r[7] }
        const c2 = { x: r[2], y: r[5], z: r[8] }
        for (const c of [c0, c1, c2]) expect(Math.hypot(c.x, c.y, c.z)).toBeCloseTo(1, 12)
        expect(dot(c0, c1)).toBeCloseTo(0, 12)
        const det =
          r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6])
        expect(det, `${w.assetId} ${hand}`).toBeCloseTo(1, 12)
      }
    }
  })
})

describe('hand frame', () => {
  const poses = [undefined, ...WEAPON_POSES, ...randomPoses(25, 11)]

  it('hand position equals skeleton.ts poseEffectors (drift guard)', () => {
    for (const [assetId, params] of [
      ['person.man', { height: 1.1, build: 1.2 }],
      ['person.elderly', {}],
      ['person.child', { build: 0.8 }],
      ['person.mannequinMale', { build: 1.2 }],
      ['person.mannequinFemale', {}]
    ] as [string, Record<string, number>][]) {
      const dims = personDims(assetId, params)
      for (const joints of poses) {
        const fx = poseEffectors(dims, joints)
        expect(dist(handFrame(dims, joints, 'L').p, fx.handL)).toBeLessThan(1e-12)
        expect(dist(handFrame(dims, joints, 'R').p, fx.handR)).toBeLessThan(1e-12)
      }
    }
  })

  it('position and orientation equal the rendered rig (three.js elbow groups)', () => {
    for (const [assetId, params] of [
      ['person.man', { height: 1.1, build: 1.2 }],
      ['person.woman', {}],
      ['person.elderly', { height: 0.9 }],
      ['person.mannequinMale', {}],
      ['person.mannequinFemale', { height: 1.1 }]
    ] as [string, Record<string, number>][]) {
      const built = buildAsset(assetId, params)
      const dims = personDims(assetId, params)
      for (const joints of poses) {
        built.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
        built.group.updateMatrixWorld(true)
        for (const hand of ['L', 'R'] as Hand[]) {
          const elbow = built.group.getObjectByName(hand === 'L' ? 'elbowL' : 'elbowR')!
          const p = elbow.localToWorld(new Vector3(0, -dims.lowerArmLen, 0))
          const m = new Matrix4().extractRotation(elbow.matrixWorld).elements // column-major
          const f = handFrame(dims, joints, hand)
          expect(dist(f.p, p), `${assetId} ${hand} p`).toBeLessThan(1e-6)
          // f.r is row-major: r[row*3+col].
          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
              expect(Math.abs(f.r[row * 3 + col]! - m[col * 4 + row]!), `${assetId} ${hand} r${row}${col}`).toBeLessThan(1e-6)
            }
          }
        }
      }
    }
  })
})

describe('held weapon points', () => {
  const dims = personDims('person.man')
  const tip = (id: string, joints: Record<string, number> | undefined, hand: Hand = 'R'): V3 => {
    const w = weaponSpec(id)!
    return heldPointLocal(dims, joints, hand, w, w.tip, 1)
  }
  const grip = (id: string, joints: Record<string, number> | undefined, hand: Hand = 'R'): V3 => {
    const w = weaponSpec(id)!
    return heldPointLocal(dims, joints, hand, w, w.grip, 1)
  }

  it('the grip lands exactly on the hand point, in both hands, at any weapon scale', () => {
    for (const w of WEAPON_SPECS) {
      for (const hand of ['L', 'R'] as Hand[]) {
        for (const joints of [undefined, ...randomPoses(5, 3)]) {
          const h = handFrame(dims, joints, hand).p
          expect(dist(heldPointLocal(dims, joints, hand, w, w.grip, 1.3), h)).toBeLessThan(1e-12)
        }
      }
    }
  })

  it('a sword at rest points down and a little forward; the thrust lunge levels it at the target', () => {
    const rest = tip('prop.sword', {})
    const g = grip('prop.sword', {})
    expect(rest.y).toBeLessThan(g.y - 0.6)
    expect(rest.z).toBeLessThan(g.z - 0.1)
    const lunge = MOTION_PRESETS.find((m) => m.id === 'sword-thrust')!.keyframes[2]!.joints
    const t = tip('prop.sword', lunge)
    const h = grip('prop.sword', lunge)
    expect(t.z).toBeLessThan(h.z - 0.8)
    expect(Math.abs(t.y - h.y)).toBeLessThan(0.15)
  })

  it('the slash follows through forward and out to the sword side', () => {
    const slash = MOTION_PRESETS.find((m) => m.id === 'sword-slash-combo')!.keyframes[1]!.joints
    const t = tip('prop.sword', slash)
    const h = grip('prop.sword', slash)
    expect(t.z).toBeLessThan(h.z - 0.4)
    expect(t.x).toBeGreaterThan(h.x + 0.3)
  })

  it('pistol aim puts the muzzle in front of the hand, level, the barrel along the forearm', () => {
    const aim = MOTION_PRESETS.find((m) => m.id === 'pistol-aim-fire')!.keyframes[1]!.joints
    const w = weaponSpec('prop.pistol')!
    const d = aimDirectionLocal(dims, aim, 'R', w)
    expect(d.z).toBeLessThan(-0.98)
    const fx = poseEffectors(dims, aim)
    const forearm = { x: fx.handR.x - fx.elbowR.x, y: fx.handR.y - fx.elbowR.y, z: fx.handR.z - fx.elbowR.z }
    const n = Math.hypot(forearm.x, forearm.y, forearm.z)
    expect(dot(d, { x: forearm.x / n, y: forearm.y / n, z: forearm.z / n })).toBeGreaterThan(0.999)
    const muzzle = tip('prop.pistol', aim)
    expect(muzzle.z).toBeLessThan(fx.handR.z - 0.1)
    expect(muzzle.y).toBeGreaterThan(fx.handR.y)
  })

  it('a left-hand hold is the mirror image of the right-hand hold', () => {
    const SWAP: Record<string, string> = {
      shoulderLX: 'shoulderRX', shoulderRX: 'shoulderLX', shoulderLZ: 'shoulderRZ', shoulderRZ: 'shoulderLZ',
      elbowL: 'elbowR', elbowR: 'elbowL', hipLX: 'hipRX', hipRX: 'hipLX', hipLZ: 'hipRZ', hipRZ: 'hipLZ',
      kneeL: 'kneeR', kneeR: 'kneeL'
    }
    const NEGATE = new Set(['torsoY', 'torsoZ', 'headY', 'headZ'])
    const mirror = (j: Record<string, number>): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const [k, val] of Object.entries(j)) out[SWAP[k] ?? k] = NEGATE.has(k) ? -val : val
      return out
    }
    for (const w of WEAPON_SPECS) {
      for (const joints of randomPoses(4, 5)) {
        for (const p of [w.tip, w.grip, ...(w.support ? [w.support] : [])]) {
          const r = heldPointLocal(dims, joints, 'R', w, p, 1)
          const l = heldPointLocal(dims, mirror(joints), 'L', w, p, 1)
          expect(Math.abs(l.x + r.x), w.assetId).toBeLessThan(1e-9)
          expect(Math.abs(l.y - r.y), w.assetId).toBeLessThan(1e-9)
          expect(Math.abs(l.z - r.z), w.assetId).toBeLessThan(1e-9)
        }
      }
    }
  })

  it('world points follow toWorld (position, heading, holder scale)', () => {
    const w = weaponSpec('prop.spear')!
    const local = heldPointLocal(dims, {}, 'R', w, w.tip, 1)
    const world = toWorld(local, { x: 2, y: 0.5, z: -3 }, 0.7, 1.1)
    const c = Math.cos(0.7)
    const s = Math.sin(0.7)
    expect(world.x).toBeCloseTo(2 + local.x * 1.1 * c + local.z * 1.1 * s, 12)
    expect(world.y).toBeCloseTo(0.5 + local.y * 1.1, 12)
  })
})

describe('idle grip poses and off-hand IK', () => {
  const dims = personDims('person.man')

  it('idle poses only touch the holding arm, mirrored for the left hand', () => {
    for (const w of WEAPON_SPECS) {
      for (const k of Object.keys(idleJoints(w, 'R'))) expect(['shoulderRX', 'shoulderRZ', 'elbowR'], w.assetId).toContain(k)
      for (const k of Object.keys(idleJoints(w, 'L'))) expect(['shoulderLX', 'shoulderLZ', 'elbowL'], w.assetId).toContain(k)
      expect(idleJoints(w, 'L').elbowL).toBe(idleJoints(w, 'R').elbowR)
    }
  })

  it('a held blade at idle is in front of the body, not inside the thigh', () => {
    for (const id of ['prop.sword', 'prop.katana', 'prop.knife', 'prop.axe']) {
      const w = weaponSpec(id)!
      const idle = idleJoints(w, 'R')
      const t = heldPointLocal(dims, idle, 'R', w, w.tip, 1)
      expect(t.z, id).toBeLessThan(-0.25)
    }
  })

  it('blades, clubs and shafts idle at low ready: tip forward and 15–50° below level, not lances', () => {
    for (const id of ['prop.sword', 'prop.katana', 'prop.knife', 'prop.axe', 'prop.baseballBat', 'prop.spear', 'prop.staff']) {
      const w = weaponSpec(id)!
      for (const hand of ['L', 'R'] as Hand[]) {
        const d = aimDirectionLocal(dims, idleJoints(w, hand), hand, w)
        const below = (Math.asin(-d.y) * 180) / Math.PI
        expect(d.z, `${id} ${hand}`).toBeLessThan(-0.5)
        expect(below, `${id} ${hand}`).toBeGreaterThan(15)
        expect(below, `${id} ${hand}`).toBeLessThan(50)
      }
    }
  })

  it('arm IK reaches reachable targets exactly and straightens toward unreachable ones', () => {
    const rnd = rng(9)
    for (const side of ['L', 'R'] as Hand[]) {
      for (let i = 0; i < 60; i++) {
        const torso = { torsoX: (rnd() - 0.5) * 0.8, torsoY: (rnd() - 0.5) * 1.2, torsoZ: (rnd() - 0.5) * 0.6 }
        // A reachable target: forward-generate a hand position from random arm channels.
        const arm0: Record<string, number> =
          side === 'L'
            ? { shoulderLX: (rnd() - 0.7) * 3, shoulderLZ: (rnd() - 0.5) * 2, elbowL: rnd() * 2.2 }
            : { shoulderRX: (rnd() - 0.7) * 3, shoulderRZ: (rnd() - 0.5) * 2, elbowR: rnd() * 2.2 }
        const target = handFrame(dims, { ...torso, ...arm0 }, side).p
        const arm = solveArmIK(dims, torso, side, target)
        const hand = handFrame(dims, { ...torso, ...arm }, side).p
        expect(dist(hand, target), `${side} #${i}`).toBeLessThan(1e-9)
        expect(arm[side === 'L' ? 'elbowL' : 'elbowR']).toBeGreaterThanOrEqual(0)
      }
    }
    const far = solveArmIK(dims, {}, 'L', { x: -0.2, y: 1.4, z: -3 })
    expect(far.elbowL).toBeCloseTo(0, 9)
    const sh = poseEffectors(dims, {}).shoulderL
    const reached = handFrame(dims, far, 'L').p
    const dir = { x: -0.2 - sh.x, y: 1.4 - sh.y, z: -3 - sh.z }
    const n = Math.hypot(dir.x, dir.y, dir.z)
    const along = { x: (reached.x - sh.x) / (dims.upperArmLen + dims.lowerArmLen), y: (reached.y - sh.y) / (dims.upperArmLen + dims.lowerArmLen), z: (reached.z - sh.z) / (dims.upperArmLen + dims.lowerArmLen) }
    expect(dot(along, { x: dir.x / n, y: dir.y / n, z: dir.z / n })).toBeGreaterThan(0.9999)
  })
})
