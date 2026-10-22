/**
 * The Choreographer's foot chase on tracks (fork addition, qa-fixes; see
 * MODIFICATIONS.md). Upstream laid each scripted beat at one fixed spot while
 * the travel samples inside its window stayed on the path, so a performer ran
 * ahead and snapped back (3–5 m in a frame); the pursuers' start clamped to
 * the path's start, so the cast began on one spot; the pursuer's skid-stop
 * was laid 1.5 m past its own spot, on the runner.
 *
 * Here every performer has an arc distance along the serpentine as a pure
 * function of time, and all its marks come off it:
 * - the path runs on straight back past its start, so the pursuers start
 *   behind the runner, each at its own spot;
 * - a scripted beat rides the track: the vault, the stumble and the
 *   pursuer's skid play their keyframe poses over the run while the root
 *   keeps going (marks with `ride`: the run grounds them, the floor rule
 *   leaves their height); the runner's skid brakes (to a quarter of its
 *   speed and back), and the pursuers, laid against the runner's track,
 *   brake with it; no travel mark falls inside a beat;
 * - every pursuer stays CHASE_SPACING (along the path) behind the one ahead
 *   until the tackle;
 * - caught: the runner falls forward with its momentum (`trip-and-fall-flat`;
 *   a bot plays its clip, which carries it on), the tackler closes from its
 *   gap to TACKLE_GAP behind it on contact and stays there; escape: the
 *   pursuer brakes to a stop, hands on its hips.
 *
 * The beats stay keyframe poses (a bot plays them over its run loop): the
 * library's trip clip is a fall, not a stumble. Only the caught runner's fall
 * is a play a bot turns into its clip.
 *
 * PURE: no DOM / three.js / Electron. Seeded like upstream (the same beat
 * times and path for a seed).
 */

import type { ChaseEnding, ChoreoEntitySpec, ChoreoMarkSpec, RoutineCtx, RoutineSpec } from './choreography'
import type { Body } from './floor'
import type { GaitId } from './types'
import type { MotionPreset } from './motions'
import { motionClip, runTravel } from './mocap/library-clips'
import { toWorld } from './skeleton'

/** What the chase borrows from `choreography.ts` (its private helpers, passed in so the two modules don't import each other). */
export interface ChaseKit {
  serpentine: (ctx: RoutineCtx, length: number, amplitude: number, seed: number) => { x: number; z: number }[]
  mulberry32: (seed: number) => () => number
  motion: (id: string) => MotionPreset | undefined
  playMotion: (marks: ChoreoMarkSpec[], preset: MotionPreset, pos: { x: number; y: number; z: number }, startT: number, opts?: { facing?: number; gait?: GaitId }) => number
  dedupeSort: (marks: ChoreoMarkSpec[]) => ChoreoMarkSpec[]
}

interface XZ {
  x: number
  z: number
}

/** Closest a pursuer comes to the one ahead of it before the tackle (m, along the path). */
export const CHASE_SPACING = 0.9
/** The tackler's root behind the runner's from the contact on (m). */
export const TACKLE_GAP = 0.45
/** A scripted beat's length (the presets' 1.2 s). */
const BEAT = 1.2
/** The ending starts this long before the end (the fall lands inside the shot). */
const ENDING = 1.6
/** The tackle lunges this far into its play (tackle-lunge's push-off keyframe). */
const CONTACT = 0.6
/** The runner's skid brakes to this share of its speed, mid-skid. */
const SKID_LOW = 0.25
/** Travel marks this often (s). */
const STEP = 0.25
/** The track's integration step (s). */
const DT = 1 / 240

const facingTo = (from: XZ, to: XZ): number => Math.atan2(-(to.x - from.x), -(to.z - from.z))
const forwardOf = (heading: number): XZ => ({ x: -Math.sin(heading), z: -Math.cos(heading) })
const clamp01 = (u: number): number => Math.min(1, Math.max(0, u))
const smooth = (u: number): number => {
  const v = clamp01(u)
  return v * v * (3 - 2 * v)
}
/** A smooth minimum: never above either, within k/2 of the smaller. */
const smin = (a: number, b: number, k: number): number => (a + b - Math.sqrt((a - b) * (a - b) + k * k)) / 2

/** A polyline by arc distance, running on straight past both ends. */
function pathOf(pts: XZ[]): { total: number; at: (d: number) => XZ & { heading: number } } {
  const cum: number[] = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z))
  const total = cum[cum.length - 1]!
  const at = (d: number): XZ & { heading: number } => {
    let i = 1
    while (i < cum.length - 1 && cum[i]! < d) i++
    const a = pts[i - 1]!
    const b = pts[i]!
    const len = Math.max(1e-6, cum[i]! - cum[i - 1]!)
    const f = (d - cum[i - 1]!) / len
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, heading: facingTo(a, b) }
  }
  return { total, at }
}

