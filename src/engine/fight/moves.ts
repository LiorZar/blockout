/**
 * Fight move tables (fork addition; see MODIFICATIONS.md).
 *
 * Strike impacts are detected from the motion data with rig FK on the
 * reference man: per limb, the striking effector is the hand / foot, or the
 * elbow / knee when that joint is folded (≥ 1.7 rad). An impact is a keyframe
 * where the effector's limb-local extension from the guard pose (keyframe 0;
 * torso twist removed so the off hand doesn't count) is a local maximum,
 * ≥ 0.7 × its maximum and ≥ 0.2 m, not clearly behind the body, and — for
 * legs — off the ground (a lunge's step isn't a kick). Impacts closer than
 * 0.15 s keep the bigger strike.
 *
 * Each impact's speed is the blow's nominal peak speed (`STRIKE_SPEED`): the
 * keyframes are too sparse to measure it (their average is 2–4 m/s, a
 * tenth of a real kick).
 *
 * A move whose upstream data reads wrong on camera plays a fork replacement
 * (`FORK_REPLACEMENTS`, motions-fork.ts) under its upstream id, so scripts,
 * saved fights, speeds and physics keep the id.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, poseEffectors, type Effector } from '../skeleton'
import type { Entity, V3 } from '../types'
import { WEAPON_SPECS, weaponSpec, type Hand, type WeaponKind, type WeaponSpec } from '../weapons'

export interface StrikeImpact {
  effector: Effector
  /** Seconds from the motion start. */
  t: number
  /** Nominal peak speed of the blow (m/s): `STRIKE_SPEED`, else the effector's default. */
  speed: number
}

export const DEFENSES: Record<'block' | 'parry' | 'slip' | 'duck', { high: string; low: string; readyFraction: number }> = {
  block: { high: 'block-high', low: 'block-low', readyFraction: 0.4 },
  parry: { high: 'parry-deflect', low: 'parry-deflect', readyFraction: 0.35 },
  slip: { high: 'dodge-left', low: 'dodge-left', readyFraction: 0.5 },
  duck: { high: 'duck-under', low: 'weave-bob', readyFraction: 0.45 }
}

/** A shield holder's block and parry (fork, motions-fork.ts): the shield up with its face toward the attacker. */
export const SHIELD_BLOCK = { high: 'shield-block-high', low: 'shield-block-face', readyFraction: 0.35 }

export const REACTIONS = {
  head: 'hit-reaction-head',
  body: 'hit-reaction-body',
  stagger: 'stagger-back',
  knockdown: 'knockdown-fall',
  ko: 'ko-collapse',
  getUp: 'get-up-from-ground',
  guard: 'boxing-guard-bounce'
} as const

export const MOVE_ALIASES: Record<string, string> = {
  jab: 'jab-cross',
  cross: 'jab-cross',
  'jab cross': 'jab-cross',
  hook: 'hook-punch',
  haymaker: 'haymaker',
  uppercut: 'uppercut',
  'front kick': 'front-kick',
  roundhouse: 'roundhouse-kick',
  knee: 'knee-strike',
  elbow: 'elbow-strike',
  'side kick': 'side-kick',
  'spinning back kick': 'spinning-back-kick',
  sweep: 'low-sweep',
  shove: 'shove-two-hands',
  tackle: 'tackle-lunge',
  // Weapons: blades land with the weapon in hand, guns shoot (SHOT_MOVES).
  'sword slash': 'sword-slash-combo',
  slash: 'sword-slash-combo',
  swing: 'sword-slash-combo',
  'sword thrust': 'sword-thrust',
  thrust: 'sword-thrust',
  stab: 'knife-lunge',
  lunge: 'knife-lunge',
  shoot: 'pistol-aim-fire',
  shoots: 'pistol-aim-fire',
  fire: 'pistol-aim-fire',
  shot: 'pistol-aim-fire',
  // Upstream has the spinning backfist twice; the catalog lists one (DUPLICATE_MOVES).
  'spinning-back-fist': 'spinning-backfist'
}

/** Fight-category motions that aren't melee strikes (ranged weapons, footwork, being hit). */
const NON_STRIKES = new Set([
  'knocked-down',
  'block-and-dodge',
  'dodge-weave',
  'dodge-right',
  'guard-up-advance',
  'sword-parry',
  'bow-draw-loose',
  'pistol-aim-fire',
  'rifle-aim-sweep',
  'rifle-aim-fire',
  'shield-brace-face'
])

