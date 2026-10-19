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
 * PURE: no DOM / three.js / Electron.
 */

import { MOTION_PRESETS, type MotionPreset } from '../motions'
import { personDims, poseEffectors, type Effector } from '../skeleton'
import type { V3 } from '../types'

export interface StrikeImpact {
  effector: Effector
  /** Seconds from the motion start. */
  t: number
  /** Effector speed (m/s) from the previous keyframe into the impact, clamped to [2, 15]. */
  speed: number
}

export const DEFENSES: Record<'block' | 'parry' | 'slip' | 'duck', { high: string; low: string; readyFraction: number }> = {
  block: { high: 'block-high', low: 'block-low', readyFraction: 0.4 },
  parry: { high: 'parry-deflect', low: 'parry-deflect', readyFraction: 0.35 },
  slip: { high: 'dodge-left', low: 'dodge-left', readyFraction: 0.5 },
  duck: { high: 'duck-under', low: 'weave-bob', readyFraction: 0.45 }
}

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
  tackle: 'tackle-lunge'
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
  'rifle-aim-sweep'
])

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

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Limb joints only: torso and head channels zeroed, so extension is the limb's own. */
function limbOnly(joints: Record<string, number>): Record<string, number> {
  return { ...joints, torsoX: 0, torsoY: 0, torsoZ: 0, headX: 0, headY: 0, headZ: 0 }
}

function detect(m: MotionPreset): StrikeImpact[] {
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
      const dt = kfs[k]!.t - kfs[k - 1]!.t
      const speed = dt > 0 ? dist(p, full[k - 1]![e]) / dt : 0
      found.push({ effector: e, t: kfs[k]!.t, speed: Math.min(15, Math.max(2, speed)), score: s })
    }
  }
  found.sort((a, b) => b.score - a.score || a.t - b.t)
  const kept: StrikeImpact[] = []
  for (const f of found) {
    if (kept.every((k) => Math.abs(k.t - f.t) >= MIN_GAP - 1e-9)) kept.push({ effector: f.effector, t: f.t, speed: f.speed })
  }
  return kept.sort((a, b) => a.t - b.t)
}

/** Impacts of a strike motion (memoised); [] for unknown motions, defenses and reactions. */
export function strikeImpacts(motionId: string): StrikeImpact[] {
  const hit = memo.get(motionId)
  if (hit) return hit
  const m = BY_ID.get(motionId)
  const out = m && isStrikeCandidate(m) ? detect(m) : []
  memo.set(motionId, out)
  return out
}

const DEFENSE_AND_REACTION_IDS = new Set<string>([
  ...Object.values(DEFENSES).flatMap((d) => [d.high, d.low]),
  ...Object.values(REACTIONS)
])

function isStrikeCandidate(m: MotionPreset): boolean {
  return m.category === 'fight' && !NON_STRIKES.has(m.id) && !DEFENSE_AND_REACTION_IDS.has(m.id)
}

export const STRIKE_IDS: string[] = MOTION_PRESETS.filter((m) => isStrikeCandidate(m) && strikeImpacts(m.id).length > 0).map(
  (m) => m.id
)

export function listFightMoves(): { id: string; name: string; impacts: StrikeImpact[] }[] {
  return STRIKE_IDS.map((id) => ({ id, name: BY_ID.get(id)!.name, impacts: strikeImpacts(id) }))
}
