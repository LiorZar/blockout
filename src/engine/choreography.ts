// Modified in this fork (2026): the floor rule (floor.ts) on posed marks, and motion marks are posed moves, root channels mirror, routines recast to chosen bodies, mocap clip runs on bots, the chase on tracks (chase-tracks.ts), routines kept on the set (routine-set.ts); see MODIFICATIONS.md.
/**
 * Choreography engine: routines that read as REAL staged choreography —
 * timed dance phrases hit on the count and change formation with real walking;
 * fights are paired exchanges where a reaction lands just after each attack and
 * fighters stay in punching range; chases are near-miss beats along a serpentine
 * path with a closing gap. Not random loops.
 *
 * PURE module (no DOM/three/Electron). Deterministic: all variation comes from a
 * seeded mulberry32 PRNG whose seed lives on the RoutineSpec (surfaced in the UI;
 * the renderer, not this engine, picks a default random seed). Output is a list
 * of per-performer specs compatible with how `sequences.ts` builds tracks/marks
 * today — each mark carries a position, gait, per-joint pose and (new here) an
 * optional facing (`arriveHeading`) so beats can face a target.
 *
 * See `motions.ts` for the joint sign conventions this module relies on.
 */

import { MOTION_PRESETS, type MotionPreset } from './motions'
import { bodyLowY, motionRootY, type Body } from './floor'
import type { GaitId, MarkClip } from './types'
import { clipPlays, copyTag, playOf, playsClips, tagPlay } from './mocap/library-clips'
import { chaseOnTracks } from './chase-tracks'
import { fitGroup, isSet, nearestSolid, type GroupLayout, type RoutineSet } from './routine-set'

/* ----------------------------- public model ---------------------------- */

export type ChoreoKind = 'dance' | 'fight' | 'chase'
export type FormationId = 'line' | 'twoRows' | 'vShape' | 'circle' | 'diamond'
export type DanceStyle = 'hiphop' | 'party' | 'latin' | 'robot' | 'mixed'
export type FightStyle = 'brawl' | 'martial-arts' | 'sparring'
export type FightEnding = 'sparring' | 'finish'
export type ChaseEnding = 'caught' | 'escape'

export interface RoutineSpec {
  kind: ChoreoKind
  /** How many performers (clamped per kind). */
  performers: number
  /** Shot seconds to fill. */
  durationS: number
  /** PRNG seed — same seed + spec ⇒ byte-identical marks. */
  seed: number
  /** Dance tempo (beats/min). Default 116. Fight/chase use `beatDur`. */
  bpm?: number
  /** Explicit beat length (s) for fight (~0.55) / chase (~0.5). */
  beatDur?: number
  /** Dance vocabulary / fight style. */
  style?: DanceStyle | FightStyle | string
  /** Dance starting formation. */
  formation?: FormationId
  /** Dance: performer i offset by i×2 counts (wave). */
  canon?: boolean
  /** Dance: odd performers mirrored (fight: mirror stances). */
  mirror?: boolean
  /** Dance: walk to a fresh formation between phrases. */
  formationChange?: boolean
  /** Fight: 'sparring' (loser gets up) | 'finish' (stays down).
   *  Chase: 'caught' | 'escape'. */
  ending?: FightEnding | ChaseEnding | string
  /** Chase serpentine sideways amplitude (m). Default 4. */
  amplitude?: number
  /** Fork: [man's, woman's] body — the assets the routine casts instead of person.man / person.woman. */
  bodies?: [string, string]
}

export interface RoutineCtx {
  /** Where to stage it and which way the group faces/travels. */
  origin: { x: number; z: number; heading: number }
  /** Fork: the performers' own bodies (retargeted people), for the floor rule. */
  bodies?: Body[]
  /** Fork (set-routines): the set the routine stays on (routine-set.ts); notes say what moved, warnings what doesn't fit. */
  set?: RoutineSet
  notes?: string[]
  warnings?: string[]
}

/** A single blocking mark for one performer (superset of the sequence mark). */
export interface ChoreoMarkSpec {
  time: number
  position: { x: number; y: number; z: number }
  gait: GaitId
  easeIn: number
  easeOut: number
  hold: number
  joints?: Record<string, number>
  /** Face this heading at/through this mark; else travel heading is used. */
  arriveHeading?: number
  /** Fork: a motion-playback mark (types.ts `ActorMark.posedMove`). */
  posedMove?: boolean
  /** Fork: a mocap clip run's mark on a bot (types.ts `ActorMark.clip`). */
  clip?: MarkClip
  /** Fork (qa-fixes): a pose riding a travel gait (a chase beat over the run): the gait grounds it, so the floor rule leaves its height. */
  ride?: boolean
}

export interface ChoreoEntitySpec {
  assetId: string
  name: string
  position: { x: number; y: number; z: number }
  rotationY: number
  label?: { text: string; color: string }
  marks: ChoreoMarkSpec[]
}

/** Keep the timeline sane even for long routines. */
const MAX_MARKS_PER_ENTITY = 160
const SPACING = 1.4
const FIGHT_RANGE = 1.2

/* ------------------------------ seeded rng ----------------------------- */

/** mulberry32 — tiny, fast, fully deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length]!
const randInt = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))

/* ---------------------------- geometry utils --------------------------- */

/** Rotate a local offset (right=+lx, forward=+lz) into world space. */
function place(
  origin: { x: number; z: number; heading: number },
  lx: number,
  lz: number
): { x: number; z: number } {
  const cos = Math.cos(origin.heading)
  const sin = Math.sin(origin.heading)
  return { x: origin.x + lx * cos - lz * sin, z: origin.z - lx * sin - lz * cos }
}

/** Heading that makes an entity at `from` face `to` (0 faces −Z). */
function facingTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

