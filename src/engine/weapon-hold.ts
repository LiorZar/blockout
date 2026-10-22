/**
 * Held weapons on mocap bots (fork addition, held-weapons; see
 * MODIFICATIONS.md). The library's Mixamo clips were recorded empty-handed or
 * with another prop, so a weapon held rigidly in the fist passes through its
 * holder's own body: a shield through the head in the fight idle, a rifle's
 * stock through the chest on the aim, a bat through the legs in a fall.
 *
 * The hold rule turns the weapon about the palm, just enough to clear the
 * holder: each core bone's skin as a convex hull (the support planes of its
 * support points, in the bone's own frame), the weapon's capsules as points
 * every few centimetres, and the least rotation that brings every point onto
 * or outside the hulls (linearised, re-measured a few times). The holding
 * forearm and hand don't count (both for a two-handed weapon; a shield's
 * upper arm too). A weapon already clear isn't turned, so a blow that lands
 * lands with the same weapon.
 *
 * - On a clip the turn is a curve over the clip's frames, made once per
 *   bot, clip, weapon and hand on the bare clip pose and followed frame to
 *   frame (each frame starts from the last one's turn eased back toward
 *   none), so it never jumps from one side of a body to the other; a joint
 *   overlay on the clip (a fight's guard) carries it with the hand.
 * - Off a clip (the keyframe rig) it is measured on the pose itself.
 * - The turn is kept in the hand's frame (a different grip), so the engine
 *   and the renderer put the weapon in the same place.
 *
 * Only bots: the procedural people and the studio mannequins hold weapons
 * exactly as before.
 *
 * PURE: no DOM / three.js / Electron. The caches hold pure functions of the
 * registered library, never anything frame to frame.
 */

import { botPose, clipPose, clipSample, mocapClip, mocapClipVersion, type MocapClip } from './mocap/clip'
import { clipWarp, gaitClipId, gaitClipTime } from './mocap/gait-clips'
import { jointLocals, mocapPose, poseFramesOf, type MocapDims, type MocapPose } from './mocap/fk'
import { qconj, qmul, qnorm, qrot, qslerp, qswing, qtoM3, type Quat } from './mocap/quat'
import { BONE_INDEX, MOCAP_BONES, type MocapBone } from './mocap/rig'
import { weaponPieces } from './weapon-shape'
import { weaponRotation, type Hand, type HandFrame, type M3, type WeaponSpec } from './weapons'
import type { PersonDims } from './skeleton'
import type { ClipState, GaitId, V3 } from './types'

/** The hulls' support directions (Fibonacci). */
const DIRS: V3[] = Array.from({ length: 64 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 64
  const r = Math.sqrt(1 - y * y)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  return { x: r * Math.cos(a), y, z: r * Math.sin(a) }
})
const D = DIRS.length

/** A hull's support planes and the sphere round it, in one bone's frame (rig metres at height ×1). */
interface Shape {
  h: Float64Array
  c: V3
  rho: number
}

/** A bone's hull: a core bone's, or a finger's (`x`: its extra bone and the hull in that bone's frame, when the pose turns the fingers; else it rides the hand). */
interface Hull extends Shape {
  bone: number
  x?: Shape & { e: number }
}

function shapeOf(pts: V3[]): Shape {
  const h = new Float64Array(D)
  DIRS.forEach((d, k) => (h[k] = Math.max(...pts.map((p) => p.x * d.x + p.y * d.y + p.z * d.z))))
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length, z: pts.reduce((a, p) => a + p.z, 0) / pts.length }
  return { h, c, rho: Math.max(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z))) }
}

const HULLS = new WeakMap<object, Hull[]>()
const PADDED_HULLS = new WeakMap<object, Hull[]>()

/**
 * For a shield, a hand's and a forearm's hulls (and a finger's) are this much wider (rig m): the skin there bends
 * between bones (the wrist, the fingers wrapped round a grip) outside their support points' hulls — a shield beside the
 * other hand on a two-handed clip sat 4 cm in its skin with the hulls clear. Not for anything else: a clip that grips a
 * pistol or a sword in both hands (an aim, a two-handed slash) would turn it out of the other hand and off its mark.
 */
const HAND_PAD = 0.035
const PADDED = new Set<number>([BONE_INDEX.LeftHand, BONE_INDEX.RightHand, BONE_INDEX.LeftForeArm, BONE_INDEX.RightForeArm])

function hulls(m: MocapDims, pad: boolean): Hull[] {
  const cache = pad ? PADDED_HULLS : HULLS
  let out = cache.get(m.rig)
  if (!out) {
    const padded = (sh: Shape): Shape => (pad ? { h: sh.h.map((v) => v + HAND_PAD), c: sh.c, rho: sh.rho + HAND_PAD } : sh)
    out = []
    for (let b = 0; b < MOCAP_BONES.length; b++) {
      // The bone's own support points (a finger's ride the finger, which a clip turns).
      const pts = m.rig.points.filter((p) => p.bone === b && p.sub === undefined).map((p) => p.off)
      if (pts.length >= 4) out.push({ bone: b, ...(PADDED.has(b) ? padded(shapeOf(pts)) : shapeOf(pts)) })
    }
    // Each finger bone of a hand: the other hand's fingers wrap a grip the weapon is in (a two-handed clip's).
    const hands = new Set([BONE_INDEX.LeftHand, BONE_INDEX.RightHand])
    m.rig.extra.forEach((_, e) => {
      const pts = m.rig.points.filter((p) => p.sub === e && hands.has(p.bone))
      if (pts.length < 4) return
      out!.push({ bone: pts[0]!.bone, ...padded(shapeOf(pts.map((p) => p.off))), x: { e, ...padded(shapeOf(pts.map((p) => p.subOff!))) } })
    })
    cache.set(m.rig, out)
  }
  return out
}

/** A hull as posed: its joint and rotation, and the shape in that frame (a finger on its own bone when the pose turns it). */
function placed(hb: Hull, pose: MocapPose): { P: V3; G: Quat; s: Shape } {
  if (hb.x && pose.XP && pose.XG) return { P: pose.XP[hb.x.e]!, G: pose.XG[hb.x.e]!, s: hb.x }
  return { P: pose.P[hb.bone]!, G: pose.G[hb.bone]!, s: hb }
}

/** The bones a held weapon keeps out of: all but the holding forearm and hand (both for a two-hander; a shield's upper arm too). */
function holderBones(spec: WeaponSpec, hand: Hand): Set<number> {
  const sides = spec.twoHanded ? ['Left', 'Right'] : [hand === 'L' ? 'Left' : 'Right']
  const parts = spec.kind === 'shield' ? ['Arm', 'ForeArm', 'Hand'] : ['ForeArm', 'Hand']
  return new Set(MOCAP_BONES.map((_, i) => i).filter((i) => !sides.some((sd) => parts.some((x) => BONE_INDEX[`${sd}${x}` as MocapBone] === i))))
}