/**
 * Peak speed (m/s) of each impact of each strike, in impact order: jabs 5.5,
 * crosses 9, hooks 10, haymakers 11; snap and push kicks 8, roundhouses 12,
 * the spinning back kick 13; a blade's slash 9 and thrust 8 at the hand
 * (`weaponHeft` adds the blade's reach). Whole-body pushes and lunges are
 * slow and heavy (physics.ts gives them the body's mass).
 */
export const STRIKE_SPEED: Record<string, number[]> = {
  'jab-cross': [5.5, 9],
  uppercut: [9],
  'high-kick': [12],
  haymaker: [11],
  'roundhouse-kick': [12],
  'front-kick-combo': [8, 5.5],
  'spinning-backfist': [10],
  'double-jab-body-shot': [5.5, 5.5, 9],
  'grapple-shove': [2.5],
  'takedown-lunge': [4],
  'boxing-combo': [5.5, 9],
  'hook-punch': [10],
  'elbow-strike': [7],
  'knee-strike': [7],
  'front-kick': [8],
  'side-kick': [8],
  'spinning-back-kick': [13],
  'low-sweep': [7],
  'tackle-lunge': [4],
  'shove-two-hands': [2.5],
  'sword-slash-combo': [9, 9],
  'sword-thrust': [8],
  'knife-lunge': [9],
  'jab-hook-cross': [10, 9],
  'teep-push-kick': [8]
}

/** Speed of a blow missing from `STRIKE_SPEED`, by the striking limb. */
const EFFECTOR_SPEED: Record<string, number> = { hand: 8, elbow: 7, foot: 10, knee: 7 }

const FOLDED = 1.7
const MIN_EXTENSION = 0.2
const MIN_GAP = 0.15
const FOOT_OFF_GROUND = 0.25

interface Limb {
  distal: Effector
  proximal: Effector
  root: 'shoulderL' | 'shoulderR' | null
  bend: string
}

const LIMBS: Limb[] = [
  { distal: 'handL', proximal: 'elbowL', root: 'shoulderL', bend: 'elbowL' },
  { distal: 'handR', proximal: 'elbowR', root: 'shoulderR', bend: 'elbowR' },
  { distal: 'footL', proximal: 'kneeL', root: null, bend: 'kneeL' },
  { distal: 'footR', proximal: 'kneeR', root: null, bend: 'kneeR' }
]

const REFERENCE = personDims('person.man')
const BY_ID = new Map(MOTION_PRESETS.map((m) => [m.id, m]))
const memo = new Map<string, StrikeImpact[]>()

/** Upstream fight move → the fork motion a fight plays for it (the twist follows the motions.ts header). */
export const FORK_REPLACEMENTS: Record<string, string> = {
  haymaker: 'haymaker-swing',
  'elbow-strike': 'elbow-strike-across',
  'sword-slash-combo': 'sword-slash-two-hand'
}
const REPLACEMENT_IDS = new Set(Object.values(FORK_REPLACEMENTS))

/** Upstream strikes that duplicate another: not listed, and played (saved fights too) as the move they duplicate. */
export const DUPLICATE_MOVES: Record<string, string> = {
  'spinning-back-fist': 'spinning-backfist'
}