/** Forward unit vector for a heading (0 faces −Z). */
function forwardOf(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: -Math.cos(heading) }
}

const dist2 = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z)

/* ------------------------------- motions ------------------------------- */

const BY_ID: Map<string, MotionPreset> = new Map(MOTION_PRESETS.map((p) => [p.id, p]))
const motion = (id: string): MotionPreset | undefined => BY_ID.get(id)

/** First existing id from a preference list (lets vocab tolerate renames). */
function firstOf(ids: readonly string[]): MotionPreset | undefined {
  for (const id of ids) {
    const m = BY_ID.get(id)
    if (m) return m
  }
  return undefined
}

/** L/R joint pairs swapped when mirroring a pose. */
const LR_PAIRS: readonly [string, string][] = [
  ['shoulderLX', 'shoulderRX'],
  ['shoulderLZ', 'shoulderRZ'],
  ['elbowL', 'elbowR'],
  ['hipLX', 'hipRX'],
  ['hipLZ', 'hipRZ'],
  ['kneeL', 'kneeR'],
  ['handL', 'handR'] // fork: fists (renderer/mocap)
]
/** Twist/lean channels whose sign flips under a mirror. */
const NEGATE_ON_MIRROR = new Set(['torsoY', 'headY', 'torsoZ', 'headZ', 'rootY', 'rootZ']) // fork: root yaw / roll

/**
 * Mirror a pose: swap L/R joint values and negate the twist/lean channels so a
 * mirrored performer is the visual reflection of the original.
 */
export function mirrorJoints(joints: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...joints }
  for (const [l, r] of LR_PAIRS) {
    const lv = joints[l]
    const rv = joints[r]
    if (lv !== undefined) out[r] = lv
    if (rv !== undefined) out[l] = rv
    if (lv === undefined) delete out[r]
    if (rv === undefined) delete out[l]
  }
  for (const k of NEGATE_ON_MIRROR) if (out[k] !== undefined) out[k] = -out[k]
  return out
}

interface PlayOpts {
  facing?: number
  mirror?: boolean
  gait?: GaitId
  /** Fork: a strike's target this far ahead (a bot's keyframe lunge stops short of it: mocap/library-clips.ts). */
  reach?: number
}

/**
 * Lay one play of a motion preset down as marks starting at `startT`, rooted at
 * `pos`, with `move.forward` applied along `facing`. Returns the end time.
 */
function playMotion(
  marks: ChoreoMarkSpec[],
  preset: MotionPreset,
  pos: { x: number; y: number; z: number },
  startT: number,
  opts: PlayOpts = {}
): number {
  const fwd = opts.facing !== undefined ? forwardOf(opts.facing) : { x: 0, z: 0 }
  // Fork: one play, which a bot plays as a clip run (mocap/library-clips.ts).
  const play = { presetId: preset.id, pos: { ...pos }, heading: opts.facing, startT, endT: startT + preset.duration, mirror: opts.mirror, ...(opts.reach !== undefined ? { reach: opts.reach } : {}) }
  for (const kf of preset.keyframes) {
    if (marks.length >= MAX_MARKS_PER_ENTITY) break
    const forward = kf.move?.forward ?? 0
    const up = kf.move?.up ?? 0
    marks.push(tagPlay(play, {
      time: startT + kf.t,
      position: {
        x: pos.x + fwd.x * forward,
        y: pos.y + up, // fork: raw; `floorRoutine` applies the floor rule
        z: pos.z + fwd.z * forward
      },
      gait: opts.gait ?? 'stand',
      easeIn: 0,
      easeOut: 0,
      hold: 0,
      joints: opts.mirror ? mirrorJoints(kf.joints) : { ...kf.joints },
      arriveHeading: opts.facing,
      posedMove: true // fork: motion playback
    }))
  }
  return startT + preset.duration
}

/** Loop a motion to fill [startT, endT) seamlessly (dance grooves). */
function playLooped(
  marks: ChoreoMarkSpec[],
  preset: MotionPreset,
  pos: { x: number; y: number; z: number },
  startT: number,
  endT: number,
  opts: PlayOpts = {}
): void {
  let t = startT
  const cycle = Math.max(0.2, preset.duration)
  const play = { presetId: preset.id, pos: { ...pos }, heading: opts.facing, startT, endT, mirror: opts.mirror } // fork: one clip run on a bot
  while (t < endT - 1e-6 && marks.length < MAX_MARKS_PER_ENTITY) {
    for (const kf of preset.keyframes) {
      const time = t + kf.t
      if (time > endT + 1e-6 || marks.length >= MAX_MARKS_PER_ENTITY) break
      const up = kf.move?.up ?? 0
      marks.push(tagPlay(play, {
        time,
        position: { x: pos.x, y: pos.y + up, z: pos.z }, // fork: raw, see floorRoutine
        gait: opts.gait ?? 'stand',
        easeIn: 0,
        easeOut: 0,
        hold: 0,
        joints: opts.mirror ? mirrorJoints(kf.joints) : { ...kf.joints },
        arriveHeading: opts.facing,
        posedMove: true // fork: motion playback
      }))
    }
    t += cycle
  }
}

/* =============================== DANCE ================================== */

const DANCE_VOCAB: Record<DanceStyle, string[]> = {
  hiphop: ['top-rock', 'running-man', 'shuffle-step', 'dab', 'floss-dance', 'body-roll', 'chest-pop', 'c-walk'],
  party: ['groove-loop', 'arms-up-party', 'disco-point', 'shoulder-bounce', 'raise-the-roof', 'clap-groove', 'macarena', 'shopping-cart'],
  latin: ['salsa-step', 'hip-sway-groove', 'two-step', 'grapevine', 'charleston', 'slow-sway-partner'],
  robot: ['robot', 'robot-wave', 'arm-wave', 'vogue-frames', 'chest-pop', 'dab'],
  mixed: ['groove-loop', 'top-rock', 'salsa-step', 'robot', 'running-man', 'hip-sway-groove', 'shuffle-step', 'disco-point', 'body-roll', 'two-step']
}
const FREEZE_MOVES = ['spin-freeze', 'breakdance-freeze', 'vogue-frames', 'dab']

