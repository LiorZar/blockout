/**
 * Mocap clips on actor marks (fork addition; see MODIFICATIONS.md): what a
 * performer's `clip` marks mean at time t, for the evaluator (`evaluate.ts`).
 *
 * - Between two marks on the same clip (and mirror), the second's `at` not
 *   before the first's (a run), the clip time runs linearly from one mark's
 *   `at` to the other's; an in-place travelling loop on a bot (a crawl, a
 *   sneak) runs it on the distance covered through the clip's warp
 *   (`gait-clips.ts`), so its planted contacts stay put; a clip starting
 *   over crossfades instead. A root-motion clip moves
 *   the performer by its hips track (turned to its heading, scaled to the
 *   bot) on top of the marks' line, so marks laid along the clip's own
 *   travel play it exactly and a moved mark spreads the difference.
 * - A held clip mark holds its pose; so do the times before the first and
 *   after the last mark.
 * - A posed leg (both marks `posedMove`) between different clips, or from a
 *   clip to no clip, crossfades over the leg. A travel leg (a walk to the
 *   next clip) blends the clip in over its last `BLEND` seconds, or out over
 *   its first.
 * - A clip mark's y is the floor under it. On a posed leg touching one, the
 *   performer's y runs on the floor line (a mark without a clip stands on
 *   its lowest point); the clip pose itself is grounded (`clip.ts`).
 * - Fork (qa-fixes): where a bot's posed clip legs travel or turn past the
 *   clips' own root travel (`stepLegs`: a run of one clip whose marks move
 *   the root further, each crossfade between two clips on its own), the
 *   clip state carries the window's travel and turn, done and in all, and
 *   its progress (`ClipState.step`): the pose steps the feet over it
 *   (`footwork.ts`).
 *
 * Every non-bot body ignores the clip (it holds the marks' joints).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { lerp, lerpAngle, smoothstep } from '../easing'
import { bodyLowY } from '../floor'
import { personDims, toWorld } from '../skeleton'
import type { ActorMark, ClipState, Entity, MarkClip, Scene, V3 } from '../types'
import { clipRoot, clipScale, mocapClip, mocapClipPose, mocapClipVersion, type MocapClip } from './clip'
import type { MocapDims, MocapPose } from './fk'
import { LOW, MAX_STEP } from './footwork'
import { clipDistance, clipWarp, gaitClipTime } from './gait-clips'
import { BONE_INDEX } from './rig'

/** Seconds a travel leg takes to blend a clip in or out. */
export const BLEND = 0.25

/** A leg of a track (`evaluate.ts`'s, the parts used here). */
export interface TrackLeg {
  from: ActorMark
  to: ActorMark
  departTime: number
  arriveTime: number
}

/** Where the evaluator is on a track (`evaluateTrack`'s answer, the parts used here). */
export interface TrackPoint {
  leg: TrackLeg | null
  atMark: ActorMark | null
  /** Linear progress over the leg (0..1). */
  legProgress: number
}

const ref = (c: MarkClip): { id: string; t: number; mirror?: boolean; seat?: number } => ({ id: c.id, t: c.at, ...(c.mirror ? { mirror: true } : {}), ...(c.seat !== undefined ? { seat: c.seat } : {}) })

/** Two marks of one clip run: the same clip and mirror, its time going forward. */
const sameClip = (a: MarkClip | undefined, b: MarkClip | undefined): a is MarkClip => !!a && !!b && a.id === b.id && !!a.mirror === !!b.mirror && b.at >= a.at

/**
 * A run's clip time at a point of its leg: linear in time, or for an
 * in-place travelling loop on a bot at the distance covered (`u`, the eased
 * progress the body travels by) through the clip's warp.
 */
