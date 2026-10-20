/**
 * The prompt's scene sections (fork addition; see MODIFICATIONS.md): what
 * each grey shape in the clip stands for, what happens in time order, and
 * what the camera does — so a video model can't misread the blockout.
 *
 *   proxies  one line per visible subject: colour, shape, label → what it is
 *            ("The orange mannequin (A) is a man holding a katana (the green
 *            shape) in the right hand.")
 *   action   staged fights beat by beat (re-solved from their scripts for
 *            each blow's outcome), motion-library moves recognised from the
 *            marks' joints, and travel between marks with its gait and
 *            screen direction; two runners on one line read as a chase
 *   camera   live shot words in order, else the overall move measured from
 *            the evaluated camera (rig, travel, lens change) — never per-leg
 *            pans or tilts (upstream's v5 rule: the clip carries those)
 *
 * `composePrompt` lays the sections out ahead of the look line and the
 * directive, and trims them to the profile's prompt cap.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { assetSpec } from './assets'
import { mirrorJoints } from './choreography'
import { ShotEvaluator } from './evaluate'
import { SHOT_MOVES, strikeImpacts } from './fight/moves'
import { solveFight, type FighterInput } from './fight/solve'
import { MOTION_PRESETS, type MotionPreset } from './motions'
import { clipMotionName } from './mocap/library-clips'
import { LABEL_COLOR_NAMES } from './palette'
import type { ShotSpec } from './shot'
import type { ActorMark, Entity, FightBeat, FightOutcome, GaitId, RigId, Scene, Shot, ShotSizeId, V3 } from './types'
import { heldWeaponWords, weaponSpec } from './weapons'

export interface ShotWords {
  proxies: string[]
  action: string[]
  camera: string[]
}

/** Budget for profiles that don't declare a prompt cap. */
export const DEFAULT_PROMPT_CHARS = 1500
export const ACTION_TRIMMED = 'The rest of the action follows the reference video.'

/* --------------------------------- names --------------------------------- */

/**
 * A label colour as a plain word: the palette's names, else the nearest hue; no
 * colour reads grey. The renderer tints a labelled entity 65 % of the way from
 * its grey toward the label colour, which keeps the label's hue.
 */
export function colorWord(hex: string | undefined): string {
  if (!hex) return 'grey'
  const h = hex.toLowerCase()
  const named = Object.entries(LABEL_COLOR_NAMES).find(([, v]) => v === h)?.[0]
  if (named) return named
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(h)
  if (!m) return 'grey'
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => parseInt(x, 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  if (s < 0.15 || max - min < 0.08) return l > 0.85 ? 'white' : l < 0.15 ? 'black' : 'grey'
  let hue = 0
  if (max === r) hue = 60 * (((g - b) / (max - min)) % 6)
  else if (max === g) hue = 60 * ((b - r) / (max - min) + 2)
  else hue = 60 * ((r - g) / (max - min) + 4)
  if (hue < 0) hue += 360
  const buckets: [number, string][] = [
    [15, 'red'],
    [40, 'orange'],
    [65, 'yellow'],
    [165, 'green'],
    [195, 'teal'],
    [255, 'blue'],
    [290, 'purple'],
    [335, 'pink'],
    [360, 'red']
  ]
  return buckets.find(([edge]) => hue < edge)![1]
}

const VEHICLE_SHAPES: Record<string, string> = {
  'vehicle.plane': 'winged shape',
  'vehicle.boat': 'boat-shaped block',
  'vehicle.train': 'long box',
  'vehicle.bus': 'long box on wheels',
  'vehicle.truck': 'long box on wheels',
  'vehicle.tank': 'box on tracks',
  'vehicle.motorcycle': 'two-wheeled shape',
  'vehicle.bicycle': 'two-wheeled shape'
}

const PRIMITIVE_SHAPES: Record<string, string> = {
  'prim.cube': 'box',
  'prim.cylinder': 'cylinder',
  'prim.ramp': 'ramp',
  'prim.wall': 'wall',
  'prim.stairs': 'block of stairs'
}

/** The studio mannequins and the mocap bots (fork) render as grey plastic mannequins. */
const isMannequin = (e: Entity): boolean => e.assetId.startsWith('person.mannequin') || e.assetId.startsWith('person.mocap')

function shapeWord(e: Entity): string {
  const spec = assetSpec(e.assetId)
  if (isMannequin(e)) return 'mannequin'
  if (spec.category === 'people') return 'figure'
  if (spec.category === 'animals') return spec.motion === 'flying' ? 'winged shape' : 'four-legged shape'
  if (spec.category === 'vehicles') return VEHICLE_SHAPES[e.assetId] ?? 'box on wheels'
  if (spec.category === 'primitives') return PRIMITIVE_SHAPES[e.assetId] ?? 'block'
  return 'shape'
}

/** "box on wheels" → "boxes on wheels", "four-legged shape" → "four-legged shapes". */
function plural(shape: string): string {
  const words = shape.split(' ')
  const i = words.indexOf('on') > 0 ? words.indexOf('on') - 1 : words.length - 1
  const w = words[i]!
  words[i] = /(x|s|ch|sh)$/.test(w) ? `${w}es` : `${w}s`
  return words.join(' ')
}

const bareNoun = (e: Entity): string => assetSpec(e.assetId).promptNoun.replace(/^(a|an|the) /, '')
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a')
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const andList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '')