const FORMATION_ORDER: FormationId[] = ['line', 'twoRows', 'vShape', 'diamond', 'circle']

/** Local (right, forward) formation positions for n performers, spacing 1.4m. */
function formationPositions(id: FormationId, n: number): { lx: number; lz: number }[] {
  const out: { lx: number; lz: number }[] = []
  const s = SPACING
  switch (id) {
    case 'line': {
      for (let i = 0; i < n; i++) out.push({ lx: (i - (n - 1) / 2) * s, lz: 0 })
      break
    }
    case 'twoRows': {
      const front = Math.ceil(n / 2)
      for (let i = 0; i < n; i++) {
        const row = i < front ? 0 : 1
        const idxInRow = i < front ? i : i - front
        const rowN = row === 0 ? front : n - front
        out.push({ lx: (idxInRow - (rowN - 1) / 2) * s, lz: -row * s * 1.4 })
      }
      break
    }
    case 'vShape': {
      // Alternate arms of a V opening toward the front (−lz), apex at back.
      for (let i = 0; i < n; i++) {
        const rank = Math.floor(i / 2) + 1
        const side = i % 2 === 0 ? -1 : 1
        out.push({ lx: side * rank * s * 0.8, lz: -rank * s * 0.8 + n * 0.05 })
      }
      break
    }
    case 'diamond': {
      // Ring on a rotated square perimeter.
      const r = s * (0.9 + n * 0.11)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / 4
        out.push({ lx: Math.cos(a) * r, lz: Math.sin(a) * r })
      }
      break
    }
    case 'circle': {
      const r = Math.max(s, (s * n) / (2 * Math.PI))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        out.push({ lx: Math.sin(a) * r, lz: -Math.cos(a) * r })
      }
      break
    }
  }
  return out
}

function danceRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  const rng = mulberry32(spec.seed)
  const n = Math.max(1, Math.min(40, Math.round(spec.performers)))
  const bpm = spec.bpm && spec.bpm > 0 ? spec.bpm : 116
  const beatDur = 60 / bpm
  const phraseDur = 8 * beatDur
  const facing = ctx.origin.heading
  const styleKey: DanceStyle = (['hiphop', 'party', 'latin', 'robot', 'mixed'] as DanceStyle[]).includes(
    spec.style as DanceStyle
  )
    ? (spec.style as DanceStyle)
    : 'mixed'
  const vocab = DANCE_VOCAB[styleKey].filter((id) => BY_ID.has(id))
  const vocabSafe = vocab.length > 0 ? vocab : ['groove-loop'].filter((id) => BY_ID.has(id))

  const startFormation: FormationId = spec.formation ?? 'line'
  let currentPos = formationPositions(startFormation, n)

  const nPhrases = Math.max(1, Math.round(spec.durationS / phraseDur))

  // Per-performer marks + a running record of their current local formation slot.
  const marks: ChoreoMarkSpec[][] = Array.from({ length: n }, () => [])
  const world = (slot: { lx: number; lz: number }): { x: number; y: number; z: number } => {
    const p = place(ctx.origin, slot.lx, slot.lz)
    return { x: p.x, y: 0, z: p.z }
  }

  let formStep = 0
  for (let ph = 0; ph < nPhrases; ph++) {
    const phraseStart = ph * phraseDur
    const isLast = ph === nPhrases - 1

    // Formation change (except before the first phrase): walk over the first
    // 4 counts, then dance the remaining 4 counts in the new formation.
    let danceStart = phraseStart
    if (spec.formationChange && ph > 0 && n > 1) {
      formStep++
      const nextFormation = FORMATION_ORDER[formStep % FORMATION_ORDER.length]!
      const nextPos = formationPositions(nextFormation, n)
      const walkEnd = phraseStart + 4 * beatDur
      for (let i = 0; i < n; i++) {
        const from = world(currentPos[i]!)
        const to = world(nextPos[i]!)
        // A real walk mark: gait carries them there facing their travel dir.
        // Arrive a beat-fraction early so the dancer settles before the count
        // (and the arrival never collides with the first on-count dance mark).
        marks[i]!.push({
          time: walkEnd - 0.06,
          position: to,
          gait: dist2(from, to) > 0.05 ? 'walk' : 'stand',
          easeIn: 0.2,
          easeOut: 0.2,
          hold: 0,
          arriveHeading: facing
        })
      }
      currentPos = nextPos
      danceStart = walkEnd
    }

    // Pick 2–4 moves spanning 2/4/8 counts to fill this phrase's dance window.
    const moves: { preset: MotionPreset; span: number }[] = []
    let countsFilled = Math.round(((danceStart - phraseStart) / beatDur))
    const spanChoices = [2, 4, 8]
    while (countsFilled < 8) {
      const remaining = 8 - countsFilled
      const span = pick(rng, spanChoices.filter((s) => s <= remaining))
      const isFinalMove = isLast && countsFilled + span >= 8
      // On the last phrase, end on a freeze-friendly move that reads held.
      const chosenId = isFinalMove ? (FREEZE_MOVES.find((id) => BY_ID.has(id)) ?? vocabSafe[0]!) : pick(rng, vocabSafe)
      const preset = motion(chosenId) ?? motion(vocabSafe[0]!)!
      moves.push({ preset, span })
      countsFilled += span
    }

    // Emit each move, synchronized across performers (canon/mirror per option).
    let cursor = danceStart
    for (const mv of moves) {
      const moveStart = cursor
      const moveEnd = cursor + mv.span * beatDur
      for (let i = 0; i < n; i++) {
        const canonOffset = spec.canon ? i * 2 * beatDur : 0
        const s0 = moveStart + canonOffset
        if (s0 >= moveEnd) continue
        const mirror = spec.mirror ? i % 2 === 1 : false
        const pos = world(currentPos[i]!)
        playLooped(marks[i]!, mv.preset, pos, s0, moveEnd, { facing, mirror })
      }
      cursor = moveEnd
    }

    // Final phrase: hold the freeze pose on the last count.
    if (isLast) {
      const freeze = firstOf(FREEZE_MOVES) ?? motion(vocabSafe[0]!)!
      const holdPose = freeze.keyframes[freeze.keyframes.length - 1]!
      const endT = Math.min(phraseStart + phraseDur, spec.durationS) // fork: never past the Duration
      for (let i = 0; i < n; i++) {
        const mirror = spec.mirror ? i % 2 === 1 : false
        const pos = world(currentPos[i]!)
        marks[i]!.push({
          time: endT,
          position: pos,
          gait: 'stand',
          easeIn: 0,
          easeOut: 0,
          hold: 0.3,
          joints: mirror ? mirrorJoints(holdPose.joints) : { ...holdPose.joints },
          arriveHeading: facing
        })
      }
    }
  }

  const out: ChoreoEntitySpec[] = []
  const start = formationPositions(startFormation, n)
  for (let i = 0; i < n; i++) {
    const p = world(start[i]!)
    out.push({
      assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
      name: `Dancer ${i + 1}`,
      position: p,
      rotationY: facing,
      marks: dedupeSort(marks[i]!.filter((m) => m.time <= spec.durationS + 1e-9)) // fork: the freeze lands on the Duration
    })
  }
  return out
}

