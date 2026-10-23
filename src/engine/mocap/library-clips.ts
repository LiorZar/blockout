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
import { clipImpactTime, defenseClip, defenseReadyTime, fallLandTime, moveClips, reactionClip } from '../fight/clip-moves'
import { DEFENSES, strikeImpacts } from '../fight/moves'
import { defaultTarget } from '../fight/script'
import { bodyLowY, type Body } from '../floor'
import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, poseEffectors, toWorld } from '../skeleton'
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
export function motionRun(id: string, body: Body | undefined, pos: V3, heading: number, startT: number, endT: number, mirror = false, seats: readonly SeatSpot[] = [], from?: number, clip?: string): ClipRunMark[] | null {
  const sit = id === SIT_DOWN && playsClips(body) ? sitRun(body, pos, heading, startT, endT, seats) : null
  if (sit) return sit
  const spec = clip ? (playsClips(body) && mocapClip(clip) ? { clip } : null) : motionClip(id, body)
  return spec ? clipRun(from !== undefined ? { ...spec, from } : spec, body!, pos, heading, startT, endT, mirror) : null
}

/**
 * Fork (set-routines): where a fall clip picks up a body running at full
 * speed, by clip: both feet off the floor, the body pitching forward at about
 * a run's speed. The library's trip walks for 0.9 s, catches its foot and
 * dives from 1.0 s; played from the start after a run, its walk-in brakes the
 * runner to 1.5 m/s and its first pose is dragged along the street.
 */
export const RUN_FROM: Readonly<Record<string, number>> = { trip: 1.06 }

/** A motion on a loaded bot filling [startT, startT + duration], or null (keep the keyframe motion): `apply_motion`'s path. */
export function clipMotion(id: string, body: Body | undefined, pos: V3, heading: number, duration: number, startT = 0, mirror = false, seats: readonly SeatSpot[] = []): ClipRunMark[] | null {
  return motionRun(id, body, pos, heading, startT, startT + duration, mirror, seats)
}

/* --------------------------------- seats -------------------------------- */

/** Fork (mocap-backlog): each seat prop's seat top at scale 1 (m), from its builder (`builders.ts`). */
export const SEAT_TOP: Readonly<Record<string, number>> = {
  'furniture.chair': 0.48,
  'furniture.stool': 0.65,
  'furniture.armchair': 0.545,
  'furniture.couch': 0.545,
  'furniture.officeChair': 0.7,
  'furniture.wheelchair': 0.54,
  'furniture.toilet': 0.49,
  'prop.bench': 0.48,
  'prop.poolLounger': 0.39
}

/** Catalog props a bot sits on: over one, a sit is a chair sit; elsewhere it sits on the floor. */
export const SEAT_ASSETS: ReadonlySet<string> = new Set(Object.keys(SEAT_TOP))

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
      // Fork (mocap-backlog): the runs sit on the seat's top (in the body's own size; `seat.ts`).
      const spot = (seatUnder(seats, pos) ?? seatUnder(seats, landing))!
      const seat = Math.round(((SEAT_TOP[spot.assetId]! * spot.scale + spot.position.y - pos.y) / (body.scale ?? 1)) * 1e6) / 1e6
      const onSeat = (run: ClipRunMark[]): ClipRunMark[] => run.map((mk) => ({ ...mk, clip: { ...mk.clip, seat } }))
      const run = onSeat(clipRun({ clip: into.id }, body, { ...start, y: pos.y }, heading, startT, endT))
      const end = run[1]!
      if (!mocapClip('sitChair') || endT - end.time <= BLEND) return run
      const idle = onSeat(clipRun({ clip: 'sitChair' }, body, { ...end.position }, heading, end.time, endT))
      endEarly(run[0]!, end, body)
      return [...run, ...idle]
    }
  }
  return mocapClip('sitFloor') ? clipRun({ clip: 'sitFloor' }, body, pos, heading, startT, endT) : null
}

/** A motion's name for prompts and lists: its preset's, or the clip's own. */
/** Fork (qa-fixes): the motion a clip shared by several presets is named by (the library's trip is a trip and fall). */
const CLIP_NAMES: Record<string, string> = { trip: 'trip-and-fall-flat' }

