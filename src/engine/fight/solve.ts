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
 * Mocap bots (fork, mocap fights; clip-moves.ts): a loaded bot plays the
 * library's fight clips. A strike is one clip run per impact (combos chain
 * them, crossfaded), its impact frame on the beat's frame; the reach solve
 * above runs on the clip pose and sits on the impact mark as an overlay,
 * ramped in and out. Blocks, parries, slips and ducks play the block and
 * dodge clips with their guard frame on the impact; landed blows the hit
 * clips by target and the side they land on; staggers, knockdowns and KOs
 * the hit and fall clips on the physics' knockback root and timing. Between
 * beats a bot holds the fight idle. A move with no clip plays its
 * keyframes, crossfaded from and back to the idle. Every other body fights
 * exactly as before.
 *
 * PURE and deterministic: no DOM / three.js / Electron, no randomness.
 */

import { mirrorJoints, type ChoreoMarkSpec } from '../choreography'
import { smoothstep } from '../easing'
import { ShotEvaluator } from '../evaluate'
import { botPose, clipRoot, clipScale, mocapClip } from '../mocap/clip'
import { effectorsOf, poseFramesOf, type MocapPose } from '../mocap/fk'
import { playsClips } from '../mocap/library-clips'
import { BONE_INDEX, MOCAP_BONES, type MocapBone } from '../mocap/rig'
import { boneSkin, fighterPose, meshDepth, partAhead, skinDepth, skinMesh, skinPoints, supportPoints, targetSkin, type SkinMesh } from '../mocap/surface'
import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, poseEffectors, toWorld, type Effector, type PersonDims } from '../skeleton'
import type { ClipState, EntityState, FightBeat, FightDoc, FightOutcome, GaitId, MarkClip, Scene, Shot, V3 } from '../types'
import { SUPPORT_SLACK, handFrame, heldPointLocal, holdJoints, supportReach, weaponContact, weaponSpec, type HeldWeapon } from '../weapons'
import { heldRotation } from '../weapon-hold'
import { heldWeaponSamples, weaponSamples, type WeaponSamples } from '../weapon-shape'
import { DEFENSES, REACTIONS, SHIELD_BLOCK, SHOT_MOVES, fightMotion, gripPitch, gunAimMove, shotHand, shotImpacts, strikeImpacts, type StrikeImpact } from './moves'
import { impact, snapAmplitude, snapCurve, weaponHeft, type ImpactResult } from './physics'
import { BODY_RADIUS, clearRun, pathCrossings, type FightObstacle, type PathSample } from './obstacles'
import { floorBody, groundBetween, groundY, type FloorBody } from './ground'
import { bodyClearance, torsoShape, torsoSurface, type TorsoShape } from './contact'
import {
  backTravel,
  clipImpactTime,
  defenseClip,
  defenseReadyTime,
  fallLandTime,
  getUpClip,
  gunClips,
  idleClip,
  moveClips,
  reactionClip,
  reactionOnset,
  type ClipBlow,
  type ClipPick
} from './clip-moves'

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
  /** The motion the beat played: a shot's gun or bow aim, a replaced move's fork motion; a bot's clips (`mocap:jabHead+cross`). */
  plays: string
  /** Mocap bots (fork): the effector each impact struck with as played (a bot's jab is its left hand). */
  effectors?: string[]
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
/** Mocap bots (fork): a knee to a bot's body lands this far up its torso: the belly, above the thighs. */
const BOT_KNEE = 0.4
/** A bot's striking knee tucks its heel by up to TUCK_MAX (rad, found to within TUCK_STEP); its shin counts from TUCK_FROM below the knee (m at height ×1). */
const TUCK_MAX = 0.8
const TUCK_STEP = 0.05
const TUCK_FROM = 0.12
/** A bot's leg in the defender's legs splays out (hip abduction) by up to LEG_SPLAY (crd2: ≤ 10°), found to within SPLAY_STEP (rad). */
const LEG_SPLAY = (10 * Math.PI) / 180
const SPLAY_STEP = 0.01
/** Roots further apart than this can't have their legs meet (m at height ×1). */
const SPLAY_NEAR = 1.4
/**
 * A bot blow whose approach (its last ORBIT_LEAD) still sinks one body more
 * than ORBIT_TOL into the other comes in swung about the target by the
 * first of ORBIT_STEPS (deg) that clears it, else the one that helps most (by
 * ORBIT_GAIN at least, or that gets it under ORBIT_BAR; crd2: ≤ 30°).
 */
const ORBIT_LEAD = 0.125
const ORBIT_TOL = 0.022
const ORBIT_GAIN = 0.005
/** The coarse angles first; the finer ones beside the best of them after them, only while it is still over ORBIT_BAR (m); whatever gets under it wins. */
const ORBIT_STEPS = [15, -15, 30, -30, 8, -8, 22, -22]
const ORBIT_COARSE = 4
const ORBIT_BAR = 0.025
/** An orbit must land its blow as well as straight on, or within ORBIT_CONTACT (m). */
const ORBIT_CONTACT = 0.005
/** A bot's bare guard a blocked blow still sinks past (a spinning backfist sweeping across) reaches across toward it first: shoulder adduction (rad). */
const GUARD_ACROSS = 0.45
/** A warm-started pitch solve's first step and how far from its start it may go (rad), else it scans. */
const WARM_STEP = 0.02
const WARM_REACH = 0.5
/** A later lean pass (bots) looks this near the last pass's lean (rad). */
const LEAN_NEAR = 0.02
/**
 * Bots kept apart after a blow (separate): skins sampled every SEP_STEP to
 * SEP_WINDOW after a beat's last blow; more than SEP_TOL in each other
 * pushes the defender back, plus SEP_MARGIN (s, m).
 */
const SEP_STEP = 1 / 12
const SEP_WINDOW = 1
/** For this long after the blow it is sampled every frame (s). */
const SEP_CLOSE = 0.25
/** Between two blows a push is gone SEP_BACK before the next (s). */
const SEP_BACK = 0.1
const SEP_TOL = 0.01
const SEP_MARGIN = 0.005
/** A push is found to within SEP_RES, at most SEP_MAX; one that can't clear the bodies must help by SEP_GAIN (m). */
const SEP_RES = 0.005
const SEP_MAX = 0.15
const SEP_GAIN = 0.01
/** Bots resting apart with a weapon held out (restGap) keep it this clear of the other (m). */
const REST_CLEAR = 0.05
/** At most this many more tries at a rest whose walk sweeps a weapon through the other (restDepth). */
const REST_TRIES = 3
/** The rest walk is looked at from this long before it ends (the idle crossfades in at its end; s). */
const REST_LOOK = 0.5
/** A held weapon in the other body after a blow swings out of it (swingWeapons) in steps of SWING_STEP, at most SWING_MAX (rad). */
const SWING_STEP = 0.1
const SWING_MAX = 1.2
/** Two bones' boxes (their support points) meet within BONE_PAD of each other (m): their skins are compared there. */
const BONE_PAD = 0.015
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
/**
 * Mocap bots (fork): a strike clip plays from up to CLIP_LEAD before its
 * impact to CLIP_TAIL after it inside a combo, CLIP_END after the last;
 * combo clips crossfade over CLIP_XFADE; the overlay ramps in over RAMP_IN
 * and out over RAMP_OUT; clip runs are marked every CLIP_STEP of clip time.
 */
const CLIP_LEAD = 0.5
const CLIP_TAIL = 0.45
const CLIP_END = 0.9
const CLIP_XFADE = 0.12
const RAMP_IN = 0.2
const RAMP_OUT = 0.25
const CLIP_STEP = 0.1
/** A bot defense plays from DEF_LEAD before its guard frame to DEF_TAIL after it. */
const DEF_LEAD = 0.45
const DEF_TAIL = 0.5
/** A bot settles out of the idle over BOT_LEAD, steps in at BOT_STEP m/s, crossfades between defender clips over BOT_XFADE, and gets up BOT_GETUP after a knockdown ends. */
const BOT_LEAD = 0.2
const BOT_STEP = 1.2
const BOT_XFADE = 0.15
const BOT_GETUP = 0.4
/** Defender clip runs are marked this often (s). */
const DEF_STEP = 1 / 15
/** A guard in a blow's way opens from GUARD_LEAD before it, all the way by GUARD_FULL before (s; bots). */
const GUARD_LEAD = 0.25
const GUARD_FULL = 0.08
/** A defender's hand or forearm within GUARD_CLEAR of a landed blow's skin is in its way; it swings back over GUARD_REOPEN. */
const GUARD_CLEAR = 0.01
const GUARD_REOPEN = 0.4
/**
 * An armed bot's guard (fork, fight-polish; armedGuard): its weapon's guard
 * point GUARD_OUT in front of the struck zone (plus the attacking weapon's
 * reach past its strike point), each arm channel within ±GUARD_SWING (rad);
 * a unit of the blade's lean along the line of attack (a shield's turn
 * away from it) weighs as GUARD_TURN (m) of its point's miss.
 */
const GUARD_OUT = 0.3
/** An armed guard's free arm keeps this clear of the attacking weapon at the impact (freeArmSwing; m). */
const GUARD_FREE = 0.05
const GUARD_SWING = 2.6
const GUARD_TURN = 0.1
/**
 * The armed guard keeps its weapon GUARD_SELF off its own body (but the arm
 * holding it), at the guard and on its way in (GUARD_RAMP); a cm in weighs GUARD_SELF_W cm
 * of miss. A weapon its idle already holds in may stay as deep.
 */
const GUARD_SELF = 0.015
const GUARD_SELF_W = 3
/** The armed guard's own-body check samples a weapon's capsules at about this many points. */
const GUARD_POINTS = 64
/** The armed guard's fit kept out of its own body runs at most this many steps. */
const GUARD_SELF_ITERS = 8
/** The ramp in, where the armed guard's weapon is kept out of its own body (fractions of the overlay). */
const GUARD_RAMP = [0.25, 0.5, 0.75]
/** The armed guard's fit stops once a step gains less than this (m², the squared miss). */
const GUARD_GAIN = 1e-8
/**
 * A blow's placement asks for its armed guard again and again as the
 * attacker settles (the defender's aim pose fixed): a guard point within
 * GUARD_REUSE (m) of one already solved, the line of attack within
 * GUARD_REUSE_DOT of its, reuses that guard.
 */
const GUARD_REUSE = 0.005
const GUARD_REUSE_DOT = 0.9995

type XZ = { x: number; z: number }
type Joints = Record<string, number>

/** A motion key a fight plays: a keyframe, or (mocap bots) a clip mark with its root travel in the fighter's frame (m). */
type FightKey = MotionPreset['keyframes'][number] & { clip?: MarkClip; travel?: XZ }
/** What a fighter plays for a beat: keyframes, or a bot's clip runs as keys. */
interface FightMotion {
  id: string
  duration: number
  keyframes: FightKey[]
}

/** A mark clip as a clip state. */
const stateOf = (c: MarkClip | undefined): ClipState | undefined => (c ? (c.mirror ? { id: c.id, t: c.at, mirror: true } : { id: c.id, t: c.at }) : undefined)
/** A clip state as a mark clip. */
const markOf = (c: ClipState | undefined): MarkClip | undefined => (c ? (c.mirror ? { id: c.id, at: c.t, mirror: true } : { id: c.id, at: c.t }) : undefined)

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
/** `p` turned by `a` (rad) about `c` in the ground plane. */
function turnAbout(p: XZ, c: XZ, a: number): XZ {
  const x = p.x - c.x
  const z = p.z - c.z
  return { x: c.x + x * Math.cos(a) - z * Math.sin(a), z: c.z + x * Math.sin(a) + z * Math.cos(a) }
}

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
  /** Mocap bots (fork, clip-moves.ts): the idle clip a loaded bot holds between beats; null for every other body (keyframes). */
  idle: string | null
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
    torso: torsoShape(input.assetId, input.params, personDims(input.assetId, input.params)),
    idle: playsClips({ assetId: input.assetId, params: input.params }) ? idleClip(held.find((h) => h.spec.kind === 'gun')?.spec.mount) : null
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

/** Mocap bots (fork): a bot's unarmed contact points by pose (contactLocal), the last CONTACT_CACHE asked. */
const CONTACTS = new WeakMap<Fighter, Map<string, V3>>()
const CONTACT_CACHE = 512

/**
 * Fighter-local point where an effector meets things. Unarmed: the rig
 * effector. A hand with a weapon: the weapon's strike or guard point (a gun
 * beat's: `shotRange` down the barrel line), in the pose the evaluator gives
 * the fighter (the grip poses of `holdJoints`; `evaluated` joints have them).
 */
function contactLocal(f: Fighter, joints: Joints | undefined, e: Effector, role: 'strike' | 'guard' = 'strike', evaluated = false, clip?: ClipState): V3 {
  const w = weaponOf(f, e)
  if (!w) {
    if (!f.dims.mocap) return poseEffectors(f.dims, joints, clip)[e]
    // Mocap bots (fork): the solves ask of the same pose again and again (a pitch scan repeats on every placement pass).
    let cache = CONTACTS.get(f)
    if (!cache) {
      cache = new Map()
      CONTACTS.set(f, cache)
    }
    const key = `${e}|${role}|${JSON.stringify(clip ?? null)}|${JSON.stringify(joints ?? null)}`
    const known = cache.get(key)
    if (known) return { ...known }
    let out: V3
    if (role !== 'strike') out = poseEffectors(f.dims, joints, clip)[e]
    else {
      // Mocap bots (fork, mocap/surface.ts): a blow lands with the part's front (the knuckles, the sole, the elbow's
      // point), its skin furthest ahead of the effector along the strike (out from the body through the effector).
      const m = f.dims.mocap
      const pose = botPose(m, joints, clip)
      const p = effectorsOf(m, poseFramesOf(m, pose))[e]
      const u = unit({ x: p.x, z: p.z })
      const a = partAhead(m, joints, clip, e, p, { x: u.x, y: 0, z: u.z }, pose)
      out = { x: p.x + u.x * a, y: p.y, z: p.z + u.z * a }
    }
    if (cache.size >= CONTACT_CACHE) cache.delete(cache.keys().next().value!)
    cache.set(key, out)
    return { ...out }
  }
  // A bot on a clip holds the weapon in the clip's own hands (no hold pose; weapons.ts applyHolds).
  const j = evaluated || clip ? joints : holdJoints(f.dims, joints, f.held)
  const range = role === 'strike' ? f.shotRange / w.scale : 0
  const t = w.spec.tip
  const a = w.spec.aim
  const p = range > 0 ? { x: t.x + a.x * range, y: t.y + a.y * range, z: t.z + a.z * range } : weaponContact(w.spec, role)
  return heldPointLocal(f.dims, j, w.hand, w.spec, p, w.scale, clip)
}

function addMark(f: Fighter, time: number, pos: XZ, y: number, gait: GaitId, joints: Joints, heading: number, clip?: MarkClip, posed = false): void {
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
    lockFacing: true,
    // Mocap bots (fork): a clip mark, and a posed move (the evaluator keeps the clip's root travel and floor line).
    ...(clip ? { clip: { ...clip } } : {}),
    ...(posed ? { posedMove: true as const } : {})
  })
}

/** Drop marks at or after t (a newer motion takes over from t). */
function truncate(f: Fighter, t: number): void {
  while (f.marks.length > 1 && f.marks[f.marks.length - 1]!.time >= t - 1e-6) f.marks.pop()
}

/** World-space effector (or weapon point) of a fighter in a pose at a root/heading. */
function effectorWorld(f: Fighter, joints: Joints, root: XZ, y: number, heading: number, e: Effector, role: 'strike' | 'guard' = 'strike', clip?: ClipState): V3 {
  return toWorld(contactLocal(f, joints, e, role, false, clip), { x: root.x, y, z: root.z }, heading, f.scale)
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
  torso: TorsoShape,
  clip?: ClipState
): V3 {
  const fx = poseEffectors(dims, joints, clip)
  const w = (p: V3): V3 => toWorld(p, position, heading, scale)
  const t = unit(toward)
  const push = (p: V3, d: number): V3 => ({ x: p.x + t.x * d, y: p.y, z: p.z + t.z * d })
  if (zone === 'head' && dims.mocap) {
    // Mocap bots (fork, mocap/surface.ts): the head's own skin toward the attacker (an elbow's jaw ELBOW_JAW below
    // the middle), from its support points: a bot's head is no sphere.
    const c = Math.cos(heading)
    const s = Math.sin(heading)
    const down = effector.startsWith('elbow') ? ELBOW_JAW : 0
    const dir = { x: (t.x * c - t.z * s) * Math.cos(down), y: -Math.sin(down), z: (t.x * s + t.z * c) * Math.cos(down) }
    const a = partAhead(dims.mocap, joints, clip, 'head', fx.head, dir)
    return w({ x: fx.head.x + dir.x * a, y: fx.head.y + dir.y * a, z: fx.head.z + dir.z * a })
  }
  if (zone === 'head' && effector.startsWith('elbow')) {
    // Fork: an elbow lands on the jaw, the head's surface ELBOW_JAW below its middle.
    const h = w(fx.head)
    return push({ ...h, y: h.y - dims.headR * scale * Math.sin(ELBOW_JAW) }, dims.headR * scale * Math.cos(ELBOW_JAW))
  }
  if (zone === 'head') return push(w(fx.head), dims.headR * scale)
  if (zone === 'legs') {
    const l = w(fx.kneeL)
    const r = w(fx.kneeR)
    const leadL = flat(sub(l, add(position, t))) <= flat(sub(r, add(position, t)))
    const lead = leadL ? l : r
    if (dims.mocap) {
      // Mocap bots (fork): the lead leg's own skin toward the attacker.
      const c = Math.cos(heading)
      const s = Math.sin(heading)
      const knee = leadL ? 'kneeL' : 'kneeR'
      return push(lead, partAhead(dims.mocap, joints, clip, knee, fx[knee], { x: t.x * c - t.z * s, y: 0, z: t.x * s + t.z * c }) * scale)
    }
    return push(lead, 0.08)
  }
  // Body (fork, contact.ts): on the torso's surface toward the attacker — the
  // chest for fists and elbows, the lower torso for a knee, the midsection
  // (belt to lower ribs) for a kick.
  // Mocap bots (fork): a knee lands on the belly (BOT_KNEE), clear of the thighs below it.
  const yFrac = effector.startsWith('knee') ? (dims.mocap ? BOT_KNEE : 0.2) : effector.startsWith('foot') ? KICK_MIDSECTION : 0.55
  return torsoSurface(torso, dims, scale, joints, position, heading, t, yFrac, clip)
}

/**
 * The defender's hand a blocked blow lands on: the one on the side the blow
 * travels — a blow on the attacker's left (local x < 0) meets the defender's
 * right hand, and vice versa.
 */
function guardHand(attackerLocalX: number): 'handL' | 'handR' {
  return attackerLocalX < 0 ? 'handR' : 'handL'
}

/** Mocap bots (fork, mocap/surface.ts): the limb a blow strikes with, shoulder to fist or hip to toe. */
const LIMB: Partial<Record<Effector, string>> = { handL: 'armL', elbowL: 'armL', handR: 'armR', elbowR: 'armR', footL: 'kickL', kneeL: 'kickL', footR: 'kickR', kneeR: 'kickR' }

/** Mocap bots (fork): the target skins a fighter's poses showed, as meshes (the solver asks of the same pose again and again). */
const MESHES = new WeakMap<Fighter, Map<string, SkinMesh | null>>()
const MESH_CACHE = 24

