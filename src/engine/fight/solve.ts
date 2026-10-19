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
 * physics (stagger, knockdown slide, head snap). All marks carry lockFacing,
 * so the evaluator keeps each fighter's facing and posed gait. The report's
 * contact errors are measured through the real ShotEvaluator.
 *
 * PURE and deterministic: no DOM / three.js / Electron, no randomness.
 */

import { mirrorJoints, type ChoreoMarkSpec } from '../choreography'
import { ShotEvaluator } from '../evaluate'
import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, poseEffectors, toWorld, type Effector, type PersonDims } from '../skeleton'
import type { EntityState, FightBeat, FightDoc, FightOutcome, GaitId, Scene, Shot, V3 } from '../types'
import { DEFENSES, REACTIONS, strikeImpacts, type StrikeImpact } from './moves'
import { impact, snapAmplitude, snapCurve, type ImpactResult } from './physics'

export interface FighterInput {
  entityId: string
  assetId: string
  params?: Record<string, number | string>
  scale: number
  start: V3
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
}

export interface FightSolution {
  tracks: [FightMarkSpec[], FightMarkSpec[]]
  report: { beats: BeatReport[]; warnings: string[]; endT: number }
}

export const MAX_FIGHT_MARKS = 400
export const GUARD_DISTANCE = 1.1
export const MAX_STEP_SPEED = 2.5
export const MIN_SEPARATION = 0.35
export const CONTACT_TOLERANCE = 0.03
export const MIN_CLEARANCE = 0.25
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
/** A kick that can't reach rises onto the toes / hops — at most this high (m). */
export const MAX_KICK_LIFT = 0.5
/** A blocking arm reaches toward the blow: elbow first, then abduction (shoulders stay in the block). */
const BLOCK_ELBOW = 0.8
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
}

function fighterOf(input: FighterInput): Fighter {
  const b = input.params?.build
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
    down: false
  }
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

/** World-space effector of a fighter in a pose at a root/heading. */
function effectorWorld(f: Fighter, joints: Joints, root: XZ, y: number, heading: number, e: Effector): V3 {
  return toWorld(poseEffectors(f.dims, joints)[e], { x: root.x, y, z: root.z }, heading, f.scale)
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
  effector: Effector
): V3 {
  const fx = poseEffectors(dims, joints)
  const w = (p: V3): V3 => toWorld(p, position, heading, scale)
  const t = unit(toward)
  const push = (p: V3, d: number): V3 => ({ x: p.x + t.x * d, y: p.y, z: p.z + t.z * d })
  if (zone === 'head') return push(w(fx.head), dims.headR * scale)
  if (zone === 'legs') {
    const l = w(fx.kneeL)
    const r = w(fx.kneeR)
    const lead = flat(sub(l, add(position, t))) <= flat(sub(r, add(position, t))) ? l : r
    return push(lead, 0.08)
  }
  // Body: the chest; a knee comes in under it, at the lower torso.
  const chest = w(fx.chest)
  if (effector.startsWith('knee')) {
    const base = w({ x: 0, y: dims.legLen + 0.08 * dims.s, z: 0 })
    const f = 0.2 / 0.55
    return push({ x: base.x + (chest.x - base.x) * f, y: base.y + (chest.y - base.y) * f, z: base.z + (chest.z - base.z) * f }, 0.3 * dims.bodyW * scale)
  }
  return push(chest, 0.3 * dims.bodyW * scale)
}

/**
 * The defender's hand a blocked blow lands on: the one on the side the blow
 * travels — a blow on the attacker's left (local x < 0) meets the defender's
 * right hand, and vice versa.
 */