/** Points along a weapon's capsules this far apart at most (m); a shield's disc keeps every other chord, a little fatter. */
const STEP = 0.03

interface RulePoint {
  q: V3
  r: number
}

const POINTS = new Map<string, RulePoint[]>()

function rulePoints(assetId: string): RulePoint[] {
  let out = POINTS.get(assetId)
  if (!out) {
    out = []
    const pieces = weaponPieces(assetId)
    const disc = assetId === 'prop.shield' ? 29 : 0
    pieces.forEach(({ a, b, r }, i) => {
      if (i < disc && i % 2 === 1) return
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / STEP))
      const rr = i < disc ? Math.hypot(r, 0.0125) : r
      for (let k = 0; k <= n; k++) out!.push({ q: { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, z: a.z + ((b.z - a.z) * k) / n }, r: rr })
    })
    POINTS.set(assetId, out)
  }
  return out
}

/** Each frame's turn starts from the last frame's eased back this far toward the resting turn. */
const RELAX = 0.3

/** A point this far outside every hull (m) still counts as a constraint (it must not be pushed in). */
const NEAR = 0.01
/** The turn stops with every point at most this far inside a hull (m). */
const TARGET = 0.002
/**
 * On a pose other than the bare clip the curve's turn is only turned further
 * when the weapon is past this deep in a hull (m), and only back to it: a
 * fight's own solves (an armed guard) keep their weapon off the skin, which
 * the hulls hold a little wide of.
 */
const ON_POSE = 0.015
/** Re-measures per turn, and the most it turns in one (rad). */
const ITERS = 16
const MAX_STEP = 0.5
/** Normals blend over the support planes within this of the nearest (rig m): no jump at a hull's edge. */
const SOFT = 0.01

/** The rotation (pose space, about the palm) that keeps the weapon's points out of the holder's hulls, from `start` (`keep`: the clearest turn it passed, not the last). */
function solveTurn(m: MocapDims, pose: MocapPose, palm: V3, vs: V3[], rs: number[], bones: Hull[], start: Quat, target = TARGET, keep = false): { q: Quat; worst: number; reach: number } {
  const k = m.k
  const nb = bones.length
  // Each hull bone as placed: its joint, its rotation (row-major, bone → pose), its sphere's centre and radius.
  const PL = new Float64Array(nb * 16)
  const H: Float64Array[] = []
  bones.forEach((hb, j) => {
    const { P, G, s } = placed(hb, pose)
    const M = qtoM3(G)
    const o = 16 * j
    H.push(s.h)
    PL[o] = P.x
    PL[o + 1] = P.y
    PL[o + 2] = P.z
    for (let e = 0; e < 9; e++) PL[o + 3 + e] = M[e]!
    const cx = s.c.x * k
    const cy = s.c.y * k
    const cz = s.c.z * k
    PL[o + 12] = P.x + M[0] * cx + M[1] * cy + M[2] * cz
    PL[o + 13] = P.y + M[3] * cx + M[4] * cy + M[5] * cz
    PL[o + 14] = P.z + M[6] * cx + M[7] * cy + M[8] * cz
    PL[o + 15] = s.rho * k
  })
  let Q = start
  let worst = -Infinity
  let far = 0
  const n = vs.length
  // Per hull, the plane that last kept a point out (the next point along a capsule is most often out past it too).
  const sep = new Int32Array(nb)
  // The points in or near a hull this pass: the point (pose, about the palm), the hull, its depth, the point in the hull's frame.
  const near: number[] = []
  let best: { q: Quat; worst: number; reach: number } | null = null
  for (let it = 0; it <= ITERS; it++) {
    near.length = 0
    worst = -Infinity
    const R = qtoM3(Q)
    for (let i = 0; i < n; i++) {
      const u = vs[i]!
      const vx = R[0] * u.x + R[1] * u.y + R[2] * u.z
      const vy = R[3] * u.x + R[4] * u.y + R[5] * u.z
      const vz = R[6] * u.x + R[7] * u.y + R[8] * u.z
      const xx = palm.x + vx
      const xy = palm.y + vy
      const xz = palm.z + vz
      const r = rs[i]!
      for (let j = 0; j < nb; j++) {
        const o = 16 * j
        const reach = PL[o + 15]! + r + NEAR
        const sx = xx - PL[o + 12]!
        const sy = xy - PL[o + 13]!
        const sz = xz - PL[o + 14]!
        if (sx * sx + sy * sy + sz * sz > reach * reach) continue
        // The point in the bone's frame (rig metres).
        const dx = (xx - PL[o]!) / k
        const dy = (xy - PL[o + 1]!) / k
        const dz = (xz - PL[o + 2]!) / k
        const lx = PL[o + 3]! * dx + PL[o + 6]! * dy + PL[o + 9]! * dz
        const ly = PL[o + 4]! * dx + PL[o + 7]! * dy + PL[o + 10]! * dz
        const lz = PL[o + 5]! * dx + PL[o + 8]! * dy + PL[o + 11]! * dz
        const h = H[j]!
        // Out past one plane by more than NEAR: clear of this hull (the plane that last did so tried first).
        const d0 = sep[j]!
        const e0 = DIRS[d0]!
        if ((h[d0]! - (lx * e0.x + ly * e0.y + lz * e0.z)) * k + r < -NEAR) continue
        let min = Infinity
        let out = false
        for (let d = 0; d < D; d++) {
          const dd = DIRS[d]!
          const s = h[d]! - (lx * dd.x + ly * dd.y + lz * dd.z)
          if (s * k + r < -NEAR) {
            sep[j] = d
            out = true
            break
          }
          if (s < min) min = s
        }
        if (out) continue
        const depth = min * k + r
        if (depth > worst) {
          worst = depth
          far = Math.hypot(vx, vy, vz)
        }
        near.push(vx, vy, vz, j, depth, min, lx, ly, lz)
      }
    }
    if (keep && (!best || worst < best.worst)) best = { q: Q, worst, reach: far }
    if (worst <= target || it === ITERS) break
    // Each such point's normal, blended over the hull's planes near its nearest; the step that turns them all out.
    const A: V3[] = []
    const B: number[] = []
    for (let c = 0; c < near.length; c += 9) {
      const vx = near[c]!
      const vy = near[c + 1]!
      const vz = near[c + 2]!
      const o = 16 * near[c + 3]!
      const h = H[near[c + 3]!]!
      const min = near[c + 5]!
      const lx = near[c + 6]!
      const ly = near[c + 7]!
      const lz = near[c + 8]!
      let nx = 0
      let ny = 0
      let nz = 0
      for (let d = 0; d < D; d++) {
        const dd = DIRS[d]!
        const w = (h[d]! - (lx * dd.x + ly * dd.y + lz * dd.z) - min) / SOFT
        if (w > 4) continue
        const e = Math.exp(-w)
        nx += e * dd.x
        ny += e * dd.y
        nz += e * dd.z
      }
      const nl = Math.hypot(nx, ny, nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      const wx = PL[o + 3]! * nx + PL[o + 4]! * ny + PL[o + 5]! * nz
      const wy = PL[o + 6]! * nx + PL[o + 7]! * ny + PL[o + 8]! * nz
      const wz = PL[o + 9]! * nx + PL[o + 10]! * ny + PL[o + 11]! * nz
      // A turn ω moves the point by ω × v: its depth drops by ω · (v × n).
      A.push({ x: vy * wz - vz * wy, y: vz * wx - vx * wz, z: vx * wy - vy * wx })
      B.push(near[c + 4]! - target + 0.002)
    }
    const w = leastTurn(A, B)
    const a = Math.hypot(w.x, w.y, w.z)
    if (a < 1e-9) break
    const s = Math.min(a, MAX_STEP)
    const sh = Math.sin(s / 2) / a
    Q = qnorm(qmul([w.x * sh, w.y * sh, w.z * sh, Math.cos(s / 2)], Q))
  }
  return best ?? { q: Q, worst, reach: far }
}

/** The least ω with a_i · ω ≥ b_i for every i (Hildreth's dual coordinate ascent; the best it finds when they conflict). */
function leastTurn(A: V3[], B: number[]): V3 {
  const lam = new Float64Array(A.length)
  const w = { x: 0, y: 0, z: 0 }
  const nn = A.map((a) => a.x * a.x + a.y * a.y + a.z * a.z)
  for (let sweep = 0; sweep < 60; sweep++) {
    let moved = 0
    for (let i = 0; i < A.length; i++) {
      if (nn[i]! < 1e-12) continue
      const a = A[i]!
      const step = (B[i]! - (a.x * w.x + a.y * w.y + a.z * w.z)) / nn[i]!
      const next = Math.max(0, lam[i]! + step)
      const d = next - lam[i]!
      if (d === 0) continue
      lam[i] = next
      w.x += d * a.x
      w.y += d * a.y
      w.z += d * a.z
      moved = Math.max(moved, Math.abs(d) * Math.sqrt(nn[i]!))
    }
    if (moved < 1e-6) break
  }
  return w
}

const QI: Quat = [0, 0, 0, 1]

/** Row-major 3×3 → unit quaternion. */
function m3toQ(r: M3): Quat {
  const t = r[0] + r[4] + r[8]
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2
    return qnorm([(r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s, 0.25 * s])
  }
  if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2
    return qnorm([0.25 * s, (r[1] + r[3]) / s, (r[2] + r[6]) / s, (r[7] - r[5]) / s])
  }
  if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2
    return qnorm([(r[1] + r[3]) / s, 0.25 * s, (r[5] + r[7]) / s, (r[2] - r[6]) / s])
  }
  const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2
  return qnorm([(r[2] + r[6]) / s, (r[5] + r[7]) / s, 0.25 * s, (r[3] - r[1]) / s])
}

