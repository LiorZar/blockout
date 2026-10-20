/**
 * The motion library on mocap bots (fork addition; see MODIFICATIONS.md):
 * which library clip plays each motion preset on a loaded bot, the clips
 * with no preset (dances, guns, phone …) as motions of their own
 * (`mocap-<clip>`), and the clip runs that lay them down as marks: two
 * marks per run (clip time running between them), on the floor, facing the
 * performer's heading, a root-motion clip's marks along its own travel.
 * Upstream's `MOTION_PRESETS` stays as it is; everything that isn't a
 * loaded bot keeps the keyframe motion.
 *
 * PURE: no DOM / three.js / Electron. The table is data about the user's
 * local library (clip keys), not Mixamo data.
 */

import { assetSpec } from '../assets'
import type { Body } from '../floor'
import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, toWorld } from '../skeleton'
import type { Entity, MarkClip, V3 } from '../types'
import { clipRoot, clipScale, mocapClip } from './clip'
import { BLEND } from './clip-marks'
import { clipDistance, clipWarp } from './gait-clips'
import { isMocapAsset } from './registry'

/** A preset's clip: from `from` (s) for the preset's length, mirrored on request. */
export interface PresetClip {
  clip: string
  from?: number
  mirror?: boolean
}

/** Motion presets (motions.ts ids) and the library clip each plays on a bot. */
export const PRESET_CLIPS: Record<string, PresetClip> = {
  // fight (apply_motion; the Fight Director keeps its keyframe moves until phase 3)
  'jab-cross': { clip: 'jabHead' },
  uppercut: { clip: 'uppercut' },
  'high-kick': { clip: 'roundhouse' },
  haymaker: { clip: 'haymaker' },
  'knocked-down': { clip: 'knockedDown' },
  'roundhouse-kick': { clip: 'roundhouse' },
  'boxing-guard-bounce': { clip: 'fightIdle' },
  'hook-punch': { clip: 'hookHead' },
  'elbow-strike': { clip: 'elbow' },
  'knee-strike': { clip: 'knee' },
  'front-kick': { clip: 'frontKick' },
  'side-kick': { clip: 'sideKick' },
  'block-high': { clip: 'blockHead' },
  'block-low': { clip: 'blockBody' },
  'stagger-back': { clip: 'shoveReact' },
  'knockdown-fall': { clip: 'knockedDown' },
  'ko-collapse': { clip: 'koBack' },
  'get-up-from-ground': { clip: 'getUpBack' },
  'sword-slash-combo': { clip: 'swordSlash' },
  'sword-parry': { clip: 'swordBlock' },
  'shield-brace': { clip: 'swordBlock' },
  'knife-lunge': { clip: 'knifeStab' },
  'pistol-aim-fire': { clip: 'pistolFire' },
  'rifle-aim-sweep': { clip: 'rifleAim' },
  'boxing-combo': { clip: 'cross' },
  // stunt
  'hit-reaction-head': { clip: 'hitHeadBig' },
  'hit-reaction-body': { clip: 'hitStomach' },
  'stumble-back-fall': { clip: 'slipFall' },
  'fall-backwards': { clip: 'fallBack' },
  'freefall-flail': { clip: 'fallIdle' },
  crawl: { clip: 'crawl' },
  jump: { clip: 'jump' },
  'stumble-trip': { clip: 'trip' },
  'trip-and-fall-flat': { clip: 'trip' },
  'thrown-backward': { clip: 'koBack' },
  'blown-back-explosion': { clip: 'fallBack' },
  'climb-up-ledge': { clip: 'climb' },
  'crawl-fast-military': { clip: 'crawl' },
  cartwheel: { clip: 'cartwheel' },
  // dance
  'hip-hop-bounce': { clip: 'danceHipHop' },
  'salsa-step': { clip: 'danceSalsa' },
  twist: { clip: 'danceTwist' },
  charleston: { clip: 'danceSwing' },
  'freestyle-dance': { clip: 'danceHouse' },
  'running-man': { clip: 'danceRunningMan' },
  'shuffle-step': { clip: 'danceShuffle' },
  'top-rock': { clip: 'danceUprock' },
  'hip-sway-groove': { clip: 'danceSamba' },
  'groove-loop': { clip: 'danceKickStep' },
  // gesture / everyday / sport
  wave: { clip: 'wave' },
  'big-wave': { clip: 'wave' },
  'hail-taxi': { clip: 'wave' },
  clap: { clip: 'clap' },
  'slow-clap': { clip: 'clap' },
  applause: { clip: 'clap' },
  'point-ahead': { clip: 'point' },
  'cheer-jump': { clip: 'cheer' },
  'fist-pump': { clip: 'cheer' },
  'goal-celebration': { clip: 'cheer' },
  'thinking-chin': { clip: 'think' },
  'sit-down': { clip: 'standToSit' },
  'stand-up': { clip: 'sitToStand' },
  'phone-call': { clip: 'phone' },
  texting: { clip: 'texting' },
  'throw-overhand': { clip: 'throw' },
  'soccer-kicks': { clip: 'kickBall' },
  'soccer-kick': { clip: 'kickBall' },
  'kneel-tie-shoe': { clip: 'kneelDown' },
  'push-ups': { clip: 'pushUp' },
  'boxing-bounce-drill': { clip: 'boxIdle' }
}

