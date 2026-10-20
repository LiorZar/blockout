/**
 * The mocap body kind (fork addition; see MODIFICATIONS.md): a Mixamo
 * skeleton (mixamorig bone names), fitted from the bind pose and skinned
 * vertices the renderer reads out of a character file, so the engine never
 * loads one. `fitMocapRig` turns that into:
 *
 * - an "A-rest": arms hanging straight down (palms in), legs vertical, the
 *   rest at bind, soles on y = 0, scaled to the catalog height. The 11-bone
 *   rig's rest is the same pose, so its world rotations drive the bones
 *   (`fk.ts`) with every gait, motion and fight unchanged. Wide hips would
 *   swallow hands hanging straight down, so the arms rest turned out
 *   (`armRest`, the least that clears the hips and thighs);
 * - person dims in the rig's terms, frame origins (the rig's frames sit at
 *   the joints; torso and head are virtual origins rigid with Spine2 / Head);
 * - surface proxies: per-bone support points (floor), capsules (contact),
 *   and a torso loft cut from the mesh.
 *
 * Fingers and end bones ride their core bone at rest. Nothing here is Mixamo
 * data: it is fitted at runtime from the user's local library.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { Bone, PersonDims } from '../skeleton'
import type { V3 } from '../types'
import { qconj, qmul, qrot, qswing, v3, vadd, vdot, vlen, vscale, vsub, type Quat } from './quat'

/** The bones the body kind poses, parent-first. */
export const MOCAP_BONES = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase'
] as const

export type MocapBone = (typeof MOCAP_BONES)[number]

export const BONE_INDEX = Object.fromEntries(MOCAP_BONES.map((b, i) => [b, i])) as Record<MocapBone, number>

const PARENT: Record<MocapBone, MocapBone | null> = {
  Hips: null,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Neck: 'Spine2',
  Head: 'Neck',
  LeftShoulder: 'Spine2',
  LeftArm: 'LeftShoulder',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2',
  RightArm: 'RightShoulder',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips',
  LeftLeg: 'LeftUpLeg',
  LeftFoot: 'LeftLeg',
  LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips',
  RightLeg: 'RightUpLeg',
  RightFoot: 'RightLeg',
  RightToeBase: 'RightFoot'
}

/** Proxy frames beyond the rig's 11: the lower spine and the neck bend with the torso and head. */
export type MocapFrame = 'spine' | 'spine1' | 'neck'
export type FrameKey = Bone | MocapFrame

export const FRAME_KEYS: FrameKey[] = ['pelvis', 'spine', 'spine1', 'torso', 'neck', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'hipL', 'hipR', 'kneeL', 'kneeR']

/** The bone each frame rides. */
export const FRAME_BONE: Record<FrameKey, MocapBone> = {
  pelvis: 'Hips',
  spine: 'Spine',
  spine1: 'Spine1',
  torso: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  shoulderL: 'LeftArm',
  shoulderR: 'RightArm',
  elbowL: 'LeftForeArm',
  elbowR: 'RightForeArm',
  hipL: 'LeftUpLeg',
  hipR: 'RightUpLeg',
  kneeL: 'LeftLeg',
  kneeR: 'RightLeg'
}

/** The frame a bone's surface is rigid with (hands with the forearm, feet with the shin, clavicles with the chest). */
const BONE_FRAME: Record<MocapBone, FrameKey> = {
  Hips: 'pelvis',
  Spine: 'spine',
  Spine1: 'spine1',
  Spine2: 'torso',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'torso',
  LeftArm: 'shoulderL',
  LeftForeArm: 'elbowL',
  LeftHand: 'elbowL',
  RightShoulder: 'torso',
  RightArm: 'shoulderR',
  RightForeArm: 'elbowR',
  RightHand: 'elbowR',
  LeftUpLeg: 'hipL',
  LeftLeg: 'kneeL',
  LeftFoot: 'kneeL',
  LeftToeBase: 'kneeL',
  RightUpLeg: 'hipR',
  RightLeg: 'kneeR',
  RightFoot: 'kneeR',
  RightToeBase: 'kneeR'
}

/** Limbs swung to hang straight down in the A-rest, by the joint below them. */
const SWING: Partial<Record<MocapBone, string>> = {
  LeftArm: 'LeftForeArm',
  LeftForeArm: 'LeftHand',
  LeftHand: 'LeftHandMiddle1',
  RightArm: 'RightForeArm',
  RightForeArm: 'RightHand',
  RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg',
  LeftLeg: 'LeftFoot',
  RightUpLeg: 'RightLeg',
  RightLeg: 'RightFoot'
}

