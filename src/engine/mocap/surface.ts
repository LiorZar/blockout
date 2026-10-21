/**
 * A mocap bot's surface for fight contact (fork addition; see
 * MODIFICATIONS.md): how far a body part's skin reaches ahead of a point
 * along a direction, from the bot's support points (the extreme skinned
 * vertices of each bone in 128 directions, `rig.ts`), posed as the body
 * call poses it. A fist lands with its knuckles, not its palm: the Fight
 * Director puts the striking part's front on the target's front (the head's
 * skin, the guard hand's), so a blow touches skin to skin instead of
 * sinking a fist's depth into the face. A fighter's hands are fists on
 * screen (renderer/mocap/body.ts closes them with the `boxIdle` clip's
 * fingers), so its hands are measured as those fists.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { Effector } from '../skeleton'
import type { ClipState, V3 } from '../types'
import { botPose, clipSample, mocapClip, mocapClipVersion, sampleLocals, withExtras } from './clip'
import type { MocapDims, MocapPose } from './fk'
import { qrot, type Quat } from './quat'
import { BONE_INDEX, MOCAP_BONES, type MocapBone } from './rig'

/** The skin a part strikes or is struck with: its bones, and how far from its effector point its surface counts (m at height ×1). */
const PARTS: Partial<Record<Effector, { bones: MocapBone[]; radius: number }>> = {
  handL: { bones: ['LeftHand'], radius: 0.2 },
  handR: { bones: ['RightHand'], radius: 0.2 },
  footL: { bones: ['LeftFoot', 'LeftToeBase'], radius: 0.2 },
  footR: { bones: ['RightFoot', 'RightToeBase'], radius: 0.2 },
  elbowL: { bones: ['LeftArm', 'LeftForeArm'], radius: 0.1 },
  elbowR: { bones: ['RightArm', 'RightForeArm'], radius: 0.1 },
  kneeL: { bones: ['LeftUpLeg', 'LeftLeg'], radius: 0.12 },
  kneeR: { bones: ['RightUpLeg', 'RightLeg'], radius: 0.12 },
  head: { bones: ['Head'], radius: 0.3 }
}

const INDEX = Object.fromEntries(Object.entries(PARTS).map(([e, p]) => [e, new Set(p!.bones.map((b) => BONE_INDEX[b]))])) as Partial<Record<Effector, Set<number>>>

/** The clip whose first frame gives a fighter's fist (renderer/mocap/body.ts `FIST_CLIP`). */
const FIST_CLIP = 'boxIdle'

const FISTS = new WeakMap<object, { version: number; local: Map<string, Quat> | null }>()

/** A pose with the fighter's fists (the renderer's), when the library has the fist clip. */
function fisted(m: MocapDims, pose: MocapPose): MocapPose {
  let f = FISTS.get(m.rig)
  if (!f || f.version !== mocapClipVersion()) {
    const c = mocapClip(FIST_CLIP)
    f = { version: mocapClipVersion(), local: c ? sampleLocals(m, clipSample(c, 0)) : null }
    FISTS.set(m.rig, f)
  }
  return f.local ? withExtras(m, pose, f.local) : pose
}

/** A support point posed (entity-local): on its own finger bone when the pose turns the fingers. */
function posed(m: MocapDims, pose: MocapPose, pt: MocapDims['rig']['points'][number]): V3 {
  const sub = !!pose.XG && pt.sub !== undefined
  const o = sub ? pt.subOff! : pt.off
  const r = qrot(sub ? pose.XG![pt.sub!]! : pose.G[pt.bone]!, { x: o.x * m.k, y: o.y * m.k, z: o.z * m.k })
  const p = sub ? pose.XP![pt.sub!]! : pose.P[pt.bone]!
  return { x: p.x + r.x, y: p.y + r.y, z: p.z + r.z }
}

/**
 * How far a bot's part (its striking or struck skin) reaches ahead of
 * `from` along the unit direction `dir` (entity-local, m): the furthest of
 * its support points near `from`. 0 for a part with no skin listed. `given`:
 * the bot's pose for `joints` / `clip`, when the caller has it.
 */