/** A bot's target skin (`surface.ts` targetSkin) posed at `pos` / `heading`, as a world mesh; null without the skin's triangles. */
function targetMesh(f: Fighter, joints: Joints, clip: ClipState | undefined, pos: V3, heading: number, target: string): SkinMesh | null {
  let cache = MESHES.get(f)
  if (!cache) {
    cache = new Map()
    MESHES.set(f, cache)
  }
  const key = `${target}|${pos.x},${pos.y},${pos.z},${heading}|${JSON.stringify(joints)}|${JSON.stringify(clip ?? null)}`
  const known = cache.get(key)
  if (known !== undefined) return known
  const own = targetSkin(f.dims.mocap!, joints, clip, target)
  const mesh = own ? skinMesh(own.p.map((q) => toWorld(q, pos, heading, f.scale)), own.tri) : null
  if (cache.size >= MESH_CACHE) cache.delete(cache.keys().next().value!)
  cache.set(key, mesh)
  return mesh
}

/**
 * Mocap bots (fork, mocap/surface.ts): how deep a bot's striking part sits
 * in the bot defender's target skin (m; negative: the gap), the attacker at
 * `root` / `heading` in `joints` / `clip`, the defender likewise (`limb`:
 * by the whole striking limb); null when either isn't a bot or the blow
 * lands with a weapon.
 */
function blowDepth(
  atk: Fighter,
  aj: Joints,
  ac: ClipState | undefined,
  e: Effector,
  root: V3,
  heading: number,
  def: Fighter,
  dj: Joints,
  dc: ClipState | undefined,
  dpos: V3,
  dheading: number,
  target: string,
  limb = false
): number | null {
  if (!atk.dims.mocap || !def.dims.mocap || weaponOf(atk, e)) return null
  const near = poseEffectors(atk.dims, aj, ac)[e]
  // `limb`: the whole striking limb (a blocked blow stops where its arm first meets the guard).
  const strike = (limb && LIMB[e] ? skinPoints(atk.dims.mocap, aj, ac, LIMB[e]!) : skinPoints(atk.dims.mocap, aj, ac, e, near)).map((p) => toWorld(p, root, heading, atk.scale))
  // Against the target's mesh; without the skin's triangles, its support hull near the blow (in its own frame).
  const mesh = targetMesh(def, dj, dc, dpos, dheading, target)
  if (mesh) return meshDepth(strike, mesh)
  const hit = toWorld(contactLocal(atk, aj, e, 'strike', false, ac), root, heading, atk.scale)
  const c = Math.cos(dheading)
  const s = Math.sin(dheading)
  const wx = (hit.x - dpos.x) / def.scale
  const wz = (hit.z - dpos.z) / def.scale
  const local = { x: wx * c - wz * s, y: (hit.y - dpos.y) / def.scale, z: wx * s + wz * c }
  const skin = skinPoints(def.dims.mocap, dj, dc, target, local).map((p) => toWorld(p, dpos, dheading, def.scale))
  return skinDepth(strike, skin)
}

/**
 * Mocap bots (fork): a knee strike tucks its heel. The least extra knee bend
 * (rad, to within TUCK_STEP, at most TUCK_MAX) that keeps the striking leg's shin and foot
 * (beyond TUCK_FROM of the knee: the knee lands) GUARD_CLEAR out of the bot
 * defender's legs; 0 when they are clear, or either isn't a skinned bot.
 */
