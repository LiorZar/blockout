/**
 * A mocap bot in the three.js scene (fork addition; see MODIFICATIONS.md).
 *
 * The visual clones the library template (SkeletonUtils.clone) under a
 * wrapper that turns the file's centimetres facing +Z into the bot's metres
 * facing −Z at its fitted scale. A hidden 11-bone rig (empty groups) runs
 * `animatePerson`, so every gait, joint override and grounding rule plays
 * as it does on the procedural people; each frame the bones are then set
 * from that rig's rotations through the engine's mocap FK (`mocap/fk.ts`):
 * nothing accumulates, a frame is a function of (document, t). Named marker
 * objects (`elbowL`, `torso` …) carry the engine's frames, so held weapons
 * (`hold.ts`) find the palm at `(0, −lowerArmLen, 0)` below the elbow.
 */

import * as THREE from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { bodyShape } from '@engine/floor'
import { boneWorld, mocapPose, poseFramesOf, type RigLocals } from '@engine/mocap/fk'
import { qconj, qmul, type Quat } from '@engine/mocap/quat'
import { BONE_INDEX, FRAME_BONE, MOCAP_BONES } from '@engine/mocap/rig'
import { personDims, type Bone } from '@engine/skeleton'
import type { AnimInput, BuiltAsset, PersonJoints } from '../viewport/builders'
import { primaryBones } from './extract'
import { mocapTemplate } from './library'

/** The studio mannequins' plastic: light body, dark joints. */
const BODY = 0xc9c9ce
const JOINT = 0x55555d

const RIG_FRAMES: Bone[] = ['pelvis', 'torso', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'hipL', 'hipR', 'kneeL', 'kneeR']

const q = (o: THREE.Object3D): Quat => [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]

