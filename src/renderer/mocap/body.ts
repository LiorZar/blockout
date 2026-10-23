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
 *
 * Phase 2 (mocap clips): a bot plays library clips — the evaluator's mark
 * clip (`AnimInput.clip`) or its gait's loop (`mocap/gait-clips.ts`), the
 * joint overrides on top as an overlay — posed and grounded by the engine
 * (`mocap/clip.ts`), so the rendered bones are the engine's. A bare stand
 * plays the idle loop; joints on a stand keep the keyframe rig pose (the
 * pose the engine's fights, weapons and shot words use). A gait change
 * crossfades (`AnimInput.from`). Fingers play the clip's (the engine poses
 * them, so the floor sees them); otherwise a relaxed hand; `AnimInput.hands`
 * closes either into a fist.
 */

import * as THREE from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { bodyShape } from '@engine/floor'
import { blendPoses, chain, clipSample, groundPose, mocapClip, mocapClipPose, poseLocals, poseLowY, sampleLocals, withExtras } from '@engine/mocap/clip'
import { boneWorld, mocapPose, poseFramesOf, type MocapPose, type RigLocals } from '@engine/mocap/fk'
import { clipWarp, gaitClipId, gaitPose as gaitClipPose } from '@engine/mocap/gait-clips'
import { qconj, qeuler, qmul, qrot, qslerp, vadd, type Quat } from '@engine/mocap/quat'
import { BONE_INDEX, FRAME_BONE, MOCAP_BONES } from '@engine/mocap/rig'
import { personDims, type Bone } from '@engine/skeleton'
import type { ClipState, GaitId } from '@engine/types'
import type { AnimInput, BuiltAsset, PersonJoints } from '../viewport/builders'
import { primaryBones } from './extract'
import { mocapTemplate } from './library'
import { movesBody } from './scene'

/** The studio mannequins' plastic: light body, dark joints. */
const BODY = 0xc9c9ce
const JOINT = 0x55555d

const RIG_FRAMES: Bone[] = ['pelvis', 'torso', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'hipL', 'hipR', 'kneeL', 'kneeR']

/** The clips whose first frame gives the relaxed hand and the fist. */
const RELAXED_CLIP = 'idle'
const FIST_CLIP = 'boxIdle'

const STILL_GAITS = new Set<GaitId>(['stand', 'gesture'])
/** held-weapons: gaits whose weapon arm the renderer steadies (hold.ts steadyArm). */
const TRAVEL_GAITS = new Set<GaitId>(['walk', 'jog', 'run'])

const q = (o: THREE.Object3D): Quat => [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]

/** Fork (fight-speed): per skin (geometry), each bone's reach: the furthest skin it moves from its joint, in the bone's own frame at bind; null when the weights don't sum to 1. */
const REACH = new WeakMap<THREE.BufferGeometry, Float64Array | null>()

function boneReach(mesh: THREE.SkinnedMesh): Float64Array | null {
  const known = REACH.get(mesh.geometry)
  if (known !== undefined) return known
  const pos = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.getAttribute('skinIndex')
  const weight = mesh.geometry.getAttribute('skinWeight')
  let reach: Float64Array | null = new Float64Array(mesh.skeleton.bones.length)
  const v = new THREE.Vector3()
  const u = new THREE.Vector3()
  for (let i = 0; i < pos.count && reach; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix)
    let sum = 0
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(i, k)
      if (w === 0) continue
      sum += w
      const b = index.getComponent(i, k)
      reach[b] = Math.max(reach[b]!, u.copy(v).applyMatrix4(mesh.skeleton.boneInverses[b]!).length())
    }
    if (Math.abs(sum - 1) > 1e-3) reach = null
  }
  REACH.set(mesh.geometry, reach)
  return reach
}

const SPHERE_M = new THREE.Matrix4()
const SPHERE_P = new THREE.Vector3()