function kneeTuck(atk: Fighter, e: Effector, aj: Joints, ac: ClipState | undefined, root: V3, heading: number, def: Fighter, dj: Joints, dc: ClipState | undefined, dpos: V3, dheading: number): number {
  if (!atk.dims.mocap?.rig.skin || (e !== 'kneeL' && e !== 'kneeR')) return 0
  const mesh = def.dims.mocap ? targetMesh(def, dj, dc, dpos, dheading, 'legs') : null
  if (!mesh) return 0
  const m = atk.dims.mocap
  const shin = e === 'kneeL' ? 'shinL' : 'shinR'
  const from = (TUCK_FROM * m.k) ** 2
  const clear = (bend: number): boolean => {
    const j = bend > 0 ? withOffsets(aj, { [e]: bend }) : aj
    const knee = poseEffectors(atk.dims, j, ac)[e]
    const pts = skinPoints(m, j, ac, shin)
      .filter((p) => (p.x - knee.x) ** 2 + (p.y - knee.y) ** 2 + (p.z - knee.z) ** 2 > from)
      .map((p) => toWorld(p, root, heading, atk.scale))
    return meshDepth(pts, mesh) < -GUARD_CLEAR
  }
  if (clear(0)) return 0
  if (!clear(TUCK_MAX)) return TUCK_MAX
  // The least bend that clears, to TUCK_STEP (bisection: more bend tucks the shin further back).
  let lo = 0
  let hi = TUCK_MAX
  while (hi - lo > TUCK_STEP / 2) {
    const mid = (lo + hi) / 2
    if (clear(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Mocap bots (fork): a strike's legs stay out of the defender's. Each of the
 * attacker's legs but the striking one that comes within GUARD_CLEAR of the
 * bot defender's legs abducts (hip Z, outward) by the least that clears it,
 * to within SPLAY_STEP, at most LEG_SPLAY; {} when they are clear, or either
 * isn't a skinned bot.
 */
function legSplay(atk: Fighter, e: Effector, aj: Joints, ac: ClipState | undefined, root: V3, heading: number, def: Fighter, dj: Joints, dc: ClipState | undefined, dpos: V3, dheading: number): Joints {
  if (!atk.dims.mocap?.rig.skin || Math.hypot(root.x - dpos.x, root.z - dpos.z) > SPLAY_NEAR * Math.max(atk.scale, def.scale)) return {}
  const mesh = def.dims.mocap ? targetMesh(def, dj, dc, dpos, dheading, 'legs') : null
  if (!mesh) return {}
  const m = atk.dims.mocap
  const out: Joints = {}
  for (const side of ['L', 'R'] as const) {
    if (LIMB[e] === `kick${side}`) continue
    const key = `hip${side}Z`
    const clear = (a: number): boolean => meshDepth(skinPoints(m, a > 0 ? withOffsets(aj, { [key]: a }) : aj, ac, `kick${side}`).map((p) => toWorld(p, root, heading, atk.scale)), mesh) < -GUARD_CLEAR
    if (clear(0)) continue
    if (!clear(LEG_SPLAY)) {
      out[key] = LEG_SPLAY
      continue
    }
    // The least splay that clears (bisection: more splay swings the leg further out).
    let lo = 0
    let hi = LEG_SPLAY
    while (hi - lo > SPLAY_STEP) {
      const mid = (lo + hi) / 2
      if (clear(mid)) hi = mid
      else lo = mid
    }
    out[key] = hi
  }
  return out
}

/** The skin a blow lands on: the guard's for a block or parry, else its target's (the lead leg for the legs). */
function skinOf(def: Fighter, dj: Joints, dc: ClipState | undefined, zone: FightBeat['target'], outcome: FightOutcome, guard: 'handL' | 'handR', toward: XZ, heading: number): string {
  if (outcome === 'block' || outcome === 'parry') return guard === 'handL' ? 'guardL' : 'guardR'
  if (zone !== 'legs') return zone === 'head' ? 'head' : 'body'
  const fx = poseEffectors(def.dims, dj, dc)
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  const t = { x: toward.x * c - toward.z * s, z: toward.x * s + toward.z * c }
  return fx.kneeL.x * t.x + fx.kneeL.z * t.z >= fx.kneeR.x * t.x + fx.kneeR.z * t.z ? 'legL' : 'legR'
}

/** The attacker (its pose, root and heading) and the defender, at one moment of a blow's approach (guardOpening). */
interface GuardSample {
  /** Its moment (s). */
  t: number
  aj: Joints
  ac: ClipState | undefined
  root: V3
  heading: number
  st: { pos: XZ; y: number; joints: Joints; clip?: ClipState }
}

/**
 * Mocap bots (fork, mocap/surface.ts): the guard a landed blow has to get
 * through, over its approach (each of `samples`). An arm the striking limb's skin (shoulder to fist,
 * hip to toe: an elbow's upper arm sweeps through a guard too) touches, or
 * comes within GUARD_CLEAR of, is in its way; it swings (shoulder X, down or up,
 * whichever is less) by the least that leaves it GUARD_CLEAR clear, at most
 * 1.2 rad; a leg in its way (`legs`) swings out (hip abduction, at most LEG_SPLAY).
 * A weapon in a swinging hand keeps out of its holder, over the approach and
 * `after` the impact (the defender then, and the share of the swing it keeps).
 * Null when nothing is in the way.
 */
function guardOpening(atk: Fighter, e: Effector, samples: GuardSample[], def: Fighter, hd: number, legs = true, after: { st: GuardSample['st']; w: number }[] = []): Joints | null {
  if (!def.dims.mocap) return null
  // Per sample, the striking limb as a mesh, once (it stays put while the guard swings); each swing's guard skin against it.
  const at = samples.map((s) => {
    const own = atk.dims.mocap && LIMB[e] && !weaponOf(atk, e) ? targetSkin(atk.dims.mocap, s.aj, s.ac, LIMB[e]!) : null
    const held = weaponOf(atk, e)
    return {
      ...s,
      pos: { x: s.st.pos.x, y: s.st.y, z: s.st.pos.z },
      limb: own ? skinMesh(own.p.map((q) => toWorld(q, s.root, s.heading, atk.scale)), own.tri) : null,
      // Fork (fight-polish): a weapon strike's weapon, as capsules.
      weapon: held && def.dims.mocap!.rig.skin ? weaponsWorld(atk, { joints: s.aj, clip: s.ac, position: s.root, heading: s.heading }, false, held) : null
    }
  })
  // Each sample's weapon's box, padded by its radius and the bones' pad.
  const boxes = at.map((s) => {
    if (!s.weapon) return null
    const pts = s.weapon.flatMap((w) => w.p)
    const pad = Math.max(...s.weapon.map((w) => w.r)) + BONE_PAD + GUARD_CLEAR
    return {
      lo: { x: Math.min(...pts.map((q) => q.x)) - pad, y: Math.min(...pts.map((q) => q.y)) - pad, z: Math.min(...pts.map((q) => q.z)) - pad },
      hi: { x: Math.max(...pts.map((q) => q.x)) + pad, y: Math.max(...pts.map((q) => q.y)) + pad, z: Math.max(...pts.map((q) => q.z)) + pad }
    }
  })
  /** How deep a sample's striking weapon sits in one of the defender's parts (`arm${side}`, `leg${side}`) posed in `j` (-Infinity when its bones' boxes stay clear of the weapon's). */
  const weaponIn = (s: (typeof at)[number], j: Joints, part: string): number => {
    const m = def.dims.mocap!
    const pose = botPose(m, j, s.st.clip)
    const side = part.endsWith('L') ? 'Left' : 'Right'
    const bones = new Set((part.startsWith('arm') ? ['Arm', 'ForeArm', 'Hand'] : ['UpLeg', 'Leg']).map((x) => BONE_INDEX[`${side}${x}` as keyof typeof BONE_INDEX]))
    // Each of the part's bones' boxes (its support points) against the weapon's.
    const box = boxes[at.indexOf(s)]!
    const own = new Map<number, { lo: V3; hi: V3 }>()
    for (const x of supportPoints(m, pose)) {
      if (!bones.has(x.bone)) continue
      const q = toWorld(x.p, s.pos, hd, def.scale)
      const c = own.get(x.bone)
      if (!c) own.set(x.bone, { lo: { ...q }, hi: { ...q } })
      else {
        c.lo = { x: Math.min(c.lo.x, q.x), y: Math.min(c.lo.y, q.y), z: Math.min(c.lo.z, q.z) }
        c.hi = { x: Math.max(c.hi.x, q.x), y: Math.max(c.hi.y, q.y), z: Math.max(c.hi.z, q.z) }
      }
    }
    const parts = [...own.values()]
    if (!parts.some((c) => c.lo.x <= box.hi.x && c.hi.x >= box.lo.x && c.lo.y <= box.hi.y && c.hi.y >= box.lo.y && c.lo.z <= box.hi.z && c.hi.z >= box.lo.z)) return -Infinity
    // (Nor when none of its axis points comes that close to one of them.)
    const near = (q: V3, pad: number): boolean => parts.some((c) => q.x >= c.lo.x - pad && q.x <= c.hi.x + pad && q.y >= c.lo.y - pad && q.y <= c.hi.y + pad && q.z >= c.lo.z - pad && q.z <= c.hi.z + pad)
    if (!s.weapon!.some((w) => w.p.some((q) => near(q, w.r + BONE_PAD + GUARD_CLEAR)))) return -Infinity
    const skin = boneSkin(m, pose, bones)
    if (!skin || skin.tri.length === 0) return -Infinity
    const mesh = skinMesh(skin.p.map((q) => toWorld(q, s.pos, hd, def.scale)), skin.tri)
    return Math.max(...s.weapon!.map((w) => meshDepth(w.p, mesh) + w.r))
  }
  /** Fork (fight-polish): how deep the weapon in the defender's `side` hand, posed in `j`, sits in a sample's striking limb. */
  const heldIn = (s: (typeof at)[number], j: Joints, side: 'L' | 'R'): number => {
    const h = def.held.find((x) => x.hand === side)
    if (!h || !s.limb || !def.dims.mocap!.rig.skin) return -Infinity
    const hj = s.st.clip ? j : holdJoints(def.dims, j, def.held)
    return Math.max(...heldWeaponSamples(def.dims, hj, side, h.spec, h.scale, s.st.clip, { position: s.pos, heading: hd, scale: def.scale }).map((w) => meshDepth(w.p, s.limb!) + w.r))
  }
  // Fork (fight-polish): a weapon in a hand the guard swings stays out of its own holder: over the approach and while the opening
  // eases off after the impact (`after`, each with its share of the swing), no deeper than unswung. Per state and side, the body but
  // that arm (a swing moves only the arm) and the weapon's depth in it unswung.
  type DefState = GuardSample['st']
  // (A weapon none of whose axis points comes within its radius, GUARD_SELF and BONE_PAD of that body's bone boxes is clear of it: its skin is posed only when one does.)
  const selves = new Map<string, { boxes: { lo: V3; hi: V3 }[]; mesh?: SkinMesh | null; rest?: number }>()
  const ownIn = (key: string, st: DefState, swing: Joints, side: 'L' | 'R'): { depth: number; rest: number } => {
    const h = def.held.find((x) => x.hand === side)
    if (!h || !def.dims.mocap!.rig.skin) return { depth: -Infinity, rest: -Infinity }
    const m = def.dims.mocap!
    const pos = { x: st.pos.x, y: st.y, z: st.pos.z }
    const skip = holdingBones(h)
    let self = selves.get(key + side)
    if (!self) {
      const B = boneBoxes(def, { joints: st.joints, clip: st.clip, position: pos, heading: hd })
      self = { boxes: [...B.box].filter(([i]) => !skip.has(i)).map(([, x]) => x) }
      selves.set(key + side, self)
    }
    const at = self
    const depth = (j: Joints): number => {
      const hj = st.clip ? j : holdJoints(def.dims, j, def.held)
      const pcs = heldWeaponSamples(def.dims, hj, side, h.spec, h.scale, st.clip, { position: pos, heading: hd, scale: def.scale })
      const near = (q: V3, pad: number): boolean => at.boxes.some((x) => q.x >= x.lo.x - pad && q.x <= x.hi.x + pad && q.y >= x.lo.y - pad && q.y <= x.hi.y + pad && q.z >= x.lo.z - pad && q.z <= x.hi.z + pad)
      if (!pcs.some((w) => w.p.some((q) => near(q, w.r + GUARD_SELF + BONE_PAD)))) return -Infinity
      if (at.mesh === undefined) {
        const own = boneSkin(m, fighterPose(m, st.joints, st.clip), new Set(MOCAP_BONES.map((b) => BONE_INDEX[b]).filter((b) => !skip.has(b))))
        at.mesh = own && own.tri.length > 0 ? skinMesh(own.p.map((q) => toWorld(q, pos, hd, def.scale)), own.tri) : null
      }
      const mesh = at.mesh
      return mesh ? Math.max(...pcs.map((w) => meshDepth(w.p, mesh) + w.r)) : -Infinity
    }
    at.rest ??= depth(st.joints)
    return { depth: depth(withOffsets(st.joints, swing)), rest: at.rest }
  }
  const keepsOut = (key: string, st: DefState, swing: Joints, side: 'L' | 'R'): boolean => {
    const { depth, rest } = ownIn(key, st, swing, side)
    return depth <= Math.max(-GUARD_SELF, rest)
  }
  // (Those frames the last to fail first.)
  const afterOrder = after.map((_, k) => k)
  const afterOk = (swing: Joints, side: 'L' | 'R'): boolean => {
    for (let n = 0; n < afterOrder.length; n++) {
      const k = afterOrder[n]!
      const a = after[k]!
      if (keepsOut(`a${k}`, a.st, Object.fromEntries(Object.entries(swing).map(([q, v]) => [q, v * a.w])), side)) continue
      afterOrder.unshift(...afterOrder.splice(n, 1))
      return false
    }
    return true
  }
  const clearAt = (s: (typeof at)[number], swing: Joints, side: 'L' | 'R'): boolean => {
    const j = withOffsets(s.st.joints, swing)
    if (s.weapon) return weaponIn(s, j, `arm${side}`) < -GUARD_CLEAR
    // (A weapon in that hand swings out with the arm, and no deeper into its own holder than it was.)
    if (s.limb)
      return (
        heldIn(s, j, side) < -GUARD_CLEAR &&
        meshDepth(skinPoints(def.dims.mocap!, j, s.st.clip, `arm${side}`).map((q) => toWorld(q, s.pos, hd, def.scale)), s.limb) < -GUARD_CLEAR &&
        (Object.keys(swing).length === 0 || !def.held.some((x) => x.hand === side) || keepsOut(`s${at.indexOf(s)}`, s.st, swing, side))
      )
    const d = blowDepth(atk, s.aj, s.ac, e, s.root, s.heading, def, j, s.st.clip, s.pos, hd, `guard${side}`)
    return d === null || d < -GUARD_CLEAR
  }
  // Every sample (or only one), the last to fail checked first.
  const order = [...at]
  const clear = (swing: Joints, side: 'L' | 'R', only?: number): boolean => {
    const after = (): boolean => Object.keys(swing).length === 0 || !at.some((s) => s.limb) || !def.held.some((x) => x.hand === side) || afterOk(swing, side)
    if (only !== undefined) return clearAt(at[only]!, swing, side) && after()
    for (let k = 0; k < order.length; k++) {
      if (clearAt(order[k]!, swing, side)) continue
      order.unshift(...order.splice(k, 1))
      return false
    }
    return after()
  }
  const out: Joints = {}
  for (const side of ['L', 'R'] as const) {
    if (clear({}, side)) continue
    // The way it swings: the least swing that clears the impact (down on a tie); then as far that way as clears the approach too (1.2 that way when none does).
    const search = (key: string): { swing: number; found: boolean } => {
      let way = 1
      let from = 1
      for (let k = 1; k <= 12; k++) {
        const d = [k * 0.1, -k * 0.1].find((a) => clear({ [key]: a }, side, 0))
        if (d !== undefined) {
          way = Math.sign(d)
          from = k
          break
        }
      }
      for (let k = from; k <= 12; k++) if (clear({ [key]: way * k * 0.1 }, side)) return { swing: way * k * 0.1, found: true }
      return { swing: 1.2 * way, found: false }
    }
    const pitch = search(`shoulder${side}X`)
    // Fork (fight-polish): an arm holding a weapon that no pitch clears (its weapon kept out of its holder) swings out sideways if that clears, else stays.
    if (!pitch.found && at.some((s) => s.limb) && def.held.some((x) => x.hand === side)) {
      const out2 = search(`shoulder${side}Z`)
      if (out2.found) out[`shoulder${side}Z`] = out2.swing
      continue
    }
    out[`shoulder${side}X`] = pitch.swing
  }
  // A leg the striking limb comes through (a kick's shin past the lead thigh) swings out of its way: the least hip abduction that clears it, at most LEG_SPLAY.
  for (const side of ['L', 'R'] as const) {
    if (!legs || !at.some((s) => s.limb || s.weapon)) break
    const key = `hip${side}Z`
    const legClear = (a: number): boolean => {
      for (let k = 0; k < order.length; k++) {
        const s = order[k]!
        const j = withOffsets(s.st.joints, { ...out, [key]: a })
        if (s.weapon ? weaponIn(s, j, `leg${side}`) < -GUARD_CLEAR : !s.limb || meshDepth(skinPoints(def.dims.mocap!, j, s.st.clip, `leg${side}`).map((q) => toWorld(q, s.pos, hd, def.scale)), s.limb) < -GUARD_CLEAR) continue
        order.unshift(...order.splice(k, 1))
        return false
      }
      return true
    }
    if (legClear(0)) continue
    if (!legClear(LEG_SPLAY)) {
      out[key] = LEG_SPLAY
      continue
    }
    let lo = 0
    let hi = LEG_SPLAY
    while (hi - lo > SPLAY_STEP) {
      const mid = (lo + hi) / 2
      if (legClear(mid)) hi = mid
      else lo = mid
    }
    out[key] = hi
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Mocap bots (fork, mocap/surface.ts): how far a bot's guard hand reaches toward the attacker (`toward`, a unit world direction), scaled. */
function guardReach(f: Fighter, joints: Joints | undefined, clip: ClipState | undefined, side: 'handL' | 'handR', toward: XZ, heading: number): number {
  const p = poseEffectors(f.dims, joints, clip)[side]
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  return partAhead(f.dims.mocap!, joints, clip, side, p, { x: toward.x * c - toward.z * s, y: 0, z: toward.x * s + toward.z * c }) * f.scale
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

/** A bot's body by part (the sweeps' groups): an armed guard keeps its weapon out of each part its idle holds it clear of (armedGuard). */
const BODY_PARTS: MocapBone[][] = [
  ['Head', 'Neck'],
  ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder'],
  ['LeftArm', 'LeftForeArm', 'LeftHand'],
  ['RightArm', 'RightForeArm', 'RightHand'],
  ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'],
  ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']
]

/**
 * Mocap bots (fork, fight-polish): an armed guard's free arm (not on a
 * two-handed grip, holding nothing) in the attacking weapon's way at the
 * impact (`a`, the attacker as placed; the defender `st` with the guard's
 * `fix`) swings out of it, GUARD_FREE clear (and GUARD_CLEAR of its own
 * guard weapon): its pitch, else its abduction, by the least (0.1 rad steps,
 * at most 1.2) that clears. Null when it is clear already or nothing clears.
 */
function freeArmSwing(atk: Fighter, aw: HeldWeapon, a: Placed, def: Fighter, guard: 'handL' | 'handR', st: { pos: XZ; y: number; joints: Joints; clip?: ClipState }, fix: Joints, hd: number): Joints | null {
  const side = guard === 'handL' ? 'R' : 'L'
  if (weaponOf(def, guard)?.spec.twoHanded || def.held.some((h) => h.hand === side)) return null
  const pcs = weaponsWorld(atk, a, false, aw)
  const pos = { x: st.pos.x, y: st.y, z: st.pos.z }
  const base = withOffsets(st.joints, fix)
  // Its own guard weapon, as the guard holds it.
  const own = weaponsWorld(def, { joints: base, clip: st.clip, position: pos, heading: hd }, false, weaponOf(def, guard)!)
  // The nearest skin of that arm to a weapon (its axis less its radius), uncapped (an axis point no nearer the arm's box than that is skipped).
  const gapTo = (arm: V3[], ws: WeaponSamples[]): number => {
    const lo = { x: Infinity, y: Infinity, z: Infinity }
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const v of arm) {
      lo.x = Math.min(lo.x, v.x)
      lo.y = Math.min(lo.y, v.y)
      lo.z = Math.min(lo.z, v.z)
      hi.x = Math.max(hi.x, v.x)
      hi.y = Math.max(hi.y, v.y)
      hi.z = Math.max(hi.z, v.z)
    }
    let g = Infinity
    for (const w of ws)
      for (const u of w.p) {
        if (Math.hypot(Math.max(0, lo.x - u.x, u.x - hi.x), Math.max(0, lo.y - u.y, u.y - hi.y), Math.max(0, lo.z - u.z, u.z - hi.z)) - w.r >= g) continue
        for (const v of arm) g = Math.min(g, Math.hypot(u.x - v.x, u.y - v.y, u.z - v.z) - w.r)
      }
    return g
  }
  const armAt = (swing: Joints): V3[] => skinPoints(def.dims.mocap!, withOffsets(base, swing), st.clip, `arm${side}`).map((q) => toWorld(q, pos, hd, def.scale))
  if (gapTo(armAt({}), pcs) >= GUARD_FREE) return null
  // (And clear of its own guard weapon.)
  const clears = (swing: Joints): boolean => {
    const arm = armAt(swing)
    return gapTo(arm, pcs) >= GUARD_FREE && gapTo(arm, own) >= GUARD_CLEAR
  }
  for (const key of [`shoulder${side}X`, `shoulder${side}Z`]) for (let k = 1; k <= 12; k++) for (const v of [k * 0.1, -k * 0.1]) if (clears({ [key]: v })) return { [key]: v }
  return null
}

/** Fork (fight-polish): the hand a fighter guards with a weapon in (a shield first, else a blade, club or shaft), or null. */
function armedSide(f: Fighter): 'handL' | 'handR' | null {
  const w = f.held.find((h) => h.spec.kind === 'shield') ?? f.held.find((h) => h.spec.kind === 'blade' || h.spec.kind === 'blunt' || h.spec.kind === 'polearm')
  return w ? (w.hand === 'L' ? 'handL' : 'handR') : null
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
  role: 'strike' | 'guard' = 'strike',
  clip?: ClipState,
  guess?: number
): { delta: number; err: number } {
  const err = (d: number): number => {
    const j = { ...joints, [key]: (joints[key] ?? 0) + d }
    return rootY + contactLocal(f, j, e, role, false, clip).y * f.scale - targetY
  }
  if (f.dims.mocap && guess !== undefined && Math.abs(guess) <= range) {
    // Mocap bots (fork): from the last pass's answer by secant (between passes the channel moves little); the scan if it strays.
    let d0 = guess
    let e0 = err(d0)
    if (Math.abs(e0) < 1e-7) return { delta: d0, err: Math.abs(e0) }
    let d1 = d0 + (d0 < range - WARM_STEP ? WARM_STEP : -WARM_STEP)
    let e1 = err(d1)
    for (let i = 0; i < 8 && Math.abs(e1) >= 1e-7 && Math.abs(e1 - e0) > 1e-12; i++) {
      const d2 = d1 - (e1 * (d1 - d0)) / (e1 - e0)
      if (!(Math.abs(d2) <= range) || Math.abs(d2 - guess) > WARM_REACH) break
      d0 = d1
      e0 = e1
      d1 = d2
      e1 = err(d2)
    }
    if (Math.abs(e1) < 1e-7) return { delta: d1, err: Math.abs(e1) }
  }
  // Mocap bots (fork): a coarser scan (each evaluation poses the rig); the root is refined below.
  const N = f.dims.mocap ? 16 : 48
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
  if (f.dims.mocap) {
    // Mocap bots (fork): regula falsi (Illinois) on the bracket, to 1e-7 m.
    let ehi = err(hi)
    let side = 0
    let d = lo
    for (let i = 0; i < 40; i++) {
      d = (lo * ehi - hi * elo) / (ehi - elo)
      const ed = err(d)
      if (Math.abs(ed) < 1e-7 || hi - lo < 1e-9) break
      if (Math.sign(ed) === Math.sign(elo)) {
        lo = d
        elo = ed
        if (side === -1) ehi /= 2
        side = -1
      }
      else {
        hi = d
        ehi = ed
        if (side === 1) elo /= 2
        side = 1
      }
    }
    return { delta: d, err: Math.abs(err(d)) }
  }
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
function solvePitch(f: Fighter, joints: Joints, e: Effector, rootY: number, targetY: number, wide = 1, clip?: ClipState, prev?: Joints): Joints {
  const x = pitchJoint(e)
  const z = x.replace(/X$/, 'Z')
  // Mocap bots (fork): `prev`, the last pass's answer, warm-starts the channels it solved (solveChannel ignores it otherwise).
  const first = solveChannel(f, joints, e, rootY, targetY, x, (x.startsWith('hip') ? LEG_PITCH : ARM_PITCH) * wide, 'strike', clip, prev && !(z in prev) ? prev[x] : undefined)
  if (first.err <= 1e-3) return { [x]: first.delta }
  const withX = { ...joints, [x]: (joints[x] ?? 0) + first.delta }
  const second = solveChannel(f, withX, e, rootY, targetY, z, ABDUCT_PITCH * wide, 'strike', clip, prev?.[z])
  const out = second.err < first.err ? { [x]: first.delta, [z]: second.delta } : { [x]: first.delta }
  // A weapon that still falls short (a short axe, a low follow-through) bends the elbow too.
  const err = Math.min(first.err, second.err)
  if (err <= 1e-3 || !weaponOf(f, e)) return out
  const elbow = `elbow${e.endsWith('L') ? 'L' : 'R'}`
  const third = solveChannel(f, withOffsets(joints, out), e, rootY, targetY, elbow, WEAPON_ELBOW, 'strike', clip)
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
  dir?: number,
  clip?: ClipState,
  lastR?: number,
  warm?: Joints
): { offsets: Joints; dir?: number; r?: number; upright: Joints } {
  let minSpacing = -Infinity
  // Mocap bots (fork): each pitch solve warm-starts from the last one's answer (the first from `warm`, the last pass's upright pitch).
  let guess: Joints | undefined = warm
  const at = (r: number, a: number): { o: Joints; err: number; a: number; space: number } => {
    const lean: Joints = { torsoX: r * Math.cos(a), torsoZ: r * Math.sin(a) }
    const pitch = solvePitch(f, withOffsets(joints, lean), e, rootY, targetY, wide, clip, guess)
    guess = pitch
    const o = { ...pitch, ...lean }
    const posed = withOffsets(joints, o)
    const space = spacing(posed)
    return { o, err: space < minSpacing ? Infinity : Math.abs(rootY + contactLocal(f, posed, e, 'strike', false, clip).y * f.scale - targetY), a, space }
  }
  const upright = at(0, 0)
  if (upright.err <= 1e-3) return { offsets: upright.o, dir, upright: upright.o }
  minSpacing = Math.min(upright.space, 0) - 0.005
  if (f.dims.mocap && dir !== undefined && lastR !== undefined) {
    // Mocap bots (fork): a later pass looks near the last pass's lean (between passes the target moves little).
    let lo = Math.max(0, lastR - LEAN_NEAR)
    let hi = Math.min(MAX_LEAN, lastR + LEAN_NEAR)
    let top = at(hi, dir)
    if (top.err <= 1e-3 && (lo === 0 || at(lo, dir).err > 1e-3)) {
      for (let i = 0; i < 3; i++) {
        const mid = (lo + hi) / 2
        const c = at(mid, dir)
        if (c.err <= 1e-3) {
          hi = mid
          top = c
        }
        else lo = mid
      }
      return { offsets: top.o, dir, r: hi, upright: upright.o }
    }
  }
  const DIRS = 12
  if (f.dims.mocap && dir === undefined) {
    // Mocap bots (fork): the directions ranked by the upright pitch under the full lean (one posed rig each); solved in the best.
    const reach = (a: number): number => {
      const posed = withOffsets(joints, { ...upright.o, torsoX: MAX_LEAN * Math.cos(a), torsoZ: MAX_LEAN * Math.sin(a) })
      return Math.abs(rootY + contactLocal(f, posed, e, 'strike', false, clip).y * f.scale - targetY)
    }
    let best = 0
    let bestErr = Infinity
    for (let d = 0; d < DIRS; d++) {
      const err = reach((2 * Math.PI * d) / DIRS)
      if (err < bestErr) {
        bestErr = err
        best = (2 * Math.PI * d) / DIRS
      }
    }
    dir = best
  }
  let full = at(MAX_LEAN, dir ?? 0)
  for (let d = 1; dir === undefined && d < DIRS; d++) {
    const c = at(MAX_LEAN, (2 * Math.PI * d) / DIRS)
    if (c.err < full.err) full = c
  }
  if (full.err >= upright.err) return { offsets: upright.o, dir, upright: upright.o }
  if (full.err > 1e-3) return { offsets: full.o, dir: full.a, upright: upright.o }
  let lo = 0
  let hi = MAX_LEAN
  // Mocap bots (fork): 6 halvings (0.3°), and the last reaching solve kept — each costs a posed pitch solve.
  let reached = full
  for (let i = 0; i < (f.dims.mocap ? 6 : 10); i++) {
    const mid = (lo + hi) / 2
    const c = at(mid, full.a)
    if (c.err <= 1e-3) {
      hi = mid
      reached = c
    }
    else lo = mid
  }
  return { offsets: f.dims.mocap ? reached.o : at(hi, full.a).o, dir: full.a, r: hi, upright: upright.o }
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
  /** Mocap bots (fork): the clip the event plays (`anchors` map absolute time → clip time); joints are its overlay. */
  clip?: ClipPick
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

function eventPose(ev: DefEvent, t: number, guard: Joints): { joints: Joints; off: XZ; up: number; clip?: ClipState } {
  if (ev.clip) {
    // Mocap bots (fork): the clip at its mapped time (a loop runs on), the extra as its overlay.
    const c = mocapClip(ev.clip.id)!
    const at = piecewise(ev.anchors)(t)
    const joints: Joints = { ...ev.extra(t) }
    const r = ev.root(t)
    const st: ClipState = { id: ev.clip.id, t: c.loop ? at : clamp(at, 0, c.duration) }
    if (ev.clip.mirror) st.mirror = true
    return { joints, off: r.off, up: r.up, clip: st }
  }
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

/**
 * Mocap bots (fork): a clip event around clip time `clipAt` (the frame that
 * meets the blow, played at `at`), from `lead` before it to `tail` after it,
 * at the clip's own speed, its root travel turned to `heading`.
 */
function clipEvent(f: Fighter, pick: ClipPick, at: number, clipAt: number, lead: number, tail: number, base: XZ, heading: number): DefEvent {
  const c = mocapClip(pick.id)!
  const a = Math.max(0, clipAt - lead)
  const b = Math.min(c.duration, clipAt + tail)
  const start = at - (clipAt - a)
  const end = at + (b - clipAt)
  const k = clipScale(f.dims.mocap!, c.hipH) * f.scale
  const r0 = clipRoot(c, a, pick.mirror)
  return {
    start,
    end,
    motion: null,
    mirror: pick.mirror,
    clip: pick,
    anchors: [
      [start, a],
      [end, b]
    ],
    root: (t) => {
      const r = clipRoot(c, clamp(a + (t - start), a, b), pick.mirror)
      const w = toWorld({ x: (r.x - r0.x) * k, y: 0, z: (r.z - r0.z) * k }, { x: 0, y: 0, z: 0 }, heading, 1)
      return { off: { x: w.x, z: w.z }, up: 0 }
    },
    base,
    times: [],
    extra: () => null
  }
}

/** Mocap bots (fork): the idle loop on shot time, as an event. */
function idleEvent(f: Fighter, start: number, end: number, base: XZ): DefEvent {
  return {
    start,
    end,
    motion: null,
    mirror: false,
    clip: { id: f.idle!, mirror: false },
    anchors: [
      [start, start],
      [start + 1, start + 1]
    ],
    root: () => ({ off: { x: 0, z: 0 }, up: 0 }),
    base,
    times: [],
    extra: () => null
  }
}

/** A fight motion's pose at local time t: keyframes as the evaluator blends them, a bot's clip keys their clip time. */
function motionPose(m: FightMotion, t: number): { joints: Joints; clip?: ClipState } {
  const k = m.keyframes
  if (!k[0]!.clip) return { joints: sampleMotion(m as MotionPreset, t).joints }
  let i = 0
  while (i < k.length - 2 && k[i + 1]!.t < t) i++
  const a = k[i]!
  const b = k[i + 1] ?? a
  const u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0
  const joints: Joints = {}
  for (const key of new Set([...Object.keys(a.joints), ...Object.keys(b.joints)])) joints[key] = (a.joints[key] ?? 0) + ((b.joints[key] ?? 0) - (a.joints[key] ?? 0)) * u
  const ca = a.clip!
  const cb = b.clip ?? ca
  const run = ca.id === cb.id && !!ca.mirror === !!cb.mirror && cb.at >= ca.at
  return { joints, clip: stateOf(run ? { ...ca, at: ca.at + (cb.at - ca.at) * u } : u < 0.5 ? ca : cb) }
}

/**
 * Mocap bots (fork): the side of the defender a blow lands on, from where
 * the striking point comes in (0.1 s before the impact, across the line to
 * the target); a straight blow by its hand or foot (a left lands on the
 * defender's right).
 */
function arrivalSide(f: Fighter, m: FightMotion, imp: StrikeImpact): 'L' | 'R' {
  const at = (t: number): V3 => {
    const s = motionPose(m, t)
    return contactLocal(f, s.joints, imp.effector, 'strike', false, s.clip)
  }
  const pI = at(imp.t)
  const pP = at(Math.max(0, imp.t - 0.1))
  const d = unit({ x: pI.x, z: pI.z })
  const lat = (pP.x - pI.x) * -d.z + (pP.z - pI.z) * d.x
  const fromLeft = Math.abs(lat) > 0.02 ? lat < 0 : imp.effector.endsWith('L')
  return fromLeft ? 'R' : 'L'
}

/** Moves that are a weapon's own: their clips strike with the right hand, so a left-hand weapon mirrors them. */
const WEAPON_MOVES = new Set(['sword-slash-combo', 'knife-lunge'])

/**
 * Mocap bots (fork, clip-moves.ts): a strike as clip runs, or null (no clip:
 * keyframes). One clip per impact; blows in a row on one clip play on in a
 * single run, other clips crossfade over CLIP_XFADE. Keys every CLIP_STEP of
 * clip time, on each impact and RAMP_IN before and RAMP_OUT after it (the
 * overlay's ramp), each with the clip's root travel so far.
 */
function clipStrike(f: Fighter, beat: FightBeat, move: string, gun: HeldWeapon | undefined, speeds: number[]): { motion: FightMotion; impacts: StrikeImpact[]; clips: string[] } | null {
  let blows: ClipBlow[] | null
  let mirror: boolean
  if (gun) {
    blows = gun.spec.kind === 'gun' ? gunClips(gun.spec.mount) : null
    mirror = gun.hand === 'L'
  }
  else {
    const melee = f.held.find((h) => h.spec.kind === 'blade' || h.spec.kind === 'blunt' || h.spec.kind === 'polearm')
    blows = moveClips(move, beat.target, melee, !!melee && f.held.some((h) => h.hand !== melee.hand))
    // A weapon's own move on the weapon hand; a fist move onto the weapon hand when only the other is armed.
    // Fork (fight-polish): a fist move off the shield arm when the other hand can take all of it (a hook with the shield swept its face through the head).
    const shieldAt = (e: Effector): boolean => weaponOf(f, e)?.spec.kind === 'shield'
    mirror =
      !!blows &&
      (WEAPON_MOVES.has(move)
        ? melee?.hand === 'L'
        : blows.some((b) => shieldAt(b.effector))
          ? blows.every((b) => !shieldAt(MIRROR_EFFECTOR[b.effector]))
          : blows.every((b) => !weaponOf(f, b.effector) && !!weaponOf(f, MIRROR_EFFECTOR[b.effector])))
  }
  if (!blows) return null
  type Seg = { clip: string; a: number; b: number; hits: { tau: number; effector: Effector; i: number }[] }
  const segs: Seg[] = []
  blows.forEach((blow, i) => {
    const e = mirror ? MIRROR_EFFECTOR[blow.effector] : blow.effector
    const w = gun ? undefined : (weaponOf(f, e) ?? undefined)
    const tau = clipImpactTime(blow, w)
    const prev = segs[segs.length - 1]
    if (prev && prev.clip === blow.clip && tau > prev.hits[prev.hits.length - 1]!.tau + 1e-9) prev.hits.push({ tau, effector: strikeEffector(f, e), i })
    else segs.push({ clip: blow.clip, a: 0, b: 0, hits: [{ tau, effector: strikeEffector(f, e), i }] })
  })
  const m = f.dims.mocap!
  const keys: FightKey[] = []
  const impacts: StrikeImpact[] = []
  let start = 0
  let base: XZ = { x: 0, z: 0 }
  segs.forEach((seg, n) => {
    const clip = mocapClip(seg.clip)!
    const first = seg.hits[0]!.tau
    const lastTau = seg.hits[seg.hits.length - 1]!.tau
    seg.a = Math.max(0, first - CLIP_LEAD)
    seg.b = Math.min(clip.duration, lastTau + (n === segs.length - 1 ? CLIP_END : CLIP_TAIL))
    const k = clipScale(m, clip.hipH) * f.scale
    const r0 = clipRoot(clip, seg.a, mirror)
    const at = new Set<number>([seg.a, seg.b])
    for (let s = seg.a + CLIP_STEP; s < seg.b - 1e-6; s += CLIP_STEP) at.add(Math.round(s * 1e6) / 1e6)
    for (const h of seg.hits) {
      at.add(h.tau)
      if (h.tau - RAMP_IN > seg.a + 1e-6) at.add(h.tau - RAMP_IN)
      if (h.tau + RAMP_OUT < seg.b - 1e-6) at.add(h.tau + RAMP_OUT)
    }
    const sorted = [...at].sort((p, q) => p - q).filter((v, q, all) => q === 0 || v - all[q - 1]! > 1e-6 || seg.hits.some((h) => h.tau === v))
    // Ramp keys too close to an impact go; the impact stays.
    const times = sorted.filter((v) => seg.hits.some((h) => h.tau === v) || seg.hits.every((h) => Math.abs(h.tau - v) > 1 / 120))
    for (const c of times) {
      const r = clipRoot(clip, c, mirror)
      keys.push({
        t: start + (c - seg.a),
        joints: {},
        clip: mirror ? { id: seg.clip, at: c, mirror: true } : { id: seg.clip, at: c },
        travel: { x: base.x + (r.x - r0.x) * k, z: base.z + (r.z - r0.z) * k }
      })
    }
    for (const h of seg.hits) impacts[h.i] = { effector: h.effector, t: start + (h.tau - seg.a), speed: speeds[h.i] ?? speeds[speeds.length - 1] ?? 8 }
    const rb = clipRoot(clip, seg.b, mirror)
    base = { x: base.x + (rb.x - r0.x) * k, z: base.z + (rb.z - r0.z) * k }
    start += seg.b - seg.a + CLIP_XFADE
  })
  const duration = keys[keys.length - 1]!.t
  return { motion: { id: `mocap:${blows.map((b) => b.clip).join('+')}`, duration, keyframes: keys }, impacts, clips: blows.map((b) => b.clip) }
}

/** Mocap bots (fork): how far a fall clip carries the body behind its root (m), from `from` on. */
function fallReachClip(f: Fighter, pick: ClipPick, from: number): number {
  const c = mocapClip(pick.id)!
  let reach = 0
  for (let t = from; t <= c.duration + 1e-9; t += 1 / 15) {
    const fx = poseEffectors(f.dims, undefined, pick.mirror ? { id: pick.id, t, mirror: true } : { id: pick.id, t })
    reach = Math.max(reach, fx.head.z, fx.chest.z, fx.kneeL.z, fx.kneeR.z, fx.footL.z, fx.footR.z)
  }
  return reach * f.scale
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
  /** A fighter at rest at time t: the guard, or (a mocap bot, fork) the idle clip on shot time. */
  const restOf = (f: Fighter, t: number): { joints: Joints; clip?: MarkClip } => (f.idle ? { joints: {}, clip: { id: f.idle, at: t } } : { joints: guard })
  for (const f of F) {
    const r = restOf(f, 0)
    addMark(f, 0, f.spot, groundY(f.floor, r.joints, 0, stateOf(r.clip)), 'stand', r.joints, f.heading, r.clip, !!f.idle)
  }
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
    const keyed = preset0 && mirror ? mirroredMove(preset0) : preset0
    // Mocap bots (fork, clip-moves.ts): the move's clips when the library has them, else its keyframes (retargeted).
    const strike = atk.idle && (!shotBeat || gun) ? clipStrike(atk, beat, move, gun, raw.map((imp) => imp.speed)) : null
    const preset: FightMotion | undefined = strike?.motion ?? keyed
    const impacts: StrikeImpact[] = strike
      ? strike.impacts
      : !keyed
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
    if (gun?.spec.support && !atk.held.some((h) => h.hand !== gun.hand) && !strike) {
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
    // Mocap bots (fork): the side of the defender each blow lands on (its reaction and defense go away from it).
    const sides = def.idle ? impacts.map((imp) => arrivalSide(atk, preset, imp)) : []

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
      const aim = preset.keyframes.find((kf) => Math.abs(kf.t - impacts[0]!.t) < 1e-9)!
      const muzzle = contactLocal(atk, aim.joints, impacts[0]!.effector, 'strike', false, stateOf(aim.clip))
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
      /** Mocap bots (fork): the reaction clip of each landed blow. */
      const hitEvents = new Map<number, DefEvent>()
      // Mocap bots (fork): guards that open for a blow (from GUARD_LEAD before it: 5b).
      const opens: { T: number; joints: Joints }[] = []
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
          // Mocap bots (fork): the block or dodge clip, its guard frame on the impact.
          // Fork (fight-polish): a bot with a blade, club, shaft or shield blocks and parries on its idle, its guard arm raised (armedGuard, below).
          const armed = !!def.idle && def.dims.mocap?.rig.skin !== undefined && (o === 'block' || o === 'parry') && armedSide(def) !== null
          const pick = armed ? { id: def.idle!, mirror: false } : def.idle ? defenseClip(o, zoneHigh, sides[i]!, shield ? { shieldHand: shield } : def.held.length > 0 ? { weapon: true } : undefined) : null
          const ev = armed ? idleEvent(def, T - DEF_LEAD, T + DEF_TAIL, base) : pick ? clipEvent(def, pick, T, defenseReadyTime(pick.id), DEF_LEAD, DEF_TAIL, base, hd) : constantEvent(start, start + m.duration, m, base, mirror)
          const own = pick ? ev.root(ev.end).off : null
          const ph = physics[i]!
          if ((o === 'block' || o === 'parry') && (ph.result === 'stagger' || ph.result === 'knockdown')) {
            let back = ph.result === 'stagger' ? ph.stepBack : Math.min(0.6, ph.slide * 0.5)
            back = propStop(notes, label, beat.attacker === 0 ? 'B' : 'A', 'push-back', base, away, back, 0, obstacles)
            const dur = ph.result === 'stagger' ? ph.stepDuration : 0.4
            if (pick) {
              const clipRootAt = ev.root
              ev.root = (t) => {
                const r = clipRootAt(t)
                const f = back * clamp((t - T) / dur, 0, 1)
                return { off: { x: r.off.x + away.x * f, z: r.off.z + away.z * f }, up: r.up }
              }
            }
            else ev.root = (t) => ({ off: { x: away.x * back * clamp((t - T) / dur, 0, 1), z: away.z * back * clamp((t - T) / dur, 0, 1) }, up: 0 })
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
          // A bot's dodge carries it back: what follows starts there.
          if (own) base = add(base, own)
          if (o === 'block' || o === 'parry') blockEvents.set(i, ev)
          if (o === 'slip' || o === 'duck') avoidIdx.push(i)
        }
        else if (o === 'miss') {
          const prev = events[events.length - 1]
          const ev = prev && prev.end > T ? { ...prev, times: [...prev.times] } : def.idle ? idleEvent(def, T - 0.25, T + 0.4, base) : constantEvent(T - 0.25, T + 0.4, null, base)
          if (!(prev && prev.end > T)) events.push(ev)
          avoidIdx.push(i)
        }
        else {
          // hit / ko: the reaction starts on the impact frame.
          const ph = physics[i]!
          // Mocap bots (fork): the reaction clip by target and the side the blow lands on, on the physics' root and timing.
          const pickR = def.idle
            ? reactionClip({
                result: ph.result === 'knockdown' || ph.result === 'stagger' ? ph.result : 'hit',
                ko: o === 'ko',
                zone: beat.target,
                moveId: beat.move,
                side: sides[i]!,
                pushFront: away.x * fwdOf(hd).x + away.z * fwdOf(hd).z > 0
              })
            : null
          if (pickR) {
            const c = mocapClip(pickR.id)!
            const onset = reactionOnset(pickR.id)
            const ev = clipEvent(def, pickR, T, onset, 0, c.duration - onset, base, hd)
            let travel = 0
            if (ph.result === 'stagger') {
              // The step back on top of the clip, eased over the physics' step.
              travel = ph.stepBack
              const clipRootAt = ev.root
              ev.root = (t) => {
                const r = clipRootAt(t)
                const f = travel * smoothstep(clamp((t - T) / ph.stepDuration, 0, 1))
                return { off: { x: r.off.x + away.x * f, z: r.off.z + away.z * f }, up: r.up }
              }
            }
            else if (ph.result === 'knockdown') {
              // The fall lands on the physics' fall time; the body slides the physics' slide, shaped by the clip's own travel.
              const land = Math.max(onset + 1 / c.fps, fallLandTime(pickR.id))
              ev.anchors = [
                [T, onset],
                [T + ph.fallDuration, land],
                [T + ph.fallDuration + (c.duration - land), c.duration]
              ]
              ev.end = T + ph.fallDuration + (c.duration - land)
              travel = ph.slide
              const toClip = piecewise(ev.anchors)
              ev.root = (t) => {
                const f = travel * backTravel(pickR.id, onset, land, clamp(toClip(t), onset, c.duration), pickR.mirror)
                return { off: { x: away.x * f, z: away.z * f }, up: 0 }
              }
            }
            if (travel > 0) {
              const what = ph.result === 'knockdown' ? 'slide' : 'stagger'
              travel = propStop(notes, label, beat.attacker === 0 ? 'B' : 'A', what, base, away, travel, ph.result === 'knockdown' ? fallReachClip(def, pickR, onset) : 0, obstacles)
            }
            events.push(ev)
            hitEvents.set(i, ev)
            base = add(base, away, travel)
            continue
          }
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
      const defAt = (t: number): { pos: XZ; y: number; joints: Joints; clip?: ClipState } => {
        let ev: DefEvent | null = null
        for (const e of events) if (t >= e.start - 1e-9) ev = e
        if (!ev) {
          const r = restOf(def, t)
          const first = events[0]
          if (def.idle && first?.clip && t > first.start - BOT_LEAD) {
            // Mocap bots (fork): the idle crossfades into the first clip over BOT_LEAD before it (5b's lead-in, with the guards opening by then).
            const at = first.start - BOT_LEAD
            const u = (t - at) / BOT_LEAD
            let ja: Joints = {}
            for (const o of opens) if (o.T - GUARD_LEAD < at) ja = withOffsets(ja, Object.fromEntries(Object.entries(o.joints).map(([k, v]) => [k, v * clamp((at - o.T + GUARD_LEAD) / (GUARD_LEAD - GUARD_FULL), 0, 1)])))
            const b = eventPose(first, first.start, guard)
            const joints = Object.fromEntries([...new Set([...Object.keys(ja), ...Object.keys(b.joints)])].map((k) => [k, (ja[k] ?? 0) + ((b.joints[k] ?? 0) - (ja[k] ?? 0)) * u]))
            const to = add(first.base, b.off)
            return { pos: { x: D.x + (to.x - D.x) * u, z: D.z + (to.z - D.z) * u }, y: def.floor.y, joints, clip: { ...b.clip!, w: u, from: { id: def.idle, t: at } } }
          }
          return { pos: { ...D }, y: groundY(def.floor, r.joints, 0, stateOf(r.clip)), joints: { ...r.joints }, clip: stateOf(r.clip) }
        }
        const p = eventPose(ev, t, guard)
        return { pos: add(ev.base, p.off), y: groundY(def.floor, p.joints, 0, p.clip), joints: p.joints, clip: p.clip }
      }

      // 3. Attacker placement per impact, iterated so "toward the attacker" is self-consistent.
      const place: { root: XZ; heading: number; pitch: Joints; lift: number; base: XZ; target: V3; error: number; rootY: number; travel?: XZ }[] = []
      for (let i = 0; i < impacts.length; i++) {
        const imp = impacts[i]!
        const kf = preset.keyframes[kIdx[i]!]!
        const kClip = stateOf(kf.clip)
        const o = outcomes[i]!
        const T = times[i]!
        const dState = defAt(T)
        const dPos: V3 = { x: dState.pos.x, y: dState.y, z: dState.pos.z }
        const avoided = o === 'slip' || o === 'duck' || o === 'miss'
        const restD = restOf(def, T)
        const aimJoints = avoided ? restD.joints : dState.joints
        const aimClip = avoided ? stateOf(restD.clip) : dState.clip
        const aimPos: V3 = avoided ? { x: D.x, y: groundY(def.floor, restD.joints, 0, aimClip), z: D.z } : dPos
        const kick = imp.effector.startsWith('foot') || imp.effector.startsWith('knee')
        // Mocap bots (fork): a leg splay the strike carries (legSplay), found after a first placement.
        let legFix: Joints = {}
        // Mocap bots (fork): the angle the attacker comes in at, swung about the target (orbit, below).
        let orbit = 0
        // Mocap bots (fork): how far a bare blocking arm reaches across toward the blow (GUARD_ACROSS, below).
        let across = 0
        // One placement; `wide` scales the limbs' pitch ranges, `lean` leans the torso too (fork: the reach retry below).
        const placeAt = (wide: number, lean = false) => {
          // Mocap bots (fork): the clip key with any leg splay (legSplay) the placement carries.
          const kj = withOffsets(kf.joints, legFix)
          const A1 = orbit ? turnAbout(A0, aimPos, orbit) : A0
          // Floor contact (fork): the root height rests the pitched pose's lowest point on the floor.
          let rootY = groundY(atk.floor, kj, 0, kClip)
          let R: XZ = add(aimPos, unit(sub(A1, aimPos)), 0.8)
          let result = { root: R, heading: 0, pitch: {} as Joints, lift: 0, base: R, target: aimPos, error: Infinity, rootY, travel: kf.travel }
          let armFix: Joints = {}
          let leanDir: number | undefined
          let leanR: number | undefined
          // Mocap bots (fork): skin to skin: how far the aim point moves out toward the attacker so the striking skin just touches.
          let skinOut = 0
          let guardSideUsed: 'handL' | 'handR' = 'handR'
          let lastPitch: Joints | undefined
          // Mocap bots (fork): the last pass's block aim, guard arm and upright pitch, warm-starting this pass's solves.
          let lastAim: Joints | undefined
          let lastArm: Joints = {}
          let lastUpright: Joints | undefined
          for (let it = 0; it < 8; it++) {
            const toward = unit(sub(R, aimPos))
            let T3 = fightTarget(def.dims, def.scale, aimJoints, aimPos, hd, toward, beat.target, imp.effector, def.torso, aimClip)
            if (o === 'block' || o === 'parry') {
              // The blow lands on the guard hand on its side, and that arm reaches
              // to the height the blow comes in at (elbow, then abduction).
              const aimPitch = solvePitch(atk, kj, imp.effector, rootY, T3.y, wide, kClip, lastAim)
              lastAim = aimPitch
              const aimed = withOffsets(kj, aimPitch)
              const e0 = contactLocal(atk, aimed, imp.effector, 'strike', false, kClip)
              const side = guardSide(def, guardHand(e0.x))
              guardSideUsed = side
              const h = rootY + e0.y * atk.scale
              const s = strikeEffector(def, side).endsWith('L') ? 'L' : 'R'
              // A shield doesn't reach: the blow meets its face where it is (reaching would turn the face away).
              // Fork (fight-polish): the shell (a bare head block, defenseClip) holds both forearms up in front of the face: the blow meets them where they are.
              const shell = beat.target === 'head' && def.held.length === 0 && blockEvents.get(i)?.clip?.id === 'blockBody'
              const reach = weaponOf(def, side)?.spec.kind === 'shield' || shell ? 0 : 1
              const first = solveChannel(def, aimJoints, side, aimPos.y, h, `elbow${s}`, BLOCK_ELBOW * reach, 'guard', aimClip, lastArm[`elbow${s}`])
              armFix = { [`elbow${s}`]: first.delta }
              let guardErr = first.err
              if (first.err > 1e-3) {
                const second = solveChannel(def, withOffsets(aimJoints, armFix), side, aimPos.y, h, `shoulder${s}Z`, ABDUCT_PITCH * reach, 'guard', aimClip, lastArm[`shoulder${s}Z`])
                if (second.err < first.err) {
                  armFix = { ...armFix, [`shoulder${s}Z`]: second.delta }
                  guardErr = second.err
                }
              }
              if (guardErr > 1e-3 && weaponOf(def, side)) {
                // A blade or shield held high (a parry) also swings the shoulder to meet the blow's height.
                const third = solveChannel(def, withOffsets(aimJoints, armFix), side, aimPos.y, h, `shoulder${s}X`, ARM_PITCH * reach, 'guard', aimClip, lastArm[`shoulder${s}X`])
                if (third.err < guardErr) armFix = { ...armFix, [`shoulder${s}X`]: third.delta }
              }
              lastArm = armFix
              const guardWeapon = def.idle && def.dims.mocap?.rig.skin ? armedSide(def) : null
              if (guardWeapon !== null && guardWeapon === strikeEffector(def, side)) {
                // Fork (fight-polish): an armed bot's weapon meets the blow in front of the zone it covers, its guard point at the blow's height,
                // out by GUARD_OUT and the attacking weapon's reach past its strike point; the blade across the line of attack, a shield facing it.
                const aw = weaponOf(atk, imp.effector)
                const past = aw ? dist3(weaponContact(aw.spec, 'strike'), aw.spec.tip) * aw.scale * atk.scale : 0
                const zone = fightTarget(def.dims, def.scale, aimJoints, aimPos, hd, toward, beat.target, imp.effector, def.torso, aimClip)
                const out = GUARD_OUT * def.scale + past
                armFix = armedGuard(def, aimJoints, aimClip, guardWeapon, aimPos, hd, { x: zone.x + toward.x * out, y: h, z: zone.z + toward.z * out }, toward, lastArm)
                lastArm = armFix
              }
              // Mocap bots (fork): the guard reaching across toward a blow that sweeps past it.
              if (across > 0) armFix = withOffsets(armFix, { [`shoulder${s}Z`]: -across })
              const hand = effectorWorld(def, withOffsets(aimJoints, armFix), aimPos, aimPos.y, hd, side, 'guard', aimClip)
              if (def.dims.mocap && !weaponOf(def, side)) {
                // Mocap bots (fork): the blow meets the guard hand's own front.
                const g = guardReach(def, withOffsets(aimJoints, armFix), aimClip, side, toward, hd)
                T3 = { x: hand.x + toward.x * g, y: hand.y, z: hand.z + toward.z * g }
              }
              else T3 = { x: hand.x + toward.x * 0.05 * def.scale, y: hand.y, z: hand.z + toward.z * 0.05 * def.scale }
            }
            if (skinOut !== 0) T3 = { x: T3.x + toward.x * skinOut, y: T3.y, z: T3.z + toward.z * skinOut }
            // A two-hand grip pitches both arms alike, so the off hand stays on the grip.
            // A lean (fork): the attacker placed in a pose as below, and how far its torso and head stay out of the defender.
            const spacing = (j: Joints): number => {
              const e = contactLocal(atk, j, imp.effector, 'strike', false, kClip)
              const u = unit(sub(A1, T3), unit(sub(A1, aimPos)))
              const root = add(T3, u, Math.hypot(e.x, e.z) * atk.scale)
              const at: V3 = { x: root.x, y: rootY, z: root.z }
              const heading = Math.atan2(u.x, u.z) - Math.atan2(-e.x, -e.z)
              const toward = unit(sub(aimPos, root))
              const head = toWorld(poseEffectors(atk.dims, j, kClip).head, at, heading, atk.scale)
              const points = [0.3, 0.6, 0.9].map((y) => torsoSurface(atk.torso, atk.dims, atk.scale, j, at, heading, toward, y, kClip))
              points.push({ x: head.x + toward.x * atk.dims.headR * atk.scale, y: head.y, z: head.z + toward.z * atk.dims.headR * atk.scale })
              return Math.min(...points.map((q) => bodyClearance(def.torso, def.dims, def.build, def.scale, aimJoints, aimPos, hd, q, aimClip)))
            }
            const fit = lean ? solveLean(atk, kj, imp.effector, rootY, T3.y, wide, spacing, leanDir, kClip, leanR, lastUpright) : null
            leanDir = fit?.dir
            leanR = fit?.r
            lastUpright = fit?.upright
            const pitch = gripPitch(beat.move, fit ? fit.offsets : solvePitch(atk, kj, imp.effector, rootY, T3.y, wide, kClip, lastPitch))
            lastPitch = fit ? undefined : pitch
            const joints = withOffsets(kj, pitch)
            const e = contactLocal(atk, joints, imp.effector, 'strike', false, kClip)
            // A kick still short of the target lifts the kicker, only as much as needed.
            const short = T3.y - (rootY + e.y * atk.scale)
            const lift = kick && short > 1e-3 ? Math.min(MAX_KICK_LIFT, short) : 0
            const ex = e.x * atk.scale
            const ez = e.z * atk.scale
            const r = Math.hypot(ex, ez)
            const phi = Math.atan2(-ex, -ez)
            const uA = unit(sub(A1, T3), unit(sub(A1, aimPos)))
            R = add(T3, uA, r)
            if (!clinch && flat(sub(R, dState.pos)) < MIN_SEPARATION) R = add(dState.pos, unit(sub(R, dState.pos), uA), MIN_SEPARATION)
            const heading = Math.atan2(uA.x, uA.z) - phi
            const E = effectorWorld(atk, joints, R, rootY + lift, heading, imp.effector, 'strike', kClip)
            const fwd = fwdOf(heading)
            const base = add(R, fwd, -(kf.move?.forward ?? 0) * atk.k)
            result = { root: R, heading, pitch: withOffsets(legFix, pitch), lift, base, target: T3, error: dist3(E, T3), rootY, travel: kf.travel }
            // Mocap bots (fork): the striking skin against the target's, and the aim point moved out (or in) by the depth.
            const touching = o === 'hit' || o === 'ko' || o === 'block' || o === 'parry'
            const depth = touching
              ? blowDepth(atk, joints, kClip, imp.effector, { x: R.x, y: rootY + lift, z: R.z }, heading, def, withOffsets(aimJoints, armFix), aimClip, aimPos, hd, skinOf(def, aimJoints, aimClip, beat.target, o, guardSideUsed, toward, hd), o === 'block' || o === 'parry')
              : null
            if (depth !== null) skinOut += depth
            // Floor contact (fork): re-solve until the pitched pose's root height holds.
            const y = groundY(atk.floor, joints, 0, kClip)
            if (it >= 3 && Math.abs(y - rootY) < 1e-5 && (depth === null || Math.abs(depth) < 2e-4)) break
            rootY = y
          }
          return { result, armFix }
        }
        const decide = (): { result: ReturnType<typeof placeAt>['result']; armFix: Joints } => {
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
          return { result, armFix }
        }
        let { result, armFix } = decide()
        // Mocap bots (fork): a landed blow gets through the guard: a hand or forearm in its way swings just clear.
        /** The impact and (a bot) every frame of the `lead` before it, for placement `r`: the guard in its way (guardOpening), the bodies (orbit). */
        const approach = (r: ReturnType<typeof placeAt>['result'], lead: number): GuardSample[] => {
          // The impact, and (a bot) every frame of the approach between its keys: their overlay as laid, their root along the clip's travel or the move's step.
          const samples: GuardSample[] = [{ t: T, aj: withOffsets(kf.joints, r.pitch), ac: kClip, root: { x: r.root.x, y: r.rootY + r.lift, z: r.root.z }, heading: r.heading, st: defAt(T) }]
          const keys = preset.keyframes
          // A key's overlay as 5a lays it: a clip's ramped in to the impact, a keyframe move's on the impact key and the one before.
          const overlay = (j: number): number => (strike ? clamp(1 + (keys[j]!.t - kf.t) / RAMP_IN, 0, 1) : j === kIdx[i]! || j === kIdx[i]! - 1 ? 1 : 0)
          for (let k = 1; atk.idle && k <= Math.floor(lead * fps + 1e-9); k++) {
            const tau = kf.t - k / fps
            let b = kIdx[i]!
            while (b > 0 && keys[b - 1]!.t >= tau) b--
            if (b === 0) break
            const ka = keys[b - 1]!
            const kb = keys[b]!
            const u = kb.t > ka.t ? (tau - ka.t) / (kb.t - ka.t) : 1
            const posed = (kj: FightKey, w: number): Joints => withOffsets(kj.joints, Object.fromEntries(Object.entries(r.pitch).map(([q, v]) => [q, v * w])))
            const ja = posed(ka, overlay(b - 1))
            const jb = posed(kb, overlay(b))
            const aj = Object.fromEntries([...new Set([...Object.keys(ja), ...Object.keys(jb)])].map((q) => [q, (ja[q] ?? 0) + ((jb[q] ?? 0) - (ja[q] ?? 0)) * u]))
            const clip: MarkClip | undefined = ka.clip && kb.clip && ka.clip.id === kb.clip.id ? { ...kb.clip, at: ka.clip.at + (kb.clip.at - ka.clip.at) * u } : u < 0.5 ? ka.clip : kb.clip
            // The root along the clip's travel, or the keyframe move's forward step.
            let off: XZ
            if (ka.travel && kb.travel && kf.travel) {
              const w = toWorld({ x: ka.travel.x + (kb.travel.x - ka.travel.x) * u - kf.travel.x, y: 0, z: ka.travel.z + (kb.travel.z - ka.travel.z) * u - kf.travel.z }, { x: 0, y: 0, z: 0 }, r.heading, 1)
              off = { x: w.x, z: w.z }
            }
            else {
              const fa = ka.move?.forward ?? 0
              off = add({ x: 0, z: 0 }, fwdOf(r.heading), (fa + ((kb.move?.forward ?? 0) - fa) * u - (kf.move?.forward ?? 0)) * atk.k)
            }
            const ac = stateOf(clip)
            samples.push({ t: T + tau - kf.t, aj, ac, root: { x: r.root.x + off.x, y: ac ? r.rootY : groundY(atk.floor, aj), z: r.root.z + off.z }, heading: r.heading, st: defAt(T + tau - kf.t) })
          }
          return samples
        }
        const hitEv = hitEvents.get(i)
        // The guard it opens (found again after an orbit): read live by the reaction, the clip playing before it and 5b's lead-in.
        const gate = { T, joints: {} as Joints }
        const scaled = (w: number): Joints | null => (w > 0 && Object.keys(gate.joints).length > 0 ? Object.fromEntries(Object.entries(gate.joints).map(([k, v]) => [k, v * w])) : null)
        const openGuard = (): void => {
          gate.joints = {}
          // (A blow to the legs lands on one: they stay.)
          // (Fork, fight-polish: and the frames it eases off over, as hitEv.extra below lays them.)
          // (Only a defender holding a weapon looks at them.)
          const span = hitEv && def.held.length > 0 ? Math.min(GUARD_REOPEN, Math.max(1e-3, hitEv.end - T)) : 0
          const after = Array.from({ length: Math.floor(span * fps + 1e-9) }, (_, k) => ({ st: defAt(T + (k + 1) / fps), w: clamp(1 - (k + 1) / fps / span, 0, 1) }))
          const open = guardOpening(atk, imp.effector, approach(result, GUARD_LEAD), def, hd, beat.target !== 'legs', after)
          if (!open) return
          gate.joints = open
          ;({ result, armFix } = decide())
        }
        if (hitEv) {
          opens.push(gate)
          // Back up by the reaction's end at the latest.
          const span = Math.min(GUARD_REOPEN, Math.max(1e-3, hitEv.end - T))
          hitEv.extra = (t) => scaled(clamp(1 - (t - T) / span, 0, 1))
          // A defense or reaction still playing when the blow comes (a combo's next blow) opens on the way: from GUARD_LEAD before it, all the way by GUARD_FULL before.
          for (const e of events) {
            if (e === hitEv || e.start >= T - 1e-9 || e.end < T - GUARD_LEAD) continue
            const before = e.extra
            e.extra = (t) => {
              const x = before(t)
              const o = t >= T ? null : scaled(clamp((t - T + GUARD_LEAD) / (GUARD_LEAD - GUARD_FULL), 0, 1))
              if (!o) return x
              const out: Joints = { ...(x ?? {}) }
              for (const [k, v] of Object.entries(o)) out[k] = (out[k] ?? 0) + v
              return out
            }
            e.times = [...e.times, T - GUARD_LEAD, T - GUARD_FULL]
          }
          openGuard()
        }
        if (atk.idle && atk.dims.mocap?.rig.skin) {
          // Mocap bots (fork): a leg in the defender's legs at the impact splays out, and the strike is placed again with it.
          const st = defAt(T)
          const splay = legSplay(atk, imp.effector, withOffsets(kf.joints, result.pitch), kClip, { x: result.root.x, y: result.rootY + result.lift, z: result.root.z }, result.heading, def, st.joints, st.clip, { x: st.pos.x, y: st.y, z: st.pos.z }, hd)
          if (Object.keys(splay).length > 0) {
            legFix = splay
            ;({ result, armFix } = decide())
          }
        }
        if (atk.idle && atk.dims.mocap?.rig.skin && def.dims.mocap?.rig.skin && (o === 'hit' || o === 'ko' || o === 'block' || o === 'parry')) {
          // Mocap bots (fork, crd2): a blow whose approach still sinks one body into the other (its legs splayed as 5a lays them) comes in swung about the target.
          // A blocking arm reaches in by the impact (as its ramp below lays it), from the block's start.
          const bev = blockEvents.get(i)
          const depth = (r: ReturnType<typeof placeAt>['result'], fix: Joints = {}): number =>
            Math.max(
              0,
              ...approach(r, ORBIT_LEAD).map((s) => {
                const dpos = { x: s.st.pos.x, y: s.st.y, z: s.st.pos.z }
                const f = bev ? clamp((s.t - bev.start) / Math.max(1e-6, T - bev.start), 0, 1) : 0
                const dj = f > 0 ? withOffsets(s.st.joints, Object.fromEntries(Object.entries(fix).map(([k, v]) => [k, v * f]))) : s.st.joints
                const aj = withOffsets(s.aj, legSplay(atk, imp.effector, s.aj, s.ac, s.root, s.heading, def, dj, s.st.clip, dpos, hd))
                return bodyOverlap(atk, { joints: aj, clip: s.ac, position: s.root, heading: s.heading }, def, { joints: dj, clip: s.st.clip, position: dpos, heading: hd }, false, s.t >= T - 1e-9 && (o === 'hit' || o === 'ko') ? atk : undefined)
              })
            )
          // The skin contact the report will read (a placement's error is its aim point's).
          const contact = (r: ReturnType<typeof placeAt>['result'], fix: Joints): number => {
            const st = defAt(T)
            const a = { joints: withOffsets(kf.joints, r.pitch), clip: kClip, position: { x: r.root.x, y: r.rootY + r.lift, z: r.root.z }, heading: r.heading } as EntityState
            const d = { joints: withOffsets(st.joints, fix), clip: st.clip, position: { x: st.pos.x, y: st.y, z: st.pos.z }, heading: hd } as EntityState
            return measuredError(atk, def, a, d, beat.target, imp.effector, o)
          }
          let worst = depth(result, armFix)
          // One more placement as `orbit` / `across` now say, its legs splayed as 5a lays them.
          const attempt = (): ReturnType<typeof decide> => {
            legFix = {}
            let tried = decide()
            const st = defAt(T)
            const splay = legSplay(atk, imp.effector, withOffsets(kf.joints, tried.result.pitch), kClip, { x: tried.result.root.x, y: tried.result.rootY + tried.result.lift, z: tried.result.root.z }, tried.result.heading, def, st.joints, st.clip, { x: st.pos.x, y: st.y, z: st.pos.z }, hd)
            if (Object.keys(splay).length > 0) {
              legFix = splay
              tried = decide()
            }
            return tried
          }
          const lands = worst > ORBIT_TOL ? Math.max(contact(result, armFix), ORBIT_CONTACT) : 0
          if (worst > ORBIT_TOL && bev && def.held.length === 0 && !weaponOf(atk, imp.effector)) {
            // A bare guard the blow still sinks past (a spinning backfist sweeping across it) reaches across toward it first, kept if that helps.
            const legs = legFix
            across = GUARD_ACROSS
            const tried = attempt()
            const d = tried.result.error > Math.max(CONTACT_TOLERANCE, result.error) || contact(tried.result, tried.armFix) > lands ? Infinity : depth(tried.result, tried.armFix)
            if (d < worst - ORBIT_GAIN) {
              result = tried.result
              armFix = tried.armFix
              worst = d
              notes.push(`${label}: ${beat.attacker === 0 ? 'B' : 'A'}'s guard reaches across to meet blow ${i + 1} so the bodies stay apart`)
            }
            else {
              across = 0
              legFix = legs
            }
          }
          if (worst > ORBIT_TOL) {
            let best = { orbit: 0, result, armFix, legFix, worst }
            for (const [k, deg] of ORBIT_STEPS.entries()) {
              // The finer angles only beside the best coarse one (between it and its neighbours).
              if (k >= ORBIT_COARSE && Math.abs(deg - (best.orbit * 180) / Math.PI) >= 15) continue
              orbit = (deg * Math.PI) / 180
              const tried = attempt()
              if (tried.result.error <= Math.max(CONTACT_TOLERANCE, result.error) && contact(tried.result, tried.armFix) <= lands) {
                const d = depth(tried.result, tried.armFix)
                if (d < best.worst - ORBIT_GAIN || (d < best.worst && d <= ORBIT_BAR && best.worst > ORBIT_BAR)) best = { orbit, result: tried.result, armFix: tried.armFix, legFix, worst: d }
              }
              // The finer angles only when the coarse ones leave it over the bar.
              if (best.worst <= ORBIT_TOL || (k === ORBIT_COARSE - 1 && best.worst <= ORBIT_BAR)) break
            }
            orbit = best.orbit
            legFix = best.legFix
            result = best.result
            armFix = best.armFix
            // The guard in its way, for the way it comes in now.
            if (orbit !== 0 && hitEv) openGuard()
            if (orbit !== 0) notes.push(`${label}: blow ${i + 1} comes in ${Math.abs(Math.round((orbit * 180) / Math.PI))}° ${orbit > 0 ? 'left' : 'right'} of straight so the bodies stay apart`)
          }
        }
        // Fork (fight-polish): an armed guard's free arm swings out of the attacking weapon's way at the impact.
        const guardWeapon = def.idle && def.dims.mocap?.rig.skin && (o === 'block' || o === 'parry') ? armedSide(def) : null
        const aw = weaponOf(atk, imp.effector)
        if (guardWeapon && aw && blockEvents.get(i)) {
          const a = { joints: withOffsets(kf.joints, result.pitch), clip: kClip, position: { x: result.root.x, y: result.rootY + result.lift, z: result.root.z }, heading: result.heading }
          const free = freeArmSwing(atk, aw, a, def, guardWeapon, defAt(T), armFix, hd)
          if (free) armFix = { ...armFix, ...free }
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
        const kf = preset.keyframes[j]!
        // Mocap bots (fork): a clip key sits along the clip's own root travel from the impact's.
        let pos: XZ
        if (kf.travel && p.travel) {
          const w = toWorld({ x: kf.travel.x - p.travel.x, y: 0, z: kf.travel.z - p.travel.z }, { x: p.root.x, y: 0, z: p.root.z }, p.heading, 1)
          pos = { x: w.x, z: w.z }
        }
        else pos = add(p.base, fwdOf(p.heading), (kf.move?.forward ?? 0) * atk.k)
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
      return { startT, times, warp, events, avoidIdx, defAt, place, owner, kfRoot, kfLift, stepDist, notes, opens }
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
        if (strike) {
          // A bot's overlay ramps in over RAMP_IN to the impact and out over RAMP_OUT after it, the clip running under it.
          const d = kf.t - impacts[q]!.t
          const w = d < 0 ? 1 + d / RAMP_IN : 1 - d / RAMP_OUT
          if (w > 1e-9) joints = withOffsets(joints, Object.fromEntries(Object.entries(p.place[q]!.pitch).map(([key, v]) => [key, v * Math.min(1, w)])))
        }
        else if (j === kq || (j === kq - 1 && !kIdx.includes(j))) joints = withOffsets(joints, p.place[q]!.pitch)
      }
      const t = p.startT + p.warp(kf.t)
      const pos = p.kfRoot(j)
      if (atk.idle) {
        // Mocap bots (fork): a knee's shin and foot stay out of the defender's legs (kneeTuck) on its clip's keys.
        const e = impacts[i]!.effector
        const dst = p.defAt(t)
        const tuck = strike ? kneeTuck(atk, e, joints, stateOf(kf.clip), { x: pos.x, y: groundY(atk.floor, joints, p.kfLift(j), stateOf(kf.clip)), z: pos.z }, pl.heading, def, dst.joints, dst.clip, { x: dst.pos.x, y: dst.y, z: dst.pos.z }, hd) : 0
        if (tuck > 0) joints = withOffsets(joints, { [e]: tuck })
        // ... and (clips and keyframes) its other leg out of the defender's legs (legSplay; an impact's is placed with it).
        if (!kIdx.includes(j)) joints = withOffsets(joints, legSplay(atk, e, joints, stateOf(kf.clip), { x: pos.x, y: groundY(atk.floor, joints, p.kfLift(j), stateOf(kf.clip)), z: pos.z }, pl.heading, def, dst.joints, dst.clip, { x: dst.pos.x, y: dst.y, z: dst.pos.z }, hd))
      }
      let gait: GaitId = 'stand'
      if (j === 0) {
        const lastMark = atk.marks[atk.marks.length - 1]!
        const d = flat(sub(pos, { x: lastMark.position.x, z: lastMark.position.z }))
        // Fork: a step-in (≤ MAX_STEP_SPEED) walks; a jog's flight lifted both feet off the floor.
        gait = d < 0.05 ? 'stand' : 'walk'
        // Mocap bots (fork): the idle plays on until the step-in (or a short settle) before the beat.
        if (atk.idle && lastMark.clip?.id === atk.idle) {
          const lead = gait === 'walk' ? clamp(d / BOT_STEP, BOT_LEAD, t - lastMark.time) : BOT_LEAD
          const at = t - lead
          if (at > lastMark.time + 1e-3) addMark(atk, at, { x: lastMark.position.x, z: lastMark.position.z }, lastMark.position.y, 'stand', {}, lastMark.arriveHeading, { id: atk.idle, at }, true)
          else if (!lastMark.posedMove) {
            // Just after a walk into the idle: the idle is posed half a frame on, so the move crossfades from it (on the floor line).
            const hold = lastMark.time + Math.min(0.5 / fps, (t - lastMark.time) / 2)
            addMark(atk, hold, { x: lastMark.position.x, z: lastMark.position.z }, lastMark.position.y, 'stand', {}, lastMark.arriveHeading, { id: atk.idle, at: hold }, true)
          }
          // A keyframe move crossfades from the idle into its first pose where the bot stands, then steps in (the floor holds through both).
          if (gait === 'walk' && !kf.clip && t - at > 2 / fps) addMark(atk, at + Math.min(BOT_XFADE, (t - at) / 2), { x: lastMark.position.x, z: lastMark.position.z }, groundY(atk.floor, joints, p.kfLift(j)), 'stand', joints, lastMark.arriveHeading, undefined, true)
        }
      }
      addMark(atk, t, pos, groundY(atk.floor, joints, p.kfLift(j), stateOf(kf.clip)), gait, joints, pl.heading, kf.clip, !!atk.idle && gait !== 'walk')
    }
    const atkEnd = p.startT + preset.duration
    atk.spot = p.kfRoot(kfs.length - 1)
    atk.heading = p.place[p.place.length - 1]!.heading

    // 5b. Defender marks: defenses / reactions, with sidesteps so avoided blows clear the head.
    const clearance: number[] = impacts.map(() => NaN)
    const effectorAt = (i: number): V3 => {
      const kf = kfs[kIdx[i]!]!
      const joints = withOffsets(kf.joints, p.place[i]!.pitch)
      return effectorWorld(atk, joints, p.place[i]!.root, p.place[i]!.rootY + p.place[i]!.lift, p.place[i]!.heading, impacts[i]!.effector, 'strike', stateOf(kf.clip))
    }
    const headClear = (i: number, extra: XZ): number => {
      const st = p.defAt(p.times[i]!)
      const head = toWorld(poseEffectors(def.dims, st.joints, st.clip).head, { x: st.pos.x + extra.x, y: st.y, z: st.pos.z + extra.z }, hd, def.scale)
      return dist3(effectorAt(i), head) - def.dims.headR * def.scale
    }
    // Body / legs blows (fork, contact.ts): an avoided blow clears the whole body (2 cm over the
    // minimum for the body model), so the defender steps back from it, or aside.
    const bodyClear = (i: number, extra: XZ): number => {
      const st = p.defAt(p.times[i]!)
      return bodyClearance(def.torso, def.dims, def.build, def.scale, st.joints, { x: st.pos.x + extra.x, y: st.y, z: st.pos.z + extra.z }, hd, effectorAt(i), st.clip)
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
    p.events.forEach((ev, e) => {
      truncate(def, ev.start)
      // Mocap bots (fork): the idle plays on until a moment before the beat's first clip.
      const before = def.marks[def.marks.length - 1]!
      if (def.idle && e === 0 && before.clip?.id === def.idle && ev.start - BOT_LEAD > before.time + 1e-3) {
        const at = ev.start - BOT_LEAD
        // Mocap bots (fork): a guard in a coming blow's way opens from GUARD_LEAD before it, all the way by GUARD_FULL before.
        let joints: Joints = {}
        for (const o of p.opens) {
          const from = o.T - GUARD_LEAD
          if (from >= at || Object.keys(o.joints).length === 0) continue
          if (from > before.time + 1e-3) addMark(def, from, { x: before.position.x, z: before.position.z }, before.position.y, 'stand', {}, before.arriveHeading, { id: def.idle, at: from }, true)
          const f = clamp((at - from) / (GUARD_LEAD - GUARD_FULL), 0, 1)
          joints = withOffsets(joints, Object.fromEntries(Object.entries(o.joints).map(([k, v]) => [k, v * f])))
        }
        addMark(def, at, { x: before.position.x, z: before.position.z }, before.position.y, 'stand', joints, before.arriveHeading, { id: def.idle, at }, true)
      }
      else if (def.idle && e === 0 && before.clip?.id === def.idle && !before.posedMove && ev.start > before.time + 1e-3) {
        // Just after a walk into the idle: the idle is posed half a frame on, so the clip crossfades from it (on the floor line).
        const at = before.time + Math.min(0.5 / fps, (ev.start - before.time) / 2)
        addMark(def, at, { x: before.position.x, z: before.position.z }, before.position.y, 'stand', {}, before.arriveHeading, { id: def.idle, at }, true)
      }
      const ts = new Set<number>([ev.start])
      if (ev.motion) {
        // Keyframe times in absolute time: the inverse of the event's time map.
        const toAbs = piecewise(ev.anchors.map(([a, l]): [number, number] => [l, a]))
        for (const kf of ev.motion.keyframes) ts.add(kf.t === 0 ? ev.start : toAbs(kf.t))
      }
      if (ev.clip) {
        // A clip run: its time map's anchors and a mark every DEF_STEP.
        for (const [a] of ev.anchors) ts.add(a)
        for (let k = 1; ev.start + k * DEF_STEP < ev.end; k++) ts.add(ev.start + k * DEF_STEP)
      }
      for (const t of ev.times) ts.add(t)
      for (const t of p.times) if (t >= ev.start) ts.add(t)
      // A bot's clip crossfades into the next one over BOT_XFADE.
      const next = p.events[e + 1]
      const end = def.idle && next && ev.end >= next.start - 1e-9 ? Math.max(ev.start, next.start - BOT_XFADE) : ev.end
      if (end < ev.end - 1e-9) ts.add(end)
      const sorted = [...ts].filter((t) => t >= ev.start - 1e-9 && t <= end + 1e-9).sort((a, b) => a - b)
      for (const t of sorted) {
        const pose = eventPose(ev, t, guard)
        addMark(def, t, add(ev.base, pose.off), groundY(def.floor, pose.joints, 0, pose.clip), 'stand', pose.joints, hd, markOf(pose.clip), !!def.idle)
      }
      // Mocap bots (fork): between two clips the idle plays on (each crossfades in and out over BOT_XFADE).
      if (def.idle && next && next.start - end > 2 * BOT_XFADE + 1e-3) {
        const after = def.marks[def.marks.length - 1]!
        for (const at of [end + BOT_XFADE, next.start - BOT_XFADE]) addMark(def, at, { x: after.position.x, z: after.position.z }, def.floor.y, 'stand', {}, hd, { id: def.idle, at }, true)
      }
    })
    // Mocap bots (fork): after each blow the bodies are kept apart (separate): before the next blow the push eases out again.
    if (!shotBeat && atk.dims.mocap?.rig.skin && def.dims.mocap?.rig.skin) {
      const who = beat.attacker === 0 ? 'B' : 'A'
      let jolts = 0
      p.times.forEach((T, i) => {
        const away = unit(sub(p.defAt(T).pos, p.place[i]!.root))
        const next = p.times[i + 1]
        if (next !== undefined) {
          if (next - T > 2 * SEP_BACK) {
            // Fork (fight-polish): a held weapon in the other body swings out first (a push only slides a shaft along itself).
            const sw = F.some((f) => f.held.length > 0) ? swingWeapons(F, T, next - 2 * SEP_BACK, fps, next - SEP_BACK) : null
            beatWarnings.push(...(sw?.notes ?? []).map((n) => `${label}: ${n} after blow ${i + 1}`))
            jolts += separate(F, atk, def, T, next - 2 * SEP_BACK, away, fps, next - SEP_BACK, sw?.states).push
          }
          return
        }
        const last = def.marks[def.marks.length - 1]!
        const sw = F.some((f) => f.held.length > 0) ? swingWeapons(F, T, Math.min(T + SEP_WINDOW, Math.max(atkEnd, last.time)), fps) : null
        beatWarnings.push(...(sw?.notes ?? []).map((n) => `${label}: ${n} after blow ${i + 1}`))
        const s = separate(F, atk, def, T, Math.min(T + SEP_WINDOW, Math.max(atkEnd, last.time)), away, fps, Infinity, sw?.states)
        if (s.push > 0) beatWarnings.push(`${label}: ${who} goes ${(s.push * 100).toFixed(0)} cm further back after the last blow${s.both ? `, and ${who === 'A' ? 'B' : 'A'} stops ${(s.push * 100).toFixed(0)} cm short,` : ''} so the bodies stay apart`)
      })
      if (jolts > 0) beatWarnings.push(`${label}: ${who} rocks back ${(jolts * 100).toFixed(0)} cm between blows so the bodies stay apart`)
    }
    const lastDef = def.marks[def.marks.length - 1]!
    def.spot = { x: lastDef.position.x, z: lastDef.position.z }
    let defEnd = lastDef.time
    const koed = outcomes.includes('ko')
    const downed = physics.some((ph, i) => ph.result === 'knockdown' && (outcomes[i] === 'hit' || outcomes[i] === 'ko'))
    // A knockdown on the last beat stays down, like a KO (fork: it used to walk from the floor back to guard).
    if (koed || (downed && n === fight.beats.length - 1)) def.down = true
    else if (downed) {
      const up = def.idle ? getUpClip() : null
      if (up) {
        // Mocap bots (fork): the get-up clip from where the fall left the body, on its own root travel.
        const ev = clipEvent(def, { id: up, mirror: false }, defEnd + BOT_GETUP, 0, 0, mocapClip(up)!.duration, def.spot, hd)
        for (let k = 0; ; k++) {
          const t = Math.min(ev.end, ev.start + k * DEF_STEP)
          const pose = eventPose(ev, t, guard)
          addMark(def, t, add(ev.base, pose.off), groundY(def.floor, pose.joints, 0, pose.clip), 'stand', pose.joints, hd, markOf(pose.clip), true)
          if (t >= ev.end) break
        }
        def.spot = add(ev.base, ev.root(ev.end).off)
        defEnd = ev.end
      }
      else {
        const getUp = BY_ID.get(REACTIONS.getUp)!
        const t0 = defEnd + 0.2
        for (const kf of getUp.keyframes) {
          addMark(def, t0 + kf.t, def.spot, groundY(def.floor, kf.joints), 'stand', kf.joints, hd)
        }
        defEnd = t0 + getUp.duration
      }
    }

    // 7. Rest: back to guard distance, facing each other (after a shot, both hold their ground).
    const recoveryEnd = Math.max(atkEnd, defEnd)
    let restT = recoveryEnd
    if (!def.down && !shotBeat) {
      const M = { x: (atk.spot.x + def.spot.x) / 2, z: (atk.spot.z + def.spot.z) / 2 }
      const dir = unit(sub(def.spot, atk.spot), fwdOf(atk.heading))
      // Mocap bots (fork): one done well before the other (a get-up) crossfades into its idle and holds it where it stands; the other comes to guard distance of it.
      const waits = (f: Fighter, end: number): boolean => !!f.idle && recoveryEnd - end > 2 * BOT_XFADE + 1e-3
      const hold = (f: Fighter, end: number): void => {
        const last = f.marks[f.marks.length - 1]!
        const at = Math.max(last.time, end) + BOT_XFADE
        addMark(f, at, f.spot, groundY(f.floor, {}, 0, stateOf({ id: f.idle!, at })), 'stand', {}, last.arriveHeading, { id: f.idle!, at }, true)
      }
      const lay = (gap: number): { aRest: XZ; dRest: XZ } => {
        let aRest = add(M, dir, -gap / 2)
        let dRest = add(M, dir, gap / 2)
        if (waits(atk, atkEnd)) {
          hold(atk, atkEnd)
          aRest = { ...atk.spot }
          dRest = add(atk.spot, dir, gap)
        }
        else if (waits(def, defEnd)) {
          hold(def, defEnd)
          dRest = { ...def.spot }
          aRest = add(def.spot, dir, -gap)
        }
        const moveA = flat(sub(aRest, atk.spot))
        const moveD = flat(sub(dRest, def.spot))
        restT = recoveryEnd + clamp(Math.max(moveA, moveD) / 1.5, 0.25, 1.5)
        const ra = restOf(atk, restT)
        const rd = restOf(def, restT)
        addMark(atk, restT, aRest, groundY(atk.floor, ra.joints, 0, stateOf(ra.clip)), moveA > 0.05 ? 'walk' : 'stand', ra.joints, facing(aRest, dRest), ra.clip, !!atk.idle && moveA <= 0.05)
        addMark(def, restT, dRest, groundY(def.floor, rd.joints, 0, stateOf(rd.clip)), moveD > 0.05 ? 'walk' : 'stand', rd.joints, facing(dRest, aRest), rd.clip, !!def.idle && moveD <= 0.05)
        return { aRest, dRest }
      }
      // Fork (fight-polish): bots with a weapon held out rest far enough apart (restGap); walking there, the weapon must not sweep through the other
      // (a spear lowered for the walk swings up into the idle): laid, looked at, and laid again further apart by as much as it goes in.
      const armed = F.every((f) => f.dims.mocap?.rig.skin) && F.some((f) => f.idle && f.held.length > 0)
      let gap = armed ? restGap(atk, def, recoveryEnd) : GUARD_DISTANCE
      const keep = [atk.marks.slice(), def.marks.slice()]
      let { aRest, dRest } = lay(gap)
      for (let k = 0; armed && k < REST_TRIES; k++) {
        const deep = restDepth(F, Math.max(recoveryEnd, restT - REST_LOOK), restT + 2 * BOT_XFADE, fps)
        if (deep <= SEP_TOL) break
        atk.marks.splice(0, atk.marks.length, ...keep[0]!)
        def.marks.splice(0, def.marks.length, ...keep[1]!)
        gap += deep + REST_CLEAR
        ;({ aRest, dRest } = lay(gap))
      }
      atk.spot = aRest
      def.spot = dRest
      atk.heading = facing(aRest, dRest)
      def.heading = facing(dRest, aRest)
    }
    else {
      restT = recoveryEnd + 0.25
      const ra = restOf(atk, restT)
      addMark(atk, restT, atk.spot, groundY(atk.floor, ra.joints, 0, stateOf(ra.clip)), 'stand', ra.joints, facing(atk.spot, def.spot), ra.clip, !!atk.idle)
      // Mocap bots (fork): a standing defender settles back into its idle too.
      if (def.idle && !def.down) {
        const rd = restOf(def, Math.max(restT, defEnd + BOT_LEAD))
        addMark(def, rd.clip!.at, def.spot, groundY(def.floor, rd.joints, 0, stateOf(rd.clip)), 'stand', rd.joints, facing(def.spot, atk.spot), rd.clip, true)
      }
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
      plays: preset.id,
      ...(atk.idle ? { effectors: impacts.map((imp) => imp.effector) } : {})
    })
    impacts.forEach((imp, i) =>
      hits.push({ beat: beats.length - 1, i, time: p.times[i]!, attacker: beat.attacker, zone: beat.target, effector: imp.effector, outcome: outcomes[i]!, shotRange: atk.shotRange })
    )
  }

  // Measure every landed blow through the real evaluator.
  const tracks: [FightMarkSpec[], FightMarkSpec[]] = [F[0].marks, F[1].marks]
  const endT = Math.max(...tracks.map((t) => t[t.length - 1]?.time ?? 0))
  // Mocap bots (fork): a fighter still standing holds its idle to the shot's end (after the fight's end, so endT is the fight's).
  for (const f of F) {
    const last = f.marks[f.marks.length - 1]
    if (!f.idle || f.down || !last || last.clip?.id !== f.idle || shot.duration <= last.time + 0.05) continue
    addMark(f, shot.duration, { x: last.position.x, z: last.position.z }, last.position.y, 'stand', {}, last.arriveHeading, { id: f.idle, at: shot.duration }, true)
  }
  const ev = fightEvaluator(F, Math.max(shot.duration, endT), fps)
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
      const fx = poseEffectors(f.dims, e.joints, e.clip)
      const body = [fx.head, fx.chest, fx.pelvis, fx.footL, fx.footR].map((p) => {
        const w = toWorld(p, e.position, e.heading, f.scale)
        return { x: w.x, z: w.z }
      })
      out[q]!.push({ t, root: { x: e.position.x, z: e.position.z }, body })
    })
  }
  return out
}

/** The evaluator over the fighters' marks so far, their held weapons in hand (for the grip poses). */
function fightEvaluator(F: [Fighter, Fighter], duration: number, fps: number): ShotEvaluator {
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
    duration,
    fps,
    aspect: '16:9',
    blockingTakeId: 'take',
    camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] }
  } as unknown as Shot
  return new ShotEvaluator(scene, shotDoc)
}

/**
 * Mocap bots (fork, mocap/surface.ts): how deep two bots' skins sit in
 * each other (m; 0 apart): where a bone's box (by its support points) meets
 * one of the other body's (within BONE_PAD), each body's skin vertices
 * there against the other's skin on the bones that meet (and their
 * neighbours).
 */
/** Where a body is and how it stands: an evaluated state, or a planned pose. */
type Placed = Pick<EntityState, 'joints' | 'clip' | 'position' | 'heading'>

function bodyOverlap(a: Fighter, sa: Placed, b: Fighter, sb: Placed, evaluated = false, exempt?: Fighter): number {
  // Each bone's box, by its support points (its outermost skin).
  const A = boneBoxes(a, sa, evaluated)
  const B = boneBoxes(b, sb, evaluated)
  // Fork (fight-polish): each fighter's weapons in the other's skin too (but `exempt`'s: a hit's own impact frame).
  const wa = a.held.length > 0 && a !== exempt ? weaponInto(weaponsWorld(a, sa, evaluated), b, sb, B, evaluated) : 0
  const wb = b.held.length > 0 && b !== exempt ? weaponInto(weaponsWorld(b, sb, evaluated), a, sa, A, evaluated) : 0
  return Math.max(wa, wb, skinsOverlap(a, sa, A, b, sb, B))
}

/** How deep two bots' skins sit in each other (bodyOverlap), from their bone boxes. */
function skinsOverlap(a: Fighter, sa: Placed, A: ReturnType<typeof boneBoxes>, b: Fighter, sb: Placed, B: ReturnType<typeof boneBoxes>): number {
  // The bones whose boxes meet one of the other body's, and where they meet.
  const meet: { lo: V3; hi: V3 }[] = []
  const bonesA = new Set<number>()
  const bonesB = new Set<number>()
  for (const [ia, x] of A.box)
    for (const [ib, y] of B.box) {
      const lo = { x: Math.max(x.lo.x, y.lo.x) - BONE_PAD, y: Math.max(x.lo.y, y.lo.y) - BONE_PAD, z: Math.max(x.lo.z, y.lo.z) - BONE_PAD }
      const hi = { x: Math.min(x.hi.x, y.hi.x) + BONE_PAD, y: Math.min(x.hi.y, y.hi.y) + BONE_PAD, z: Math.min(x.hi.z, y.hi.z) + BONE_PAD }
      if (lo.x > hi.x || lo.y > hi.y || lo.z > hi.z) continue
      meet.push({ lo, hi })
      bonesA.add(ia)
      bonesB.add(ib)
    }
  if (meet.length === 0) return 0
  const within = (q: V3): boolean => meet.some(({ lo, hi }) => q.x >= lo.x && q.x <= hi.x && q.y >= lo.y && q.y <= hi.y && q.z >= lo.z && q.z <= hi.z)
  // Each body's skin on those bones: its vertices where they meet sink into the other's.
  const skin = (f: Fighter, s: Placed, P: typeof A, bones: Set<number>): { p: V3[]; tri: number[] } | null => {
    const own = boneSkin(f.dims.mocap!, P.pose, bones)
    return own && own.tri.length > 0 ? { p: own.p.map((x) => toWorld(x, s.position, s.heading, f.scale)), tri: own.tri } : null
  }
  // With their neighbours (parent and children), so the cut skin's open edges lie away from where they meet.
  const SA = skin(a, sa, A, grownBones(a, bonesA))
  const SB = skin(b, sb, B, grownBones(b, bonesB))
  if (!SA || !SB) return 0
  const into = (P: { p: V3[] }, Q: { p: V3[]; tri: number[] }): number => {
    const pts = P.p.filter(within)
    return pts.length > 0 ? meshDepth(pts, skinMesh(Q.p, Q.tri)) : 0
  }
  return Math.max(0, into(SA, SB), into(SB, SA))
}

/**
 * Mocap bots (fork, fight-polish; weapon-shape.ts): a fighter's held weapons
 * (or `only` one) as capsules, world axis points and radius, posed as
 * contactLocal poses them. An evaluated state's own pose (not a `swung` one
 * tried on it) poses each weapon once (separate pushes it about).
 */
function weaponsWorld(f: Fighter, s: Placed, evaluated: boolean, only?: HeldWeapon, swung = false): WeaponSamples[] {
  const j = evaluated || s.clip ? s.joints : holdJoints(f.dims, s.joints, f.held)
  const which = f.held.filter((h) => !only || h === only)
  const at = evaluated && !swung ? localOf(f, s) : null
  if (!at) return which.flatMap((h) => heldWeaponSamples(f.dims, j, h.hand, h.spec, h.scale, s.clip, { position: s.position, heading: s.heading, scale: f.scale }))
  const held = (at.held ??= new Map())
  const local = which.flatMap((h): WeaponSamples[] => {
    let x = held.get(h)
    if (!x) held.set(h, (x = heldWeaponSamples(f.dims, j, h.hand, h.spec, h.scale, s.clip)))
    return x
  })
  return local.map((w) => ({ p: w.p.map((q) => toWorld(q, s.position, s.heading, f.scale)), r: w.r * f.scale }))
}

/**
 * An evaluated state's entity-local work, by its joints object (fresh from
 * the evaluator and never changed): separate tries pushes that move only its
 * root, so the pose, its support points and its weapons are posed once.
 */
interface Local {
  f: Fighter
  clip: ClipState | undefined
  pose: MocapPose
  support: { p: V3; bone: number }[]
  held?: Map<HeldWeapon, WeaponSamples[]>
  skins?: Map<string, SkinMesh | null>
  /** Its bone boxes where it was last placed. */
  boxes?: { at: V3; heading: number; box: Map<number, { lo: V3; hi: V3 }> }
}
const LOCAL = new WeakMap<object, Local>()
function localOf(f: Fighter, s: Placed): Local {
  const known = s.joints ? LOCAL.get(s.joints) : undefined
  if (known && known.f === f && known.clip === s.clip) return known
  const pose = fighterPose(f.dims.mocap!, s.joints, s.clip)
  const out = { f, clip: s.clip, pose, support: supportPoints(f.dims.mocap!, pose) }
  if (s.joints) LOCAL.set(s.joints, out)
  return out
}

/** Each bone's box by its support points (world), for a placed bot (an evaluated one's posed once: localOf). */
function boneBoxes(f: Fighter, s: Placed, evaluated = false): { pose: MocapPose; box: Map<number, { lo: V3; hi: V3 }> } {
  const at = evaluated ? localOf(f, s) : null
  if (at?.boxes && at.boxes.heading === s.heading && at.boxes.at.x === s.position.x && at.boxes.at.y === s.position.y && at.boxes.at.z === s.position.z) return { pose: at.pose, box: at.boxes.box }
  const pose = at ? at.pose : fighterPose(f.dims.mocap!, s.joints, s.clip)
  const box = new Map<number, { lo: V3; hi: V3 }>()
  for (const x of at ? at.support : supportPoints(f.dims.mocap!, pose)) {
    const p = toWorld(x.p, s.position, s.heading, f.scale)
    const c = box.get(x.bone)
    if (!c) box.set(x.bone, { lo: { ...p }, hi: { ...p } })
    else {
      c.lo.x = Math.min(c.lo.x, p.x)
      c.lo.y = Math.min(c.lo.y, p.y)
      c.lo.z = Math.min(c.lo.z, p.z)
      c.hi.x = Math.max(c.hi.x, p.x)
      c.hi.y = Math.max(c.hi.y, p.y)
      c.hi.z = Math.max(c.hi.z, p.z)
    }
  }
  if (at) at.boxes = { at: { ...s.position }, heading: s.heading, box }
  return { pose, box }
}

/** A bone set with its neighbours (parent and children), so a cut skin's open edges lie away from where it is met. */
function grownBones(f: Fighter, bones: Set<number>): Set<number> {
  const out = new Set(bones)
  f.dims.mocap!.rig.parent.forEach((p, i) => {
    if (bones.has(i) && p >= 0) out.add(p)
    if (p >= 0 && bones.has(p)) out.add(i)
  })
  return out
}

/**
 * How deep weapon capsules sit in a bot's skin (m; 0 when apart): its skin on
 * the bones whose boxes meet a capsule's (with their neighbours); an evaluated
 * state's whole skin, once in its own frame (localOf). Bones in `skip` (a
 * holder's arm, for its own weapon) are left out.
 */
function weaponInto(pcs: WeaponSamples[], b: Fighter, sb: Placed, B = boneBoxes(b, sb), evaluated = false, skip?: Set<number>): number {
  if (pcs.length === 0) return 0
  const bones = new Set<number>()
  for (const w of pcs) {
    const lo = { x: Infinity, y: Infinity, z: Infinity }
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const q of w.p) {
      lo.x = Math.min(lo.x, q.x)
      lo.y = Math.min(lo.y, q.y)
      lo.z = Math.min(lo.z, q.z)
      hi.x = Math.max(hi.x, q.x)
      hi.y = Math.max(hi.y, q.y)
      hi.z = Math.max(hi.z, q.z)
    }
    const pad = w.r + BONE_PAD
    for (const [i, x] of B.box) if (!skip?.has(i) && x.lo.x <= hi.x + pad && x.hi.x >= lo.x - pad && x.lo.y <= hi.y + pad && x.hi.y >= lo.y - pad && x.lo.z <= hi.z + pad && x.hi.z >= lo.z - pad) bones.add(i)
  }
  if (bones.size === 0) return 0
  // An axis point within its radius of the skin lies within that (and BONE_PAD) of one of those boxes: none there, none in (and no skin to build).
  const hit = new Set([...bones].filter((i) => {
    const x = B.box.get(i)!
    return pcs.some((w) => w.p.some((q) => q.x >= x.lo.x - w.r - BONE_PAD && q.x <= x.hi.x + w.r + BONE_PAD && q.y >= x.lo.y - w.r - BONE_PAD && q.y <= x.hi.y + w.r + BONE_PAD && q.z >= x.lo.z - w.r - BONE_PAD && q.z <= x.hi.z + w.r + BONE_PAD))
  }))
  if (hit.size === 0) return 0
  if (evaluated) {
    // Its skin on those bones and their neighbours (but `skip`) in the state's own frame, once per such set (separate's pushes and
    // swingWeapons' swings ask again and again); the capsules brought into it (toWorld's inverse).
    const at = localOf(b, sb)
    const near = grownBones(b, hit)
    for (const i of skip ?? []) near.delete(i)
    const key = [...near].sort((x, y) => x - y).join(',')
    let mesh = (at.skins ??= new Map()).get(key)
    if (mesh === undefined) {
      const own = near.size > 0 ? boneSkin(b.dims.mocap!, at.pose, near) : null
      mesh = own && own.tri.length > 0 ? skinMesh(own.p, own.tri) : null
      at.skins.set(key, mesh)
    }
    if (!mesh) return 0
    const c = Math.cos(sb.heading)
    const sn = Math.sin(sb.heading)
    const local = (q: V3): V3 => {
      const x = q.x - sb.position.x
      const z = q.z - sb.position.z
      return { x: (x * c - z * sn) / b.scale, y: (q.y - sb.position.y) / b.scale, z: (x * sn + z * c) / b.scale }
    }
    const m = mesh
    return Math.max(0, ...pcs.map((w) => meshDepth(w.p.map(local), m) * b.scale + w.r))
  }
  const grown = grownBones(b, bones)
  for (const i of skip ?? []) grown.delete(i)
  const own = boneSkin(b.dims.mocap!, B.pose, grown)
  if (!own || own.tri.length === 0) return 0
  const mesh = skinMesh(own.p.map((x) => toWorld(x, sb.position, sb.heading, b.scale)), own.tri)
  return Math.max(0, ...pcs.map((w) => meshDepth(w.p, mesh) + w.r))
}

/**
 * Mocap bots (fork, fight-polish): an armed guard. The guard arm's overlay
 * (shoulder pitch and abduction, elbow) that puts its weapon's guard point
 * (contactLocal 'guard': mid-blade, the shield's face) at `C` (world), the
 * blade or shaft across the line of attack (`toward`, the unit way to the
 * attacker), a shield's face toward it: least squares (Levenberg–Marquardt)
 * from `warm`, each channel within ±GUARD_SWING.
 */
function armedGuard(def: Fighter, joints: Joints, clip: ClipState | undefined, side: 'handL' | 'handR', pos: V3, heading: number, C: V3, toward: XZ, warm: Joints = {}): Joints {
  // The guards solved for this aim pose (by its joints object), and its body by part.
  let memos = GUARDS.get(joints)
  if (!memos) GUARDS.set(joints, (memos = []))
  let memo = memos.find((x) => x.def === def && x.clip === clip && x.side === side && x.pos.x === pos.x && x.pos.y === pos.y && x.pos.z === pos.z && x.heading === heading)
  if (!memo) memos.push((memo = { def, clip, side, pos, heading, solved: [] }))
  const known = memo.solved.find((x) => Math.hypot(x.C.x - C.x, x.C.y - C.y, x.C.z - C.z) <= GUARD_REUSE && x.toward.x * toward.x + x.toward.z * toward.z >= GUARD_REUSE_DOT)
  if (known) return known.out
  const w = weaponOf(def, side)!
  const s = side === 'handL' ? 'L' : 'R'
  const keys = [`shoulder${s}X`, `shoulder${s}Z`, `elbow${s}`]
  const shield = w.spec.kind === 'shield'
  const from = shield ? w.spec.tip : w.spec.grip
  const to = shield ? { x: w.spec.tip.x + w.spec.aim.x, y: w.spec.tip.y + w.spec.aim.y, z: w.spec.tip.z + w.spec.aim.z } : w.spec.tip
  const c = Math.cos(heading)
  const sn = Math.sin(heading)
  // The way to the attacker in the defender's own frame (toWorld's inverse turn).
  const tl = { x: toward.x * c - toward.z * sn, z: toward.x * sn + toward.z * c }
  // Its own body but the guard arm (and a two-handed grip's other forearm and hand), as the overlay leaves it, by part (built when first needed).
  const m = def.dims.mocap!
  let pose: MocapPose | undefined
  const skip = holdingBones(w)
  // A part of it: its bones' boxes (support points, world), and its skin as a mesh (built when a weapon comes near those).
  let support: { p: V3; bone: number }[] | undefined
  const partOf = (bones: number[]): GuardPart => {
    support ??= supportPoints(m, (pose ??= fighterPose(m, joints, clip))).map((x) => ({ p: toWorld(x.p, pos, heading, def.scale), bone: x.bone }))
    const set = new Set(bones)
    const box = new Map<number, { lo: V3; hi: V3 }>()
    for (const { p, bone } of support) {
      if (!set.has(bone)) continue
      const c = box.get(bone)
      if (!c) box.set(bone, { lo: { ...p }, hi: { ...p } })
      else {
        c.lo = { x: Math.min(c.lo.x, p.x), y: Math.min(c.lo.y, p.y), z: Math.min(c.lo.z, p.z) }
        c.hi = { x: Math.max(c.hi.x, p.x), y: Math.max(c.hi.y, p.y), z: Math.max(c.hi.z, p.z) }
      }
    }
    return { bones, boxes: [...box.values()] }
  }
  const meshOf = (part: GuardPart): SkinMesh | null => {
    if (part.mesh !== undefined) return part.mesh
    const own = part.bones.length > 0 ? boneSkin(m, (pose ??= fighterPose(m, joints, clip)), new Set(part.bones)) : null
    return (part.mesh = own && own.tri.length > 0 ? skinMesh(own.p.map((q) => toWorld(q, pos, heading, def.scale)), own.tri) : null)
  }
  // The weapon's model points held in a pose (heldPointLocal's, one hand frame for all of them; a bot off its clip holds it as contactLocal does).
  const all = weaponSamples(w.spec.assetId)
  const stride = Math.max(2, Math.ceil(all.reduce((n, x) => n + x.p.length, 0) / GUARD_POINTS))
  const pieces = all.map((x) => ({ p: x.p.filter((_, k) => k % stride === 0 || k === x.p.length - 1), r: x.r * w.scale * def.scale }))
  const holding = (j: Joints): ((q: V3) => V3) => {
    const hj = clip ? j : holdJoints(def.dims, j, def.held)
    const f = handFrame(def.dims, hj, w.hand, clip)
    // held-weapons: turned in the grip by the clip's hold turn (weapon-hold.ts); the guard keeps it off its holder itself.
    const r = heldRotation(def.dims, hj, w.hand, w.spec, w.scale, clip, f, false)
    const g = w.spec.grip
    return (q) => {
      const x = (q.x - g.x) * w.scale
      const y = (q.y - g.y) * w.scale
      const z = (q.z - g.z) * w.scale
      return { x: f.p.x + r[0]! * x + r[1]! * y + r[2]! * z, y: f.p.y + r[3]! * x + r[4]! * y + r[5]! * z, z: f.p.z + r[6]! * x + r[7]! * y + r[8]! * z }
    }
  }
  /** How far the weapon (every other axis point of each capsule, or sparser: GUARD_POINTS) sits in a mesh past GUARD_SELF clear. */
  const placed = (j: Joints, at = holding(j)): WeaponSamples[] => pieces.map((x) => ({ p: x.p.map((q) => toWorld(at(q), pos, heading, def.scale)), r: x.r }))
  // (None of its points within its radius, GUARD_SELF and BONE_PAD of the part's boxes: clear of it, its skin unposed.)
  const depthIn = (part: GuardPart, pcs: WeaponSamples[]): number => {
    const pad = GUARD_SELF + BONE_PAD
    if (!pcs.some((x) => x.p.some((q) => part.boxes.some((c) => q.x >= c.lo.x - x.r - pad && q.x <= c.hi.x + x.r + pad && q.y >= c.lo.y - x.r - pad && q.y <= c.hi.y + x.r + pad && q.z >= c.lo.z - x.r - pad && q.z <= c.hi.z + x.r + pad)))) return -Infinity
    const mesh = meshOf(part)
    if (!mesh) return -Infinity
    let deep = -Infinity
    for (const x of pcs) deep = Math.max(deep, meshDepth(x.p, mesh) + x.r + GUARD_SELF)
    return deep
  }
  // Only what the guard adds: the parts its idle already holds the weapon in (a clip-and-hold mismatch) may keep it that deep; the rest stay clear.
  const at = memo
  const split = (): NonNullable<GuardMemo['parts']> => {
    if (at.parts) return at.parts
    const groups = BODY_PARTS.map((g) => g.map((b) => BONE_INDEX[b]).filter((b) => !skip.has(b)))
    const rest = placed(joints)
    const idle = groups.map((g) => depthIn(partOf(g), rest))
    const held = groups.filter((_, k) => idle[k]! > 0)
    at.parts = { strict: partOf(groups.filter((_, k) => idle[k]! <= 0).flat()), held: partOf(held.flat()), allow: Math.max(0, ...idle) }
    return at.parts
  }
  const inside = (j: Joints, at = holding(j)): number => {
    const { strict, held, allow } = split()
    const pcs = placed(j, at)
    return Math.max(0, depthIn(strict, pcs), depthIn(held, pcs) - allow)
  }
  const posed = (p: number[], f = 1): Joints => withOffsets(joints, { [keys[0]!]: p[0]! * f, [keys[1]!]: p[1]! * f, [keys[2]!]: p[2]! * f })
  const res = (p: number[], self: boolean): number[] => {
    const j = posed(p)
    const at = holding(j)
    const g = toWorld(at(weaponContact(w.spec, 'guard')), pos, heading, def.scale)
    const a = at(from)
    const b = at(to)
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1
    const along = ((b.x - a.x) * tl.x + (b.z - a.z) * tl.z) / l
    const r = [g.x - C.x, g.y - C.y, g.z - C.z, GUARD_TURN * (shield ? 1 - along : along)]
    // Out of its own body at the guard and on the ramp in (the overlay blends in linearly).
    return self ? [...r, GUARD_SELF_W * inside(j, at), ...GUARD_RAMP.map((f) => GUARD_SELF_W * inside(posed(p, f)))] : r
  }
  const cost = (r: number[]): number => r.reduce((q, v) => q + v * v, 0)
  const fit = (p0: number[], self: boolean): number[] => {
    let p = p0
    let r = res(p, self)
    let e = cost(r)
    let lambda = 1e-2
    for (let it = 0; it < (self ? GUARD_SELF_ITERS : 14) && e > 1e-8; it++) {
      const J = p.map((_, k) => {
        const q = p.slice()
        q[k] = q[k]! + 1e-3
        return res(q, self).map((v, i) => (v - r[i]!) / 1e-3)
      })
      // (JᵀJ + λ diag) δ = −Jᵀ r, 3 × 3.
      const A = [0, 1, 2].map((a) => [0, 1, 2].map((b) => J[a]!.reduce((q, v, i) => q + v * J[b]![i]!, 0)))
      const g = [0, 1, 2].map((a) => -J[a]!.reduce((q, v, i) => q + v * r[i]!, 0))
      let improved = false
      let gain = 0
      for (let tries = 0; tries < 6 && !improved; tries++) {
        const M = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)))
        const d = solve3(M, g)
        const q = p.map((v, k) => clamp(v + d[k]!, -GUARD_SWING, GUARD_SWING))
        const rq = res(q, self)
        const eq = cost(rq)
        if (eq < e) {
          gain = e - eq
          p = q
          r = rq
          e = eq
          lambda = Math.max(1e-4, lambda / 3)
          improved = true
        }
        else lambda *= 4
      }
      if (!improved || gain < GUARD_GAIN) break
    }
    return p
  }
  // The guard alone; again keeping clear of its own body when that one puts the weapon in it.
  const start = keys.map((k) => clamp(warm[k] ?? 0, -GUARD_SWING, GUARD_SWING))
  const out = (q: number[]): Joints => {
    const j = { [keys[0]!]: q[0]!, [keys[1]!]: q[1]!, [keys[2]!]: q[2]! }
    at.solved.push({ C, toward, out: j })
    return j
  }
  const clean = (q: number[]): boolean => inside(posed(q)) <= 0 && GUARD_RAMP.every((f) => inside(posed(q, f)) <= 0)
  const p = fit(start, false)
  if (clean(p)) return out(p)
  // Kept out of itself: from the start, else (or from there) the better.
  const a = fit(start, true)
  if (clean(a)) return out(a)
  const b = fit(p, true)
  return out(cost(res(b, true)) < cost(res(a, true)) ? b : a)
}