const IRREGULAR: Record<string, string> = { man: 'men', woman: 'women', child: 'children', person: 'people' }

/** "a man" → "men", "an elderly person" → "elderly people", "a city bus" → "city buses". */
function pluralNoun(noun: string): string {
  const words = noun.replace(/^(a|an|the) /, '').split(' ')
  const w = words[words.length - 1]!
  words[words.length - 1] = IRREGULAR[w] ?? (/(x|s|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`)
  return words.join(' ')
}

/** A third-person verb phrase for several subjects: "dances the robot" → "dance the robot". */
function pluralPhrase(phrase: string): string {
  const [verb, ...rest] = phrase.split(' ')
  const v = verb === 'does' ? 'do' : verb === 'flies' ? 'fly' : verb!.replace(/s$/, '')
  return [v, ...rest].join(' ')
}

/** The colour an entity renders: its label's (tinted toward it), else the builder's grey plastic. */
function renderedColor(e: Entity): string {
  if (e.label?.color) return colorWord(e.label.color)
  return isMannequin(e) ? 'light grey' : 'grey'
}

/** How the action refers to an entity: its label, else "the orange man" / "the man". */
function nameOf(e: Entity): string {
  const text = e.label?.text?.trim()
  if (text) return text
  return e.label?.color ? `the ${colorWord(e.label.color)} ${bareNoun(e)}` : `the ${bareNoun(e)}`
}

/** Several subjects at once: labels by name, unlabelled look-alikes counted ("A, B and 3 men"). */
function groupName(members: Entity[]): string {
  const parts: string[] = []
  const counts = new Map<string, number>()
  for (const e of members) {
    if (e.label?.text?.trim()) parts.push(nameOf(e))
    else counts.set(nameOf(e), (counts.get(nameOf(e)) ?? 0) + 1)
  }
  for (const [name, n] of counts) parts.push(n === 1 ? name : `${n} ${pluralNoun(name)}`)
  return andList(parts)
}

function heldBy(scene: Scene, holder: Entity): Entity[] {
  return scene.entities.filter((w) => w.heldBy?.entityId === holder.id && !!weaponSpec(w.assetId) && !w.excludeFromExport)
}

/* --------------------------------- proxies -------------------------------- */

function proxyLine(scene: Scene, e: Entity): string | null {
  const spec = assetSpec(e.assetId)
  const color = renderedColor(e)
  const name = e.label?.text?.trim()
  const shape = shapeWord(e)
  if (spec.category === 'primitives' || spec.category === 'custom') {
    return name ? `The ${color} ${shape} stands for "${name}".` : null
  }
  // "a sword (the green shape) in A's right hand", as weapons.ts words it.
  const held = heldBy(scene, e)
    .map((w) => heldWeaponWords(w, scene.entities))
    .filter((w): w is string => !!w)
  const holding = held.length > 0 ? ` holding ${held.join(' and ')}` : ''
  return `The ${color} ${shape}${name ? ` (${name})` : ''} is ${spec.promptNoun}${holding}.`
}

function proxyLines(scene: Scene, shot: Shot): string[] {
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId) ?? scene.blocking[0]
  const moving = new Set((take?.tracks ?? []).filter((t) => t.marks.length > 1).map((t) => t.entityId))
  const fighters = new Set((scene.fights ?? []).flatMap((f) => f.fighterIds))
  // Labelled or armed subjects get a line each; unlabelled look-alikes (same colour and shape) share one.
  const lines: (string | Entity[])[] = []
  const groups = new Map<string, Entity[]>()
  for (const e of scene.entities) {
    if (e.excludeFromExport || (e.heldBy && weaponSpec(e.assetId))) continue
    const cat = assetSpec(e.assetId).category
    if (cat === 'environment') continue
    const notable =
      cat === 'people' || cat === 'animals' || cat === 'vehicles' || !!e.label?.text?.trim() || moving.has(e.id) || fighters.has(e.id)
    if (!notable) continue
    const line = proxyLine(scene, e)
    if (!line) continue
    if (e.label?.text?.trim() || heldBy(scene, e).length > 0) {
      lines.push(line)
      continue
    }
    const key = `${renderedColor(e)}|${shapeWord(e)}`
    const group = groups.get(key)
    if (group) group.push(e)
    else {
      groups.set(key, [e])
      lines.push(groups.get(key)!)
    }
  }
  return lines.map((item) => {
    if (typeof item === 'string') return item
    if (item.length === 1) return proxyLine(scene, item[0]!)!
    const nouns = new Map<string, number>()
    for (const e of item) nouns.set(assetSpec(e.assetId).promptNoun, (nouns.get(assetSpec(e.assetId).promptNoun) ?? 0) + 1)
    const what =
      nouns.size === 1
        ? pluralNoun([...nouns.keys()][0]!)
        : andList([...nouns].map(([noun, n]) => (n === 1 ? noun : `${n} ${pluralNoun(noun)}`)))
    return `The ${item.length} ${renderedColor(item[0]!)} ${plural(shapeWord(item[0]!))} are ${what}.`
  })
}

/* ---------------------------------- action -------------------------------- */

interface ActionEvent {
  t: number
  /** The one entity doing it, when look-alike events may group and same-subject sentences merge. */
  entity?: Entity
  name: string
  phrase: string
}

/** A fighter for the solver, with the weapons in its hands — as the store's `fighterInput`. */
function fighterOf(e: Entity, scene: Scene): FighterInput {
  const held = heldBy(scene, e)
  const weapons = held
    .filter((w, k) => held.findIndex((x) => x.heldBy!.hand === w.heldBy!.hand) === k)
    .map((w) => ({ assetId: w.assetId, hand: w.heldBy!.hand, scale: w.transform.scale }))
  return {
    entityId: e.id,
    assetId: e.assetId,
    params: e.params,
    scale: e.transform.scale,
    start: { ...e.transform.position },
    ...(weapons.length > 0 ? { weapons } : {})
  }
}

/** Motion names as words: "Jab / Cross" → "jab and cross", "Swim (Freestyle)" → "swim". */
function motionWords(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*[/&]\s*/g, ' and ')
    .replace(/\s*—\s*/g, ' to the ')
    .replace(/^the /, '')
    .trim()
}

const ZONE: Record<FightBeat['target'], string> = { head: 'head', body: 'body', legs: 'legs' }

function strikePhrase(move: string, target: FightBeat['target'], defender: string, scene: Scene, attacker: Entity): string {
  const zone = `${defender}'s ${ZONE[target]}`
  const held = heldBy(scene, attacker).map((w) => ({ w, spec: weaponSpec(w.assetId)! }))
  const gun = held.find((h) => h.spec.kind === 'gun')
  const melee = held.find((h) => h.spec.kind === 'blade' || h.spec.kind === 'blunt' || h.spec.kind === 'polearm')
  const withW = (h: typeof melee): string => (h ? ` with the ${bareNoun(h.w)}` : '')
  if (SHOT_MOVES.has(move)) return `shoots at ${defender}${withW(gun)}`
  switch (move) {
    case 'sword-slash-combo':
      return `slashes at ${zone}${withW(melee)}`
    case 'sword-thrust':
      return `thrusts at ${zone}${withW(melee)}`
    case 'knife-lunge':
      return `lunges at ${zone}${withW(melee)}`
    case 'low-sweep':
      return `sweeps ${defender}'s legs`
    case 'shove-two-hands':
      return `shoves ${defender}`
    case 'tackle-lunge':
      return `tackles ${defender}`
    case 'grapple-shove':
      return `grabs and shoves ${defender}`
    case 'takedown-lunge':
      return `lunges for a takedown on ${defender}`
  }
  const preset = MOTION_PRESETS.find((p) => p.id === move)
  const words = motionWords(preset?.name ?? move.replace(/-/g, ' '))
  const arm = /^(hand|elbow)/.test(strikeImpacts(move)[0]?.effector ?? '')
  if (melee && arm) return `swings the ${bareNoun(melee.w)} at ${zone}`
  return `throws ${article(words)} ${words} at ${zone}`
}

function outcomeClause(outcome: FightOutcome, result: string | undefined, defender: string, shot: boolean): string {
  const through = result === 'knockdown' ? ' but goes down' : result === 'stagger' ? ' but staggers back' : ''
  switch (outcome) {
    case 'block':
      return `${defender} blocks${through}`
    case 'parry':
      return `${defender} parries${through}`
    case 'slip':
      return `${defender} slips it`
    case 'duck':
      return `${defender} ducks under it`
    case 'miss':
      return 'it misses'
    case 'ko':
      return `it knocks ${defender} out`
    case 'hit':
      if (result === 'knockdown') return `it knocks ${defender} down`
      if (result === 'stagger') return `${defender} staggers back`
      return shot ? `it hits ${defender}` : 'it lands'
  }
}

function fightEvents(scene: Scene, shot: Shot): { events: ActionEvent[]; fighters: Set<string> } {
  const events: ActionEvent[] = []
  const fighters = new Set<string>()
  for (const fight of scene.fights ?? []) {
    const ents = fight.fighterIds.map((id) => scene.entities.find((e) => e.id === id))
    if (!ents[0] || !ents[1]) continue
    fight.fighterIds.forEach((id) => fighters.add(id))
    let report: ReturnType<typeof solveFight>['report']
    try {
      report = solveFight(fight, [fighterOf(ents[0], scene), fighterOf(ents[1], scene)], {
        duration: shot.duration,
        fps: shot.fps
      }).report
    } catch {
      continue
    }
    for (const br of report.beats) {
      if (br.startT >= shot.duration) continue
      const beat = fight.beats[br.index]
      if (!beat) continue
      const atk = ents[beat.attacker]!
      const def = ents[beat.attacker === 0 ? 1 : 0]!
      const D = nameOf(def)
      const isShot = SHOT_MOVES.has(beat.move)
      const n = br.impactTimes.length
      const clauses: string[] = []
      for (let i = 0; i < n; i++) {
        const k = beat.outcomes.length - n + i
        let o: FightOutcome = k >= 0 ? beat.outcomes[k]! : 'block'
        if (isShot && (o === 'block' || o === 'parry')) o = 'miss'
        const clause = outcomeClause(o, br.physics[i]?.result, D, isShot)
        if (clauses[clauses.length - 1] !== clause) clauses.push(clause)
      }
      const phrase = strikePhrase(beat.move, beat.target, D, scene, atk)
      events.push({ t: br.startT, name: nameOf(atk), phrase: clauses.length > 0 ? `${phrase}, ${clauses.join(', then ')}` : phrase })
    }
  }
  return { events, fighters }
}

/* ------------------------- motions from the library ------------------------ */

const jointKey = (j: Record<string, number>): string =>
  Object.keys(j)
    .sort()
    .map((k) => `${k}:${Math.round(j[k]! * 1e6)}`)
    .join(',')

let s_motionIndex: Map<string, { preset: MotionPreset; mirror: boolean }[]> | null = null

/** First-keyframe pose → the presets (plain or mirrored) that start with it. */
function motionIndex(): Map<string, { preset: MotionPreset; mirror: boolean }[]> {
  if (s_motionIndex) return s_motionIndex
  const index = new Map<string, { preset: MotionPreset; mirror: boolean }[]>()
  const add = (key: string, entry: { preset: MotionPreset; mirror: boolean }): void => {
    const list = index.get(key) ?? []
    list.push(entry)
    index.set(key, list)
  }
  for (const preset of MOTION_PRESETS) {
    const first = preset.keyframes[0]
    if (!first || preset.keyframes.length < 2) continue
    add(jointKey(first.joints), { preset, mirror: false })
    add(jointKey(mirrorJoints(first.joints)), { preset, mirror: true })
  }
  s_motionIndex = index
  return index
}

/** Motion-library presets laid down in these marks (exactly, or mirrored), in time order. */
function recognizeMotions(marks: ActorMark[]): { t: number; preset: MotionPreset }[] {
  const index = motionIndex()
  const found: { t: number; preset: MotionPreset }[] = []
  let i = 0
  while (i < marks.length) {
    const m = marks[i]!
    // Fork: a mocap bot's clip run, named by its motion (mocap/library-clips.ts).
    if (m.clip) {
      const named = clipMotionName(m.clip.id)
      if (named && found[found.length - 1]?.preset.id !== named.id) found.push({ t: m.time, preset: named })
      i++
      continue
    }
    let best: MotionPreset | null = null
    let bestLen = 0
    for (const c of m.joints ? (index.get(jointKey(m.joints)) ?? []) : []) {
      const kfs = c.preset.keyframes
      let k = 1
      while (k < kfs.length && i + k < marks.length) {
        const mk = marks[i + k]!
        const want = c.mirror ? mirrorJoints(kfs[k]!.joints) : kfs[k]!.joints
        if (!mk.joints || jointKey(mk.joints) !== jointKey(want)) break
        if (Math.abs(mk.time - m.time - (kfs[k]!.t - kfs[0]!.t)) > 1e-4) break
        k++
      }
      if (k > bestLen) {
        best = c.preset
        bestLen = k
      }
    }
    if (best && bestLen >= 2) {
      if (found[found.length - 1]?.preset.id !== best.id) found.push({ t: m.time, preset: best })
      i += bestLen
    } else i++
  }
  return found
}

function motionPhrase(preset: MotionPreset): string {
  const words = motionWords(preset.name)
  if (preset.category === 'dance') return `dances the ${words}`
  if (preset.category === 'fight' && strikeImpacts(preset.id).length > 0) return `throws ${article(words)} ${words}`
  return `does ${article(words)} ${words}`
}

/* ------------------------------ travel + chases ---------------------------- */

interface Segment {
  e: Entity
  t0: number
  t1: number
  from: V3
  to: V3
  gait: GaitId
  vehicle: boolean
}

function travelVerb(e: Entity, gait: GaitId): string {
  const spec = assetSpec(e.assetId)
  if (spec.category === 'vehicles') {
    if (e.assetId === 'vehicle.plane') return 'flies'
    if (e.assetId === 'vehicle.boat') return 'sails'
    if (e.assetId === 'vehicle.bicycle') return 'rides'
    if (e.assetId === 'vehicle.train') return 'rolls'
    return 'drives'
  }
  if (spec.motion === 'flying') return 'flies'
  const verbs: Partial<Record<GaitId, string>> = { walk: 'walks', jog: 'jogs', run: 'runs', crouch: 'creeps', lie: 'crawls', fall: 'stumbles' }
  return verbs[gait] ?? 'moves'
}

/** Screen direction of a ground move for a camera looking along `pan`. */
function screenDirection(dx: number, dz: number, pan: number): string {
  const lat = dx * Math.cos(pan) - dz * Math.sin(pan)
  const dep = -dx * Math.sin(pan) - dz * Math.cos(pan)
  const side = lat > 0 ? 'from left to right' : 'from right to left'
  const depth = dep > 0 ? 'away from the camera' : 'toward the camera'
  if (Math.abs(lat) >= 2 * Math.abs(dep)) return side
  if (Math.abs(dep) >= 2 * Math.abs(lat)) return depth
  return `${depth} and ${lat > 0 ? 'to the right' : 'to the left'}`
}

const MIN_TRAVEL = 0.75

function segmentsOf(e: Entity, marks: ActorMark[], duration: number): Segment[] {
  const out: Segment[] = []
  const vehicle = assetSpec(e.assetId).category === 'vehicles'
  for (let i = 1; i < marks.length; i++) {
    const p = marks[i - 1]!
    const c = marks[i]!
    const t0 = p.time + p.hold
    if (t0 >= duration) break
    if (Math.hypot(c.position.x - p.position.x, c.position.z - p.position.z) < MIN_TRAVEL) continue
    const last = out[out.length - 1]
    const gait = vehicle ? 'run' : c.gait
    if (last && last.gait === gait && Math.abs(last.t1 - t0) < 1e-6) {
      last.t1 = c.time
      last.to = c.position
      continue
    }
    out.push({ e, t0, t1: c.time, from: p.position, to: c.position, gait, vehicle })
  }
  return out
}

function at(s: Segment, t: number): { x: number; z: number } {
  const f = s.t1 > s.t0 ? Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))) : 1
  return { x: s.from.x + (s.to.x - s.from.x) * f, z: s.from.z + (s.to.z - s.from.z) * f }
}