/** A bot's visual, or null while its library template isn't loaded. */
export function buildMocapPerson(
  assetId: string,
  params: Record<string, number | string> | undefined,
  animatePerson: (j: PersonJoints, input: AnimInput) => void
): BuiltAsset | null {
  const t = mocapTemplate(assetId)
  const dims = personDims(assetId, params)
  const m = dims.mocap
  if (!t || !m) return null
  const group = new THREE.Group()
  group.name = assetId
  const root = new THREE.Group()
  group.add(root)

  // The hidden rig (same layout as the studio mannequins').
  const joint = (parent: THREE.Object3D, name: string, x: number, y: number): THREE.Group => {
    const g = new THREE.Group()
    g.name = `rig:${name}`
    g.position.set(x, y, 0)
    parent.add(g)
    return g
  }
  const pelvis = joint(root, 'pelvis', 0, dims.legLen)
  const torso = joint(pelvis, 'torso', 0, 0.08 * dims.s)
  const head = joint(torso, 'head', 0, dims.torsoLen)
  const shoulderL = joint(torso, 'shoulderL', -dims.shoulderX, dims.shoulderY)
  const shoulderR = joint(torso, 'shoulderR', dims.shoulderX, dims.shoulderY)
  const elbowL = joint(shoulderL, 'elbowL', 0, -dims.upperArmLen)
  const elbowR = joint(shoulderR, 'elbowR', 0, -dims.upperArmLen)
  const hipL = joint(pelvis, 'hipL', -dims.hipX, 0)
  const hipR = joint(pelvis, 'hipR', dims.hipX, 0)
  const kneeL = joint(hipL, 'kneeL', 0, -dims.upperLegLen)
  const kneeR = joint(hipR, 'kneeR', 0, -dims.upperLegLen)
  const j: PersonJoints = { root, pelvis, torso, head, hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, elbowL, elbowR, legLen: dims.legLen, baseLean: 0, shape: bodyShape(assetId, params) }

  // The character, its bones at bind.
  const model = clone(t.root) as THREE.Group
  const wrapper = new THREE.Group()
  wrapper.rotation.y = Math.PI
  const unit = t.unit * m.rig.scale * m.k
  wrapper.scale.setScalar(unit)
  wrapper.add(model)
  root.add(wrapper)
  const bones = primaryBones(model)
  for (const [name, bone] of bones) t.bindLocal.get(name)?.decompose(bone.position, bone.quaternion, bone.scale)
  const core = MOCAP_BONES.map((name) => bones.get(name)!)
  model.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const color = /joint/i.test(mesh.name) ? JOINT : BODY
    mesh.material = new THREE.MeshPhongMaterial({ color, specular: 0x2c2c2c, shininess: 36 })
    mesh.userData.origColor = color
    mesh.castShadow = true
    mesh.receiveShadow = true
    // The bind-pose bounds don't hold a posed body.
    mesh.frustumCulled = false
  })
  group.updateMatrixWorld(true)
  const hipsParentInv = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(core[0]!.parent!.matrixWorld).invert()

  // The engine's frames, for held weapons and anything else that finds the rig by name.
  const markers = new Map<Bone, THREE.Object3D>()
  for (const f of RIG_FRAMES) {
    const o = new THREE.Object3D()
    o.name = f
    root.add(o)
    markers.set(f, o)
  }

  const tmp = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const rot = new THREE.Quaternion()
  const scl = new THREE.Vector3(unit, unit, unit)
  const pose = (): void => {
    const L: RigLocals = {
      pelvis: q(pelvis),
      torso: q(torso),
      head: q(head),
      shoulderL: q(shoulderL),
      shoulderR: q(shoulderR),
      elbowL: q(elbowL),
      elbowR: q(elbowR),
      hipL: q(hipL),
      hipR: q(hipR),
      kneeL: q(kneeL),
      kneeR: q(kneeR)
    }
    const p = mocapPose(m, L)
    const Q = boneWorld(m, p)
    const h = Q[0]!
    tmp.compose(pos.set(p.P[0]!.x, p.P[0]!.y, p.P[0]!.z), rot.set(h[0], h[1], h[2], h[3]), scl).premultiply(hipsParentInv)
    tmp.decompose(core[0]!.position, core[0]!.quaternion, core[0]!.scale)
    for (let i = 1; i < core.length; i++) {
      const l = qmul(qconj(Q[m.rig.parent[i]!]!), Q[i]!)
      core[i]!.quaternion.set(l[0], l[1], l[2], l[3])
    }
    const fr = poseFramesOf(m, p)
    for (const [f, o] of markers) {
      const g = p.G[BONE_INDEX[FRAME_BONE[f]]]!
      o.position.set(fr[f].p.x, fr[f].p.y, fr[f].p.z)
      o.quaternion.set(g[0], g[1], g[2], g[3])
    }
  }

  const animate = (input: AnimInput): void => {
    animatePerson(j, input)
    pose()
  }
  // hold.ts steadyArm: a weapon arm keeps its posed rotation through a travelling gait.
  group.userData.mocapSteady = (side: 'L' | 'R', overrides: Record<string, number> | undefined): void => {
    const ov = (k: string): number => overrides?.[k] ?? 0
    if (side === 'L') {
      shoulderL.rotation.set(-ov('shoulderLX'), 0, -ov('shoulderLZ'))
      elbowL.rotation.set(ov('elbowL'), 0, 0)
    } else {
      shoulderR.rotation.set(-ov('shoulderRX'), 0, ov('shoulderRZ'))
      elbowR.rotation.set(ov('elbowR'), 0, 0)
    }
    pose()
  }

  const tint = new THREE.Color()
  const setTint = (color: string | null): void => {
    model.traverse((o) => {
      const mesh = o as THREE.Mesh
      const orig = mesh.userData.origColor as number | undefined
      if (!mesh.isMesh || orig === undefined) return
      const mat = mesh.material as THREE.MeshPhongMaterial
      mat.color.setHex(orig)
      if (color !== null) mat.color.lerp(tint.set(color), 0.65)
    })
  }

  animate({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 })
  return { group, height: dims.H, animate, setTint }
}