function runTime(a: MarkClip, b: MarkClip, p: TrackPoint, u: number, entity?: Entity): number {
  const clip = mocapClip(a.id)
  const m = entity && clip?.inPlace ? personDims(entity.assetId, entity.params).mocap : undefined
  const warp = m && clip ? clipWarp(m, clip, entity!.assetId) : null
  if (!warp || !clip) return lerp(a.at, b.at, p.legProgress)
  return gaitClipTime(clip, warp, lerp(clipDistance(clip, warp, a.at), clipDistance(clip, warp, b.at), u), 0)
}

/**
 * The clip state of a track point, or undefined when no clip plays. `u` is
 * the leg's eased progress; `entity` the performer (its warp); `legs` its
 * track's legs (a bot's footwork windows).
 */
export function clipStateAt(p: TrackPoint, t: number, u: number, entity?: Entity, legs?: readonly TrackLeg[]): ClipState | undefined {
  const leg = p.leg
  if (!leg) return p.atMark?.clip ? ref(p.atMark.clip) : undefined
  const { from, to } = leg
  if (!from.clip && !to.clip) return undefined
  // Fork (qa-fixes): the feet step over root travel the clips don't make.
  const step = legs && entity ? stepAt(stepLegs(legs, entity).get(leg), p, u, entity.transform.scale) : undefined
  if (sameClip(from.clip, to.clip)) return { ...ref(from.clip), t: runTime(from.clip, to.clip!, p, u, entity), ...(step ? { step } : {}) }
  if (from.posedMove && to.posedMove) {
    if (to.clip) return { ...ref(to.clip), w: u, ...(from.clip ? { from: ref(from.clip) } : {}), ...(step ? { step } : {}) }
    return { ...ref(from.clip!), w: 1 - u }
  }
  const span = Math.min(BLEND, leg.arriveTime - leg.departTime)
  if (span <= 0) return undefined
  if (to.clip && leg.arriveTime - t < span) return { ...ref(to.clip), w: smoothstep(1 - (leg.arriveTime - t) / span) }
  if (from.clip && t - leg.departTime < span) return { ...ref(from.clip), w: 1 - smoothstep((t - leg.departTime) / span) }
  return undefined
}

/**
 * Where a performer stands on a clip leg: the root travel of a root-motion
 * clip on a same-clip leg, and the floor line on any posed leg touching a
 * clip mark. `position` is the evaluator's (on the marks' path); returns it
 * unchanged elsewhere.
 */
export function clipPosition(entity: Entity, p: TrackPoint, u: number, heading: number, position: V3): V3 {
  const leg = p.leg
  if (!leg || !(leg.from.clip || leg.to.clip) || !(leg.from.posedMove && leg.to.posedMove)) return position
  const { from, to } = leg
  const body = { assetId: entity.assetId, params: entity.params, scale: entity.transform.scale }
  const floor = (m: ActorMark): number => (m.clip ? m.position.y : m.position.y + bodyLowY(body, m.joints))
  let out: V3 = { ...position, y: lerp(floor(from), floor(to), sameClip(from.clip, to.clip) ? p.legProgress : u) }
  if (sameClip(from.clip, to.clip)) {
    const clip = mocapClip(from.clip.id)
    const m = personDims(entity.assetId, entity.params).mocap
    if (clip && !clip.inPlace && m) {
      const k = clipScale(m, clip.hipH) * entity.transform.scale
      const mirror = !!from.clip.mirror
      const a = clipRoot(clip, from.clip.at, mirror)
      const b = clipRoot(clip, to.clip!.at, mirror)
      const r = clipRoot(clip, lerp(from.clip.at, to.clip!.at, p.legProgress), mirror)
      const d = { x: (r.x - lerp(a.x, b.x, p.legProgress)) * k, y: 0, z: (r.z - lerp(a.z, b.z, p.legProgress)) * k }
      out = toWorld(d, out, heading, 1)
    }
  }
  return out
}

/** How far a turn of the body moves a foot, per radian (m: a foot's distance from the root). */
const FOOT_R = 0.2

