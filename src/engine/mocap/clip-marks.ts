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
 *
 * Every non-bot body ignores the clip (it holds the marks' joints).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { lerp, smoothstep } from '../easing'
import { bodyLowY } from '../floor'
import { personDims, toWorld } from '../skeleton'
import type { ActorMark, ClipState, Entity, MarkClip, Scene, V3 } from '../types'
import { clipRoot, clipScale, mocapClip } from './clip'
import { clipDistance, clipWarp, gaitClipTime } from './gait-clips'

/** Seconds a travel leg takes to blend a clip in or out. */
export const BLEND = 0.25

/** Where the evaluator is on a track (`evaluateTrack`'s answer, the parts used here). */
export interface TrackPoint {
  leg: { from: ActorMark; to: ActorMark; departTime: number; arriveTime: number } | null
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

/** The clip state of a track point, or undefined when no clip plays. `u` is the leg's eased progress; `entity` the performer (its warp). */
export function clipStateAt(p: TrackPoint, t: number, u: number, entity?: Entity): ClipState | undefined {
  const leg = p.leg
  if (!leg) return p.atMark?.clip ? ref(p.atMark.clip) : undefined
  const { from, to } = leg
  if (!from.clip && !to.clip) return undefined
  if (sameClip(from.clip, to.clip)) return { ...ref(from.clip), t: runTime(from.clip, to.clip!, p, u, entity) }
  if (from.posedMove && to.posedMove) {
    if (to.clip) return { ...ref(to.clip), w: u, ...(from.clip ? { from: ref(from.clip) } : {}) }
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
        }
      }
}
