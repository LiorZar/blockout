/**
 * Knee lock (fork addition, mocap-backlog; see MODIFICATIONS.md): a bot
 * playing a travelling in-place loop captured on another bot (the X Bot on
 * the library's Y Bot takes) keeps a planted knee where it planted.
 * Retargeting puts the take's rotations on other proportions, so a knee on
 * the floor moves back at another speed than the contact the loop's warp
 * follows (`gait-clips.ts`) and slides (the X Bot's crawl: 2.1 cm a step).
 * Once per bot and clip: over each window a knee is on the floor and slow,
 * its drift from where it planted (the warp's travel taken out); the thigh
 * turns so the knee joint stays put (the shin rides along), and the
 * correction eases back to nothing over the swing. The clip's own bot plays
 * it as captured.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { smoothstep } from '../easing'
import { chain, clipPose, clipSample, mocapClipVersion, poseLowY, type MocapClip } from './clip'
import type { MocapDims, MocapPose } from './fk'
import { measureWarp } from './gait-clips'
import { qmul, qrot, qswing, vsub } from './quat'
import { mocapRig } from './registry'
import { BONE_INDEX, type MocapRig } from './rig'

const I = BONE_INDEX

/** The knees' thigh and shin bones (the knee joint is the shin's). */
const KNEES = [
  [I.LeftUpLeg, I.LeftLeg],
  [I.RightUpLeg, I.RightLeg]
] as const

/** A knee is on the floor when its shin's lowest point is within this of it (m, as the warp reads contacts). */
const ON_FLOOR = 0.01

/** One loop's correction per knee, sampled at `rate` (n + 1 samples, the last the loop's end). */
interface KneeLock {
  rate: number
  n: number
  knees: { dx: Float64Array; dz: Float64Array }[]
}

/**
 * A knee's correction over one loop (pose metres): `x`, `z` its joint and
 * `low` its shin's lowest point over the floor per sample (n + 1, the last
 * the loop's end), `C` the warp's travel. Over each window it is on the
 * floor and slow (under half the loop's speed over the ground) the
 * correction undoes its drift from where it planted; between windows it
 * eases from the last one's to nothing at the next plant.
 */
export function kneeCorrection(x: ArrayLike<number>, z: ArrayLike<number>, low: ArrayLike<number>, C: ArrayLike<number>, rate: number): { dx: Float64Array; dz: Float64Array } {
  const n = C.length - 1
  const dx = new Float64Array(n + 1)
  const dz = new Float64Array(n + 1)
  const speed = (C[n]! * rate) / n
  // Its ground motion from sample i to i + 1 (the body travels -z by the warp).
  const step = (i: number): number => Math.hypot(x[i + 1]! - x[i]!, z[i + 1]! - z[i]! - (C[i + 1]! - C[i]!)) * rate
  const down = Array.from({ length: n }, (_, i) => low[i]! < ON_FLOOR && step(i) < 0.5 * speed)
  if (!down.some((d) => d) || down.every((d) => d)) return { dx, dz }
  // The loop unrolled from the start of a plant: sample k, its joint over the ground (the travel added up across the wrap).
  const first = down.findIndex((d, i) => d && !down[(i + n - 1) % n])
  const at = (k: number): number => (first + k) % n
  const X = (k: number): number => x[at(k)]!
  const Z = (k: number): number => z[at(k)]! - C[at(k)]! - (first + k >= n ? C[n]! : 0)
  let start = 0
  for (let k = 0; k < n; k++) {
    if (down[at(k)]) {
      if (k === 0 || !down[at(k - 1)]) start = k
      dx[at(k)] = X(start) - X(k)
      dz[at(k)] = Z(start) - Z(k)
      continue
    }
    // A swing: from the plant's last correction to nothing at the next plant.
    let e = k
    while (e < n && !down[at(e)]) e++
    const fx = dx[at(k - 1)]!
    const fz = dz[at(k - 1)]!
    for (let j = k; j < e; j++) {
      const w = 1 - smoothstep((j - k + 1) / (e - k + 1))
      dx[at(j)] = fx * w
      dz[at(j)] = fz * w
    }
    k = e - 1
  }
  dx[n] = dx[0]!
  dz[n] = dz[0]!
  return { dx, dz }
}

const LOCKS = new WeakMap<MocapRig, Map<string, KneeLock | null>>()

/** A clip's knee lock on a rig at height ×1 (cached per registration). */
function lockOf(rig: MocapRig, clip: MocapClip, mirror: boolean): KneeLock | null {
  let byClip = LOCKS.get(rig)
  if (!byClip) LOCKS.set(rig, (byClip = new Map()))
  const key = `${clip.id}|${mirror}|${mocapClipVersion()}`
  if (byClip.has(key)) return byClip.get(key)!
  const m: MocapDims = { rig, k: 1 }
  const warp = measureWarp(m, clip)
  let lock: KneeLock | null = null
  if (warp) {
    const n = warp.C.length - 1
    const poses = Array.from({ length: n + 1 }, (_, i) => {
      const s = clipSample(clip, Math.min(i / warp.rate, clip.duration * (1 - 1e-12)), mirror)
      const pose = clipPose(m, s)
      return { pose, floor: poseLowY(m, pose) - s.clear }
    })
    const knees = KNEES.map(([, shin]) => {
      const pts = rig.points.filter((pt) => pt.bone === shin)
      const low = poses.map(({ pose, floor }) => Math.min(...pts.map((pt) => pose.P[shin]!.y + qrot(pose.G[shin]!, pt.off).y)) - floor)
      return kneeCorrection(
        poses.map(({ pose }) => pose.P[shin]!.x),
        poses.map(({ pose }) => pose.P[shin]!.z),
        low,
        warp.C,
        warp.rate
      )
    })
    if (knees.some((k) => k.dz.some((v) => v !== 0) || k.dx.some((v) => v !== 0))) lock = { rate: warp.rate, n, knees }
  }
  byClip.set(key, lock)
  return lock
}

/**
 * A clip pose (not grounded) with a retargeted bot's planted knees kept put:
 * each thigh turned so its knee joint moves by the lock's correction at clip
 * time `t`. The clip's own bot, or a clip that isn't a travelling loop,
 * gets the pose back as it is.
 */
export function lockKnees(m: MocapDims, clip: MocapClip, t: number, mirror: boolean, pose: MocapPose): MocapPose {
  if (!clip.inPlace || mocapRig(clip.source) === m.rig) return pose
  const lock = lockOf(m.rig, clip, mirror)
  if (!lock) return pose
  const D = clip.duration
  const tt = clip.loop && D > 0 ? t - Math.floor(t / D) * D : Math.min(Math.max(0, t), D)
  const f = Math.min(lock.n, tt * lock.rate)
  const i = Math.min(Math.floor(f), lock.n - 1)
  const u = f - i
  let G: MocapPose['G'] | null = null
  KNEES.forEach(([thigh, shin], q) => {
    const { dx, dz } = lock.knees[q]!
    const cx = (dx[i]! + (dx[i + 1]! - dx[i]!) * u) * m.k
    const cz = (dz[i]! + (dz[i + 1]! - dz[i]!) * u) * m.k
    if (cx === 0 && cz === 0) return
    const H = pose.P[thigh]!
    const K = pose.P[shin]!
    const v = vsub(K, H)
    G ??= [...pose.G]
    G[thigh] = qmul(qswing(v, { x: v.x + cx, y: v.y, z: v.z + cz }), G[thigh]!)
  })
  return G ? chain(m, G, pose.P[I.Hips]!, pose.XG) : pose
}