export function clipMotionName(clipId: string): MotionPreset | undefined {
  const preset = CLIP_NAMES[clipId] ?? Object.entries(PRESET_CLIPS).find(([, s]) => s.clip === clipId)?.[0]
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
  /** Fork (fight-polish): a routine strike's target, this far ahead along its heading (m): a bot's keyframe lunge stops short of it. */
  reach?: number
  /** Fork (set-routines): the clip time a bot's run of the play starts at, instead of its preset clip's (`RUN_FROM`). */
  from?: number
  /** Fork (set-routines): the clip a bot plays the play on instead of its preset's (a chase's tackle dives on the trip); its run marks name the preset (`MarkClip.as`). */
  clip?: string
}

const PLAYS = new WeakMap<object, MotionPlay>()

/** Remember which play a keyframe mark belongs to (routines and sequences lay plays before they know the bodies). */
export function tagPlay<T extends object>(play: MotionPlay, mark: T): T {
  PLAYS.set(mark, play)
  return mark
}

/** Fork (mocap-backlog): the play a routine's or sequence's mark belongs to, if any. */
export function playOf(mark: object): MotionPlay | undefined {
  return PLAYS.get(mark)
}

/** A copy of a mark keeps its play. */
export function copyTag<T extends object>(from: object, to: T): T {
  const play = PLAYS.get(from)
  if (play) PLAYS.set(to, play)
  return to
}

/** Phase 3: the routine and sequence defenses (motions.ts ids) as the Fight Director's, and the side of the blow its clip is picked for. */
const DEFENSE_PLAYS: Record<string, { outcome: keyof typeof DEFENSES; high: boolean; side: 'L' | 'R' }> = {
  'block-high': { outcome: 'block', high: true, side: 'R' },
  'block-low': { outcome: 'block', high: false, side: 'R' },
  'parry-deflect': { outcome: 'parry', high: true, side: 'R' },
  // The dodge clip slips away from a blow on the left (to the right): dodging left is it mirrored.
  'dodge-left': { outcome: 'slip', high: true, side: 'R' },
  'dodge-right': { outcome: 'slip', high: true, side: 'L' },
  'duck-under': { outcome: 'duck', high: true, side: 'L' },
  'weave-bob': { outcome: 'duck', high: false, side: 'L' }
}

/** Phase 3: routine falls (motions.ts ids) on the Fight Director's fall clips: a knockdown, or a KO. */
const FALL_PLAYS: Record<string, { ko: boolean }> = { 'knocked-down': { ko: false }, 'knockdown-fall': { ko: false }, 'ko-collapse': { ko: true } }
/** The get-up after each fall clip. */
const GET_UP_AFTER: Record<string, string> = { knockedDown: 'getUpKnockdown', koBack: 'getUpBack', koStomach: 'getUpStomach' }
const GET_UP = 'get-up-from-ground'
const GUARD_BOUNCE = 'boxing-guard-bounce'

/**
 * A keyframe fall on a body: when its hips come down to the floor (within a
 * tenth of their drop, as `fallLandTime` reads a clip's; between keyframes
 * by straight lines), and whether it lands on its front (the head ahead of
 * the hips).
 */
function keyframeLanding(preset: MotionPreset, body: Body): { t: number; front: boolean } {
  const dims = personDims(body.assetId, body.params)
  const keys = preset.keyframes.map((kf) => {
    const fx = poseEffectors(dims, kf.joints)
    return { t: kf.t, y: fx.pelvis.y - bodyLowY(body, kf.joints), front: fx.head.z < fx.pelvis.z }
  })
  const lo = Math.min(...keys.map((k) => k.y))
  const at = lo + 0.1 * (keys[0]!.y - lo)
  const k = Math.max(0, keys.findIndex((x) => x.y <= at + 1e-9))
  const a = keys[Math.max(0, k - 1)]!
  const b = keys[k]!
  const u = k > 0 && a.y - b.y > 1e-9 ? (a.y - at) / (a.y - b.y) : 1
  return { t: a.t + (b.t - a.t) * u, front: b.front }
}

/**
 * Phase 3: a routine's or sequence's fight move on a bot as the Fight
 * Director's clips (fight/clip-moves.ts), or null (its keyframes: a move
 * with no clip). A strike one run per impact, each impact frame on the
 * keyframe move's impact (the routine's exchanges are timed on those), each
 * run from where the last one ended; a defense its guard frame on the
 * keyframe defense's ready time; a fall (by the way it falls) its
 * floor-contact frame on the keyframe fall's landing; a get-up the one for
 * the fall before it (`fell`), standing at the keyframe get-up's end (from
 * `after` on, played faster if it must); the guard bounce the fight idle on
 * shot time; any other its own clip.
 */