const TORSO_BONES: MocapBone[] = ['Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder']

/** Clearance between the hanging hands and the hips / thighs, the largest rest turn, and its step (rad). */
const ARM_GAP = 0.01
const ARM_REST_MAX = (20 * Math.PI) / 180
const ARM_REST_STEP = (0.25 * Math.PI) / 180

/**
 * The least outward turn of a hanging arm (about its shoulder joint, in the
 * frontal plane) that keeps its forearm and hand `ARM_GAP` outside the
 * hips and thighs at the same height and depth.
 */
function armRestTurn(side: 1 | -1, shoulder: V3, arm: V3[], body: V3[]): number {
  const CELL = 0.02
  const key = (y: number, z: number): string => `${Math.round(y / CELL)},${Math.round(z / CELL)}`
  const reach = new Map<string, number>()
  for (const p of body) {
    if (p.x * side <= 0) continue
    const k = key(p.y, p.z)
    reach.set(k, Math.max(reach.get(k) ?? 0, p.x * side))
  }
  const clears = (a: number): boolean => {
    const c = Math.cos(side * a)
    const sn = Math.sin(side * a)
    return arm.every((p) => {
      const dx = p.x - shoulder.x
      const dy = p.y - shoulder.y
      const x = (shoulder.x + dx * c - dy * sn) * side
      const y = shoulder.y + dx * sn + dy * c
      for (let i = -1; i <= 1; i++)
        for (let k = -1; k <= 1; k++) {
          const r = reach.get(key(y + i * CELL, p.z + k * CELL))
          if (r !== undefined && x < r + ARM_GAP) return false
        }
      return true
    })
  }
  for (let a = 0; a < ARM_REST_MAX; a += ARM_REST_STEP) if (clears(a)) return a
  return ARM_REST_MAX
}

/** A source bone: its name without the mixamorig prefix, parent index (−1 at the root), bind position and world rotation. */
export interface MocapSourceBone {
  name: string
  parent: number
  p: V3
  q: Quat
}

/**
 * What the renderer reads out of a character file: bones parent-first, and
 * the skinned vertices at bind with each one's dominant bone. Entity space:
 * metres, +Y up, facing −Z, +X the character's right.
 */
export interface MocapSource {
  bones: MocapSourceBone[]
  verts: { p: ArrayLike<number>; bone: ArrayLike<number> }
}

export interface MocapPoint {
  frame: FrameKey
  p: V3
}

export interface MocapCapsule {
  frame: FrameKey
  a: V3
  b: V3
  r: number
}

/** A fitted mocap body at height ×1 (entity-local, root under the pelvis on the floor). */
export interface MocapRig {
  /** Per core bone: parent index (−1 at Hips), A-rest joint, offset from the parent's joint, A-rest world rotation. */
  parent: number[]
  rest: V3[]
  offset: V3[]
  restQ: Quat[]
  /** Source metres → rig metres (the catalog height over the file's). */
  scale: number
  /** The arms' rest turn outward (rad): the least that keeps the hanging hands off the hips and thighs. */
  armRest: number
  /** The source's A-rest centre (Hips x / z, the soles' y), subtracted before scaling. */
  centre: V3
  dims: Omit<PersonDims, 'mocap'>
  /** Frame origins at rest (the rig frames' rotations are all identity there). */
  origin: Record<FrameKey, V3>
  /** Toe effectors in the knee frames. */
  toe: { L: V3; R: V3 }
  /** Shoulder joints in the torso frame (arm IK). */
  shoulder: { L: V3; R: V3 }
  /** Floor proxy: support points of each bone's surface, frame-local. */
  points: MocapPoint[]
  /** Contact proxy: a capsule per limb, the pelvis, neck and head, frame-local. */
  capsules: MocapCapsule[]
  /** The torso loft in the torso frame (contact.ts `TorsoShape` 'loft'). */
  torso: { ys: number[]; rings: [number, number][][] }
}

/** The bone name without the mixamorig prefix ("mixamorig:Hips", "mixamorig9Hips" → "Hips"). */
export function mixamoName(name: string): string {
  return name.replace(/^mixamorig\d*:?/, '')
}

