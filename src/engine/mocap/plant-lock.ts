/**
 * Plant lock (fork addition, chase-feet; see MODIFICATIONS.md): a bot's
 * planted feet stay where they planted while its legs aren't one gait loop
 * played on distance. A gait loop keeps its planted feet put on its own (its
 * clip time runs on the distance walked, `gait-clips.ts`), but a crossfade
 * between two loops (a run braking to a walk) blends spots their strides put
 * apart, and the blend dragged the planted foot from one to the other.
 *
 * The renderer samples, on a fixed grid from the start of such a window (a
 * function of the document, never of the frame drawn before), the pose the
 * bot would show without the lock (`plantSample`: the toe and ankle joints
 * on the floor plan in world space, and the lowest surface point of the toe
 * and of the foot over the floor). Per foot, `plantCorrection` walks those
 * samples: while the foot is down (its toe's surface within DOWN of the
 * floor, standing on the toe joint; else the foot's, on the ankle; the
 * contacts a loop's warp reads, `gait-clips.ts`) its correction cancels the
 * travel of that joint over the floor, so the foot
 * stays put and can't jump as it lands; once it lifts, the correction eases
 * out over EASE seconds of its swing, so the next plant is the loop's own. A
 * held foot the leg can't reach steps off it, and so does one still held HOLD
 * seconds after the last crossfade. Into a standing pose (an idle, a keyframe
 * stand), which never lifts a foot, each held foot steps to its spot in the
 * stance in turn, so every correction is gone by the window's end.
 * `plantPose` moves each foot by its correction with two-bone leg IK
 * (`footwork.ts` `reachLeg`, the knee in its own plane), the foot's turn kept.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { smoothstep } from '../easing'
import type { MocapDims, MocapPose } from './fk'
import { chain } from './clip'
import { reachLeg } from './footwork'
import { qrot, vscale } from './quat'
import { BONE_INDEX } from './rig'

const I = BONE_INDEX

/** Samples per second along a window. */
export const PLANT_RATE = 96

/** A toe or foot whose lowest surface point is this far over the floor or less is down (m). */
const DOWN = 0.02

/** Seconds a lifted foot's correction eases out over, and a step off a hold takes. */
const EASE = 0.2
const STEP = 0.2

/** Seconds after the last blending sample a foot is held at most. */
const HOLD = 0.8

/** A leg that has to reach keeps this share of its length (as `footwork.ts`'s); the hips sink at most DROP (m) for a held foot's reach, and a foot that needs more steps off. */
const REACH = 0.995
const DROP = 0.08

/** How high a step off a hold lifts the foot (m): a share of the step, at least LIFT_MIN, at most LIFT. */
const LIFT = 0.08
const LIFT_MIN = 0.035
const LIFT_SHARE = 0.35

/** A correction under this is none (m); a held foot further than STEP_MIN off its spot in a standing pose steps to it. */
const NONE = 1e-6
const STEP_MIN = 0.01

const LEGS = {
  L: [I.LeftUpLeg, I.LeftLeg, I.LeftFoot, I.LeftToeBase],
  R: [I.RightUpLeg, I.RightLeg, I.RightFoot, I.RightToeBase]
} as const

type Side = keyof typeof LEGS

/** A point on the floor plan (world x, z). */
export interface Flat {
  x: number
  z: number
}

/** Where a bot's root is (world) and which way it faces. */
export interface PlantRoot {
  x: number
  z: number
  heading: number
}

/**
 * One foot in a sample: its toe and ankle joints on the floor plan, how far the toe's and the foot's lowest surface
 * points are over the floor (m), its hip joint on the floor plan, the hip's and the ankle's heights (entity space) and
 * the leg's length (thigh and shin).
 */
export interface PlantFoot {
  toe: Flat
  ankle: Flat
  toeUp: number
  ankleUp: number
  hip: Flat
  hipY: number
  ankleY: number
  leg: number
}

export interface PlantSample {
  t: number
  L: PlantFoot
  R: PlantFoot
  /** A crossfade runs here. */
  mixed?: boolean
  /** The pose stands still here (an idle, the keyframe rig, a mark clip): no foot is held. */
  still?: boolean
}

/** A foot's correction: on the floor plan (world), and up (m, a step off a hold). */
export interface PlantMove extends Flat {
  up: number
}

export type PlantShift = Record<Side, PlantMove>

/** A local point on the floor plan turned to the world at a root. */
function toWorld(at: PlantRoot, x: number, z: number): Flat {
  const c = Math.cos(at.heading)
  const s = Math.sin(at.heading)
  return { x: at.x + x * c + z * s, z: at.z - x * s + z * c }
}

