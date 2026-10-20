/**
 * Fight contact solver (fork addition; see MODIFICATIONS.md): a beat script
 * → ordinary actor marks for two fighters, with blows that land.
 *
 * Per beat: impact times snap to the shot's frame grid (the strike motion is
 * time-warped by < half a frame so every impact keyframe sits on a frame);
 * the defender's pose at each impact is known from its defense / reaction
 * schedule; the attacker's rig is pitched at the shoulder or hip so the
 * effector reaches the target height, then yawed and placed in closed form
 * so it meets the target point exactly; a kick that still falls short lifts
 * the kicker (onto the toes / a small hop, ramped in and landed) and a
 * blocking arm reaches to meet the blow. Reactions follow the closed-form
 * physics (stagger, knockdown slide, head snap; a guarded stagger rocks the
 * defender back behind its guard). All marks carry lockFacing,
 * so the evaluator keeps each fighter's facing and posed gait. The report's
 * contact errors are measured through the real ShotEvaluator.
 *
 * Weapons (fork; src/engine/weapons.ts): a blow from a hand holding a weapon
 * lands with the weapon (blade, point, club end), a blocked one meets the
 * defender's blade or shield, and a gun beat (SHOT_MOVES) aims the barrel
 * line through the target, with the reaction on the shot frame.
 *
 * PURE and deterministic: no DOM / three.js / Electron, no randomness.
 */

import { mirrorJoints, type ChoreoMarkSpec } from '../choreography'
import { ShotEvaluator } from '../evaluate'
import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, poseEffectors, toWorld, type Effector, type PersonDims } from '../skeleton'
import type { EntityState, FightBeat, FightDoc, FightOutcome, GaitId, Scene, Shot, V3 } from '../types'
import { SUPPORT_SLACK, heldPointLocal, holdJoints, supportReach, weaponContact, weaponSpec, type HeldWeapon } from '../weapons'
import { DEFENSES, REACTIONS, SHIELD_BLOCK, SHOT_MOVES, fightMotion, gripPitch, gunAimMove, shotHand, shotImpacts, strikeImpacts, type StrikeImpact } from './moves'
import { impact, snapAmplitude, snapCurve, weaponHeft, type ImpactResult } from './physics'
import { BODY_RADIUS, clearRun, pathCrossings, type FightObstacle, type PathSample } from './obstacles'
import { floorBody, groundBetween, groundY, type FloorBody } from './ground'
import { bodyClearance, torsoShape, torsoSurface, type TorsoShape } from './contact'

export interface FighterInput {
  entityId: string
  assetId: string
  params?: Record<string, number | string>
  scale: number
  start: V3
  /** Weapons in this fighter's hands (held-weapon entities' asset, hand and scale). */
  weapons?: { assetId: string; hand: 'L' | 'R'; scale: number }[]
}

/** A fight mark: an ordinary choreography mark that keeps its facing and posed gait while travelling. */
export interface FightMarkSpec extends ChoreoMarkSpec {
  arriveHeading: number
  lockFacing: true
}

export interface BeatReport {
  index: number
  startT: number
  impactTimes: number[]
  contactErrorM: number[]
  clearanceM: number[]
  /** Per impact: how far a kick lifted the kicker off the floor to reach (m; 0 = feet down). */
  liftM: number[]
  physics: ImpactResult[]
  warnings: string[]
  /** The motion the beat played: a shot's gun or bow aim, a replaced move's fork motion. */
  plays: string
}

export interface FightSolution {
  tracks: [FightMarkSpec[], FightMarkSpec[]]
  report: { beats: BeatReport[]; warnings: string[]; endT: number }
  /** Set props (fork): each fighter's evaluated path, one sample per frame (empty unless props or `paths` were asked for). */
  paths: [PathSample[], PathSample[]]
}

/** Set props (fork): solver options. */
export interface FightSolveOptions {
  /** Static set props: push-backs stop at them, and paths that still run into one are warned about. */
  obstacles?: FightObstacle[]
  /** Sample the evaluated paths even without props (to place a fight clear of them). */
  paths?: boolean
}

export const MAX_FIGHT_MARKS = 400
export const GUARD_DISTANCE = 1.1
export const MAX_STEP_SPEED = 2.5
export const MIN_SEPARATION = 0.35
export const CONTACT_TOLERANCE = 0.03
export const MIN_CLEARANCE = 0.25
/** A body or legs blow that's avoided clears the whole body by this much (fork). */
export const MIN_BODY_CLEARANCE = 0.1
export const CLINCH_MOVES = new Set(['knee-strike', 'elbow-strike', 'shove-two-hands', 'tackle-lunge', 'grapple-shove'])
/** Lateral blows: the head snap turns (headY) instead of nodding back (headX). */
const HOOK_MOVES = new Set([
  'hook-punch',
  'haymaker',
  'roundhouse-kick',
  'spinning-backfist',
  'spinning-back-fist',
  'elbow-strike',
  'sword-slash-combo'
])
/** Pitch range (rad) for reaching the target height: arms at the shoulder, legs at the hip. */
const ARM_PITCH = 1.0
const LEG_PITCH = 0.9
const ABDUCT_PITCH = 0.6
/** Reach (fork): a blow that can't land tries again with those pitch ranges this much wider. */
const WIDE_REACH = 1.8
/** Reach (fork): an arm blow still this far off after the wider pitch leans the torso too, at most MAX_LEAN. */
const LEAN_TOLERANCE = 0.015
const MAX_LEAN = (20 * Math.PI) / 180
/** An elbow to the head lands on the jaw: the head's surface this far below its middle (rad, fork). */
const ELBOW_JAW = (35 * Math.PI) / 180
/** A kick that can't reach rises onto the toes / hops — at most this high (m). */
export const MAX_KICK_LIFT = 0.5
/** A body kick lands this far up the torso (fork): the midsection, between the belt and the lower ribs. */
const KICK_MIDSECTION = 0.3
/** A blocking arm reaches toward the blow: elbow first, then abduction (shoulders stay in the block). */
const BLOCK_ELBOW = 0.8
/** An armed blow that can't reach the target height by pitch alone bends the elbow by up to this. */
const WEAPON_ELBOW = 0.8
/** A guarded blow that staggers rocks the defender's torso back by up to this (rad). */
const GUARD_ROCK = 0.35
const SNAP_HZ = 15
const SNAP_S = 0.6

type XZ = { x: number; z: number }
type Joints = Record<string, number>

const BY_ID = new Map(MOTION_PRESETS.map((m) => [m.id, m]))
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const facing = (from: XZ, to: XZ): number => Math.atan2(-(to.x - from.x), -(to.z - from.z))
const fwdOf = (h: number): XZ => ({ x: -Math.sin(h), z: -Math.cos(h) })
const flat = (d: XZ): number => Math.hypot(d.x, d.z)
const add = (a: XZ, b: XZ, k = 1): XZ => ({ x: a.x + b.x * k, z: a.z + b.z * k })
const sub = (a: XZ, b: XZ): XZ => ({ x: a.x - b.x, z: a.z - b.z })
function unit(d: XZ, fallback: XZ = { x: 0, z: -1 }): XZ {
  const l = flat(d)
  return l < 1e-9 ? fallback : { x: d.x / l, z: d.z / l }
}
const dist3 = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Joints + root move of a motion at local time t (linear, missing keys = 0 — the evaluator's rule). */
function sampleMotion(m: MotionPreset, t: number): { joints: Joints; forward: number; up: number } {
  const k = m.keyframes
  const at = (i: number): { joints: Joints; forward: number; up: number } => ({
    joints: { ...k[i]!.joints },
    forward: k[i]!.move?.forward ?? 0,
    up: k[i]!.move?.up ?? 0
  })
  if (t <= k[0]!.t) return at(0)
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i]!
    const b = k[i + 1]!
    if (t <= b.t) {
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      const joints: Joints = {}
      for (const key of new Set([...Object.keys(a.joints), ...Object.keys(b.joints)])) {
        joints[key] = (a.joints[key] ?? 0) + ((b.joints[key] ?? 0) - (a.joints[key] ?? 0)) * u
      }
      const fa = a.move?.forward ?? 0
      const ua = a.move?.up ?? 0
      return { joints, forward: fa + ((b.move?.forward ?? 0) - fa) * u, up: ua + ((b.move?.up ?? 0) - ua) * u }
    }
  }
  return at(k.length - 1)
}