/* =============================== FIGHT ================================== */

/** ATTACK id → ordered candidate REACTION ids (blocks first, then hits). */
const COMPAT: Record<string, string[]> = {
  'hook-punch': ['duck-under', 'hit-reaction-head'],
  'jab-cross': ['block-high', 'weave-bob', 'hit-reaction-head'],
  'jab-hook-cross': ['block-high', 'weave-bob', 'hit-reaction-head'],
  'front-kick': ['block-low', 'hit-reaction-body', 'stagger-back'],
  'teep-push-kick': ['block-low', 'stagger-back'],
  'side-kick': ['block-low', 'stagger-back', 'hit-reaction-body'],
  'low-sweep': ['jump', 'trip-and-fall-flat'],
  haymaker: ['duck-under', 'ko-collapse'],
  'knee-strike': ['hit-reaction-body'],
  'elbow-strike': ['hit-reaction-head', 'stagger-back'],
  'roundhouse-kick': ['block-high', 'stagger-back', 'hit-reaction-head'],
  'spinning-back-kick': ['stagger-back', 'knockdown-fall'],
  'spinning-back-fist': ['duck-under', 'hit-reaction-head'],
  'tackle-lunge': ['dodge-left', 'dodge-right', 'knockdown-fall'],
  'shove-two-hands': ['stagger-back']
}

/** Reactions that are pure defense (no ground/pushback). */
const BLOCK_REACTIONS = new Set([
  'block-high',
  'block-low',
  'parry-deflect',
  'weave-bob',
  'duck-under',
  'dodge-left',
  'dodge-right',
  'shield-brace',
  'jump'
])

/** How far a reaction shoves the defender backward (m). */
const PUSHBACK: Record<string, number> = {
  'stagger-back': 0.6,
  'knockdown-fall': 1.2,
  'ko-collapse': 1.2,
  'trip-and-fall-flat': 0.9,
  'thrown-backward': 1.5
}

const ATTACK_POOL: Record<FightStyle, string[]> = {
  brawl: ['haymaker', 'hook-punch', 'shove-two-hands', 'tackle-lunge', 'elbow-strike'],
  'martial-arts': ['front-kick', 'side-kick', 'spinning-back-kick', 'knee-strike', 'low-sweep', 'roundhouse-kick'],
  sparring: ['jab-cross', 'hook-punch', 'front-kick', 'jab-hook-cross']
}
const CLIMAX_ATTACK: Record<FightStyle, string> = {
  brawl: 'haymaker',
  'martial-arts': 'spinning-back-kick',
  sparring: 'hook-punch'
}

type Phase = 'probing' | 'combos' | 'climax' | 'resolution'
function phaseAt(t: number, dur: number): Phase {
  const f = t / dur
  if (f < 0.3) return 'probing'
  if (f < 0.7) return 'combos'
  if (f < 0.9) return 'climax'
  return 'resolution'
}

/** Snap a time up to the next beat-grid count. */
const snapCount = (t: number, beatDur: number): number => Math.ceil(t / beatDur - 1e-9) * beatDur

interface Fighter {
  pos: { x: number; y: number; z: number }
  marks: ChoreoMarkSpec[]
}

/**
 * One attack beat: attacker steps to range, fires; defender reacts a beat-third
 * later (reads as contact) and is shoved back per the reaction. Enforces the
 * fighting-range invariant at the attack instant.
 */
