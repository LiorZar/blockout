// Fork addition (2026): the rendered mocap bot follows the engine's FK and stays on the floor (fixture skeleton); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { heldWeaponMatrix, steadyArm } from '@renderer/viewport/hold'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { primaryBones } from '@renderer/mocap/extract'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import { MOCAP_BONES } from '@engine/mocap/rig'
import { clearMocapBodies } from '@engine/mocap/registry'
import { personDims, poseEffectors, poseFrames, type Bone } from '@engine/skeleton'
import { heldPointLocal, weaponSpec } from '@engine/weapons'
import type { V3 } from '@engine/types'
import { fixtureCharacter } from './mocap-three-fixture'
import { groundingFailures } from './mocap-ground'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

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

function randomJoints(r: () => number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of CHANNELS) if (r() > 0.3) out[c] = (r() * 2 - 1) * (c.startsWith('elbow') || c.startsWith('knee') ? 2.2 : 1.2)
  return out
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const RIG: Bone[] = ['pelvis', 'torso', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'hipL', 'hipR', 'kneeL', 'kneeR']

/** CPU-skinned world positions of every vertex weighted wholly to one bone. */
function rigidSkin(root: THREE.Object3D): THREE.Vector3[] {
  root.updateMatrixWorld(true)
  const out: THREE.Vector3[] = []
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const w = mesh.geometry.getAttribute('skinWeight')
    const pos = mesh.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      if (w.getX(i) !== 1) continue
      out.push(mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(pos, i)).applyMatrix4(mesh.matrixWorld))
    }
  })
  return out
}

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapTemplate(FEMALE, fixtureCharacter(0.93))
})

afterAll(() => clearMocapBodies())

describe('a rendered mocap bot', () => {
  it('is a skinned character, not the stand-in mannequin', () => {
    const b = buildAsset(MALE)
    let skinned = 0
    b.group.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++
    })
    expect(skinned).toBe(2)
    expect(b.height).toBe(1.8)
  })

  it('puts every bone and rig frame where the engine FK does, to 1 mm', () => {
    const r = rng(3)
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      const dims = personDims(id)
      const bones = primaryBones(b.group)
      for (let n = 0; n < 40; n++) {
        const joints = randomJoints(r)
        b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
        b.group.updateMatrixWorld(true)
        const pose = mocapPose(dims.mocap!, jointLocals(joints))
        MOCAP_BONES.forEach((name, i) => {
          const w = bones.get(name)!.getWorldPosition(new THREE.Vector3())
          expect(dist(w, pose.P[i]!), `${id} ${name}`).toBeLessThan(0.001)
        })
        const fr = poseFrames(dims, joints)
        for (const f of RIG) {
          const o = b.group.getObjectByName(f)!
          expect(dist(o.getWorldPosition(new THREE.Vector3()), fr[f].p), `${id} ${f}`).toBeLessThan(0.001)
          const e = new THREE.Matrix4().extractRotation(o.matrixWorld).elements
          const r3 = fr[f].r
          const m = [e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!]
          m.forEach((v, k) => expect(v, `${id} ${f} r${k}`).toBeCloseTo(r3[k]!, 6))
        }
      }
    }
  })

  it('moves its skin rigidly with each bone, as the engine moves the bone', () => {
    const b = buildAsset(MALE)
    b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 })
    const rest = rigidSkin(b.group)
    const m = personDims(MALE).mocap!
    const at = mocapPose(m, jointLocals(undefined))
    const r = rng(9)
    for (let n = 0; n < 12; n++) {
      const joints = randomJoints(r)
      b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
      const posed = rigidSkin(b.group)
      const pose = mocapPose(m, jointLocals(joints))
      // Each rest vertex rides the one bone whose motion explains it: P + G · G₀⁻¹ · (rest − P₀).
      rest.forEach((v0, k) => {
        let best = Infinity
        for (let i = 0; i < MOCAP_BONES.length; i++) {
          const g = new THREE.Quaternion(...pose.G[i]!).multiply(new THREE.Quaternion(...at.G[i]!).invert())
          const w = new THREE.Vector3(v0.x - at.P[i]!.x, v0.y - at.P[i]!.y, v0.z - at.P[i]!.z).applyQuaternion(g)
          best = Math.min(best, posed[k]!.distanceTo(new THREE.Vector3(pose.P[i]!.x + w.x, pose.P[i]!.y + w.y, pose.P[i]!.z + w.z)))
        }
        expect(best).toBeLessThan(0.001)
      })
    }
  })

  it('holds a weapon in its palm, where the engine puts the grip', () => {
    const b = buildAsset(MALE)
    const joints = { shoulderRX: -1.1, elbowR: 0.6, torsoY: 0.3 }
    b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
    b.group.updateMatrixWorld(true)
    const spec = weaponSpec('prop.pistol')!
    const dims = personDims(MALE)
    const m = heldWeaponMatrix(b.group, dims, spec, 'R', 1)!
    const grip = new THREE.Vector3(spec.grip.x, spec.grip.y, spec.grip.z).applyMatrix4(m)
    expect(dist(grip, heldPointLocal(dims, joints, 'R', spec, spec.grip, 1))).toBeLessThan(0.001)
    // A travelling gait swings the arms; a steadied weapon arm keeps its posed rotation.
    b.animate!({ gait: 'walk', phase: 0.3, speed: 1.4, distance: 0.4, time: 0, overrides: joints })
    steadyArm(b.group, 'R', joints)
    b.group.updateMatrixWorld(true)
    const hand = b.group.getObjectByName('elbowR')!.localToWorld(new THREE.Vector3(0, -dims.lowerArmLen, 0))
    const shoulder = b.group.getObjectByName('shoulderR')!.getWorldPosition(new THREE.Vector3())
    const want = poseEffectors(dims, joints)
    const wantShoulder = poseEffectors(dims, joints).shoulderR
    expect(hand.distanceTo(shoulder)).toBeCloseTo(dist(want.handR, wantShoulder), 3)
  })

  it('tints through its materials and restores them', () => {
    const b = buildAsset(FEMALE)
    const colors = (): string[] => {
      const out: string[] = []
      b.group.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(((o as THREE.Mesh).material as THREE.MeshPhongMaterial).color.getHexString())
      })
      return out
    }
    const before = colors()
    b.setTint('#ff0000')
    expect(colors()).not.toEqual(before)
    b.setTint(null)
    expect(colors()).toEqual(before)
  })

  it('every gait and library motion keeps the skin on the floor within ±2 cm, every 1/12 s', () => {
    for (const id of [MALE, FEMALE]) expect(groundingFailures(id).slice(0, 12)).toEqual([])
  }, 300_000)
})
