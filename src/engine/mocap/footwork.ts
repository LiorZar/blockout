/**
 * Bot footwork (fork addition, qa-fixes; see MODIFICATIONS.md): a bot's feet
 * step instead of sliding where its marks carry the root further, or turn
 * it more, than its clips do (a fight's step-in, rest walk, stagger or
 * push). A clip keeps its feet planted under its own root travel; travel
 * past it would drag the planted feet along. The evaluator finds those
 * windows (`clip-marks.ts` `clipStateAt`) and hands the pose the travel and
 * turn done and in all (`ClipState.step`); `plantFeet` (at the end of
 * `mocapClipPose`, so the engine and the renderer agree) keeps each
 * grounded foot where it stood and steps it to its new spot in turn: the
 * window's lead foot first (the evaluator's pick: the front foot, or the
 * one on the side it goes), `n` steps each, lifted. On a
 * crossfade between two clips each foot steps from the first clip's spot
 * to the second's instead of sliding there (a stance switch). Two-bone leg
 * IK with the knee in its own plane (`seat.ts`'s), the hips sinking a few
 * centimetres where a step needs the reach; the torso and arms stay the
 * clip's, and so does a foot off the floor (a kick) or a body that isn't
 * standing (a fall).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { smoothstep } from '../easing'
import type { ClipStep, V3 } from '../types'
import type { MocapDims, MocapPose } from './fk'
import { qmul, qrot, qslerp, qswing, vadd, vdot, vlen, vscale, vsub, type Quat } from './quat'
import { BONE_INDEX } from './rig'

const I = BONE_INDEX

/** The most one step of a foot covers (m). */
export const MAX_STEP = 0.4

/** How high a step lifts the foot (m): a share of the step, at most LIFT, at least LIFT_MIN once it is a step. */
const LIFT = 0.08
const LIFT_MIN = 0.035
const LIFT_SHARE = 0.35

/** A foot this far over its rest height or less is on the floor; this far or more, off it (m). */
const GROUNDED = 0.05
const AIRBORNE = 0.15

/** The hips this share of their rest height or less: not standing; this share or more: standing. */
export const LOW = 0.6
const UP = 0.8

/** A leg that has to reach keeps this share of its length (a little bend); the hips sink at most DROP (m) for a step's reach. */
const REACH = 0.995
const DROP = 0.08

/** The legs' thigh, shin, foot and toe bones. */
const LEGS = [
  [I.LeftUpLeg, I.LeftLeg, I.LeftFoot, I.LeftToeBase],
  [I.RightUpLeg, I.RightLeg, I.RightFoot, I.RightToeBase]
] as const

/** A turn about the vertical, the way a heading turns the body. */
const yaw = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)]

const lerpV = (a: V3, b: V3, u: number): V3 => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u })

/**
 * A foot's progress over its steps at window progress `s`: the window splits
 * into 2n turns, the lead foot (q 0) stepping on the even ones, the other on
 * the odd ones. `sigma` is the share of its way it has gone (eased within a
 * step, most of the way while lifted), `lift` how far into a step it is
 * (−1 between steps).
 */
export function footProgress(s: number, n: number, q: 0 | 1): { sigma: number; lift: number } {
  const x = Math.min(1, Math.max(0, s)) * 2 * n
  let sigma = 0
  let lift = -1
  for (let k = 0; k < n; k++) {
    const f = Math.min(1, Math.max(0, x - (2 * k + q)))
    sigma += smoothstep((f - 0.1) / 0.8) / n
    if (f > 0 && f < 1) lift = f
  }
  return { sigma, lift }
}

/** How much a pose stands (0 lying or kneeling … 1 on its feet), by its hips' height. */
function standing(m: MocapDims, pose: MocapPose): number {
  const rest = m.rig.rest[I.Hips]!.y * m.k
  return smoothstep((pose.P[I.Hips]!.y / rest - LOW) / (UP - LOW))
}

/** How much a foot of a pose is on the floor (1) or off it (0): its ankle or toe over its rest height. */
function grounded(m: MocapDims, pose: MocapPose, foot: number, toe: number): number {
  const h = Math.min(pose.P[foot]!.y - m.rig.rest[foot]!.y * m.k, pose.P[toe]!.y - m.rig.rest[toe]!.y * m.k)
  return 1 - smoothstep((h - GROUNDED) / (AIRBORNE - GROUNDED))
}

