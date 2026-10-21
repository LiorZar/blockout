// Fork addition (2026): the Fight Director on mocap bots — bone contact points, the clip move table, impacts from peak extension, the clip solve (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearMocapClips, mocapClipPose, registerMocapClip } from '@engine/mocap/clip'
import { qeuler, qrot } from '@engine/mocap/quat'
import { BONE_INDEX } from '@engine/mocap/rig'
import { meshDepth, skinMesh } from '@engine/mocap/surface'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { framePoint, personDims, poseEffectors, poseFrames } from '@engine/skeleton'
import { handFrame, heldPointLocal, weaponContact, weaponSpec, type HeldWeapon } from '@engine/weapons'
import { backTravel, clipImpactTime, defenseClip, defenseReadyTime, fallLandTime, moveClips, reactionClip, reactionOnset } from '@engine/fight/clip-moves'
import type { V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'
import { bent } from './mocap-fight-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  const guard = { shoulderLX: -0.6, elbowL: 1.4, shoulderRX: -0.6, elbowR: 1.4 }
  let wrist = syntheticClip(MALE, sweep(guard, { ...guard, shoulderLX: -1.4, elbowL: 0.1 }, 13), { inPlace: false })
  wrist = bent(wrist, BONE_INDEX.LeftHand, qeuler(0.7, 0, 0.3))
  wrist = bent(wrist, BONE_INDEX.LeftFoot, qeuler(-0.8, 0, 0))
  registerMocapClip('bentLimbs', wrist)
  // Strikes: the left fist out to its furthest at frame 12 and back; the cross holds its reach frames 9–13.
  const jabOut = { ...guard, shoulderLX: -1.5, elbowL: 0.05 }
  registerMocapClip('jabHead', syntheticClip(MALE, [...sweep(guard, jabOut, 13), ...sweep(jabOut, guard, 13).slice(1)], { inPlace: false }))
  const crossOut = { ...guard, shoulderRX: -1.5, elbowR: 0.05, torsoY: 0.3 }
  registerMocapClip('cross', syntheticClip(MALE, [...sweep(guard, crossOut, 10), ...Array.from({ length: 4 }, () => crossOut), ...sweep(crossOut, guard, 10)], { inPlace: false }))
  // A swing up past level: the fist peaks forward at level (frame 10), a blade held in it later.
  registerMocapClip('greatSword', syntheticClip(MALE, sweep({ shoulderRX: 0, elbowR: 0.6 }, { shoulderRX: -2.6, elbowR: 0.6 }, 21), { inPlace: false }))
  // A block: both hands up to their furthest at frame 8, held, then down.
  const up = { ...guard, shoulderLX: -1.3, shoulderRX: -1.3, elbowL: 2, elbowR: 2 }
  registerMocapClip('blockHead', syntheticClip(MALE, [...sweep(guard, up, 9), ...Array.from({ length: 6 }, () => up), ...sweep(up, guard, 9)], { inPlace: false }))
  // A KO stands still for ten frames, then goes; the fall drops the hips 0.8 m by frame 16 and travels back.
  registerMocapClip('koBack', syntheticClip(MALE, [...Array.from({ length: 10 }, () => guard), ...sweep(guard, { ...guard, torsoX: -0.9 }, 20)], { inPlace: false }))
  registerMocapClip('knockedDown', syntheticClip(MALE, sweep(guard, { ...guard, torsoX: -0.5 }, 31), { inPlace: false, hips: (f) => ({ x: 0, y: -0.05 * Math.min(f, 16), z: 0.03 * f }) }))
  for (const id of ['hitHeadLeft', 'hitHeadRight', 'hitStomach', 'hitSide', 'shoveReact', 'hitUppercut', 'dodge', 'blockBody', 'jabBody', 'hookHead', 'hookBody', 'uppercut', 'roundhouse', 'lowKick'])
    registerMocapClip(id, syntheticClip(MALE, sweep(guard, { ...guard, headX: -0.4 }, 16), { inPlace: false }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('bot contact points on their own bones', () => {
  it('on a clip the hand is the palm on the hand bone and the toe the ToeBase joint, the wrist and ankle bent', () => {
    for (const id of [MALE, FEMALE]) {
      const dims = personDims(id)
      const m = dims.mocap!
      const mid = m.rig.extra.find((x) => x.name === 'LeftHandMiddle1')!
      for (const t of [0, 0.2, 0.4]) {
        const st = { id: 'bentLimbs', t }
        const pose = mocapClipPose(m, st)!
        const hand = pose.P[BONE_INDEX.LeftHand]!
        const knuckle = qrot(pose.G[BONE_INDEX.LeftHand]!, { x: mid.offset.x * m.k, y: mid.offset.y * m.k, z: mid.offset.z * m.k })
        const palm = { x: hand.x + knuckle.x / 2, y: hand.y + knuckle.y / 2, z: hand.z + knuckle.z / 2 }
        const e = poseEffectors(dims, undefined, st)
        expect(dist(e.handL, palm)).toBeLessThan(1e-9)
        expect(dist(e.footL, pose.P[BONE_INDEX.LeftToeBase]!)).toBeLessThan(1e-9)
        // The bend matters: the forearm-rigid palm and shin-rigid toe are well off.
        const fr = poseFrames(dims, undefined, st)
        expect(dist(framePoint(fr.elbowL, { x: 0, y: -dims.lowerArmLen, z: 0 }), palm)).toBeGreaterThan(0.02)
        // The held weapon rides the hand bone: its frame is at the palm, turned as the hand.
        const hf = handFrame(dims, undefined, 'L', st)
        expect(dist(hf.p, palm)).toBeLessThan(1e-9)
        expect(hf.r).toEqual(fr.wristL!.r)
      }
    }
  })

  it('on keyframe poses the contact points and hand frame are unchanged (the hand and foot rigid with the forearm and shin)', () => {
    const poses: Record<string, number>[] = [{}, { shoulderLX: -1.2, elbowL: 0.4, kneeL: 0.9, hipLX: -0.8 }, { torsoY: 0.5, shoulderRZ: 0.6, elbowR: 1.9, hipRZ: 0.4, kneeR: 1.6, rootX: 0.3 }]
    for (const id of [MALE, FEMALE]) {
      const dims = personDims(id)
      const m = dims.mocap!
      for (const joints of poses) {
        const fr = poseFrames(dims, joints)
        const e = poseEffectors(dims, joints)
        const k = m.k
        expect(dist(e.handL, framePoint(fr.elbowL, { x: 0, y: -dims.lowerArmLen, z: 0 }))).toBeLessThan(1e-9)
        expect(dist(e.handR, framePoint(fr.elbowR, { x: 0, y: -dims.lowerArmLen, z: 0 }))).toBeLessThan(1e-9)
        // The toe effector as phase 1 had it: the ToeBase joint at rest, in the knee frame.
        const rest = m.rig.rest
        const toe = {
          L: { x: rest[BONE_INDEX.LeftToeBase]!.x - m.rig.origin.kneeL.x, y: rest[BONE_INDEX.LeftToeBase]!.y - m.rig.origin.kneeL.y, z: rest[BONE_INDEX.LeftToeBase]!.z - m.rig.origin.kneeL.z },
          R: { x: rest[BONE_INDEX.RightToeBase]!.x - m.rig.origin.kneeR.x, y: rest[BONE_INDEX.RightToeBase]!.y - m.rig.origin.kneeR.y, z: rest[BONE_INDEX.RightToeBase]!.z - m.rig.origin.kneeR.z }
        }
        expect(dist(e.footL, framePoint(fr.kneeL, { x: toe.L.x * k, y: toe.L.y * k, z: toe.L.z * k }))).toBeLessThan(1e-9)
        expect(dist(e.footR, framePoint(fr.kneeR, { x: toe.R.x * k, y: toe.R.y * k, z: toe.R.z * k }))).toBeLessThan(1e-9)
        const hf = handFrame(dims, joints, 'R')
        expect(dist(hf.p, framePoint(fr.elbowR, { x: 0, y: -dims.lowerArmLen, z: 0 }))).toBeLessThan(1e-9)
        hf.r.forEach((v, i) => expect(v).toBeCloseTo(fr.elbowR.r[i]!, 12))
      }
    }
  })

  it('the hand and foot capsules ride the wrist and ankle', () => {
    const rig = personDims(MALE).mocap!.rig
    for (const f of ['wristL', 'wristR', 'ankleL', 'ankleR'] as const) expect(rig.capsules.some((c) => c.frame === f), f).toBe(true)
    expect(weaponSpec('prop.sword')).toBeDefined()
  })
})

describe('fight moves on bots: the clip table and the impact frames', () => {
  it('maps moves onto clips by target in a fork table, one clip per impact; a move without clips keeps its keyframes', () => {
    expect(moveClips('jab-cross', 'head')).toEqual([
      { clip: 'jabHead', effector: 'handL' },
      { clip: 'cross', effector: 'handR' }
    ])
    expect(moveClips('jab-cross', 'body')!.map((b) => b.clip)).toEqual(['jabBody', 'cross'])
    expect(moveClips('hook-punch', 'body')).toEqual([{ clip: 'hookBody', effector: 'handL' }])
    expect(moveClips('roundhouse-kick', 'legs')).toEqual([{ clip: 'lowKick', effector: 'footR' }])
    expect(moveClips('spinning-backfist', 'head')).toBeNull()
    expect(moveClips('low-sweep', 'legs')).toBeNull()
    // Missing from the library: keyframes.
    expect(moveClips('front-kick', 'body')).toBeNull()
    // Weapons: a blade's slash swings the great sword's two cuts; the same move unarmed has no clip.
    const sword: HeldWeapon = { spec: weaponSpec('prop.sword')!, hand: 'R', scale: 1 }
    expect(moveClips('sword-slash-combo', 'head', sword)!.map((b) => [b.clip, b.within])).toEqual([
      ['greatSword', [0.5, 1]],
      ['greatSword', [1.1, 1.7]]
    ])
    expect(moveClips('sword-slash-combo', 'head')).toBeNull()
    // A fist move with a weapon in hand still plays its clips (the blow lands with the weapon).
    expect(moveClips('jab-cross', 'head', sword)!.map((b) => b.clip)).toEqual(['jabHead', 'cross'])
  })

  it('an impact is the peak extension of the striking effector toward the front, the first frame of a plateau', () => {
    expect(clipImpactTime({ clip: 'jabHead', effector: 'handL' })).toBeCloseTo(12 / 30, 9)
    expect(clipImpactTime({ clip: 'cross', effector: 'handR' })).toBeCloseTo(9 / 30, 9)
    // The definition, re-derived: no frame reaches further forward.
    const m = personDims(MALE)
    const reach = (t: number): number => -poseEffectors(m, undefined, { id: 'jabHead', t }).handL.z
    for (let f = 0; f <= 24; f++) expect(reach(f / 30)).toBeLessThanOrEqual(reach(12 / 30) + 1e-12)
  })

  it('with a weapon in hand the impact is the strike point of the weapon at its furthest, not the fist', () => {
    const sword: HeldWeapon = { spec: weaponSpec('prop.sword')!, hand: 'R', scale: 1 }
    const bare = clipImpactTime({ clip: 'greatSword', effector: 'handR' })
    const armed = clipImpactTime({ clip: 'greatSword', effector: 'handR' }, sword)
    const dims = personDims(MALE)
    const fist = (t: number): number => -poseEffectors(dims, undefined, { id: 'greatSword', t }).handR.z
    for (let f = 0; f <= 20; f++) expect(fist(f / 30)).toBeLessThanOrEqual(fist(bare) + 1e-12)
    const point = (t: number): number => -heldPointLocal(dims, undefined, 'R', sword.spec, weaponContact(sword.spec, 'strike'), 1, { id: 'greatSword', t }).z
    for (let f = 0; f <= 20; f++) expect(point(f / 30)).toBeLessThanOrEqual(point(armed) + 1e-12)
    expect(Math.abs(armed - bare)).toBeGreaterThan(1.5 / 30)
  })

  it('a defense meets the blow at its furthest guard; a reaction starts as it moves; a fall lands when the hips are down', () => {
    expect(defenseReadyTime('blockHead')).toBeCloseTo(8 / 30, 9)
    expect(reactionOnset('koBack')).toBeCloseTo(10 / 30, 9)
    expect(reactionOnset('hitHeadLeft')).toBeLessThan(reactionOnset('koBack'))
    expect(fallLandTime('knockedDown')).toBeCloseTo(15 / 30, 9)
    // The fall's back travel as a share, 0 → 1 over its window.
    expect(backTravel('knockedDown', 0, 1, 0)).toBe(0)
    expect(backTravel('knockedDown', 0, 1, 0.5)).toBeCloseTo(0.5, 6)
    expect(backTravel('knockedDown', 0, 1, 1)).toBe(1)
  })

  it('reacts by target and the side the blow lands on, defends by height, side and what is in hand', () => {
    const r = (o: Partial<Parameters<typeof reactionClip>[0]>): ReturnType<typeof reactionClip> =>
      reactionClip({ result: 'hit', ko: false, zone: 'head', moveId: 'jab-cross', side: 'R', ...o })
    // A blow on the right side of the head takes the left punch's hit (the head goes left, away from it).
    expect(r({})).toEqual({ id: 'hitHeadLeft', mirror: false })
    expect(r({ side: 'L' })).toEqual({ id: 'hitHeadRight', mirror: false })
    expect(r({ moveId: 'uppercut' })).toEqual({ id: 'hitUppercut', mirror: false })
    // No hitHeadBig in this library: the beat keeps its keyframe reaction.
    expect(r({ result: 'stagger' })).toBeNull()
    expect(r({ zone: 'body' })).toEqual({ id: 'hitStomach', mirror: false })
    // The side hit is captured from the left: a lateral blow on the right mirrors it.
    expect(r({ zone: 'body', moveId: 'hook-punch', side: 'L' })).toEqual({ id: 'hitSide', mirror: false })
    expect(r({ zone: 'body', moveId: 'hook-punch', side: 'R' })).toEqual({ id: 'hitSide', mirror: true })
    expect(r({ zone: 'body', moveId: 'shove-two-hands' })).toEqual({ id: 'shoveReact', mirror: false })
    expect(r({ zone: 'legs', side: 'L' })).toEqual({ id: 'hitSide', mirror: false })
    expect(r({ result: 'knockdown' })).toEqual({ id: 'knockedDown', mirror: false })
    expect(r({ result: 'knockdown', ko: true })).toEqual({ id: 'koBack', mirror: false })
    expect(r({ result: 'knockdown', ko: true, pushFront: true })).toBeNull()
    // Bare hands take a head blow on the shell (blockBody's forearms up in front of the face), its outer hand (the left) on the blow's side; a blade, club or shaft in hand keeps blockHead.
    expect(defenseClip('block', true, 'R')).toEqual({ id: 'blockBody', mirror: true })
    expect(defenseClip('block', true, 'L')).toEqual({ id: 'blockBody', mirror: false })
    expect(defenseClip('parry', true, 'R', { weapon: true })).toEqual({ id: 'blockHead', mirror: false })
    expect(defenseClip('block', true, 'L', { weapon: true })).toEqual({ id: 'blockHead', mirror: true })
    expect(defenseClip('parry', false, 'L')).toEqual({ id: 'blockBody', mirror: false })
    expect(defenseClip('slip', true, 'L')).toEqual({ id: 'dodge', mirror: false })
    expect(defenseClip('duck', false, 'R')).toEqual({ id: 'dodge', mirror: true })
    expect(defenseClip('block', true, 'R', { shieldHand: 'L' })).toBeNull()
  })
})

/** A cube of half-size h, split into a grid of n × n squares a face (two triangles each), wound outward. */
function cube(h: number, n = 4): { p: V3[]; tri: number[] } {
  const p: V3[] = []
  const tri: number[] = []
  const faces: [V3, V3, V3][] = [
    [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    [{ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }],
    [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
    [{ x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }],
    [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }],
    [{ x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }]
  ]
  for (const [nrm, u, v] of faces) {
    const base = p.length
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const a = -h + (2 * h * i) / n
        const b = -h + (2 * h * j) / n
        p.push({ x: nrm.x * h + u.x * a + v.x * b, y: nrm.y * h + u.y * a + v.y * b, z: nrm.z * h + u.z * a + v.z * b })
      }
    const at = (i: number, j: number): number => base + i * (n + 1) + j
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) tri.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1))
  }
  return { p, tri }
}

