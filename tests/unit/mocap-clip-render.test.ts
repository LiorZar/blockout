// Fork addition (2026): a rendered mocap bot playing clips matches the engine's clip pose (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildAsset, type AnimInput } from '@renderer/viewport/builders'
import { steadyArm } from '@renderer/viewport/hold'
import { primaryBones } from '@renderer/mocap/extract'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { botInput, poseKind } from '@renderer/mocap/scene'
import { clearMocapClips, clipSample, mocapClip, mocapClipPose, registerMocapClip } from '@engine/mocap/clip'
import { jointLocals, mocapPose, type MocapPose } from '@engine/mocap/fk'
import { clipStride, clipWarp, gaitClipId, gaitClipTime, gaitPose, measureStride } from '@engine/mocap/gait-clips'
import { MOCAP_BONES } from '@engine/mocap/rig'
import { clearMocapBodies } from '@engine/mocap/registry'
import { personDims } from '@engine/skeleton'
import type { EntityState } from '@engine/types'
import { createEntity } from '@engine/schema'
import { fixtureCharacter } from './mocap-three-fixture'
import { lowestSkinned } from './mocap-ground'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

const STAND: AnimInput = { gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 }

/** Every core bone's rendered world position against a pose's joints (m). */
function boneError(group: THREE.Object3D, pose: MocapPose): number {
  group.updateMatrixWorld(true)
  const bones = primaryBones(group)
  let worst = 0
  MOCAP_BONES.forEach((name, i) => {
    const p = bones.get(name)!.getWorldPosition(new THREE.Vector3())
    worst = Math.max(worst, p.distanceTo(new THREE.Vector3(pose.P[i]!.x, pose.P[i]!.y, pose.P[i]!.z)))
  })
  return worst
}

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapTemplate(FEMALE, fixtureCharacter(0.93))
  registerMocapClip('raise', syntheticClip(MALE, sweep({ shoulderLX: 0 }, { shoulderLX: -1.5, elbowL: 0.6 }, 31)))
  registerMocapClip('idle', syntheticClip(MALE, sweep({ torsoX: 0 }, { torsoX: 0.1 }, 31), { loop: true, curl: { LeftHandIndex1: 0.3, RightHandIndex1: 0.3 } }))
  registerMocapClip('boxIdle', syntheticClip(MALE, sweep({}, {}, 2), { curl: { LeftHandIndex1: 1.4, RightHandIndex1: 1.4 } }))
  // An in-place "walk": the body still, the contacts sliding back under it at 1.2 m/s.
  registerMocapClip('walk', syntheticClip(MALE, sweep({ hipLX: -0.2, hipRX: 0.2 }, { hipLX: -0.2, hipRX: 0.2 }, 31), { loop: true, grounded: true, hips: (f) => ({ x: 0, y: 0, z: 0.04 * f }) }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('a bot playing clips', () => {
  it('renders a mark clip where the engine poses it, overlay and all, to 1 mm', () => {
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      const m = personDims(id).mocap!
      for (const [clip, ov] of [[{ id: 'raise', t: 0.4 }, undefined], [{ id: 'raise', t: 0.9, mirror: true }, { elbowR: 0.8, torsoY: 0.3 }]] as const) {
        b.animate!({ ...STAND, clip, overrides: ov })
        expect(boneError(b.group, mocapClipPose(m, clip, ov)!), `${id} ${JSON.stringify(clip)}`).toBeLessThan(0.001)
      }
    }
  })

  it('stands the rendered skin on the clip\'s floor', () => {
    const b = buildAsset(MALE)
    for (const t of [0, 0.5, 1]) {
      b.animate!({ ...STAND, clip: { id: 'raise', t } })
      expect(Math.abs(lowestSkinned(b.group))).toBeLessThan(0.006)
    }
  })

  it('a bare stand plays the idle loop on time; a stand under joint offsets keeps the keyframe rig', () => {
    const b = buildAsset(MALE)
    const m = personDims(MALE).mocap!
    b.animate!({ ...STAND, time: 2.5 })
    expect(boneError(b.group, mocapClipPose(m, { id: 'idle', t: 2.5 })!)).toBeLessThan(0.001)
    expect(poseKind(MALE, { ...STAND })).toBe('idle')
    const ov = { shoulderRX: -1, elbowR: 1.2 }
    b.animate!({ ...STAND, overrides: ov })
    const rig = mocapPose(m, jointLocals(ov))
    const root = b.group.getObjectByName('rig:pelvis')!.parent!
    const P = rig.P.map((p) => ({ ...p, y: p.y + root.position.y }))
    expect(boneError(b.group, { P, G: rig.G })).toBeLessThan(0.001)
    expect(poseKind(MALE, { ...STAND, overrides: ov })).toBe('rig:stand')
    expect(poseKind(MALE, { ...STAND, overrides: { handR: 1 } })).toBe('idle')
  })

  it('a walk runs its loop on distance over the measured stride (the contacts stay put)', () => {
    const c = mocapClip('walk')!
    const m = personDims(MALE).mocap!
    expect(measureStride(m, c)).toBeCloseTo(1.2 * c.duration, 6)
    expect(clipStride(personDims(MALE, { height: 1.1 }).mocap!, c, MALE)).toBeCloseTo(1.1 * 1.2 * c.duration, 6)
    expect(gaitClipId(MALE, 'walk', 1.4)).toBe('walk')
    expect(gaitClipId(MALE, 'walk', 0)).toBe('idle')
    expect(gaitClipId(FEMALE, 'walk', 1.4)).toBe('walk')
    const b = buildAsset(MALE)
    const warp = clipWarp(m, c, MALE)
    for (const d of [0.4, 1.9]) {
      b.animate!({ gait: 'walk', phase: 0, speed: 1.4, distance: d, time: 0, scale: 1.3 })
      expect(boneError(b.group, gaitPose(m, c, warp, d / 1.3, 0).pose)).toBeLessThan(0.001)
    }
    // An even contact speed: the warp runs evenly.
    warp!.C.forEach((c, i) => expect(c).toBeCloseTo((i / warp!.rate) * 1.2, 6))
    // The body travels the clip's own contact speed: a foot planted at d stays put in the world.
    const foot = (d: number): number => {
      const st = clipSample(c, gaitClipTime(c, warp, d / 1.3, 0))
      return st.hips.z * 1.3 * (m.rig.rest[0]!.y / st.hipH) * m.k - d
    }
    expect(foot(0.3) - foot(0.5)).toBeCloseTo(0, 9)
  })

  it('crossfades from the pose it leaves', () => {
    const b = buildAsset(MALE)
    const m = personDims(MALE).mocap!
    const walk: AnimInput = { gait: 'walk', phase: 0, speed: 1.4, distance: 0.7, time: 1, scale: 1 }
    b.animate!({ ...STAND, time: 1, from: { input: walk, w: 0 } })
    const warp = clipWarp(m, mocapClip('walk')!, MALE)
    expect(boneError(b.group, mocapClipPose(m, { id: 'walk', t: gaitClipTime(mocapClip('walk')!, warp, 0.7, 1) })!)).toBeLessThan(0.001)
    b.animate!({ ...STAND, time: 1, from: { input: walk, w: 1 } })
    expect(boneError(b.group, mocapClipPose(m, { id: 'idle', t: 1 })!)).toBeLessThan(0.001)
    b.animate!({ ...STAND, time: 1, from: { input: walk, w: 0.5 } })
    expect(Math.abs(lowestSkinned(b.group))).toBeLessThan(0.006)
  })

  it('finds a gait change by bisection and blends over GAIT_BLEND seconds', () => {
    const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
    const arrive = 2.1
    const inputAt = (t: number): AnimInput => (t < arrive ? { gait: 'walk', phase: 0, speed: 1.4, distance: 1.4 * t, time: t } : { ...STAND, distance: 1.4 * arrive, time: t })
    const at = (t: number): AnimInput => {
      const input = inputAt(t)
      botInput(e, { entityId: e.id, position: { x: 0, y: 0, z: 0 }, heading: 0, gait: input.gait, distanceTravelled: input.distance, speed: input.speed } as EntityState, input, { inputAt, held: new Set() })
      return input
    }
    expect(at(2).from).toBeUndefined()
    const mid = at(arrive + 0.125)
    expect(mid.from!.input.gait).toBe('walk')
    expect(mid.from!.w).toBeCloseTo(0.5, 2)
    expect(at(arrive + 0.3).from).toBeUndefined()
  })

  it('plays finger poses: relaxed by default, a fist per hand, and the clip\'s own where it has them', () => {
    const b = buildAsset(MALE)
    const index = (side: string): THREE.Quaternion => primaryBones(b.group).get(`${side}HandIndex1`)!.quaternion.clone()
    b.animate!({ ...STAND, overrides: { shoulderLX: -0.2 } })
    const relaxedL = index('Left')
    const relaxedR = index('Right')
    b.animate!({ ...STAND, overrides: { shoulderLX: -0.2 }, hands: { L: 1, R: 0 } })
    expect(index('Left').angleTo(relaxedL)).toBeCloseTo(1.1, 4)
    expect(index('Right').angleTo(relaxedR)).toBeLessThan(1e-6)
    // A clip's fingers render where the engine (and so the floor proxy) puts them.
    const m = personDims(MALE).mocap!
    b.animate!({ ...STAND, clip: { id: 'boxIdle', t: 0 } })
    b.group.updateMatrixWorld(true)
    const pose = mocapClipPose(m, { id: 'boxIdle', t: 0 })!
    const e = m.rig.extra.findIndex((x) => x.name === 'LeftHandIndex1')
    const p = primaryBones(b.group).get('LeftHandIndex1')!.getWorldPosition(new THREE.Vector3())
    expect(p.distanceTo(new THREE.Vector3(pose.XP![e]!.x, pose.XP![e]!.y, pose.XP![e]!.z))).toBeLessThan(0.001)
    const tip = primaryBones(b.group).get('LeftHandMiddle1')!.getWorldPosition(new THREE.Vector3())
    const em = m.rig.extra.findIndex((x) => x.name === 'LeftHandMiddle1')
    expect(tip.distanceTo(new THREE.Vector3(pose.XP![em]!.x, pose.XP![em]!.y, pose.XP![em]!.z))).toBeLessThan(0.001)
  })

  it('a weapon arm on a walking clip holds its rig pose off the clip\'s chest', () => {
    const b = buildAsset(MALE)
    b.animate!({ gait: 'walk', phase: 0, speed: 1.4, distance: 0.5, time: 0, scale: 1, overrides: { shoulderRX: -0.6, elbowR: 1.4 } })
    b.group.updateMatrixWorld(true)
    const elbow = b.group.getObjectByName('elbowR')!.getWorldPosition(new THREE.Vector3())
    steadyArm(b.group, 'R', { shoulderRX: -1.2, elbowR: 1 })
    b.group.updateMatrixWorld(true)
    const moved = b.group.getObjectByName('elbowR')!.getWorldPosition(new THREE.Vector3())
    expect(moved.distanceTo(elbow)).toBeGreaterThan(0.05)
    const shoulder = b.group.getObjectByName('shoulderR')!.getWorldPosition(new THREE.Vector3())
    // Raised forward: the elbow out in front of the shoulder.
    expect(moved.z).toBeLessThan(shoulder.z - 0.1)
  })
})