function fightRun(play: MotionPlay, body: Body, heading: number, fell?: string, after = -Infinity): ClipRunMark[] | null {
  const h = play.heading ?? heading
  const impacts = strikeImpacts(play.presetId)
  if (impacts.length > 0) {
    const blows = moveClips(play.presetId, defaultTarget(play.presetId))
    if (!blows || blows.length !== impacts.length) return null
    const at = impacts.map((imp) => play.startT + imp.t)
    const out: ClipRunMark[] = []
    blows.forEach((b, i) => {
      const tau = clipImpactTime(b)
      const start = Math.max(i === 0 ? play.startT : (at[i - 1]! + at[i]!) / 2, at[i]! - tau)
      const end = i === blows.length - 1 ? play.endT : (at[i]! + at[i + 1]!) / 2
      // Fork (fight-polish): the first blow's run starts back by the clip's own travel to its impact, so the blow lands from where the
      // keyframe move strikes (at fighting range), not that much further in.
      const lead = out.length > 0 ? null : toWorld(runTravel(b.clip, body, tau - (at[i]! - start), tau, play.mirror), { x: 0, y: 0, z: 0 }, h, 1)
      const from = out.length > 0 ? { ...out[out.length - 1]!.position } : { x: play.pos.x - lead!.x, y: play.pos.y, z: play.pos.z - lead!.z }
      const run = clipRun({ clip: b.clip, from: tau - (at[i]! - start) }, body, from, h, start, end, play.mirror)
      const prev = out[out.length - 1]
      if (prev && prev.time >= run[0]!.time - 1e-6) endEarly(out[out.length - 2]!, prev, body)
      out.push(...run)
    })
    return out
  }
  const preset = MOTION_PRESETS.find((p) => p.id === play.presetId)
  const d = DEFENSE_PLAYS[play.presetId]
  const pick = d && defenseClip(d.outcome, d.high, d.side)
  if (d && pick && preset) {
    const ready = play.startT + DEFENSES[d.outcome].readyFraction * preset.duration
    const r = defenseReadyTime(pick.id)
    const start = Math.max(play.startT, ready - r)
    return clipRun({ clip: pick.id, from: r - (ready - start), mirror: pick.mirror }, body, play.pos, h, start, play.endT, play.mirror)
  }
  const fall = FALL_PLAYS[play.presetId]
  if (fall && preset) {
    const land = keyframeLanding(preset, body)
    const clip = reactionClip({ result: 'knockdown', ko: fall.ko, zone: 'body', moveId: play.presetId, side: 'R', pushFront: land.front })
    if (clip) {
      const T = play.startT + land.t
      const tau = fallLandTime(clip.id)
      const start = Math.max(play.startT, T - tau)
      return clipRun({ clip: clip.id, from: tau - (T - start), mirror: clip.mirror }, body, play.pos, h, start, play.endT, play.mirror)
    }
  }
  if (play.presetId === GET_UP) {
    const id = [fell && GET_UP_AFTER[fell], 'getUpKnockdown', 'getUpBack'].find((c): c is string => !!c && !!mocapClip(c))
    if (id) {
      const len = mocapClip(id)!.duration
      const start = Math.max(after, play.endT - len)
      const run = clipRun({ clip: id }, body, play.pos, h, start, start + len, play.mirror)
      if (start + len > play.endT) run[1]!.time = Math.round(play.endT * 1e6) / 1e6
      return run
    }
  }
  if (play.presetId === GUARD_BOUNCE && mocapClip('fightIdle')) return clipRun({ clip: 'fightIdle', from: play.startT }, body, play.pos, h, play.startT, play.endT, play.mirror)
  return motionRun(play.presetId, body, play.pos, h, play.startT, play.endT, play.mirror)
}

/** A keyframe strike on a bot (no clip) comes no closer to its routine's target than this (m): it lands, it doesn't run through. */
const STRIKE_STOP = 0.75

/** Fork (fight-polish): a keyframe strike's mark on a bot, its lunge held STRIKE_STOP short of the play's target (`reach` ahead). */
function short<M extends { time: number }>(mark: M, play: MotionPlay): M {
  const p = (mark as unknown as { position?: V3 }).position
  if (!p || play.reach === undefined || strikeImpacts(play.presetId).length === 0) return mark
  const h = play.heading ?? 0
  const fx = -Math.sin(h)
  const fz = -Math.cos(h)
  const ahead = (p.x - play.pos.x) * fx + (p.z - play.pos.z) * fz
  const over = ahead - (play.reach - STRIKE_STOP)
  return over > 0 ? copyTag(mark, { ...mark, position: { x: p.x - fx * over, y: p.y, z: p.z - fz * over } }) : mark
}