export function partAhead(m: MocapDims, joints: Record<string, number> | undefined, clip: ClipState | undefined, part: Effector, from: V3, dir: V3, given?: MocapPose): number {
  const bones = INDEX[part]
  if (!bones) return 0
  const hand = part === 'handL' || part === 'handR'
  const base = given ?? botPose(m, joints, clip)
  const pose = hand ? fisted(m, base) : base
  const r2 = (PARTS[part]!.radius * m.k) ** 2
  let ahead = -Infinity
  for (const pt of m.rig.points) {
    if (!bones.has(pt.bone)) continue
    const p = posed(m, pose, pt)
    const dx = p.x - from.x
    const dy = p.y - from.y
    const dz = p.z - from.z
    if (dx * dx + dy * dy + dz * dz > r2) continue
    ahead = Math.max(ahead, dx * dir.x + dy * dir.y + dz * dir.z)
  }
  return Number.isFinite(ahead) ? ahead : 0
}

/** The bones a part's skin is cut from for skin-to-skin contact (the striking side within its radius). */
const SKIN: Record<string, MocapBone[]> = {
  head: ['Head', 'Neck'],
  // The thighs with the body: a low blow lands on whichever it meets first.
  body: ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftUpLeg', 'RightUpLeg'],
  legL: ['LeftUpLeg', 'LeftLeg'],
  legR: ['RightUpLeg', 'RightLeg'],
  guardL: ['LeftHand', 'LeftForeArm'],
  guardR: ['RightHand', 'RightForeArm'],
  // A striking knee's shin and foot, and the legs they must stay out of (fight/solve.ts kneeTuck).
  shinL: ['LeftLeg', 'LeftFoot', 'LeftToeBase'],
  shinR: ['RightLeg', 'RightFoot', 'RightToeBase'],
  legs: ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'],
  // A striking limb, shoulder to fist or hip to toe (a guard in its way opens: fight/solve.ts guardOpening).
  armL: ['LeftArm', 'LeftForeArm', 'LeftHand'],
  armR: ['RightArm', 'RightForeArm', 'RightHand'],
  kickL: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'],
  kickR: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'],
  // The whole body (bodies kept apart: the fight checks).
  whole: [...MOCAP_BONES]
}

/** Each bone beyond the core's core ancestor (fingers ride the hand, end bones their bone). */
const ANCESTORS = new WeakMap<object, number[]>()
function ancestors(m: MocapDims): number[] {
  let a = ANCESTORS.get(m.rig)
  if (!a) {
    const N = m.rig.parent.length
    const out: number[] = []
    for (const x of m.rig.extra) out.push(x.parent < N ? x.parent : out[x.parent - N]!)
    a = out
    ANCESTORS.set(m.rig, a)
  }
  return a
}

/**
 * A bot's skin, posed (entity-local): the skinned vertices whose dominant
 * bone (or its core ancestor) is in `bones`, blended over their influences
 * exactly as the renderer skins them; without the skin's influences, the
 * bones' support points.
 */