const FOOT_POINTS = new WeakMap<MocapDims['rig'], MocapDims['rig']['points'][]>()

/** The lowest point of a foot (q 0 left, 1 right; its foot and toe bones' support points) with its ankle at `ankle`, the foot and toe turned `gFoot`, `gToe`. */
function footLowY(m: MocapDims, q: 0 | 1, ankle: V3, gFoot: Quat, gToe: Quat): number {
  let pts = FOOT_POINTS.get(m.rig)
  if (!pts) {
    pts = LEGS.map(([, , foot, toe]) => m.rig.points.filter((pt) => pt.bone === foot || pt.bone === toe))
    FOOT_POINTS.set(m.rig, pts)
  }
  const [, , foot, toe] = LEGS[q]!
  const toeAt = vadd(ankle, qrot(gFoot, vscale(m.rig.offset[toe]!, m.k)))
  let low = Infinity
  for (const pt of pts[q]!) low = Math.min(low, pt.bone === foot ? ankle.y + qrot(gFoot, vscale(pt.off, m.k)).y : toeAt.y + qrot(gToe, vscale(pt.off, m.k)).y)
  return low
}

/** Turn a leg (thigh, shin) so its ankle is at T (or as near as the leg reaches, along the floor), the foot and toe at their rotations. */
function reachLeg(G: Quat[], P: V3[], leg: (typeof LEGS)[number], T: V3, gFoot: Quat, gToe: Quat): void {
  const [thigh, shin, foot, toe] = leg
  const H = P[thigh]!
  const K = P[shin]!
  const A = P[foot]!
  const L1 = vlen(vsub(K, H))
  const L2 = vlen(vsub(A, K))
  const reach = Math.max((L1 + L2) * REACH, vlen(vsub(A, H)))
  let target = T
  if (vlen(vsub(T, H)) > reach) {
    // Out of reach: the foot comes in along the floor toward the point under the hip.
    const flat = Math.sqrt(Math.max(0, reach * reach - (H.y - T.y) ** 2))
    const out = Math.hypot(T.x - H.x, T.z - H.z)
    target = out > 1e-9 ? { x: H.x + ((T.x - H.x) * flat) / out, y: T.y, z: H.z + ((T.z - H.z) * flat) / out } : { x: H.x, y: T.y, z: H.z }
  }
  const span = vsub(target, H)
  const D = Math.max(1e-9, Math.min(vlen(span), L1 + L2))
  const u = vscale(span, 1 / (vlen(span) || 1))
  // The knee bends the way it did: off the hip–ankle line toward where it was.
  const v = vsub(K, H)
  let b = vsub(v, vscale(u, vdot(v, u)))
  if (vlen(b) < 1e-9) b = vsub({ x: 0, y: 0, z: -1 }, vscale(u, -u.z))
  b = vscale(b, 1 / (vlen(b) || 1))
  const a = (L1 * L1 - L2 * L2 + D * D) / (2 * D)
  const K2 = vadd(H, vadd(vscale(u, a), vscale(b, Math.sqrt(Math.max(0, L1 * L1 - a * a)))))
  const A2 = vadd(H, vscale(u, D))
  G[thigh] = qmul(qswing(v, vsub(K2, H)), G[thigh]!)
  G[shin] = qmul(qswing(vsub(A, K), vsub(A2, K2)), G[shin]!)
  G[foot] = gFoot
  G[toe] = gToe
}

/**
 * A grounded pose with its feet stepping over a window (`step`; see the
 * module header): its rig rotations and hips (lowered a little where a
 * step needs the reach), or null when no foot moves. `ends`, on a
 * crossfade, are the two clips' grounded poses it blends: each foot steps
 * from one's spot to the other's. The caller chains the pose from them.
 */
