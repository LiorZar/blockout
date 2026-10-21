/**
 * Floor contact for fighters (fork addition; see MODIFICATIONS.md).
 *
 * Every fight mark rests the posed body's lowest point (floor.ts body proxy)
 * on the fighter's floor, plus a reported kick lift: crouches, lunges and
 * ducks plant their feet, falls and get-ups lie on the floor, and nothing
 * goes through it. The library's authored root drops (`move.up`) were made
 * for other proportions, so fights don't use them.
 *
 * The evaluator interpolates joints and root height linearly between marks,
 * and the lowest point of a pose isn't linear in its joints: `groundBetween`
 * inserts a grounded mark wherever the in-between pose would float or sink.
 * Mocap bots (fork, mocap fights): a clip mark's y is its floor (the clip
 * pose grounds itself), and legs touching one are left to the evaluator.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { lerpAngle } from '../easing'
import { bodyShape, lowestY, type BodyShape } from '../floor'
import type { ChoreoMarkSpec } from '../choreography'
import type { ClipState } from '../types'

type Joints = Record<string, number>

/** A fighter's body on its floor. */
export interface FloorBody {
  shape: BodyShape
  scale: number
  /** The floor height under the fighter (its start y). */
  y: number
}

/** Interior samples per interval, the float / sink tolerance (m), and the shortest interval split (s). */
const SAMPLES = 8
const TOLERANCE = 0.015
const MIN_GAP = 1 / 120

export function floorBody(assetId: string, params: Record<string, number | string> | undefined, scale: number, y: number): FloorBody {
  return { shape: bodyShape(assetId, params), scale, y }
}

/**
 * Root height that rests a posed fighter's lowest point on its floor, `lift`
 * above it. A mocap bot on a clip (fork, mocap fights) stands on its floor:
 * the clip pose grounds itself on the root (mocap/clip.ts), so its mark's y
 * is the floor, plus the lift.
 */
export function groundY(b: FloorBody, joints: Joints | undefined, lift = 0, clip?: ClipState): number {
  if (clip && b.shape.dims.mocap) return b.y + lift
  return b.y - lowestY(b.shape, joints) * b.scale + lift
}

function lerpJoints(a: Joints | undefined, b: Joints | undefined, u: number): Joints {
  const out: Joints = {}
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) out[k] = (a?.[k] ?? 0) + ((b?.[k] ?? 0) - (a?.[k] ?? 0)) * u
  return out
}

/**
 * Insert grounded marks from index `from` on wherever the pose interpolated
 * between two marks floats or sinks more than 1.5 cm against the lift ramp
 * between them (a mark's lift: its height above its own grounded height).
 * The inserted mark has the interpolated joints, position and facing, so the
 * motion is unchanged but for the root height. Stops at `cap` marks.
 */
export function groundBetween<M extends ChoreoMarkSpec & { arriveHeading?: number }>(b: FloorBody, marks: M[], from: number, cap: number): void {
  const liftOf = (m: M): number => m.position.y - groundY(b, m.joints)
  let k = Math.max(0, from)
  while (k < marks.length - 1 && marks.length < cap) {
    const m0 = marks[k]!
    const m1 = marks[k + 1]!
    // A leg touching a clip mark is grounded by the evaluator (the clip pose on the floor line).
    if (m1.time - m0.time < 2 * MIN_GAP || !m0.joints || !m1.joints || m0.clip || m1.clip) {
      k++
      continue
    }
    const l0 = liftOf(m0)
    const l1 = liftOf(m1)
    let worst = 0
    let at = 0
    for (let s = 1; s < SAMPLES; s++) {
      const u = s / SAMPLES
      const have = m0.position.y + (m1.position.y - m0.position.y) * u
      const err = have - groundY(b, lerpJoints(m0.joints, m1.joints, u), l0 + (l1 - l0) * u)
      if (Math.abs(err) > Math.abs(worst)) {
        worst = err
        at = u
      }
    }
    if (Math.abs(worst) <= TOLERANCE) {
      k++
      continue
    }
    const joints = lerpJoints(m0.joints, m1.joints, at)
    const lerp = (p: number, q: number): number => p + (q - p) * at
    const mid: M = {
      ...m1,
      time: lerp(m0.time, m1.time),
      position: { x: lerp(m0.position.x, m1.position.x), y: groundY(b, joints, lerp(l0, l1)), z: lerp(m0.position.z, m1.position.z) },
      joints
    }
    if (m0.arriveHeading !== undefined && m1.arriveHeading !== undefined) mid.arriveHeading = lerpAngle(m0.arriveHeading, m1.arriveHeading, at)
    marks.splice(k + 1, 0, mid)
  }
}
