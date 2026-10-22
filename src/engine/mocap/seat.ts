/**
 * Mocap seats (fork addition, mocap-backlog; see MODIFICATIONS.md): a bot's
 * sit on a seat prop at the prop's height. A clip's sit rests the hips at
 * the height its take was captured on (~0.4 m); `seatLift` raises them onto
 * a higher seat top and turns each leg (thigh and shin, the knee in its own
 * plane) so the feet keep their spot on the floor. A foot the leg can't
 * reach slides toward the point under its hip. The seat stops the buttocks
 * as a real one does: nothing changes while they are above it, so a
 * stand-to-sit comes down onto it. A seat lower than the clip's isn't sat
 * down onto.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { V3 } from '../types'
import type { MocapDims, MocapPose } from './fk'
import { qmul, qrot, qswing, vadd, vdot, vlen, vscale, vsub, type Quat } from './quat'
import { BONE_INDEX, type MocapRig } from './rig'

const I = BONE_INDEX

/** A thigh's support points this far down it (0 hip … 1 knee) or less sit on the seat. */
const SEAT_SPAN = 0.5

/** A leg that has to reach keeps this share of its length (a little bend). */
const REACH = 0.995

/** The legs' thigh, shin, foot and toe bones. */
const LEGS = [
  [I.LeftUpLeg, I.LeftLeg, I.LeftFoot, I.LeftToeBase],
  [I.RightUpLeg, I.RightLeg, I.RightFoot, I.RightToeBase]
] as const

const SEAT_POINTS = new WeakMap<MocapRig, MocapRig['points']>()

/** The support points a bot sits on: the hips and the upper half of each thigh. */
function seatPoints(rig: MocapRig): MocapRig['points'] {
  let pts = SEAT_POINTS.get(rig)
  if (!pts) {
    const knee: Partial<Record<number, V3>> = { [I.LeftUpLeg]: rig.offset[I.LeftLeg]!, [I.RightUpLeg]: rig.offset[I.RightLeg]! }
    pts = rig.points.filter((pt) => {
      if (pt.bone === I.Hips) return true
      const k = knee[pt.bone]
      return !!k && vdot(pt.off, k) / vdot(k, k) <= SEAT_SPAN
    })
    SEAT_POINTS.set(rig, pts)
  }
  return pts
}

function lowOf(m: MocapDims, pose: MocapPose, pts: MocapRig['points']): number {
  let low = Infinity
  for (const pt of pts) low = Math.min(low, pose.P[pt.bone]!.y + qrot(pose.G[pt.bone]!, vscale(pt.off, m.k)).y)
  return low
}

/** Where a posed bot sits: the lowest point of its hips and upper thighs (entity metres). */
export function seatContactY(m: MocapDims, pose: MocapPose): number {
  return lowOf(m, pose, seatPoints(m.rig))
}

/** The lowest surface point of one bone of a pose (its support points). */
export function boneLowY(m: MocapDims, pose: MocapPose, bone: number): number {
  return lowOf(
    m,
    pose,
    m.rig.points.filter((pt) => pt.bone === bone)
  )
}

/** The pose with its hips `d` higher and each leg turned so its foot stays put (or reaches the floor nearest it). */
function liftBy(pose: MocapPose, d: number): MocapPose {
  const up = { x: 0, y: d, z: 0 }
  const G = [...pose.G]
  const P = pose.P.map((p) => vadd(p, up))
  for (const [thigh, shin, foot, toe] of LEGS) {
    const H0 = pose.P[thigh]!
    const H = P[thigh]!
    const K = pose.P[shin]!
    const A = pose.P[foot]!
    const L1 = vlen(vsub(K, H0))
    const L2 = vlen(vsub(A, K))
    // The foot where it was, or slid along the floor toward the point under the hip until the leg reaches it.
    let T = A
    const reach = (L1 + L2) * REACH
    if (vlen(vsub(A, H)) > reach) {
      const flat = Math.sqrt(Math.max(0, reach * reach - (H.y - A.y) ** 2))
      const out = Math.hypot(A.x - H.x, A.z - H.z)
      T = out > 1e-9 ? { x: H.x + ((A.x - H.x) * flat) / out, y: A.y, z: H.z + ((A.z - H.z) * flat) / out } : { x: H.x, y: A.y, z: H.z }
    }
    const span = vsub(T, H)
    const D = Math.max(1e-9, Math.min(vlen(span), L1 + L2))
    const u = vscale(span, 1 / (vlen(span) || 1))
    // The knee bends the way it did: off the hip–foot line toward where it was.
    const v = vsub(K, H0)
    let b = vsub(v, vscale(u, vdot(v, u)))
    if (vlen(b) < 1e-9) b = vsub({ x: 0, y: 0, z: -1 }, vscale(u, -u.z))
    b = vscale(b, 1 / (vlen(b) || 1))
    const a = (L1 * L1 - L2 * L2 + D * D) / (2 * D)
    const K2 = vadd(H, vadd(vscale(u, a), vscale(b, Math.sqrt(Math.max(0, L1 * L1 - a * a)))))
    const A2 = vadd(H, vscale(u, D))
    G[thigh] = qmul(qswing(v, vsub(K2, H)), G[thigh]!)
    G[shin] = qmul(qswing(vsub(A, K), vsub(A2, K2)), G[shin]!)
    P[shin] = K2
    P[foot] = A2
    P[toe] = vadd(A2, vsub(pose.P[toe]!, A))
  }
  return { P, G }
}

/**
 * A grounded pose sat on a seat top `seat` (metres over its root): its rig
 * rotations and hips, the hips lifted until their lowest point is on the
 * seat (the legs turn as they rise, so a few steps), the feet put; null
 * when the hips are on or above the seat.
 */
export function seatLift(m: MocapDims, pose: MocapPose, seat: number): { G: Quat[]; hips: V3 } | null {
  let d = seat - seatContactY(m, pose)
  if (!(d > 1e-6)) return null
  let lifted = liftBy(pose, d)
  for (let k = 0; k < 4; k++) {
    const miss = seat - seatContactY(m, lifted)
    if (Math.abs(miss) < 1e-4) break
    d += miss
    lifted = liftBy(pose, d)
  }
  return { G: lifted.G, hips: lifted.P[I.Hips]! }
}