/** A function of time as samples every DT from 0 (linear in between, held past the ends). */
function sampled(n: number, f: (t: number) => number): (t: number) => number {
  const v = Array.from({ length: n + 1 }, (_, i) => f(i * DT))
  return (t) => {
    const x = Math.min(n, Math.max(0, t / DT))
    const i = Math.min(n - 1, Math.floor(x))
    return v[i]! + (v[i + 1]! - v[i]!) * (x - i)
  }
}

/** The arc distance of a track whose speed is `speed(t)` (from 0 at t = 0), integrated every DT. */
function integrate(n: number, d0: number, speed: (t: number) => number): (t: number) => number {
  const v: number[] = [d0]
  for (let i = 1; i <= n; i++) v.push(v[i - 1]! + ((speed((i - 1) * DT) + speed(i * DT)) / 2) * DT)
  return (t) => {
    const x = Math.min(n, Math.max(0, t / DT))
    const i = Math.min(n - 1, Math.floor(x))
    return v[i]! + (v[i + 1]! - v[i]!) * (x - i)
  }
}

/** A beat's window. */
interface Beat {
  preset: MotionPreset
  t0: number
}

/**
 * The chase: the runner first (label RUNNER), then the pursuers, as
 * upstream's `chaseRoutine` returns them.
 */
