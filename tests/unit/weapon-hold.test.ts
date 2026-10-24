// Fork addition (2026, held-weapons): a bot's held weapon turns in the grip to clear its own body on clips the library recorded empty-handed (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildAsset, type AnimInput } from '@renderer/viewport/builders'
import { heldWeaponMatrix, steadyArm } from '@renderer/viewport/hold'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { clearMocapBodies } from '@engine/mocap/registry'
import { botPose } from '@engine/mocap/clip'
import { BONE_INDEX, MOCAP_BONES } from '@engine/mocap/rig'
import { boneSkin, skinDepth } from '@engine/mocap/surface'
import { personDims, type PersonDims } from '@engine/skeleton'
import { handFrame, heldPointLocal, holdJoints, TRAVEL_CARRY, travelCarry, weaponRotation, weaponSpec, type Hand } from '@engine/weapons'
import { heldWeaponSamples, weaponSamples } from '@engine/weapon-shape'
import { holdDepth, holdLoop, holdTurn, rigLift } from '@engine/weapon-hold'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import type { ClipState, V3 } from '@engine/types'
import { botInput } from '@renderer/mocap/scene'
import type { BotHold } from '@renderer/mocap/body'
import type { MocapPose } from '@engine/mocap/fk'
import type { Entity, EntityState, Scene, Shot } from '@engine/types'
import { ShotEvaluator } from '@engine/evaluate'
import { fixtureCharacter } from './mocap-three-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const STAND: AnimInput = { gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 }
const far = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// The right fist pulled in to the belly, then up across the chest: a club or a long gun held in it goes into the body.
const OUT = { shoulderRX: -0.3, shoulderRZ: 0.9, elbowR: 0.2 }
const IN = { shoulderRX: 0.2, shoulderRZ: -0.3, elbowR: 1.6 }
const ACROSS = { shoulderRX: 0, shoulderRZ: -0.5, elbowR: 1.8 }
// A boxing guard, both fists by the face.
const GUARD = { shoulderLX: -0.6, elbowL: 1.9, shoulderLZ: -0.1, shoulderRX: -0.6, elbowR: 1.9, shoulderRZ: -0.1 }

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapTemplate(FEMALE, fixtureCharacter(0.93))
  registerMocapClip('pullIn', syntheticClip(MALE, [...sweep(OUT, IN, 16), ...sweep(IN, ACROSS, 16).slice(1), ...sweep(ACROSS, OUT, 16).slice(1)], { inPlace: false }))
  registerMocapClip('guard', syntheticClip(MALE, sweep(GUARD, { ...GUARD, torsoX: 0.05 }, 31), { loop: true, inPlace: false }))
  registerMocapClip('reachOut', syntheticClip(MALE, sweep(OUT, { ...OUT, shoulderRX: -0.6 }, 16), { inPlace: false }))
  registerMocapClip('walk', syntheticClip(MALE, sweep({ hipRX: -0.3, hipLX: 0.3, shoulderRX: 0.3 }, { hipRX: 0.3, hipLX: -0.3, shoulderRX: -0.3 }, 31), { loop: true }))
  // The crouch's loop: stooped, the right fist pulled in to the belly, the body bobbing a little.
  const STOOP = { shoulderRX: 0.4, shoulderRZ: -0.4, elbowR: 1.5 }
  registerMocapClip('crouchStill', syntheticClip(MALE, [...sweep({ ...STOOP, torsoX: 0.55 }, { ...STOOP, torsoX: 0.65 }, 16), ...sweep({ ...STOOP, torsoX: 0.65 }, { ...STOOP, torsoX: 0.55 }, 16).slice(1)], { loop: true }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

/** The weapon's grip rotation as it was before the hold rule (weaponRotation on the hand frame). */
function baseSamples(dims: PersonDims, hand: Hand, assetId: string, clip?: ClipState): { p: V3[]; r: number }[] {
  const spec = weaponSpec(assetId)!
  const f = handFrame(dims, undefined, hand, clip)
  const R = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder, torso: f.torso })
  const g = spec.grip
  return weaponSamples(assetId).map((s) => ({
    p: s.p.map((q) => {
      const d = { x: q.x - g.x, y: q.y - g.y, z: q.z - g.z }
      return { x: f.p.x + R[0] * d.x + R[1] * d.y + R[2] * d.z, y: f.p.y + R[3] * d.x + R[4] * d.y + R[5] * d.z, z: f.p.z + R[6] * d.x + R[7] * d.y + R[8] * d.z }
    }),
    r: s.r
  }))
}