function guardHand(attackerLocalX: number): 'handL' | 'handR' {
  return attackerLocalX < 0 ? 'handR' : 'handL'
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
  range: number
): { delta: number; err: number } {
  const err = (d: number): number => {
    const j = { ...joints, [key]: (joints[key] ?? 0) + d }
    return rootY + poseEffectors(f.dims, j)[e].y * f.scale - targetY
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
function solvePitch(f: Fighter, joints: Joints, e: Effector, rootY: number, targetY: number): Joints {
  const x = pitchJoint(e)
  const first = solveChannel(f, joints, e, rootY, targetY, x, x.startsWith('hip') ? LEG_PITCH : ARM_PITCH)
  if (first.err <= 1e-3) return { [x]: first.delta }
  const z = x.replace(/X$/, 'Z')
  const withX = { ...joints, [x]: (joints[x] ?? 0) + first.delta }
  const second = solveChannel(f, withX, e, rootY, targetY, z, ABDUCT_PITCH)
  return second.err < first.err ? { [x]: first.delta, [z]: second.delta } : { [x]: first.delta }
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
  shot: { duration: number; fps: number }
): FightSolution {
  const fps = shot.fps > 0 ? shot.fps : 24
  const onGrid = (x: number): number => Math.round(x * fps) / fps
  const upGrid = (x: number): number => Math.ceil(x * fps - 1e-9) / fps
  const exaggeration = clamp(fight.exaggeration ?? 1.5, 1, 3)
  const beatGap = fight.beatGap ?? 0.35
  const firstStart = fight.startT ?? 0.4
  const guard = { ...BY_ID.get(REACTIONS.guard)!.keyframes[0]!.joints }
  const F: [Fighter, Fighter] = [fighterOf(fighters[0]), fighterOf(fighters[1])]
  const warnings: string[] = []
  const beats: BeatReport[] = []
  type Hit = { beat: number; i: number; time: number; attacker: 0 | 1; zone: FightBeat['target']; effector: Effector; outcome: FightOutcome }
  const hits: Hit[] = []

  F[0].heading = facing(F[0].spot, F[1].spot)
  F[1].heading = facing(F[1].spot, F[0].spot)
  for (const f of F) addMark(f, 0, f.spot, f.y, 'stand', guard, f.heading)
  let prevEnd = 0

  for (let n = 0; n < fight.beats.length; n++) {
    const beat = fight.beats[n]!
    const name = `Beat ${n + 1}`
    const label = `${name} (${beat.attacker === 0 ? 'A' : 'B'} ${beat.move} → ${beat.target})`
    const atk = F[beat.attacker]
    const def = F[beat.attacker === 0 ? 1 : 0]
    if (atk.down || def.down) {
      warnings.push(`${name} dropped: a fighter is down`)
      continue
    }
    const preset = BY_ID.get(beat.move)
    const impacts: StrikeImpact[] = preset ? strikeImpacts(beat.move) : []
    if (!preset || impacts.length === 0) {
      warnings.push(`${label} dropped: ${beat.move} is not a strike`)
      continue
    }
    const beatWarnings: string[] = []
    const outcomes = padOutcomes(beat.outcomes, impacts.length)
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
    const physics = impacts.map((imp, i) =>
      impact({
        moveId: beat.move,
        effector: imp.effector,
        speed: imp.speed,
        power,
        outcome: outcomes[i]!,
        defender: def.dims,
        defenderBuild: def.build,
        exaggeration
      })
    )

    const plan = (desiredStart: number, ceil: boolean) => {
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
          const d = DEFENSES[o]
          const m = BY_ID.get(zoneHigh ? d.high : d.low)!
          const start = T - d.readyFraction * m.duration
          // Slip away from the striking side.
          const mirror = o === 'slip' && impacts[i]!.effector.endsWith('R')
          const ev = constantEvent(start, start + m.duration, m, base, mirror)
          const ph = physics[i]!
          if ((o === 'block' || o === 'parry') && (ph.result === 'stagger' || ph.result === 'knockdown')) {
            const back = ph.result === 'stagger' ? ph.stepBack : Math.min(0.6, ph.slide * 0.5)
            const dur = ph.result === 'stagger' ? ph.stepDuration : 0.4
            ev.root = (t) => ({ off: { x: away.x * back * clamp((t - T) / dur, 0, 1), z: away.z * back * clamp((t - T) / dur, 0, 1) }, up: 0 })
            ev.times = [T + dur]
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
        if (!ev) return { pos: { ...D }, y: def.y, joints: { ...guard } }
        const p = eventPose(ev, t, guard)
        return { pos: add(ev.base, p.off), y: def.y + p.up, joints: p.joints }
      }

      // 3. Attacker placement per impact, iterated so "toward the attacker" is self-consistent.
      const place: { root: XZ; heading: number; pitch: Joints; lift: number; base: XZ; target: V3; error: number }[] = []
      for (let i = 0; i < impacts.length; i++) {
        const imp = impacts[i]!
        const kf = preset.keyframes[kIdx[i]!]!
        const o = outcomes[i]!
        const T = times[i]!
        const dState = defAt(T)
        const dPos: V3 = { x: dState.pos.x, y: dState.y, z: dState.pos.z }
        const aimJoints = o === 'slip' || o === 'duck' || o === 'miss' ? guard : dState.joints
        const aimPos: V3 = o === 'slip' || o === 'duck' || o === 'miss' ? { x: D.x, y: def.y, z: D.z } : dPos
        const rootUp = (kf.move?.up ?? 0) * atk.k
        const rootY = atk.y + rootUp
        let R: XZ = add(aimPos, unit(sub(A0, aimPos)), 0.8)
        const kick = imp.effector.startsWith('foot') || imp.effector.startsWith('knee')
        let result = { root: R, heading: 0, pitch: {} as Joints, lift: 0, base: R, target: aimPos, error: Infinity }
        let armFix: Joints = {}
        for (let it = 0; it < 4; it++) {
          const toward = unit(sub(R, aimPos))
          let T3 = fightTarget(def.dims, def.scale, aimJoints, aimPos, hd, toward, beat.target, imp.effector)
          if (o === 'block' || o === 'parry') {
            // The blow lands on the guard hand on its side, and that arm reaches
            // to the height the blow comes in at (elbow, then abduction).
            const aimPitch = solvePitch(atk, kf.joints, imp.effector, rootY, T3.y)
            const aimed = withOffsets(kf.joints, aimPitch)
            const e0 = poseEffectors(atk.dims, aimed)[imp.effector]
            const side = guardHand(e0.x)
            const h = rootY + e0.y * atk.scale
            const s = side.endsWith('L') ? 'L' : 'R'
            const first = solveChannel(def, aimJoints, side, aimPos.y, h, `elbow${s}`, BLOCK_ELBOW)
            armFix = { [`elbow${s}`]: first.delta }
            if (first.err > 1e-3) {
              const second = solveChannel(def, withOffsets(aimJoints, armFix), side, aimPos.y, h, `shoulder${s}Z`, ABDUCT_PITCH)
              if (second.err < first.err) armFix = { ...armFix, [`shoulder${s}Z`]: second.delta }
            }
            const hand = effectorWorld(def, withOffsets(aimJoints, armFix), aimPos, aimPos.y, hd, side)
            T3 = { x: hand.x + toward.x * 0.05 * def.scale, y: hand.y, z: hand.z + toward.z * 0.05 * def.scale }
          }
          const pitch = solvePitch(atk, kf.joints, imp.effector, rootY, T3.y)
          const joints = withOffsets(kf.joints, pitch)
          const e = poseEffectors(atk.dims, joints)[imp.effector]
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
          result = { root: R, heading, pitch, lift, base, target: T3, error: dist3(E, T3) }
        }
        const ev = blockEvents.get(i)
        if (ev && Object.keys(armFix).length > 0) {
          // Ramp the reaching arm in by the impact frame and back out by the defense's end.
          const fix = armFix
          ev.extra = (t) => {
            const f = t <= T ? clamp((t - ev.start) / Math.max(1e-6, T - ev.start), 0, 1) : clamp(1 - (t - T) / Math.max(1e-6, ev.end - T), 0, 1)
            if (f <= 0) return null
            const out: Joints = {}
            for (const [k, v] of Object.entries(fix)) out[k] = v * f
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
      return { startT, times, warp, events, avoidIdx, defAt, place, owner, kfRoot, kfLift, stepDist }
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
        const v = d / Math.max(1e-6, t - lastMark.time)
        gait = d < 0.05 ? 'stand' : v <= 2.0 ? 'walk' : 'jog'
      }
      addMark(atk, t, pos, atk.y + (kf.move?.up ?? 0) * atk.k + p.kfLift(j), gait, joints, pl.heading)
    }
    const atkEnd = p.startT + preset.duration
    atk.spot = p.kfRoot(kfs.length - 1)
    atk.heading = p.place[p.place.length - 1]!.heading

    // 5b. Defender marks: defenses / reactions, with sidesteps so avoided blows clear the head.
    const clearance: number[] = impacts.map(() => NaN)
    const effectorAt = (i: number): V3 => {
      const kf = kfs[kIdx[i]!]!
      const joints = withOffsets(kf.joints, p.place[i]!.pitch)
      return effectorWorld(atk, joints, p.place[i]!.root, atk.y + (kf.move?.up ?? 0) * atk.k + p.place[i]!.lift, p.place[i]!.heading, impacts[i]!.effector)
    }
    const headClear = (i: number, extra: XZ): number => {
      const st = p.defAt(p.times[i]!)
      const head = toWorld(poseEffectors(def.dims, st.joints).head, { x: st.pos.x + extra.x, y: st.y, z: st.pos.z + extra.z }, hd, def.scale)
      return dist3(effectorAt(i), head) - def.dims.headR * def.scale
    }
    for (const i of p.avoidIdx) {
      const T = p.times[i]!
      const ev = [...p.events].reverse().find((e) => e.start <= T + 1e-9)
      if (!ev) continue
      const line = unit(sub(A0, D))
      const perp = { x: -line.z, z: line.x }
      let best: { m: number; n: XZ } | null = null
      if (headClear(i, { x: 0, z: 0 }) >= MIN_CLEARANCE + 0.002) best = { m: 0, n: perp }
      else {
        for (const sgn of [1, -1]) {
          const n = { x: perp.x * sgn, z: perp.z * sgn }
          if (headClear(i, { x: n.x, z: n.z }) < MIN_CLEARANCE + 0.002) continue
          let lo = 0
          let hi = 1
          for (let it = 0; it < 40; it++) {
            const mid = (lo + hi) / 2
            if (headClear(i, { x: n.x * mid, z: n.z * mid }) >= MIN_CLEARANCE + 0.002) hi = mid
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
        beatWarnings.push(`${label}: added a ${(m * 100).toFixed(0)} cm sidestep so blow ${i + 1} clears the head`)
      }
      clearance[i] = headClear(i, { x: 0, z: 0 })
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
        addMark(def, t, add(ev.base, pose.off), def.y + pose.up, 'stand', pose.joints, hd)
      }
    }
    const lastDef = def.marks[def.marks.length - 1]!
    def.spot = { x: lastDef.position.x, z: lastDef.position.z }
    let defEnd = lastDef.time
    const koed = outcomes.includes('ko')
    const downed = physics.some((ph, i) => ph.result === 'knockdown' && (outcomes[i] === 'hit' || outcomes[i] === 'ko'))
    if (koed) def.down = true
    else if (downed && n < fight.beats.length - 1) {
      const getUp = BY_ID.get(REACTIONS.getUp)!
      const t0 = defEnd + 0.2
      for (const kf of getUp.keyframes) {
        addMark(def, t0 + kf.t, def.spot, def.y + (kf.move?.up ?? 0) * def.k, 'stand', kf.joints, hd)
      }
      defEnd = t0 + getUp.duration
    }

    // 7. Rest: back to guard distance, facing each other.
    const recoveryEnd = Math.max(atkEnd, defEnd)
    let restT = recoveryEnd
    if (!def.down) {
      const M = { x: (atk.spot.x + def.spot.x) / 2, z: (atk.spot.z + def.spot.z) / 2 }
      const dir = unit(sub(def.spot, atk.spot), fwdOf(atk.heading))
      const aRest = add(M, dir, -GUARD_DISTANCE / 2)
      const dRest = add(M, dir, GUARD_DISTANCE / 2)
      const moveA = flat(sub(aRest, atk.spot))
      const moveD = flat(sub(dRest, def.spot))
      restT = recoveryEnd + clamp(Math.max(moveA, moveD) / 1.5, 0.25, 1.5)
      addMark(atk, restT, aRest, atk.y, moveA > 0.05 ? 'walk' : 'stand', guard, facing(aRest, dRest))
      addMark(def, restT, dRest, def.y, moveD > 0.05 ? 'walk' : 'stand', guard, facing(dRest, aRest))
      atk.spot = aRest
      def.spot = dRest
      atk.heading = facing(aRest, dRest)
      def.heading = facing(dRest, aRest)
    }
    else {
      restT = recoveryEnd + 0.25
      addMark(atk, restT, atk.spot, atk.y, 'stand', guard, facing(atk.spot, def.spot))
    }

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
      warnings: beatWarnings
    })
    impacts.forEach((imp, i) =>
      hits.push({ beat: beats.length - 1, i, time: p.times[i]!, attacker: beat.attacker, zone: beat.target, effector: imp.effector, outcome: outcomes[i]! })
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
    entities: F.map((f) => ({
      id: f.input.entityId,
      assetId: f.input.assetId,
      name: f.input.entityId,
      params: f.input.params,
      transform: { position: { ...f.input.start }, rotationY: 0, scale: f.scale }
    })),
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
    const err = measuredError(F[h.attacker], F[h.attacker === 0 ? 1 : 0], a, d, h.zone, h.effector, h.outcome)
    const rep = beats[h.beat]!
    rep.contactErrorM[h.i] = err
    if (err > CONTACT_TOLERANCE) {
      const msg = `Beat ${rep.index + 1} (${h.attacker === 0 ? 'A' : 'B'} ${fight.beats[rep.index]!.move} → ${h.zone}): can't reach — blow ${h.i + 1} is ${(err * 100).toFixed(1)} cm off`
      rep.warnings.push(msg)
    }
  }
  for (const b of beats) warnings.push(...b.warnings)
  return { tracks, report: { beats, warnings, endT } }
}

/** Contact error of one blow from evaluated states (block/parry: on the guard hand). */
function measuredError(
  atk: Fighter,
  def: Fighter,
  a: EntityState,
  d: EntityState,
  zone: FightBeat['target'],
  effector: Effector,
  outcome: FightOutcome
): number {
  const E = toWorld(poseEffectors(atk.dims, a.joints)[effector], a.position, a.heading, atk.scale)
  const toward = sub(a.position, d.position)
  let T = fightTarget(def.dims, def.scale, d.joints, d.position, d.heading, toward, zone, effector)
  if (outcome === 'block' || outcome === 'parry') {
    const side = guardHand(poseEffectors(atk.dims, a.joints)[effector].x)
    const hand = toWorld(poseEffectors(def.dims, d.joints)[side], d.position, d.heading, def.scale)
    const t = unit(toward)
    T = { x: hand.x + t.x * 0.05 * def.scale, y: hand.y, z: hand.z + t.z * 0.05 * def.scale }
  }
  return dist3(E, T)
}
