/**
 * Bot gait loops on one foot phase (fork addition, set-routines; see
 * MODIFICATIONS.md). A travelling loop plays on the distance walked, so its
 * planted feet stay put, but each loop used to start from its own clip time
 * at distance 0: at a gait change (a run braking to a walk, a jog speeding
 * up to a run) the two loops crossfaded had different feet down, and the
 * blend dragged a foot along the floor. Here a bot carries one foot phase
 * (foot cycles), advanced over each leg by the leg's travel over the stride
 * of the loop it plays (a clip holding two strides counts two cycles): every
 * loop plays at that phase from its own left-foot touchdown
 * (`ClipWarp.origin`), so the loops crossfaded at a change have
 * the same foot down at the same point of its step. Over a leg the phase
 * runs at the distance walked over the loop's stride, so the feet still stay
 * put.
 *
 * PURE: no DOM / three.js / Electron. Remembered per legs array (built once
 * per evaluator) and registry version.
 */

import type { ActorMark, Entity, GaitId } from '../types'
import { personDims } from '../skeleton'
import { mocapClip, mocapClipVersion } from './clip'
import { clipWarp, gaitClipId } from './gait-clips'
import { mocapVersion } from './registry'

/** A leg of a track (the evaluator's, the parts used here). */
export interface PhaseLeg {
  from: ActorMark
  to: ActorMark
  departTime: number
  arriveTime: number
  distanceBefore: number
  path: { length: number }
}

interface Phases {
  key: string
  /** Per leg: the distance it starts at, the phase there, and the stride of the loop it plays (Infinity: none). */
  d0: number[]
  p0: number[]
  stride: number[]
}

const PHASES = new WeakMap<readonly PhaseLeg[], Phases>()

/** How far one foot cycle (a stride of each foot) of a gait's travelling loop carries a bot (world metres), or Infinity when it plays none. */
export function loopStride(entity: Entity, gait: GaitId): number {
  const m = personDims(entity.assetId, entity.params).mocap
  const id = m ? gaitClipId(entity.assetId, gait, 1) : undefined
  const clip = id ? mocapClip(id) : undefined
  const warp = m && clip ? clipWarp(m, clip, entity.assetId) : null
  const s = warp ? (warp.stride / (warp.cycles ?? 1)) * m!.k * entity.transform.scale : 0
  return s > 1e-6 ? s : Infinity
}

/**
 * A bot's foot phase (cycles) at `distance` along its track, or undefined
 * for a body that plays no loops. `plays` is the gait each leg plays (the
 * evaluator's rule).
 */
export function loopPhaseAt(entity: Entity, legs: readonly PhaseLeg[], distance: number, plays: (leg: PhaseLeg) => GaitId): number | undefined {
  if (!personDims(entity.assetId, entity.params).mocap) return undefined
  const key = `${mocapVersion()}|${mocapClipVersion()}|${entity.transform.scale}`
  let ph = PHASES.get(legs)
  if (!ph || ph.key !== key) {
    ph = { key, d0: [], p0: [], stride: [] }
    let p = 0
    for (const leg of legs) {
      const stride = loopStride(entity, plays(leg))
      ph.d0.push(leg.distanceBefore)
      ph.p0.push(p)
      ph.stride.push(stride)
      p += leg.path.length / stride
    }
    PHASES.set(legs, ph)
  }
  // The last leg starting at or before the distance (a leg of no length holds the phase where it is).
  let lo = 0
  let hi = ph.d0.length - 1
  if (hi < 0 || distance <= ph.d0[0]!) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ph.d0[mid]! <= distance) lo = mid
    else hi = mid - 1
  }
  const into = Math.min(distance - ph.d0[lo]!, legs[lo]!.path.length)
  return ph.p0[lo]! + into / ph.stride[lo]!
}