const DOWN = v3(0, -1, 0)
const RADIAL = 32
const SECTIONS = 18
const DIRECTIONS = 128

/** Evenly spread unit directions (Fibonacci sphere). */
const SPHERE: V3[] = Array.from({ length: DIRECTIONS }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / DIRECTIONS
  const r = Math.sqrt(1 - y * y)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  return v3(r * Math.cos(a), y, r * Math.sin(a))
})

/** 2-D convex hull (monotone chain), counter-clockwise. */
function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Where the ray from the origin along (ux, uz) leaves a polygon (0 when it misses). */
function rayExit(poly: [number, number][], ux: number, uz: number): number {
  let out = 0
  let [ax, az] = poly[poly.length - 1]!
  for (const [bx, bz] of poly) {
    const dx = bx - ax
    const dz = bz - az
    const det = dx * uz - ux * dz
    if (Math.abs(det) > 1e-12) {
      const k = (dx * az - ax * dz) / det
      const v = (ux * az - uz * ax) / det
      if (k > 0 && v >= 0 && v <= 1) out = Math.max(out, k)
    }
    ax = bx
    az = bz
  }
  return out
}

/** A capsule around points along axis `d` through `o` (frame-local): its radius holds every point. */
function capsuleOf(frame: FrameKey, pts: V3[], o: V3, d: V3): MocapCapsule | null {
  if (pts.length === 0) return null
  const u = vscale(d, 1 / (vlen(d) || 1))
  let lo = Infinity
  let hi = -Infinity
  let r = 0
  for (const p of pts) {
    const w = vsub(p, o)
    const t = vdot(w, u)
    lo = Math.min(lo, t)
    hi = Math.max(hi, t)
    r = Math.max(r, vlen(vsub(w, vscale(u, t))))
  }
  const a = Math.min(lo + r, (lo + hi) / 2)
  const b = Math.max(hi - r, (lo + hi) / 2)
  return { frame, a: vadd(o, vscale(u, a)), b: vadd(o, vscale(u, b)), r }
}

/**
 * Fit a body from its source (see the module header). `height` is the
 * catalog height; throws when a core bone or a middle finger is missing or
 * the hierarchy isn't Mixamo's.
 */
