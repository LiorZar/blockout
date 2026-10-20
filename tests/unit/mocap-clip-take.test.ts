// Fork addition (2026): reading a Mixamo-like take (FBXLoader layout) into clip data, on the fixture skeleton; see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { clearMocapClips, clipSample, mocapClip, registerMocapClip, sampleLocals } from '@engine/mocap/clip'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import { MOCAP_BONES } from '@engine/mocap/rig'
import { clearMocapBodies } from '@engine/mocap/registry'
import { qconj, qmul, type Quat } from '@engine/mocap/quat'
import { personDims } from '@engine/skeleton'
import { readClipTake } from '@renderer/mocap/clips'
import { primaryBones } from '@renderer/mocap/extract'
import { registerClipTake, registerMocapTemplate } from '@renderer/mocap/library'
import { fixtureCharacter } from './mocap-three-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'

function angle(a: Quat, b: Quat): number {
  const d = qmul(qconj(a), b)
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]))
}

/** Entity space (m, facing −Z) → file space (cm, facing +Z), as the fixture character. */
const TO_FILE = new THREE.Matrix4().makeScale(100, 100, 100).multiply(new THREE.Matrix4().makeRotationY(-Math.PI))
const Q_FILE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI)

const POSES = sweep({ shoulderLX: 0, kneeR: 0, torsoY: 0 }, { shoulderLX: -1.4, kneeR: 1.1, torsoY: 0.4 }, 16)
const CURL = 0.9

/** A take on a fresh fixture character: core tracks from a synthetic clip, the left index finger curling, the hips drifting. */
function take(): { root: THREE.Group; clip: THREE.AnimationClip } {
  const src = syntheticClip(MALE, POSES, { inPlace: false, hips: (f) => ({ x: 0, y: 0.01 * f, z: -0.05 * f }) })
  const root = fixtureCharacter()
  const bones = primaryBones(root)
  const n = MOCAP_BONES.length
  const frames = POSES.length
  const times = Array.from({ length: frames }, (_, f) => f / 30)
  const tracks: THREE.KeyframeTrack[] = []
  const world = (f: number, i: number): THREE.Quaternion => {
    const r = src.rot
    return Q_FILE.clone().multiply(new THREE.Quaternion(r[4 * (f * n + i)]!, r[4 * (f * n + i) + 1]!, r[4 * (f * n + i) + 2]!, r[4 * (f * n + i) + 3]!))
  }
  MOCAP_BONES.forEach((name, i) => {
    const par = i === 0 ? -1 : MOCAP_BONES.indexOf(bones.get(name)!.parent!.name.replace('mixamorig', '') as (typeof MOCAP_BONES)[number])
    const values: number[] = []
    for (let f = 0; f < frames; f++) {
      const local = par < 0 ? world(f, i) : world(f, par).invert().multiply(world(f, i))
      values.push(local.x, local.y, local.z, local.w)
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`mixamorig${name}.quaternion`, times, values))
  })
  const hips: number[] = []
  for (let f = 0; f < frames; f++) {
    const p = new THREE.Vector3(src.hips[3 * f]!, src.hips[3 * f + 1]!, src.hips[3 * f + 2]!).applyMatrix4(TO_FILE)
    hips.push(p.x, p.y, p.z)
  }
  tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', times, hips))
  const index = bones.get('LeftHandIndex1')!
  const curl: number[] = []
  for (let f = 0; f < frames; f++) {
    const q = index.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (CURL * f) / (frames - 1)))
    curl.push(q.x, q.y, q.z, q.w)
  }
  tracks.push(new THREE.QuaternionKeyframeTrack('mixamorigLeftHandIndex1.quaternion', times, curl))
  return { root, clip: new THREE.AnimationClip('mixamo.com', (frames - 1) / 30, tracks) }
}

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('reading a take', () => {
  it('samples every frame into the engine clip: the rig pose of each frame and the hips travel', () => {
    const { root, clip } = take()
    ;(root as THREE.Group & { animations: THREE.AnimationClip[] }).animations = [clip]
    registerClipTake('t', root, MALE, { fps: 30, inPlace: false })
    const c = mocapClip('t')!
    expect(c.frames).toBe(16)
    const m = personDims(MALE).mocap!
    for (const f of [0, 7, 15]) {
      const want = mocapPose(m, jointLocals(POSES[f])).G
      clipSample(c, f / 30).G.forEach((q, i) => expect(angle(q, want[i]!), `frame ${f} ${MOCAP_BONES[i]}`).toBeLessThan(1e-5))
    }
    const r = clipSample(c, 15 / 30).root
    expect(r.z - clipSample(c, 0).root.z).toBeCloseTo(-0.75, 4)
    expect(clipSample(c, 15 / 30).hips.y - clipSample(c, 0).hips.y).toBeCloseTo(0.15, 4)
  })

  it('carries the finger tracks into the clip, under their parents, and mirrors them onto the other hand', () => {
    const { root, clip } = take()
    const src = readClipTake(root, clip, { unit: 0.01, fps: 30, source: MALE })
    expect(src.extra!.names).toEqual(['LeftHandIndex1'])
    expect(src.rot.length).toBe(16 * MOCAP_BONES.length * 4)
    registerMocapClip('fingers', src)
    const m = personDims(MALE).mocap!
    const c = mocapClip('fingers')!
    const curl = (t: number, mirror = false, name = 'LeftHandIndex1'): number => {
      const q = sampleLocals(m, clipSample(c, t, mirror)).get(name)!
      return 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]))
    }
    expect(curl(0.5)).toBeCloseTo(CURL, 4)
    expect(curl(0.25)).toBeCloseTo(CURL / 2, 4)
    expect(curl(0.5, true, 'RightHandIndex1')).toBeCloseTo(CURL, 4)
    expect(sampleLocals(m, clipSample(c, 0.5, true)).has('LeftHandIndex1')).toBe(false)
  })
})