function skinOn(m: MocapDims, pose: MocapPose, bones: Set<number>, near: V3 | undefined, r2: number, index?: Int32Array): V3[] {
  const out: V3[] = []
  let at = -1
  const keep = (p: V3): void => {
    if (near && (p.x - near.x) ** 2 + (p.y - near.y) ** 2 + (p.z - near.z) ** 2 > r2) return
    if (index) index[at] = out.length
    out.push(p)
  }
  const skin = m.rig.skin
  if (!skin) {
    for (const pt of m.rig.points) if (bones.has(pt.bone)) keep(posed(m, pose, pt))
    return out
  }
  const N = m.rig.parent.length
  const full = pose.XG ? pose : withExtras(m, pose)
  const k = m.k
  for (const v of vertsOn(m, bones)) {
    let x = 0
    let y = 0
    let z = 0
    for (let i = 0; i < 4; i++) {
      const b = skin.bone[4 * v + i]!
      if (b < 0) continue
      const w = skin.weight[4 * v + i]!
      const P = b < N ? full.P[b]! : full.XP![b - N]!
      const [qx, qy, qz, qw] = b < N ? full.G[b]! : full.XG![b - N]!
      // qrot, inline (the hot loop of every skin-to-skin measure).
      const ox = skin.off[12 * v + 3 * i]! * k
      const oy = skin.off[12 * v + 3 * i + 1]! * k
      const oz = skin.off[12 * v + 3 * i + 2]! * k
      const tx = 2 * (qy * oz - qz * oy)
      const ty = 2 * (qz * ox - qx * oz)
      const tz = 2 * (qx * oy - qy * ox)
      x += w * (P.x + ox + qw * tx + qy * tz - qz * ty)
      y += w * (P.y + oy + qw * ty + qz * tx - qx * tz)
      z += w * (P.z + oz + qw * tz + qx * ty - qy * tx)
    }
    at = v
    keep({ x, y, z })
  }
  return out
}

/** Bone sets cached per rig (vertsOn, trisOn) before the caches start over. */
const SET_CACHE = 256

/** Each bone set's skinned vertices (their dominant bone, or its core ancestor, in the set), per rig. */
const VERTS = new WeakMap<object, Map<string, Int32Array>>()
function vertsOn(m: MocapDims, bones: Set<number>): Int32Array {
  let byRig = VERTS.get(m.rig)
  if (!byRig) {
    byRig = new Map()
    VERTS.set(m.rig, byRig)
  }
  const key = [...bones].sort((a, b) => a - b).join(',')
  let list = byRig.get(key)
  if (!list) {
    const skin = m.rig.skin!
    const N = m.rig.parent.length
    const up = ancestors(m)
    const out: number[] = []
    for (let v = 0; v < skin.n; v++) {
      const d = skin.dom[v]!
      if (bones.has(d < N ? d : up[d - N]!)) out.push(v)
    }
    list = Int32Array.from(out)
    if (byRig.size >= SET_CACHE) byRig.clear()
    byRig.set(key, list)
  }
  return list
}

/** A target's skin counts this far from the blow (m at height ×1): its hull is the local surface, not one across a concavity. */
const TARGET_RADIUS = 0.3

/**
 * A bot's skin, posed (entity-local): a striking part's (`handL` … within
 * its radius of `near`, a fighter's hands as fists) or a target's (`head`,
 * `body`, `legL` / `legR`, `guardL` / `guardR`; within TARGET_RADIUS of
 * `near`, the blow, when given).
 */
export function skinPoints(m: MocapDims, joints: Record<string, number> | undefined, clip: ClipState | undefined, part: string, near?: V3): V3[] {
  const strike = PARTS[part as Effector]
  const target = !strike || part === 'head'
  const list = target ? SKIN[part] : strike.bones
  if (!list) return []
  const bones = new Set(list.map((b) => BONE_INDEX[b]))
  const fist = part === 'handL' || part === 'handR' || part.startsWith('guard') || part.startsWith('arm')
  const pose = fist ? fisted(m, botPose(m, joints, clip)) : botPose(m, joints, clip)
  return skinOn(m, pose, bones, near, ((target ? TARGET_RADIUS : strike.radius) * m.k) ** 2)
}

/** Unit directions spread over the sphere (Fibonacci), the hull's faces. */
const HULL_DIRS: V3[] = Array.from({ length: 96 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 96
  const r = Math.sqrt(1 - y * y)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  return { x: r * Math.cos(a), y, z: r * Math.sin(a) }
})

/**
 * Skin to skin (world points): how deep the striking skin `strike` sits in
 * the target's (its support hull, 96 faces), positive inside; negative, the
 * gap to it. 0 when they just touch.
 */
