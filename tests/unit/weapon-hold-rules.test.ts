// Fork addition (2026, mocap-followup): held-weapons' four newest hold rules on synthetic clips (fixture bot): the lift cut, the on-pose refine keeping its clearest turn, the elbow way, the shield-only hand pad; see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { botPose, clearMocapClips, clipPose, clipSample, mocapClip, registerMocapClip } from '@engine/mocap/clip'
import { clearMocapBodies } from '@engine/mocap/registry'
import { BONE_INDEX, MOCAP_BONES } from '@engine/mocap/rig'
import { boneSkin, skinDepth } from '@engine/mocap/surface'
import type { MocapPose } from '@engine/mocap/fk'
import { personDims, type PersonDims } from '@engine/skeleton'
import { handFrame, weaponRotation, weaponSpec, type Hand } from '@engine/weapons'
import { weaponSamples } from '@engine/weapon-shape'
import { holdArm, holdDepth, holdTurn, liftJoints, poseHoldTurn, turnedRotation } from '@engine/weapon-hold'
import type { ClipState, V3 } from '@engine/types'
import { fixtureCharacter } from './mocap-three-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
type Quat = [number, number, number, number]

/** A pose held for `n` frames: a clip whose every frame is that pose. */
const still = (id: string, joints: Record<string, number>, n = 8): void => {
  registerMocapClip(id, syntheticClip(MALE, sweep(joints, joints, n), { inPlace: false }))
}

// The right fist under the chin: no shoulder lift takes the weapon out of the chest, opening the elbow does.
const CHIN = { shoulderRX: 0.18, shoulderRZ: -0.31, elbowR: 2.88 }
// Stooped, the right fist pulled in to the belly: a forward lift takes it out (opening the elbow would too).
const IN_FIST = { torsoX: 0.6, shoulderRX: 0.44, shoulderRZ: -0.4, elbowR: 1.53 }
// The left fist in the body where the elbow way would clear more frames than any other: a shield still lifts at the shoulder.
const SHIELD_IN = [
  { torsoX: 0.6, shoulderLX: 0.63, shoulderLZ: 0.45, elbowL: 2.81 },
  { torsoX: 0, shoulderLX: 0.75, shoulderLZ: -0.86, elbowL: 1.44 }
]
// Upright, the right hand behind the back: a forward lift swings the fist into the back.
const BEHIND = { torsoX: 0.05, shoulderRX: 0.72, shoulderRZ: -0.42, elbowR: 0.95 }
// Both arms out, both hands near each other in front.
const HANDS = (sx: number, sz: number, el: number): Record<string, number> => ({ shoulderRX: sx, shoulderLX: sx, shoulderRZ: sz, shoulderLZ: sz, elbowR: el, elbowL: el })
// Arms reaching out, both hands open: the clip under the overlays the refine measures on.
const REACH = { shoulderRX: -0.3, shoulderRZ: 0.9, elbowR: 0.2, shoulderLX: -0.3, shoulderLZ: 0.9, elbowL: 0.2 }

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  still('chin', CHIN)
  still('inFist', IN_FIST)
  SHIELD_IN.forEach((p, i) => still(`shieldIn${i}`, p, 4))
  // The fist in the belly for 6 frames (a forward lift), then snapped behind the back.
  registerMocapClip('snap', syntheticClip(MALE, [...sweep(IN_FIST, IN_FIST, 6), ...sweep(BEHIND, BEHIND, 10)], { inPlace: false }))
  still('shieldByHand0', HANDS(-0.9, -0.5, 0.4), 6)
  still('shieldByHand1', HANDS(-1.2, -0.5, 0.4), 6)
  still('pistolByHand0', HANDS(-1.2, -0.7, 1.2), 6)
  still('pistolByHand1', HANDS(-0.6, -0.7, 1.2), 6)
  registerMocapClip('reach', syntheticClip(MALE, sweep(REACH, { ...REACH, shoulderRX: -0.6, shoulderLX: -0.6 }, 16), { inPlace: false }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

/** The weapon's capsules as the bot holds it: the grip's rotation turned by `turn` (default: the hold rule's on that pose). */
function placed(dims: PersonDims, joints: Record<string, number> | undefined, clip: ClipState | undefined, assetId: string, hand: Hand, turn?: Quat | null): { p: V3[]; r: number }[] {
  const spec = weaponSpec(assetId)!
  const f = handFrame(dims, joints, hand, clip)
  const R0 = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder, torso: f.torso })
  const R = turnedRotation(R0, f.r, turn === undefined ? holdTurn(dims, joints, clip, spec, hand, 1) : turn)
  const g = spec.grip
  return weaponSamples(assetId).map((s) => ({
    p: s.p.map((q) => {
      const d = { x: q.x - g.x, y: q.y - g.y, z: q.z - g.z }
      return { x: f.p.x + R[0] * d.x + R[1] * d.y + R[2] * d.z, y: f.p.y + R[3] * d.x + R[4] * d.y + R[5] * d.z, z: f.p.z + R[6] * d.x + R[7] * d.y + R[8] * d.z }
    }),
    r: s.r
  }))
}

