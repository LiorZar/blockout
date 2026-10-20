/**
 * Gaits from mocap clips (fork addition; see MODIFICATIONS.md): which
 * library loop each gait plays on a loaded bot, and how far one cycle of a
 * travelling loop carries the body (its stride, measured off the clip's own
 * planted contacts), so a gait run on distance plants its feet without
 * sliding. Idle loops (stand, talk, sit, lie, crouch still) run on time.
 *
 * A bot standing with joint offsets on (a keyframe motion, a weapon's hold
 * pose, a fight) keeps the keyframe rig pose: the engine's FK (fights,
 * weapons, shot words) sees that same pose. Only a bare stand plays the
 * idle loop.
 *
 * PURE: no DOM / three.js / Electron. The stride cache is keyed by the
 * registry versions, never filled on the `state(t)` path of an export after
 * the first frame that needs it (a pure function of the registered data).
 */

import type { GaitId } from '../types'
import { clipPose, clipSample, mocapClip, mocapClipPose, mocapClipVersion, poseLowY, type MocapClip } from './clip'
import type { MocapDims, MocapPose } from './fk'
import { mocapVersion } from './registry'
import { BONE_INDEX, type MocapBone } from './rig'

/** The library loop of each gait (still, moving where they differ, and on a seat prop for the sit). */
export const GAIT_CLIPS: Record<GaitId, { still: string; moving?: string; seated?: string }> = {
  stand: { still: 'idle' },
  walk: { still: 'walk' },
  jog: { still: 'jog' },
  run: { still: 'run' },
  // The crouch idle with the crouched walk's arms at rest (the library's holds a hand up, `clip.ts`).
  crouch: { still: 'crouchStill', moving: 'crouchWalk' },
  // On the floor, or in the chair when a seat prop takes the hips (`library-clips.ts` seats).
  sit: { still: 'sitFloor', seated: 'sitChair' },
  lie: { still: 'lieIdle' },
  gesture: { still: 'talk' },
  fall: { still: 'lieIdle' }
}

/** Per bot, clips that replace a gait's (the woman walks her own walk). */
const BODY_CLIPS: Record<string, Record<string, string>> = {
  'person.mocapFemale': { walk: 'walkFemale' }
}

/** Below this speed (m/s) a travelling gait stands. */
const STILL = 0.05

const TRAVELS = new Set<GaitId>(['walk', 'jog', 'run'])

/** The clip a bot plays for a gait at a speed (`seated`: a seat prop under its hips), or undefined when the library has none. */
export function gaitClipId(assetId: string, gait: GaitId, speed: number, seated = false): string | undefined {
  const g = TRAVELS.has(gait) && speed < STILL ? 'stand' : gait
  const spec = GAIT_CLIPS[g]
  const key = g === 'crouch' && speed >= STILL ? spec.moving! : seated && spec.seated ? spec.seated : spec.still
  const id = BODY_CLIPS[assetId]?.[key] ?? key
  return mocapClip(id) ? id : mocapClip(key) ? key : undefined
}

/** A contact joint is on the floor when its lowest surface point is within this of it (m). */
const ON_FLOOR = 0.01

/** Contacts whose planted speed measures a stride: feet (heel and ball), hands, knees. */
const CONTACTS: MocapBone[][] = [
  ['LeftFoot', 'LeftToeBase'],
  ['RightFoot', 'RightToeBase'],
  ['LeftHand'],
  ['RightHand'],
  ['LeftLeg'],
  ['RightLeg']
]

function contactLow(m: MocapDims, pose: MocapPose, bones: number[]): number {
  let low = Infinity
  for (const pt of m.rig.points) {
    if (!bones.includes(pt.bone)) continue
    const P = pose.P[pt.bone]!
    const [x, y, z, w] = pose.G[pt.bone]!
    const o = pt.off
    const k = m.k
    const tx = 2 * (y * o.z * k - z * o.y * k)
    const tz = 2 * (x * o.y * k - y * o.x * k)
    const py = P.y + o.y * k + w * (2 * (z * o.x * k - x * o.z * k)) + z * tx - x * tz
    if (py < low) low = py
  }
  return low
}

/**
 * How an in-place loop travels on a bot, sampled at `rate` per second over
 * one loop. The planted contact at each step is the joint on the floor (its
 * surface within `ON_FLOOR` of the floor) sliding back under the body at the
 * speed closest to the loop's travel speed: a swing brushing the floor moves
 * forward, a toe dragging off slows down, a foot landing alone is the only
 * one.
 * `C` is the planted contact's backward travel, cumulated (m, from 0), and
 * `stride` the total over the loop; steps without a contact (a run's flight,
 * a foot stopping on the floor) take the speeds either side. Played at the
 * clip time where `C` reaches the distance walked, the body travels as its
 * feet push it and a planted foot stays put. No travel: null.
 */
export interface ClipWarp {
  rate: number
  stride: number
  C: Float64Array
}

/** Samples per second for a clip's travel. */
const RATE = 120