/** Clips with no preset, as motions of their own (`mocap-<clip>`). */
export const CLIP_MOTIONS: { clip: string; name: string; category: MotionPreset['category'] }[] = [
  { clip: 'sprint', name: 'Sprint', category: 'sport' },
  { clip: 'sneak', name: 'Sneak forward', category: 'everyday' },
  { clip: 'drunkWalk', name: 'Drunk walk', category: 'everyday' },
  { clip: 'kneelIdle', name: 'Kneel (hold)', category: 'everyday' },
  { clip: 'kneelUp', name: 'Stand up from a kneel', category: 'everyday' },
  { clip: 'sitFloor', name: 'Sit on the floor', category: 'everyday' },
  { clip: 'sitChair', name: 'Sit in a chair', category: 'everyday' },
  { clip: 'lieIdle', name: 'Lie on the back', category: 'everyday' },
  { clip: 'talk', name: 'Talk', category: 'gesture' },
  { clip: 'idle', name: 'Breathe (idle)', category: 'gesture' },
  { clip: 'turnLeft', name: 'Turn left', category: 'everyday' },
  { clip: 'turnRight', name: 'Turn right', category: 'everyday' },
  { clip: 'pickUp', name: 'Pick up an object', category: 'everyday' },
  { clip: 'getUpStomach', name: 'Get up from the stomach', category: 'stunt' },
  { clip: 'fallFlat', name: 'Fall flat on the face', category: 'stunt' },
  { clip: 'backflip', name: 'Backflip', category: 'stunt' },
  { clip: 'rifleIdle', name: 'Rifle at low ready', category: 'fight' },
  { clip: 'rifleFire', name: 'Fire a rifle', category: 'fight' },
  { clip: 'pistolIdle', name: 'Pistol at the ready', category: 'fight' },
  { clip: 'pistolAim', name: 'Aim a pistol', category: 'fight' },
  { clip: 'jabBody', name: 'Jab to the body', category: 'fight' },
  { clip: 'hookBody', name: 'Hook to the body', category: 'fight' },
  { clip: 'lowKick', name: 'Low kick', category: 'fight' },
  { clip: 'headbutt', name: 'Headbutt', category: 'fight' },
  { clip: 'hitHeadLeft', name: 'Hit in the head (from the left)', category: 'stunt' },
  { clip: 'hitHeadRight', name: 'Hit in the head (from the right)', category: 'stunt' },
  { clip: 'hitSide', name: 'Big hit to the side', category: 'stunt' },
  { clip: 'hitUppercut', name: 'Take an uppercut', category: 'stunt' },
  { clip: 'koStomach', name: 'Knocked out onto the stomach', category: 'stunt' },
  { clip: 'getUpKnockdown', name: 'Get up after a knockdown', category: 'stunt' },
  { clip: 'swordBlocked', name: 'Sword blocked', category: 'fight' },
  { clip: 'greatSword', name: 'Great sword slash', category: 'fight' },
  { clip: 'heavySwing', name: 'Heavy weapon swing', category: 'fight' },
  { clip: 'dodge', name: 'Dodge back', category: 'fight' }
]