export function chaseOnTracks(spec: RoutineSpec, ctx: RoutineCtx, kit: ChaseKit): ChoreoEntitySpec[] {
  const n = Math.max(2, Math.min(6, Math.round(spec.performers)))
  const dur = spec.durationS
  const amplitude = spec.amplitude ?? 4
  const ending: ChaseEnding = spec.ending === 'escape' ? 'escape' : 'caught'
  const runnerSpeed = 5.2
  const length = Math.min(120, runnerSpeed * dur * 0.95)
  const path = pathOf(kit.serpentine(ctx, length, amplitude, spec.seed))
  const total = path.total
  const N = Math.max(2, Math.ceil(dur / DT))
  const rng = kit.mulberry32(spec.seed)
  const gap0 = 3.5
  const gapAt = (t: number): number => {
    const f = t / dur
    return ending === 'caught' ? gap0 * (1 - f * 0.92) : gap0 * (1 + f * 1.1)
  }
  // The beats at upstream's seeded times, kept apart and clear of the ending.
  const r1 = rng()
  const r2 = rng()
  const tEnd = Math.max(0, dur - ENDING)
  let beatT2 = Math.min(dur * (0.6 + r2 * 0.08), tEnd - BEAT - 0.1)
  let beatT1 = Math.min(dur * (0.3 + r1 * 0.08), beatT2 - BEAT - 0.3)
  if (beatT1 < 0.3) beatT1 = NaN
  if (beatT2 < 0.3 || (!Number.isNaN(beatT1) && beatT2 < beatT1 + BEAT)) beatT2 = NaN
  const vault = kit.motion('vault-obstacle')
  const skid = kit.motion('sprint-skid-stop')
  const stumble = kit.motion('stumble-trip')
  const fall = kit.motion('trip-and-fall-flat')
  const tackle = kit.motion('tackle-lunge')
  const hands = kit.motion('hands-on-hips')
  const caught = ending === 'caught' && !!fall && !!tackle

  // Each performer's body (what buildRoutine casts it as), for the runner's fall clip.
  const asset = (i: number): string => (i === 0 || i % 2 === 1 ? 'person.man' : 'person.woman')
  const bodyOf = (i: number): Body => ctx.bodies?.[i] ?? { assetId: spec.bodies ? spec.bodies[asset(i) === 'person.man' ? 0 : 1] : asset(i) }

  // ---- The runner's track ----
  // Upstream's runner speed (its arc distance total·(0.82 f + 0.13 f²), jog to run), braked by the skid and the fall.
  const v0 = (t: number): number => (total / dur) * (0.82 + (0.26 * t) / dur)
  const skidAt = (t: number): number => (Number.isNaN(beatT2) || !skid || t < beatT2 || t > beatT2 + BEAT ? 1 : 1 - (1 - SKID_LOW) * Math.sin((Math.PI * (t - beatT2)) / BEAT))
  // Caught: from the fall's start the runner slows to a stop by the landing (a keyframe body; a bot plays its clip's own travel).
  const fallLand = fall ? (fall.keyframes.find((kf) => (kf.move?.up ?? 0) <= -0.5)?.t ?? fall.duration) : 1
  const stopAt = (t: number): number => (!caught || t < tEnd ? 1 : clamp01(1 - (t - tEnd) / fallLand))
  const runArc = integrate(N, 0, (t) => v0(t) * skidAt(t) * stopAt(t))
  const fallStart = path.at(runArc(tEnd))
  const fallHeading = fallStart.heading
  const fallClip = caught ? motionClip('trip-and-fall-flat', bodyOf(0)) : null
  /** Where the runner is (world): on the path, or in the fall along its clip's travel. */
  const runnerPos = (t: number): XZ => {
    if (fallClip && t > tEnd) {
      const off = runTravel(fallClip.clip, bodyOf(0), fallClip.from ?? 0, (fallClip.from ?? 0) + Math.min(t - tEnd, fall!.duration), !!fallClip.mirror)
      const p = toWorld(off, { x: fallStart.x, y: 0, z: fallStart.z }, fallHeading, 1)
      return { x: p.x, z: p.z }
    }
    if (caught && t > tEnd) {
      // A keyframe body falls straight on from where the fall began.
      const fwd = forwardOf(fallHeading)
      const d = runArc(t) - runArc(tEnd)
      return { x: fallStart.x + fwd.x * d, z: fallStart.z + fwd.z * d }
    }
    return path.at(runArc(t))
  }
  /** The runner's progress along the path (its fall projected on the fall's heading). */
  const runnerArc = (t: number): number => {
    if (!caught || t <= tEnd) return runArc(t)
    const p = runnerPos(t)
    const fwd = forwardOf(fallHeading)
    return runArc(tEnd) + (p.x - fallStart.x) * fwd.x + (p.z - fallStart.z) * fwd.z
  }
  const runnerAt = sampled(N, runnerArc)

  // ---- The pursuers' tracks ----
  const tackleT = tEnd
  const contactT = tackleT + CONTACT
  /** The tackler's distance behind the runner: its gap, closing on contact to TACKLE_GAP. */
  const tackleGap = (t: number): number => {
    const g = gapAt(Math.min(t, contactT))
    return t <= contactT ? g : g + (TACKLE_GAP - g) * smooth((t - contactT) / 0.25)
  }
  const giveUp = skid
  const arcs: ((t: number) => number)[] = [runnerAt]
  for (let pi = 1; pi < n; pi++) {
    const lag = (pi - 1) * 1.6
    const ahead = arcs[pi - 1]!
    let base: (t: number) => number = (t) => runnerAt(t) - gapAt(t) - lag
    if (pi === 1 && caught) base = (t) => runnerAt(t) - (t < tackleT ? gapAt(t) : tackleGap(t))
    if (pi === 1 && ending === 'escape' && giveUp) {
      // Escape: the pursuer brakes to a stop over its give-up skid, then stands.
      const free = base
      const speed = (t: number): number => (free(t + DT) - free(Math.max(0, t - DT))) / (t < DT ? DT : 2 * DT)
      const stop = integrate(N, free(tEnd), (t) => speed(t + tEnd) * clamp01(1 - t / BEAT))
      base = (t) => (t <= tEnd ? free(t) : stop(t - tEnd))
    }
    const own = base
    const track = pi === 1 ? own : (t: number) => smin(own(t), ahead(t) - CHASE_SPACING, 1)
    arcs.push(sampled(N, track))
  }

  // ---- Marks ----
  const posOn = (i: number, t: number): XZ & { heading: number } => {
    if (i === 0) {
      const p = runnerPos(t)
      return { ...p, heading: caught && t > tEnd ? fallHeading : path.at(runArc(t)).heading }
    }
    if (i === 1 && caught && t > tackleT) {
      // The tackle: behind the runner along its fall, facing it.
      const r = runnerPos(t)
      const fwd = forwardOf(fallHeading)
      const g = tackleGap(t)
      return { x: r.x - fwd.x * g, z: r.z - fwd.z * g, heading: fallHeading }
    }
    return path.at(arcs[i]!(t))
  }
  /** Speed along the track (m/s), for the travel gait. */
  const speedOf = (i: number, t: number): number => {
    const a = posOn(i, Math.max(0, t - 0.05))
    const b = posOn(i, Math.min(dur, t + 0.05))
    return Math.hypot(b.x - a.x, b.z - a.z) / (Math.min(dur, t + 0.05) - Math.max(0, t - 0.05))
  }
  /**
   * A beat's keyframe poses on the track (no play: a bot keeps them). Over a
   * travel gait they ride it (the gait plays under them and grounds them, as
   * on a bot's run loop); a stand plays them as a posed move.
   */
  const ride = (marks: ChoreoMarkSpec[], i: number, preset: MotionPreset, t0: number, gait: GaitId): void => {
    const rides = gait !== 'stand'
    for (const kf of preset.keyframes) {
      const t = t0 + kf.t
      if (t > dur + 1e-6) break
      const p = posOn(i, t)
      const m: ChoreoMarkSpec = { time: t, position: { x: p.x, y: kf.move?.up ?? 0, z: p.z }, gait, easeIn: 0, easeOut: 0, hold: 0, joints: { ...kf.joints }, arriveHeading: p.heading }
      if (rides) m.ride = true
      else m.posedMove = true
      marks.push(m)
    }
  }
  /** Travel marks every STEP outside the beats' windows. */
  const travel = (marks: ChoreoMarkSpec[], i: number, beats: Beat[], until: number, gaitAt: (t: number) => GaitId): void => {
    const step = Math.max(STEP, dur / 100)
    const count = Math.max(1, Math.round(until / step))
    for (let s = 0; s <= count; s++) {
      const t = (s / count) * until
      if (beats.some((b) => t > b.t0 - 1e-6 && t < b.t0 + b.preset.duration + 1e-6)) continue
      const p = posOn(i, t)
      const v = speedOf(i, t)
      const gait: GaitId = v < 0.3 ? 'stand' : v < 2.2 ? 'walk' : gaitAt(t)
      marks.push({ time: t, position: { x: p.x, y: 0, z: p.z }, gait, easeIn: 0, easeOut: s === 0 ? 0.2 : 0, hold: 0, arriveHeading: p.heading })
    }
  }

  const out: ChoreoEntitySpec[] = []
  // Runner: the vault at beat 1, the skid at beat 2, the fall when caught.
  {
    const marks: ChoreoMarkSpec[] = []
    const beats: Beat[] = []
    if (vault && !Number.isNaN(beatT1)) beats.push({ preset: vault, t0: beatT1 })
    if (skid && !Number.isNaN(beatT2)) beats.push({ preset: skid, t0: beatT2 })
    // Travel first: a beat's mark at the same time replaces a travel mark (dedupeSort keeps the later).
    travel(marks, 0, beats, caught ? tEnd : dur, (t) => (t / dur < 0.35 ? 'jog' : 'run'))
    for (const b of beats) ride(marks, 0, b.preset, b.t0, 'run')
    if (caught) {
      // The fall: one play (a bot plays its clip from here, along its own travel); a keyframe body slows to a stop on the line.
      const from = marks.length
      kit.playMotion(marks, fall!, { x: fallStart.x, y: 0, z: fallStart.z }, tEnd, { facing: fallHeading })
      for (const m of marks.slice(from)) {
        const p = runnerPos(m.time)
        m.position = { x: p.x, y: m.position.y, z: p.z }
      }
    }
    const start = posOn(0, 0)
    out.push({
      assetId: 'person.man',
      name: 'Runner',
      position: { x: start.x, y: 0, z: start.z },
      rotationY: start.heading,
      label: { text: 'RUNNER', color: '#e5484d' },
      marks: kit.dedupeSort(marks)
    })
  }
  // Pursuers: the first stumbles at beat 1, skids with the runner at beat 2, then tackles (caught) or gives up (escape).
  for (let pi = 1; pi < n; pi++) {
    const marks: ChoreoMarkSpec[] = []
    const beats: Beat[] = []
    if (pi === 1) {
      if (stumble && !Number.isNaN(beatT1)) beats.push({ preset: stumble, t0: beatT1 })
      if (skid && !Number.isNaN(beatT2)) beats.push({ preset: skid, t0: beatT2 })
    }
    const gives = pi === 1 && !caught && ending === 'escape' && !!giveUp
    travel(marks, pi, beats, (pi === 1 && caught) || gives ? tEnd : dur, () => 'run')
    for (const b of beats) ride(marks, pi, b.preset, b.t0, 'run')
    if (pi === 1 && caught) ride(marks, pi, tackle!, tackleT, 'stand')
    else if (gives) {
      ride(marks, pi, giveUp!, tEnd, 'run')
      if (hands) ride(marks, pi, hands, tEnd + giveUp!.duration, 'stand')
    }
    const start = posOn(pi, 0)
    out.push({
      assetId: asset(pi),
      name: n > 2 ? `Pursuer ${pi}` : 'Pursuer',
      position: { x: start.x, y: 0, z: start.z },
      rotationY: start.heading,
      marks: kit.dedupeSort(marks)
    })
  }
  return out
}
