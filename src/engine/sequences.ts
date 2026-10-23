// Modified in this fork (2026): the floor rule (floor.ts) on posed marks, and apply_motion marks are posed moves, mocap clip runs on bots, a car chase on its own open road; see MODIFICATIONS.md.
/**
 * Crowd & sequence director: one-click choreographed groups. Generates the
 * ENTITIES (people, cars) and their TRACKS (marks with gaits, altitude, and
 * joint keyframes) for a whole staged sequence — a 20-dancer number, a bar
 * brawl, a foot chase, a car chase — which the app drops into the scene as
 * a single undoable step. Everything stays editable afterwards: each
 * performer is a normal entity with normal marks.
 *
 * Pure module (no DOM/three/Electron, no randomness) — variation comes from
 * per-index trigonometry so the same options always stage the same crowd.
 */

import { MOTION_PRESETS, type MotionPreset } from './motions'
import { bodyLowY, motionRootY, type Body } from './floor'
import { clipMotion, clipPlays, tagPlay, type SeatSpot } from './mocap/library-clips'
import { OPEN_ROAD, ROAD_END, roadLocal, roadSpan, roadWorld, type RoadPlace } from './road-kit'
import { vehicleBox } from './vehicles'
import type { MarkClip } from './types'

export type SequenceType = 'dance' | 'fight' | 'footChase' | 'carChase'

export interface SequenceOptions {
  type: SequenceType
  /** How many performers (clamped 2–60). */
  count: number
  /**
   * Per type: dance → a dance MotionPreset id or 'mixed'; fight → 'paired'
   * or 'mob'; footChase → 'straight' or 'weaving'; carChase → 'pursuit' or
   * 'weaving'.
   */
  style: string
  /** Where to stage it and which way the sequence faces/travels. */
  origin: { x: number; z: number; heading: number }
  /** Shot duration — choreography fills it. */
  duration: number
  /** Fork: the bodies the men and the women are cast as (a bot plays its motions as clip runs). */
  bodies?: [string, string]
  /** Fork (street-kit): the open road a car chase was placed on; the chase runs along it and lengthens it. */
  road?: RoadPlace & { entityId: string }
}

export interface SequenceMarkSpec {
  time: number
  position: { x: number; y: number; z: number }
  gait: 'walk' | 'jog' | 'run' | 'stand'
  easeIn: number
  easeOut: number
  hold: number
  joints?: Record<string, number>
  /** Fork: face this heading through the motion (with `posedMove`). */
  arriveHeading?: number
  posedMove?: boolean
  /** Fork: a mocap clip run's mark on a bot (types.ts `ActorMark.clip`). */
  clip?: MarkClip
  /** Fork (street-kit): waypoints from the previous mark (types.ts `MarkBase.via`). */
  via?: { x: number; y: number; z: number }[]
}

export interface SequenceEntitySpec {
  assetId: string
  name: string
  position: { x: number; y: number; z: number }
  rotationY: number
  label?: { text: string; color: string }
  marks: SequenceMarkSpec[]
  /** Fork (street-kit): the entity's params (the open road's length). */
  params?: Record<string, number>
  /** Fork (street-kit): update this entity (an open road the chase lengthens) instead of adding one. */
  replaces?: string
}

/** Hard cap so a 60-dancer number can't explode the timeline. */
const MAX_MARKS_PER_ENTITY = 40

const clampCount = (n: number): number => Math.max(2, Math.min(60, Math.round(n)))

/** Rotate a local offset (right = +lx, forward = +lz) into world space. */
function place(
  origin: { x: number; z: number; heading: number },
  lx: number,
  lz: number
): { x: number; z: number } {
  const cos = Math.cos(origin.heading)
  const sin = Math.sin(origin.heading)
  // right(θ) = (cosθ, 0, -sinθ); forward(θ) = (-sinθ, 0, -cosθ)
  return {
    x: origin.x + lx * cos - lz * sin,
    z: origin.z - lx * sin - lz * cos
  }
}