export function skinDepth(strike: V3[], target: V3[]): number {
  if (strike.length === 0 || target.length === 0) return 0
  const h = HULL_DIRS.map((d) => Math.max(...target.map((p) => p.x * d.x + p.y * d.y + p.z * d.z)))
  let depth = -Infinity
  for (const q of strike) {
    // The signed distance outside the hull: its furthest face plane.
    let out = -Infinity
    HULL_DIRS.forEach((d, k) => {
      out = Math.max(out, q.x * d.x + q.y * d.y + q.z * d.z - h[k]!)
    })
    depth = Math.max(depth, -out)
  }
  return depth
}

/**
 * A target's skin with its triangles (entity-local), as `skinPoints` for a
 * target; null without the skin's triangles (the support hull serves then).
 */
export function targetSkin(m: MocapDims, joints: Record<string, number> | undefined, clip: ClipState | undefined, part: string, near?: V3): { p: V3[]; tri: number[] } | null {
  if (!SKIN[part]) return null
  const fist = part.startsWith('guard')
  const pose = fist ? fisted(m, botPose(m, joints, clip)) : botPose(m, joints, clip)
  return boneSkin(m, pose, new Set(SKIN[part]!.map((b) => BONE_INDEX[b])), near)
}

/** A fighter bot's pose: the body call's, its hands the fists the renderer shows. */
export function fighterPose(m: MocapDims, joints: Record<string, number> | undefined, clip: ClipState | undefined): MocapPose {
  return fisted(m, botPose(m, joints, clip))
}

/** A posed bot's support points (entity-local), each with its core bone. */
export function supportPoints(m: MocapDims, pose: MocapPose): { p: V3; bone: number }[] {
  return m.rig.points.map((pt) => ({ p: posed(m, pose, pt), bone: pt.bone }))
}

/**
 * A posed bot's skin on `bones` (entity-local; within TARGET_RADIUS of
 * `near`, when given) and its triangles with all three corners on it; null
 * without the skin's triangles.
 */
export function boneSkin(m: MocapDims, pose: MocapPose, bones: Set<number>, near?: V3): { p: V3[]; tri: number[] } | null {
  const skin = m.rig.skin
  if (!skin?.tri) return null
  if (!near) return { p: skinOn(m, pose, bones, undefined, 0), tri: trisOn(m, bones) }
  const index = new Int32Array(skin.n).fill(-1)
  const p = skinOn(m, pose, bones, near, (TARGET_RADIUS * m.k) ** 2, index)
  // The mesh's triangles with all three corners kept.
  const tri: number[] = []
  for (let k = 0; k < skin.tri.length; k += 3) {
    const a = index[skin.tri[k]!]!
    const b = index[skin.tri[k + 1]!]!
    const c = index[skin.tri[k + 2]!]!
    if (a >= 0 && b >= 0 && c >= 0) tri.push(a, b, c)
  }
  return { p, tri }
}

/** Each bone set's whole-skin triangles (with all three corners on it), on its `vertsOn` list's indices, per rig. */
const TRIS = new WeakMap<object, Map<string, number[]>>()
function trisOn(m: MocapDims, bones: Set<number>): number[] {
  let byRig = TRIS.get(m.rig)
  if (!byRig) {
    byRig = new Map()
    TRIS.set(m.rig, byRig)
  }
  const key = [...bones].sort((a, b) => a - b).join(',')
  let tri = byRig.get(key)
  if (!tri) {
    const skin = m.rig.skin!
    const index = new Int32Array(skin.n).fill(-1)
    vertsOn(m, bones).forEach((v, i) => (index[v] = i))
    tri = []
    for (let k = 0; k < skin.tri!.length; k += 3) {
      const a = index[skin.tri![k]!]!
      const b = index[skin.tri![k + 1]!]!
      const c = index[skin.tri![k + 2]!]!
      if (a >= 0 && b >= 0 && c >= 0) tri.push(a, b, c)
    }
    if (byRig.size >= SET_CACHE) byRig.clear()
    byRig.set(key, tri)
  }
  return tri
}

/** Grid cell for the vertex search (m), and how many cells around a point it looks. */
const CELL = 0.02
const REACH = 4
/** A point's closest skin is searched on the triangles around its NEAREST nearest vertices. */
const NEAREST = 3

