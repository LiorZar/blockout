/**
 * Body-surface contact for fight blows (fork addition; see MODIFICATIONS.md).
 *
 * A body blow lands where the horizontal line from a point on the torso axis
 * toward the attacker leaves the torso. The classic people's torso is the
 * capsule of `buildPerson` (radius 0.5·bodyW, axis 0.15–0.85·torsoLen); the
 * studio mannequins' is the lofted torso of `mannequin-mesh.ts` (its section
 * tables are copied here, sampled at the mesh's 32 ring angles, so the
 * surface is the mesh's own). `bodyClearance` is how far a point is from the
 * whole body (body / legs misses). `tests/unit/fight-contact.test.ts` checks
 * both against the built meshes. A mocap bot playing a clip (fork, mocap
 * fights) is measured on its clip pose.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { mocapStandIn } from '../mocap/registry'
import { framePoint, poseFrames, type PersonDims } from '../skeleton'
import type { ClipState, V3 } from '../types'

/** A torso section (mannequin-mesh.ts): y, half-width a, half-depth b, centre cz / cx, front bump, back bulge. */
type Section = [y: number, a: number, b: number, cz?: number, cx?: number, bump?: number, back?: number]

// mannequin-mesh.ts TORSO_M / TORSO_F (y in torsoLen, widths at s = 1, build 1).
const TORSO_M: Section[] = [
  [0.06, 0.134, 0.09, 0.004],
  [0.12, 0.13, 0.092, 0.002],
  [0.22, 0.128, 0.094, -0.002],
  [0.34, 0.136, 0.098, -0.006],
  [0.46, 0.152, 0.104, -0.01, 0, 0, 0.008],
  [0.56, 0.166, 0.11, -0.012, 0, 0.004, 0.014],
  [0.63, 0.173, 0.112, -0.012, 0, 0.016, 0.018],
  [0.71, 0.178, 0.112, -0.01, 0, 0.021, 0.018],
  [0.79, 0.18, 0.108, -0.006, 0, 0.016, 0.016],
  [0.86, 0.178, 0.1, -0.002, 0, 0.006, 0.012],
  [0.92, 0.175, 0.092, 0.003, 0, 0, 0.008],
  [0.95, 0.168, 0.087, 0.006],
  [0.98, 0.15, 0.081, 0.008],
  [1.02, 0.124, 0.074, 0.011],
  [1.06, 0.098, 0.066, 0.014],
  [1.1, 0.074, 0.058, 0.016]
]
const TORSO_F: Section[] = [
  [0.06, 0.12, 0.081, 0.004],
  [0.12, 0.114, 0.08, 0.002],
  [0.24, 0.106, 0.078],
  [0.36, 0.113, 0.082, -0.002],
  [0.45, 0.125, 0.087, -0.004, 0, 0.004],
  [0.5, 0.131, 0.089, -0.005, 0, 0.022],
  [0.56, 0.136, 0.091, -0.006, 0, 0.05],
  [0.62, 0.141, 0.092, -0.006, 0, 0.056],
  [0.68, 0.145, 0.091, -0.005, 0, 0.038],
  [0.74, 0.149, 0.089, -0.004, 0, 0.012, 0.004],
  [0.8, 0.152, 0.086, -0.002, 0, 0.003, 0.006],
  [0.87, 0.151, 0.082, 0, 0, 0, 0.006],
  [0.93, 0.146, 0.076, 0.004],
  [0.96, 0.136, 0.072, 0.006],
  [0.99, 0.12, 0.067, 0.008],
  [1.03, 0.098, 0.06, 0.01],
  [1.07, 0.074, 0.052, 0.012],
  [1.1, 0.058, 0.047, 0.012]
]
const BUMP_AT = [(246 * Math.PI) / 180, (294 * Math.PI) / 180]
const BACK_AT = [(55 * Math.PI) / 180, (125 * Math.PI) / 180]
/** The mesh's ring: 32 angles, superellipse exponent 2.3; front bulges sharper on the female. */
const RADIAL = 32
const TORSO_N = 2.3