/**
 * Fork (fight-speed): a posed bot skin's bounding sphere from its bones, not its vertices. three sorts by it every
 * frame and the bot clears it every frame (setBones): skinning every vertex on the CPU cost tens of ms a bot a frame.
 * Each skin influence moves its vertex rigidly with its bone, so it lies within that bone's reach (scaled as the bone
 * is) of its joint, and the skinned vertex (weights summing to 1) in the hull of those balls: the sphere around them
 * holds the whole posed skin. It is larger than the skin's own, never smaller (it only orders the draw and starts a
 * pick; the bot is never culled).
 */
function bonesSphere(mesh: THREE.SkinnedMesh, reach: Float64Array): void {
  const bones = mesh.skeleton.bones
  // Each moving bone's joint (skin space) and reach, and the box around those balls.
  const at: { x: number; y: number; z: number; r: number }[] = []
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let b = 0; b < bones.length; b++) {
    if (!(reach[b]! > 0)) continue
    SPHERE_M.multiplyMatrices(mesh.bindMatrixInverse, bones[b]!.matrixWorld)
    const { x, y, z } = SPHERE_P.setFromMatrixPosition(SPHERE_M)
    const r = reach[b]! * SPHERE_M.getMaxScaleOnAxis()
    at.push({ x, y, z, r })
    lo.x = Math.min(lo.x, x - r)
    lo.y = Math.min(lo.y, y - r)
    lo.z = Math.min(lo.z, z - r)
    hi.x = Math.max(hi.x, x + r)
    hi.y = Math.max(hi.y, y + r)
    hi.z = Math.max(hi.z, z + r)
  }
  const sphere = (mesh.boundingSphere ??= new THREE.Sphere())
  if (at.length === 0) {
    sphere.makeEmpty()
    return
  }
  const c = sphere.center.set((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)
  sphere.radius = Math.max(...at.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) + p.r))
}

/**
 * held-weapons: what a bot shows, for its held weapons' hold rule (`hold.ts`): the pose (arms steadied
 * on a travelling gait), whether it plays a mark clip, the keyframe rig or a gait's loop, and the clip
 * state and overrides it was given.
 */
export interface BotHold {
  pose: MocapPose
  kind: 'clip' | 'rig' | 'gait'
  clip?: AnimInput['clip']
  overrides?: Record<string, number>
  /** A gait's loop played as is (crouch, sit, lie: not a travelling gait's), at its clip time: the weapon held as on a clip. */
  loop?: ClipState
}