/** An armed guard's work for one aim pose (armedGuard): its holder's body by part, and the guards solved. */
interface GuardMemo {
  def: Fighter
  clip: ClipState | undefined
  side: 'handL' | 'handR'
  pos: V3
  heading: number
  parts?: { strict: GuardPart; held: GuardPart; allow: number }
  solved: { C: V3; toward: XZ; out: Joints }[]
}
/** A part of an armed guard's holder: its bones, their boxes, and its skin once built. */
interface GuardPart {
  bones: number[]
  boxes: { lo: V3; hi: V3 }[]
  mesh?: SkinMesh | null
}
const GUARDS = new WeakMap<object, GuardMemo[]>()

/** A 3 × 3 system M x = b (Cramer). */
function solve3(M: number[][], b: number[]): number[] {
  const det = (m: number[][]): number => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  const D = det(M)
  if (Math.abs(D) < 1e-15) return [0, 0, 0]
  return [0, 1, 2].map((k) => det(M.map((row, i) => row.map((v, j) => (j === k ? b[i]! : v)))) / D)
}


/**
 * Mocap bots (fork, fight-polish): how far apart two fighters rest between
 * beats. GUARD_DISTANCE, or, a bot holding a weapon (a spear held out in its
 * idle), its weapon's reach ahead of it plus how far the other's body comes
 * toward it (a lead leg), plus REST_CLEAR: both in their idles at `t`.
 */