/** The fall clips (a get-up after one matches it). */
const FALL_CLIPS = new Set(Object.keys(GET_UP_AFTER))

/** A routine's plain stand mark (no pose of its own): the push-back after a reaction, or a fallen fighter held down. */
function bare(m: object): m is { time: number; position: V3; gait: string } {
  const k = m as { joints?: unknown; clip?: unknown; gait?: string }
  return !k.joints && !k.clip && k.gait === 'stand' && !PLAYS.has(m)
}

/**
 * A performer's marks with every tagged play whose preset has a clip
 * replaced by its clip run, when the body is a loaded bot; else the marks
 * unchanged. Phase 3: fight moves play the Fight Director's clips
 * (`fightRun`: strikes and defenses on the keyframe move's impact and ready
 * times, falls on its landing, get-ups standing at its end, the guard
 * bounce on shot time); only a move with no clip keeps its keyframes. A
 * routine's plain stand mark at a run's (or its play's) end moves the run's
 * end there (a push-back); after a fall, plain stand marks hold the fall's
 * last frame.
 */
export function clipPlays<M extends { time: number }>(marks: M[], body: Body, heading = 0): (M | ClipRunMark)[] {
  if (!playsClips(body)) return marks
  const out: (M | ClipRunMark)[] = []
  let fell: string | undefined
  for (let i = 0; i < marks.length; ) {
    const play = PLAYS.get(marks[i]!)
    const last = out[out.length - 1] as ClipRunMark | undefined
    if (!play && fell && last?.clip && bare(marks[i]!)) {
      // Down: held on the fall's last frame where the mark puts the body.
      const m = marks[i]! as unknown as { time: number; position: V3 }
      out.push({ ...last, time: m.time, position: { x: m.position.x, y: last.position.y, z: m.position.z } })
      i++
      continue
    }
    const fight = MOTION_PRESETS.find((p) => p.id === play?.presetId)?.category === 'fight'
    const run = !play
      ? null
      : play.clip
        ? motionRun(play.presetId, body, play.pos, play.heading ?? heading, play.startT, play.endT, play.mirror, undefined, play.from, play.clip)
        : fight
          ? fightRun(play, body, heading, fell, last?.time)
          : motionRun(play.presetId, body, play.pos, play.heading ?? heading, play.startT, play.endT, play.mirror, undefined, play.from)
    if (!play || !run) {
      out.push(play && fight && play.reach !== undefined ? short(marks[i]!, play) : marks[i]!)
      i++
      continue
    }
    // Fork (set-routines): a play on another clip names its preset.
    if (play.clip) for (const r of run) r.clip = { ...r.clip, as: play.presetId }
    fell = FALL_CLIPS.has(run[0]!.clip.id) ? run[0]!.clip.id : undefined
    while (i < marks.length && PLAYS.get(marks[i]!) === play) i++
    // A push-back at the run's (or the play's) end: the run ends where it puts the body.
    const end = run[run.length - 1]!
    while (i < marks.length && bare(marks[i]!) && Math.min(Math.abs(marks[i]!.time - end.time), Math.abs(marks[i]!.time - play.endT)) < 1e-4) {
      const p = (marks[i]! as unknown as { position: V3 }).position
      end.position = { x: p.x, y: end.position.y, z: p.z }
      i++
    }
    // Fork (fight-polish): a strike run starting back from its play (fightRun) takes the plain step-in mark before it back with it.
    const step = out[out.length - 1] as { position?: V3; clip?: unknown; joints?: unknown } | undefined
    const p0 = run[0]!.position
    if (step?.position && !step.clip && !step.joints && Math.hypot(step.position.x - play.pos.x, step.position.z - play.pos.z) < 1e-6 && Math.hypot(p0.x - play.pos.x, p0.z - play.pos.z) > 1e-6)
      out[out.length - 1] = { ...step, position: { x: p0.x, y: step.position.y, z: p0.z } } as unknown as M
    // A run that starts as the last one ends: the last ends a moment early, so the two crossfade.
    const prev = out[out.length - 1] as ClipRunMark | undefined
    const prevStart = out[out.length - 2] as ClipRunMark | undefined
    if (prev?.clip && prevStart?.clip && prev.time >= run[0]!.time - 1e-6) endEarly(prevStart, prev, body)
    out.push(...run)
  }
  return out
}