/** Piecewise-linear map through (x, y) anchors (x ascending), clamped at both ends' slopes. */
function piecewise(anchors: [number, number][]): (x: number) => number {
  return (x: number) => {
    for (let i = 0; i < anchors.length - 1; i++) {
      const [x0, y0] = anchors[i]!
      const [x1, y1] = anchors[i + 1]!
      if (x <= x1 || i === anchors.length - 2) return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1
    }
    return anchors[0]![1]
  }
}

interface Fighter {
  input: FighterInput
  dims: PersonDims
  build: number
  scale: number
  /** Root-move scale: motions are authored on the 1.78 m reference man. */
  k: number
  y: number
  marks: FightMarkSpec[]
  spot: XZ
  heading: number
  down: boolean
  /** Held weapons (one per hand). */
  held: HeldWeapon[]
  /** While a gun beat is solved: how far down the barrel line its contact point sits (m; 0 = none). */
  shotRange: number
  /** Floor contact (fork, ground.ts): every mark rests the body's lowest point on the floor. */
  floor: FloorBody
  /** Body blows land on this torso's surface (fork, contact.ts). */
  torso: TorsoShape
}

function fighterOf(input: FighterInput): Fighter {
  const b = input.params?.build
  const held: HeldWeapon[] = []
  for (const w of input.weapons ?? []) {
    const spec = weaponSpec(w.assetId)
    if (spec && !held.some((h) => h.hand === w.hand)) held.push({ spec, hand: w.hand, scale: w.scale > 0 ? w.scale : 1 })
  }
  return {
    input,
    dims: personDims(input.assetId, input.params),
    build: clamp(typeof b === 'number' ? b : 1, 0.8, 1.3),
    scale: input.scale > 0 ? input.scale : 1,
    k: (personDims(input.assetId, input.params).H / 1.78) * (input.scale > 0 ? input.scale : 1),
    y: input.start.y,
    marks: [],
    spot: { x: input.start.x, z: input.start.z },
    heading: 0,
    down: false,
    held,
    shotRange: 0,
    floor: floorBody(input.assetId, input.params, input.scale > 0 ? input.scale : 1, input.start.y),
    torso: torsoShape(input.assetId, input.params, personDims(input.assetId, input.params))
  }
}

/** The weapon a hand fights with: its own, or the two-handed one the other hand holds. */
function weaponOf(f: Fighter, e: Effector): HeldWeapon | null {
  if (e !== 'handL' && e !== 'handR') return null
  const side = e === 'handL' ? 'L' : 'R'
  const own = f.held.find((h) => h.hand === side)
  if (own) return own
  const other = f.held.find((h) => h.hand !== side)
  return other?.spec.support ? other : null
}

/** A blow from a hand on a two-handed weapon comes from the hand that holds it. */
function strikeEffector(f: Fighter, e: Effector): Effector {
  const w = weaponOf(f, e)
  return w ? (w.hand === 'L' ? 'handL' : 'handR') : e
}

/**
 * Fighter-local point where an effector meets things. Unarmed: the rig
 * effector. A hand with a weapon: the weapon's strike or guard point (a gun
 * beat's: `shotRange` down the barrel line), in the pose the evaluator gives
 * the fighter (the grip poses of `holdJoints`; `evaluated` joints have them).
 */
function contactLocal(f: Fighter, joints: Joints | undefined, e: Effector, role: 'strike' | 'guard' = 'strike', evaluated = false): V3 {
  const w = weaponOf(f, e)
  if (!w) return poseEffectors(f.dims, joints)[e]
  const j = evaluated ? joints : holdJoints(f.dims, joints, f.held)
  const range = role === 'strike' ? f.shotRange / w.scale : 0
  const t = w.spec.tip
  const a = w.spec.aim
  const p = range > 0 ? { x: t.x + a.x * range, y: t.y + a.y * range, z: t.z + a.z * range } : weaponContact(w.spec, role)
  return heldPointLocal(f.dims, j, w.hand, w.spec, p, w.scale)
}

function addMark(f: Fighter, time: number, pos: XZ, y: number, gait: GaitId, joints: Joints, heading: number): void {
  const last = f.marks[f.marks.length - 1]
  if (last && time <= last.time + 1e-6) f.marks.pop()
  f.marks.push({
    time,
    position: { x: pos.x, y, z: pos.z },
    gait,
    easeIn: 0,
    easeOut: 0,
    hold: 0,
    joints: { ...joints },
    arriveHeading: heading,
    lockFacing: true
  })
}

/** Drop marks at or after t (a newer motion takes over from t). */
function truncate(f: Fighter, t: number): void {
  while (f.marks.length > 1 && f.marks[f.marks.length - 1]!.time >= t - 1e-6) f.marks.pop()
}

/** World-space effector (or weapon point) of a fighter in a pose at a root/heading. */
function effectorWorld(f: Fighter, joints: Joints, root: XZ, y: number, heading: number, e: Effector, role: 'strike' | 'guard' = 'strike'): V3 {
  return toWorld(contactLocal(f, joints, e, role), { x: root.x, y, z: root.z }, heading, f.scale)
}

/** The point a blow aims at on the defender (also used by blocks via the guard hand). */
export function fightTarget(
  dims: PersonDims,
  scale: number,
  joints: Joints | undefined,
  position: V3,
  heading: number,
  toward: XZ,
  zone: FightBeat['target'],
  effector: Effector,
  torso: TorsoShape
): V3 {
  const fx = poseEffectors(dims, joints)
  const w = (p: V3): V3 => toWorld(p, position, heading, scale)
  const t = unit(toward)
  const push = (p: V3, d: number): V3 => ({ x: p.x + t.x * d, y: p.y, z: p.z + t.z * d })
  if (zone === 'head' && effector.startsWith('elbow')) {
    // Fork: an elbow lands on the jaw, the head's surface ELBOW_JAW below its middle.
    const h = w(fx.head)
    return push({ ...h, y: h.y - dims.headR * scale * Math.sin(ELBOW_JAW) }, dims.headR * scale * Math.cos(ELBOW_JAW))
  }
  if (zone === 'head') return push(w(fx.head), dims.headR * scale)
  if (zone === 'legs') {
    const l = w(fx.kneeL)
    const r = w(fx.kneeR)
    const lead = flat(sub(l, add(position, t))) <= flat(sub(r, add(position, t))) ? l : r
    return push(lead, 0.08)
  }
  // Body (fork, contact.ts): on the torso's surface toward the attacker — the
  // chest for fists and elbows, the lower torso for a knee, the midsection
  // (belt to lower ribs) for a kick.
  const yFrac = effector.startsWith('knee') ? 0.2 : effector.startsWith('foot') ? KICK_MIDSECTION : 0.55
  return torsoSurface(torso, dims, scale, joints, position, heading, t, yFrac)
}

/**
 * The defender's hand a blocked blow lands on: the one on the side the blow
 * travels — a blow on the attacker's left (local x < 0) meets the defender's
 * right hand, and vice versa.
 */
function guardHand(attackerLocalX: number): 'handL' | 'handR' {
  return attackerLocalX < 0 ? 'handR' : 'handL'
}

/** Weapons: an armed defender takes a blocked blow on its blade or shield, whichever hand holds it. */
function guardSide(f: Fighter, side: 'handL' | 'handR'): 'handL' | 'handR' {
  const shield = shieldHand(f)
  if (shield) return shield === 'L' ? 'handL' : 'handR'
  const guards = (e: 'handL' | 'handR'): boolean => {
    const w = weaponOf(f, e)
    return !!w && w.spec.kind !== 'gun' && w.spec.kind !== 'bow'
  }
  const other = side === 'handL' ? 'handR' : 'handL'
  return !guards(side) && guards(other) ? other : side
}

/** Shields (fork): the hand a fighter's shield is in — it blocks and parries with it — or null. */
function shieldHand(f: Fighter): 'L' | 'R' | null {
  return f.held.find((h) => h.spec.kind === 'shield')?.hand ?? null
}

/** Weapons: a one-handed weapon move (all blows from one hand), mirrored onto the other hand. */
function mirroredMove(m: MotionPreset): MotionPreset {
  return { ...m, keyframes: m.keyframes.map((k) => ({ ...k, joints: mirrorJoints(k.joints) })) }
}

const MIRROR_EFFECTOR: Record<Effector, Effector> = {
  handL: 'handR', handR: 'handL', elbowL: 'elbowR', elbowR: 'elbowL', footL: 'footR', footR: 'footL',
  kneeL: 'kneeR', kneeR: 'kneeL', shoulderL: 'shoulderR', shoulderR: 'shoulderL', head: 'head', chest: 'chest', pelvis: 'pelvis'
}