/** Deterministic per-index jitter in [-1, 1]. */
const jitter = (i: number, salt: number): number => Math.sin(i * 12.9898 + salt * 78.233) % 1

function dancePresets(): MotionPreset[] {
  return MOTION_PRESETS.filter((p) => p.category === 'dance')
}

function fightPresets(ids: string[], fallback: string[]): MotionPreset[] {
  const found = ids
    .map((id) => MOTION_PRESETS.find((p) => p.id === id))
    .filter((p): p is MotionPreset => !!p)
  if (found.length > 0) return found
  return fallback
    .map((id) => MOTION_PRESETS.find((p) => p.id === id))
    .filter((p): p is MotionPreset => !!p)
}

/**
 * Lay a motion's keyframes down as joint marks starting at `startT`,
 * looping to fill the window. Keyframe `move` offsets (jumps, crawls) are
 * applied relative to `pos` along `heading`. Returns the time it finished.
 */
function appendMotion(
  marks: SequenceMarkSpec[],
  preset: MotionPreset,
  pos: { x: number; y: number; z: number },
  startT: number,
  endT: number,
  heading = 0
): number {
  let t = startT
  const cycle = preset.duration + (preset.loop ? 0.05 : 0.4)
  const fwd = { x: -Math.sin(heading), z: -Math.cos(heading) }
  // Fork: the plays a bot turns into clip runs (mocap/library-clips.ts): a loop is one, a one-shot one per repeat.
  let play = { presetId: preset.id, pos: { ...pos }, startT, endT }
  while (t <= endT + 1e-6 && marks.length < MAX_MARKS_PER_ENTITY) {
    if (!preset.loop) play = { presetId: preset.id, pos: { ...pos }, startT: t, endT: Math.min(endT, t + cycle) }
    for (const kf of preset.keyframes) {
      const time = t + kf.t
      if (time > endT + 1e-6 || marks.length >= MAX_MARKS_PER_ENTITY) break
      const forward = kf.move?.forward ?? 0
      const up = kf.move?.up ?? 0
      marks.push(tagPlay(play, {
        time,
        position: {
          x: pos.x + fwd.x * forward,
          // Fork: raw; `floorMarks` applies the floor rule (it used to clamp at 0).
          y: pos.y + up,
          z: pos.z + fwd.z * forward
        },
        gait: 'stand',
        easeIn: 0,
        easeOut: 0,
        hold: 0,
        joints: { ...kf.joints }
      }))
    }
    if (!preset.loop && t + cycle + preset.duration > endT) break
    t += cycle
  }
  return t
}

/**
 * Fork: the floor rule (floor.ts `motionRootY`) on posed marks laid on a
 * floor at `baseY`: a keyframe that doesn't lift the body rests its lowest
 * point on it, and nothing goes below it.
 */
function floorMarks(marks: SequenceMarkSpec[], baseY: number, body: Body | undefined): void {
  for (const m of marks) if (m.joints) m.position.y = motionRootY(baseY, m.position.y - baseY, bodyLowY(body, m.joints))
}

/* ------------------------------- dance --------------------------------- */

function danceSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = clampCount(opts.count)
  const styles = dancePresets()
  const chosen =
    opts.style === 'mixed' ? null : (styles.find((p) => p.id === opts.style) ?? styles[0] ?? null)
  const out: SequenceEntitySpec[] = []
  const cols = Math.min(6, Math.ceil(Math.sqrt(count * 1.4)))
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const rowWidth = Math.min(cols, count - row * cols)
    const lx = (col - (rowWidth - 1) / 2) * 1.8 + jitter(i, 1) * 0.15
    const lz = -row * 2.0 + jitter(i, 2) * 0.15
    const pos3 = place(opts.origin, lx, lz)
    const preset = chosen ?? styles[i % Math.max(1, styles.length)]!
    const marks: SequenceMarkSpec[] = []
    if (preset) {
      // Ripple: back rows start a beat later — reads as staged choreography.
      const ripple = row * 0.12
      appendMotion(marks, preset, { x: pos3.x, y: 0, z: pos3.z }, ripple, opts.duration)
    }
    out.push({
      assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
      name: `Dancer ${i + 1}`,
      position: { x: pos3.x, y: 0, z: pos3.z },
      rotationY: opts.origin.heading,
      marks
    })
  }
  return out
}