function restGap(a: Fighter, b: Fighter, t: number): number {
  const ahead = (f: Fighter, p: V3): number => -p.z * f.scale
  const reach = (f: Fighter): number => {
    if (!f.idle || f.held.length === 0 || !f.dims.mocap?.rig.skin) return -Infinity
    const clip = { id: f.idle, t }
    return Math.max(...f.held.flatMap((h) => heldWeaponSamples(f.dims, {}, h.hand, h.spec, h.scale, clip).flatMap((w) => w.p.map((q) => ahead(f, q) + w.r * f.scale))))
  }
  const front = (f: Fighter): number => (f.dims.mocap ? Math.max(...supportPoints(f.dims.mocap, fighterPose(f.dims.mocap, {}, f.idle ? { id: f.idle, t } : undefined)).map((x) => ahead(f, x.p))) : BODY_RADIUS)
  const need = Math.max(reach(a) + front(b), reach(b) + front(a)) + REST_CLEAR
  return Math.max(GUARD_DISTANCE, need)
}

/** Mocap bots (fork, fight-polish): how deep either fighter's held weapons go in the other from `from` to `to` (each frame), as laid so far. */
function restDepth(F: [Fighter, Fighter], from: number, to: number, fps: number): number {
  const ev = fightEvaluator(F, to + 1, fps)
  let deep = 0
  for (let t = from; t <= to + 1e-9; t += 1 / fps) {
    const st = ev.evaluate(t)
    const s = F.map((f) => st.entities.find((e) => e.entityId === f.input.entityId)!)
    for (const [i, f] of F.entries()) {
      if (f.held.length === 0) continue
      const o = F[1 - i]!
      deep = Math.max(deep, weaponInto(weaponsWorld(f, s[i]!, true), o, s[1 - i]!, boneBoxes(o, s[1 - i]!, true), true))
    }
  }
  return deep
}