function pitchJoint(e: Effector): string {
  const side = e.endsWith('L') ? 'L' : 'R'
  return e.startsWith('hand') || e.startsWith('elbow') ? `shoulder${side}X` : `hip${side}X`
}

/** Δ on one joint channel (within ±range) that brings the effector to height y, and the height error left. */
function solveChannel(
  f: Fighter,
  joints: Joints,
  e: Effector,
  rootY: number,
  targetY: number,
  key: string,
  range: number,
  role: 'strike' | 'guard' = 'strike'
): { delta: number; err: number } {
  const err = (d: number): number => {
    const j = { ...joints, [key]: (joints[key] ?? 0) + d }
    return rootY + contactLocal(f, j, e, role).y * f.scale - targetY
  }
  const N = 48
  let best = 0
  let bestErr = Math.abs(err(0))
  let prevD = -range
  let prevE = err(prevD)
  let bracket: [number, number] | null = null
  for (let i = 0; i <= N; i++) {
    const d = -range + (2 * range * i) / N
    const v = err(d)
    if (Math.abs(v) < bestErr) {
      bestErr = Math.abs(v)
      best = d
    }
    if (i > 0 && Math.sign(v) !== Math.sign(prevE) && (!bracket || Math.abs(d) < Math.abs(bracket[1]))) bracket = [prevD, d]
    prevD = d
    prevE = v
  }
  if (!bracket) return { delta: best, err: bestErr }
  let [lo, hi] = bracket
  let elo = err(lo)
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const em = err(mid)
    if (Math.sign(em) === Math.sign(elo)) {
      lo = mid
      elo = em
    }
    else hi = mid
  }
  const delta = (lo + hi) / 2
  return { delta, err: Math.abs(err(delta)) }
}

/**
 * Joint offsets that pitch the striking limb so the effector reaches height
 * y: the shoulder or hip X channel first; if that alone can't reach (a hook's
 * forearm runs sideways), the abduction (Z) channel on top of it.
 */
function solvePitch(f: Fighter, joints: Joints, e: Effector, rootY: number, targetY: number, wide = 1): Joints {
  const x = pitchJoint(e)
  const first = solveChannel(f, joints, e, rootY, targetY, x, (x.startsWith('hip') ? LEG_PITCH : ARM_PITCH) * wide)
  if (first.err <= 1e-3) return { [x]: first.delta }
  const z = x.replace(/X$/, 'Z')
  const withX = { ...joints, [x]: (joints[x] ?? 0) + first.delta }
  const second = solveChannel(f, withX, e, rootY, targetY, z, ABDUCT_PITCH * wide)
  const out = second.err < first.err ? { [x]: first.delta, [z]: second.delta } : { [x]: first.delta }
  // A weapon that still falls short (a short axe, a low follow-through) bends the elbow too.
  const err = Math.min(first.err, second.err)
  if (err <= 1e-3 || !weaponOf(f, e)) return out
  const elbow = `elbow${e.endsWith('L') ? 'L' : 'R'}`
  const third = solveChannel(f, withOffsets(joints, out), e, rootY, targetY, elbow, WEAPON_ELBOW)
  return third.err < err ? { ...out, [elbow]: third.delta } : out
}

/**
 * Reach (fork): a torso lean (pitch torsoX and side bend torsoZ, on top of
 * the move's own, at most MAX_LEAN) plus the limb pitch re-solved on it, that
 * bring an arm blow's effector to height y: in the lean direction that comes
 * closest at the full lean (or `dir`, found on an earlier pass), the
 * smallest lean that reaches, else the full lean. `spacing` is how far the
 * attacker placed in a pose stays out of the defender's body; a lean that
 * takes it into the body, or deeper than upright, is out.
 */
function solveLean(
  f: Fighter,
  joints: Joints,
  e: Effector,
  rootY: number,
  targetY: number,
  wide: number,
  spacing: (joints: Joints) => number,
  dir?: number
): { offsets: Joints; dir?: number } {
  let minSpacing = -Infinity
  const at = (r: number, a: number): { o: Joints; err: number; a: number; space: number } => {
    const lean: Joints = { torsoX: r * Math.cos(a), torsoZ: r * Math.sin(a) }
    const o = { ...solvePitch(f, withOffsets(joints, lean), e, rootY, targetY, wide), ...lean }
    const posed = withOffsets(joints, o)
    const space = spacing(posed)
    return { o, err: space < minSpacing ? Infinity : Math.abs(rootY + contactLocal(f, posed, e).y * f.scale - targetY), a, space }
  }
  const upright = at(0, 0)
  if (upright.err <= 1e-3) return { offsets: upright.o, dir }
  minSpacing = Math.min(upright.space, 0) - 0.005
  const DIRS = 12
  let full = at(MAX_LEAN, dir ?? 0)
  for (let d = 1; dir === undefined && d < DIRS; d++) {
    const c = at(MAX_LEAN, (2 * Math.PI * d) / DIRS)
    if (c.err < full.err) full = c
  }
  if (full.err >= upright.err) return { offsets: upright.o, dir }
  if (full.err > 1e-3) return { offsets: full.o, dir: full.a }
  let lo = 0
  let hi = MAX_LEAN
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2
    if (at(mid, full.a).err <= 1e-3) hi = mid
    else lo = mid
  }
  return { offsets: at(hi, full.a).o, dir: full.a }
}

function withOffsets(joints: Joints, offsets: Joints): Joints {
  const out = { ...joints }
  for (const [k, v] of Object.entries(offsets)) out[k] = (out[k] ?? 0) + v
  return out
}

function padOutcomes(outcomes: FightOutcome[], n: number): FightOutcome[] {
  const given = outcomes.length > 0 ? outcomes : (['hit'] as FightOutcome[])
  if (given.length >= n) return given.slice(given.length - n)
  return [...Array<FightOutcome>(n - given.length).fill('block'), ...given]
}

/** One timed piece of the defender's beat: a motion, its time map and root path. */
interface DefEvent {
  start: number
  end: number
  motion: MotionPreset | null
  mirror: boolean
  /** (absolute time, motion-local time) anchors; the map is piecewise-linear through them. */
  anchors: [number, number][]
  /** Absolute time → root offset from the event's base spot, and root height. */
  root: (t: number) => { off: XZ; up: number }
  base: XZ
  /** Extra sample times (snap curve, sidestep ramp). */
  times: number[]
  /** Joint offsets on top of the motion (head snap). */
  extra: (t: number) => Joints | null
}

function constantEvent(start: number, end: number, motion: MotionPreset | null, base: XZ, mirror = false): DefEvent {
  return {
    start,
    end,
    motion,
    mirror,
    anchors: [
      [start, 0],
      [start + Math.max(1e-3, motion?.duration ?? end - start), Math.max(1e-3, motion?.duration ?? end - start)]
    ],
    root: () => ({ off: { x: 0, z: 0 }, up: 0 }),
    base,
    times: [],
    extra: () => null
  }
}

function eventPose(ev: DefEvent, t: number, guard: Joints): { joints: Joints; off: XZ; up: number } {
  const s = ev.motion ? sampleMotion(ev.motion, clamp(piecewise(ev.anchors)(t), 0, ev.motion.duration)) : { joints: { ...guard } }
  let joints = ev.mirror ? mirrorJoints(s.joints) : s.joints
  const extra = ev.extra(t)
  if (extra) {
    joints = { ...joints }
    for (const [k, v] of Object.entries(extra)) joints[k] = (joints[k] ?? 0) + v
  }
  const r = ev.root(t)
  return { joints, off: r.off, up: r.up }
}