/** A pose, and whether it came off the hidden rig (the phase-1 path, the root's transform kept). */
interface Posed {
  pose: MocapPose
  rig?: boolean
  /** held-weapons: the loop clip and time of a still or crouched gait (BotHold.loop). */
  loop?: ClipState
}

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
  // The bones beyond the core (fingers) in the engine's order, with their bind under the parent.
  const extra = m.rig.extra.map((x) => {
    const bone = bones.get(x.name)
    return { bone, bind: bone?.quaternion.clone() }
  })
  const skinned: THREE.SkinnedMesh[] = []
  model.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    skinned.push(mesh)
    const color = /joint/i.test(mesh.name) ? JOINT : BODY
    mesh.material = new THREE.MeshPhongMaterial({ color, specular: 0x2c2c2c, shininess: 36 })
    mesh.userData.origColor = color
    mesh.castShadow = true
    mesh.receiveShadow = true
    // The bind-pose bounds don't hold a posed body.
    mesh.frustumCulled = false
    // Fork (fight-speed): its sphere from the bones (bonesSphere), not every vertex skinned on the CPU.
    const reach = boneReach(mesh)
    if (reach) mesh.computeBoundingSphere = (): void => bonesSphere(mesh, reach)
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
  // Phase 3: a held weapon rides the hand bone (a clip bends the wrist): `gripL` / `gripR` are
  // stand-in elbow frames turned as the hand, with the palm at (0, −lowerArmLen, 0) (hold.ts).
  const grips = (['L', 'R'] as const).map((side) => {
    const o = new THREE.Object3D()
    o.name = `grip${side}`
    root.add(o)
    return { side, o }
  })

  const tmp = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const rot = new THREE.Quaternion()
  const scl = new THREE.Vector3(unit, unit, unit)
  /** Set the bones and markers from a pose (root space). */
  const setBones = (p: MocapPose): void => {
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
    for (const { side, o } of grips) {
      const w = fr[side === 'L' ? 'wristL' : 'wristR']!
      const g = p.G[BONE_INDEX[side === 'L' ? 'LeftHand' : 'RightHand']]!
      const palm = m.rig.palm[side]
      const off = qrot(g, { x: palm.x * m.k, y: palm.y * m.k + dims.lowerArmLen, z: palm.z * m.k })
      o.position.set(w.p.x + off.x, w.p.y + off.y, w.p.z + off.z)
      o.quaternion.set(g[0], g[1], g[2], g[3])
    }
    // three caches a skinned mesh's bounds from the pose it first measures (export depth range,
    // top-down fit): forget them, so a measure is of this pose, whatever was rendered before.
    for (const mesh of skinned) {
      const lazy = mesh as unknown as { boundingBox: THREE.Box3 | null; boundingSphere: THREE.Sphere | null }
      lazy.boundingBox = null
      lazy.boundingSphere = null
    }
    // The fingers: the pose's own (skinning rotation G · restQ under the parent's), else at bind.
    const QX: Quat[] = []
    m.rig.extra.forEach((x, e) => {
      const b = extra[e]!
      if (!p.XG) {
        if (b.bone) b.bone.quaternion.copy(b.bind!)
        return
      }
      QX[e] = qmul(p.XG[e]!, x.restQ)
      const l = qmul(qconj(x.parent < Q.length ? Q[x.parent]! : QX[x.parent - Q.length]!), QX[e]!)
      b.bone?.quaternion.set(l[0], l[1], l[2], l[3])
    })
  }
  const rigLocals = (): RigLocals => ({
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
  })

  // Hands: relaxed and fist (each clip's first frame, when the library has it).
  const handOf = (id: string): Map<string, Quat> | null => {
    const c = mocapClip(id)
    return c ? sampleLocals(m, clipSample(c, 0)) : null
  }
  const relaxed = handOf(RELAXED_CLIP)
  const fist = handOf(FIST_CLIP)
  /** The pose's fingers (relaxed where it has none), closed toward a fist per hand. */
  const withHands = (p: MocapPose, hands: AnimInput['hands']): MocapPose => {
    if (!relaxed && !fist) return p
    let local = p.XG ? poseLocals(m, p) : (relaxed ?? new Map<string, Quat>())
    if (fist && hands && (hands.L > 0 || hands.R > 0)) {
      local = new Map(local)
      for (const [name, f] of fist) {
        const w = Math.min(1, name.startsWith('Left') ? hands.L : name.startsWith('Right') ? hands.R : 0)
        if (w > 0) local.set(name, qslerp(local.get(name) ?? [0, 0, 0, 1], f, w))
      }
    }
    return withExtras(m, p, local)
  }

  /** The hidden rig's pose in entity space (its root's grounding and tilt applied). */
  const rigPose = (): MocapPose => {
    const p = mocapPose(m, rigLocals())
    const rq = q(root)
    const rp = { x: root.position.x, y: root.position.y, z: root.position.z }
    return { P: p.P.map((v) => vadd(qrot(rq, v), rp)), G: p.G.map((g) => qmul(rq, g)) }
  }
  const mix = (a: Posed, b: Posed, w: number): Posed => {
    const target = poseLowY(m, a.pose) + (poseLowY(m, b.pose) - poseLowY(m, a.pose)) * w
    return { pose: groundPose(m, blendPoses(m, a.pose, b.pose, w), target) }
  }
  /** A gait's pose: its clip loop, or the hidden rig (a stand under joint offsets, or no clip in the library). */
  const gaitPose = (input: AnimInput): Posed => {
    const ov = input.overrides
    const id = movesBody(ov) && STILL_GAITS.has(input.gait) ? undefined : gaitClipId(assetId, input.gait, input.speed, input.seated)
    const clip = id ? mocapClip(id) : undefined
    if (id && clip) {
      // Fork (shot-clear): a sit over a seat prop rests on its top.
      const g = gaitClipPose(m, clip, clipWarp(m, clip, assetId), input.distance / ((input.scale ?? 1) * m.k), input.time, ov, input.seated ? input.seat : undefined)
      return { pose: g.pose, ...(TRAVEL_GAITS.has(input.gait) ? {} : { loop: { id, t: g.t } }) }
    }
    animatePerson(j, input)
    return { pose: rigPose(), rig: true }
  }
  /** What the bot shows for an input (see the module header). */
  const resolve = (input: AnimInput): Posed => {
    const c = input.clip && mocapClip(input.clip.id) ? input.clip : undefined
    const w = c ? Math.min(1, Math.max(0, c.w ?? 1)) : 0
    if (c && (w >= 1 || c.from)) return { pose: mocapClipPose(m, c, input.overrides)! }
    let g = gaitPose(input)
    if (input.from && input.from.w < 1) {
      const a = gaitPose(input.from.input)
      g = mix(a, g, Math.max(0, input.from.w))
    }
    if (c) g = mix(g, { pose: mocapClipPose(m, { ...c, w: 1 }, input.overrides)! }, w)
    return g
  }

  let last: { pose: MocapPose; rig: boolean } = { pose: mocapPose(m, rigLocals()), rig: true }
  // held-weapons: the pose as shown, its arms steadied (mocapSteady) on top, for the hold rule (hold.ts).
  let steadied: MocapPose | null = null
  const animate = (input: AnimInput): void => {
    const r = resolve(input)
    steadied = null
    if (r.rig) {
      // Phase 1: the hidden rig as posed (its root carries the gait's grounding).
      animatePerson(j, input)
      const p = withHands(mocapPose(m, rigLocals()), input.hands)
      setBones(p)
      last = { pose: p, rig: true }
    } else {
      root.position.set(0, 0, 0)
      root.rotation.set(0, 0, 0)
      const p = withHands(r.pose, input.hands)
      setBones(p)
      last = { pose: p, rig: false }
    }
    const kind: BotHold['kind'] = input.clip && mocapClip(input.clip.id) ? 'clip' : r.rig ? 'rig' : 'gait'
    group.userData.mocapHold = { pose: last.pose, kind, clip: input.clip, overrides: input.overrides, ...(kind === 'gait' && r.loop ? { loop: r.loop } : {}) } satisfies BotHold
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
    if (last.rig) {
      const p = mocapPose(m, rigLocals())
      steadied = last.pose.XG ? withExtras(m, p, poseLocals(m, last.pose)) : p
      ;(group.userData.mocapHold as BotHold).pose = steadied
      return setBones(steadied)
    }
    // On a clip: the arm hangs off the clip's chest as the rig would hold it (held-weapons: on top of
    // an arm already steadied, so a two-handed weapon keeps both).
    const from = steadied ?? last.pose
    const G = [...from.G]
    const half = (side === 'L' ? -1 : 1) * (m.rig.armRest / 2)
    const sh = side === 'L' ? qeuler(-ov('shoulderLX'), 0, -ov('shoulderLZ')) : qeuler(-ov('shoulderRX'), 0, ov('shoulderRZ'))
    const arm = qmul(G[BONE_INDEX.Spine2]!, qmul(sh, [0, 0, Math.sin(half), Math.cos(half)]))
    const fore = qmul(arm, qeuler(ov(side === 'L' ? 'elbowL' : 'elbowR'), 0, 0))
    const s = side === 'L' ? 'Left' : 'Right'
    G[BONE_INDEX[`${s}Arm`]] = arm
    G[BONE_INDEX[`${s}ForeArm`]] = fore
    G[BONE_INDEX[`${s}Hand`]] = fore
    const p = chain(m, G, from.P[0]!)
    steadied = from.XG ? withExtras(m, p, poseLocals(m, from)) : p
    ;(group.userData.mocapHold as BotHold).pose = steadied
    setBones(steadied)
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