/** The id prefix of a clip's own motion. */
export const CLIP_MOTION_PREFIX = 'mocap-'

/** A clip's own motion, as a preset (no keyframes: it only plays on a loaded bot). */
export function clipMotionPreset(id: string): MotionPreset | undefined {
  const m = CLIP_MOTIONS.find((x) => CLIP_MOTION_PREFIX + x.clip === id)
  const c = m && mocapClip(m.clip)
  return m && c ? { id, name: m.name, category: m.category, duration: Math.round(c.duration * 100) / 100, loop: c.loop, keyframes: [] } : undefined
}

/** The clips' own motions on offer now (their clips loaded). */
export function clipMotionPresets(): MotionPreset[] {
  return CLIP_MOTIONS.map((m) => clipMotionPreset(CLIP_MOTION_PREFIX + m.clip)).filter((p): p is MotionPreset => !!p)
}

/** Whether a motion plays a library clip on a loaded bot (a mapped preset whose clip loaded, or a clip's own). */
export function motionHasClip(id: string): boolean {
  const spec = id.startsWith(CLIP_MOTION_PREFIX) ? { clip: id.slice(CLIP_MOTION_PREFIX.length) } : PRESET_CLIPS[id]
  return !!spec && !!mocapClip(spec.clip)
}

/** Whether a body plays library clips: a loaded mocap bot. */
export function playsClips(body: Body | undefined): body is Body {
  return !!body && isMocapAsset(body.assetId) && !!personDims(body.assetId, body.params).mocap
}

/** The clip a motion plays on a body, or null (not a loaded bot, or no clip for it in the library). */
export function motionClip(id: string, body: Body | undefined): PresetClip | null {
  if (!playsClips(body)) return null
  const spec = id.startsWith(CLIP_MOTION_PREFIX) ? { clip: id.slice(CLIP_MOTION_PREFIX.length) } : PRESET_CLIPS[id]
  return spec && mocapClip(spec.clip) ? spec : null
}

/** One clip-run mark (the fields sequences.ts and choreography.ts marks share). */
export interface ClipRunMark {
  time: number
  position: V3
  gait: 'stand'
  easeIn: number
  easeOut: number
  hold: number
  arriveHeading: number
  posedMove: true
  clip: MarkClip
}

/**
 * How far a run of a clip carries a bot from clip time `a` to `b`, in its
 * own frame (facing −Z): a root-motion clip by its hips track, an in-place
 * travelling loop by its contacts (the warp's distance, `gait-clips.ts`).
 */
export function runTravel(clipId: string, body: Body, a: number, b: number, mirror = false): V3 {
  const clip = mocapClip(clipId)!
  const m = personDims(body.assetId, body.params).mocap!
  const scale = body.scale ?? 1
  if (!clip.inPlace) {
    const k = clipScale(m, clip.hipH) * scale
    const ra = clipRoot(clip, a, mirror)
    const rb = clipRoot(clip, b, mirror)
    return { x: (rb.x - ra.x) * k, y: 0, z: (rb.z - ra.z) * k }
  }
  const warp = clipWarp(m, clip, body.assetId)
  return warp ? { x: 0, y: 0, z: -(clipDistance(clip, warp, b) - clipDistance(clip, warp, a)) * m.k * scale } : { x: 0, y: 0, z: 0 }
}

/**
 * A clip run as marks: the clip from `spec.from` starting at `startT`, for
 * the span to `endT` (a loop fills it; a one-shot plays out and holds its
 * last frame). Two marks on the floor at `pos.y`, facing `heading`, the
 * second along the run's travel (`runTravel`).
 */