/** A person's torso surface, in the torso bone's frame. */
export type TorsoShape =
  | { kind: 'capsule'; r: number; y0: number; y1: number }
  | { kind: 'loft'; ys: number[]; rings: [number, number][][] }

/** The torso of a person asset (`dims` from `personDims(assetId, params)`). */
export function torsoShape(assetId: string, params: Record<string, number | string> | undefined, dims: PersonDims): TorsoShape {
  // Fork: a mocap bot's loft is cut from its mesh (mocap/rig.ts), scaled by its height.
  if (dims.mocap) {
    const { rig, k } = dims.mocap
    return { kind: 'loft', ys: rig.torso.ys.map((y) => y * k), rings: rig.torso.rings.map((ring) => ring.map(([x, z]): [number, number] => [x * k, z * k])) }
  }
  const id = mocapStandIn(assetId)
  const female = id === 'person.mannequinFemale'
  if (!female && id !== 'person.mannequinMale') return { kind: 'capsule', r: dims.bodyW * 0.5, y0: dims.torsoLen * 0.15, y1: dims.torsoLen * 0.85 }
  const b = params?.build
  const W = dims.s * Math.min(1.3, Math.max(0.8, typeof b === 'number' ? b : 1))
  const sections = (female ? TORSO_F : TORSO_M).map(([y, a, bb, cz = 0, cx = 0, bump = 0, back = 0]): Section => [y * dims.torsoLen, a * W, bb * W, cz * W, cx * W, bump * W, back * W])
  const sharp = female ? 14 : 8
  const rings = sections.map((sec) => Array.from({ length: RADIAL }, (_, k) => ringPoint(sec, (k / RADIAL) * Math.PI * 2, sharp)))
  return { kind: 'loft', ys: sections.map((sec) => sec[0]), rings }
}

/** A ring point at angle t (mannequin-mesh.ts `ringPoint`): [x, z]. */
function ringPoint(sec: Section, t: number, sharp: number): [number, number] {
  const [, a, b, cz = 0, cx = 0, bump = 0, back = 0] = sec
  const e = 2 / TORSO_N
  const c = Math.cos(t)
  const s = Math.sin(t)
  const lobe = (at: number[], k: number): number => at.reduce((acc, p) => acc + Math.max(0, Math.cos(t - p)) ** k, 0)
  return [cx + a * Math.sign(c) * Math.abs(c) ** e, cz + b * Math.sign(s) * Math.abs(s) ** e - bump * lobe(BUMP_AT, sharp) + back * lobe(BACK_AT, 4)]
}

/** The loft's ring at height y (its vertices lerp between sections, as the mesh's do), or null outside it. */
function ringAt(shape: { ys: number[]; rings: [number, number][][] }, y: number): [number, number][] | null {
  const { ys, rings } = shape
  if (y < ys[0]! || y > ys[ys.length - 1]!) return null
  let i = 0
  while (i < ys.length - 2 && ys[i + 1]! < y) i++
  const u = (y - ys[i]!) / (ys[i + 1]! - ys[i]!)
  return rings[i]!.map(([x, z], k) => [x + (rings[i + 1]![k]![0] - x) * u, z + (rings[i + 1]![k]![1] - z) * u])
}

/** Is a torso-frame point inside the torso? */
function inside(shape: TorsoShape, p: V3): boolean {
  if (shape.kind === 'capsule') {
    // CapsuleGeometry(r, len, 4, 8) is a lathe of 8 sides: each ring is an
    // octagon with corners at atan2(x, z) = k·45°, its flats cos(22.5°) in.
    const dy = p.y < shape.y0 ? shape.y0 - p.y : p.y > shape.y1 ? p.y - shape.y1 : 0
    if (dy >= shape.r) return false
    const ring = Math.sqrt(shape.r * shape.r - dy * dy)
    const phi = Math.atan2(p.x, p.z)
    const mid = (Math.floor(phi / (Math.PI / 4)) + 0.5) * (Math.PI / 4)
    return Math.hypot(p.x, p.z) * Math.cos(phi - mid) <= ring * Math.cos(Math.PI / 8)
  }
  const ring = ringAt(shape, p.y)
  if (!ring) return false
  // Point in the mesh's 32-gon ring (even-odd rule).
  let odd = false
  let [px, pz] = ring[RADIAL - 1]!
  for (const [qx, qz] of ring) {
    if (qz > p.z !== pz > p.z && p.x < qx + ((px - qx) * (p.z - qz)) / (pz - qz)) odd = !odd
    px = qx
    pz = qz
  }
  return odd
}