/**
 * Leader → followers: running the same way on the leader's path (within a
 * stride or two of it), overlapping in time, behind it. Each follower chases
 * its nearest leader.
 */
function chases(segs: Segment[]): Map<Segment, Segment[]> {
  const pairs: { leader: Segment; follower: Segment; gap: number }[] = []
  const running = (s: Segment): boolean => s.vehicle || s.gait === 'run' || s.gait === 'jog'
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]!
      const b = segs[j]!
      if (a.e.id === b.e.id || a.vehicle !== b.vehicle || !running(a) || !running(b)) continue
      const t0 = Math.max(a.t0, b.t0)
      const t1 = Math.min(a.t1, b.t1)
      if (t1 - t0 < 0.5 * Math.min(a.t1 - a.t0, b.t1 - b.t0)) continue
      const da = { x: a.to.x - a.from.x, z: a.to.z - a.from.z }
      const db = { x: b.to.x - b.from.x, z: b.to.z - b.from.z }
      const la = Math.hypot(da.x, da.z)
      const lb = Math.hypot(db.x, db.z)
      if ((da.x * db.x + da.z * db.z) / (la * lb) < 0.8) continue
      const u = { x: da.x / la + db.x / lb, z: da.z / la + db.z / lb }
      const lu = Math.hypot(u.x, u.z)
      const pa = at(a, (t0 + t1) / 2)
      const pb = at(b, (t0 + t1) / 2)
      const along = ((pb.x - pa.x) * u.x + (pb.z - pa.z) * u.z) / lu
      const across = Math.abs((pb.x - pa.x) * u.z - (pb.z - pa.z) * u.x) / lu
      if (across > (a.vehicle ? 4 : 1.5) || Math.abs(along) < 0.5 || Math.abs(along) > 25) continue
      const [leader, follower] = along > 0 ? [b, a] : [a, b]
      pairs.push({ leader, follower, gap: Math.abs(along) })
    }
  }
  const leads = new Map<Segment, Segment[]>()
  const following = new Set<Segment>()
  for (const { leader, follower } of pairs.sort((x, y) => x.gap - y.gap)) {
    if (following.has(follower) || following.has(leader) || leads.has(follower)) continue
    following.add(follower)
    leads.set(leader, [...(leads.get(leader) ?? []), follower])
  }
  return leads
}