export function clipRun(spec: PresetClip, body: Body, pos: V3, heading: number, startT: number, endT: number, mirror = false): ClipRunMark[] {
  const clip = mocapClip(spec.clip)!
  const from = spec.from ?? 0
  const len = Math.max(1 / clip.fps, clip.loop ? endT - startT : Math.min(endT - startT, clip.duration - from))
  const flip = !!spec.mirror !== mirror
  const travel = runTravel(spec.clip, body, from, from + len, flip)
  const at = (t: number, p: V3, a: number): ClipRunMark => ({
    time: Math.round(t * 1e6) / 1e6,
    position: p,
    gait: 'stand',
    easeIn: 0,
    easeOut: 0,
    hold: 0,
    arriveHeading: heading,
    posedMove: true,
    clip: flip ? { id: spec.clip, at: a, mirror: true } : { id: spec.clip, at: a }
  })
  return [at(startT, { ...pos }, from), at(startT + len, toWorld(travel, pos, heading, 1), from + len)]
}

/** End a run's last leg a moment early (its own travel to the new end), so the run after it crossfades in. */
function endEarly(start: ClipRunMark, end: ClipRunMark, body: Body): void {
  const d = Math.min(BLEND, (end.time - start.time) / 2)
  end.time = Math.round((end.time - d) * 1e6) / 1e6
  end.clip = { ...end.clip, at: end.clip.at - d }
  const p = toWorld(runTravel(end.clip.id, body, start.clip.at, end.clip.at, end.clip.mirror), start.position, start.arriveHeading, 1)
  end.position = { x: p.x, y: end.position.y, z: p.z }
}

/**
 * A motion on a loaded bot as clip runs filling [startT, endT] (the
 * sit-down by its seat, `sitRun`), or null (keep the keyframe motion).
 */
export function motionRun(id: string, body: Body | undefined, pos: V3, heading: number, startT: number, endT: number, mirror = false, seats: readonly SeatSpot[] = []): ClipRunMark[] | null {
  const sit = id === SIT_DOWN && playsClips(body) ? sitRun(body, pos, heading, startT, endT, seats) : null
  if (sit) return sit
  const spec = motionClip(id, body)
  return spec ? clipRun(spec, body!, pos, heading, startT, endT, mirror) : null
}

/** A motion on a loaded bot filling [startT, startT + duration], or null (keep the keyframe motion): `apply_motion`'s path. */
export function clipMotion(id: string, body: Body | undefined, pos: V3, heading: number, duration: number, startT = 0, mirror = false, seats: readonly SeatSpot[] = []): ClipRunMark[] | null {
  return motionRun(id, body, pos, heading, startT, startT + duration, mirror, seats)
}

/* --------------------------------- seats -------------------------------- */

/** Catalog props a bot sits on: over one, a sit is a chair sit; elsewhere it sits on the floor. */
export const SEAT_ASSETS: ReadonlySet<string> = new Set([
  'furniture.chair',
  'furniture.stool',
  'furniture.armchair',
  'furniture.couch',
  'furniture.officeChair',
  'furniture.wheelchair',
  'furniture.toilet',
  'prop.bench',
  'prop.poolLounger'
])

/** A seat prop where it stands. */
export interface SeatSpot {
  assetId: string
  position: V3
  scale: number
}

/** A scene's seat props, where they stand (`at`: an entity's position at the moment, when known). */
export function seatSpots(entities: readonly Entity[], at?: (entityId: string) => V3 | undefined): SeatSpot[] {
  return entities
    .filter((e) => SEAT_ASSETS.has(e.assetId))
    .map((e) => ({ assetId: e.assetId, position: at?.(e.id) ?? e.transform.position, scale: e.transform.scale }))
}

/** Seats more than this above or below a point are on another floor (m). */
const SEAT_FLOOR = 0.5

/** The seat prop under a point (the hips): one whose catalog footprint (× its scale) covers it, on the same floor. */
export function seatUnder(seats: readonly SeatSpot[], p: V3): SeatSpot | undefined {
  return seats.find((s) => Math.abs(s.position.y - p.y) < SEAT_FLOOR && Math.hypot(s.position.x - p.x, s.position.z - p.z) <= assetSpec(s.assetId).footprint * s.scale)
}

const SIT_DOWN = 'sit-down'