/* ------------------------------- fight --------------------------------- */

function fightSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = clampCount(opts.count)
  const strikes = fightPresets(
    ['jab-cross', 'roundhouse-kick', 'haymaker', 'uppercut', 'front-kick-combo', 'high-kick'],
    ['jab-cross', 'haymaker', 'uppercut', 'high-kick']
  )
  const reactions = fightPresets(
    ['hit-reaction-head', 'hit-reaction-body', 'stumble-back-fall', 'block-and-dodge'],
    ['block-and-dodge', 'knocked-down']
  )
  const out: SequenceEntitySpec[] = []

  if (opts.style === 'mob') {
    // One defender in the middle, everyone else circles in and strikes.
    const center = place(opts.origin, 0, 0)
    const defender: SequenceEntitySpec = {
      assetId: 'person.man',
      name: 'Defender',
      position: { x: center.x, y: 0, z: center.z },
      rotationY: opts.origin.heading,
      label: { text: 'HERO', color: '#3b82f6' },
      marks: []
    }
    // Dodges through most of it, goes down near the end.
    const dodge = reactions.find((p) => p.id === 'block-and-dodge') ?? reactions[0]
    const fall =
      reactions.find((p) => p.id === 'stumble-back-fall') ??
      fightPresets(['knocked-down'], ['knocked-down'])[0]
    if (dodge) {
      const downAt = Math.max(1, opts.duration - (fall?.duration ?? 1.5) - 0.2)
      appendMotion(defender.marks, dodge, defender.position, 0, downAt)
      if (fall) appendMotion(defender.marks, fall, defender.position, downAt + 0.1, opts.duration)
    }
    out.push(defender)
    for (let i = 1; i < count; i++) {
      const angle = (i / (count - 1)) * Math.PI * 2
      const r = 1.5 + (i % 3) * 0.7
      const pos = place(opts.origin, Math.sin(angle) * r, Math.cos(angle) * r)
      const facing = Math.atan2(-(center.x - pos.x), -(center.z - pos.z))
      const strike = strikes[i % strikes.length]!
      const marks: SequenceMarkSpec[] = []
      appendMotion(marks, strike, { x: pos.x, y: 0, z: pos.z }, (i - 1) * 0.35, opts.duration)
      out.push({
        assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
        name: `Attacker ${i}`,
        position: { x: pos.x, y: 0, z: pos.z },
        rotationY: facing,
        marks
      })
    }
    return out
  }

  // Paired brawl: clusters of duels scattered around the origin.
  const pairs = Math.floor(count / 2)
  for (let p = 0; p < pairs; p++) {
    const clusterAngle = p * 2.399963 // golden angle — even, non-grid scatter
    const clusterR = p === 0 ? 0 : 1.6 + 1.35 * Math.sqrt(p)
    const cx = Math.sin(clusterAngle) * clusterR
    const cz = Math.cos(clusterAngle) * clusterR
    // Each duel fights along its own local axis so the brawl reads chaotic.
    const duelAxis = jitter(p, 3) * Math.PI
    const half = 0.7
    const a = place(opts.origin, cx + Math.sin(duelAxis) * half, cz + Math.cos(duelAxis) * half)
    const b = place(opts.origin, cx - Math.sin(duelAxis) * half, cz - Math.cos(duelAxis) * half)
    const faceAB = Math.atan2(-(b.x - a.x), -(b.z - a.z))
    const faceBA = faceAB + Math.PI
    const strike = strikes[p % strikes.length]!
    const reaction = reactions[p % reactions.length]!
    const offset = (p % 4) * 0.3

    const attacker: SequenceEntitySpec = {
      assetId: p % 2 === 0 ? 'person.man' : 'person.woman',
      name: `Fighter ${p * 2 + 1}`,
      position: { x: a.x, y: 0, z: a.z },
      rotationY: faceAB,
      marks: []
    }
    appendMotion(attacker.marks, strike, attacker.position, offset, opts.duration)

    const defender: SequenceEntitySpec = {
      assetId: p % 2 === 0 ? 'person.woman' : 'person.man',
      name: `Fighter ${p * 2 + 2}`,
      position: { x: b.x, y: 0, z: b.z },
      rotationY: faceBA,
      marks: []
    }
    // Reactions land a beat after the strikes start.
    appendMotion(defender.marks, reaction, defender.position, offset + strike.duration * 0.5, opts.duration)
    out.push(attacker, defender)
  }
  // Odd one out spectates, cheering.
  if (count % 2 === 1) {
    const pos = place(opts.origin, 0, 2.5)
    const cheer = fightPresets(['cheer-jump', 'arms-up-party'], ['arms-up-party'])[0]
    const spectator: SequenceEntitySpec = {
      assetId: 'person.man',
      name: 'Spectator',
      position: { x: pos.x, y: 0, z: pos.z },
      rotationY: opts.origin.heading + Math.PI,
      marks: []
    }
    if (cheer) appendMotion(spectator.marks, cheer, spectator.position, 0.5, opts.duration)
    out.push(spectator)
  }
  return out
}