/** Travel under this in a leg is none (m); a window travelling under WINDOW_MIN keeps its slide. */
const NO_TRAVEL = 1e-3
const WINDOW_MIN = 0.03

type XZ = { x: number; z: number }

/** A window of travel past the clips: in all (world metres), the steps each foot takes, and the foot stepping first. */
interface StepWindow {
  E: XZ
  A: number
  n: number
  lead: 0 | 1
}

/**
 * A leg of a footwork window: the window, the travel and turn done before
 * the leg, the marks' travel over it, its clip's root travel (world metres,
 * body frame), its headings, and its share of the window.
 */
interface StepLeg {
  win: StepWindow
  e0: XZ
  a0: number
  dm: XZ
  dr: XZ
  ha: number
  hb: number
  s0: number
  s1: number
}

const STEP_LEGS = new WeakMap<readonly TrackLeg[], Map<TrackLeg, StepLeg>>()

const HIPS = new WeakMap<MocapDims['rig'], Map<string, Float64Array>>()

/** A clip's grounded hips height per frame over the bot's rest hips (remembered per rig and registration). */
function hipsShare(m: MocapDims, clip: MocapClip): Float64Array {
  let byClip = HIPS.get(m.rig)
  if (!byClip) HIPS.set(m.rig, (byClip = new Map()))
  const key = `${clip.id}|${mocapClipVersion()}`
  let out = byClip.get(key)
  if (!out) {
    const rest = m.rig.rest[BONE_INDEX.Hips]!.y * m.k
    out = Float64Array.from({ length: clip.frames }, (_, f) => (mocapClipPose(m, { id: clip.id, t: f / clip.fps })?.P[BONE_INDEX.Hips]!.y ?? rest) / rest)
    byClip.set(key, out)
  }
  return out
}

/** Whether a clip brings the body down (its hips under LOW of their rest height) between clip times a and b. */
function goesDown(m: MocapDims, clip: MocapClip, a: number, b: number): boolean {
  const h = hipsShare(m, clip)
  const all = clip.loop && b - a >= clip.duration
  const wrap = (t: number): number => (clip.loop && clip.duration > 0 ? t - Math.floor(t / clip.duration) * clip.duration : Math.min(clip.duration, Math.max(0, t)))
  const fa = Math.floor(wrap(a) * clip.fps)
  const fb = Math.ceil(wrap(b) * clip.fps)
  for (let f = 0; f < clip.frames; f++) {
    const inside = all || (fa <= fb ? f >= fa && f <= fb : f >= fa || f <= fb)
    if (inside && h[f]! < LOW) return true
  }
  return false
}

/** A body-frame vector turned to a heading (`toWorld`'s turn); a negative heading turns it back. */
const turnXZ = (v: XZ, h: number): XZ => ({ x: v.x * Math.cos(h) + v.z * Math.sin(h), z: -v.x * Math.sin(h) + v.z * Math.cos(h) })

/**
 * A bot track's footwork windows, by leg: runs of posed legs between clip
 * marks whose marks travel or turn the root past the clip's own root travel
 * (a run broken where nothing moves or the travel turns back), and each
 * crossfade between two clips on its own. Remembered per legs array (built
 * once per evaluator).
 */