/**
 * A ramp after a blow at T (separate, swingWeapons): 0 at T, all of it by
 * `first`, held to `last`, gone again by `back` (held on when infinite).
 */
function rampShare(T: number, first: number, last: number, back: number): (t: number) => number {
  return (t) => (t <= T ? 0 : t <= last + 1e-9 || !Number.isFinite(back) ? clamp((t - T) / Math.max(1e-3, first - T), 0, 1) : clamp((back - t) / Math.max(1e-3, back - last), 0, 1))
}

/** A mark at a frame a ramp turns on (unless one is there, or it crossfades there): the evaluated state, as it stands. */
function markAtState(f: Fighter, t: number, st: EntityState): void {
  const k = f.marks.findIndex((m) => m.time > t - 1e-6)
  if (!st.clip || (st.clip.w ?? 1) < 1 || k <= 0 || Math.abs(f.marks[k]!.time - t) <= 1e-3) return
  f.marks.splice(k, 0, { ...f.marks[k - 1]!, time: t, position: { ...st.position }, joints: { ...(st.joints ?? {}) }, clip: markOf(st.clip)!, arriveHeading: st.heading })
}

/** The share of a ramp a fighter's marks give a moment (the evaluator runs straight between them). */
function realizedShare(f: Fighter, t: number, share: (t: number) => number): number {
  const k = f.marks.findIndex((m) => m.time > t + 1e-9)
  if (k <= 0) return share(t)
  const a = f.marks[k - 1]!
  const b = f.marks[k]!
  const u = b.time > a.time ? (t - a.time) / (b.time - a.time) : 1
  return share(a.time) + (share(b.time) - share(a.time)) * u
}