/**
 * World point where the horizontal line from the torso axis (at `yFrac` of
 * the torso length) toward `toward` leaves the torso of a posed person.
 */
export function torsoSurface(
  shape: TorsoShape,
  dims: PersonDims,
  scale: number,
  joints: Record<string, number> | undefined,
  position: V3,
  heading: number,
  toward: { x: number; z: number },
  yFrac: number,
  clip?: ClipState
): V3 {
  // Fork (mocap fights): a bot playing a clip, the clip's torso.
  const torso = poseFrames(dims, joints, clip).torso
  const axis = framePoint(torso, { x: 0, y: yFrac * dims.torsoLen, z: 0 })
  // The direction in the entity frame (un-yawed), then in the torso frame (Rᵀ·d).
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  const dx = toward.x * c - toward.z * s
  const dz = toward.x * s + toward.z * c
  const r = torso.r
  const local = (k: number): V3 => {
    const w = { x: axis.x + dx * k - torso.p.x, y: axis.y - torso.p.y, z: axis.z + dz * k - torso.p.z }
    return { x: r[0] * w.x + r[3] * w.y + r[6] * w.z, y: r[1] * w.x + r[4] * w.y + r[7] * w.z, z: r[2] * w.x + r[5] * w.y + r[8] * w.z }
  }
  let lo = 0
  let hi = 0.6 * dims.s
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (inside(shape, local(mid))) lo = mid
    else hi = mid
  }
  const k = ((lo + hi) / 2) * scale
  const a = { x: axis.x * scale, y: axis.y * scale, z: axis.z * scale }
  // Entity-local → world (as skeleton.ts toWorld), then out along `toward`.
  return { x: position.x + a.x * c + a.z * s + toward.x * k, y: position.y + a.y, z: position.z - a.x * s + a.z * c + toward.z * k }
}

/** Signed distance from a torso-frame point to the torso (negative inside): the round capsule (it holds the lathe), or radially at the point's height. */
function torsoGap(shape: TorsoShape, p: V3): number {
  if (shape.kind === 'capsule') return Math.hypot(p.x, p.y - Math.min(shape.y1, Math.max(shape.y0, p.y)), p.z) - shape.r
  // The loft: the distance to its profile in the point's azimuth (the ring
  // radius at nearby heights), so a sloping chest or shoulder isn't overestimated.
  const [y0, y1] = [shape.ys[0]!, shape.ys[shape.ys.length - 1]!]
  const rho = Math.hypot(p.x, p.z)
  const ux = rho > 1e-9 ? p.x / rho : 0
  const uz = rho > 1e-9 ? p.z / rho : -1
  // Where the ray from the axis along (ux, uz) crosses the ring at height y.
  const radius = (y: number): number => {
    const ring = ringAt(shape, y)!
    let out = 0
    let [ax, az] = ring[RADIAL - 1]!
    for (const [bx, bz] of ring) {
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
  const yc = Math.min(y1, Math.max(y0, p.y))
  const here = rho - radius(yc)
  if (yc === p.y && here < 0) return here
  let best = Math.hypot(Math.max(0, here), p.y - yc)
  const span = 0.25 * (y1 - y0)
  for (let k = 0; k <= 16; k++) {
    const y = Math.min(y1, Math.max(y0, p.y - span + (2 * span * k) / 16))
    best = Math.min(best, Math.hypot(Math.max(0, rho - radius(y)), p.y - y))
  }
  return best
}

const segDist = (p: V3, a: V3, b: V3): number => {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const l2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z
  const u = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2)) : 0
  return Math.hypot(p.x - a.x - ab.x * u, p.y - a.y - ab.y * u, p.z - a.z - ab.z * u)
}