export function plantFeet(m: MocapDims, pose: MocapPose, step: ClipStep, ends?: { a: MocapPose; b: MocapPose }): { G: Quat[]; hips: V3 } | null {
  const stand = standing(m, pose)
  if (stand <= 0) return null
  const E = { x: step.E.x, y: 0, z: step.E.z }
  const travel = Math.hypot(E.x, E.z)
  const a = ends?.a ?? pose
  const b = ends?.b ?? pose
  const g = LEGS.map(([, , foot, toe]) => Math.min(grounded(m, a, foot, toe), grounded(m, b, foot, toe)) * stand)
  const P = pose.P
  const feet = ([0, 1] as const).map((q) => {
    const [, , foot, toe] = LEGS[q]
    const { sigma, lift } = footProgress(step.s, step.n, q === step.lead ? 0 : 1)
    const turn = yaw(sigma * step.A - step.a)
    const base = ends ? lerpV(a.P[foot]!, b.P[foot]!, sigma) : P[foot]!
    const T = vadd(qrot(turn, base), { x: sigma * E.x - step.e.x, y: 0, z: sigma * E.z - step.e.z })
    // This step's height: a share of its length (its share of the travel and turn, and of the way between the clips' spots), none while the other foot is off the floor.
    let up = 0
    if (lift >= 0) {
      const len = (travel + Math.abs(step.A) * Math.hypot(base.x, base.z) + (ends ? vlen(vsub(b.P[foot]!, a.P[foot]!)) : 0)) / step.n
      up = (len > 0.02 ? Math.min(LIFT, Math.max(LIFT_MIN, LIFT_SHARE * len)) : 0) * Math.sin(Math.PI * lift) * g[q === 0 ? 1 : 0]!
    }
    const gFoot = qmul(turn, ends ? qslerp(a.G[foot]!, b.G[foot]!, sigma) : pose.G[foot]!)
    const gToe = qmul(turn, ends ? qslerp(a.G[toe]!, b.G[toe]!, sigma) : pose.G[toe]!)
    return { foot, toe, sigma, T, up, gFoot, gToe }
  })
  // While one foot is up, the other stands on the floor (a light-footed clip holds it a little off it).
  const press = ([0, 1] as const).map((q) => {
    const other = feet[q === 0 ? 1 : 0]!
    if (other.up <= 0) return 0
    const own = feet[q]!
    return Math.max(0, footLowY(m, q, own.T, own.gFoot, own.gToe)) * Math.min(1, other.up / LIFT_MIN)
  })
  const aims = ([0, 1] as const).map((q) => {
    if (g[q]! <= 0) return null
    const { foot, sigma, up, gFoot, gToe } = feet[q]!
    let T = { ...feet[q]!.T, y: feet[q]!.T.y + up - press[q]! }
    T = lerpV(P[foot]!, T, g[q]!)
    // At a window's ends the foot is where the clip has it.
    if (vlen(vsub(T, P[foot]!)) < 1e-9 && Math.abs(sigma * step.A - step.a) < 1e-9 && (!ends || sigma === 1 || sigma === 0)) return null
    return { T, gFoot: qslerp(pose.G[foot]!, gFoot, g[q]!), gToe: qslerp(pose.G[feet[q]!.toe]!, gToe, g[q]!) }
  })
  if (!aims[0] && !aims[1]) return null
  // A step further than the leg reaches from where the clip holds the hips: the hips sink into it (a bent knee), up
  // to DROP; not while a foot is off the floor (a kick lands where the clip has it).
  let drop = 0
  aims.forEach((aim, q) => {
    if (!aim || Math.min(g[0]!, g[1]!) < 1) return
    const [thigh, shin, foot] = LEGS[q]!
    const H = P[thigh]!
    const reach = Math.max((vlen(vsub(P[shin]!, H)) + vlen(vsub(P[foot]!, P[shin]!))) * REACH, vlen(vsub(P[foot]!, H)))
    const out = Math.hypot(aim.T.x - H.x, aim.T.z - H.z)
    if (out < reach) drop = Math.max(drop, H.y - aim.T.y - Math.sqrt(reach * reach - out * out))
  })
  drop = Math.min(DROP, drop)
  const Pd = drop > 0 ? P.map((p) => ({ x: p.x, y: p.y - drop, z: p.z })) : P
  const G = [...pose.G]
  aims.forEach((aim, q) => {
    if (aim) reachLeg(G, Pd, LEGS[q]!, aim.T, aim.gFoot, aim.gToe)
  })
  return { G, hips: Pd[I.Hips]! }
}