/**
 * Mocap bots (fork, fight-polish): after a blow at T, a held weapon riding
 * its holder's reaction or follow-through into the other body (a spear as
 * its holder falls: a push along the line between them only slides it along
 * itself) swings out of the way. Its arm's pitch, else its abduction, by the
 * least (in SWING_STEP, at most SWING_MAX either way) that leaves it at most
 * SEP_TOL in on every frame from T to `end`, and no deeper in its own holder
 * than unswung; eased in by the first such frame and out again by `back`
 * (rampShare). Notes on the swings made.
 */
function swingWeapons(F: [Fighter, Fighter], T: number, end: number, fps: number, back = Infinity): { notes: string[]; states?: SepFrame[] } {
  const notes: string[] = []
  // The frames separate looks at (evaluated afresh once a swing has changed the marks).
  let states: SepFrame[] | undefined
  const evaluate = (): SepFrame[] => {
    const ev = fightEvaluator(F, Math.max(end, Number.isFinite(back) ? back : 0) + 1, fps)
    return sepTimes(T, end, fps).map((t) => {
      const st = ev.evaluate(t)
      return { t, s: F.map((f) => st.entities.find((e) => e.entityId === f.input.entityId)!) }
    })
  }
  for (const [i, f] of F.entries()) {
    const o = F[1 - i]!
    for (const h of f.held) {
      states ??= evaluate()
      const frames = states.map(({ t, s }) => ({ t, sf: s[i]!, so: s[1 - i]!, d: weaponInto(weaponsWorld(f, s[i]!, true, h), o, s[1 - i]!, boneBoxes(o, s[1 - i]!, true), true) }))
      const over = frames.filter((x) => x.d > SEP_TOL)
      if (over.length === 0) continue
      const first = over[0]!
      const last = over[over.length - 1]!
      const share = rampShare(T, first.t, last.t, back)
      if (Number.isFinite(back)) markAtState(f, last.t, last.sf)
      markAtState(f, first.t, first.sf)
      // Per frame (every one: the swing must not put it in elsewhere; those it is in first), its depth in its holder but the arm (the swing
      // moves only the arm: the unswung body), and that unswung (made when first asked).
      const order = [...[...over].sort((a, b) => b.d - a.d), ...frames.filter((x) => x.d <= SEP_TOL)]
      const arm = holdingBones(h)
      const own = order.map((x) => {
        let rest: number | undefined
        const depth = (pcs: WeaponSamples[]): number => weaponInto(pcs, f, x.sf, boneBoxes(f, x.sf, true), true, arm)
        return { depth, rest: (): number => (rest ??= depth(weaponsWorld(f, x.sf, true, h))) }
      })
      // (Out of the other body on every frame, and no deeper in its own: whichever failed last is checked first, each on its frames in
      // `order`, the last to fail first.)
      let ownFirst = false
      const firstO = order.map((_, k) => k)
      const firstS = order.map((_, k) => k)
      const every = (first: number[], ok: (k: number) => boolean): boolean => {
        for (let n = 0; n < first.length; n++) {
          if (ok(first[n]!)) continue
          first.unshift(...first.splice(n, 1))
          return false
        }
        return true
      }
      const clears = (key: string, a: number): boolean => {
        // Each frame's swung weapon, once.
        const ws: WeaponSamples[][] = []
        const swung = (k: number): WeaponSamples[] => (ws[k] ??= weaponsWorld(f, { ...order[k]!.sf, joints: withOffsets(order[k]!.sf.joints ?? {}, { [key]: a * realizedShare(f, order[k]!.t, share) }) }, true, h, true))
        const outOfOther = (): boolean => every(firstO, (k) => weaponInto(swung(k), o, order[k]!.so, boneBoxes(o, order[k]!.so, true), true) <= SEP_TOL)
        const noDeeper = (): boolean => every(firstS, (k) => own[k]!.depth(swung(k)) <= own[k]!.rest())
        if (ownFirst ? !noDeeper() : !outOfOther()) return false
        if (ownFirst ? outOfOther() : noDeeper()) return true
        ownFirst = !ownFirst
        return false
      }
      let pick: { key: string; swing: number } | null = null
      // Not even the largest swing clears the deepest frame: none will.
      const deepest = order[0]!
      const reaches = (key: string, a: number): boolean =>
        weaponInto(weaponsWorld(f, { ...deepest.sf, joints: withOffsets(deepest.sf.joints ?? {}, { [key]: a * realizedShare(f, deepest.t, share) }) }, true, h, true), o, deepest.so, boneBoxes(o, deepest.so, true), true) <= SEP_TOL
      const keys = [`shoulder${h.hand}X`, `shoulder${h.hand}Z`].filter((key) => reaches(key, SWING_MAX) || reaches(key, -SWING_MAX))
      for (const key of keys) {
        for (let k = 1; k * SWING_STEP <= SWING_MAX + 1e-9 && !pick; k++) {
          const a = [k * SWING_STEP, -k * SWING_STEP].find((v) => clears(key, v))
          if (a !== undefined) pick = { key, swing: a }
        }
        if (pick) break
      }
      if (!pick) continue
      // Each mark from T to `back` takes its share.
      for (const m of f.marks) {
        if (m.time <= T + 1e-9 || m.time >= back - 1e-9) continue
        const w = share(m.time)
        if (w > 0) m.joints = { ...(m.joints ?? {}), [pick.key]: (m.joints?.[pick.key] ?? 0) + pick.swing * w }
      }
      states = undefined
      notes.push(`${f === F[0] ? 'A' : 'B'}'s ${h.spec.assetId.replace(/^prop\./, '')} swings ${Math.round((Math.abs(pick.swing) * 180) / Math.PI)}° clear of ${f === F[0] ? 'B' : 'A'}`)
    }
  }
  return { notes, states }
}

