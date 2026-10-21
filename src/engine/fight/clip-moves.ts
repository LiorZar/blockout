/**
 * Fight moves on mocap bots (fork addition; see MODIFICATIONS.md): which
 * library clips a loaded bot plays for each Fight Director move, reaction
 * and defense, and where in each clip the blow lands.
 *
 * - A move is one clip per impact (`moveClips`): a combo chains clips (the
 *   jab-cross is the jab, then the cross), picked by target (a jab or hook
 *   to the body, a low kick to the legs) and by the weapon in hand (blades
 *   and clubs two-handed swing the great sword's two cuts, a blade beside a
 *   shield the sword-and-shield slash, a knife stabs; guns raise their aim
 *   and fire). The clips play as captured (orthodox, the left hand and foot
 *   lead), so a bot's jab is its left hand. A move with no clip (the spinning
 *   backfist, the sweep, the teep, the grapples …) is null: it keeps its
 *   keyframes, retargeted.
 * - The impact frame (`clipImpactTime`) is the striking effector's peak
 *   extension toward the front in the clip's FK on its source bot (its
 *   furthest point along the clip's facing, the root travel out: a strike
 *   clip faces −Z), the first frame of the plateau; with a weapon in the
 *   hand, the weapon's strike point's.
 * - Reactions by target and the side the blow lands on (`reactionClip`),
 *   defenses by height, side and what's in hand (`defenseClip`), each with the frame that meets the blow
 *   (`defenseReadyTime`, `reactionOnset`) and a fall's landing
 *   (`fallLandTime`).
 *
 * PURE: no DOM / three.js / Electron. The table names clip keys of the
 * user's local library (data about it, not Mixamo data); the times are
 * measured from the registered clips at run time, memoised per registry
 * version, never on the `state(t)` path of a frame.
 */

import { clipSample, mocapClip, mocapClipPose, mocapClipVersion, type MocapClip } from '../mocap/clip'
import { effectorsOf, poseFramesOf, type MocapDims } from '../mocap/fk'
import { mocapRig } from '../mocap/registry'
import { personDims, type Effector } from '../skeleton'
import type { FightBeat, V3 } from '../types'
import { heldPointLocal, weaponContact, type HeldWeapon } from '../weapons'

type Zone = FightBeat['target']

/** A clip one impact of a move plays, the effector it strikes with as captured, and the clip seconds its impact is searched in. */
export interface ClipBlow {
  clip: string
  effector: Effector
  within?: [number, number]
}

/** A clip per target (`default` for the rest). */
type Pick = string | ({ default: string } & Partial<Record<Zone, string>>)

interface BlowSpec {
  clip: Pick
  within?: [number, number]
}

/** The effector each strike clip strikes with, as captured (orthodox: the left hand and foot lead). */
export const CLIP_EFFECTOR: Record<string, Effector> = {
  jabHead: 'handL',
  jabBody: 'handL',
  cross: 'handR',
  hookHead: 'handL',
  hookBody: 'handL',
  uppercut: 'handL',
  haymaker: 'handR',
  elbow: 'elbowR',
  knee: 'kneeR',
  frontKick: 'footL',
  sideKick: 'footL',
  roundhouse: 'footR',
  lowKick: 'footR',
  greatSword: 'handR',
  swordSlash: 'handR',
  heavySwing: 'handR',
  knifeStab: 'handR',
  rifleAim: 'handR',
  pistolAim: 'handR'
}

const JAB: BlowSpec = { clip: { default: 'jabHead', body: 'jabBody' } }
const HOOK: BlowSpec = { clip: { default: 'hookHead', body: 'hookBody' } }
const CROSS: BlowSpec = { clip: 'cross' }

/** Unarmed moves → the clips of their impacts, in impact order. */
export const FIGHT_CLIPS: Record<string, BlowSpec[]> = {
  'jab-cross': [JAB, CROSS],
  'boxing-combo': [JAB, CROSS],
  // Two jabs and a body shot: the left hook to the body, a cross to the head.
  'double-jab-body-shot': [JAB, JAB, { clip: { default: 'cross', body: 'hookBody' } }],
  'jab-hook-cross': [HOOK, CROSS],
  'hook-punch': [HOOK],
  uppercut: [{ clip: 'uppercut' }],
  haymaker: [{ clip: 'haymaker' }],
  'elbow-strike': [{ clip: 'elbow' }],
  'knee-strike': [{ clip: 'knee' }],
  'front-kick': [{ clip: 'frontKick' }],
  'side-kick': [{ clip: 'sideKick' }],
  'roundhouse-kick': [{ clip: { default: 'roundhouse', legs: 'lowKick' } }],
  'high-kick': [{ clip: 'roundhouse' }],
  'front-kick-combo': [{ clip: 'frontKick' }, JAB]
}