const BONE_POINTS = new WeakMap<MocapDims['rig'], Map<number, MocapDims['rig']['points']>>()

/** The lowest surface point of a bone in a pose (its support points; entity space y). */
export function boneLow(m: MocapDims, pose: MocapPose, bone: number): number {
  let by = BONE_POINTS.get(m.rig)
  if (!by) BONE_POINTS.set(m.rig, (by = new Map()))
  let pts = by.get(bone)
  if (!pts) by.set(bone, (pts = m.rig.points.filter((pt) => pt.bone === bone)))
  const P = pose.P[bone]!
  const q = pose.G[bone]!
  let low = Infinity
  for (const pt of pts) low = Math.min(low, P.y + qrot(q, vscale(pt.off, m.k)).y)
  return low
}

/** A bot's feet in a pose (entity space, its floor at y 0) at a root, at shot time `t`. */
export function plantSample(m: MocapDims, pose: MocapPose, at: PlantRoot, t: number): PlantSample {
  const foot = (side: Side): PlantFoot => {
    const [thigh, shin, ankle, toe] = LEGS[side]
    const H = pose.P[thigh]!
    const K = pose.P[shin]!
    const A = pose.P[ankle]!
    const T = pose.P[toe]!
    return {
      toe: toWorld(at, T.x, T.z),
      ankle: toWorld(at, A.x, A.z),
      toeUp: boneLow(m, pose, toe),
      ankleUp: boneLow(m, pose, ankle),
      hip: toWorld(at, H.x, H.z),
      hipY: H.y,
      ankleY: A.y,
      leg: Math.hypot(K.x - H.x, K.y - H.y, K.z - H.z) + Math.hypot(A.x - K.x, A.y - K.y, A.z - K.z)
    }
  }
  return { t, L: foot('L'), R: foot('R') }
}

/** The joint a foot stands on: its toe's when the toe is down, else its ankle when the foot is, else none. */
function standsOn(f: PlantFoot, k: number): 'toe' | 'ankle' | null {
  return f.toeUp < DOWN * k ? 'toe' : f.ankleUp < DOWN * k ? 'ankle' : null
}

/** How far the hips sink for a leg (hip at `H`, `leg` long, its ankle in the pose at `A`) to reach `T` (m; Infinity: out of reach on the floor plan). */
function sinkFor(H: { x: number; y: number; z: number }, A: { x: number; y: number; z: number }, T: { x: number; y: number; z: number }, leg: number): number {
  const reach = Math.max(leg * REACH, Math.hypot(A.x - H.x, A.y - H.y, A.z - H.z))
  const out = Math.hypot(T.x - H.x, T.z - H.z)
  return out < reach ? H.y - T.y - Math.sqrt(reach * reach - out * out) : Infinity
}

/** How far the hips sink for a foot moved by `c` (m). */
function sink(f: PlantFoot, c: Flat): number {
  return sinkFor({ x: f.hip.x, y: f.hipY, z: f.hip.z }, { x: f.ankle.x, y: f.ankleY, z: f.ankle.z }, { x: f.ankle.x + c.x, y: f.ankleY, z: f.ankle.z + c.z }, f.leg)
}

/**
 * Each foot's correction at the last of `samples` (in time order, the first
 * the window's start, where no foot is corrected): see the module header. A
 * held foot whose leg can't reach its spot any more, or whose hold runs out
 * (HOLD seconds past the last crossfade) while it is down, steps off it: over
 * STEP seconds the correction eases out while the foot lifts in an arc, so it
 * moves through the air, not over the floor. Where the pose stands still (an
 * idle never lifts a foot) a held foot steps to its spot in the stance once
 * the other foot is down and not stepping, the one further off first. `k` is
 * the bot's height multiplier.
 */