/** A rotation about the unit axis `a` by `angle` (rad). */
function qaxis(a: V3, angle: number): Quat {
  const s = Math.sin(angle / 2)
  return [a.x * s, a.y * s, a.z * s, Math.cos(angle / 2)]
}

/**
 * A shield's resting turn (pose space): about the forearm, its face away
 * from the holder's spine (the line from the hips to the neck), so the disc
 * lies outside the body the arm is beside. Identity for anything else, or
 * when the disc's centre sits on the forearm's line through the spine.
 */
function faceOut(spec: WeaponSpec, pose: MocapPose, palm: V3, handRot: M3, R: M3, scale: number): Quat {
  if (spec.kind !== 'shield') return QI
  const a = { x: handRot[1], y: handRot[4], z: handRot[7] }
  const face = { x: -R[2], y: -R[5], z: -R[8] }
  const d = { x: spec.tip.x - spec.grip.x, y: spec.tip.y - spec.grip.y, z: spec.tip.z - spec.grip.z }
  const c = { x: palm.x + (R[0] * d.x + R[1] * d.y + R[2] * d.z) * scale, y: palm.y + (R[3] * d.x + R[4] * d.y + R[5] * d.z) * scale, z: palm.z + (R[6] * d.x + R[7] * d.y + R[8] * d.z) * scale }
  const h = pose.P[BONE_INDEX.Hips]!
  const nk = pose.P[BONE_INDEX.Neck]!
  const s = { x: nk.x - h.x, y: nk.y - h.y, z: nk.z - h.z }
  const ss = s.x * s.x + s.y * s.y + s.z * s.z
  const u = ss > 0 ? Math.min(1, Math.max(0, ((c.x - h.x) * s.x + (c.y - h.y) * s.y + (c.z - h.z) * s.z) / ss)) : 0
  const o = { x: c.x - h.x - s.x * u, y: c.y - h.y - s.y * u, z: c.z - h.z - s.z * u }
  const oa = o.x * a.x + o.y * a.y + o.z * a.z
  const out = { x: o.x - a.x * oa, y: o.y - a.y * oa, z: o.z - a.z * oa }
  const ol = Math.hypot(out.x, out.y, out.z)
  if (ol < 1e-3) return QI
  const n = { x: out.x / ol, y: out.y / ol, z: out.z / ol }
  const cr = { x: face.y * n.z - face.z * n.y, y: face.z * n.x - face.x * n.z, z: face.x * n.y - face.y * n.x }
  const angle = Math.atan2(cr.x * a.x + cr.y * a.y + cr.z * a.z, face.x * n.x + face.y * n.y + face.z * n.z)
  return qaxis(a, angle)
}

/**
 * The hold turn of a weapon on a posed bot, in its hand's frame (a turn of
 * the grip). From `prev` (the turn a frame before, hand frame) eased back
 * toward the weapon's resting turn, else from that resting turn (a shield
 * faces out, anything else none); if that start can't clear the body, from
 * the resting turn and from none too, the clearest kept. Identity when the
 * weapon is clear.
 */
export function poseHoldTurn(m: MocapDims, pose: MocapPose, spec: WeaponSpec, hand: Hand, scale: number, prev?: Quat, relax = RELAX, target = TARGET): Quat {
  return holdSolve(m, pose, spec, hand, scale, prev, relax, target, true).q
}