/** How deep (m) a weapon's capsules sit in its holder: each bone's skin as its hull, but the holding forearm and hand (both for a two-hander; a shield's upper arm too). */
function ownDepth(dims: PersonDims, clip: ClipState | undefined, pieces: { p: V3[]; r: number }[], assetId: string, hand: Hand, joints?: Record<string, number>): number {
  return depthOn(dims, botPose(dims.mocap!, joints, clip), pieces, assetId, hand)
}

function depthOn(dims: PersonDims, pose: MocapPose, pieces: { p: V3[]; r: number }[], assetId: string, hand: Hand): number {
  const m = dims.mocap!
  const spec = weaponSpec(assetId)!
  const sides = spec.twoHanded ? ['Left', 'Right'] : [hand === 'L' ? 'Left' : 'Right']
  const skip = sides.flatMap((sd) => (spec.kind === 'shield' ? ['Arm', 'ForeArm', 'Hand'] : ['ForeArm', 'Hand']).map((x) => `${sd}${x}`))
  let d = -Infinity
  for (const b of MOCAP_BONES) {
    if (skip.includes(b)) continue
    const skin = boneSkin(m, pose, new Set([BONE_INDEX[b]]))!.p
    if (skin.length < 4) continue
    for (const w of pieces) d = Math.max(d, skinDepth(w.p, skin) + w.r)
  }
  return d
}