/** Lateral blows: the defender reels sideways (a body hit is the side hit). */
const LATERAL = new Set(['hook-punch', 'haymaker', 'roundhouse-kick', 'high-kick', 'elbow-strike', 'jab-hook-cross', 'spinning-backfist', 'spinning-back-fist', 'sword-slash-combo'])
/** Pushes: the defender takes the shove. */
const PUSHES = new Set(['shove-two-hands', 'grapple-shove', 'tackle-lunge', 'takedown-lunge'])

/** The weapons a hand fights with (fork weapons.ts kinds) and the clips their moves play. */
const SLASH = 'sword-slash-combo'
const STAB = 'knife-lunge'

/** Clip seconds of the great sword's two cuts (the sweep, then the overhead chop). */
const GREAT_SWORD_CUTS: [number, number][] = [
  [0.5, 1.0],
  [1.1, 1.7]
]

/** A pick for a target. */
function pick(p: Pick, zone: Zone): string {
  return typeof p === 'string' ? p : (p[zone] ?? p.default)
}

/**
 * The clip blows a bot plays for a move at a target, or null (no clip in the
 * table or the library: the move keeps its keyframes). `weapon` is the
 * weapon the striking hand holds (or the two-hander the other hand holds),
 * `offHand` whether the other hand holds something else (a shield).
 */
export function moveClips(moveId: string, zone: Zone, weapon?: HeldWeapon, offHand = false): ClipBlow[] | null {
  let specs: BlowSpec[] | undefined
  if (moveId === SLASH || moveId === STAB) {
    // A weapon move needs a blade, club or shaft in hand (unarmed, it keeps its keyframes).
    const kind = weapon?.spec.kind
    if (kind !== 'blade' && kind !== 'blunt' && kind !== 'polearm') return null
    if (moveId === STAB) specs = [{ clip: 'knifeStab' }]
    // Two cuts: two-handed the great sword's, beside a shield the sword-and-shield slash twice, a shaft the heavy swing.
    else if (kind === 'polearm') specs = [{ clip: 'heavySwing' }, { clip: 'heavySwing' }]
    else specs = offHand ? [{ clip: 'swordSlash' }, { clip: 'swordSlash' }] : GREAT_SWORD_CUTS.map((within) => ({ clip: 'greatSword', within }))
  }
  else specs = FIGHT_CLIPS[moveId]
  if (!specs) return null
  const out = specs.map((s): ClipBlow => {
    const clip = pick(s.clip, zone)
    return { clip, effector: CLIP_EFFECTOR[clip]!, ...(s.within ? { within: s.within } : {}) }
  })
  return out.every((b) => mocapClip(b.clip)) ? out : null
}

/** A gun's aim on a bot: the aim loop (a long gun shouldered, a pistol in both hands); the shot goes off at `GUN_AIM_AT`. */
export function gunClips(mount: 'hand' | 'shoulder'): ClipBlow[] | null {
  const aim = mount === 'shoulder' ? 'rifleAim' : 'pistolAim'
  return mocapClip(aim) ? [{ clip: aim, effector: CLIP_EFFECTOR[aim]!, within: [GUN_AIM_AT, GUN_AIM_AT] }] : null
}

/** Clip seconds into an aim loop the shot goes off: the aim has settled. */
export const GUN_AIM_AT = 0.4

/** The idle a bot fighter holds between beats: a gun's ready, else the fight idle. */
export function idleClip(gun?: 'hand' | 'shoulder'): string | null {
  const id = gun === 'shoulder' ? 'rifleIdle' : gun === 'hand' ? 'pistolIdle' : 'fightIdle'
  return mocapClip(id) ? id : mocapClip('fightIdle') ? 'fightIdle' : null
}

/* ----------------------------- clip analysis ----------------------------- */

/** Extensions within this of the peak are its plateau (m): a held reach, not a rising one. */
const PLATEAU = 1e-6

const memo = new Map<string, number>()
let memoVersion = -1