function attackBeat(
  atk: Fighter,
  def: Fighter,
  attackId: string,
  reactionId: string,
  t: number,
  beatDur: number,
  mirror: boolean
): number {
  const attack = motion(attackId)
  const react = motion(reactionId)
  if (!attack || !react) return t
  // Attacker closes to fighting range along the line to the defender.
  const toDef = facingTo(atk.pos, def.pos)
  const fwd = forwardOf(toDef)
  atk.pos = { x: def.pos.x - fwd.x * FIGHT_RANGE, y: 0, z: def.pos.z - fwd.z * FIGHT_RANGE }
  // Advance mark (quick step-in) just before the strike so the close reads.
  atk.marks.push({
    time: Math.max(0, t - beatDur * 0.4),
    position: { ...atk.pos },
    gait: 'walk',
    easeIn: 0,
    easeOut: 0.3,
    hold: 0,
    arriveHeading: toDef
  })
  const atkFace = facingTo(atk.pos, def.pos)
  const defFace = facingTo(def.pos, atk.pos)
  playMotion(atk.marks, attack, atk.pos, t, { facing: atkFace, mirror, reach: FIGHT_RANGE })
  // Reaction lands mid-attack.
  const reactT = t + beatDur * 0.35
  const reactEnd = playMotion(def.marks, react, def.pos, reactT, { facing: defFace })
  // Shove the defender back along the away axis and RECORD the travel, so the
  // defender's timeline and stored position stay in sync (the next attacker
  // steps to the shoved-back spot, keeping fighting range honest).
  const push = PUSHBACK[reactionId] ?? 0
  if (push > 0) {
    const away = forwardOf(defFace) // defender's forward points AT attacker…
    def.pos = { x: def.pos.x + away.x * -push, y: 0, z: def.pos.z + away.z * -push }
    def.marks.push({
      time: reactEnd,
      position: { ...def.pos },
      gait: 'stand',
      easeIn: 0,
      easeOut: 0,
      hold: 0,
      arriveHeading: defFace
    })
  }
  const slot = Math.max(attack.duration, react.duration + beatDur * 0.35)
  return snapCount(t + slot, beatDur)
}

/** Both fighters bounce on guard + circle a little between exchanges. */
function guardBreather(
  a: Fighter,
  b: Fighter,
  t: number,
  counts: number,
  beatDur: number,
  angle: number
): number {
  const bounce = firstOf(['boxing-guard-bounce', 'boxing-bounce-drill'])
  const endT = t + counts * beatDur
  // Rotate both a touch around their midpoint (circling footwork).
  const mid = { x: (a.pos.x + b.pos.x) / 2, z: (a.pos.z + b.pos.z) / 2 }
  const rot = (p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
    const dx = p.x - mid.x
    const dz = p.z - mid.z
    return {
      x: mid.x + dx * Math.cos(angle) - dz * Math.sin(angle),
      y: 0,
      z: mid.z + dx * Math.sin(angle) + dz * Math.cos(angle)
    }
  }
  a.pos = rot(a.pos)
  b.pos = rot(b.pos)
  const aFace = facingTo(a.pos, b.pos)
  const bFace = facingTo(b.pos, a.pos)
  if (bounce) {
    playLooped(a.marks, bounce, a.pos, t, endT, { facing: aFace })
    playLooped(b.marks, bounce, b.pos, t, endT, { facing: bFace })
  } else {
    a.marks.push({ time: endT, position: { ...a.pos }, gait: 'stand', easeIn: 0, easeOut: 0, hold: 0, arriveHeading: aFace })
    b.marks.push({ time: endT, position: { ...b.pos }, gait: 'stand', easeIn: 0, easeOut: 0, hold: 0, arriveHeading: bFace })
  }
  return endT
}

function fightRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  const n = Math.max(2, Math.min(8, Math.round(spec.performers)))
  if (n >= 3) return oneVsManyRoutine(spec, ctx, n)

  const rng = mulberry32(spec.seed)
  const beatDur = spec.beatDur && spec.beatDur > 0 ? spec.beatDur : 0.55
  const style: FightStyle = (['brawl', 'martial-arts', 'sparring'] as FightStyle[]).includes(spec.style as FightStyle)
    ? (spec.style as FightStyle)
    : 'brawl'
  const ending: FightEnding = spec.ending === 'sparring' || style === 'sparring' ? 'sparring' : 'finish'
  const dur = spec.durationS

  const aStart = place(ctx.origin, -FIGHT_RANGE / 2, 0)
  const bStart = place(ctx.origin, FIGHT_RANGE / 2, 0)
  const A: Fighter = { pos: { x: aStart.x, y: 0, z: aStart.z }, marks: [] }
  const B: Fighter = { pos: { x: bStart.x, y: 0, z: bStart.z }, marks: [] }

  let t = 0
  let exchange = 0
  let climaxDone = false
  let loser: 'A' | 'B' | null = null
  const resolutionAt = dur - 2.2

  while (t < resolutionAt && A.marks.length < MAX_MARKS_PER_ENTITY && B.marks.length < MAX_MARKS_PER_ENTITY) {
    const phase = phaseAt(t, dur)
    const attacker = exchange % 2 === 0 ? A : B
    const defender = exchange % 2 === 0 ? B : A
    const mirror = spec.mirror ? exchange % 2 === 1 : false

    if (phase === 'climax' && !climaxDone) {
      const bigId = CLIMAX_ATTACK[style]
      const finisher = ending === 'finish' ? 'ko-collapse' : 'knockdown-fall'
      const react = motion(finisher) ? finisher : 'stagger-back'
      t = attackBeat(attacker, defender, bigId, react, snapCount(t, beatDur), beatDur, mirror)
      climaxDone = true
      loser = defender === A ? 'A' : 'B'
      break
    }

    // How many attacks this exchange (escalation).
    const attacks = phase === 'probing' ? 1 : randInt(rng, 2, 3)
    const pool = ATTACK_POOL[style].filter((id) => motion(id))
    for (let k = 0; k < attacks; k++) {
      const attackId = pick(rng, pool)
      const candidates = (COMPAT[attackId] ?? ['hit-reaction-body']).filter((id) => motion(id))
      const blocks = candidates.filter((id) => BLOCK_REACTIONS.has(id))
      let reactionId: string
      if (phase === 'probing' && blocks.length > 0)
        reactionId = pick(rng, blocks) // probing reads as mostly-blocked
      else reactionId = candidates.length ? pick(rng, candidates) : 'hit-reaction-body'
      t = attackBeat(attacker, defender, attackId, reactionId, snapCount(t, beatDur), beatDur, mirror)
      if (t >= resolutionAt) break
    }
    // Breather + circling between exchanges.
    const breatherCounts = randInt(rng, 2, 4)
    const angle = (rng() - 0.5) * 0.5
    t = guardBreather(A, B, snapCount(t, beatDur), breatherCounts, beatDur, angle)
    exchange++
  }

  // Resolution: winner keeps guard and settles; loser gets up or stays down.
  resolveFight(A, B, loser, ending, t, dur, beatDur)

  const faceAtEnd = { a: facingTo(A.pos, B.pos), b: facingTo(B.pos, A.pos) }
  return [
    {
      assetId: 'person.man',
      name: 'Fighter A',
      position: { x: aStart.x, y: 0, z: aStart.z },
      rotationY: faceAtEnd.a,
      label: { text: 'FIGHTER A', color: '#3b82f6' },
      marks: dedupeSort(A.marks)
    },
    {
      assetId: 'person.woman',
      name: 'Fighter B',
      position: { x: bStart.x, y: 0, z: bStart.z },
      rotationY: faceAtEnd.b,
      label: { text: 'FIGHTER B', color: '#e5484d' },
      marks: dedupeSort(B.marks)
    }
  ]
}