/**
 * A target's skin as a mesh to measure against (world points, triangles):
 * its vertices binned in a CELL grid over its bounds, and each vertex's
 * triangles.
 */
export interface SkinMesh {
  p: Float64Array
  tri: Int32Array
  o: V3
  nx: number
  ny: number
  nz: number
  start: Int32Array
  items: Int32Array
  ring: Int32Array
  ringItems: Int32Array
  /** Per triangle, the query that last tested it. */
  seen: Int32Array
  query: number
}

/** A mesh of world points and triangles (three vertex indices each), for `meshDepth`. */
export function skinMesh(points: V3[], triangles: ArrayLike<number>): SkinMesh {
  const V = points.length
  const p = new Float64Array(3 * V)
  let x0 = Infinity
  let y0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let z1 = -Infinity
  points.forEach((q, i) => {
    p[3 * i] = q.x
    p[3 * i + 1] = q.y
    p[3 * i + 2] = q.z
    x0 = Math.min(x0, q.x)
    y0 = Math.min(y0, q.y)
    z0 = Math.min(z0, q.z)
    x1 = Math.max(x1, q.x)
    y1 = Math.max(y1, q.y)
    z1 = Math.max(z1, q.z)
  })
  const tri = Int32Array.from(triangles)
  const T = tri.length / 3
  if (V === 0) x0 = y0 = z0 = x1 = y1 = z1 = 0
  const nx = Math.floor((x1 - x0) / CELL) + 1
  const ny = Math.floor((y1 - y0) / CELL) + 1
  const nz = Math.floor((z1 - z0) / CELL) + 1
  // The cells' vertices, counted then filled (CSR).
  const cellOf = new Int32Array(V)
  const start = new Int32Array(nx * ny * nz + 1)
  for (let i = 0; i < V; i++) {
    const x = Math.floor((p[3 * i]! - x0) / CELL)
    const y = Math.floor((p[3 * i + 1]! - y0) / CELL)
    const z = Math.floor((p[3 * i + 2]! - z0) / CELL)
    cellOf[i] = (x * ny + y) * nz + z
    start[cellOf[i]! + 1]!++
  }
  for (let i = 1; i < start.length; i++) start[i]! += start[i - 1]!
  const items = new Int32Array(V)
  const fill = start.slice(0, -1)
  for (let i = 0; i < V; i++) items[fill[cellOf[i]!]!++] = i
  // Each vertex's triangles (CSR).
  const ring = new Int32Array(V + 1)
  for (let k = 0; k < tri.length; k++) ring[tri[k]! + 1]!++
  for (let i = 1; i < ring.length; i++) ring[i]! += ring[i - 1]!
  const ringItems = new Int32Array(tri.length)
  const at = ring.slice(0, -1)
  for (let k = 0; k < tri.length; k++) ringItems[at[tri[k]!]!++] = (k / 3) | 0
  return { p, tri, o: { x: x0, y: y0, z: z0 }, nx, ny, nz, start, items, ring, ringItems, seen: new Int32Array(T), query: 0 }
}

/** The closest point of triangle t to (qx, qy, qz) into `out` (Ericson); returns its squared distance. */
function closestOn(m: SkinMesh, t: number, qx: number, qy: number, qz: number, out: Float64Array): number {
  const p = m.p
  const a = 3 * m.tri[3 * t]!
  const b = 3 * m.tri[3 * t + 1]!
  const c = 3 * m.tri[3 * t + 2]!
  const ax = p[a]!
  const ay = p[a + 1]!
  const az = p[a + 2]!
  const abx = p[b]! - ax
  const aby = p[b + 1]! - ay
  const abz = p[b + 2]! - az
  const acx = p[c]! - ax
  const acy = p[c + 1]! - ay
  const acz = p[c + 2]! - az
  const apx = qx - ax
  const apy = qy - ay
  const apz = qz - az
  const set = (u: number, v: number): number => {
    out[0] = ax + abx * u + acx * v
    out[1] = ay + aby * u + acy * v
    out[2] = az + abz * u + acz * v
    return (qx - out[0]) ** 2 + (qy - out[1]) ** 2 + (qz - out[2]) ** 2
  }
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return set(0, 0)
  const bpx = qx - p[b]!
  const bpy = qy - p[b + 1]!
  const bpz = qz - p[b + 2]!
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return set(1, 0)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0)
  const cpx = qx - p[c]!
  const cpy = qy - p[c + 1]!
  const cpz = qz - p[c + 2]!
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return set(0, 1)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return set(1 - w, w)
  }
  const denom = 1 / (va + vb + vc)
  return set(vb * denom, vc * denom)
}