/** poseHoldTurn's turn and how deep the weapon still sits with it (m; −Infinity when no hull is in reach). `wedge` false: no wedge search. */
function holdSolve(m: MocapDims, pose: MocapPose, spec: WeaponSpec, hand: Hand, scale: number, prev: Quat | undefined, relax: number, target: number, wedge: boolean): { q: Quat; worst: number } {
  const fr = poseFramesOf(m, pose)
  const wrist = fr[hand === 'L' ? 'wristL' : 'wristR']!
  const qh = pose.G[BONE_INDEX[hand === 'L' ? 'LeftHand' : 'RightHand']]!
  const pm = m.rig.palm[hand]
  const off = qrot(qh, { x: pm.x * m.k, y: pm.y * m.k, z: pm.z * m.k })
  const palm = { x: wrist.p.x + off.x, y: wrist.p.y + off.y, z: wrist.p.z + off.z }
  const R = weaponRotation(spec, hand, { hand: palm, handRot: wrist.r, shoulder: fr[hand === 'L' ? 'shoulderL' : 'shoulderR'].p, torso: fr.torso.r })
  const g = spec.grip
  const pts = rulePoints(spec.assetId)
  const vs = pts.map(({ q }) => {
    const x = (q.x - g.x) * scale
    const y = (q.y - g.y) * scale
    const z = (q.z - g.z) * scale
    return { x: R[0] * x + R[1] * y + R[2] * z, y: R[3] * x + R[4] * y + R[5] * z, z: R[6] * x + R[7] * y + R[8] * z }
  })
  const rs = pts.map((p) => p.r * scale)
  const toHand = (q: Quat): Quat => qnorm(qmul(qmul(qconj(qh), q), qh))
  const toPose = (q: Quat): Quat => qmul(qmul(qh, q), qconj(qh))
  const keep = holderBones(spec, hand)
  // Only the bones whose sphere the weapon's can reach.
  let reach = 0
  for (let i = 0; i < vs.length; i++) reach = Math.max(reach, Math.hypot(vs[i]!.x, vs[i]!.y, vs[i]!.z) + rs[i]!)
  const bones = hulls(m, spec.kind === 'shield').filter((hb) => {
    if (!keep.has(hb.bone)) return false
    const { P, G, s } = placed(hb, pose)
    const c = qrot(G, { x: s.c.x * m.k, y: s.c.y * m.k, z: s.c.z * m.k })
    return Math.hypot(P.x + c.x - palm.x, P.y + c.y - palm.y, P.z + c.z - palm.z) <= reach + s.rho * m.k + NEAR
  })
  const rest = faceOut(spec, pose, palm, wrist.r, R, scale)
  const starts = !wedge && prev ? [qslerp(toPose(prev), rest, relax)] : prev ? [qslerp(toPose(prev), rest, relax), rest, QI] : [rest, QI]
  if (bones.length === 0) return { q: toHand(starts[0]!), worst: -Infinity }
  let best: { q: Quat; worst: number; reach: number } | null = null
  for (const st of starts) {
    // (The on-pose refine never leaves the weapon deeper than the turn it was given: a guard's pose a solve can't clear.)
    const r = solveTurn(m, pose, palm, vs, rs, bones, st, target, !wedge)
    if (!best || r.worst < best.worst - 0.005) best = r
    if (best.worst <= target + 0.005) break
  }
  // (A weapon in the body at the fist — its handle — no turn frees: the arm moves instead, `armClear`.)
  if (wedge && best!.worst > target + 0.005 && best!.reach > WEDGE_REACH) {
    // Wedged (a blade between the legs on a get-up): the weapon's axis swung every which way, the clearest kept, the nearest of those.
    const s0 = starts[0]!
    const a0 = qrot(s0, vs.reduce((a, v) => (v.x * v.x + v.y * v.y + v.z * v.z > a.x * a.x + a.y * a.y + a.z * a.z ? v : a), { x: 0, y: 0, z: 0 }))
    let near = Infinity
    for (const d of AXES) {
      const r = solveTurn(m, pose, palm, vs, rs, bones, qnorm(qmul(qswing(a0, d), s0)), target)
      const off = 1 - Math.abs(r.q[0] * s0[0] + r.q[1] * s0[1] + r.q[2] * s0[2] + r.q[3] * s0[3])
      if (r.worst < best!.worst - 0.005 || (r.worst <= best!.worst + 0.005 && Math.max(r.worst, best!.worst) <= target + 0.005 && off < near)) {
        best = r
        near = off
      }
    }
  }
  return { q: toHand(best!.q), worst: best!.worst }
}

/** A weapon still in the body this far from the palm (m) or nearer is in it at the fist. */
const WEDGE_REACH = 0.12

/** Directions a wedged weapon's axis is tried along: the cube's faces, edges and corners. */
const AXES: V3[] = []
for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++)
    for (let z = -1; z <= 1; z++) {
      const l = Math.hypot(x, y, z)
      if (l > 0) AXES.push({ x: x / l, y: y / l, z: z / l })
    }

/**
 * How deep (m) a weapon turned by `turn` (hand frame) sits in its holder's
 * hulls, the deepest point; −NEAR or less when clear. `within`: only its
 * points that near the grip (m, model).
 */
export function holdDepth(m: MocapDims, pose: MocapPose, spec: WeaponSpec, hand: Hand, scale: number, turn: Quat, within = Infinity): number {
  const fr = poseFramesOf(m, pose)
  const wrist = fr[hand === 'L' ? 'wristL' : 'wristR']!
  const qh = pose.G[BONE_INDEX[hand === 'L' ? 'LeftHand' : 'RightHand']]!
  const pm = m.rig.palm[hand]
  const off = qrot(qh, { x: pm.x * m.k, y: pm.y * m.k, z: pm.z * m.k })
  const palm = { x: wrist.p.x + off.x, y: wrist.p.y + off.y, z: wrist.p.z + off.z }
  const R = weaponRotation(spec, hand, { hand: palm, handRot: wrist.r, shoulder: fr[hand === 'L' ? 'shoulderL' : 'shoulderR'].p, torso: fr.torso.r })
  const g = spec.grip
  const pts = within < Infinity ? rulePoints(spec.assetId).filter(({ q }) => Math.hypot(q.x - g.x, q.y - g.y, q.z - g.z) <= within) : rulePoints(spec.assetId)
  const vs = pts.map(({ q }) => {
    const x = (q.x - g.x) * scale
    const y = (q.y - g.y) * scale
    const z = (q.z - g.z) * scale
    return { x: R[0] * x + R[1] * y + R[2] * z, y: R[3] * x + R[4] * y + R[5] * z, z: R[6] * x + R[7] * y + R[8] * z }
  })
  const keep = holderBones(spec, hand)
  const start = qmul(qmul(qh, turn), qconj(qh))
  // One measure, no turn: the solve's first pass with nothing to fix.
  const r = solveTurn(m, pose, palm, vs, pts.map((p) => p.r * scale), hulls(m, spec.kind === 'shield').filter((hb) => keep.has(hb.bone)), start, Infinity)
  return r.worst
}