export function solveFight(
  fight: FightDoc,
  fighters: [FighterInput, FighterInput],
  shot: { duration: number; fps: number },
  opts: FightSolveOptions = {}
): FightSolution {
  const fps = shot.fps > 0 ? shot.fps : 24
  const obstacles = opts.obstacles ?? []
  const onGrid = (x: number): number => Math.round(x * fps) / fps
  const upGrid = (x: number): number => Math.ceil(x * fps - 1e-9) / fps
  const exaggeration = clamp(fight.exaggeration ?? 1.5, 1, 3)
  const beatGap = fight.beatGap ?? 0.35
  const firstStart = fight.startT ?? 0.4
  const guard = { ...BY_ID.get(REACTIONS.guard)!.keyframes[0]!.joints }
  const F: [Fighter, Fighter] = [fighterOf(fighters[0]), fighterOf(fighters[1])]
  const warnings: string[] = []
  const beats: BeatReport[] = []
  type Hit = { beat: number; i: number; time: number; attacker: 0 | 1; zone: FightBeat['target']; effector: Effector; outcome: FightOutcome; shotRange: number }
  const hits: Hit[] = []

  F[0].heading = facing(F[0].spot, F[1].spot)
  F[1].heading = facing(F[1].spot, F[0].spot)
  for (const f of F) addMark(f, 0, f.spot, groundY(f.floor, guard), 'stand', guard, f.heading)
  let prevEnd = 0

  for (let n = 0; n < fight.beats.length; n++) {
    const beat = fight.beats[n]!
    const name = `Beat ${n + 1}`
    const label = `${name} (${beat.attacker === 0 ? 'A' : 'B'} ${SHOT_MOVES.has(beat.move) ? 'shoot' : beat.move} → ${beat.target})`
    const atk = F[beat.attacker]
    const def = F[beat.attacker === 0 ? 1 : 0]
    if (atk.down || def.down) {
      warnings.push(`${name} dropped: a fighter is down`)
      continue
    }
    // Weapons: a gun beat plays its gun's aim (shouldered for long guns), fired from the gun hand and
    // mirrored onto a left-hand gun; a one-hand strike mirrors onto the weapon hand when only the
    // other hand is armed; a blow from a hand on a two-hander comes from its holding hand.
    const shotBeat = SHOT_MOVES.has(beat.move)
    // A bow shoots too (its loose); a gun in the other hand goes first.
    const gun = shotBeat ? (atk.held.find((h) => h.spec.kind === 'gun') ?? atk.held.find((h) => h.spec.kind === 'bow')) : undefined
    const move = gun ? gunAimMove(gun.spec) : beat.move
    const raw = shotBeat ? (gun ? shotImpacts(move) : []) : strikeImpacts(beat.move)
    const mirror = shotBeat
      ? !!gun && gun.hand !== shotHand(move)
      : raw.length > 0 && raw.every((imp) => !weaponOf(atk, imp.effector) && !!weaponOf(atk, MIRROR_EFFECTOR[imp.effector]))
    const preset0 = fightMotion(move)
    const preset = preset0 && mirror ? mirroredMove(preset0) : preset0
    const impacts: StrikeImpact[] = !preset
      ? []
      : raw.map((imp) => ({ ...imp, effector: strikeEffector(atk, mirror ? MIRROR_EFFECTOR[imp.effector] : imp.effector) }))
    if (!preset || impacts.length === 0) {
      warnings.push(shotBeat ? `${label} dropped: ${beat.attacker === 0 ? 'A' : 'B'} has no gun or bow in hand` : `${label} dropped: ${beat.move} is not a strike`)
      continue
    }
    const beatWarnings: string[] = []
    let outcomes = padOutcomes(beat.outcomes, impacts.length)
    if (shotBeat && outcomes.some((o) => o === 'block' || o === 'parry')) {
      outcomes = outcomes.map((o): FightOutcome => (o === 'block' || o === 'parry' ? 'miss' : o))
      beatWarnings.push(`${label}: a shot can't be blocked or parried, so it misses`)
    }
    if (gun?.spec.support && !atk.held.some((h) => h.hand !== gun.hand)) {
      // An arm too short for the fore-end (weapons.ts supportReach) holds the gun further back: say so.
      const aim = preset.keyframes.find((kf) => Math.abs(kf.t - impacts[0]!.t) < 1e-9)!.joints
      const r = supportReach(atk.dims, holdJoints(atk.dims, aim, atk.held), gun.hand, gun.spec, gun.scale)
      const who = beat.attacker === 0 ? 'A' : 'B'
      if (r.slideM > SUPPORT_SLACK) beatWarnings.push(`${label}: ${who} can't reach the ${gun.spec.assetId.replace('prop.', '')}'s fore-end; the support hand holds it ${(r.slideM * 100).toFixed(0)} cm further back`)
    }
    const power = clamp(beat.power ?? 0.7, 0.2, 1)
    const clinch = CLINCH_MOVES.has(beat.move)
    const kIdx = impacts.map((imp) => preset.keyframes.findIndex((kf) => Math.abs(kf.t - imp.t) < 1e-9))
    const last = impacts[impacts.length - 1]!

    // 1. Start time: explicit or after the previous beat, never before it ends.
    let desired = Math.max(beat.at ?? prevEnd + beatGap, firstStart)
    if (desired < prevEnd) {
      beatWarnings.push(`${label} moved to ${prevEnd.toFixed(2)} s: the previous beat was still running`)
      desired = prevEnd
    }

    // 2. Geometry that doesn't depend on time: who stands where, facing whom.
    const D = def.spot
    const A0 = atk.spot
    const hd = facing(D, A0)
    atk.shotRange = 0
    if (shotBeat) {
      // The shot's contact point sits down the barrel line, about as far as the target: the shooter holds its ground.
      const aim = preset.keyframes.find((kf) => Math.abs(kf.t - impacts[0]!.t) < 1e-9)!.joints
      const muzzle = contactLocal(atk, aim, impacts[0]!.effector)
      atk.shotRange = Math.max(0.3, flat(sub(D, A0)) - Math.hypot(muzzle.x, muzzle.z) * atk.scale - 0.15)
    }
    const physics = impacts.map((imp, i) => {
      // A bullet doesn't care who fires it; a melee blow carries the attacker's body and weapon.
      const w = shotBeat ? null : weaponOf(atk, imp.effector)
      const bothHands = !!w?.spec.support && !atk.held.some((h) => h.hand !== w.hand)
      return impact({
        moveId: beat.move,
        effector: imp.effector,
        speed: imp.speed,
        power,
        outcome: outcomes[i]!,
        defender: def.dims,
        defenderBuild: def.build,
        exaggeration,
        ...(shotBeat ? {} : { attacker: atk.dims, attackerBuild: atk.build }),
        ...(w ? { weapon: weaponHeft(w.spec, w.scale, atk.dims, atk.scale, beat.move, bothHands) } : {})
      })
    })

    const plan = (desiredStart: number, ceil: boolean) => {
      const notes: string[] = []
      const tf0 = desiredStart + last.t
      // On the frame grid, never earlier than asked.
      let tf = ceil ? upGrid(tf0) : onGrid(tf0)
      if (tf - last.t < desiredStart - 1e-9) tf = upGrid(tf0)
      const startT = tf - last.t
      const times = impacts.map((imp, i) => (i === impacts.length - 1 ? tf : onGrid(startT + imp.t)))
      for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]! + 1e-9) times[i] = times[i - 1]! + 1 / fps
      const warp = piecewise([
        [0, 0],
        ...impacts.map((imp, i): [number, number] => [imp.t, times[i]! - startT]),
        [preset.duration, preset.duration]
      ])

      // Defender timeline for this beat.
      const events: DefEvent[] = []
      const avoidIdx: number[] = []
      const blockEvents = new Map<number, DefEvent>()
      let base: XZ = { ...D }
      const away = unit(sub(D, A0), fwdOf(hd + Math.PI))
      for (let i = 0; i < impacts.length; i++) {
        const o = outcomes[i]!
        const T = times[i]!
        const zoneHigh = beat.target === 'head'
        if (o === 'block' || o === 'parry' || o === 'slip' || o === 'duck') {
          // A shield blocks and parries with the shield blocks (authored in the left hand).
          const shield = o === 'block' || o === 'parry' ? shieldHand(def) : null
          const d = shield ? SHIELD_BLOCK : DEFENSES[o]
          const m = BY_ID.get(zoneHigh ? d.high : d.low)!
          const start = T - d.readyFraction * m.duration
          // Slip away from the striking side.
          const mirror = shield ? shield === 'R' : o === 'slip' && impacts[i]!.effector.endsWith('R')
          const ev = constantEvent(start, start + m.duration, m, base, mirror)
          const ph = physics[i]!
          if ((o === 'block' || o === 'parry') && (ph.result === 'stagger' || ph.result === 'knockdown')) {
            let back = ph.result === 'stagger' ? ph.stepBack : Math.min(0.6, ph.slide * 0.5)
            back = propStop(notes, label, beat.attacker === 0 ? 'B' : 'A', 'push-back', base, away, back, 0, obstacles)
            const dur = ph.result === 'stagger' ? ph.stepDuration : 0.4
            ev.root = (t) => ({ off: { x: away.x * back * clamp((t - T) / dur, 0, 1), z: away.z * back * clamp((t - T) / dur, 0, 1) }, up: 0 })
            // The guard holds while the blow rocks the body back (torso, then head) and the feet give ground.
            const rock = GUARD_ROCK * clamp(ph.capture / (0.6 * def.dims.legLen), 0.6, 1)
            const span = dur + 0.25
            ev.extra = (t) => {
              if (t <= T || t >= T + span) return null
              const b = Math.sin((Math.PI * (t - T)) / span)
              return { torsoX: -rock * b, headX: -0.6 * rock * b }
            }
            ev.times = [T + dur, ...[1, 2, 3, 4, 5].map((k) => T + (span * k) / 6), T + span]
            base = add(base, away, back)
          }
          events.push(ev)
          if (o === 'block' || o === 'parry') blockEvents.set(i, ev)
          if (o === 'slip' || o === 'duck') avoidIdx.push(i)
        }
        else if (o === 'miss') {
          const prev = events[events.length - 1]
          const ev = prev && prev.end > T ? { ...prev, times: [...prev.times] } : constantEvent(T - 0.25, T + 0.4, null, base)
          if (!(prev && prev.end > T)) events.push(ev)
          avoidIdx.push(i)
        }
        else {
          // hit / ko: the reaction starts on the impact frame.
          const ph = physics[i]!
          const id =
            ph.result === 'knockdown'
              ? o === 'ko'
                ? REACTIONS.ko
                : REACTIONS.knockdown
              : ph.result === 'stagger'
                ? REACTIONS.stagger
                : beat.target === 'head'
                  ? REACTIONS.head
                  : REACTIONS.body
          const m = BY_ID.get(id)!
          const fwd = m.keyframes.map((kf) => -(kf.move?.forward ?? 0))
          const maxBack = Math.max(0, ...fwd)
          let anchors: [number, number][] = [
            [T, 0],
            [T + m.duration, m.duration]
          ]
          let end = T + m.duration
          let root = (_t: number): { off: XZ; up: number } => ({ off: { x: 0, z: 0 }, up: 0 })
          let travel = 0
          if (ph.result === 'stagger') {
            const kTr = m.keyframes.findIndex((kf) => -(kf.move?.forward ?? 0) >= maxBack - 1e-9)
            const tTr = kTr > 0 ? m.keyframes[kTr]!.t : m.duration
            anchors = [
              [T, 0],
              [T + ph.stepDuration, tTr],
              [T + ph.stepDuration + (m.duration - tTr), m.duration]
            ]
            const toLocal = piecewise(anchors)
            end = T + ph.stepDuration + (m.duration - tTr)
            travel = ph.stepBack
            root = (t) => {
              const s = sampleMotion(m, clamp(toLocal(t), 0, m.duration))
              const f = maxBack > 0 ? -s.forward / maxBack : 0
              return { off: { x: away.x * travel * f, z: away.z * travel * f }, up: 0 }
            }
          }
          else if (ph.result === 'knockdown') {
            const minUp = Math.min(0, ...m.keyframes.map((kf) => kf.move?.up ?? 0))
            const kLand = m.keyframes.findIndex((kf) => (kf.move?.up ?? 0) <= minUp * 0.9 - 1e-9)
            const tLand = kLand > 0 ? m.keyframes[kLand]!.t : m.duration
            anchors = [
              [T, 0],
              [T + ph.fallDuration, tLand],
              [T + ph.fallDuration + (m.duration - tLand), m.duration]
            ]
            const toLocal = piecewise(anchors)
            end = T + ph.fallDuration + (m.duration - tLand)
            travel = ph.slide
            root = (t) => {
              const tl = clamp(toLocal(t), 0, m.duration)
              const s = sampleMotion(m, tl)
              const f = maxBack > 0 ? -s.forward / maxBack : Math.min(1, tl / tLand)
              return { off: { x: away.x * travel * f, z: away.z * travel * f }, up: s.up * def.k }
            }
          }
          // Set props (fork): the stagger / slide stops where the body (fallen: its full length) meets one.
          if (travel > 0) {
            const what = ph.result === 'knockdown' ? 'slide' : 'stagger'
            travel = propStop(notes, label, beat.attacker === 0 ? 'B' : 'A', what, base, away, travel, ph.result === 'knockdown' ? fallReach(def, m) : 0, obstacles)
          }
          const ev: DefEvent = { start: T, end, motion: m, mirror: false, anchors, root, base, times: [], extra: () => null }
          if (beat.target !== 'legs') {
            const A = snapAmplitude(ph.impulse, exaggeration)
            const curve = snapCurve(A, SNAP_S, SNAP_HZ)
            const hook = HOOK_MOVES.has(beat.move)
            const sign = impacts[i]!.effector.endsWith('R') ? -1 : 1
            const body = beat.target === 'body'
            ev.times = curve.map((p) => T + p.t)
            ev.extra = (t) => {
              const dt = t - T
              if (dt < 0 || dt > SNAP_S + 1e-9) return null
              const j = Math.min(curve.length - 1, Math.floor(dt * SNAP_HZ + 1e-9))
              const a = curve[j]!
              const b = curve[Math.min(curve.length - 1, j + 1)]!
              const v = b.t > a.t ? a.value + ((b.value - a.value) * (dt - a.t)) / (b.t - a.t) : a.value
              const out: Joints = hook ? { headY: sign * v } : { headX: -v }
              if (body) out.torsoX = 0.6 * v
              return out
            }
          }
          events.push(ev)
          base = add(base, away, travel)
        }
      }
      for (let i = 0; i < events.length - 1; i++) events[i]!.end = Math.min(events[i]!.end, events[i + 1]!.start)

      /** Defender root, heading and joints at absolute time t (inside this beat). */
      const defAt = (t: number): { pos: XZ; y: number; joints: Joints } => {
        let ev: DefEvent | null = null
        for (const e of events) if (t >= e.start - 1e-9) ev = e
        if (!ev) return { pos: { ...D }, y: groundY(def.floor, guard), joints: { ...guard } }
        const p = eventPose(ev, t, guard)
        return { pos: add(ev.base, p.off), y: groundY(def.floor, p.joints), joints: p.joints }
      }

      // 3. Attacker placement per impact, iterated so "toward the attacker" is self-consistent.
      const place: { root: XZ; heading: number; pitch: Joints; lift: number; base: XZ; target: V3; error: number; rootY: number }[] = []
      for (let i = 0; i < impacts.length; i++) {
        const imp = impacts[i]!
        const kf = preset.keyframes[kIdx[i]!]!
        const o = outcomes[i]!
        const T = times[i]!
        const dState = defAt(T)
        const dPos: V3 = { x: dState.pos.x, y: dState.y, z: dState.pos.z }
        const aimJoints = o === 'slip' || o === 'duck' || o === 'miss' ? guard : dState.joints
        const aimPos: V3 = o === 'slip' || o === 'duck' || o === 'miss' ? { x: D.x, y: groundY(def.floor, guard), z: D.z } : dPos
        const kick = imp.effector.startsWith('foot') || imp.effector.startsWith('knee')
        // One placement; `wide` scales the limbs' pitch ranges, `lean` leans the torso too (fork: the reach retry below).
        const placeAt = (wide: number, lean = false) => {
          // Floor contact (fork): the root height rests the pitched pose's lowest point on the floor.
          let rootY = groundY(atk.floor, kf.joints)
          let R: XZ = add(aimPos, unit(sub(A0, aimPos)), 0.8)
          let result = { root: R, heading: 0, pitch: {} as Joints, lift: 0, base: R, target: aimPos, error: Infinity, rootY }
          let armFix: Joints = {}
          let leanDir: number | undefined
          for (let it = 0; it < 8; it++) {
            const toward = unit(sub(R, aimPos))
            let T3 = fightTarget(def.dims, def.scale, aimJoints, aimPos, hd, toward, beat.target, imp.effector, def.torso)
            if (o === 'block' || o === 'parry') {
              // The blow lands on the guard hand on its side, and that arm reaches
              // to the height the blow comes in at (elbow, then abduction).
              const aimPitch = solvePitch(atk, kf.joints, imp.effector, rootY, T3.y, wide)
              const aimed = withOffsets(kf.joints, aimPitch)
              const e0 = contactLocal(atk, aimed, imp.effector)
              const side = guardSide(def, guardHand(e0.x))
              const h = rootY + e0.y * atk.scale
              const s = strikeEffector(def, side).endsWith('L') ? 'L' : 'R'
              // A shield doesn't reach: the blow meets its face where it is (reaching would turn the face away).
              const reach = weaponOf(def, side)?.spec.kind === 'shield' ? 0 : 1
              const first = solveChannel(def, aimJoints, side, aimPos.y, h, `elbow${s}`, BLOCK_ELBOW * reach, 'guard')
              armFix = { [`elbow${s}`]: first.delta }
              let guardErr = first.err
              if (first.err > 1e-3) {
                const second = solveChannel(def, withOffsets(aimJoints, armFix), side, aimPos.y, h, `shoulder${s}Z`, ABDUCT_PITCH * reach, 'guard')
                if (second.err < first.err) {
                  armFix = { ...armFix, [`shoulder${s}Z`]: second.delta }
                  guardErr = second.err
                }
              }
              if (guardErr > 1e-3 && weaponOf(def, side)) {
                // A blade or shield held high (a parry) also swings the shoulder to meet the blow's height.
                const third = solveChannel(def, withOffsets(aimJoints, armFix), side, aimPos.y, h, `shoulder${s}X`, ARM_PITCH * reach, 'guard')
                if (third.err < guardErr) armFix = { ...armFix, [`shoulder${s}X`]: third.delta }
              }
              const hand = effectorWorld(def, withOffsets(aimJoints, armFix), aimPos, aimPos.y, hd, side, 'guard')
              T3 = { x: hand.x + toward.x * 0.05 * def.scale, y: hand.y, z: hand.z + toward.z * 0.05 * def.scale }
            }
            // A two-hand grip pitches both arms alike, so the off hand stays on the grip.
            // A lean (fork): the attacker placed in a pose as below, and how far its torso and head stay out of the defender.
            const spacing = (j: Joints): number => {
              const e = contactLocal(atk, j, imp.effector)
              const u = unit(sub(A0, T3), unit(sub(A0, aimPos)))
              const root = add(T3, u, Math.hypot(e.x, e.z) * atk.scale)
              const at: V3 = { x: root.x, y: rootY, z: root.z }
              const heading = Math.atan2(u.x, u.z) - Math.atan2(-e.x, -e.z)
              const toward = unit(sub(aimPos, root))
              const head = toWorld(poseEffectors(atk.dims, j).head, at, heading, atk.scale)
              const points = [0.3, 0.6, 0.9].map((y) => torsoSurface(atk.torso, atk.dims, atk.scale, j, at, heading, toward, y))
              points.push({ x: head.x + toward.x * atk.dims.headR * atk.scale, y: head.y, z: head.z + toward.z * atk.dims.headR * atk.scale })
              return Math.min(...points.map((q) => bodyClearance(def.torso, def.dims, def.build, def.scale, aimJoints, aimPos, hd, q)))
            }
            const fit = lean ? solveLean(atk, kf.joints, imp.effector, rootY, T3.y, wide, spacing, leanDir) : null
            leanDir = fit?.dir
            const pitch = gripPitch(beat.move, fit ? fit.offsets : solvePitch(atk, kf.joints, imp.effector, rootY, T3.y, wide))
            const joints = withOffsets(kf.joints, pitch)
            const e = contactLocal(atk, joints, imp.effector)
            // A kick still short of the target lifts the kicker, only as much as needed.
            const short = T3.y - (rootY + e.y * atk.scale)
            const lift = kick && short > 1e-3 ? Math.min(MAX_KICK_LIFT, short) : 0
            const ex = e.x * atk.scale
            const ez = e.z * atk.scale
            const r = Math.hypot(ex, ez)
            const phi = Math.atan2(-ex, -ez)
            const uA = unit(sub(A0, T3), unit(sub(A0, aimPos)))
            R = add(T3, uA, r)
            if (!clinch && flat(sub(R, dState.pos)) < MIN_SEPARATION) R = add(dState.pos, unit(sub(R, dState.pos), uA), MIN_SEPARATION)
            const heading = Math.atan2(uA.x, uA.z) - phi
            const E = effectorWorld(atk, joints, R, rootY + lift, heading, imp.effector)
            const fwd = fwdOf(heading)
            const base = add(R, fwd, -(kf.move?.forward ?? 0) * atk.k)
            result = { root: R, heading, pitch, lift, base, target: T3, error: dist3(E, T3), rootY }
            // Floor contact (fork): re-solve until the pitched pose's root height holds.
            const y = groundY(atk.floor, joints)
            if (it >= 3 && Math.abs(y - rootY) < 1e-5) break
            rootY = y
          }
          return { result, armFix }
        }
        let { result, armFix } = placeAt(1)
        // Reach (fork): a blow that still misses, or a body or legs kick that has to lift the kicker, tries
        // again with the limb pitched wider, which brings the attacker in closer (spacing rules still hold).
        // Head kicks keep their lift.
        if ((o === 'hit' || o === 'ko') && (result.error > CONTACT_TOLERANCE || (kick && beat.target !== 'head' && result.lift > 0))) {
          const wider = placeAt(WIDE_REACH)
          const better = wider.result.error <= CONTACT_TOLERANCE ? result.error > CONTACT_TOLERANCE || wider.result.lift < result.lift - 1e-3 : wider.result.error < result.error - 1e-3
          if (better) {
            result = wider.result
            armFix = wider.armFix
          }
        }
        // An arm blow still off the surface (an elbow up to a taller head) leans the torso into it, ≤ 20°.
        if ((o === 'hit' || o === 'ko') && !kick && result.error > LEAN_TOLERANCE) {
          const leaned = placeAt(WIDE_REACH, true)
          if (leaned.result.error < result.error - 1e-3) {
            result = leaned.result
            armFix = leaned.armFix
          }
        }
        const ev = blockEvents.get(i)
        if (ev && Object.keys(armFix).length > 0) {
          // Ramp the reaching arm in by the impact frame and back out by the defense's end (on top of any rock-back).
          const fix = armFix
          const before = ev.extra
          ev.extra = (t) => {
            const f = t <= T ? clamp((t - ev.start) / Math.max(1e-6, T - ev.start), 0, 1) : clamp(1 - (t - T) / Math.max(1e-6, ev.end - T), 0, 1)
            const out: Joints = { ...before(t) }
            if (f <= 0) return Object.keys(out).length > 0 ? out : null
            for (const [k, v] of Object.entries(fix)) out[k] = (out[k] ?? 0) + v * f
            return out
          }
        }
        place.push(result)
      }

      // Root of keyframe j and the placement it belongs to.
      const owner = (j: number): number => {
        for (let i = 0; i < kIdx.length; i++) if (j <= kIdx[i]!) return i
        return kIdx.length - 1
      }
      const kfRoot = (j: number): XZ => {
        const p = place[owner(j)]!
        const pos = add(p.base, fwdOf(p.heading), (preset.keyframes[j]!.move?.forward ?? 0) * atk.k)
        // Outside the clinch, never closer than MIN_SEPARATION.
        if (!clinch) {
          const dPos = defAt(startT + warp(preset.keyframes[j]!.t)).pos
          if (flat(sub(pos, dPos)) < MIN_SEPARATION) return add(dPos, unit(sub(pos, dPos), unit(sub(A0, dPos))), MIN_SEPARATION)
        }
        return pos
      }
      /** The kick lift at keyframe j: ramps up to each lifting impact and lands after. */
      const kfLift = (j: number): number => {
        const t = preset.keyframes[j]!.t
        let lift = 0
        place.forEach((pl, i) => {
          if (pl.lift <= 0) return
          const ti = impacts[i]!.t
          const w = t <= ti ? (ti > 0 ? t / ti : 1) : preset.duration > ti ? (preset.duration - t) / (preset.duration - ti) : 0
          lift = Math.max(lift, pl.lift * clamp(w, 0, 1))
        })
        return lift
      }
      const stepDist = flat(sub(kfRoot(0), A0))
      return { startT, times, warp, events, avoidIdx, defAt, place, owner, kfRoot, kfLift, stepDist, notes }
    }

    // 4. Step-in at ≤ 2.5 m/s: push the beat later rather than teleport.
    const atkLast = atk.marks[atk.marks.length - 1]!.time
    let p = plan(desired, false)
    const need = atkLast + p.stepDist / MAX_STEP_SPEED
    if (p.startT < need - 1e-9) {
      const delay = need - p.startT
      p = plan(need, true)
      beatWarnings.push(`${label} delayed ${delay.toFixed(2)} s so the step-in stays under ${MAX_STEP_SPEED} m/s`)
    }
    beatWarnings.push(...p.notes)
    if (p.times[p.times.length - 1]! > shot.duration - 0.3 + 1e-9) {
      warnings.push(`${name} dropped: past the end of the shot`)
      continue
    }

    // Snapshot for the mark-cap rollback.
    const saved = F.map((f) => ({ marks: f.marks.slice(), spot: { ...f.spot }, heading: f.heading, down: f.down }))
    const savedEnd = prevEnd

    // 5a. Attacker marks: step-in, then the strike keyframes (time-warped, pitched, placed).
    const kfs = preset.keyframes
    for (let j = 0; j < kfs.length; j++) {
      const kf = kfs[j]!
      const i = p.owner(j)
      const pl = p.place[i]!
      let joints: Joints = { ...kf.joints }
      for (let q = 0; q < kIdx.length; q++) {
        const kq = kIdx[q]!
        if (j === kq || (j === kq - 1 && !kIdx.includes(j))) joints = withOffsets(joints, p.place[q]!.pitch)
      }
      const t = p.startT + p.warp(kf.t)
      const pos = p.kfRoot(j)
      let gait: GaitId = 'stand'
      if (j === 0) {
        const lastMark = atk.marks[atk.marks.length - 1]!
        const d = flat(sub(pos, { x: lastMark.position.x, z: lastMark.position.z }))
        // Fork: a step-in (≤ MAX_STEP_SPEED) walks; a jog's flight lifted both feet off the floor.
        gait = d < 0.05 ? 'stand' : 'walk'
      }
      addMark(atk, t, pos, groundY(atk.floor, joints, p.kfLift(j)), gait, joints, pl.heading)
    }
    const atkEnd = p.startT + preset.duration
    atk.spot = p.kfRoot(kfs.length - 1)
    atk.heading = p.place[p.place.length - 1]!.heading

    // 5b. Defender marks: defenses / reactions, with sidesteps so avoided blows clear the head.
    const clearance: number[] = impacts.map(() => NaN)
    const effectorAt = (i: number): V3 => {
      const kf = kfs[kIdx[i]!]!
      const joints = withOffsets(kf.joints, p.place[i]!.pitch)
      return effectorWorld(atk, joints, p.place[i]!.root, p.place[i]!.rootY + p.place[i]!.lift, p.place[i]!.heading, impacts[i]!.effector)
    }
    const headClear = (i: number, extra: XZ): number => {
      const st = p.defAt(p.times[i]!)
      const head = toWorld(poseEffectors(def.dims, st.joints).head, { x: st.pos.x + extra.x, y: st.y, z: st.pos.z + extra.z }, hd, def.scale)
      return dist3(effectorAt(i), head) - def.dims.headR * def.scale
    }
    // Body / legs blows (fork, contact.ts): an avoided blow clears the whole body (2 cm over the
    // minimum for the body model), so the defender steps back from it, or aside.
    const bodyClear = (i: number, extra: XZ): number => {
      const st = p.defAt(p.times[i]!)
      return bodyClearance(def.torso, def.dims, def.build, def.scale, st.joints, { x: st.pos.x + extra.x, y: st.y, z: st.pos.z + extra.z }, hd, effectorAt(i))
    }
    const high = beat.target === 'head'
    const clearOf = high ? headClear : bodyClear
    const clearNeed = high ? MIN_CLEARANCE + 0.002 : MIN_BODY_CLEARANCE + 0.02
    for (const i of p.avoidIdx) {
      const T = p.times[i]!
      const ev = [...p.events].reverse().find((e) => e.start <= T + 1e-9)
      if (!ev) continue
      const line = unit(sub(A0, D))
      const perp = { x: -line.z, z: line.x }
      const back = { x: -line.x, z: -line.z }
      let best: { m: number; n: XZ } | null = null
      if (clearOf(i, { x: 0, z: 0 }) >= clearNeed) best = { m: 0, n: perp }
      else {
        for (const n of high ? [perp, { x: -perp.x, z: -perp.z }] : [back, perp, { x: -perp.x, z: -perp.z }]) {
          if (clearOf(i, { x: n.x, z: n.z }) < clearNeed) continue
          let lo = 0
          let hi = 1
          for (let it = 0; it < 40; it++) {
            const mid = (lo + hi) / 2
            if (clearOf(i, { x: n.x * mid, z: n.z * mid }) >= clearNeed) hi = mid
            else lo = mid
          }
          if (!best || hi < best.m) best = { m: hi, n }
        }
      }
      if (best && best.m > 0) {
        const { m, n } = best
        const rampIn = Math.max(ev.start, T - 0.25)
        const rampOut = Math.max(T + 0.3, ev.end)
        const prevRoot = ev.root
        ev.root = (t) => {
          const r = prevRoot(t)
          const f = t <= T ? clamp((t - rampIn) / Math.max(1e-6, T - rampIn), 0, 1) : clamp(1 - (t - T) / Math.max(1e-6, rampOut - T), 0, 1)
          return { off: { x: r.off.x + n.x * m * f, z: r.off.z + n.z * m * f }, up: r.up }
        }
        ev.times = [...ev.times, rampIn, T, rampOut]
        ev.end = Math.max(ev.end, rampOut)
        beatWarnings.push(`${label}: added a ${(m * 100).toFixed(0)} cm ${n === back ? 'step back' : 'sidestep'} so blow ${i + 1} clears the ${high ? 'head' : 'body'}`)
      }
      clearance[i] = clearOf(i, { x: 0, z: 0 })
    }
    for (const ev of p.events) {
      truncate(def, ev.start)
      const ts = new Set<number>([ev.start])
      if (ev.motion) {
        // Keyframe times in absolute time: the inverse of the event's time map.
        const toAbs = piecewise(ev.anchors.map(([a, l]): [number, number] => [l, a]))
        for (const kf of ev.motion.keyframes) ts.add(kf.t === 0 ? ev.start : toAbs(kf.t))
      }
      for (const t of ev.times) ts.add(t)
      for (const t of p.times) if (t >= ev.start) ts.add(t)
      const sorted = [...ts].filter((t) => t >= ev.start - 1e-9 && t <= ev.end + 1e-9).sort((a, b) => a - b)
      for (const t of sorted) {
        const pose = eventPose(ev, t, guard)
        addMark(def, t, add(ev.base, pose.off), groundY(def.floor, pose.joints), 'stand', pose.joints, hd)
      }
    }
    const lastDef = def.marks[def.marks.length - 1]!
    def.spot = { x: lastDef.position.x, z: lastDef.position.z }
    let defEnd = lastDef.time
    const koed = outcomes.includes('ko')
    const downed = physics.some((ph, i) => ph.result === 'knockdown' && (outcomes[i] === 'hit' || outcomes[i] === 'ko'))
    // A knockdown on the last beat stays down, like a KO (fork: it used to walk from the floor back to guard).
    if (koed || (downed && n === fight.beats.length - 1)) def.down = true
    else if (downed) {
      const getUp = BY_ID.get(REACTIONS.getUp)!
      const t0 = defEnd + 0.2
      for (const kf of getUp.keyframes) {
        addMark(def, t0 + kf.t, def.spot, groundY(def.floor, kf.joints), 'stand', kf.joints, hd)
      }
      defEnd = t0 + getUp.duration
    }

    // 7. Rest: back to guard distance, facing each other (after a shot, both hold their ground).
    const recoveryEnd = Math.max(atkEnd, defEnd)
    let restT = recoveryEnd
    if (!def.down && !shotBeat) {
      const M = { x: (atk.spot.x + def.spot.x) / 2, z: (atk.spot.z + def.spot.z) / 2 }
      const dir = unit(sub(def.spot, atk.spot), fwdOf(atk.heading))
      const aRest = add(M, dir, -GUARD_DISTANCE / 2)
      const dRest = add(M, dir, GUARD_DISTANCE / 2)
      const moveA = flat(sub(aRest, atk.spot))
      const moveD = flat(sub(dRest, def.spot))
      restT = recoveryEnd + clamp(Math.max(moveA, moveD) / 1.5, 0.25, 1.5)
      addMark(atk, restT, aRest, groundY(atk.floor, guard), moveA > 0.05 ? 'walk' : 'stand', guard, facing(aRest, dRest))
      addMark(def, restT, dRest, groundY(def.floor, guard), moveD > 0.05 ? 'walk' : 'stand', guard, facing(dRest, aRest))
      atk.spot = aRest
      def.spot = dRest
      atk.heading = facing(aRest, dRest)
      def.heading = facing(dRest, aRest)
    }
    else {
      restT = recoveryEnd + 0.25
      addMark(atk, restT, atk.spot, groundY(atk.floor, guard), 'stand', guard, facing(atk.spot, def.spot))
    }
    // Floor contact (fork): grounded marks where this beat's in-between poses would float or sink.
    F.forEach((f, q) => {
      let k = 0
      while (k < f.marks.length && f.marks[k] === saved[q]!.marks[k]) k++
      groundBetween(f.floor, f.marks, k - 1, MAX_FIGHT_MARKS)
    })

    if (F[0].marks.length > MAX_FIGHT_MARKS || F[1].marks.length > MAX_FIGHT_MARKS) {
      F.forEach((f, q) => {
        f.marks = saved[q]!.marks
        f.spot = saved[q]!.spot
        f.heading = saved[q]!.heading
        f.down = saved[q]!.down
      })
      prevEnd = savedEnd
      warnings.push(`Beats ${n + 1}–${fight.beats.length} dropped: over the ${MAX_FIGHT_MARKS}-mark limit`)
      break
    }
    prevEnd = restT
    beats.push({
      index: n,
      startT: p.startT,
      impactTimes: p.times,
      contactErrorM: p.place.map((pl) => pl.error),
      clearanceM: clearance,
      liftM: p.place.map((pl) => pl.lift),
      physics,
      warnings: beatWarnings,
      plays: preset.id
    })
    impacts.forEach((imp, i) =>
      hits.push({ beat: beats.length - 1, i, time: p.times[i]!, attacker: beat.attacker, zone: beat.target, effector: imp.effector, outcome: outcomes[i]!, shotRange: atk.shotRange })
    )
  }

  // Measure every landed blow through the real evaluator.
  const tracks: [FightMarkSpec[], FightMarkSpec[]] = [F[0].marks, F[1].marks]
  const endT = Math.max(...tracks.map((t) => t[t.length - 1]?.time ?? 0))
  const scene = {
    id: 'fight',
    name: 'fight',
    number: 1,
    environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
    entities: [
      ...F.map((f) => ({
        id: f.input.entityId,
        assetId: f.input.assetId,
        name: f.input.entityId,
        params: f.input.params,
        transform: { position: { ...f.input.start }, rotationY: 0, scale: f.scale }
      })),
      // Held weapons, so the evaluator gives the fighters their grip poses.
      ...F.flatMap((f) =>
        f.held.map((h) => ({
          id: `${f.input.entityId}-${h.hand}-weapon`,
          assetId: h.spec.assetId,
          name: h.spec.assetId,
          heldBy: { entityId: f.input.entityId, hand: h.hand },
          transform: { position: { ...f.input.start }, rotationY: 0, scale: h.scale }
        }))
      )
    ],
    blocking: [
      {
        id: 'take',
        name: 'fight',
        tracks: F.map((f) => ({ entityId: f.input.entityId, marks: f.marks.map((m, q) => ({ ...m, id: `${f.input.entityId}-${q}` })) }))
      }
    ],
    shots: []
  } as unknown as Scene
  const shotDoc = {
    id: 'shot',
    name: 'fight',
    duration: Math.max(shot.duration, endT),
    fps,
    aspect: '16:9',
    blockingTakeId: 'take',
    camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] }
  } as unknown as Shot
  const ev = new ShotEvaluator(scene, shotDoc)
  for (const h of hits) {
    if (h.outcome !== 'hit' && h.outcome !== 'ko' && h.outcome !== 'block' && h.outcome !== 'parry') continue
    const st = ev.evaluate(h.time)
    const a = st.entities.find((e) => e.entityId === F[h.attacker].input.entityId)!
    const d = st.entities.find((e) => e.entityId === F[h.attacker === 0 ? 1 : 0].input.entityId)!
    F[h.attacker].shotRange = h.shotRange
    const err = measuredError(F[h.attacker], F[h.attacker === 0 ? 1 : 0], a, d, h.zone, h.effector, h.outcome)
    const rep = beats[h.beat]!
    rep.contactErrorM[h.i] = err
    if (err > CONTACT_TOLERANCE) {
      const msg = `Beat ${rep.index + 1} (${h.attacker === 0 ? 'A' : 'B'} ${fight.beats[rep.index]!.move} → ${h.zone}): can't reach — blow ${h.i + 1} is ${(err * 100).toFixed(1)} cm off`
      rep.warnings.push(msg)
    }
  }
  for (const b of beats) warnings.push(...b.warnings)
  // Set props (fork): every stretch of a solved path that still runs into one.
  const paths: [PathSample[], PathSample[]] = obstacles.length > 0 || opts.paths ? samplePaths(ev, F, endT, fps) : [[], []]
  const crossings = pathCrossings(paths, obstacles).sort((a, b) => a.fighter - b.fighter || a.t0 - b.t0)
  for (let i = 0; i < crossings.length; i++) {
    // One warning per stretch: pieces of one prop (or touching props) hit together merge.
    const c = { ...crossings[i]! }
    while (i + 1 < crossings.length && crossings[i + 1]!.fighter === c.fighter && crossings[i + 1]!.t0 <= c.t1 + 1e-9) c.t1 = Math.max(c.t1, crossings[++i]!.t1)
    const when = c.t1 > c.t0 ? `${c.t0.toFixed(2)}–${c.t1.toFixed(2)} s` : `${c.t0.toFixed(2)} s`
    warnings.push(`${c.fighter === 0 ? 'A' : 'B'} runs into ${c.obstacle.name} at ${when}`)
  }
  return { tracks, report: { beats, warnings, endT }, paths }
}

