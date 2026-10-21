/**
 * Reading a Mixamo character out of its loaded FBX (fork addition; see
 * MODIFICATIONS.md): the bind pose of its mixamorig bones and its skinned
 * vertices, in the engine's entity space (metres, facing −Z), for
 * `registerMocapBody`. FBXLoader gives a second mesh's skeleton duplicate
 * bones (same name, identity local, under the first): the first of each name
 * is the bone that gets posed.
 *
 * Nothing extracted here is stored: it is fitted at runtime from the user's
 * local library.
 */

import * as THREE from 'three'
import { mixamoName, type MocapSource } from '@engine/mocap/rig'
import type { Quat } from '@engine/mocap/quat'

/** File units (Mixamo: centimetres, +Z forward) → entity space. */
export function fileToEntity(unit: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(Math.PI).multiply(new THREE.Matrix4().makeScale(unit, unit, unit))
}

/** The posed bone of each mixamorig name (the first in tree order). */
export function primaryBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const out = new Map<string, THREE.Bone>()
  root.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return
    const name = mixamoName(o.name)
    if (!out.has(name)) out.set(name, o as THREE.Bone)
  })
  return out
}

/** The skinned meshes' bind matrix of each bone (world space at load), by name. */
function bindWorlds(root: THREE.Object3D): Map<string, THREE.Matrix4> {
  const out = new Map<string, THREE.Matrix4>()
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    mesh.skeleton.bones.forEach((b, i) => {
      const name = mixamoName(b.name)
      if (!out.has(name)) out.set(name, mesh.skeleton.boneInverses[i]!.clone().invert())
    })
  })
  return out
}

/** Metres per file unit: Mixamo files are in centimetres. */
export function fileUnit(root: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(root)
  return box.max.y - box.min.y > 10 ? 0.01 : 1
}

/**
 * The character's bind pose and skinned vertices (each with its heaviest
 * bone and, phase 3, its four skin influences), deduplicated to the
 * millimetre, in entity space; phase 3: the meshes' triangles over them.
 */
export function extractMocap(root: THREE.Object3D, unit = fileUnit(root)): MocapSource {
  root.updateMatrixWorld(true)
  const C = fileToEntity(unit)
  const bones = primaryBones(root)
  const binds = bindWorlds(root)
  const names = [...bones.keys()]
  const index = new Map(names.map((n, i) => [n, i]))
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const m = new THREE.Matrix4()
  const out: MocapSource['bones'] = names.map((name) => {
    const bone = bones.get(name)!
    let parent = -1
    for (let p = bone.parent; p; p = p.parent) {
      if (!(p as THREE.Bone).isBone) continue
      parent = index.get(mixamoName(p.name)) ?? -1
      break
    }
    m.multiplyMatrices(C, binds.get(name) ?? bone.matrixWorld).decompose(pos, quat, scale)
    return { name, parent, p: { x: pos.x, y: pos.y, z: pos.z }, q: [quat.x, quat.y, quat.z, quat.w] as Quat }
  })
  const p: number[] = []
  const boneOf: number[] = []
  const infBone: number[] = []
  const infWeight: number[] = []
  const tri: number[] = []
  const seen = new Set<string>()
  const v = new THREE.Vector3()
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const g = mesh.geometry
    const position = g.getAttribute('position')
    const skinIndex = g.getAttribute('skinIndex')
    const skinWeight = g.getAttribute('skinWeight')
    if (!position || !skinIndex || !skinWeight) return
    const toEntity = new THREE.Matrix4().multiplyMatrices(C, mesh.bindMatrix)
    // Phase 3: each of this mesh's vertices as a kept vertex (−1: skipped), for its triangles.
    const kept = new Int32Array(position.count).fill(-1)
    const at = new Map<string, number>()
    for (let i = 0; i < position.count; i++) {
      let best = 0
      let weight = -1
      for (let k = 0; k < skinIndex.itemSize; k++) {
        const w = skinWeight.getComponent(i, k)
        if (w > weight) {
          weight = w
          best = skinIndex.getComponent(i, k)
        }
      }
      const b = index.get(mixamoName(mesh.skeleton.bones[best]?.name ?? ''))
      if (b === undefined) continue
      v.fromBufferAttribute(position, i).applyMatrix4(toEntity)
      const key = `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)},${b}`
      if (seen.has(key)) {
        kept[i] = at.get(key) ?? -1
        continue
      }
      seen.add(key)
      at.set(key, boneOf.length)
      kept[i] = boneOf.length
      p.push(v.x, v.y, v.z)
      boneOf.push(b)
      // Phase 3: the four skin influences, so the engine skins the vertex as three does.
      for (let k = 0; k < 4; k++) {
        const w = k < skinIndex.itemSize ? skinWeight.getComponent(i, k) : 0
        const j = w > 0 ? index.get(mixamoName(mesh.skeleton.bones[skinIndex.getComponent(i, k)]?.name ?? '')) : undefined
        infBone.push(j ?? -1)
        infWeight.push(j === undefined ? 0 : w)
      }
    }
    // The mesh's triangles over the kept vertices (the winding turned with the file's handedness: none, a rotation).
    const faces = g.getIndex()
    const count = faces ? faces.count : position.count
    for (let k = 0; k + 2 < count; k += 3) {
      const a = kept[faces ? faces.getX(k) : k]!
      const b = kept[faces ? faces.getX(k + 1) : k + 1]!
      const c = kept[faces ? faces.getX(k + 2) : k + 2]!
      if (a >= 0 && b >= 0 && c >= 0 && a !== b && b !== c && a !== c) tri.push(a, b, c)
    }
  })
  return { bones: out, verts: { p, bone: boneOf, inf: { bone: infBone, weight: infWeight, tri } } }
}