/* ------------------------------- on clips -------------------------------- */

interface Curve {
  q: Float64Array
  /** The holding arm's move per frame (shoulder X, shoulder Z, elbow; 3 per frame), or null when the arm never moves. */
  arm: Float64Array | null
}

/** The holding arm moves when a turned weapon still sits this deep in a hull (m) — the fist itself in the body — and until it is this deep. */
const ARM_AT = 0.012
const ARM_TARGET = 0.004
/** The arm's move eases in and out over this many frames either side. */
const ARM_EASE = 5

const armKeys = (hand: Hand): string[] => (hand === 'L' ? ['shoulderLX', 'shoulderLZ', 'elbowL'] : ['shoulderRX', 'shoulderRZ', 'elbowR'])

/**
 * The way the holding arm lifts off the body (shoulder X, shoulder Z, elbow
 * per rad of lift): raised forward and a little out; a negative lift takes
 * it back and in. One way for every pose, so a lift needed on one frame
 * clears its neighbours too as they ease in and out of it.
 */
const LIFT = [-2 / Math.sqrt(5), 1 / Math.sqrt(5), 0]
/** On a clip a run of frames may also lift back and in, straight out to the side, or open the elbow (a hand at the chin, a gun's stock in the chest). */
const WAYS = [LIFT, LIFT.map((v) => -v), [0, 1, 0], [0, 0, -1]]
const ELBOW_WAY = 3
/** The elbow way opens the arm at most to this short of straight (rad). */
const ELBOW_OPEN = 0.1

/** How far the holding elbow is bent on a pose (rad, 0 straight). */
function elbowFlex(pose: MocapPose, hand: Hand): number {
  const s = hand === 'L' ? 'Left' : 'Right'
  const a = pose.P[BONE_INDEX[`${s}Arm` as MocapBone]]!
  const e = pose.P[BONE_INDEX[`${s}ForeArm` as MocapBone]]!
  const w = pose.P[BONE_INDEX[`${s}Hand` as MocapBone]]!
  const u = { x: e.x - a.x, y: e.y - a.y, z: e.z - a.z }
  const v = { x: w.x - e.x, y: w.y - e.y, z: w.z - e.z }
  const c = (u.x * v.x + u.y * v.y + u.z * v.z) / (Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) || 1)
  return Math.acos(Math.min(1, Math.max(-1, c)))
}
/** The most it lifts (rad), and the steps its least lift is looked for in. */
const LIFT_MAX = 1.2
const LIFT_STEP = 0.08

export const liftJoints = (hand: Hand, lift: number): Record<string, number> => Object.fromEntries(armKeys(hand).map((k, i) => [k, LIFT[i]! * lift]))

/**
 * A lift one way (`sign` 1 forward, −1 back): the least past which `depth`
 * (m, of the lift) stays at ARM_TARGET or under — a lift that only grazes
 * clear doesn't count, so the lift follows a pose smoothly while it is
 * needed and any more lift is clear too. Where none clears, the lift that
 * gets it furthest out; `d` is how deep it is then.
 */
function liftWay(depth: (s: number) => number, d0: number, sign: number): { s: number; clear: boolean; d: number } {
  const n = Math.round(LIFT_MAX / LIFT_STEP)
  let best = { s: 0, d: d0 }
  // From the top down: the highest lift still in it, and the least lift past that.
  let i = n
  for (; i >= 1; i--) {
    const d = depth(sign * i * LIFT_STEP)
    if (d < best.d) best = { s: sign * i * LIFT_STEP, d }
    if (d > ARM_TARGET) break
  }
  if (i === n) {
    for (let k = n - 1; k >= 1; k--) {
      const d = depth(sign * k * LIFT_STEP)
      if (d < best.d) best = { s: sign * k * LIFT_STEP, d }
    }
    return { ...best, clear: false }
  }
  let lo = i * LIFT_STEP
  let hi = (i + 1) * LIFT_STEP
  for (let k = 0; k < 10; k++) {
    const mid = (lo + hi) / 2
    if (depth(sign * mid) <= ARM_TARGET) hi = mid
    else lo = mid
  }
  return { s: sign * hi, clear: true, d: ARM_TARGET }
}

/** A way's lift as used: clear, or at least 5 mm better than unlifted (`d0`), else none. */
const liftOf = (w: { s: number; clear: boolean; d: number }, d0: number): number => (w.clear || w.d < d0 - 0.005 ? w.s : 0)

/** The least lift forward, else back (`liftWay`), else the better of the two; 0 when none helps. */
function armLift(depth: (s: number) => number, d0: number): number {
  const fw = liftWay(depth, d0, 1)
  if (fw.clear) return fw.s
  const bw = liftWay(depth, d0, -1)
  if (bw.clear) return bw.s
  return liftOf(bw.d < fw.d ? bw : fw, d0)
}

/**
 * The holding arm's lift per clip frame (a clip overlay) that takes a
 * weapon turned by the curve out of its holder where the fist itself is in
 * the body (a hand on the knee on a get-up): each run of such frames lifts
 * one way (`WAYS`), forward where that clears all of them, else the way that
 * clears the most — back and in, out to the side, or the elbow opened (neighbours easing
 * between two ways would pass through neither). `at[f]`: how deep the
 * turned weapon sits unlifted (the turn's own solve measured it).
 */