/** Set props (fork): shorten a push-back so the body stops at the first prop in its way (noting it). */
function propStop(notes: string[], label: string, who: string, what: string, from: XZ, dir: XZ, travel: number, reach: number, obstacles: FightObstacle[]): number {
  if (travel <= 0 || obstacles.length === 0) return travel
  const { run, hit } = clearRun(from, dir, travel + reach, BODY_RADIUS, obstacles)
  if (!hit || run - reach >= travel) return travel
  const stop = Math.max(0, run - reach)
  notes.push(`${label}: ${who}'s ${what} stopped at ${hit.name} (${travel.toFixed(2)} → ${stop.toFixed(2)} m)`)
  return stop
}

/** How far a fall carries the body behind its root (m): head, chest, knees or feet, whichever ends furthest back. */
function fallReach(f: Fighter, m: MotionPreset): number {
  let reach = 0
  for (const kf of m.keyframes) {
    const fx = poseEffectors(f.dims, kf.joints)
    reach = Math.max(reach, fx.head.z, fx.chest.z, fx.kneeL.z, fx.kneeR.z, fx.footL.z, fx.footR.z)
  }
  return reach * f.scale
}

/** Each fighter's evaluated root and body points (head, chest, pelvis, feet), one sample per frame to the end of the fight. */
function samplePaths(ev: ShotEvaluator, F: [Fighter, Fighter], endT: number, fps: number): [PathSample[], PathSample[]] {
  const out: [PathSample[], PathSample[]] = [[], []]
  const n = Math.ceil(endT * fps - 1e-9)
  for (let k = 0; k <= n; k++) {
    const t = Math.min(endT, k / fps)
    const st = ev.evaluate(t)
    F.forEach((f, q) => {
      const e = st.entities.find((x) => x.entityId === f.input.entityId)
      if (!e) return
      const fx = poseEffectors(f.dims, e.joints)
      const body = [fx.head, fx.chest, fx.pelvis, fx.footL, fx.footR].map((p) => {
        const w = toWorld(p, e.position, e.heading, f.scale)
        return { x: w.x, z: w.z }
      })
      out[q]!.push({ t, root: { x: e.position.x, z: e.position.z }, body })
    })
  }
  return out
}

/** Contact error of one blow from evaluated states (block/parry: on the guard hand or its weapon). */
function measuredError(
  atk: Fighter,
  def: Fighter,
  a: EntityState,
  d: EntityState,
  zone: FightBeat['target'],
  effector: Effector,
  outcome: FightOutcome
): number {
  const strike = contactLocal(atk, a.joints, effector, 'strike', true)
  const E = toWorld(strike, a.position, a.heading, atk.scale)
  const toward = sub(a.position, d.position)
  let T = fightTarget(def.dims, def.scale, d.joints, d.position, d.heading, toward, zone, effector, def.torso)
  if (outcome === 'block' || outcome === 'parry') {
    const side = guardSide(def, guardHand(strike.x))
    const hand = toWorld(contactLocal(def, d.joints, side, 'guard', true), d.position, d.heading, def.scale)
    const t = unit(toward)
    T = { x: hand.x + t.x * 0.05 * def.scale, y: hand.y, z: hand.z + t.z * 0.05 * def.scale }
  }
  return dist3(E, T)
}