describe('a bot holds a weapon clear of its own body', { timeout: 60_000 }, () => {
  it('a club or a long gun the clip drives into the body turns in the grip until it is out, the grip still in the palm', () => {
    for (const id of [MALE, FEMALE]) {
      const dims = personDims(id)
      for (const assetId of ['prop.baseballBat', 'prop.rifle']) {
        const spec = weaponSpec(assetId)!
        let worstBefore = -Infinity
        for (let f = 0; f <= 46; f += 2) {
          const clip = { id: 'pullIn', t: f / 30 }
          const before = ownDepth(dims, clip, baseSamples(dims, 'R', assetId, clip), assetId, 'R')
          worstBefore = Math.max(worstBefore, before)
          const after = ownDepth(dims, clip, heldWeaponSamples(dims, undefined, 'R', spec, 1, clip), assetId, 'R')
          expect(after, `${id} ${assetId} f${f}: ${(before * 100).toFixed(1)} cm before`).toBeLessThan(0.01)
          expect(far(heldPointLocal(dims, undefined, 'R', spec, spec.grip, 1, clip), handFrame(dims, undefined, 'R', clip).p)).toBeLessThan(1e-9)
        }
        // The clip does put the bare hold well inside.
        expect(worstBefore, `${id} ${assetId}`).toBeGreaterThan(0.04)
      }
    }
  })

  it('a weapon already clear is not turned: every point exactly where the grip alone puts it', () => {
    const dims = personDims(MALE)
    for (const assetId of ['prop.sword', 'prop.baseballBat', 'prop.pistol']) {
      const spec = weaponSpec(assetId)!
      const clip = { id: 'reachOut', t: 0.2 }
      expect(ownDepth(dims, clip, baseSamples(dims, 'R', assetId, clip), assetId, 'R'), assetId).toBeLessThan(0)
      expect(holdTurn(dims, undefined, clip, spec, 'R', 1), assetId).toBeNull()
      const base = baseSamples(dims, 'R', assetId, clip)
      const now = heldWeaponSamples(dims, undefined, 'R', spec, 1, clip)
      base.forEach((s, i) => s.p.forEach((p, k) => expect(far(p, now[i]!.p[k]!)).toBe(0)))
    }
  })

  it('procedural people and studio mannequins hold every weapon exactly as before', () => {
    const joints = { ...IN, shoulderLX: -0.5, elbowL: 1.5 }
    for (const id of ['person.man', 'person.woman', 'person.mannequinMale']) {
      const dims = personDims(id)
      for (const hand of ['L', 'R'] as Hand[]) {
        for (const assetId of ['prop.sword', 'prop.shield', 'prop.rifle', 'prop.spear']) {
          const spec = weaponSpec(assetId)!
          expect(holdTurn(dims, joints, undefined, spec, hand, 1)).toBeNull()
          const f = handFrame(dims, joints, hand)
          const R = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder, torso: f.torso })
          const tip = heldPointLocal(dims, joints, hand, spec, spec.tip, 1)
          const d = { x: spec.tip.x - spec.grip.x, y: spec.tip.y - spec.grip.y, z: spec.tip.z - spec.grip.z }
          expect(tip).toEqual({ x: f.p.x + (R[0] * d.x + R[1] * d.y + R[2] * d.z), y: f.p.y + (R[3] * d.x + R[4] * d.y + R[5] * d.z), z: f.p.z + (R[6] * d.x + R[7] * d.y + R[8] * d.z) })
        }
      }
    }
  })

  it('the turn follows the clip frame to frame, never flipping round the body', () => {
    const dims = personDims(MALE)
    const spec = weaponSpec('prop.baseballBat')!
    let prev: [number, number, number, number] = [0, 0, 0, 1]
    for (let f = 0; f <= 46; f++) {
      const q = holdTurn(dims, undefined, { id: 'pullIn', t: f / 30 }, spec, 'R', 1) ?? [0, 0, 0, 1]
      const dot = Math.abs(q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3])
      expect((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI, `f${f}`).toBeLessThan(15)
      prev = q
    }
  })

  it('a joint overlay on the clip keeps the clip\'s turn while the weapon stays clear; an overlay or a crossfade that moves it in is measured on its own pose', () => {
    for (const id of [MALE, FEMALE]) {
      const dims = personDims(id)
      const spec = weaponSpec('prop.baseballBat')!
      const clip = { id: 'pullIn', t: 16 / 30 }
      const q = holdTurn(dims, undefined, clip, spec, 'R', 1)!
      expect(q).not.toBeNull()
      // The other arm moves: the turn holds.
      holdTurn(dims, { shoulderLX: -0.4 }, clip, spec, 'R', 1)!.forEach((x, i) => expect(x).toBeCloseTo(q[i]!, 9))
      // The holding arm pulled further in, and a crossfade into the clip: each turned back to 1.5 cm on its own pose (the bar is 3).
      const ov = { elbowR: 0.4, shoulderRZ: -0.15 }
      expect(ownDepth(dims, clip, heldWeaponSamples(dims, ov, 'R', spec, 1, clip), 'prop.baseballBat', 'R', ov), id).toBeLessThan(0.02)
      const fade = { id: 'pullIn', t: 16 / 30, w: 0.5, from: { id: 'reachOut', t: 0.2 } }
      expect(ownDepth(dims, fade, heldWeaponSamples(dims, undefined, 'R', spec, 1, fade), 'prop.baseballBat', 'R'), id).toBeLessThan(0.02)
    }
  })

  it('a shield in a guard faces out, off the head and chest', () => {
    for (const id of [MALE, FEMALE]) {
      const dims = personDims(id)
      const spec = weaponSpec('prop.shield')!
      for (const t of [0, 0.5]) {
        const clip = { id: 'guard', t }
        expect(ownDepth(dims, clip, heldWeaponSamples(dims, undefined, 'L', spec, 1, clip), 'prop.shield', 'L'), `${id} t=${t}`).toBeLessThan(0.01)
        // The face's normal points away from the spine.
        const face = heldPointLocal(dims, undefined, 'L', spec, spec.tip, 1, clip)
        const back = heldPointLocal(dims, undefined, 'L', spec, { ...spec.tip, z: spec.tip.z + 0.05 }, 1, clip)
        const n = { x: face.x - back.x, z: face.z - back.z }
        expect(n.x * face.x + n.z * face.z, `${id} t=${t}`).toBeGreaterThan(0)
      }
    }
  })

  it('the rendered weapon is where the engine holds it, turned', () => {
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      const dims = personDims(id)
      for (const [assetId, hand, clip] of [['prop.baseballBat', 'R', { id: 'pullIn', t: 16 / 30 }], ['prop.rifle', 'R', { id: 'pullIn', t: 30 / 30 }], ['prop.shield', 'L', { id: 'guard', t: 0.3 }]] as const) {
        const spec = weaponSpec(assetId)!
        expect(holdTurn(dims, undefined, clip, spec, hand, 1), `${id} ${assetId}`).not.toBeNull()
        b.animate!({ ...STAND, clip })
        b.group.updateMatrixWorld(true)
        const m = heldWeaponMatrix(b.group, dims, spec, hand, 1)!
        for (const p of [spec.grip, spec.tip]) {
          const rendered = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m)
          expect(far(rendered, heldPointLocal(dims, undefined, hand, spec, p, 1, clip)), `${id} ${assetId}`).toBeLessThan(0.001)
        }
      }
    }
  })

  it('a two-handed weapon on a walk keeps both arms steadied', () => {
    const b = buildAsset(MALE)
    const ov = { shoulderRX: 0, shoulderRZ: -0.2, elbowR: 0.65, shoulderLX: -0.3, shoulderLZ: 0.3, elbowL: 1.1 }
    const walk = { ...STAND, gait: 'walk' as const, speed: 1.4, distance: 0.7, time: 0.5, overrides: ov }
    const grip = (side: 'L' | 'R'): THREE.Vector3 => b.group.getObjectByName(`grip${side}`)!.getWorldPosition(new THREE.Vector3())
    b.animate!(walk)
    steadyArm(b.group, 'R', ov)
    b.group.updateMatrixWorld(true)
    const r = grip('R')
    steadyArm(b.group, 'L', ov)
    b.group.updateMatrixWorld(true)
    expect(grip('R').distanceTo(r)).toBeLessThan(1e-9)
  })
})