export function measureWarp(m: MocapDims, clip: MocapClip): ClipWarp | null {
  if (!clip.inPlace || clip.frames < 3) return null
  const bones = CONTACTS.flat().map((b) => BONE_INDEX[b])
  const n = Math.max(2, Math.round(clip.duration * RATE))
  const rate = n / clip.duration
  // The last sample is the loop's last frame, not its wrap to the first.
  const samples = Array.from({ length: n + 1 }, (_, i) => clipSample(clip, Math.min(i / rate, clip.duration * (1 - 1e-12))))
  const poses = samples.map((s) => clipPose(m, s))
  // Per sample: the contact joints on the floor (the pose stands at its clearance, `clip.ts`).
  const down = poses.map((pose, i) => {
    const floor = poseLowY(m, pose) - samples[i]!.clear * m.k
    return new Set(bones.filter((b) => contactLow(m, pose, [b]) - floor < ON_FLOOR * m.k))
  })
  const z = (i: number, b: number): number => poses[i]!.P[b]!.z
  const speeds = (i: number): [number, number][] => [...down[i]!].filter((b) => down[i + 1]!.has(b)).map((b) => [b, (z(i + 1, b) - z(i, b)) * rate])
  // The travel speed: the median backward speed of joints on the floor, then the planted contacts'.
  const all = Array.from({ length: n }, (_, i) => speeds(i).map(([, u]) => u)).flat().filter((u) => u > 0).sort((a, b) => a - b)
  if (all.length === 0) return null
  let vRef = all[Math.floor(all.length / 2)]!
  let out: ClipWarp | null = null
  for (let pass = 0; pass < 2; pass++) {
    const pick = Array.from({ length: n }, (_, i): [number, number] | null => {
      let best: [number, number] | null = null
      for (const c of speeds(i)) if (!best || Math.abs(c[1] - vRef) < Math.abs(best[1] - vRef)) best = c
      return best
    })
    const v = pick.map((p) => (p && p[1] > 0.1 * vRef ? p[1] : null))
    if (!v.some((x) => x !== null)) return null
    // Fill the gaps from the speeds either side (around the loop).
    const filled = v.map((x, i) => {
      if (x !== null) return x
      let a = i
      let b = i
      let da = 0
      let db = 0
      while (v[(a + n) % n] === null && da < n) {
        a--
        da++
      }
      while (v[b % n] === null && db < n) {
        b++
        db++
      }
      const va = v[(a + n) % n]!
      const vb = v[b % n]!
      return va + ((vb - va) * da) / (da + db)
    })
    const C = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) C[i + 1] = C[i]! + filled[i]! / rate
    out = { rate, stride: C[n]!, C }
    vRef = C[n]! / clip.duration
  }
  return out
}

/** How far one cycle carries a bot (0 for a clip that doesn't travel). */
export function measureStride(m: MocapDims, clip: MocapClip): number {
  return measureWarp(m, clip)?.stride ?? 0
}

const WARPS = new Map<string, ClipWarp | null>()

/** A clip's travel on a bot at height ×1 (cached per registration). */
export function clipWarp(m: MocapDims, clip: MocapClip, assetId: string): ClipWarp | null {
  const key = `${assetId}|${clip.id}|${mocapVersion()}|${mocapClipVersion()}`
  if (!WARPS.has(key)) WARPS.set(key, measureWarp({ rig: m.rig, k: 1 }, clip))
  return WARPS.get(key)!
}

/** A clip's stride on a bot, in the bot's metres. */
export function clipStride(m: MocapDims, clip: MocapClip, assetId: string): number {
  return (clipWarp(m, clip, assetId)?.stride ?? 0) * m.k
}

/**
 * A gait clip's clip time: a travelling loop at the time its contacts have
 * travelled `distance` (bot metres at height ×1: the walked distance over
 * the entity's scale and height); anything else on shot time.
 */
export function gaitClipTime(clip: MocapClip, warp: ClipWarp | null, distance: number, time: number): number {
  if (!warp || !(warp.stride > 0)) return time
  const cycles = Math.floor(distance / warp.stride)
  const rem = distance - cycles * warp.stride
  const C = warp.C
  let lo = 0
  let hi = C.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (C[mid]! <= rem) lo = mid
    else hi = mid
  }
  const span = C[hi]! - C[lo]!
  const f = lo + (span > 0 ? (rem - C[lo]!) / span : 0)
  return cycles * clip.duration + f / warp.rate
}

/** The inverse of `gaitClipTime`: how far a travelling loop's contacts have travelled at clip time `t`. */
export function clipDistance(clip: MocapClip, warp: ClipWarp, t: number): number {
  const D = clip.duration
  const cycles = clip.loop && D > 0 ? Math.floor(t / D) : 0
  const f = Math.min(warp.C.length - 1, Math.max(0, (t - cycles * D) * warp.rate))
  const i = Math.min(Math.floor(f), warp.C.length - 2)
  return cycles * warp.stride + warp.C[i]! + (warp.C[i + 1]! - warp.C[i]!) * (f - i)
}

/** A gait loop's pose on a bot: the clip at the warped time (grounded, `clip.ts`). */
export function gaitPose(m: MocapDims, clip: MocapClip, warp: ClipWarp | null, distance: number, time: number, joints?: Record<string, number>): { pose: MocapPose; t: number } {
  const t = gaitClipTime(clip, warp, distance, time)
  return { pose: mocapClipPose(m, { id: clip.id, t }, joints)!, t }
}