function stepLegs(legs: readonly TrackLeg[], entity: Entity): Map<TrackLeg, StepLeg> {
  const known = STEP_LEGS.get(legs)
  if (known) return known
  const map = new Map<TrackLeg, StepLeg>()
  STEP_LEGS.set(legs, map)
  const m = personDims(entity.assetId, entity.params).mocap
  if (!m) return map
  const scale = entity.transform.scale
  type Part = { leg: TrackLeg; de: XZ; da: number; w: number; dm: XZ; dr: XZ; ha: number; hb: number; cross: boolean; down: boolean }
  let run: Part[] = []
  const close = (): void => {
    if (run.length === 0) return
    // A window through a fall (a knockdown, a KO) keeps its slide: a falling body doesn't step.
    if (run.some((q) => q.down)) {
      run = []
      return
    }
    const E = run.reduce((acc, q) => ({ x: acc.x + q.de.x, z: acc.z + q.de.z }), { x: 0, z: 0 })
    const A = run.reduce((acc, q) => acc + q.da, 0)
    const travel = Math.hypot(E.x, E.z) + FOOT_R * Math.abs(A)
    const total = run.reduce((acc, q) => acc + q.w, 0)
    const feet = run[0]!.cross || travel >= WINDOW_MIN ? leadFoot(m, run[0]!.leg, turnXZ(E, -run[0]!.ha), scale) : null
    // A crossfade on the spot whose feet stay put has nothing to step.
    if (feet && (travel >= WINDOW_MIN || feet.moves >= WINDOW_MIN)) {
      const win: StepWindow = { E, A, n: Math.max(1, Math.ceil(travel / MAX_STEP)), lead: feet.lead }
      let e0: XZ = { x: 0, z: 0 }
      let a0 = 0
      let done = 0
      for (const q of run) {
        const s0 = total > 0 ? done / total : 0
        done += q.w
        map.set(q.leg, { win, e0, a0, dm: q.dm, dr: q.dr, ha: q.ha, hb: q.hb, s0, s1: total > 0 ? done / total : 1 })
        e0 = { x: e0.x + q.de.x, z: e0.z + q.de.z }
        a0 += q.da
      }
    }
    run = []
  }
  for (const leg of legs) {
    const { from, to } = leg
    const h0 = from.arriveHeading ?? to.arriveHeading
    const ca = from.clip ? mocapClip(from.clip.id) : undefined
    if (!from.clip || !to.clip || !from.posedMove || !to.posedMove || h0 === undefined || !ca || !mocapClip(to.clip.id)) {
      close()
      continue
    }
    const hb = to.arriveHeading ?? h0
    const dm = { x: to.position.x - from.position.x, z: to.position.z - from.position.z }
    const cross = !sameClip(from.clip, to.clip)
    // An in-place travelling loop (a crawl, a sneak) travels on its warp, its contacts planted (`gait-clips.ts`).
    if (!cross && ca.inPlace && clipWarp(m, ca, entity.assetId)) {
      close()
      continue
    }
    let dr: XZ = { x: 0, z: 0 }
    if (!cross && !ca.inPlace) {
      const k = clipScale(m, ca.hipH) * scale
      const a = clipRoot(ca, from.clip.at, !!from.clip.mirror)
      const b = clipRoot(ca, to.clip.at, !!from.clip.mirror)
      dr = { x: (b.x - a.x) * k, z: (b.z - a.z) * k }
    }
    const r = turnXZ(dr, hb)
    const de = { x: dm.x - r.x, z: dm.z - r.z }
    const da = lerpAngle(h0, hb, 1) - h0
    const w = Math.hypot(de.x, de.z) + FOOT_R * Math.abs(da)
    const cb = mocapClip(to.clip.id)!
    // A run of a clip that brings the body down anywhere (a knockdown, a get-up) is a fall all through; a crossfade, at its two poses.
    const down = cross ? goesDown(m, ca, from.clip.at, from.clip.at) || goesDown(m, cb, to.clip.at, to.clip.at) : ca.loop ? goesDown(m, ca, from.clip.at, to.clip.at) : goesDown(m, ca, 0, ca.duration)
    const part: Part = { leg, de, da, w, dm, dr, ha: h0, hb, cross, down }
    if (cross) {
      close()
      run = [part]
      close()
      continue
    }
    if (w < NO_TRAVEL) {
      close()
      continue
    }
    // The travel turning back starts a window of its own.
    const last = run[run.length - 1]
    if (last && (last.de.x * de.x + last.de.z * de.z < 0 || last.da * da < -1e-6)) close()
    run.push(part)
  }
  close()
  return map
}