function resolveFight(
  A: Fighter,
  B: Fighter,
  loser: 'A' | 'B' | null,
  ending: FightEnding,
  t: number,
  dur: number,
  beatDur: number
): void {
  const winner = loser === 'A' ? B : A
  const down = loser === 'A' ? A : loser === 'B' ? B : null
  const bounce = firstOf(['boxing-guard-bounce', 'boxing-bounce-drill'])
  const startT = snapCount(t, beatDur)
  if (bounce) playLooped(winner.marks, bounce, winner.pos, startT, dur, { facing: down ? facingTo(winner.pos, down.pos) : facingTo(winner.pos, (loser === 'A' ? A : B).pos) })
  if (down) {
    if (ending === 'sparring') {
      const getUp = motion('get-up-from-ground')
      if (getUp) playMotion(down.marks, getUp, down.pos, Math.max(startT, dur - getUp.duration - 0.1), { facing: facingTo(down.pos, winner.pos) })
    } else {
      // Stays down: hold the collapsed pose to the end.
      const last = down.marks[down.marks.length - 1]
      if (last) down.marks.push({ ...last, time: dur, joints: last.joints ? { ...last.joints } : undefined })
    }
  }
}

/** Movie one-vs-many: hero centre, attackers ring in and take turns. */
function oneVsManyRoutine(spec: RoutineSpec, ctx: RoutineCtx, n: number): ChoreoEntitySpec[] {
  const rng = mulberry32(spec.seed)
  const beatDur = spec.beatDur && spec.beatDur > 0 ? spec.beatDur : 0.55
  const style: FightStyle = (['brawl', 'martial-arts', 'sparring'] as FightStyle[]).includes(spec.style as FightStyle)
    ? (spec.style as FightStyle)
    : 'martial-arts'
  const dur = spec.durationS
  const nAtk = n - 1

  const center = place(ctx.origin, 0, 0)
  const hero: Fighter = { pos: { x: center.x, y: 0, z: center.z }, marks: [] }
  const ringR = Math.max(1.8, 1.4 + nAtk * 0.25)
  const attackers: Fighter[] = []
  const ringPos: { x: number; z: number }[] = []
  for (let i = 0; i < nAtk; i++) {
    const a = (i / nAtk) * Math.PI * 2
    const p = place(ctx.origin, Math.sin(a) * ringR, -Math.cos(a) * ringR)
    ringPos.push(p)
    attackers.push({ pos: { x: p.x, y: 0, z: p.z }, marks: [] })
  }

  const bounce = firstOf(['boxing-guard-bounce', 'boxing-bounce-drill'])
  const pool = ATTACK_POOL[style].filter((id) => motion(id))
  let t = 0
  let turn = 0
  // Idle attackers guard-bounce on the ring; each takes a turn attacking.
  const idleUntil: number[] = new Array(nAtk).fill(0)

  while (t < dur - 1.5) {
    const i = turn % nAtk
    const atk = attackers[i]!
    // Everyone idles on the ring up to now.
    for (let j = 0; j < nAtk; j++) {
      if (j === i) continue
      if (bounce && idleUntil[j]! < t) {
        playLooped(attackers[j]!.marks, bounce, attackers[j]!.pos, idleUntil[j]!, t, { facing: facingTo(attackers[j]!.pos, hero.pos) })
        idleUntil[j] = t
      }
    }
    // This attacker steps in and strikes; hero reacts facing them.
    const attackId = pick(rng, pool)
    const candidates = (COMPAT[attackId] ?? ['hit-reaction-body']).filter((id) => motion(id))
    const reactionId = candidates.length ? pick(rng, candidates) : 'hit-reaction-body'
    const tEnd = attackBeat(atk, hero, attackId, reactionId, snapCount(t, beatDur), beatDur, false)
    // Attacker retreats back to the ring after the strike.
    const home = ringPos[i]!
    atk.pos = { x: home.x, y: 0, z: home.z }
    atk.marks.push({ time: tEnd + beatDur * 0.5, position: { x: home.x, y: 0, z: home.z }, gait: 'walk', easeIn: 0.2, easeOut: 0.2, hold: 0, arriveHeading: facingTo(home, hero.pos) })
    idleUntil[i] = tEnd + beatDur * 0.5
    t = tEnd + beatDur
    turn++
  }
  // Trailing idle for everyone still on the ring.
  for (let j = 0; j < nAtk; j++) {
    if (bounce && idleUntil[j]! < dur) playLooped(attackers[j]!.marks, bounce, attackers[j]!.pos, idleUntil[j]!, dur, { facing: facingTo(attackers[j]!.pos, hero.pos) })
  }

  const out: ChoreoEntitySpec[] = [
    {
      assetId: 'person.man',
      name: 'Hero',
      position: { x: center.x, y: 0, z: center.z },
      rotationY: ctx.origin.heading,
      label: { text: 'HERO', color: '#3b82f6' },
      marks: dedupeSort(hero.marks)
    }
  ]
  for (let i = 0; i < nAtk; i++) {
    const p = ringPos[i]!
    out.push({
      assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
      name: `Attacker ${i + 1}`,
      position: { x: p.x, y: 0, z: p.z },
      rotationY: facingTo(p, hero.pos),
      marks: dedupeSort(attackers[i]!.marks)
    })
  }
  return out
}