/* ----------------------------- foot chase ------------------------------ */

function footChaseSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = clampCount(opts.count)
  const runSpeed = 5.2
  const length = Math.min(70, runSpeed * opts.duration * 0.9)
  const weaving = opts.style === 'weaving'
  const out: SequenceEntitySpec[] = []
  for (let i = 0; i < count; i++) {
    // Leader out front; pursuers in a staggered wedge behind.
    const backset = i === 0 ? 0 : 2.2 + i * 1.6
    const lateral = i === 0 ? 0 : jitter(i, 4) * 1.6
    const startL = place(opts.origin, lateral, -0 - backset)
    const marks: SequenceMarkSpec[] = []
    const steps = 5
    for (let s2 = 0; s2 <= steps; s2++) {
      const f = s2 / steps
      const along = f * length - backset
      const wob = weaving ? Math.sin(f * Math.PI * 2 + i * 0.9) * 2.2 : 0
      const p = place(opts.origin, lateral + wob, along)
      marks.push({
        time: f * opts.duration,
        position: { x: s2 === 0 ? startL.x : p.x, y: 0, z: s2 === 0 ? startL.z : p.z },
        gait: 'run',
        easeIn: s2 === steps ? 0.25 : 0,
        easeOut: s2 === 0 ? 0.25 : 0,
        hold: 0
      })
    }
    out.push({
      assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
      name: i === 0 ? 'Runner' : `Pursuer ${i}`,
      position: { x: startL.x, y: 0, z: startL.z },
      rotationY: opts.origin.heading,
      label: i === 0 ? { text: 'RUNNER', color: '#e5484d' } : undefined,
      marks
    })
  }
  return out
}

/* ------------------------------ car chase ------------------------------ */

const CHASE_CARS = ['vehicle.sedan', 'vehicle.suv', 'vehicle.pickup', 'vehicle.van']
/** Fork (street-kit): the chase's pace (m/s; upstream's 17 × 0.9), the gap between cars (m) and the spacing of a car's waypoints (m). */
const CHASE_PACE = 15.3
const CHASE_GAP = 7.5
const VIA_STEP = 8
/** Fork (street-kit): road behind the last car's start and past the lead's end (m). */
const ROAD_BEHIND = 40
const ROAD_AHEAD = 45