function cached(key: string, f: () => number): number {
  if (memoVersion !== mocapClipVersion()) {
    memo.clear()
    memoVersion = mocapClipVersion()
  }
  let v = memo.get(key)
  if (v === undefined) {
    v = f()
    memo.set(key, v)
  }
  return v
}

/** The clip's source bot at height ×1. */
function sourceOf(clip: MocapClip): MocapDims {
  return { rig: mocapRig(clip.source)!, k: 1 }
}

/** Frame range of a clip within clip seconds [a, b]. */
function frames(clip: MocapClip, within?: [number, number]): [number, number] {
  const last = clip.frames - 1
  if (!within) return [0, last]
  return [Math.max(0, Math.min(last, Math.round(within[0] * clip.fps))), Math.max(0, Math.min(last, Math.round(within[1] * clip.fps)))]
}

/**
 * Clip seconds of a blow's impact: the first frame of the plateau of the
 * effector's (or the held weapon's strike point's) forward reach.
 */
export function clipImpactTime(blow: ClipBlow, weapon?: HeldWeapon): number {
  const key = `${blow.clip}|${blow.effector}|${blow.within?.join(',') ?? ''}|${weapon ? `${weapon.spec.assetId}:${weapon.scale}` : ''}`
  return cached(key, () => {
    const clip = mocapClip(blow.clip)!
    const [f0, f1] = frames(clip, blow.within)
    if (f0 === f1) return f0 / clip.fps
    const m = sourceOf(clip)
    const dims = personDims(clip.source)
    const hand = blow.effector === 'handL' ? 'L' : 'R'
    const reach: number[] = []
    for (let f = f0; f <= f1; f++) {
      const st = { id: blow.clip, t: f / clip.fps }
      const p: V3 = weapon && blow.effector.startsWith('hand')
        ? heldPointLocal(dims, undefined, hand, weapon.spec, weaponContact(weapon.spec, 'strike'), weapon.scale, st)
        : effectorsOf(m, poseFramesOf(m, mocapClipPose(m, st)!))[blow.effector]
      reach.push(-p.z)
    }
    const peak = Math.max(...reach)
    let k = reach.indexOf(peak)
    while (k > 0 && reach[k - 1]! >= peak - PLATEAU) k--
    return (f0 + k) / clip.fps
  })
}

/** Where on a pose a part has moved from the clip's first frame (entity-local, root travel out). */
function displacement(clip: MocapClip, f: number, parts: Effector[]): number {
  const m = sourceOf(clip)
  const e0 = effectorsOf(m, poseFramesOf(m, mocapClipPose(m, { id: clip.id, t: 0 })!))
  const e = effectorsOf(m, poseFramesOf(m, mocapClipPose(m, { id: clip.id, t: f / clip.fps })!))
  return Math.max(...parts.map((p) => Math.hypot(e[p].x - e0[p].x, e[p].y - e0[p].y, e[p].z - e0[p].z)))
}

/** The clip second a defense meets the blow: the guard hands' (a dodge's head's) furthest move, the first frame of its plateau. */
export function defenseReadyTime(clipId: string): number {
  return cached(`ready|${clipId}`, () => {
    const clip = mocapClip(clipId)!
    const parts: Effector[] = clipId === 'dodge' ? ['head'] : ['handL', 'handR']
    const d = Array.from({ length: clip.frames }, (_, f) => displacement(clip, f, parts))
    const peak = Math.max(...d)
    let k = d.indexOf(peak)
    while (k > 0 && d[k - 1]! >= peak - PLATEAU) k--
    return k / clip.fps
  })
}

/** A reaction starts moving when a part has moved this far from its first frame (m). */
const ONSET = 0.02

/** The clip second a reaction starts (the blow lands a frame before it moves): a KO stands a moment first. */
export function reactionOnset(clipId: string): number {
  return cached(`onset|${clipId}`, () => {
    const clip = mocapClip(clipId)!
    for (let f = 0; f < clip.frames; f++) if (displacement(clip, f, ['head', 'chest', 'handL', 'handR']) > ONSET) return Math.max(0, f - 1) / clip.fps
    return 0
  })
}