function armClear(m: MocapDims, clip: MocapClip, mirror: boolean, spec: WeaponSpec, hand: Hand, scale: number, q: Float64Array, at: Float64Array): { raw: Float64Array; way: Int8Array } {
  const raw = new Float64Array(clip.frames)
  const wayOf = new Int8Array(clip.frames)
  const need = [...at.keys()].filter((f) => at[f]! > ARM_AT)
  if (need.length === 0) return { raw, way: wayOf }
  const keys = armKeys(hand)
  // A lift `s` (≥ 0) along WAYS[w] at frame f: how deep the weapon turned by the curve then sits (the elbow opens no
  // further than ELBOW_OPEN short of straight).
  const depth = (f: number, w: number): ((s: number) => number) => {
    const sample = clipSample(clip, f / clip.fps, mirror)
    const turn: Quat = [q[4 * f]!, q[4 * f + 1]!, q[4 * f + 2]!, q[4 * f + 3]!]
    const cap = w === ELBOW_WAY ? Math.max(0, elbowFlex(clipPose(m, sample), hand) - ELBOW_OPEN) : Infinity
    return (s) => holdDepth(m, clipPose(m, sample, Object.fromEntries(keys.map((k, i) => [k, WAYS[w]![i]! * Math.min(s, cap)]))), spec, hand, scale, turn)
  }
  // Runs of frames within easing reach of each other (round the seam of a loop).
  const runs: number[][] = []
  for (const f of need) {
    const run = runs[runs.length - 1]
    if (run && f - run[run.length - 1]! <= 2 * ARM_EASE) run.push(f)
    else runs.push([f])
  }
  if (clip.loop && runs.length > 1 && runs[0]![0]! + clip.frames - runs[runs.length - 1]!.at(-1)! <= 2 * ARM_EASE) runs[0] = [...runs.pop()!, ...runs[0]!]
  for (const run of runs) {
    const found = WAYS.map(() => new Map<number, ReturnType<typeof liftWay>>())
    const way = (f: number, w: number): ReturnType<typeof liftWay> => {
      let r = found[w]!.get(f)
      if (!r) found[w]!.set(f, (r = liftWay(depth(f, w), at[f]!, 1)))
      return r
    }
    const clears = (w: number): number => run.filter((f) => way(f, w).clear).length
    // Forward where that clears every frame of the run, else the way that clears the most (forward, back, out, elbow on a tie).
    let best = 0
    let most = clears(0)
    for (let w = 1; w < WAYS.length && most < run.length; w++) {
      // (A shield rides the forearm: opening the elbow swings its disc through the body.)
      if (w === ELBOW_WAY && spec.kind === 'shield') continue
      const n = clears(w)
      if (n > most) {
        best = w
        most = n
      }
    }
    for (const f of run) {
      raw[f] = liftOf(way(f, best), at[f]!)
      if (best === ELBOW_WAY) raw[f] = Math.min(raw[f]!, Math.max(0, elbowFlex(clipPose(m, clipSample(clip, f / clip.fps, mirror)), hand) - ELBOW_OPEN))
      wayOf[f] = best
    }
  }
  return { raw, way: wayOf }
}

const CURVES = new WeakMap<object, { version: number; byKey: Map<string, Curve> }>()

/** The hold turn per frame of a clip (on the clip pose, its arm lifted where it lifts), followed frame to frame; a loop goes round twice so its seam matches. */
function clipCurve(m: MocapDims, clipId: string, mirror: boolean, spec: WeaponSpec, hand: Hand, scale: number): Curve | null {
  const clip = mocapClip(clipId)
  if (!clip) return null
  let byRig = CURVES.get(m.rig)
  if (!byRig || byRig.version !== mocapClipVersion()) {
    byRig = { version: mocapClipVersion(), byKey: new Map() }
    CURVES.set(m.rig, byRig)
  }
  const key = `${m.k}|${clipId}|${mirror ? 1 : 0}|${spec.assetId}|${hand}|${scale}`
  let curve = byRig.byKey.get(key)
  if (!curve) {
    const q = new Float64Array(4 * clip.frames)
    const passes = clip.loop ? 2 : 1
    const at = new Float64Array(clip.frames)
    const lifted = new Float64Array(clip.frames)
    const keys = armKeys(hand)
    // The turn followed frame to frame, on each frame's pose with the arm moved by `arm` (none, then the move found).
    const follow = (lift: Float64Array | null): void => {
      let prev = QI
      for (let pass = 0; pass < passes; pass++) {
        for (let f = 0; f < clip.frames; f++) {
          const moved = !!lift && (lift[3 * f] !== 0 || lift[3 * f + 1] !== 0 || lift[3 * f + 2] !== 0)
          const pose = clipPose(m, clipSample(clip, f / clip.fps, mirror), moved ? Object.fromEntries(keys.map((k, i) => [k, lift![3 * f + i]!])) : undefined)
          const r = holdSolve(m, pose, spec, hand, scale, f === 0 && pass === 0 ? undefined : prev, RELAX, TARGET, true)
          prev = r.q
          q.set(prev, 4 * f)
          if (!lift) at[f] = r.worst
          else lifted[f] = r.worst
        }
      }
    }
    follow(null)
    const { raw, way } = armClear(m, clip, mirror, spec, hand, scale, q, at)
    // Each frame's lift: the largest of its neighbours' eased by their distance (wrapping round a loop), the way of that
    // neighbour's run (runs further apart than the easing never meet).
    let arm: Float64Array | null = null
    if (raw.some((x) => x !== 0)) {
      arm = new Float64Array(3 * clip.frames)
      for (let f = 0; f < clip.frames; f++) {
        let best = 0
        let w = 0
        for (let k = -ARM_EASE; k <= ARM_EASE; k++) {
          const g = clip.loop ? (((f + k) % clip.frames) + clip.frames) % clip.frames : f + k
          if (g < 0 || g >= clip.frames) continue
          const v = raw[g]! * (0.5 + 0.5 * Math.cos((Math.PI * k) / (ARM_EASE + 1)))
          if (v > best) {
            best = v
            w = way[g]!
          }
        }
        for (let i = 0; i < 3; i++) arm[3 * f + i] = WAYS[w]![i]! * best
      }
      // The turn again on the lifted poses: a lift eased in from a neighbour moves the hand, and the bare pose's turn
      // could carry the weapon into the body there.
      follow(arm)
      // A lift eased in from a neighbour can move the hand where the bare pose was clear (a dance step, the end of a
      // swing): a frame its lift leaves in the body gets the lift scaled back to the most a solve clears (none at the
      // least), then the turn is followed again.
      let cut = false
      for (let f = 0; f < clip.frames; f++) {
        if (lifted[f]! <= ARM_AT || (arm[3 * f] === 0 && arm[3 * f + 1] === 0 && arm[3 * f + 2] === 0)) continue
        const g = f > 0 ? f - 1 : clip.loop ? clip.frames - 1 : -1
        const prev: Quat | undefined = g < 0 ? undefined : [q[4 * g]!, q[4 * g + 1]!, q[4 * g + 2]!, q[4 * g + 3]!]
        const sample = clipSample(clip, f / clip.fps, mirror)
        let pick = 1
        let d = lifted[f]!
        for (const c of [0.75, 0.5, 0.25, 0]) {
          const pose = clipPose(m, sample, c > 0 ? Object.fromEntries(keys.map((k, i) => [k, arm![3 * f + i]! * c])) : undefined)
          const r = holdSolve(m, pose, spec, hand, scale, prev, RELAX, TARGET, true)
          if (r.worst < d - 0.005) {
            pick = c
            d = r.worst
          }
          if (d <= ARM_AT) break
        }
        if (pick < 1) {
          for (let i = 0; i < 3; i++) arm[3 * f + i] = arm[3 * f + i]! * pick
          cut = true
        }
      }
      if (cut) follow(arm)
    }
    curve = { q, arm }
    byRig.byKey.set(key, curve)
  }
  return curve
}

