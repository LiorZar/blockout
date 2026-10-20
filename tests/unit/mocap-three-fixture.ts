// Fork addition (2026): the fixture skeleton as a three.js skinned character, laid out like an FBXLoader result; see MODIFICATIONS.md.
/**
 * The made-up mixamorig skeleton of `mocap-fixture.ts` built the way three's
 * FBXLoader hands a Mixamo character over: centimetres, facing +Z, bones
 * named "mixamorigHips", a surface mesh on the bones and a second mesh
 * ("joints": hands and feet) on duplicate bones under them. No Mixamo data.
 */

import * as THREE from 'three'
import { FIXTURE_BONES, fixtureSource, fixtureSurfaces } from './mocap-fixture'

/** Entity space (m, facing −Z) → file space (cm, facing +Z). */
const TO_FILE = new THREE.Matrix4().makeScale(100, 100, 100).multiply(new THREE.Matrix4().makeRotationY(-Math.PI))

export function fixtureCharacter(k = 1): THREE.Group {
  const src = fixtureSource(k)
  const root = new THREE.Group()
  const world = src.bones.map((b) =>
    new THREE.Matrix4().compose(new THREE.Vector3(b.p.x, b.p.y, b.p.z), new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), new THREE.Vector3(1, 1, 1)).premultiply(TO_FILE)
  )
  // World matrices carry the file's scale; bones take it out (scale 1, as FBX bones).
  const unscaled = world.map((m) => {
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    m.decompose(p, q, new THREE.Vector3())
    return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1))
  })
  const bones = src.bones.map((b) => {
    const bone = new THREE.Bone()
    bone.name = `mixamorig${b.name}`
    return bone
  })
  src.bones.forEach((b, i) => {
    const parentWorld = b.parent < 0 ? new THREE.Matrix4() : unscaled[b.parent]!
    new THREE.Matrix4().copy(parentWorld).invert().multiply(unscaled[i]!).decompose(bones[i]!.position, bones[i]!.quaternion, bones[i]!.scale)
    ;(b.parent < 0 ? root : bones[b.parent]!).add(bones[i]!)
  })
  // FBXLoader's duplicates for the second mesh: same name, identity local, under the first.
  const dupes = bones.map((b) => {
    const d = new THREE.Bone()
    d.name = b.name
    b.add(d)
    return d
  })
  root.updateMatrixWorld(true)
  const names = FIXTURE_BONES.map((d) => d[0])
  const joints = new Set(['LeftHand', 'RightHand', 'LeftHandIndex1', 'RightHandIndex1', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'])
  const mesh = (which: 'surface' | 'joints', skeleton: THREE.Bone[]): THREE.SkinnedMesh => {
    const pos: number[] = []
    const idx: number[] = []
    const wgt: number[] = []
    const v = new THREE.Vector3()
    for (const s of fixtureSurfaces()) {
      if (joints.has(s.bone) !== (which === 'joints')) continue
      for (const p of s.points) {
        v.set(p.x * k, p.y * k, p.z * k).applyMatrix4(TO_FILE)
        pos.push(v.x, v.y, v.z)
        // The owning bone; near its joint a share on the parent too (the dominant weight decides).
        const b = names.indexOf(s.bone)
        const par = Math.max(0, src.bones[b]!.parent)
        const j = src.bones[b]!.p
        const near = Math.hypot(p.x * k - j.x, p.y * k - j.y, p.z * k - j.z) < 0.04 * k
        idx.push(b, par, 0, 0)
        wgt.push(near ? 0.8 : 1, near ? 0.2 : 0, 0, 0)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
    const m = new THREE.SkinnedMesh(g, new THREE.MeshPhongMaterial({ color: which === 'surface' ? 0x3355aa : 0x222222 }))
    m.name = which === 'surface' ? 'Fixture_Surface' : 'Fixture_Joints'
    root.add(m)
    m.updateMatrixWorld(true)
    m.bind(new THREE.Skeleton(skeleton))
    return m
  }
  mesh('surface', bones)
  mesh('joints', dupes)
  return root
}