/** How deep (m) the capsules sit in the holder's skin, bone by bone (`only` those bones), leaving out the holding forearm and hand (a shield's upper arm too). */
function depthOn(dims: PersonDims, pose: MocapPose, pieces: { p: V3[]; r: number }[], assetId: string, hand: Hand, only?: string[]): number {
  const m = dims.mocap!
  const spec = weaponSpec(assetId)!
  const sides = spec.twoHanded ? ['Left', 'Right'] : [hand === 'L' ? 'Left' : 'Right']
  const skip = sides.flatMap((sd) => (spec.kind === 'shield' ? ['Arm', 'ForeArm', 'Hand'] : ['ForeArm', 'Hand']).map((x) => `${sd}${x}`))
  let d = -Infinity
  for (const b of MOCAP_BONES) {
    if (skip.includes(b) || (only && !only.includes(b))) continue
    const skin = boneSkin(m, pose, new Set([BONE_INDEX[b]]))!.p
    if (skin.length < 4) continue
    for (const w of pieces) d = Math.max(d, skinDepth(w.p, skin) + w.r)
  }
  return d
}

/** On a clip frame as applyHolds places it: the holding arm moved by holdArm, the weapon turned on that pose. */
function onClip(dims: PersonDims, clip: ClipState, assetId: string, hand: Hand, only?: string[]): { d: number; arm: Record<string, number> | null } {
  const arm = holdArm(dims, clip, weaponSpec(assetId)!, hand, 1)
  const pose = botPose(dims.mocap!, arm ?? undefined, clip)
  return { d: depthOn(dims, pose, placed(dims, arm ?? undefined, clip, assetId, hand), assetId, hand, only), arm }
}

/** The bare clip pose's own turn, no arm move: how deep the weapon sits when only the grip turns. */
function turnOnly(dims: PersonDims, clip: ClipState, assetId: string, hand: Hand): number {
  const m = dims.mocap!
  const sample = clipSample(mocapClip(clip.id)!, clip.t, !!clip.mirror)
  const pose = clipPose(m, sample)
  return depthOn(dims, pose, placed(dims, undefined, clip, assetId, hand, poseHoldTurn(m, pose, weaponSpec(assetId)!, hand, 1) as Quat), assetId, hand)
}

describe('the holding arm opens its elbow only when that clears more frames, and never for a shield', { timeout: 60_000 }, () => {
  it('a fist under the chin: no shoulder lift frees the weapon, so the elbow opens (never past 0.1 rad short of straight)', () => {
    const dims = personDims(MALE)
    for (const assetId of ['prop.sword', 'prop.pistol']) {
      const clip = { id: 'chin', t: 4 / 30 }
      expect(turnOnly(dims, clip, assetId, 'R'), assetId).toBeGreaterThan(0.03)
      const { d, arm } = onClip(dims, clip, assetId, 'R')
      expect(arm, assetId).not.toBeNull()
      expect(arm!.elbowR, assetId).toBeLessThan(-0.2)
      expect(Math.abs(arm!.shoulderRX!) + Math.abs(arm!.shoulderRZ!), assetId).toBeLessThan(1e-12)
      expect(CHIN.elbowR + arm!.elbowR!, assetId).toBeGreaterThanOrEqual(0.1 - 1e-9)
      expect(d, assetId).toBeLessThan(0.01)
    }
  })

  it('a fist in the belly a forward lift frees: the arm lifts forward and the elbow stays', () => {
    const dims = personDims(MALE)
    const clip = { id: 'inFist', t: 4 / 30 }
    expect(turnOnly(dims, clip, 'prop.sword', 'R')).toBeGreaterThan(0.03)
    const { d, arm } = onClip(dims, clip, 'prop.sword', 'R')
    expect(arm).not.toBeNull()
    expect(arm!.elbowR).toBe(0)
    // Forward and a little out: shoulder X −2, Z +1 per unit of lift.
    expect(arm!.shoulderRX).toBeLessThan(-0.1)
    expect(arm!.shoulderRZ! / arm!.shoulderRX!).toBeCloseTo(-0.5, 9)
    expect(d).toBeLessThan(0.01)
  })

  it('a shield lifts at the shoulder even where opening the elbow would clear more', () => {
    const dims = personDims(MALE)
    SHIELD_IN.forEach((_, i) => {
      const clip = { id: `shieldIn${i}`, t: 2 / 30 }
      const { arm } = onClip(dims, clip, 'prop.shield', 'L')
      expect(arm, `pose ${i}`).not.toBeNull()
      expect(arm!.elbowL, `pose ${i}`).toBe(0)
      expect(Math.abs(arm!.shoulderLX!) + Math.abs(arm!.shoulderLZ!), `pose ${i}`).toBeGreaterThan(0.1)
    })
  })
})

