// Fork addition (2026): mocap clips as plain data on the fixture skeleton (no Mixamo data); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bodyLowY } from '@engine/floor'
import {
  blendPoses,
  clearMocapClips,
  clipPose,
  clipSample,
  clipScale,
  CONTACT,
  mocapClip,
  mocapClipPose,
  poseLowY,
  registerMocapClip,
  sampleLocals
} from '@engine/mocap/clip'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import { gaitClipId } from '@engine/mocap/gait-clips'
import { BONE_INDEX } from '@engine/mocap/rig'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { qconj, qmul, qrot, type Quat } from '@engine/mocap/quat'
import { personDims, poseEffectors } from '@engine/skeleton'
import type { V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
/** The angle between two rotations (atan2: exact near 0). */
function angle(a: Quat, b: Quat): number {
  const d = qmul(qconj(a), b)
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]))
}

/** Raise the left arm forward over 31 frames (1 s), the hips drifting forward 0.6 m. */
const RAISE = sweep({ shoulderLX: 0, elbowL: 0 }, { shoulderLX: -1.5, elbowL: 0.6 }, 31)

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerMocapClip('raise', syntheticClip(MALE, RAISE))
  registerMocapClip('raiseTravel', syntheticClip(MALE, RAISE, { inPlace: false, hips: (f) => ({ x: 0.1 * Math.sin(f / 5), y: 0, z: (-0.6 * f) / 30 }) }))
  registerMocapClip('loop', syntheticClip(MALE, [...RAISE, ...RAISE.slice(0, -1).reverse()], { loop: true, inPlace: false, hips: (f) => ({ x: 0, y: 0, z: -0.02 * f }) }))
  registerMocapClip('crouch', syntheticClip(MALE, sweep({}, { hipLX: -1.2, hipRX: -1.2, kneeL: 2.2, kneeR: 2.2, torsoX: 0.5 }, 11), { grounded: true }))
  registerMocapClip('hop', syntheticClip(MALE, sweep({}, {}, 13), { hips: (f) => ({ x: 0, y: 0.3 * Math.sin((Math.PI * f) / 12), z: 0 }) }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('mocap clips: data', () => {
  it('stores frames, duration and the clip as rig rotations of the source A-rest', () => {
    const c = mocapClip('raise')!
    expect(c.frames).toBe(31)
    expect(c.duration).toBeCloseTo(1, 12)
    const m = personDims(MALE).mocap!
    for (const f of [0, 12, 30]) {
      const want = mocapPose(m, jointLocals(RAISE[f])).G
      const s = clipSample(c, f / 30)
      s.G.forEach((q, i) => expect(angle(q, want[i]!), `frame ${f} bone ${i}`).toBeLessThan(1e-9))
    }
  })

  it('samples between frames on the shortest arc, and holds the ends of a one-shot clip', () => {
    const c = mocapClip('raise')!
    const a = clipSample(c, 10 / 30)
    const b = clipSample(c, 11 / 30)
    const mid = clipSample(c, 10.5 / 30)
    const i = BONE_INDEX.LeftArm
    expect(angle(mid.G[i]!, a.G[i]!)).toBeCloseTo(angle(a.G[i]!, b.G[i]!) / 2, 9)
    expect(angle(mid.G[i]!, b.G[i]!)).toBeCloseTo(angle(a.G[i]!, b.G[i]!) / 2, 9)
    expect(clipSample(c, -2).G).toEqual(clipSample(c, 0).G)
    expect(clipSample(c, 7).G).toEqual(clipSample(c, 1).G)
  })

  it('loops a loop clip and carries its root travel on, cycle after cycle', () => {
    const c = mocapClip('loop')!
    const D = c.duration
    const x = 0.37
    const s0 = clipSample(c, x)
    const s2 = clipSample(c, 2 * D + x)
    s0.G.forEach((q, i) => expect(angle(q, s2.G[i]!)).toBeLessThan(1e-9))
    const per = clipSample(c, D).root.z - clipSample(c, 0).root.z
    expect(per).toBeLessThan(0)
    expect(s2.root.z - s0.root.z).toBeCloseTo(2 * per, 9)
    // In place there is no root; with root motion the pose's hips stay over the root.
    expect(clipSample(mocapClip('raise')!, 0.5).root).toEqual({ x: 0, z: 0 })
    expect(s0.hips.x).toBe(0)
    expect(s0.hips.z).toBe(0)
  })

  it('takes the straight-line travel out of a clip flagged in place whose hips travel anyway, keeping its sway', () => {
    const sway = (f: number): number => 0.03 * Math.sin((2 * Math.PI * f) / 30)
    const c = registerMocapClip('sprintLike', syntheticClip(MALE, RAISE, { inPlace: true, loop: true, hips: (f) => ({ x: sway(f), y: 0, z: -0.1 * f }) }))
    const still = registerMocapClip('swayLike', syntheticClip(MALE, RAISE, { inPlace: true, loop: true, hips: (f) => ({ x: sway(f), y: 0, z: 0 }) }))
    expect(c.inPlace).toBe(true)
    for (const f of [0, 7, 15, 30]) {
      expect(clipSample(c, f / 30).hips.z, `z @${f}`).toBeCloseTo(clipSample(still, f / 30).hips.z, 9)
      expect(clipSample(c, f / 30).hips.x, `x @${f}`).toBeCloseTo(clipSample(still, f / 30).hips.x, 9)
    }
    expect(clipSample(c, 0.5).root).toEqual({ x: 0, z: 0 })
  })

  it('mirrors left and right: a left-arm raise becomes a right-arm raise', () => {
    const m = personDims(MALE).mocap!
    const s = clipSample(mocapClip('raise')!, 1)
    const fx = poseEffectors(personDims(MALE), undefined, { id: 'raise', t: 1 })
    const mx = poseEffectors(personDims(MALE), undefined, { id: 'raise', t: 1, mirror: true })
    expect(fx.handL.z).toBeLessThan(-0.3)
    expect(mx.handR.x).toBeCloseTo(-fx.handL.x, 2)
    expect(mx.handR.y).toBeCloseTo(fx.handL.y, 2)
    expect(mx.handR.z).toBeCloseTo(fx.handL.z, 2)
    const travel = clipSample(mocapClip('raiseTravel')!, 0.3, true).root
    expect(travel.x).toBeCloseTo(-clipSample(mocapClip('raiseTravel')!, 0.3).root.x, 12)
    expect(clipPose(m, s).P.length).toBe(22)
  })

  it('blends two poses on the shortest arc, whatever the quaternion sign', () => {
    const m = personDims(MALE).mocap!
    const a = clipPose(m, clipSample(mocapClip('raise')!, 0))
    const b = clipPose(m, clipSample(mocapClip('raise')!, 1))
    const flipped = { P: b.P, G: b.G.map((q): Quat => [-q[0], -q[1], -q[2], -q[3]]) }
    const i = BONE_INDEX.LeftArm
    const half = blendPoses(m, a, b, 0.5)
    const halfFlipped = blendPoses(m, a, flipped, 0.5)
    expect(angle(half.G[i]!, halfFlipped.G[i]!)).toBeLessThan(1e-9)
    expect(angle(half.G[i]!, a.G[i]!)).toBeCloseTo(angle(a.G[i]!, b.G[i]!) / 2, 9)
    expect(blendPoses(m, a, b, 0)).toBe(a)
    expect(blendPoses(m, a, b, 1)).toBe(b)
  })
})

describe('mocap clips: posing a bot', () => {
  it('a joint overlay turns the clip bone in its parent frame; zero joints leave the clip as it is', () => {
    const m = personDims(MALE).mocap!
    const s = clipSample(mocapClip('raise')!, 0.5)
    const plain = clipPose(m, s)
    expect(clipPose(m, s, { elbowL: 0 })).toEqual(plain)
    const bent = clipPose(m, s, { elbowL: 0.4 })
    const fa = BONE_INDEX.LeftForeArm
    const ua = BONE_INDEX.LeftArm
    // The forearm turns 0.4 rad more about the upper arm's frame x; the upper arm doesn't move.
    expect(angle(bent.G[ua]!, plain.G[ua]!)).toBeLessThan(1e-12)
    expect(angle(bent.G[fa]!, plain.G[fa]!)).toBeCloseTo(0.4, 9)
    const axis = qrot(plain.G[ua]!, { x: 1, y: 0, z: 0 })
    const d = (p: { P: V3[] }): V3 => ({ x: p.P[BONE_INDEX.LeftHand]!.x - p.P[fa]!.x, y: p.P[BONE_INDEX.LeftHand]!.y - p.P[fa]!.y, z: p.P[BONE_INDEX.LeftHand]!.z - p.P[fa]!.z })
    const a = d(plain)
    const b = d(bent)
    expect(a.x * axis.x + a.y * axis.y + a.z * axis.z).toBeCloseTo(b.x * axis.x + b.y * axis.y + b.z * axis.z, 9)
    // The torso overlay spreads over the spine: the chest turns the full angle.
    const twisted = clipPose(m, s, { torsoY: 0.6 })
    expect(angle(twisted.G[BONE_INDEX.Spine2]!, plain.G[BONE_INDEX.Spine2]!)).toBeCloseTo(0.6, 6)
    expect(angle(twisted.G[BONE_INDEX.Spine]!, plain.G[BONE_INDEX.Spine]!)).toBeCloseTo(0.2, 6)
  })

  it('plays a Y Bot clip on another bot through the bind correction, the hips scaled by hip height', () => {
    const male = personDims(MALE).mocap!
    const female = personDims(FEMALE).mocap!
    const s = clipSample(mocapClip('crouch')!, 1 / 3)
    const a = clipPose(male, s)
    const b = clipPose(female, s)
    a.G.forEach((q, i) => expect(angle(q, b.G[i]!)).toBeLessThan(1e-12))
    expect(b.P[0]!.y / a.P[0]!.y).toBeCloseTo(clipScale(female, s.hipH) / clipScale(male, s.hipH), 12)
    expect(clipScale(male, s.hipH)).toBeCloseTo(1, 12)
    expect(clipScale(female, s.hipH)).toBeCloseTo(female.rig.rest[0]!.y / male.rig.rest[0]!.y, 12)
    // The height slider scales it too.
    const tall = personDims(FEMALE, { height: 1.1 }).mocap!
    expect(clipScale(tall, s.hipH)).toBeCloseTo(1.1 * clipScale(female, s.hipH), 12)
  })

  it('grounds a clip pose at its clearance: on the floor when grounded, up in the air at the top of a hop', () => {
    for (const id of [MALE, FEMALE]) {
      const m = personDims(id).mocap!
      for (const [clip, t] of [['crouch', 0], ['crouch', 1 / 3], ['raise', 0.5]] as const) {
        const pose = mocapClipPose(m, { id: clip, t })!
        expect(poseLowY(m, pose), `${id} ${clip} @${t}`).toBeCloseTo(0, 9)
        expect(bodyLowY({ assetId: id }, undefined, { id: clip, t })).toBeCloseTo(0, 9)
      }
      const hop = mocapClip('hop')!
      expect(Math.min(...hop.clear)).toBe(0)
      const top = mocapClipPose(m, { id: 'hop', t: 0.2 })!
      expect(poseLowY(m, top)).toBeCloseTo((0.3 - CONTACT) * clipScale(m, hop.hipH), 3)
    }
    // The crouch folds the legs: the hips come down with it.
    const m = personDims(MALE).mocap!
    expect(mocapClipPose(m, { id: 'crouch', t: 1 / 3 })!.P[0]!.y).toBeLessThan(mocapClipPose(m, { id: 'crouch', t: 0 })!.P[0]!.y - 0.25)
  })

  it('crossfades from the joints pose, or from another clip, by w', () => {
    const d = personDims(MALE)
    const m = d.mocap!
    const rig = mocapClipPose(m, { id: 'raise', t: 1, w: 0 }, { elbowR: 1 })!
    const want = mocapPose(m, jointLocals({ elbowR: 1 }))
    rig.G.forEach((q, i) => expect(angle(q, want.G[i]!)).toBeLessThan(1e-12))
    const half = mocapClipPose(m, { id: 'raise', t: 1, w: 0.5, from: { id: 'crouch', t: 1 / 3 } })!
    const a = mocapClipPose(m, { id: 'crouch', t: 1 / 3 })!
    const b = mocapClipPose(m, { id: 'raise', t: 1 })!
    const i = BONE_INDEX.LeftUpLeg
    expect(angle(half.G[i]!, a.G[i]!)).toBeCloseTo(angle(a.G[i]!, b.G[i]!) / 2, 9)
    expect(poseLowY(m, half)).toBeCloseTo(0, 9)
    // Unknown clips fall back to the joints pose.
    expect(mocapClipPose(m, { id: 'nope', t: 0 })).toBeNull()
    expect(poseEffectors(d, { elbowR: 1 }, { id: 'nope', t: 0 })).toEqual(poseEffectors(d, { elbowR: 1 }))
  })

  it('leaves the procedural bodies alone', () => {
    for (const id of ['person.man', 'person.mannequinFemale']) {
      const d = personDims(id)
      expect(poseEffectors(d, { shoulderLX: -1 }, { id: 'raise', t: 1 })).toEqual(poseEffectors(d, { shoulderLX: -1 }))
      expect(bodyLowY({ assetId: id }, { kneeL: 1 }, { id: 'raise', t: 1 })).toBe(bodyLowY({ assetId: id }, { kneeL: 1 }))
    }
  })

  it('refuses a clip whose source bot is not loaded', () => {
    expect(() => registerMocapClip('x', { ...syntheticClip(MALE, RAISE), source: 'person.man' })).toThrow(/isn't loaded/)
  })
})

describe('mocap clips: the sampled distance', () => {
  it('a root-motion clip travels by its hips track', () => {
    const c = mocapClip('raiseTravel')!
    const r0 = clipSample(c, 0).root
    const r1 = clipSample(c, 1).root
    const m = personDims(MALE).mocap!
    expect(r1.z - r0.z).toBeCloseTo(-0.6, 9)
    expect(m.rig.scale).toBeGreaterThan(0)
    expect(dist({ x: r0.x, y: 0, z: r0.z }, { x: 0, y: 0, z: 0 })).toBeLessThan(1e-12)
  })
})

describe('mocap clips: a crouch at rest', () => {
  // The crouch idle holds its right hand up the whole loop; the crouched walk swings its arms about a hang.
  const CROUCH = { hipLX: -1.2, hipRX: -1.2, kneeL: 2.2, kneeR: 2.2 }
  const wave = (f: number): number => Math.sin((2 * Math.PI * f) / 20)
  const IDLE = Array.from({ length: 21 }, (_, f) => ({ ...CROUCH, torsoX: 0.5 + 0.05 * wave(f), shoulderRX: -2.6, elbowR: 0.4 }))
  const walk = (lean: number): Record<string, number>[] =>
    Array.from({ length: 21 }, (_, f) => ({ ...CROUCH, torsoX: 0.3, shoulderLX: lean + 0.4 * wave(f), shoulderRX: lean - 0.4 * wave(f), elbowL: 0.5, elbowR: 0.5 }))
  const local = (G: Quat[], i: number): Quat => qmul(qconj(G[i === BONE_INDEX.LeftShoulder || i === BONE_INDEX.RightShoulder ? BONE_INDEX.Spine2 : i - 1]!), G[i]!)
  const ARMS = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'] as const
  const BODY = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftUpLeg', 'LeftLeg', 'RightFoot'] as const

  it("loops the crouch idle with the crouched walk's arms at rest: the body breathes as before, the hands stay down", () => {
    const m = personDims(MALE).mocap!
    registerMocapClip('crouchWalk', syntheticClip(MALE, walk(-0.3), { loop: true, grounded: true, curl: { RightHandIndex1: 0.2 } }))
    expect(mocapClip('crouchStill')).toBeUndefined()
    registerMocapClip('crouchIdle', syntheticClip(MALE, IDLE, { loop: true, grounded: true, inPlace: false, curl: { RightHandIndex1: -0.5 } }))
    const idle = mocapClip('crouchIdle')!
    const still = mocapClip('crouchStill')!
    expect([still.frames, still.duration, still.loop, still.inPlace]).toEqual([idle.frames, idle.duration, idle.loop, idle.inPlace])
    // The walk's arms at their mean: the rig pose of the swing's middle.
    const rest = mocapPose(m, jointLocals({ ...CROUCH, shoulderLX: -0.3, shoulderRX: -0.3, elbowL: 0.5, elbowR: 0.5 })).G
    for (let f = 0; f < idle.frames; f++) {
      const a = clipSample(idle, f / 30)
      const b = clipSample(still, f / 30)
      for (const bone of BODY) expect(angle(a.G[BONE_INDEX[bone]]!, b.G[BONE_INDEX[bone]]!), `${bone} @${f}`).toBeLessThan(1e-12)
      for (const bone of ARMS) expect(angle(local(b.G, BONE_INDEX[bone]), local(rest, BONE_INDEX[bone])), `${bone} @${f}`).toBeLessThan(1e-9)
      expect(b.X.get('RightHandIndex1'), `finger @${f}`).toBeDefined()
      const pose = mocapClipPose(m, { id: 'crouchStill', t: f / 30 })!
      expect(poseLowY(m, pose)).toBeCloseTo(0, 9)
      expect(pose.P[BONE_INDEX.RightHand]!.y).toBeLessThan(pose.P[BONE_INDEX.Spine2]!.y)
      const raised = mocapClipPose(m, { id: 'crouchIdle', t: f / 30 })!
      expect(raised.P[BONE_INDEX.RightHand]!.y).toBeGreaterThan(raised.P[BONE_INDEX.Head]!.y)
    }
    // The finger takes the walk's curl under the hand.
    const fingers = sampleLocals(m, clipSample(still, 0.2))
    const walkFingers = sampleLocals(m, clipSample(mocapClip('crouchWalk')!, 0))
    expect(angle(fingers.get('RightHandIndex1')!, walkFingers.get('RightHandIndex1')!)).toBeLessThan(1e-9)
    // A new walk rebuilds it.
    registerMocapClip('crouchWalk', syntheticClip(MALE, walk(-0.6), { loop: true, grounded: true }))
    const lower = mocapPose(m, jointLocals({ ...CROUCH, shoulderLX: -0.6, elbowL: 0.5 })).G
    expect(angle(local(clipSample(mocapClip('crouchStill')!, 0).G, BONE_INDEX.LeftArm), local(lower, BONE_INDEX.LeftArm))).toBeLessThan(1e-9)
    expect(gaitClipId(MALE, 'crouch', 0)).toBe('crouchStill')
  })
})