/** The clip second a fall lands: the hips within a tenth of their full drop. */
export function fallLandTime(clipId: string): number {
  return cached(`land|${clipId}`, () => {
    const clip = mocapClip(clipId)!
    const y = Array.from({ length: clip.frames }, (_, f) => clip.hips[3 * f + 1]!)
    const lo = Math.min(...y)
    const drop = y[0]! - lo
    const k = y.findIndex((v) => v <= lo + 0.1 * drop)
    return Math.max(0, k) / clip.fps
  })
}

/** How far a clip's root travels backward (+Z, source metres) from clip second `a` to `t`, as a share of its travel to `b` (0 → 1, clamped). */
export function backTravel(clipId: string, a: number, b: number, t: number, mirror = false): number {
  const clip = mocapClip(clipId)!
  const z = (s: number): number => clipSample(clip, s, mirror).root.z
  const total = z(b) - z(a)
  if (total < 1e-3) return b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 1
  return Math.min(1, Math.max(0, (z(t) - z(a)) / total))
}

/* ------------------------- reactions and defenses ------------------------- */

/** A clip a bot reacts or defends with, mirrored or as captured. */
export interface ClipPick {
  id: string
  mirror: boolean
}

/**
 * The clip a bot reacts to a landed blow with, or null (the library lacks
 * it: keyframes). `side` is the side of the defender the blow lands on, so
 * the head and body always go away from it. Head: an uppercut takes
 * `hitUppercut`, a staggering blow `hitHeadBig`, else `hitHeadLeft` (a left
 * punch's: it lands on the right side) or `hitHeadRight`; body: pushes the
 * shove reaction, lateral blows the side hit (captured from the left,
 * mirrored for the right), the rest the stomach hit; legs the side hit. A
 * knockdown is `knockedDown`; a KO falls back (`koBack`), or onto its front
 * when the push is toward the defender's front (`koStomach`).
 */
export function reactionClip(o: { result: 'hit' | 'stagger' | 'knockdown'; ko: boolean; zone: Zone; moveId: string; side: 'L' | 'R'; pushFront?: boolean }): ClipPick | null {
  let id: string
  let mirror = false
  if (o.result === 'knockdown') id = o.ko ? (o.pushFront ? 'koStomach' : 'koBack') : 'knockedDown'
  else if (o.zone === 'head') id = o.moveId === 'uppercut' ? 'hitUppercut' : o.result === 'stagger' ? 'hitHeadBig' : o.side === 'R' ? 'hitHeadLeft' : 'hitHeadRight'
  else if (o.zone === 'body' && PUSHES.has(o.moveId)) id = 'shoveReact'
  else if (o.zone === 'body' && !LATERAL.has(o.moveId)) id = 'hitStomach'
  else {
    id = 'hitSide'
    mirror = o.side === 'R'
  }
  return mocapClip(id) ? { id, mirror } : null
}

/**
 * The clip a bot defends with, or null: blocks and parries by height (a
 * blade or shield in hand: the sword-and-shield block, the shield in the
 * left hand as captured), slips and ducks the dodge. `side` is where the
 * blow comes in: the head block leans away from a blow on the right and the
 * dodge slips away from one on the left, as captured; the other side
 * mirrors them. Fork (fight-polish): bare hands take a head blow on the
 * shell, `blockBody`'s guard frame (both forearms up in front of the face;
 * `blockHead` meets it ducked half a metre aside, the face bare), its outer
 * hand (the left, as captured) on the side the blow comes in; a hand
 * holding a blade, club or shaft (`armed.weapon`) keeps `blockHead`.
 */
export function defenseClip(outcome: 'block' | 'parry' | 'slip' | 'duck', high: boolean, side: 'L' | 'R', armed?: { shieldHand?: 'L' | 'R'; weapon?: boolean }): ClipPick | null {
  let id: string
  let mirror: boolean
  if (outcome === 'slip' || outcome === 'duck') {
    id = 'dodge'
    mirror = side === 'R'
  }
  else if (armed?.shieldHand) {
    id = 'swordBlocked'
    mirror = armed.shieldHand === 'R'
  }
  else if (high && !armed?.weapon && mocapClip('blockBody')) {
    id = 'blockBody'
    mirror = side === 'R'
  }
  else {
    id = high ? 'blockHead' : 'blockBody'
    mirror = high && side === 'L'
  }
  return mocapClip(id) ? { id, mirror } : null
}

/** The library clip a bot gets up with after a knockdown, or null. */
export function getUpClip(): string | null {
  return mocapClip('getUpKnockdown') ? 'getUpKnockdown' : null
}