function travelEvents(scene: Scene, shot: Shot, ev: ShotEvaluator, skip: Set<string>): ActionEvent[] {
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId) ?? scene.blocking[0]
  const segs: Segment[] = []
  const events: ActionEvent[] = []
  for (const track of take?.tracks ?? []) {
    const e = scene.entities.find((x) => x.id === track.entityId)
    if (!e || e.excludeFromExport || skip.has(e.id) || (e.heldBy && weaponSpec(e.assetId))) continue
    const marks = [...track.marks].sort((a, b) => a.time - b.time)
    for (const { t, preset } of recognizeMotions(marks)) {
      if (t < shot.duration) events.push({ t, entity: e, name: nameOf(e), phrase: motionPhrase(preset) })
    }
    segs.push(...segmentsOf(e, marks, shot.duration))
  }
  const panAt = (s: Segment): number => ev.evaluate(Math.min((s.t0 + Math.min(s.t1, shot.duration)) / 2, shot.duration)).camera.pan
  const leads = chases(segs)
  const followers = new Set([...leads.values()].flat())
  for (const s of segs) {
    if (followers.has(s)) continue
    const dir = screenDirection(s.to.x - s.from.x, s.to.z - s.from.z, panAt(s))
    const chasers = leads.get(s)
    if (chasers) {
      const names = chasers.map((c) => nameOf(c.e))
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]!
      events.push({ t: Math.min(s.t0, ...chasers.map((c) => c.t0)), name: who, phrase: `${names.length > 1 ? 'chase' : 'chases'} ${nameOf(s.e)} ${dir}` })
    } else events.push({ t: s.t0, entity: s.e, name: nameOf(s.e), phrase: `${travelVerb(s.e, s.gait)} ${dir}` })
  }
  return events
}

