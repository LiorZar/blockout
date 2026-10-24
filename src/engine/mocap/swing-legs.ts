/**
 * Beat legs over a travelling loop (fork addition, chase-feet; see
 * MODIFICATIONS.md). A keyframe beat riding a bot's travelling loop (the
 * chase's vault, skid and stumble, `chase-tracks.ts` `ride`) adds its hip and
 * knee channels on top of the loop's legs, and on a planted foot that moved
 * the foot over the floor (17–37 cm in QA's chase): the loop keeps a planted
 * foot put only with its own legs. Here the bot shows the beat's pose as
 * before (its crouch, torso, arms, a swinging leg's tuck), but each foot goes
 * where the loop has it (the loop's foot under the beat's other channels) as
 * far as that foot is on the floor: all the way while the loop has it down,
 * so it stays where the loop plants it, none once it swings SWING_UP clear
 * (or the root is lifted that far, the vault over its obstacle). The leg
 * reaches it with two-bone IK (`footwork.ts` `reachLeg`, the knee in its own
 * plane), the foot turned as the loop turns it; where the beat holds the hips
 * higher than that leg reaches (a beat straightening the leg the loop stands
 * on), they sink until it does.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { smoothstep } from '../easing'
import { chain, mocapClipPose, type MocapClip } from './clip'
import type { MocapDims, MocapPose } from './fk'
import { reachLeg } from './footwork'
import { gaitClipTime, gaitPose, type ClipWarp } from './gait-clips'
import { boneLow } from './plant-lock'
import { qslerp } from './quat'
import { BONE_INDEX } from './rig'

const I = BONE_INDEX

/** Each leg's channels and its bones (thigh, shin, foot, toe). */
const LEGS = [
  { keys: ['hipLX', 'hipLZ', 'kneeL'], bones: [I.LeftUpLeg, I.LeftLeg, I.LeftFoot, I.LeftToeBase] },
  { keys: ['hipRX', 'hipRZ', 'kneeR'], bones: [I.RightUpLeg, I.RightLeg, I.RightFoot, I.RightToeBase] }
] as const

/** A foot this far over the floor or less (its lowest surface point, m) goes where the loop has it; SWING_UP or more, where the beat has it. */
const SWING_LOW = 0.03
const SWING_UP = 0.15

/** A leg that has to reach keeps this share of its length (as `footwork.ts`'s). */
const REACH = 0.995

/** How far off the floor a height (m, the bot's own size) puts a foot: 0 to 1. */
const swing = (m: MocapDims, up: number): number => smoothstep((up - SWING_LOW * m.k) / ((SWING_UP - SWING_LOW) * m.k))

/**
 * A travelling loop's pose on a bot at a distance (`gait-clips.ts`
 * `gaitPose`) under a beat's channels, each foot where the loop has it as far
 * as it is on the floor; `lift` is how far the root is lifted over the
 * ground (m, the bot's own size).
 */
export function swingGaitPose(
  m: MocapDims,
  clip: MocapClip,
  warp: ClipWarp | null,
  distance: number,
  time: number,
  joints?: Record<string, number>,
  lift = 0
): { pose: MocapPose; t: number } {
  const air = swing(m, lift)
  const g = gaitPose(m, clip, warp, distance, time, joints)
  if (!joints || air >= 1 || !LEGS.some((l) => l.keys.some((k) => (joints[k] ?? 0) !== 0))) return g
  const rest = Object.fromEntries(Object.entries(joints).filter(([k]) => !LEGS.some((l) => (l.keys as readonly string[]).includes(k))))
  const loop = mocapClipPose(m, { id: clip.id, t: gaitClipTime(clip, warp, distance, time) }, rest)!
  const full = g.pose
  const aims = []
  for (const { bones } of LEGS) {
    const [, , foot, toe] = bones
    const w = Math.max(air, swing(m, Math.min(boneLow(m, loop, foot), boneLow(m, loop, toe)) + lift))
    if (w >= 1) continue
    const A = loop.P[foot]!
    const B = full.P[foot]!
    aims.push({ bones, T: { x: A.x + (B.x - A.x) * w, y: A.y + (B.y - A.y) * w, z: A.z + (B.z - A.z) * w }, foot: qslerp(loop.G[foot]!, full.G[foot]!, w), toe: qslerp(loop.G[toe]!, full.G[toe]!, w) })
  }
  if (aims.length === 0) return g
  // The hips sink where a leg can't reach its foot from the beat's (a beat straightening the leg the loop stands on).
  let drop = 0
  for (const { bones, T } of aims) {
    const [thigh, shin, foot] = bones
    const H = full.P[thigh]!
    const K = full.P[shin]!
    const A = full.P[foot]!
    const reach = REACH * (Math.hypot(K.x - H.x, K.y - H.y, K.z - H.z) + Math.hypot(A.x - K.x, A.y - K.y, A.z - K.z))
    const out = Math.hypot(T.x - H.x, T.z - H.z)
    if (out < reach) drop = Math.max(drop, H.y - T.y - Math.sqrt(reach * reach - out * out))
  }
  const P = drop > 0 ? full.P.map((p) => ({ x: p.x, y: p.y - drop, z: p.z })) : full.P
  const G = [...full.G]
  for (const a of aims) reachLeg(G, P, a.bones, a.T, a.foot, a.toe)
  return { pose: chain(m, G, P[I.Hips]!, full.XG), t: g.t }
}