/** The moments separate looks at after a blow at T, to `end`. */
function sepTimes(T: number, end: number, fps: number): number[] {
  const out: number[] = []
  for (let t = T + 1 / fps; t <= end + 1e-9; t += t < T + SEP_CLOSE ? 1 / fps : SEP_STEP) out.push(t)
  return out
}

/** A frame separate looks at: its moment and both fighters' states (as F orders them). */
interface SepFrame {
  t: number
  s: EntityState[]
}

/** Mocap bots (fork, fight-polish): the bones of the arm holding `h` (and a two-handed grip's other forearm and hand): a weapon may lie in them. */
function holdingBones(h: HeldWeapon): Set<number> {
  const arm = h.hand === 'L' ? 'Left' : 'Right'
  const other = h.hand === 'L' ? 'Right' : 'Left'
  const names = [`${arm}Arm`, `${arm}ForeArm`, `${arm}Hand`, ...(h.spec.twoHanded ? [`${other}ForeArm`, `${other}Hand`] : [])] as MocapBone[]
  return new Set(names.map((b) => BONE_INDEX[b]))
}

/**
 * Mocap bots (fork): after a blow at T the bodies are kept apart (a fall
 * into the attacker, a follow-through into the defender): the skins sampled
 * to `end` (every frame for SEP_CLOSE, then every SEP_STEP), and where they
 * sit more than SEP_TOL in each other, the defender's marks after T are
 * pushed back along `away`, ramped in by the first frame that overlapped,
 * by the least push (to within SEP_RES, at most SEP_MAX) that clears those
 * frames, plus SEP_MARGIN; when the defender alone can't get clear, the
 * attacker's own marks after T are held back as far. When nothing clears
 * them, the least push that does as well as SEP_MAX, if that helps by
 * SEP_GAIN. Before another blow (`back`,
 * finite) the push holds to the last frame that overlapped and eases out by
 * `back`, so that blow lands where it was placed. Returns the push (m) and
 * whether the attacker was held back too.
 */
function separate(F: [Fighter, Fighter], atk: Fighter, def: Fighter, T: number, end: number, away: XZ, fps: number, back = Infinity, frames?: SepFrame[]): { push: number; both: boolean } {
  // (Fork, fight-polish: or the frames swingWeapons evaluated, the marks unchanged since.)
  const ev = frames ? null : fightEvaluator(F, Math.max(end, Number.isFinite(back) ? back : 0) + 1, fps)
  const over: { t: number; sa: EntityState; sd: EntityState; d: number }[] = []
  const ia = F.indexOf(atk)
  const id = F.indexOf(def)
  for (const [k, t] of (frames ? frames.map((x) => x.t) : sepTimes(T, end, fps)).entries()) {
    const st = frames ? null : ev!.evaluate(t)
    const sa = frames ? frames[k]!.s[ia]! : st!.entities.find((e) => e.entityId === atk.input.entityId)!
    const sd = frames ? frames[k]!.s[id]! : st!.entities.find((e) => e.entityId === def.input.entityId)!
    const d = bodyOverlap(atk, sa, def, sd, true)
    if (d > SEP_TOL) over.push({ t, sa, sd, d })
  }
  if (over.length === 0) return { push: 0, both: false }
  const first = over[0]!
  const last = over[over.length - 1]!
  const share = rampShare(T, first.t, last.t, back)
  const marksAt = (f: Fighter, at: (o: (typeof over)[number]) => EntityState): void => {
    if (Number.isFinite(back)) markAtState(f, last.t, at(last))
    markAtState(f, first.t, at(first))
  }
  marksAt(def, (o) => o.sd)
  const realized = (f: Fighter, t: number): number => realizedShare(f, t, share)
  const moved = (s: EntityState, d: XZ, p: number): EntityState => ({ ...s, position: { x: s.position.x + d.x * p, y: s.position.y, z: s.position.z + d.z * p } })
  const toward = { x: -away.x, z: -away.z }
  // How deep the bodies still sit in each other on one of those frames, the defender pushed by p (and with `both`, the attacker held back by p).
  const depthAt = ({ t, sa, sd }: (typeof over)[number], p: number, both: boolean): number =>
    bodyOverlap(atk, both ? moved(sa, toward, p * realized(atk, t)) : sa, def, moved(sd, away, p * realized(def, t)), true)
  const deepest = (p: number, both: boolean): number => Math.max(...over.map((o) => depthAt(o, p, both)))
  // Unpushed, as the frames were found.
  const start = Math.max(...over.map((o) => o.d))
  let both = false
  let most = deepest(SEP_MAX, false)
  if (most > SEP_TOL) {
    // The attacker carrying on into the defender (a kick stepping through, a tackle): its own travel after the blow is held back too.
    const held = deepest(SEP_MAX, true)
    if (held < most - SEP_RES) {
      both = true
      marksAt(atk, (o) => o.sa)
      most = deepest(SEP_MAX, true)
    }
  }
  if (most > SEP_TOL && start - most < SEP_GAIN) return { push: 0, both: false }
  const goal = most <= SEP_TOL ? SEP_TOL : most + SEP_RES
  let lo = 0
  let hi = SEP_MAX
  // Each push is tried on the deepest frames first and given up at the first one still over the goal (the last to fail goes first).
  const order = [...over].sort((a, b) => b.d - a.d)
  const fits = (p: number): boolean => {
    for (let k = 0; k < order.length; k++) {
      if (depthAt(order[k]!, p, both) <= goal) continue
      order.unshift(...order.splice(k, 1))
      return false
    }
    return true
  }
  while (hi - lo > SEP_RES) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  const push = hi + SEP_MARGIN
  // Each later mark moved by its share.
  const shift = (f: Fighter, dir: XZ): void => {
    for (const m of f.marks) {
      if (m.time <= T + 1e-9 || m.time >= back - 1e-9) continue
      const w = share(m.time)
      m.position = { x: m.position.x + dir.x * push * w, y: m.position.y, z: m.position.z + dir.z * push * w }
    }
  }
  shift(def, away)
  if (both) {
    shift(atk, toward)
    const end = atk.marks[atk.marks.length - 1]!
    atk.spot = { x: end.position.x, z: end.position.z }
  }
  return { push, both }
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
  const strike = contactLocal(atk, a.joints, effector, 'strike', true, a.clip)
  const E = toWorld(strike, a.position, a.heading, atk.scale)
  const toward = sub(a.position, d.position)
  // Mocap bots (fork): skin to skin, how far the striking skin is from just touching the target's.
  if (atk.dims.mocap && def.dims.mocap && !weaponOf(atk, effector)) {
    const at = (guard: 'handL' | 'handR'): number | null =>
      blowDepth(atk, a.joints ?? {}, a.clip, effector, a.position, a.heading, def, d.joints ?? {}, d.clip, d.position, d.heading, skinOf(def, d.joints ?? {}, d.clip, zone, outcome, guard, unit(toward), d.heading), outcome === 'block' || outcome === 'parry')
    let depth = at(guardSide(def, guardHand(strike.x)))
    // Fork (fight-polish): bare hands block on whichever forearm the blow meets (the shell holds both up).
    if (depth !== null && (outcome === 'block' || outcome === 'parry') && def.held.length === 0) depth = Math.max(at('handL')!, at('handR')!)
    if (depth !== null) return Math.abs(depth)
  }
  let T = fightTarget(def.dims, def.scale, d.joints, d.position, d.heading, toward, zone, effector, def.torso, d.clip)
  if (outcome === 'block' || outcome === 'parry') {
    const side = guardSide(def, guardHand(strike.x))
    const hand = toWorld(contactLocal(def, d.joints, side, 'guard', true, d.clip), d.position, d.heading, def.scale)
    const t = unit(toward)
    if (def.dims.mocap && !weaponOf(def, side)) {
      const g = guardReach(def, d.joints, d.clip, side, t, d.heading)
      T = { x: hand.x + t.x * g, y: hand.y, z: hand.z + t.z * g }
    }
    else T = { x: hand.x + t.x * 0.05 * def.scale, y: hand.y, z: hand.z + t.z * 0.05 * def.scale }
  }
  return dist3(E, T)
}