/**
 * Fork (street-kit): the shot starts mid-chase, so each car drives one smooth
 * line at speed from the first frame to the last (two marks, the weave in
 * `via` points, no easing: no heading snaps at a mark, no standing start). On
 * an open road (`opts.road`) it runs along the road; `carChaseRoad` gives the
 * road under it.
 */
function carChaseSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = clampCount(opts.count)
  const length = CHASE_PACE * opts.duration
  const weaving = opts.style === 'weaving'
  const road = opts.road
  // On a road: start where the click falls along its centre line, driving along it the way nearest the asked heading.
  const origin = road ? onRoadOrigin(road, opts.origin) : opts.origin
  const out: SequenceEntitySpec[] = []
  for (let i = 0; i < count; i++) {
    const backset = i * CHASE_GAP
    const lane = i === 0 ? 0 : ((i % 3) - 1) * 2.6
    const lateral = (f: number): number => (weaving ? Math.sin(f * Math.PI * 2.5 + i * 1.3) * 2.8 : lane * (1 - f * 0.3))
    const steps = Math.max(2, Math.ceil(length / VIA_STEP))
    const pts = Array.from({ length: steps + 1 }, (_, k) => {
      const p = place(origin, lateral(k / steps), (k / steps) * length - backset)
      return { x: p.x, y: 0, z: p.z }
    })
    out.push({
      assetId: CHASE_CARS[i % CHASE_CARS.length]!,
      name: i === 0 ? 'Lead car' : `Chase car ${i}`,
      position: { ...pts[0]! },
      // Facing along its line at the first frame (the line's first tangent points at the first waypoint).
      rotationY: Math.atan2(-(pts[1]!.x - pts[0]!.x), -(pts[1]!.z - pts[0]!.z)),
      label: i === 0 ? { text: 'LEAD', color: '#e5484d' } : undefined,
      marks: [
        { time: 0, position: pts[0]!, gait: 'run', easeIn: 0, easeOut: 0, hold: 0 },
        { time: opts.duration, position: pts[steps]!, via: pts.slice(1, steps), gait: 'run', easeIn: 0, easeOut: 0, hold: 0 }
      ]
    })
  }
  return out
}

/**
 * Fork (street-kit): the open road under a staged car chase (`cars` from
 * generateSequence): from ROAD_BEHIND m behind the last car's start to
 * ROAD_AHEAD m past the lead's end, or the road it was placed on lengthened
 * to cover that (`replaces` names it).
 */
export function carChaseRoad(opts: SequenceOptions, cars: SequenceEntitySpec[]): SequenceEntitySpec {
  const origin = opts.road ? onRoadOrigin(opts.road, opts.origin) : opts.origin
  const fx = -Math.sin(origin.heading)
  const fz = -Math.cos(origin.heading)
  let from = 0
  let to = 0
  for (const c of cars) {
    const box = vehicleBox(c.assetId)
    for (const m of c.marks) {
      const along = (m.position.x - origin.x) * fx + (m.position.z - origin.z) * fz
      from = Math.min(from, along - (box?.back ?? 0))
      to = Math.max(to, along + (box?.front ?? 0))
    }
  }
  return chaseRoad(origin, from - ROAD_BEHIND, to + ROAD_AHEAD, opts.road)
}

/** The point of the road nearest `o` on its centre line, heading along it the way nearest `o.heading`. */
function onRoadOrigin(road: RoadPlace, o: { x: number; z: number; heading: number }): { x: number; z: number; heading: number } {
  const along = Math.max(-road.length / 2 - ROAD_END, Math.min(road.length / 2 + ROAD_END, roadLocal(road, o).along))
  const p = roadWorld(road, 0, along)
  const turn = Math.atan2(Math.sin(o.heading - road.heading), Math.cos(o.heading - road.heading))
  return { x: p.x, z: p.z, heading: Math.abs(turn) <= Math.PI / 2 ? road.heading : road.heading + Math.PI }
}