/** Scratch for `signedAt`. */
const C3 = new Float64Array(3)
const ND = new Float64Array(NEAREST)
const NV = new Int32Array(NEAREST)

/** A point's signed distance to the mesh (negative: behind the nearest triangle's face), or CELL × REACH when nothing is that near. */
function signedAt(q: V3, m: SkinMesh): number {
  const cap = CELL * REACH
  const c = C3
  const nd = ND
  const nv = NV
  const p = m.p
  const cx = Math.floor((q.x - m.o.x) / CELL)
  const cy = Math.floor((q.y - m.o.y) / CELL)
  const cz = Math.floor((q.z - m.o.z) / CELL)
  if (cx < -REACH || cy < -REACH || cz < -REACH || cx >= m.nx + REACH || cy >= m.ny + REACH || cz >= m.nz + REACH) return cap
  nd.fill(Infinity)
  nv.fill(-1)
  for (let s = 0; s <= REACH; s++) {
    const z0 = Math.max(0, cz - s)
    const z1 = Math.min(m.nz - 1, cz + s)
    for (let x = Math.max(0, cx - s); x <= Math.min(m.nx - 1, cx + s); x++)
      for (let y = Math.max(0, cy - s); y <= Math.min(m.ny - 1, cy + s); y++) {
        // The shell's cells only (in the cube's order): inside its x / y faces, just its two z faces.
        const face = Math.abs(x - cx) === s || Math.abs(y - cy) === s
        const step = face || s === 0 ? 1 : 2 * s
        for (let z = face || s === 0 ? z0 : cz - s; z <= z1; z += step) {
          if (z < z0) continue
          const cellAt = (x * m.ny + y) * m.nz + z
          for (let k = m.start[cellAt]!; k < m.start[cellAt + 1]!; k++) {
            const v = m.items[k]!
            const d = (q.x - p[3 * v]!) ** 2 + (q.y - p[3 * v + 1]!) ** 2 + (q.z - p[3 * v + 2]!) ** 2
            if (d >= nd[NEAREST - 1]!) continue
            let i = NEAREST - 1
            while (i > 0 && nd[i - 1]! > d) {
              nd[i] = nd[i - 1]!
              nv[i] = nv[i - 1]!
              i--
            }
            nd[i] = d
            nv[i] = v
          }
        }
      }
    // Cells past shell s are at least s cells away.
    if (nd[NEAREST - 1]! <= (s * CELL) ** 2) break
  }
  if (nv[0]! < 0) return cap
  const id = ++m.query
  let best = Infinity
  let bx = 0
  let by = 0
  let bz = 0
  // The faces at the closest point (several when it is on an edge or a corner): their summed normals sign it.
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < NEAREST; i++) {
    const v = nv[i]!
    if (v < 0) break
    for (let k = m.ring[v]!; k < m.ring[v + 1]!; k++) {
      const t = m.ringItems[k]!
      if (m.seen[t] === id) continue
      m.seen[t] = id
      const d = closestOn(m, t, q.x, q.y, q.z, c)
      const tie = Number.isFinite(best) && Math.abs(d - best) <= 1e-12 + best * 1e-9
      if (d > best && !tie) continue
      const a = 3 * m.tri[3 * t]!
      const b = 3 * m.tri[3 * t + 1]!
      const e = 3 * m.tri[3 * t + 2]!
      const ux = p[b]! - p[a]!
      const uy = p[b + 1]! - p[a + 1]!
      const uz = p[b + 2]! - p[a + 2]!
      const vx = p[e]! - p[a]!
      const vy = p[e + 1]! - p[a + 1]!
      const vz = p[e + 2]! - p[a + 2]!
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const l = Math.hypot(nx, ny, nz) || 1
      if (!tie) {
        best = d
        bx = c[0]!
        by = c[1]!
        bz = c[2]!
        sx = sy = sz = 0
      }
      sx += nx / l
      sy += ny / l
      sz += nz / l
    }
  }
  if (!Number.isFinite(best)) return cap
  const behind = (q.x - bx) * sx + (q.y - by) * sy + (q.z - bz) * sz < 0
  return Math.min(cap, behind ? -Math.sqrt(best) : Math.sqrt(best))
}