/** The keyframes a fight move plays: its fork replacement, else the motion itself (a duplicate plays its original). */
export function fightMotion(id: string): MotionPreset | undefined {
  const move = DUPLICATE_MOVES[id] ?? id
  return BY_ID.get(FORK_REPLACEMENTS[move] ?? move)
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Limb joints only: torso and head channels zeroed, so extension is the limb's own. */
function limbOnly(joints: Record<string, number>): Record<string, number> {
  return { ...joints, torsoX: 0, torsoY: 0, torsoZ: 0, headX: 0, headY: 0, headZ: 0 }
}

function detect(m: MotionPreset, id: string): StrikeImpact[] {
  const kfs = m.keyframes
  if (kfs.length < 3) return []
  const full = kfs.map((k) => poseEffectors(REFERENCE, k.joints))
  const local = kfs.map((k) => poseEffectors(REFERENCE, limbOnly(k.joints)))
  const found: (StrikeImpact & { score: number })[] = []
  for (const limb of LIMBS) {
    const eff = (k: number): Effector => ((kfs[k]!.joints[limb.bend] ?? 0) >= FOLDED ? limb.proximal : limb.distal)
    const score = kfs.map((_, k) => dist(local[k]![eff(k)], local[0]![eff(k)]))
    const max = Math.max(...score)
    for (let k = 1; k < kfs.length - 1; k++) {
      const s = score[k]!
      if (!(s > score[k - 1]! && s >= score[k + 1]!)) continue
      if (s < 0.7 * max || s < MIN_EXTENSION) continue
      const e = eff(k)
      const p = full[k]![e]
      const rootZ = limb.root ? full[k]![limb.root].z : 0
      if (p.z - rootZ > 0.25) continue // clearly behind the body: a wind-up, not a blow
      if (!limb.root && p.y < FOOT_OFF_GROUND) continue // a step, not a kick
      found.push({ effector: e, t: kfs[k]!.t, speed: 0, score: s })
    }
  }
  found.sort((a, b) => b.score - a.score || a.t - b.t)
  const kept: StrikeImpact[] = []
  for (const f of found) {
    if (kept.every((k) => Math.abs(k.t - f.t) >= MIN_GAP - 1e-9)) kept.push({ effector: f.effector, t: f.t, speed: 0 })
  }
  return kept
    .sort((a, b) => a.t - b.t)
    .map((imp, k) => ({ ...imp, speed: STRIKE_SPEED[id]?.[k] ?? EFFECTOR_SPEED[imp.effector.replace(/[LR]$/, '')]! }))
}

/** Impacts of a strike motion (memoised; a replaced move's from its fork data); [] for unknown motions, defenses and reactions. */
export function strikeImpacts(motionId: string): StrikeImpact[] {
  const same = DUPLICATE_MOVES[motionId]
  if (same) return strikeImpacts(same)
  const hit = memo.get(motionId)
  if (hit) return hit
  const m = BY_ID.get(motionId)
  const out = m && isStrikeCandidate(m) ? detect(fightMotion(motionId)!, motionId) : []
  memo.set(motionId, out)
  return out
}

const DEFENSE_AND_REACTION_IDS = new Set<string>([
  ...Object.values(DEFENSES).flatMap((d) => [d.high, d.low]),
  SHIELD_BLOCK.high,
  SHIELD_BLOCK.low,
  ...Object.values(REACTIONS)
])

function isStrikeCandidate(m: MotionPreset): boolean {
  return m.category === 'fight' && !NON_STRIKES.has(m.id) && !DEFENSE_AND_REACTION_IDS.has(m.id) && !REPLACEMENT_IDS.has(m.id) && !(m.id in DUPLICATE_MOVES)
}

export const STRIKE_IDS: string[] = MOTION_PRESETS.filter((m) => isStrikeCandidate(m) && strikeImpacts(m.id).length > 0).map(
  (m) => m.id
)

/* ----------------------------- gun shots (fork) ---------------------------- */

/** Aim-and-fire motions a gun or bow beat plays (held weapons; see src/engine/weapons.ts). */
export const SHOT_MOVES = new Set(['pistol-aim-fire', 'rifle-aim-fire', 'bow-draw-loose'])

/** The aim a gun or bow beat plays, whichever shot the script names: long guns shoulder, pistols aim arms out, a bow draws and looses. */
export function gunAimMove(spec: WeaponSpec): string {
  if (spec.kind === 'bow') return 'bow-draw-loose'
  return spec.mount === 'shoulder' ? 'rifle-aim-fire' : 'pistol-aim-fire'
}

/** The hand a shot motion fires from as authored: the bow arm is the left, guns fire from the right. */
export function shotHand(moveId: string): 'L' | 'R' {
  return moveId === 'bow-draw-loose' ? 'L' : 'R'
}

/** A bullet or an arrow: the physics sees the fastest blow there is. */
const BULLET_SPEED = 15

/**
 * The shot of an aim-and-fire motion, fired from `hand`: a gun's keyframe
 * just before the recoil (the gun arm's highest raise); a bow's loose (the
 * draw arm opening after full draw). [] for anything else.
 */
export function shotImpacts(moveId: string, hand: 'L' | 'R' = shotHand(moveId)): StrikeImpact[] {
  const m = BY_ID.get(moveId)
  if (!m || !SHOT_MOVES.has(moveId)) return []
  let k: number
  if (moveId === 'bow-draw-loose') {
    const draw = m.keyframes.map((kf) => kf.joints.elbowR ?? 0)
    k = Math.min(m.keyframes.length - 2, draw.indexOf(Math.max(...draw)) + 1)
  }
  else {
    const raise = m.keyframes.map((kf) => -(kf.joints[`shoulder${hand}X`] ?? 0))
    k = Math.max(1, raise.indexOf(Math.max(...raise)) - 1)
  }
  return [{ effector: hand === 'L' ? 'handL' : 'handR', t: m.keyframes[k]!.t, speed: BULLET_SPEED }]
}

/** Moves played with both hands on one grip (fork): the solver pitches both arms alike, so the hands stay together. */
export const TWO_HAND_GRIP = new Set(['sword-slash-combo'])

/**
 * The solver's pitch offsets for a blow, for a two-hand-grip move copied to
 * the other arm's shoulder X: both shoulders turn about the torso's X axis,
 * so equal pitches move both hands alike.
 */
export function gripPitch(moveId: string, pitch: Record<string, number>): Record<string, number> {
  if (!TWO_HAND_GRIP.has(moveId)) return pitch
  const out = { ...pitch }
  for (const [side, other] of [['L', 'R'], ['R', 'L']]) {
    const v = pitch[`shoulder${side}X`]
    if (v !== undefined && pitch[`shoulder${other}X`] === undefined) out[`shoulder${other}X`] = v
  }
  return out
}

/* ------------------------- weapon motions by hand (fork) ------------------------ */

/** Fork shield motions, authored with the shield in the left hand. */
const SHIELD_MOTIONS = new Set(['shield-block-face', 'shield-brace-face', 'shield-block-high'])
const MELEE: WeaponKind[] = ['blade', 'blunt', 'polearm']
const REPLACED = new Map(Object.entries(FORK_REPLACEMENTS).map(([from, to]) => [to, from]))

/**
 * The hand a motion uses its weapon in as authored, and the weapons it is
 * for: a shot's gun or bow hand, the shield motions' left, a strike whose
 * blows all come from one hand (a fork replacement by its upstream move's
 * blows); null for anything else.
 */
export function motionWeaponHand(motionId: string): { hand: Hand; kinds: WeaponKind[] } | null {
  if (SHOT_MOVES.has(motionId)) return { hand: shotHand(motionId), kinds: motionId === 'bow-draw-loose' ? ['bow'] : ['gun'] }
  if (SHIELD_MOTIONS.has(motionId)) return { hand: 'L', kinds: ['shield'] }
  const sides = new Set(strikeImpacts(REPLACED.get(motionId) ?? motionId).map((imp) => imp.effector.slice(-1)))
  return sides.size === 1 ? { hand: [...sides][0] as Hand, kinds: MELEE } : null
}

/**
 * A motion plays mirrored on a performer whose weapon for it is only in the
 * other hand (a left-hand rifle shoulders on the left, a left-hand sword
 * slashes with the left arm), as fights already do.
 */
export function mirrorForHeld(motionId: string, held: { hand: Hand; kind: WeaponKind }[]): boolean {
  const w = motionWeaponHand(motionId)
  if (!w) return false
  const fits = held.filter((h) => w.kinds.includes(h.kind))
  return fits.length > 0 && fits.every((h) => h.hand !== w.hand)
}

/** `mirrorForHeld` for a performer in a scene: the weapons whose `heldBy` names it. */
export function mirrorForHolder(motionId: string, holderId: string, entities: Entity[]): boolean {
  const held = entities.flatMap((e) => {
    const spec = e.heldBy?.entityId === holderId ? weaponSpec(e.assetId) : undefined
    return spec ? [{ hand: e.heldBy!.hand, kind: spec.kind }] : []
  })
  return mirrorForHeld(motionId, held)
}

export function listFightMoves(): { id: string; name: string; impacts: StrikeImpact[] }[] {
  return STRIKE_IDS.map((id) => ({ id, name: BY_ID.get(id)!.name, impacts: strikeImpacts(id) }))
}

/** The gun and bow shots a fight script can use (list_fight_moves adds them after the strikes), with the weapons that play each. */
export function listShotMoves(): { id: string; name: string; impacts: StrikeImpact[]; guns: string[] }[] {
  return [...SHOT_MOVES].map((id) => ({
    id,
    name: BY_ID.get(id)!.name,
    impacts: shotImpacts(id),
    guns: WEAPON_SPECS.filter((w) => (w.kind === 'gun' || w.kind === 'bow') && gunAimMove(w) === id).map((w) => w.assetId)
  }))
}