/* =============================== CHASE ================================== */

/** Sample a serpentine polyline of world waypoints across the floor. */
function serpentine(
  ctx: RoutineCtx,
  length: number,
  amplitude: number,
  seed: number
): { x: number; z: number }[] {
  const rng = mulberry32(seed ^ 0x9e3779b9)
  const pts: { x: number; z: number }[] = []
  const segs = Math.max(6, Math.round(length / 4))
  const phase = rng() * Math.PI * 2
  const freq = 1.4 + rng() * 0.8
  for (let i = 0; i <= segs; i++) {
    const f = i / segs
    const along = f * length
    const lateral = Math.sin(f * Math.PI * freq + phase) * amplitude
    const p = place(ctx.origin, lateral, -along)
    pts.push({ x: p.x, z: p.z })
  }
  return pts
}

/**
 * Fork (qa-fixes): the chase runs on tracks (`chase-tracks.ts`): every mark
 * off one arc distance per performer, so nothing teleports, the pursuers start
 * behind the runner and nobody runs through anybody.
 */
function chaseRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  return chaseOnTracks(spec, ctx, { serpentine, mulberry32, motion, playMotion, dedupeSort })
}

/* ------------------------------- shared -------------------------------- */

/** Sort marks by time and drop exact time collisions (keep the later push). */
function dedupeSort(marks: ChoreoMarkSpec[]): ChoreoMarkSpec[] {
  const sorted = [...marks].sort((a, b) => a.time - b.time)
  const out: ChoreoMarkSpec[] = []
  for (const m of sorted) {
    const clamped = copyTag(m, { ...m, time: Math.max(0, m.time) }) // fork: keeps its play (mocap clip runs)
    const prev = out[out.length - 1]
    if (prev && Math.abs(prev.time - clamped.time) < 1e-4) out[out.length - 1] = clamped
    else out.push(clamped)
  }
  return out.slice(0, MAX_MARKS_PER_ENTITY)
}

/* -------------------------------- entry -------------------------------- */

/** Style choices offered per kind (for the Choreographer UI). */
export function choreoStyles(kind: ChoreoKind): { id: string; name: string }[] {
  switch (kind) {
    case 'dance':
      return [
        { id: 'mixed', name: 'Mixed' },
        { id: 'hiphop', name: 'Hip-hop' },
        { id: 'party', name: 'Party' },
        { id: 'latin', name: 'Latin' },
        { id: 'robot', name: 'Robot' }
      ]
    case 'fight':
      return [
        { id: 'brawl', name: 'Brawl' },
        { id: 'martial-arts', name: 'Martial arts' },
        { id: 'sparring', name: 'Sparring' }
      ]
    case 'chase':
      return [{ id: 'default', name: 'Foot chase' }]
  }
}

export function choreoEndings(kind: ChoreoKind): { id: string; name: string }[] {
  switch (kind) {
    case 'fight':
      return [
        { id: 'finish', name: 'Finish (loser stays down)' },
        { id: 'sparring', name: 'Sparring (loser gets up)' }
      ]
    case 'chase':
      return [
        { id: 'caught', name: 'Caught' },
        { id: 'escape', name: 'Escape' }
      ]
    case 'dance':
      return [{ id: 'freeze', name: 'Freeze pose' }]
  }
}

export function choreoFormations(): { id: FormationId; name: string }[] {
  return [
    { id: 'line', name: 'Line' },
    { id: 'twoRows', name: 'Two rows' },
    { id: 'vShape', name: 'V-shape' },
    { id: 'diamond', name: 'Diamond' },
    { id: 'circle', name: 'Circle' }
  ]
}

/**
 * Build a full routine — the per-performer marks a store action drops into the
 * active take as one undoable step.
 */
export function buildRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  const specs = routineOf(spec, ctx)
  // Fork: recast before grounding, so posed marks rest each body on the floor.
  if (spec.bodies) for (const e of specs) e.assetId = e.assetId === 'person.man' ? spec.bodies[0] : e.assetId === 'person.woman' ? spec.bodies[1] : e.assetId
  // Fork: a bot plays its motions as clip runs (mocap/library-clips.ts); any other body holds its falls.
  specs.forEach((e, i) => {
    const body = ctx.bodies?.[i] ?? { assetId: e.assetId }
    e.marks = clipPlays(holdFalls(e.marks, body), body, e.rotationY)
  })
  floorRoutine(specs, ctx.bodies)
  return specs
}