function actionLines(scene: Scene, shot: Shot, ev: ShotEvaluator): string[] {
  const { events: fights, fighters } = fightEvents(scene, shot)
  const events = [...fights, ...travelEvents(scene, shot, ev, fighters)]
    .map((e, k) => ({ e, k }))
    .sort((a, b) => a.e.t - b.e.t || a.k - b.k)
    .map(({ e }) => e)
  // The same move by several subjects within half a second is one sentence ("4 men and 4 women dance the robot").
  const grouped: { t: number; phrase: string; name: string; members: Entity[] }[] = []
  for (const e of events) {
    const g = e.entity
      ? grouped.find((x) => x.members.length > 0 && x.phrase === e.phrase && Math.abs(x.t - e.t) <= 0.5 && !x.members.includes(e.entity!))
      : undefined
    if (g) g.members.push(e.entity!)
    else grouped.push({ t: e.t, phrase: e.phrase, name: e.name, members: e.entity ? [e.entity] : [] })
  }
  const lines: string[] = []
  let prev: Entity | undefined
  for (const g of grouped) {
    const solo = g.members.length === 1 ? g.members[0] : undefined
    if (solo && prev === solo) {
      lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, -1)}, then ${g.phrase}.`
    } else if (g.members.length > 1) lines.push(`${capitalize(groupName(g.members))} ${pluralPhrase(g.phrase)}.`)
    else lines.push(`${capitalize(g.name)} ${g.phrase}.`)
    prev = solo
  }
  return lines
}

/* ---------------------------------- camera -------------------------------- */

const SIZE_WORDS: Record<ShotSizeId, string> = {
  EWS: 'extreme wide shot',
  WS: 'wide shot',
  FS: 'full shot',
  MS: 'medium shot',
  MCU: 'medium close-up',
  CU: 'close-up',
  ECU: 'extreme close-up'
}

const SIDE_WORDS: Record<NonNullable<ShotSpec['side']>, string> = {
  front: 'from the front',
  frontLeft: 'from the front left',
  left: 'from the left',
  backLeft: 'from behind on the left',
  back: 'from behind',
  backRight: 'from behind on the right',
  right: 'from the right',
  frontRight: 'from the front right',
  line: ''
}

const ANGLE_WORDS: Record<NonNullable<ShotSpec['angle']>, string> = {
  eye: '',
  low: 'low angle',
  high: 'high angle',
  overhead: 'overhead',
  ground: 'ground level'
}

const RIG_WORDS: Record<RigId, string> = {
  sticks: '',
  dolly: 'on a dolly',
  steadicam: 'steadicam',
  handheld: 'handheld',
  crane: 'on a crane',
  drone: 'drone',
  carMount: 'car-mounted'
}

function shotWords(spec: ShotSpec, scene: Scene): string {
  const name = (id: string): string => {
    const e = scene.entities.find((x) => x.id === id)
    return e ? nameOf(e) : 'the subject'
  }
  const names = spec.subjectIds.map(name)
  const who = names.length > 1 ? `of ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : `on ${names[0] ?? 'the action'}`
  const parts = [`${SIZE_WORDS[spec.size]} ${who}`]
  if (spec.over) parts.push(`over ${name(spec.over.entityId)}'s ${spec.over.shoulder} shoulder`)
  if (spec.side && SIDE_WORDS[spec.side]) parts.push(SIDE_WORDS[spec.side])
  if (spec.angle && ANGLE_WORDS[spec.angle]) parts.push(ANGLE_WORDS[spec.angle])
  if (spec.lens) parts.push(`${Math.round(spec.lens)}mm`)
  if (spec.dutchDeg) parts.push('dutch angle')
  return parts.join(', ')
}