describe('a bot moves its holding arm off its body where no turn frees the weapon', { timeout: 60_000 }, () => {
  // Stooped forward with the right fist pulled in to the belly: the sword's handle is in the body at the fist.
  const IN_FIST = { torsoX: 0.6, shoulderRX: 0.4, shoulderRZ: -0.4, elbowR: 1.5 }
  const sword = weaponSpec('prop.sword')!
  const held = [{ spec: sword, hand: 'R' as Hand, scale: 1 }]
  const fist = (dims: PersonDims, j: Record<string, number>): number => holdDepth(dims.mocap!, mocapPose(dims.mocap!, jointLocals(j)), sword, 'R', 1, holdTurn(dims, j, undefined, sword, 'R', 1) ?? [0, 0, 0, 1], 0.12)

  it('on the keyframe rig the arm moves the fist out, growing from nothing as the fist goes in', () => {
    const dims = personDims(MALE)
    expect(fist(dims, IN_FIST)).toBeGreaterThan(0.05)
    const moved = holdJoints(dims, IN_FIST, held, {}, 0, true)!
    expect(fist(dims, moved)).toBeLessThan(0.006)
    // Only the holding arm moves.
    for (const k of Object.keys(moved)) if (!['shoulderRX', 'shoulderRZ', 'elbowR'].includes(k)) expect(moved[k]).toBe(IN_FIST[k as keyof typeof IN_FIST])
    // Clear of the body: no move. Pressing the fist further in, the lift follows step by step, never jumping.
    const at = (u: number): Record<string, number> => ({ ...IN_FIST, elbowR: 0.6 + 0.9 * u })
    expect(rigLift(dims, { ...IN_FIST, elbowR: 0.6, shoulderRZ: 0 }, sword, 'R', 1)).toBe(0)
    let prev: number | null = null
    for (let k = 10; k <= 30; k++) {
      // (The lift is one scalar along one unit way: its step is the joints' step.)
      const lift = rigLift(dims, at(k / 30), sword, 'R', 1)
      if (prev !== null) expect(Math.abs(lift - prev), `step ${k}`).toBeLessThan(0.06)
      expect(fist(dims, holdJoints(dims, at(k / 30), held, {}, 0, true)!), `step ${k}`).toBeLessThan(0.006)
      prev = lift
    }
  })

  it('on a keyframe motion the lift eases in before the fist reaches the body and out after it leaves, clear on every frame', () => {
    const dims = personDims(MALE)
    const CLEAR = { ...IN_FIST, elbowR: 0.6, shoulderRZ: 0 }
    // The fist snaps in between two frames at 1 s and back out at 2 s: the lift the pose needs jumps.
    const keys: [number, Record<string, number>][] = [[0, CLEAR], [1, CLEAR], [1 + 1 / 24, IN_FIST], [2, IN_FIST], [2 + 1 / 24, CLEAR], [3, CLEAR]]
    const marks = keys.map(([time, joints], k) => ({ id: `m${k}`, time, position: { x: 0, y: 0, z: 0 }, gait: 'stand', easeIn: 0, easeOut: 0, hold: 0, arriveHeading: 0, posedMove: true, joints }))
    const holder = { id: 'p', assetId: MALE, name: 'p', transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } } as unknown as Entity
    const weapon = { id: 'w', assetId: 'prop.sword', name: 'w', heldBy: { entityId: 'p', hand: 'R' }, transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } } as unknown as Entity
    const scene = (entities: Entity[]): Scene => ({ id: 's', name: 's', number: 1, fights: [], environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 }, entities, blocking: [{ id: 'take', name: 't', tracks: [{ entityId: 'p', marks }] }], shots: [] }) as unknown as Scene
    const shot = { id: 'shot', name: 's', duration: 3, fps: 24, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
    const bare = new ShotEvaluator(scene([holder]), shot)
    const armed = new ShotEvaluator(scene([holder, weapon]), shot)
    // The lift alone: the holding arm's joints less the hold without it, along the lift's way (shoulder X forward is −).
    const along = (a: Record<string, number>, b: Record<string, number>): number => -(a.shoulderRX! - b.shoulderRX!) * (2 / Math.sqrt(5)) + (a.shoulderRZ! - b.shoulderRZ!) / Math.sqrt(5)
    const raw: number[] = []
    const eased: number[] = []
    for (let f = 0; f <= 72; f++) {
      const own = bare.evaluate(f / 24).entities.find((e) => e.entityId === 'p')!.joints
      const base = holdJoints(dims, own, held, {}, 0, false)!
      raw.push(along(holdJoints(dims, own, held, {}, 0, true)!, base))
      const st = armed.evaluate(f / 24).entities.find((e) => e.entityId === 'p')!
      eased.push(along(st.joints!, base))
      // As far as the pose needs it, or more the same way: the fist stays out.
      if (raw[f] !== 0) expect(fist(dims, st.joints!), `f${f}`).toBeLessThan(0.006)
    }
    const step = (xs: number[]): number => Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i]!)))
    const top = Math.max(...raw.map(Math.abs))
    expect(step(raw)).toBeGreaterThan(0.6 * top)
    expect(step(eased)).toBeLessThan(0.3 * top)
    const first = (xs: number[]): number => xs.findIndex((x) => Math.abs(x) > 1e-6)
    const last = (xs: number[]): number => xs.length - 1 - [...xs].reverse().findIndex((x) => Math.abs(x) > 1e-6)
    expect((first(raw) - first(eased)) / 24).toBeGreaterThanOrEqual(0.15)
    expect((last(eased) - last(raw)) / 24).toBeGreaterThanOrEqual(0.15)
    // Pure state(t): a frame asked for alone, out of order, is the same.
    const again = new ShotEvaluator(scene([holder, weapon]), shot).evaluate(25 / 24).entities.find((e) => e.entityId === 'p')!.joints!
    expect(again).toEqual(armed.evaluate(25 / 24).entities.find((e) => e.entityId === 'p')!.joints)
  })

  it('procedural people and mannequins: the rig move never applies', () => {
    for (const id of ['person.man', 'person.mannequinMale']) {
      const dims = personDims(id)
      expect(holdJoints(dims, IN_FIST, held, {}, 0, true)).toEqual(holdJoints(dims, IN_FIST, held, {}, 0, false))
      expect(rigLift(dims, IN_FIST, sword, 'R', 1)).toBe(0)
    }
  })

  it("on a crouch, sit or lie loop the loop's own arms hold the weapon, moved off the body where its fist is in it, as on a clip", () => {
    for (const id of [MALE, FEMALE]) {
      expect(holdLoop(id, 'crouch', 0)).toBe('crouchStill')
      for (const g of ['stand', 'gesture', 'walk', 'jog', 'run'] as const) expect(holdLoop(id, g, 1.4)).toBeUndefined()
      const dims = personDims(id)
      const b = buildAsset(id)
      const entity = { id: 'p', assetId: id, transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } } as unknown as Entity
      const es = { entityId: 'p', position: { x: 0, y: 0, z: 0 } } as unknown as EntityState
      // Where the renderer draws the sword, how deep in the pose it shows.
      const shown = (weapons: { spec: typeof sword; hand: Hand; scale: number }[], t: number): { d: number; moved: boolean } => {
        const input: AnimInput = { ...STAND, gait: 'crouch', time: t }
        botInput(entity, es, input, { inputAt: () => null, held: new Set(['R']), weapons })
        b.animate!(input)
        b.group.updateMatrixWorld(true)
        const mat = heldWeaponMatrix(b.group, dims, sword, 'R', 1)!
        const pieces = weaponSamples('prop.sword').map((s) => ({ p: s.p.map((q) => new THREE.Vector3(q.x, q.y, q.z).applyMatrix4(mat)), r: s.r }))
        return { d: depthOn(dims, (b.group.userData.mocapHold as BotHold).pose, pieces, 'prop.sword', 'R'), moved: !!input.overrides }
      }
      let before = -Infinity
      let moved = 0
      for (let f = 0; f < 31; f += 3) {
        // Without the arm move (no weapons told), the fist in the belly; with it, out.
        before = Math.max(before, shown([], f / 30).d)
        const after = shown(held, f / 30)
        expect(after.d, `${id} f${f}`).toBeLessThan(0.03)
        if (after.moved) moved++
      }
      expect(before, id).toBeGreaterThan(0.03)
      expect(moved, id).toBeGreaterThan(0)
    }
  })

  it('on the move a bot carries a two-handed or long weapon on its shoulder, by its speed; nothing else changes', () => {
    expect(travelCarry('stand', 3)).toBe(0)
    expect(travelCarry('crouch', 1)).toBe(0)
    expect(travelCarry('walk', 0)).toBe(0)
    expect(travelCarry('jog', 3)).toBe(1)
    expect(travelCarry('walk', 0.5)).toBeCloseTo(0.5, 9)
    for (let v = 0; v < 0.85; v += 0.1) expect(travelCarry('run', v + 0.1)).toBeGreaterThan(travelCarry('run', v))
    const bot = personDims(MALE)
    const bat = [{ spec: weaponSpec('prop.baseballBat')!, hand: 'R' as Hand, scale: 1 }]
    const still = holdJoints(bot, undefined, bat, {}, 0)!
    const moving = holdJoints(bot, undefined, bat, {}, 1)!
    const carry = TRAVEL_CARRY['prop.baseballBat']!
    expect(moving.shoulderRX! - still.shoulderRX!).toBeCloseTo(carry.shoulderX, 9)
    expect(moving.shoulderRZ! - still.shoulderRZ!).toBeCloseTo(carry.shoulderZ, 9)
    expect(moving.elbowR! - still.elbowR!).toBeCloseTo(carry.elbow, 9)
    // A one-handed sword, and the procedural people, carry as before.
    expect(holdJoints(bot, undefined, held, {}, 1)).toEqual(holdJoints(bot, undefined, held, {}, 0))
    const man = personDims('person.man')
    expect(holdJoints(man, undefined, bat, {}, 1)).toEqual(holdJoints(man, undefined, bat, {}, 0))
  })
})