describe('skin to skin on a mesh', () => {
  const c = cube(0.1)
  const mesh = skinMesh(c.p, c.tri)
  const at = (q: V3): number => meshDepth([q], mesh)

  it('measures a point against faces, edges and corners: the gap outside, the depth inside', () => {
    expect(at({ x: 0.01, y: 0.02, z: 0.15 })).toBeCloseTo(-0.05, 9)
    expect(at({ x: 0.13, y: 0.13, z: 0.01 })).toBeCloseTo(-Math.SQRT2 * 0.03, 9)
    expect(at({ x: 0.12, y: 0.12, z: 0.12 })).toBeCloseTo(-Math.sqrt(3) * 0.02, 9)
    expect(at({ x: 0.01, y: 0.02, z: 0.07 })).toBeCloseTo(0.03, 9)
    // Inside beside an edge and a corner: the nearer face.
    expect(at({ x: 0.08, y: 0.085, z: 0.0 })).toBeCloseTo(0.015, 9)
    expect(at({ x: 0.09, y: 0.09, z: 0.09 })).toBeCloseTo(0.01, 9)
    // Out of reach: the cap.
    expect(at({ x: 0, y: 0, z: 0.5 })).toBeCloseTo(-0.08, 9)
  })

  it('a striking skin of many points: the coarse pass and its refinement find the closest point', () => {
    for (const [z, want] of [[0.14, -0.01], [0.12, 0.01]] as const) {
      // A ball of 400 points, radius 3 cm, over the top face (a fist's size).
      const ball = Array.from({ length: 400 }, (_, i) => {
        const y = 1 - (2 * (i + 0.5)) / 400
        const r = Math.sqrt(1 - y * y)
        const a = i * Math.PI * (3 - Math.sqrt(5))
        return { x: 0.03 * r * Math.cos(a) + 0.004, y: 0.03 * r * Math.sin(a) - 0.003, z: z + 0.03 * y }
      })
      const brute = Math.max(...ball.map(at))
      expect(meshDepth(ball, mesh)).toBe(brute)
      expect(brute).toBeCloseTo(want, 3)
    }
  })
})