/**
 * The sit-down on a bot: over a seat prop (under the hips, or where the
 * stand-to-sit sets them down) it stands, sits back onto it, laid so the
 * hips land where the seat takes them, and the chair idle fills the rest;
 * anywhere else it sits on the floor. Null without those clips.
 */
function sitRun(body: Body, pos: V3, heading: number, startT: number, endT: number, seats: readonly SeatSpot[]): ClipRunMark[] | null {
  const into = mocapClip('standToSit')
  if (into) {
    const back = runTravel(into.id, body, 0, into.duration)
    const landing = toWorld(back, pos, heading, 1)
    const start = seatUnder(seats, pos) ? toWorld({ x: -back.x, y: 0, z: -back.z }, pos, heading, 1) : seatUnder(seats, landing) ? pos : null
    if (start) {
      const run = clipRun({ clip: into.id }, body, { ...start, y: pos.y }, heading, startT, endT)
      const end = run[1]!
      if (!mocapClip('sitChair') || endT - end.time <= BLEND) return run
      const idle = clipRun({ clip: 'sitChair' }, body, { ...end.position }, heading, end.time, endT)
      endEarly(run[0]!, end, body)
      return [...run, ...idle]
    }
  }
  return mocapClip('sitFloor') ? clipRun({ clip: 'sitFloor' }, body, pos, heading, startT, endT) : null
}

/** A motion's name for prompts and lists: its preset's, or the clip's own. */
export function clipMotionName(clipId: string): MotionPreset | undefined {
  const preset = Object.entries(PRESET_CLIPS).find(([, s]) => s.clip === clipId)?.[0]
  return (preset && MOTION_PRESETS.find((p) => p.id === preset)) || clipMotionPreset(CLIP_MOTION_PREFIX + clipId)
}

/* ------------------------- routines and sequences ------------------------ */

/** One play of a preset, as a routine or sequence laid it down (keyframes). */
export interface MotionPlay {
  presetId: string
  pos: V3
  /** Absent: the performer's own heading. */
  heading?: number
  startT: number
  endT: number
  mirror?: boolean
}

const PLAYS = new WeakMap<object, MotionPlay>()

/** Remember which play a keyframe mark belongs to (routines and sequences lay plays before they know the bodies). */
export function tagPlay<T extends object>(play: MotionPlay, mark: T): T {
  PLAYS.set(mark, play)
  return mark
}

/** A copy of a mark keeps its play. */
export function copyTag<T extends object>(from: object, to: T): T {
  const play = PLAYS.get(from)
  if (play) PLAYS.set(to, play)
  return to
}

/**
 * A performer's marks with every tagged play whose preset has a clip
 * replaced by its clip run, when the body is a loaded bot; else the marks
 * unchanged. Strikes and blocks (the fight category) keep their keyframes:
 * a routine's exchanges are timed on them (the Fight Director's moves come
 * with phase 3); reactions, falls and get-ups play their clips.
 */
export function clipPlays<M extends { time: number }>(marks: M[], body: Body, heading = 0): (M | ClipRunMark)[] {
  if (!playsClips(body)) return marks
  const out: (M | ClipRunMark)[] = []
  for (let i = 0; i < marks.length; ) {
    const play = PLAYS.get(marks[i]!)
    const fight = MOTION_PRESETS.find((p) => p.id === play?.presetId)?.category === 'fight'
    const run = play && !fight ? motionRun(play.presetId, body, play.pos, play.heading ?? heading, play.startT, play.endT, play.mirror) : null
    if (!play || !run) {
      out.push(marks[i]!)
      i++
      continue
    }
    while (i < marks.length && PLAYS.get(marks[i]!) === play) i++
    // A run that starts as the last one ends: the last ends a moment early, so the two crossfade.
    const prev = out[out.length - 1] as ClipRunMark | undefined
    const prevStart = out[out.length - 2] as ClipRunMark | undefined
    if (prev?.clip && prevStart?.clip && prev.time >= run[0]!.time - 1e-6) endEarly(prevStart, prev, body)
    out.push(...run)
  }
  return out
}
