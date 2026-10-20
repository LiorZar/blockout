/**
 * Mocap clips in the renderer (fork addition; see MODIFICATIONS.md).
 * `readClipTake` samples a Mixamo take (three's FBXLoader result: a bone
 * tree and one AnimationClip) at its frames: the core bones' world rotations,
 * the hips joint and the tracked bones beyond the core (fingers), in entity
 * space, for the engine (`registerMocapClip`). Sampling runs once at load
 * through the tracks' interpolants: nothing accumulates, and the parsed
 * take is thrown away.
 *
 * Nothing read here is stored outside memory: the clips are the user's local
 * library.
 */

import * as THREE from 'three'
import type { MocapClipSource } from '@engine/mocap/clip'
import { MOCAP_BONES, mixamoName } from '@engine/mocap/rig'
import { fileToEntity, primaryBones } from './extract'

const CORE = new Set<string>(MOCAP_BONES)

/** A take sampled at `fps`, captured on `source`. `unit` is metres per file unit (the source character's). */
export function readClipTake(root: THREE.Object3D, take: THREE.AnimationClip, o: { unit: number; fps: number; source: string; loop?: boolean; inPlace?: boolean }): MocapClipSource {
  const bones = primaryBones(root)
  const quat = new Map<THREE.Bone, THREE.Interpolant>()
  const pos = new Map<THREE.Bone, THREE.Interpolant>()
  for (const track of take.tracks) {
    const dot = track.name.lastIndexOf('.')
    const bone = bones.get(mixamoName(track.name.slice(0, dot)))
    if (!bone) continue
    const prop = track.name.slice(dot + 1)
    if (prop === 'quaternion') quat.set(bone, track.createInterpolant())
    else if (prop === 'position') pos.set(bone, track.createInterpolant())
  }
  const core = MOCAP_BONES.map((name) => {
    const b = bones.get(name)
    if (!b) throw new Error(`clip take: no ${name} bone`)
    return b
  })
  const names = [...bones.keys()].filter((n) => !CORE.has(n) && quat.has(bones.get(n)!))
  const extra = names.map((n) => bones.get(n)!)
  const frames = Math.max(1, Math.round(take.duration * o.fps) + 1)
  const C = fileToEntity(o.unit)
  const rot = new Float64Array(frames * core.length * 4)
  const hips = new Float64Array(frames * 3)
  const xrot = new Float64Array(frames * extra.length * 4)
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  for (let f = 0; f < frames; f++) {
    const t = Math.min(take.duration, f / o.fps)
    for (const [bone, it] of quat) {
      const v = it.evaluate(t)
      bone.quaternion.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize()
    }
    for (const [bone, it] of pos) {
      const v = it.evaluate(t)
      bone.position.set(v[0]!, v[1]!, v[2]!)
    }
    root.updateMatrixWorld(true)
    core.forEach((bone, i) => {
      m.multiplyMatrices(C, bone.matrixWorld).decompose(p, q, s)
      rot.set([q.x, q.y, q.z, q.w], (f * core.length + i) * 4)
      if (i === 0) hips.set([p.x, p.y, p.z], 3 * f)
    })
    extra.forEach((bone, i) => {
      m.multiplyMatrices(C, bone.matrixWorld).decompose(p, q, s)
      xrot.set([q.x, q.y, q.z, q.w], (f * extra.length + i) * 4)
    })
  }
  return { source: o.source, fps: o.fps, loop: o.loop, inPlace: o.inPlace, rot, hips, extra: { names, rot: xrot } }
}