export function fitMocapRig(src: MocapSource, height: number): MocapRig {
  const n = src.bones.length
  const index = new Map(src.bones.map((b, i) => [b.name, i]))
  const need = (name: string): number => {
    const i = index.get(name)
    if (i === undefined) throw new Error(`mocap body: no ${name} bone`)
    return i
  }
  const core = MOCAP_BONES.map(need)
  MOCAP_BONES.forEach((b, k) => {
    const p = PARENT[b]
    if ((p ? need(p) : -1) !== src.bones[core[k]!]!.parent) throw new Error(`mocap body: ${b} isn't under ${p ?? 'the root'}`)
  })
  const B = src.bones.map((b) => b.q)
  const P = src.bones.map((b) => b.p)
  // A-rest world rotations (limbs swung straight down, the rest at bind) and joints.
  const W: Quat[] = new Array(n)
  const R: V3[] = new Array(n)
  const coreOf = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const b = src.bones[i]!
    const par = b.parent
    if (par >= i) throw new Error('mocap body: bones are not parent-first')
    const k = (MOCAP_BONES as readonly string[]).indexOf(b.name)
    if (k >= 0) {
      const child = SWING[b.name as MocapBone]
      W[i] = child ? qmul(qswing(vsub(P[need(child)]!, P[i]!), DOWN), B[i]!) : B[i]!
      coreOf[i] = k
    } else {
      if (par < 0) throw new Error(`mocap body: ${b.name} sits above Hips`)
      W[i] = qmul(W[par]!, qmul(qconj(B[par]!), B[i]!))
      coreOf[i] = coreOf[par]!
    }
    R[i] = par < 0 ? P[i]! : vadd(R[par]!, qrot(W[par]!, qrot(qconj(B[par]!), vsub(P[i]!, P[par]!))))
  }
  // Skinned vertices into the A-rest, rigid with their dominant bone.
  const vp = src.verts.p
  const vb = src.verts.bone
  const m = vb.length
  const verts: V3[] = new Array(m)
  let minY = Infinity
  let maxY = -Infinity
  for (let v = 0; v < m; v++) {
    const i = vb[v]!
    const w = { x: vp[3 * v]! - P[i]!.x, y: vp[3 * v + 1]! - P[i]!.y, z: vp[3 * v + 2]! - P[i]!.z }
    const r = vadd(R[i]!, qrot(W[i]!, qrot(qconj(B[i]!), w)))
    verts[v] = r
    minY = Math.min(minY, r.y)
    maxY = Math.max(maxY, r.y)
  }
  if (!(maxY > minY)) throw new Error('mocap body: no skinned vertices')
  const root = R[core[0]!]!
  const centre = v3(root.x, minY, root.z)
  const scale = height / (maxY - minY)
  const norm = (p: V3): V3 => vscale(vsub(p, centre), scale)
  for (let v = 0; v < m; v++) verts[v] = norm(verts[v]!)
  const rest = core.map((i) => norm(R[i]!))
  const at = (name: string): V3 => norm(R[need(name)]!)
  const parent = MOCAP_BONES.map((b) => (PARENT[b] ? BONE_INDEX[PARENT[b]!] : -1))

  // Dims in the rig's terms (left and right averaged).
  const avg = (f: (side: 'Left' | 'Right') => number): number => (f('Left') + f('Right')) / 2
  const s = height / 1.78
  const upperLegLen = avg((sd) => vlen(vsub(at(`${sd}Leg`), at(`${sd}UpLeg`))))
  const lowerLegLen = avg((sd) => at(`${sd}Leg`).y)
  const upperArmLen = avg((sd) => vlen(vsub(at(`${sd}ForeArm`), at(`${sd}Arm`))))
  const palm = (sd: 'Left' | 'Right'): V3 => vadd(at(`${sd}Hand`), vscale(vsub(at(`${sd}HandMiddle1`), at(`${sd}Hand`)), 0.5))
  const lowerArmLen = avg((sd) => at(`${sd}ForeArm`).y - palm(sd).y)
  const T0 = rest[BONE_INDEX.Spine]!
  const byBone = MOCAP_BONES.map((): V3[] => [])
  for (let v = 0; v < m; v++) byBone[coreOf[vb[v]!]!]!.push(verts[v]!)
  const head = byBone[BONE_INDEX.Head]!
  const hb = head.reduce(
    (b, p) => ({ lo: v3(Math.min(b.lo.x, p.x), Math.min(b.lo.y, p.y), Math.min(b.lo.z, p.z)), hi: v3(Math.max(b.hi.x, p.x), Math.max(b.hi.y, p.y), Math.max(b.hi.z, p.z)) }),
    { lo: v3(Infinity, Infinity, Infinity), hi: v3(-Infinity, -Infinity, -Infinity) }
  )
  if (head.length === 0) throw new Error('mocap body: no head vertices')
  const headR = (hb.hi.y - hb.lo.y) / 2
  const headC = vscale(vadd(hb.lo, hb.hi), 0.5)
  const H0 = vsub(headC, v3(0, headR + 0.06 * s, 0))
  const torsoPts = TORSO_BONES.flatMap((b) => byBone[BONE_INDEX[b]]!)
  const hips = ['Hips', 'Spine', 'LeftUpLeg', 'RightUpLeg'].flatMap((b) => byBone[BONE_INDEX[b as MocapBone]]!)
  const hanging = (sd: 'Left' | 'Right'): V3[] => [...byBone[BONE_INDEX[`${sd}ForeArm`]]!, ...byBone[BONE_INDEX[`${sd}Hand`]]!]
  const armRest = Math.max(armRestTurn(-1, at('LeftArm'), hanging('Left'), hips), armRestTurn(1, at('RightArm'), hanging('Right'), hips))
  const bodyW = 2 * torsoPts.reduce((w, p) => Math.max(w, Math.abs(p.x)), 0)
  const dims: Omit<PersonDims, 'mocap'> = {
    H: height,
    s,
    legLen: upperLegLen + lowerLegLen,
    headR,
    torsoLen: H0.y - T0.y,
    bodyW,
    shoulderX: avg((sd) => Math.abs(at(`${sd}Arm`).x - T0.x)),
    hipX: avg((sd) => Math.abs(at(`${sd}UpLeg`).x)),
    shoulderY: avg((sd) => at(`${sd}Arm`).y - T0.y),
    upperArmLen,
    lowerArmLen,
    upperLegLen,
    lowerLegLen,
    baseLean: 0
  }

  const origin = Object.fromEntries(FRAME_KEYS.map((f) => [f, rest[BONE_INDEX[FRAME_BONE[f]]]!])) as Record<FrameKey, V3>
  origin.torso = T0
  origin.head = H0

  // Floor proxy: each bone's extreme vertices in 128 directions.
  const points: MocapPoint[] = []
  MOCAP_BONES.forEach((b, k) => {
    const pts = byBone[k]!
    if (pts.length === 0) return
    const frame = BONE_FRAME[b]
    const picked = new Set<number>()
    for (const d of SPHERE) {
      let best = 0
      let bestDot = -Infinity
      pts.forEach((p, i) => {
        const dot = vdot(p, d)
        if (dot > bestDot) {
          bestDot = dot
          best = i
        }
      })
      picked.add(best)
    }
    for (const i of [...picked].sort((a, c) => a - c)) points.push({ frame, p: vsub(pts[i]!, origin[frame]) })
  })

  // Contact proxy: capsules along each limb, across the pelvis, up the neck and head.
  const capsules: MocapCapsule[] = []
  const local = (b: MocapBone): V3[] => byBone[BONE_INDEX[b]]!.map((p) => vsub(p, origin[BONE_FRAME[b]]))
  const joint = (name: string, frame: FrameKey): V3 => vsub(at(name), origin[frame])
  const add = (c: MocapCapsule | null): void => {
    if (c) capsules.push(c)
  }
  add(capsuleOf('pelvis', local('Hips'), v3(0, 0, 0), v3(1, 0, 0)))
  add(capsuleOf('neck', local('Neck'), v3(0, 0, 0), vsub(at('Head'), at('Neck'))))
  add(capsuleOf('head', local('Head'), vsub(headC, H0), v3(0, 1, 0)))
  for (const sd of ['Left', 'Right'] as const) {
    const x = sd === 'Left' ? 'L' : 'R'
    add(capsuleOf(`shoulder${x}`, local(`${sd}Arm`), v3(0, 0, 0), DOWN))
    add(capsuleOf(`elbow${x}`, local(`${sd}ForeArm`), v3(0, 0, 0), DOWN))
    add(capsuleOf(`elbow${x}`, local(`${sd}Hand`), joint(`${sd}Hand`, `elbow${x}`), DOWN))
    add(capsuleOf(`hip${x}`, local(`${sd}UpLeg`), v3(0, 0, 0), DOWN))
    add(capsuleOf(`knee${x}`, local(`${sd}Leg`), v3(0, 0, 0), DOWN))
    const foot = [...local(`${sd}Foot`), ...local(`${sd}ToeBase`)]
    const heel = joint(`${sd}Foot`, `knee${x}`)
    add(capsuleOf(`knee${x}`, foot, heel, vsub(joint(`${sd}ToeBase`, `knee${x}`), heel)))
  }

  // Torso loft: convex sections of the chest and belly, sampled on 32 rays from the torso axis.
  const tp = torsoPts.map((p) => vsub(p, T0))
  const y0 = tp.reduce((lo, p) => Math.min(lo, p.y), Infinity)
  const y1 = tp.reduce((hi, p) => Math.max(hi, p.y), -Infinity)
  const step = (y1 - y0) / (SECTIONS - 1)
  const ys: number[] = []
  const rings: [number, number][][] = []
  for (let k = 0; k < SECTIONS; k++) {
    const y = y0 + step * k
    const slab = tp.filter((p) => Math.abs(p.y - y) <= step * 0.75).map((p): [number, number] => [p.x, p.z])
    if (slab.length < 3) continue
    const poly = hull(slab)
    const ring = Array.from({ length: RADIAL }, (_, i): [number, number] => {
      const t = (i / RADIAL) * Math.PI * 2
      const r = rayExit(poly, Math.cos(t), Math.sin(t))
      return [r * Math.cos(t), r * Math.sin(t)]
    })
    ys.push(y)
    rings.push(ring)
  }

  return {
    parent,
    rest,
    offset: rest.map((p, i) => (parent[i]! < 0 ? p : vsub(p, rest[parent[i]!]!))),
    restQ: core.map((i) => W[i]!),
    scale,
    armRest,
    centre,
    dims,
    origin,
    toe: { L: joint('LeftToeBase', 'kneeL'), R: joint('RightToeBase', 'kneeR') },
    shoulder: { L: vsub(at('LeftArm'), T0), R: vsub(at('RightArm'), T0) },
    points,
    capsules,
    torso: { ys, rings }
  }
}