/** The coarse pass measures every STRIDE-th striking point; every point within REFINE of one it found within BAND of its closest is measured too. */
const STRIDE = 8
const BAND = 0.005
const REFINE = 0.015

/**
 * Skin to skin against a target's mesh (world points): the striking skin's
 * closest approach to its triangles, inside when behind the nearest
 * triangle's face. As a depth: positive inside, negative the gap (searched
 * to CELL × REACH; beyond, the gap is that far). The approach is local: a
 * coarse pass, then the full skin around its closest points.
 */
export function meshDepth(strike: V3[], m: SkinMesh): number {
  let closest = CELL * REACH
  if (strike.length <= 4 * STRIDE) {
    for (const q of strike) closest = Math.min(closest, signedAt(q, m))
    return -closest
  }
  const coarse: { q: V3; d: number }[] = []
  for (let i = 0; i < strike.length; i += STRIDE) {
    const d = signedAt(strike[i]!, m)
    coarse.push({ q: strike[i]!, d })
    closest = Math.min(closest, d)
  }
  const near = coarse.filter((c) => c.d <= closest + BAND && c.d < CELL * REACH)
  if (near.length === 0) return -closest
  // Only points inside the box around those can be near one.
  const lo = { x: Math.min(...near.map((c) => c.q.x)) - REFINE, y: Math.min(...near.map((c) => c.q.y)) - REFINE, z: Math.min(...near.map((c) => c.q.z)) - REFINE }
  const hi = { x: Math.max(...near.map((c) => c.q.x)) + REFINE, y: Math.max(...near.map((c) => c.q.y)) + REFINE, z: Math.max(...near.map((c) => c.q.z)) + REFINE }
  // The points near those, binned at REFINE.
  const bins = new Map<number, V3[]>()
  const key = (x: number, y: number, z: number): number => (x * 4096 + y) * 4096 + z
  const o = near[0]!.q
  const cellOf = (v: number, c: number): number => Math.floor((v - c) / REFINE) + 2048
  for (const c of near) {
    const k = key(cellOf(c.q.x, o.x), cellOf(c.q.y, o.y), cellOf(c.q.z, o.z))
    const list = bins.get(k)
    if (list) list.push(c.q)
    else bins.set(k, [c.q])
  }
  const r2 = REFINE * REFINE
  strike.forEach((q, i) => {
    if (i % STRIDE === 0 || q.x < lo.x || q.y < lo.y || q.z < lo.z || q.x > hi.x || q.y > hi.y || q.z > hi.z) return
    const cx = cellOf(q.x, o.x)
    const cy = cellOf(q.y, o.y)
    const cz = cellOf(q.z, o.z)
    let close = false
    for (let x = cx - 1; x <= cx + 1 && !close; x++)
      for (let y = cy - 1; y <= cy + 1 && !close; y++)
        for (let z = cz - 1; z <= cz + 1 && !close; z++)
          for (const c of bins.get(key(x, y, z)) ?? []) {
            if ((q.x - c.x) ** 2 + (q.y - c.y) ** 2 + (q.z - c.z) ** 2 <= r2) {
              close = true
              break
            }
          }
    if (close) closest = Math.min(closest, signedAt(q, m))
  })
  return -closest
}