describe('a lift eased in from a neighbouring run is cut back where it carries the fist into the body', { timeout: 60_000 }, () => {
  it('the frames after a forward-lift run, the hand behind the back: lifted less than the easing gives, every frame clear', () => {
    const dims = personDims(MALE)
    const m = dims.mocap!
    const sword = weaponSpec('prop.sword')!
    const clip = (f: number): ClipState => ({ id: 'snap', t: f / 30 })
    // The lift along its way (forward is shoulder X −2/√5 per unit).
    const lift = (f: number): number => -(holdArm(dims, clip(f), sword, 'R', 1)?.shoulderRX ?? 0) * (Math.sqrt(5) / 2)
    const top = lift(5)
    expect(top).toBeGreaterThan(0.3)
    // The run's lift eased over the next frames (a cosine over 5 frames either side) would put the fist in the back.
    const eased = (k: number): number => top * (0.5 + 0.5 * Math.cos((Math.PI * k) / 6))
    for (const k of [1, 2]) {
      const joints = liftJoints('R', eased(k))
      const pose = botPose(m, joints, clip(5 + k))
      const turn = poseHoldTurn(m, pose, sword, 'R', 1) as Quat
      expect(depthOn(dims, pose, placed(dims, joints, clip(5 + k), 'prop.sword', 'R', turn), 'prop.sword', 'R'), `f${5 + k} eased`).toBeGreaterThan(0.03)
      expect(lift(5 + k), `f${5 + k}`).toBeLessThan(0.5 * eased(k))
    }
    for (let f = 0; f < 16; f++) expect(onClip(dims, clip(f), 'prop.sword', 'R').d, `f${f}`).toBeLessThan(0.015)
  })
})

describe('the on-pose refine keeps the clearest turn it passes, never deeper than the clip\'s own', { timeout: 60_000 }, () => {
  // Overlays on the reach clip that pull the holding fist into the body: no turn clears them.
  const CASES: [string, Hand, Record<string, number>, number][] = [
    ['prop.spear', 'R', { torsoX: 0.12, shoulderRX: 0.56, shoulderRZ: -1.54, elbowR: 0.51 }, 4],
    ['prop.baseballBat', 'R', { torsoX: 0.68, shoulderRX: 0.33, shoulderRZ: -1.36, elbowR: 1.08 }, 0],
    ['prop.shield', 'L', { torsoX: 0.52, shoulderLX: 0.52, shoulderLZ: -1.33, elbowL: 1.02 }, 3]
  ]

  it('an overlay the solve can\'t clear: the turn it keeps sits no deeper than the curve\'s; where it passed a clearer one, that one', () => {
    const dims = personDims(MALE)
    const m = dims.mocap!
    for (const [assetId, hand, ov, f] of CASES) {
      const spec = weaponSpec(assetId)!
      const clip = { id: 'reach', t: f / 30 }
      const pose = botPose(m, ov, clip)
      const curve = holdTurn(dims, undefined, clip, spec, hand, 1) ?? [0, 0, 0, 1]
      const before = holdDepth(m, pose, spec, hand, 1, curve)
      // Past the refine's 1.5 cm: it does solve here.
      expect(before, assetId).toBeGreaterThan(0.03)
      const after = holdDepth(m, pose, spec, hand, 1, holdTurn(dims, ov, clip, spec, hand, 1) ?? [0, 0, 0, 1])
      expect(after, assetId).toBeLessThanOrEqual(before + 1e-9)
      if (assetId === 'prop.shield') expect(after, assetId).toBeLessThan(before - 0.01)
    }
  })
})

describe('a shield keeps a hand\'s width off the other hand; nothing else does', { timeout: 60_000 }, () => {
  it('a shield beside the other hand: at least 2 cm off its hand and forearm', () => {
    const dims = personDims(MALE)
    for (const id of ['shieldByHand0', 'shieldByHand1']) {
      const clip = { id, t: 3 / 30 }
      expect(onClip(dims, clip, 'prop.shield', 'L', ['RightHand', 'RightForeArm']).d, id).toBeLessThan(-0.02)
      expect(onClip(dims, clip, 'prop.shield', 'L').d, id).toBeLessThan(0)
    }
  })

  it('a pistol beside the other hand (a two-handed aim) stays where the grip puts it, clear of that hand', () => {
    const dims = personDims(MALE)
    const pistol = weaponSpec('prop.pistol')!
    for (const id of ['pistolByHand0', 'pistolByHand1']) {
      const clip = { id, t: 3 / 30 }
      expect(holdTurn(dims, undefined, clip, pistol, 'R', 1), id).toBeNull()
      expect(holdArm(dims, clip, pistol, 'R', 1), id).toBeNull()
      expect(onClip(dims, clip, 'prop.pistol', 'R', ['LeftHand', 'LeftForeArm']).d, id).toBeLessThan(0.01)
    }
  })
})