/** Reactions that end on the floor. */
const FALLS = new Set(['knockdown-fall', 'ko-collapse', 'trip-and-fall-flat', 'thrown-backward'])

/**
 * Fork (mocap-backlog): after a fall, the routine's plain stand marks (the
 * push-back at its end, a finish's "stays down") hold the fall's last pose
 * as a posed move until the performer's next move, or to the end: the rule a
 * bot follows on its fall clip (`clipPlays`). A body that plays clips keeps
 * its marks.
 */
function holdFalls(marks: ChoreoMarkSpec[], body: Body): ChoreoMarkSpec[] {
  if (playsClips(body)) return marks
  let held: Record<string, number> | undefined
  return marks.map((m) => {
    const play = playOf(m)
    if (play) {
      const fall = FALLS.has(play.presetId) ? motion(play.presetId) : undefined
      const last = fall?.keyframes[fall.keyframes.length - 1]?.joints
      held = last ? (play.mirror ? mirrorJoints(last) : { ...last }) : undefined
      return m
    }
    if (!held || m.joints || m.clip || m.gait !== 'stand') {
      held = undefined
      return m
    }
    return { ...m, joints: { ...held }, posedMove: true }
  })
}

function routineOf(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  switch (spec.kind) {
    case 'dance':
      return danceRoutine(spec, placeOnSet(spec, ctx)) // fork (set-routines)
    case 'fight':
      return fightRoutine(spec, placeOnSet(spec, ctx)) // fork (set-routines)
    case 'chase':
      return chaseRoutine(spec, ctx)
  }
}

/**
 * Fork (set-routines): a dance or a fight stands where it was placed only if
 * every spot it uses is clear of the set; else it moves to the nearest spot
 * that is (routine-set.ts `fitGroup`), and says so.
 */
function placeOnSet(spec: RoutineSpec, ctx: RoutineCtx): RoutineCtx {
  if (!isSet(ctx.set)) return ctx
  const layout = spec.kind === 'dance' ? danceLayout(spec) : fightLayout(spec)
  const fit = fitGroup(ctx.set, ctx.origin, layout)
  const where = ctx.set.name ?? 'the set'
  const at = (o: { x: number; z: number }): string => `(${o.x.toFixed(1)}, ${o.z.toFixed(1)})`
  if (!fit.fits) {
    ctx.warnings?.push(`No clear floor on ${where} for this ${spec.kind} near ${at(ctx.origin)}: it stays where it was placed, into ${nearestSolid(ctx.set, ctx.origin, layout)}.`)
    return ctx
  }
  if (fit.moved > 0.01 || fit.turnedDeg !== 0)
    ctx.notes?.push(`Moved the ${spec.kind} ${fit.moved.toFixed(1)} m to ${at(fit.origin)}${fit.turnedDeg ? `, turned ${Math.abs(fit.turnedDeg)}°` : ''}, so it keeps clear of ${where}.`)
  return { ...ctx, origin: fit.origin }
}

/** Fork (set-routines): every formation spot a dance uses, and the walks between them (`danceRoutine`'s order). */
function danceLayout(spec: RoutineSpec): GroupLayout {
  const n = Math.max(1, Math.min(40, Math.round(spec.performers)))
  const bpm = spec.bpm && spec.bpm > 0 ? spec.bpm : 116
  const phrases = Math.max(1, Math.round(spec.durationS / ((8 * 60) / bpm)))
  const forms: FormationId[] = [spec.formation ?? 'line']
  if (spec.formationChange && n > 1) for (let ph = 1; ph < phrases; ph++) forms.push(FORMATION_ORDER[ph % FORMATION_ORDER.length]!)
  const spots = forms.map((f) => formationPositions(f, n).map((p) => ({ x: p.lx, z: p.lz })))
  return { slots: spots.flat(), walks: spots.slice(1).flatMap((to, k) => to.map((p, i): [{ x: number; z: number }, { x: number; z: number }] => [spots[k]![i]!, p])) }
}

/** Fork (set-routines): a fight's spots: the pair, or the hero and the ring, with room for knockbacks round the middle. */
function fightLayout(spec: RoutineSpec): GroupLayout {
  const n = Math.max(2, Math.min(8, Math.round(spec.performers)))
  const round = (c: { x: number; z: number }, r: number): { x: number; z: number }[] =>
    Array.from({ length: 8 }, (_, i) => ({ x: c.x + Math.sin((i / 8) * Math.PI * 2) * r, z: c.z + Math.cos((i / 8) * Math.PI * 2) * r }))
  if (n === 2) return { slots: [...round({ x: -FIGHT_RANGE / 2, z: 0 }, 1.2), ...round({ x: FIGHT_RANGE / 2, z: 0 }, 1.2)], walks: [] }
  const ringR = Math.max(1.8, 1.4 + (n - 1) * 0.25)
  const ring = Array.from({ length: n - 1 }, (_, i) => ({ x: Math.sin((i / (n - 1)) * Math.PI * 2) * ringR, z: -Math.cos((i / (n - 1)) * Math.PI * 2) * ringR }))
  return { slots: [{ x: 0, z: 0 }, ...round({ x: 0, z: 0 }, 1.2), ...ring], walks: [] }
}

/**
 * Fork: posed marks on the floor (floor.ts rule, the ground at y = 0) with
 * each performer's own body.
 */
function floorRoutine(specs: ChoreoEntitySpec[], bodies: Body[] | undefined): void {
  specs.forEach((e, i) => {
    const body = bodies?.[i] ?? { assetId: e.assetId }
    for (const m of e.marks) {
      if (!m.joints || m.ride) continue
      m.position.y = motionRootY(0, m.position.y, bodyLowY(body, m.joints))
    }
  })
}