const DEG = Math.PI / 180

function cameraLines(scene: Scene, shot: Shot, ev: ShotEvaluator): string[] {
  const marks = [...shot.camera.marks].sort((a, b) => a.time - b.time)
  if (marks.length === 0) return []
  const parts: string[] = []
  const mount = shot.camera.mountEntityId ? scene.entities.find((e) => e.id === shot.camera.mountEntityId) : undefined
  if (mount) parts.push(`mounted on ${nameOf(mount)}`)
  else if (RIG_WORDS[shot.camera.rig]) parts.push(RIG_WORDS[shot.camera.rig])
  const framed = marks.filter((m) => m.shot)
  if (framed.length > 0) {
    const words: string[] = []
    for (const m of framed) {
      const w = shotWords(m.shot!, scene)
      if (words[words.length - 1] !== w) words.push(w)
    }
    // Coverage that goes back and forth names each framing once.
    const unique = [...new Set(words)]
    if (unique.length < words.length) {
      const named = unique.slice(0, 4).map((w) => `${article(w)} ${w}`)
      parts.push(`moves between ${andList(named)}${unique.length > 4 ? ' and others like them' : ''}`)
    } else parts.push(words.slice(0, 5).join('; then ') + (words.length > 5 ? '; and more framings like these' : ''))
  } else {
    const n = 24
    const end = Math.max(0, shot.duration - 1 / Math.max(1, shot.fps))
    const cams = Array.from({ length: n + 1 }, (_, k) => ev.evaluate((end * k) / n).camera)
    const a = cams[0]!
    const b = cams[n]!
    const dx = b.position.x - a.position.x
    const dz = b.position.z - a.position.z
    const dy = b.position.y - a.position.y
    const dep = -dx * Math.sin(a.pan) - dz * Math.cos(a.pan)
    const lat = dx * Math.cos(a.pan) - dz * Math.sin(a.pan)
    let pan = 0
    let path = 0
    for (let k = 1; k <= n; k++) {
      const p = cams[k - 1]!
      const c = cams[k]!
      pan += Math.atan2(Math.sin(c.pan - p.pan), Math.cos(c.pan - p.pan))
      path += Math.hypot(c.position.x - p.position.x, c.position.y - p.position.y, c.position.z - p.position.z)
    }
    const moves: string[] = []
    if (path > 3 && Math.abs(pan) > 60 * DEG && Math.hypot(dx, dz) < 0.6 * path) moves.push('arcs around the action')
    else {
      if (dep > 0.5) moves.push('moves forward')
      else if (dep < -0.5) moves.push('pulls back')
      if (lat > 0.5) moves.push('trucks right')
      else if (lat < -0.5) moves.push('trucks left')
    }
    if (dy > 0.4) moves.push('rises')
    else if (dy < -0.4) moves.push('lowers')
    if (moves.length > 0) parts.push(moves.join(' and '))
    const f0 = Math.round(a.focalLength)
    const f1 = Math.round(b.focalLength)
    if (Math.abs(f1 - f0) >= 5) parts.push(`the lens goes from ${f0}mm to ${f1}mm`)
    else if (moves.length === 0) parts.push(parts.length > 0 ? 'holding position' : 'locked off')
  }
  const tracked = shot.camera.trackEntityId ? scene.entities.find((e) => e.id === shot.camera.trackEntityId) : undefined
  if (tracked) parts.push(`keeping ${nameOf(tracked)} in frame`)
  return [`Camera: ${parts.join('; ')}.`]
}