/**
 * The foot stepping first over a window starting on `leg` (`E` its travel,
 * body frame at the start): travelling forward or back the front foot (a
 * fighter's nearer the opponent: a staggered body's front foot gets out of
 * the blow's way first), aside the one on that side; on the spot the one
 * going further between the two clips' poses. And the most a foot goes
 * between them.
 */
function leadFoot(m: MocapDims, leg: TrackLeg, E: XZ, scale: number): { lead: 0 | 1; moves: number } {
  const pose = (c: MarkClip): MocapPose | null => mocapClipPose(m, { id: c.id, t: c.at, ...(c.mirror ? { mirror: true } : {}) })
  const a = pose(leg.from.clip!)
  const b = pose(leg.to.clip!)
  if (!a || !b) return { lead: 0, moves: 0 }
  const ankles = [BONE_INDEX.LeftFoot, BONE_INDEX.RightFoot]
  // How far each foot goes between the two clips' poses (a run of one clip: the same pose, nowhere).
  const goes = ankles.map((i) => Math.hypot(b.P[i]!.x - a.P[i]!.x, b.P[i]!.z - a.P[i]!.z))
  const moves = sameClip(leg.from.clip, leg.to.clip) ? 0 : Math.max(...goes)
  if (Math.hypot(E.x, E.z) / scale > 0.01) {
    // Forward or back, the front foot (the one nearer an opponent); aside, the one on that side.
    const along = ankles.map((i) => a.P[i]!.x * E.x - a.P[i]!.z * Math.abs(E.z))
    return { lead: along[1]! > along[0]! ? 1 : 0, moves }
  }
  return { lead: goes[1]! > goes[0]! ? 1 : 0, moves }
}

/** The footwork at a point of a window's leg (undefined off windows): the window's travel and turn, done and in all, in the body's frame. */
function stepAt(sl: StepLeg | undefined, p: TrackPoint, u: number, scale: number): ClipState['step'] {
  if (!sl) return undefined
  const h = lerpAngle(sl.ha, sl.hb, u)
  const r = turnXZ(sl.dr, h)
  const e = { x: sl.e0.x + u * sl.dm.x - p.legProgress * r.x, z: sl.e0.z + u * sl.dm.z - p.legProgress * r.z }
  const local = (v: XZ): XZ => {
    const b = turnXZ(v, -h)
    return { x: b.x / scale, z: b.z / scale }
  }
  return { e: local(e), E: local(sl.win.E), a: sl.a0 + (h - sl.ha), A: sl.win.A, s: lerp(sl.s0, sl.s1, u), n: sl.win.n, lead: sl.win.lead }
}

/** Drop malformed `clip` fields from a loaded document's actor marks (never throws). */
export function sanitizeClipMarks(scene: Scene): void {
  const list = <T>(a: unknown): T[] => (Array.isArray(a) ? (a as T[]) : [])
  for (const take of list<Scene['blocking'][number]>(scene.blocking))
    for (const track of list<Scene['blocking'][number]['tracks'][number]>(take?.tracks))
      for (const m of list<ActorMark>(track?.marks)) {
        const c = (m as { clip?: unknown } | null)?.clip as Partial<MarkClip> | null | undefined
        if (c === undefined) continue
        if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || typeof c.at !== 'number' || !Number.isFinite(c.at)) delete m.clip
        else {
          if (c.mirror !== undefined && typeof c.mirror !== 'boolean') delete c.mirror
          // Fork (mocap-backlog): a seat top is a height in metres.
          if (c.seat !== undefined && !(typeof c.seat === 'number' && c.seat > 0 && c.seat < 5)) delete c.seat
          // Fork (set-routines): the motion a run stands for is a preset id.
          if (c.as !== undefined && (typeof c.as !== 'string' || !c.as)) delete c.as
        }
      }
}