/**
 * How far a world point is from a posed person's body (m; negative inside):
 * the torso surface, the head, and capsules a little fuller than either
 * body's pelvis, arms, legs and feet.
 */
export function bodyClearance(
  shape: TorsoShape,
  dims: PersonDims,
  build: number,
  scale: number,
  joints: Record<string, number> | undefined,
  position: V3,
  heading: number,
  point: V3,
  clip?: ClipState
): number {
  // The point in the entity frame (unscaled), then the torso frame.
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  const wx = (point.x - position.x) / scale
  const wz = (point.z - position.z) / scale
  const p: V3 = { x: wx * c - wz * s, y: (point.y - position.y) / scale, z: wx * s + wz * c }
  const fr = poseFrames(dims, joints, clip)
  const t = fr.torso
  const r = t.r
  const d = { x: p.x - t.p.x, y: p.y - t.p.y, z: p.z - t.p.z }
  let gap = torsoGap(shape, { x: r[0] * d.x + r[3] * d.y + r[6] * d.z, y: r[1] * d.x + r[4] * d.y + r[7] * d.z, z: r[2] * d.x + r[5] * d.y + r[8] * d.z })
  // Fork: a mocap bot's capsules are fitted to its mesh (mocap/rig.ts).
  if (dims.mocap) {
    const k = dims.mocap.k
    for (const c of dims.mocap.rig.capsules) {
      const f = fr[c.frame]!
      gap = Math.min(gap, segDist(p, framePoint(f, { x: c.a.x * k, y: c.a.y * k, z: c.a.z * k }), framePoint(f, { x: c.b.x * k, y: c.b.y * k, z: c.b.z * k })) - c.r * k)
    }
    return gap * scale
  }
  const W = dims.s * build
  const at = (f: keyof typeof fr, x: number, y: number, z: number): V3 => framePoint(fr[f]!, { x, y, z })
  const head = at('head', 0, dims.headR + 0.06 * dims.s, 0)
  gap = Math.min(gap, Math.hypot(p.x - head.x, p.y - head.y, p.z - head.z) - dims.headR)
  // Pelvis box / loft, neck; per side the deltoid, arm, hand and curled
  // fingers, thigh, shin, foot box.
  const hw = 0.5 * dims.bodyW
  const caps: [V3, V3, number][] = [
    [at('pelvis', -hw, 0.02 * dims.s, 0), at('pelvis', hw, 0.02 * dims.s, 0), 0.135 * W],
    [at('head', 0, 0, 0), at('head', 0, 0.08 * dims.s, 0), 0.075 * W]
  ]
  for (const side of ['L', 'R'] as const) {
    const sh = fr[`shoulder${side}`]
    const el = fr[`elbow${side}`]
    const hp = fr[`hip${side}`]
    const kn = fr[`knee${side}`]
    const hand = framePoint(el, { x: 0, y: -dims.lowerArmLen, z: 0 })
    caps.push(
      [sh.p, sh.p, 0.095 * W],
      [sh.p, el.p, 0.065 * W],
      [el.p, hand, 0.055 * W],
      [hand, hand, 0.1 * W],
      [hp.p, kn.p, 0.105 * W],
      [kn.p, framePoint(kn, { x: 0, y: -dims.lowerLegLen + 0.06 * dims.s, z: 0 }), 0.075 * W],
      [framePoint(kn, { x: 0, y: -dims.lowerLegLen + 0.03 * dims.s, z: 0.06 * dims.s }), framePoint(kn, { x: 0, y: -dims.lowerLegLen + 0.03 * dims.s, z: -0.16 * dims.s }), 0.085 * W]
    )
  }
  for (const [a, b, rad] of caps) gap = Math.min(gap, segDist(p, a, b) - rad)
  return gap * scale
}