/* --------------------------------- assembly -------------------------------- */

export function describeShot(scene: Scene, shot: Shot): ShotWords {
  const ev = new ShotEvaluator(scene, shot)
  return { proxies: proxyLines(scene, shot), action: actionLines(scene, shot, ev), camera: cameraLines(scene, shot, ev) }
}

/** The longest prefix of `items` (joined by `sep`) that fits in `room` characters; '' when none does. */
function prefixFit(items: string[], sep: string, room: number): string {
  let out = ''
  for (const item of items) {
    const next = out ? `${out}${sep}${item}` : item
    if (next.length > room) break
    out = next
  }
  return out
}

/**
 * Proxy map → action → camera → the fixed paragraphs (look, setting, the
 * directive), within `maxChars`. Room goes to the proxy map first, then the
 * camera, then as much of the action as fits (ending with ACTION_TRIMMED when
 * some of it doesn't). Empty sections are left out.
 */
export function composePrompt(fixed: string[], words: ShotWords, maxChars = DEFAULT_PROMPT_CHARS): string {
  const SEP = '\n\n'
  const tail = fixed.filter((p) => p.length > 0)
  let room = maxChars - tail.join(SEP).length
  const take = (text: string): string => {
    if (text) room -= text.length + SEP.length
    return text
  }
  const proxies = take(prefixFit(words.proxies, '\n', room - SEP.length))
  const camera = take(prefixFit(words.camera, ' ', room - SEP.length))
  const whole = words.action.join(' ')
  let action = whole
  if (whole.length + SEP.length > room) {
    const head = prefixFit(words.action, ' ', room - SEP.length - ACTION_TRIMMED.length - 1)
    action = head ? `${head} ${ACTION_TRIMMED}` : ACTION_TRIMMED.length + SEP.length <= room ? ACTION_TRIMMED : ''
  }
  return [proxies, action, camera, ...tail].filter((p) => p.length > 0).join(SEP)
}