/** The open road under a chase from `from` to `to` m along its heading; on a road, that road lengthened to cover them. */
function chaseRoad(origin: { x: number; z: number; heading: number }, from: number, to: number, road?: RoadPlace & { entityId: string }): SequenceEntitySpec {
  let span = roadSpan(origin, origin.heading, from, to)
  if (road) {
    // Both spans along the road's own axis.
    const a = roadLocal(road, roadWorld({ ...origin }, 0, from)).along
    const b = roadLocal(road, roadWorld({ ...origin }, 0, to)).along
    const lo = Math.min(-road.length / 2, a, b)
    const hi = Math.max(road.length / 2, a, b)
    span = roadSpan(road, road.heading, lo, hi)
  }
  return {
    assetId: OPEN_ROAD,
    name: 'Open road',
    position: { x: span.x, y: 0, z: span.z },
    rotationY: span.heading,
    params: { length: Math.round(span.length * 10) / 10 },
    marks: [],
    ...(road ? { replaces: road.entityId } : {})
  }
}

/* -------------------------------- entry -------------------------------- */

/** Styles offered per sequence type (dance styles come from the library). */
export function sequenceStyles(type: SequenceType): { id: string; name: string }[] {
  switch (type) {
    case 'dance':
      return [
        { id: 'mixed', name: 'Mixed styles' },
        ...dancePresets().map((p) => ({ id: p.id, name: p.name }))
      ]
    case 'fight':
      return [
        { id: 'paired', name: 'Paired brawl' },
        { id: 'mob', name: 'Mob vs one' }
      ]
    case 'footChase':
    case 'carChase':
      return [
        { id: 'straight', name: 'Straight pursuit' },
        { id: 'weaving', name: 'Weaving' }
      ]
  }
}

/**
 * Choreograph ONE performer with a motion preset at a fixed spot — used to
 * restyle already-staged performers (swap the dance, change the strike)
 * without restaging the crowd. Returns null for unknown preset ids.
 */
export function choreographMotion(
  presetId: string,
  pos: { x: number; y: number; z: number },
  heading: number,
  duration: number,
  startT = 0,
  body?: Body,
  /** Fork: a bot's clip run plays mirrored, its travel too (keyframe joints stay the caller's to mirror). */
  mirror = false,
  /** Fork: the seat props a bot's sit-down sits on (else the floor). */
  seats: readonly SeatSpot[] = []
): SequenceMarkSpec[] | null {
  // Fork: a loaded bot plays the motion's library clip as one run (mocap/library-clips.ts).
  const run = clipMotion(presetId, body, pos, heading, duration, startT, mirror, seats)
  if (run) return run
  const preset = MOTION_PRESETS.find((p) => p.id === presetId)
  if (!preset) return null
  const marks: SequenceMarkSpec[] = []
  appendMotion(marks, preset, pos, startT, duration, heading)
  // Fork: on the performer's floor, as a posed move that keeps its facing
  // (no walk cycle between keyframes, no turn toward a vertical move).
  floorMarks(marks, pos.y, body)
  for (const m of marks) {
    m.arriveHeading = heading
    m.posedMove = true
  }
  return marks
}

export function generateSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const specs = sequenceOf(opts)
  for (const e of specs) {
    // Fork: cast the chosen bodies; a bot plays its motions as clip runs; the floor rule.
    if (opts.bodies) e.assetId = e.assetId === 'person.man' ? opts.bodies[0] : e.assetId === 'person.woman' ? opts.bodies[1] : e.assetId
    e.marks = clipPlays(e.marks, { assetId: e.assetId }, e.rotationY)
    floorMarks(e.marks, 0, { assetId: e.assetId })
  }
  return specs
}

function sequenceOf(opts: SequenceOptions): SequenceEntitySpec[] {
  switch (opts.type) {
    case 'dance':
      return danceSequence(opts)
    case 'fight':
      return fightSequence(opts)
    case 'footChase':
      return footChaseSequence(opts)
    case 'carChase':
      return carChaseSequence(opts)
  }
}