/** A clip's hold turn at clip time `t` (looping or clamped as `clipSample` reads it). */
function clipTurn(m: MocapDims, clipId: string, t: number, mirror: boolean, spec: WeaponSpec, hand: Hand, scale: number): Quat {
  const clip = mocapClip(clipId)
  const curve = clip && clipCurve(m, clipId, mirror, spec, hand, scale)
  if (!clip || !curve) return QI
  const dur = clip.duration
  const tt = dur > 0 ? (clip.loop ? t - Math.floor(t / dur) * dur : Math.min(dur, Math.max(0, t))) : 0
  const last = clip.frames - 1
  const f = Math.min(last, tt * clip.fps)
  const i = Math.min(Math.floor(f), Math.max(0, last - 1))
  const j = Math.min(i + 1, last)
  const at = (k: number): Quat => [curve.q[4 * k]!, curve.q[4 * k + 1]!, curve.q[4 * k + 2]!, curve.q[4 * k + 3]!]
  return j > i ? qslerp(at(i), at(j), f - i) : at(i)
}

/** A clip's arm move at clip time `t` (interpolated between its frames), or null. */
function clipArm(m: MocapDims, clipId: string, t: number, mirror: boolean, spec: WeaponSpec, hand: Hand, scale: number): number[] | null {
  const clip = mocapClip(clipId)
  const curve = clip && clipCurve(m, clipId, mirror, spec, hand, scale)
  if (!clip || !curve?.arm) return null
  const dur = clip.duration
  const tt = dur > 0 ? (clip.loop ? t - Math.floor(t / dur) * dur : Math.min(dur, Math.max(0, t))) : 0
  const last = clip.frames - 1
  const f = Math.min(last, tt * clip.fps)
  const i = Math.min(Math.floor(f), Math.max(0, last - 1))
  const j = Math.min(i + 1, last)
  const u = j > i ? f - i : 0
  const out = [0, 1, 2].map((c) => curve.arm![3 * i + c]! + (curve.arm![3 * j + c]! - curve.arm![3 * i + c]!) * u)
  return out.some((v) => v !== 0) ? out : null
}

/**
 * The holding arm's move (joint channels, a clip overlay) that takes a bot's
 * weapon off its holder where the clip's own fist is in the body, or null:
 * not a bot, not on a clip, or no move. A crossfade blends both sides'.
 */
export function holdArm(dims: PersonDims, clip: ClipState | undefined, spec: WeaponSpec, hand: Hand, scale: number): Record<string, number> | null {
  const m = dims.mocap
  if (!m || !clip || !mocapClip(clip.id)) return null
  const w = Math.min(1, Math.max(0, clip.w ?? 1))
  const to = clipArm(m, clip.id, clip.t, !!clip.mirror, spec, hand, scale)
  const from = w < 1 && clip.from && mocapClip(clip.from.id) ? clipArm(m, clip.from.id, clip.from.t, !!clip.from.mirror, spec, hand, scale) : null
  if (!to && !from) return null
  const keys = armKeys(hand)
  return Object.fromEntries(keys.map((k, i) => [k, (from?.[i] ?? 0) * (1 - w) + (to?.[i] ?? 0) * w]))
}

/* ------------------------------ the rig pose ------------------------------ */

/** Rig-pose turns remembered (a pure function of the joints; cleared when full). */
const RIG_CACHE = 512
const RIG = new WeakMap<object, Map<string, Quat>>()
/** Turns measured on a clip pose under an overlay, remembered the same way (a fight asks for the same states again and again). */
const ON_POSE_TURNS = new WeakMap<object, Map<string, Quat>>()

const jointsKey = (joints: Record<string, number> | undefined): string =>
  joints ? Object.keys(joints).sort().filter((k) => joints[k] !== 0).map((k) => `${k}:${joints[k]}`).join(',') : ''

function rigTurn(m: MocapDims, joints: Record<string, number> | undefined, spec: WeaponSpec, hand: Hand, scale: number): Quat {
  let byRig = RIG.get(m.rig)
  if (!byRig) {
    byRig = new Map()
    RIG.set(m.rig, byRig)
  }
  const key = `${m.k}|${spec.assetId}|${hand}|${scale}|${jointsKey(joints)}`
  let q = byRig.get(key)
  if (!q) {
    q = poseHoldTurn(m, mocapPose(m, jointLocals(joints)), spec, hand, scale)
    if (byRig.size >= RIG_CACHE * 8) byRig.clear()
    byRig.set(key, q)
  }
  return q
}

/* --------------------------- the arm off the body -------------------------- */

/** On the keyframe rig only the weapon this near the grip counts for the arm's move (m, model): the fist and the handle beside it, which no turn frees. */
const FIST = 0.12

const withArm = (joints: Record<string, number> | undefined, arm: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = { ...joints }
  for (const [k, v] of Object.entries(arm)) out[k] = (out[k] ?? 0) + v
  return out
}

/** Rig lifts remembered, by rig (pure functions of their inputs; cleared when full). */
const LIFTS = new WeakMap<object, Map<string, number>>()

/**
 * The holding arm's lift (rad along LIFT; `liftJoints` makes it joints) for
 * a bot on the keyframe rig whose fist is in its own body (a bow brings it
 * to the thigh), or 0: the least lift (`armLift`) that takes the weapon by
 * the fist out of it. A motion eases it in and out (`easedRigLift`).
 */
export function rigLift(dims: PersonDims, joints: Record<string, number> | undefined, spec: WeaponSpec, hand: Hand, scale: number): number {
  const m = dims.mocap
  if (!m) return 0
  let byRig = LIFTS.get(m.rig)
  if (!byRig) {
    byRig = new Map()
    LIFTS.set(m.rig, byRig)
  }
  const key = `${m.k}|${spec.assetId}|${hand}|${scale}|${jointsKey(joints)}`
  let lift = byRig.get(key)
  if (lift === undefined) {
    // The fist on the grip alone (the turn about the palm is made again on the lifted pose; measured with it, a lift would jump as it flips).
    const depth = (s: number): number => holdDepth(m, mocapPose(m, jointLocals(withArm(joints, liftJoints(hand, s)))), spec, hand, scale, QI, FIST)
    const d0 = depth(0)
    lift = d0 > ARM_TARGET ? armLift(depth, d0) : 0
    if (byRig.size >= RIG_CACHE * 8) byRig.clear()
    byRig.set(key, lift)
  }
  return lift
}