export function plantCorrection(samples: readonly PlantSample[], k = 1): PlantShift {
  // Per foot: its correction, its lift, and what it is easing out over (a swing, or a step `step` high).
  const feet = (['L', 'R'] as const).map((side) => ({ side, c: { x: 0, z: 0 } as Flat, up: 0, ease: null as { c: Flat; t: number; step?: number } | null }))
  type Foot = (typeof feet)[number]
  const eased = (f: Foot, t: number): void => {
    const e = f.ease!
    const u = Math.min(1, (t - e.t) / (e.step !== undefined ? STEP : EASE))
    const w = 1 - smoothstep(u)
    f.c = { x: e.c.x * w, z: e.c.z * w }
    f.up = e.step !== undefined ? e.step * Math.sin(Math.PI * u) : 0
    if (u >= 1 && e.step !== undefined) f.ease = null
  }
  const step = (f: Foot, from: Flat, t0: number, t: number): void => {
    f.ease = { c: from, t: t0, step: stepHeight(from, k) }
    eased(f, t)
  }
  let mixed = samples[0]?.mixed ? samples[0].t : -Infinity
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!
    if (s.mixed) mixed = s.t
    const t0 = samples[i - 1]!.t
    const late = s.t - mixed > HOLD
    const held: Foot[] = []
    for (const f of feet) {
      const a = samples[i - 1]![f.side]
      const b = s[f.side]
      const on = standsOn(b, k)
      f.up = 0
      // A step runs to its end.
      if (f.ease?.step !== undefined) {
        eased(f, s.t)
        continue
      }
      if (on && (s.still || !late)) {
        // Down: the joint it stands on doesn't travel (from the sample before, where it was down too).
        const next = standsOn(a, k) ? { x: f.c.x - (b[on].x - a[on].x), z: f.c.z - (b[on].z - a[on].z) } : f.c
        f.ease = null
        // Out of reach: it steps off from where it stood.
        if (sink(b, next) > DROP * k) step(f, f.c, t0, s.t)
        else {
          f.c = next
          held.push(f)
        }
        continue
      }
      // Down but let go of (the hold ran out): a step.
      if (on && Math.hypot(f.c.x, f.c.z) > NONE) {
        step(f, f.c, t0, s.t)
        continue
      }
      // In the air: the correction eases out over the swing.
      f.ease ??= { c: f.c, t: t0 }
      eased(f, s.t)
    }
    if (!s.still) continue
    // A still pose: a held foot off its spot steps to it once the other foot stands (past HOLD, whatever the other does).
    const off = held.filter((f) => Math.hypot(f.c.x, f.c.z) > STEP_MIN * k && (late || held.includes(feet.find((g) => g !== f)!)))
    const go = off.sort((p, q) => Math.hypot(q.c.x, q.c.z) - Math.hypot(p.c.x, p.c.z))[0]
    if (go) step(go, go.c, s.t, s.t)
  }
  return { L: { ...feet[0]!.c, up: feet[0]!.up }, R: { ...feet[1]!.c, up: feet[1]!.up } }
}

/** A step's height for a correction (m). */
function stepHeight(c: Flat, k: number): number {
  return Math.min(LIFT, Math.max(LIFT_MIN, LIFT_SHARE * Math.hypot(c.x, c.z))) * k
}

/** Whether a correction moves anything. */
export function plantMoves(shift: PlantShift): boolean {
  return (['L', 'R'] as const).some((q) => Math.hypot(shift[q].x, shift[q].z) > NONE || shift[q].up > NONE)
}

/**
 * A pose (entity space) with each foot moved by its correction (world, the
 * root facing `heading`), the hips sunk where a held foot needs the reach (at
 * most DROP; the other foot then kept where the pose has it), or the pose
 * itself when none moves.
 */
export function plantPose(m: MocapDims, pose: MocapPose, shift: PlantShift, heading: number): MocapPose {
  if (!plantMoves(shift)) return pose
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  const P = pose.P
  const aims = (['L', 'R'] as const).map((side) => {
    const d = shift[side]
    const leg = LEGS[side]
    const A = P[leg[2]]!
    const moves = Math.hypot(d.x, d.z) > NONE || d.up > NONE
    // The world shift turned into the entity's frame.
    return { leg, moves, T: moves ? { x: A.x + d.x * c - d.z * s, y: A.y + d.up, z: A.z + d.x * s + d.z * c } : A }
  })
  let drop = 0
  for (const { leg, moves, T } of aims) {
    if (!moves) continue
    const H = P[leg[0]]!
    const K = P[leg[1]]!
    const A = P[leg[2]]!
    drop = Math.max(drop, sinkFor(H, A, T, Math.hypot(K.x - H.x, K.y - H.y, K.z - H.z) + Math.hypot(A.x - K.x, A.y - K.y, A.z - K.z)))
  }
  drop = Math.min(DROP * m.k, drop)
  const Pd = drop > 0 ? P.map((p) => ({ x: p.x, y: p.y - drop, z: p.z })) : P
  const G = [...pose.G]
  for (const { leg, moves, T } of aims) if (moves || drop > 0) reachLeg(G, Pd, leg, T, pose.G[leg[2]]!, pose.G[leg[3]]!)
  return chain(m, G, Pd[I.Hips]!, pose.XG)
}