/** The rig lift eases in and out over this long (s) either side of the poses that need it, looked at on a 24 fps grid. */
const RIG_EASE = 0.25
const RIG_FPS = 24

/**
 * A bot's rig lift at time `t` eased in and out (the evaluator is a pure
 * state(t), so it looks ahead): the largest of the lifts on the 24 fps grid
 * within RIG_EASE of `t` (`raw(n)`, the lift at n / 24 s), each weighted by a
 * cosine of its distance; with `own` (the lift at `t` itself) and only the
 * lifts the same way as it when it has one, so the pose stays clear.
 */
export function easedRigLift(t: number, own: number, raw: (n: number) => number): number {
  let best = own
  for (let n = Math.ceil((t - RIG_EASE) * RIG_FPS); n <= Math.floor((t + RIG_EASE) * RIG_FPS); n++) {
    const s = raw(n)
    if (s === 0 || (own !== 0 && Math.sign(s) !== Math.sign(own))) continue
    const v = s * (0.5 + 0.5 * Math.cos((Math.PI * (n / RIG_FPS - t)) / RIG_EASE))
    if (Math.abs(v) > Math.abs(best)) best = v
  }
  return best
}

/** Gaits whose loop a bot plays as is when holding a weapon (`holdLoop`): not a stand (the hold pose on the keyframe rig) nor a travelling gait (its weapon arm steadied). */
const OWN_ARM_GAITS = new Set(['crouch', 'sit', 'lie', 'fall'])

/**
 * The loop clip an armed bot plays as is on a gait (a crouch, the crouched
 * walk, a sit, lying down: the loop's own arms hold the weapon, as a mark
 * clip's do; the standing hold pose would put it in the body), or undefined
 * (any other gait, or no loop in the library).
 */
export function holdLoop(assetId: string, gait: string, speed: number, seated = false): string | undefined {
  return OWN_ARM_GAITS.has(gait) ? gaitClipId(assetId, gait as GaitId, speed, seated) : undefined
}

/**
 * The holding arm's move on such a loop at a moment (`gaitPose`'s clip
 * time, from the distance in rig metres and the time): the clip's arm move
 * (`holdArm`), or null.
 */
export function loopArm(dims: PersonDims, assetId: string, loopId: string, distance: number, time: number, spec: WeaponSpec, hand: Hand, scale: number): Record<string, number> | null {
  const m = dims.mocap
  const clip = mocapClip(loopId)
  if (!m || !clip) return null
  return holdArm(dims, { id: loopId, t: gaitClipTime(clip, clipWarp(m, clip, assetId), distance, time) }, spec, hand, scale)
}

/**
 * The hold turn of a bot's weapon (hand frame), or null when there is none:
 * not a bot, or the weapon is clear. On a clip, the clip's curve (crossfaded
 * with the side it comes from), measured again on the pose when a joint
 * overlay or a crossfade makes it other than the bare clip (`onPose` false
 * skips that: a solve of the overlay itself, which keeps the weapon off its
 * holder on its own); off a clip, the rig pose's.
 */
export function holdTurn(dims: PersonDims, joints: Record<string, number> | undefined, clip: ClipState | undefined, spec: WeaponSpec, hand: Hand, scale: number, onPose = true): Quat | null {
  const m = dims.mocap
  if (!m) return null
  let q: Quat
  if (clip && mocapClip(clip.id)) {
    q = clipTurn(m, clip.id, clip.t, !!clip.mirror, spec, hand, scale)
    const w = Math.min(1, Math.max(0, clip.w ?? 1))
    if (w < 1) {
      const from = clip.from && mocapClip(clip.from.id) ? clipTurn(m, clip.from.id, clip.from.t, !!clip.from.mirror, spec, hand, scale) : rigTurn(m, joints, spec, hand, scale)
      q = qslerp(from, q, w)
    }
    // A pose that isn't the bare clip (a joint overlay, a crossfade): the turn measured on it, from the curve's.
    if (onPose && (w < 1 || (joints && Object.values(joints).some((v) => v !== 0)))) {
      let byRig = ON_POSE_TURNS.get(m.rig)
      if (!byRig) {
        byRig = new Map()
        ON_POSE_TURNS.set(m.rig, byRig)
      }
      const key = `${m.k}|${spec.assetId}|${hand}|${scale}|${clip.id}|${clip.t}|${clip.mirror ? 1 : 0}|${w}|${clip.from ? `${clip.from.id}|${clip.from.t}|${clip.from.mirror ? 1 : 0}` : ''}|${jointsKey(joints)}`
      let r = byRig.get(key)
      if (!r) {
        // From the curve's turn alone, no wedge search: the overlay placed the weapon (a guard, a swing), so it is only nudged.
        r = holdSolve(m, botPose(m, joints, clip), spec, hand, scale, q, 0, ON_POSE, false).q
        if (byRig.size >= RIG_CACHE * 8) byRig.clear()
        byRig.set(key, r)
      }
      q = r
    }
  } else q = rigTurn(m, joints, spec, hand, scale)
  return q[3] > 1 - 1e-12 ? null : q
}

/** A weapon's rotation (model → holder space) with a hold turn of its hand frame: `r` turned about the hand by `turn`. */
export function turnedRotation(r: M3, handRot: M3, turn: Quat | null): M3 {
  if (!turn) return r
  const c = qtoM3(turn)
  const h = handRot
  // handRot · c · handRotᵀ · r
  const hc: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) hc[3 * i + j] = h[3 * i]! * c[j]! + h[3 * i + 1]! * c[3 + j]! + h[3 * i + 2]! * c[6 + j]!
  const hct: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) hct[3 * i + j] = hc[3 * i]! * h[3 * j]! + hc[3 * i + 1]! * h[3 * j + 1]! + hc[3 * i + 2]! * h[3 * j + 2]!
  const out: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[3 * i + j] = hct[3 * i]! * r[j]! + hct[3 * i + 1]! * r[3 + j]! + hct[3 * i + 2]! * r[6 + j]!
  return out as M3
}

/**
 * A held weapon's rotation (model → holder space) on a hand frame: the
 * grip's (`weaponRotation`), turned by the bot's hold rule. Exactly
 * `weaponRotation` for everyone but a bot.
 */
export function heldRotation(dims: PersonDims, joints: Record<string, number> | undefined, hand: Hand, spec: WeaponSpec, scale: number, clip: ClipState | undefined, f: HandFrame, onPose = true): M3 {
  const r = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder, torso: f.torso })
  return dims.mocap ? turnedRotation(r, f.r, holdTurn(dims, joints, clip, spec, hand, scale, onPose)) : r
}

export { m3toQ }
