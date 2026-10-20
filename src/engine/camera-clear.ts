/**
 * Clear camera views (fork addition, fix-camera-set; see MODIFICATIONS.md):
 * shot words, framing presets and people-follow moves keep the camera in open
 * space (never inside a wall, prop or body) with the framed subject unblocked
 * by the set or other cast.
 *
 * The set comes in as data: static props' and kits' meshes as oriented boxes
 * with their full height (renderer/fight-obstacles.ts `cameraBoxes`). Cast is
 * read off the evaluator: people as spheres on their posed rig (FK), moving
 * vehicles and animals as boxes. A view is clear when the camera is never
 * inside a box or a body and, in ≥ 90 % of the samples, every framed subject
 * shows its head and chest. A blocked view takes the nearest clear
 * alternative — closer on a wider lens (same frame size), higher, then swung
 * round the subject — and says so; framed subjects never block each other.
 *
 * PURE: no DOM / three.js / Electron, no randomness. It runs when a mark is
 * made; shot words keep the outcome in `ShotSpec.view` for the per-frame solve.
 */

import { assetSpec, entityHeight } from './assets'
import type { CameraMarkSpec } from './camera-moves'
import { ShotEvaluator } from './evaluate'
import { headingOf } from './path'
import { solveShot, turnXZ, type ShotSpec, type ShotSubject, type ShotView } from './shot'
import { personDims, poseEffectors, toWorld } from './skeleton'
import type { CameraMark, EntityState, Scene, Shot, V3 } from './types'

/** A piece of the set: an oriented floor box (heading as `object.rotation.y`) from y0 to y1. */
export interface SetBox {
  entityId: string
  name: string
  x: number
  z: number
  hx: number
  hz: number
  heading: number
  y0: number
  y1: number
}

export interface BodySphere {
  entityId: string
  name: string
  x: number
  y: number
  z: number
  r: number
}

export interface ViewWorld {
  boxes: SetBox[]
  bodies: BodySphere[]
}

/** The lens keeps this far from walls and props (m), and this far from bodies. */
export const CAMERA_MARGIN = 0.2
export const BODY_MARGIN = 0.12
/** A subject is seen when its visible targets weigh this much (head 0.4 + chest 0.35). */
export const MIN_VISIBLE = 0.75
/** A view is clear when this share of its samples is. */
export const MIN_CLEAR_SHARE = 0.9

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function local(b: SetBox, p: V3): V3 {
  const dx = p.x - b.x
  const dz = p.z - b.z
  const c = Math.cos(b.heading)
  const s = Math.sin(b.heading)
  return { x: dx * c - dz * s, y: p.y, z: dx * s + dz * c }
}

function inBox(b: SetBox, p: V3, m: number): boolean {
  const l = local(b, p)
  return Math.abs(l.x) < b.hx + m && Math.abs(l.z) < b.hz + m && l.y > b.y0 - m && l.y < b.y1 + m
}

function segmentHitsBox(box: SetBox, a: V3, b: V3): boolean {
  const la = local(box, a)
  const lb = local(box, b)
  let t0 = 0
  let t1 = 1
  const slabs: [number, number, number, number][] = [
    [la.x, lb.x - la.x, -box.hx, box.hx],
    [la.y, lb.y - la.y, box.y0, box.y1],
    [la.z, lb.z - la.z, -box.hz, box.hz]
  ]
  for (const [p, d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return false
      continue
    }
    let e0 = (lo - p) / d
    let e1 = (hi - p) / d
    if (e0 > e1) [e0, e1] = [e1, e0]
    t0 = Math.max(t0, e0)
    t1 = Math.min(t1, e1)
    if (t0 > t1) return false
  }
  return t1 - t0 > 1e-6
}

function segmentHitsSphere(s: BodySphere, a: V3, b: V3): boolean {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const len2 = d.x * d.x + d.y * d.y + d.z * d.z
  const u = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((s.x - a.x) * d.x + (s.y - a.y) * d.y + (s.z - a.z) * d.z) / len2))
  return Math.hypot(a.x + d.x * u - s.x, a.y + d.y * u - s.y, a.z + d.z * u - s.z) < s.r
}

/** What the camera is inside of (a box within CAMERA_MARGIN, a body within BODY_MARGIN), or null. */
export function insideOf(p: V3, world: ViewWorld): string | null {
  for (const b of world.boxes) if (inBox(b, p, CAMERA_MARGIN)) return b.name
  for (const s of world.bodies) if (Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) < s.r + BODY_MARGIN) return s.name
  return null
}

/** The first thing between a and b (entities in `ignore` don't count), or null. */
export function blockerOf(a: V3, b: V3, world: ViewWorld, ignore: ReadonlySet<string>): string | null {
  for (const box of world.boxes) if (!ignore.has(box.entityId) && segmentHitsBox(box, a, b)) return box.name
  for (const s of world.bodies) if (!ignore.has(s.entityId) && segmentHitsSphere(s, a, b)) return s.name
  return null
}

// ---------------------------------------------------------------------------
// Cast and targets
// ---------------------------------------------------------------------------

const isPerson = (s: { assetId: string }): boolean => s.assetId.startsWith('person.')

/** Cast as occluders: people as spheres on their posed rig; other moving cast (vehicles, animals) as boxes. */
export function castWorld(subjects: ShotSubject[], moving: ReadonlySet<string>, nameOf: (id: string) => string = (id) => id): ViewWorld {
  const out: ViewWorld = { boxes: [], bodies: [] }
  for (const s of subjects) {
    const name = nameOf(s.id)
    if (isPerson(s)) {
      const dims = personDims(s.assetId, s.params)
      const fx = poseEffectors(dims, s.joints)
      const w = (p: V3): V3 => toWorld(p, s.position, s.heading, s.scale)
      const pelvis = w(fx.pelvis)
      const chest = w(fx.chest)
      const sphere = (p: V3, r: number): BodySphere => ({ entityId: s.id, name, ...p, r: r * s.scale })
      out.bodies.push(
        sphere(w(fx.head), dims.headR * 1.15),
        sphere(chest, dims.bodyW * 0.6),
        sphere({ x: (chest.x + pelvis.x) / 2, y: (chest.y + pelvis.y) / 2, z: (chest.z + pelvis.z) / 2 }, dims.bodyW * 0.55),
        sphere(pelvis, dims.bodyW * 0.5),
        sphere(w(fx.shoulderL), dims.bodyW * 0.3),
        sphere(w(fx.shoulderR), dims.bodyW * 0.3),
        sphere(w(fx.kneeL), dims.bodyW * 0.3),
        sphere(w(fx.kneeR), dims.bodyW * 0.3)
      )
      continue
    }
    const spec = assetSpec(s.assetId)
    if (!moving.has(s.id) || spec.category === 'environment' || spec.category === 'weapons') continue
    out.boxes.push({
      entityId: s.id,
      name,
      x: s.position.x,
      z: s.position.z,
      hx: spec.footprint * 0.5 * s.scale,
      hz: spec.footprint * s.scale,
      heading: s.heading,
      y0: s.position.y,
      y1: s.position.y + spec.height * s.scale
    })
  }
  return out
}

/** Points a camera must see on a subject, weighted: a person's head, chest and pelvis; a thing's middle and top. */
export function subjectTargets(s: ShotSubject): { p: V3; w: number }[] {
  if (isPerson(s)) {
    const fx = poseEffectors(personDims(s.assetId, s.params), s.joints)
    const w = (p: V3): V3 => toWorld(p, s.position, s.heading, s.scale)
    return [
      { p: w(fx.head), w: 0.4 },
      { p: w(fx.chest), w: 0.35 },
      { p: w(fx.pelvis), w: 0.25 }
    ]
  }
  const h = assetSpec(s.assetId).height * s.scale
  return [
    { p: { x: s.position.x, y: s.position.y + h * 0.5, z: s.position.z }, w: 0.5 },
    { p: { x: s.position.x, y: s.position.y + h * 0.85, z: s.position.z }, w: 0.5 }
  ]
}

export interface ViewCheck {
  /** What the camera is inside of, or null. */
  inside: string | null
  /** The least-seen framed subject's visible weight (0..1). */
  visible: number
  /** What hides it, or null. */
  blocker: string | null
}

export function checkView(cam: V3, framed: ShotSubject[], world: ViewWorld, ignore: ReadonlySet<string>): ViewCheck {
  const inside = insideOf(cam, world)
  let visible = 1
  let blocker: string | null = null
  for (const s of framed) {
    let seen = 0
    let hid: string | null = null
    for (const t of subjectTargets(s)) {
      const b = blockerOf(cam, t.p, world, ignore)
      if (b) hid ??= b
      else seen += t.w
    }
    if (seen < visible) {
      visible = seen
      blocker = hid
    }
  }
  return { inside, visible, blocker }
}

const clearCheck = (c: ViewCheck, minVisible = MIN_VISIBLE): boolean => !c.inside && c.visible >= minVisible - 1e-9

// ---------------------------------------------------------------------------
// Alternatives
// ---------------------------------------------------------------------------

export interface ViewVariant {
  /** Swing round the subject (degrees); positive moves the camera to its own right. */
  turnDeg: number
  /** Metres higher. */
  raise: number
  /** Distance and lens factor (< 1: closer on a wider lens). */
  closer: number
}

const CLOSER = [1, 0.85, 0.7, 0.55, 0.45]
const RAISE = [0, 0.5, 1, 1.5, 2.5]
const TURN = [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180]
const ZERO: ViewVariant = { turnDeg: 0, raise: 0, closer: 1 }

const closerSteps = (c: number): number => {
  const i = CLOSER.findIndex((x) => Math.abs(x - c) < 1e-9)
  return i >= 0 ? i : (1 - c) / 0.15
}

/** How far a variant is from the asked-for view: a closer step = a 0.5 m raise = 20° of swing. */
export function variantCost(v: ViewVariant): number {
  return closerSteps(v.closer) + v.raise / 0.5 + Math.abs(v.turnDeg) / 20
}

function variantDistance(a: ViewVariant, b: ViewVariant): number {
  return Math.abs(closerSteps(a.closer) - closerSteps(b.closer)) + Math.abs(a.raise - b.raise) / 0.5 + Math.abs(a.turnDeg - b.turnDeg) / 20
}

export const isZeroVariant = (v: ViewVariant): boolean => v.turnDeg === 0 && v.raise === 0 && v.closer === 1

/** The alternatives to try, nearest first (ties: closer, then higher, then swung). */
export function viewVariants(opts: { lens: number; maxTurnDeg?: number; turns?: boolean; raise?: boolean; closer?: boolean }): ViewVariant[] {
  const out: ViewVariant[] = []
  for (const turnDeg of opts.turns === false ? [0] : TURN.filter((t) => Math.abs(t) <= (opts.maxTurnDeg ?? 180)))
    for (const raise of opts.raise === false ? [0] : RAISE)
      for (const closer of opts.closer === false ? [1] : CLOSER.filter((c) => opts.lens * c >= 12 - 1e-9)) out.push({ turnDeg, raise, closer })
  const key = (v: ViewVariant): number[] => [variantCost(v), Math.abs(v.turnDeg), v.raise, TURN.indexOf(v.turnDeg)]
  return out.sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (Math.abs(ka[i]! - kb[i]!) > 1e-9) return ka[i]! - kb[i]!
    return 0
  })
}

/** A fixed camera moved by a variant: swung round the look point, brought closer along its offset, raised. */
export function variantPosition(cam: V3, look: V3, v: ViewVariant): V3 {
  const flat = turnXZ({ x: cam.x - look.x, z: cam.z - look.z }, (v.turnDeg * Math.PI) / 180)
  return {
    x: look.x + flat.x * v.closer,
    y: Math.max(0.2, look.y + (cam.y - look.y) * v.closer + v.raise),
    z: look.z + flat.z * v.closer
  }
}

export interface ViewChoice {
  variant: ViewVariant
  clear: boolean
  /** Share of the samples that are clear. */
  share: number
  /** What blocked the asked-for view (first problem in its samples), or null. */
  blocker: string | null
}

/**
 * The nearest clear variant (`variants` nearest first; with `prev`, moving
 * away from the previous choice costs ¾ as much, so a moving camera eases back
 * rather than jumping). When none is clear: the least blocked one.
 * `minVisible`: how much of each subject must show (default head and chest).
 */
export function chooseView(
  check: (v: ViewVariant) => ViewCheck[],
  variants: ViewVariant[],
  prev?: ViewVariant,
  minVisible = MIN_VISIBLE
): ViewChoice {
  const clearCheck = (c: ViewCheck): boolean => !c.inside && c.visible >= minVisible - 1e-9
  const ordered = prev
    ? variants
        .map((v, i) => ({ v, i, cost: variantCost(v) + 0.75 * variantDistance(v, prev) }))
        .sort((a, b) => a.cost - b.cost || a.i - b.i)
        .map((x) => x.v)
    : variants
  const askedChecks = check(ZERO)
  const problem = askedChecks.find((c) => !clearCheck(c))
  const blocker = problem ? (problem.inside ?? problem.blocker) : null
  let best: { variant: ViewVariant; share: number; inside: number; visible: number } | null = null
  for (const variant of ordered) {
    const checks = isZeroVariant(variant) ? askedChecks : check(variant)
    if (checks.length === 0) return { variant, clear: true, share: 1, blocker }
    const inside = checks.filter((c) => c.inside).length
    const share = checks.filter(clearCheck).length / checks.length
    if (inside === 0 && share >= MIN_CLEAR_SHARE - 1e-9) return { variant, clear: true, share, blocker }
    const visible = checks.reduce((s, c) => s + (c.inside ? 0 : c.visible), 0) / checks.length
    if (!best || inside < best.inside || (inside === best.inside && (share > best.share + 1e-9 || (Math.abs(share - best.share) <= 1e-9 && visible > best.visible + 1e-9))))
      best = { variant, share, inside, visible }
  }
  return { variant: best?.variant ?? ZERO, clear: false, share: best?.share ?? 0, blocker }
}

const fmt = (n: number): string => String(+n.toFixed(2))

/** What a variant changed, e.g. "30% closer on a 25 mm lens, 0.5 m higher". */
export function describeView(v: Partial<ViewVariant>, lens: number): string {
  const parts: string[] = []
  const closer = v.closer ?? 1
  if (closer < 1) parts.push(`${Math.round((1 - closer) * 100)}% closer on a ${Math.round(lens * closer)} mm lens`)
  if (v.raise) parts.push(`${fmt(v.raise)} m higher`)
  if (v.turnDeg) parts.push(`swung ${Math.abs(v.turnDeg)}° to the camera's ${v.turnDeg > 0 ? 'right' : 'left'}`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Evaluator states → shot subjects (static joint_* params layered under mark joints, as in the evaluator). */
export function shotSubjects(scene: Scene, states: EntityState[]): ShotSubject[] {
  const out: ShotSubject[] = []
  for (const es of states) {
    const e = scene.entities.find((x) => x.id === es.entityId)
    if (!e) continue
    let joints = es.joints
    for (const [key, v] of Object.entries(e.params ?? {})) {
      if (key.startsWith('joint_') && typeof v === 'number' && v !== 0) {
        joints = { ...joints, [key.slice(6)]: (joints?.[key.slice(6)] ?? 0) + v }
      }
    }
    out.push({ id: e.id, assetId: e.assetId, params: e.params, scale: e.transform.scale, position: es.position, heading: es.heading, joints })
  }
  return out
}

interface Sample {
  t: number
  subjects: ShotSubject[]
  world: ViewWorld
}

const nameOfEntity = (scene: Scene): ((id: string) => string) => {
  const names = new Map(scene.entities.map((e) => [e.id, e.label?.text || e.name]))
  return (id) => names.get(id) ?? id
}

/** Subjects and occluders of a shot at time t (cached). */
function sampler(scene: Scene, shot: Shot, boxes: SetBox[]): (t: number) => Sample {
  const ev = new ShotEvaluator(scene, shot)
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId) ?? scene.blocking[0]
  const moving = new Set((take?.tracks ?? []).filter((tr) => tr.marks.length > 0).map((tr) => tr.entityId))
  const nameOf = nameOfEntity(scene)
  const cache = new Map<number, Sample>()
  return (t) => {
    const key = Math.round(t * 1000)
    let s = cache.get(key)
    if (!s) {
      const subjects = shotSubjects(scene, ev.evaluate(Math.min(Math.max(t, 0), shot.duration)).entities)
      const cast = castWorld(subjects, moving, nameOf)
      s = { t, subjects, world: { boxes: [...boxes, ...cast.boxes], bodies: cast.bodies } }
      cache.set(key, s)
    }
    return s
  }
}

/** Evenly spaced sample times over a span (about two a second, 2–13; one for an instant). */
function spanTimes(t0: number, t1: number): number[] {
  if (t1 - t0 < 1e-3) return [t0]
  const n = Math.min(13, Math.max(2, Math.ceil((t1 - t0) / 0.5) + 1))
  return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1))
}

const OPEN: ViewCheck = { inside: null, visible: 1, blocker: null }

export interface ViewOutcome {
  /** What was blocked and how the camera gave way (only when it moved). */
  note?: string
  /** No clear view exists. */
  warning?: string
}

const listNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? 'the subject') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

function outcome(subject: string, choice: ViewChoice, lens: number): ViewOutcome {
  const how = describeView(choice.variant, lens)
  const out: ViewOutcome = {}
  if (how) out.note = `The view of ${subject} was blocked${choice.blocker ? ` by ${choice.blocker}` : ''}: ${how}.`
  if (!choice.clear) out.warning = `No clear view of ${subject}${choice.blocker ? ` past ${choice.blocker}` : ''}: kept the least blocked view.`
  return out
}

/** A shot words mark's note or warning, read back from its stored view (`lens`: the asked-for lens). */
export function viewNote(scene: Scene, spec: ShotSpec, lens: number): ViewOutcome {
  const v = spec.view
  if (!v) return {}
  const choice: ViewChoice = {
    variant: { turnDeg: v.turnDeg ?? 0, raise: v.raise ?? 0, closer: v.closer ?? 1 },
    clear: !v.noClearView,
    share: v.noClearView ? 0 : 1,
    blocker: v.blockedBy ?? null
  }
  return outcome(listNames(spec.subjectIds.map(nameOfEntity(scene))), choice, spec.lens ?? lens)
}

/**
 * Shot words with a clear view over the span they drive (`span`: the mark's
 * time to the next mark or the shot's end). Unchanged when the asked-for view
 * is clear; otherwise the nearest clear variant goes into `spec.view`.
 */
export function clearShotWords(
  scene: Scene,
  shot: Shot,
  spec: ShotSpec,
  span: [number, number],
  focalLength: number,
  boxes: SetBox[]
): { spec: ShotSpec } & ViewOutcome {
  const base: ShotSpec = { ...spec }
  delete base.view
  const lens = base.lens ?? focalLength
  const ots = !!base.over
  const overhead = base.angle === 'overhead'
  const line = (base.side ?? (base.subjectIds.length > 1 ? 'line' : 'frontRight')) === 'line'
  const variants = viewVariants({ lens, turns: !ots && !overhead, raise: !overhead, closer: !ots, maxTurnDeg: line ? 60 : 180 })
  const at = sampler(scene, shot, boxes)
  const samples = spanTimes(span[0], Math.max(span[0], span[1])).map(at)
  const ignore = new Set([...base.subjectIds, ...(base.over ? [base.over.entityId] : [])])
  const setup = { sensorId: shot.camera.sensorId, aspect: shot.aspect, focalLength }
  const check = (v: ViewVariant): ViewCheck[] =>
    samples.map((s) => {
      const framed = base.subjectIds.map((id) => s.subjects.find((x) => x.id === id)).filter((x): x is ShotSubject => !!x)
      if (framed.length < base.subjectIds.length) return OPEN
      try {
        const view: ShotView = isZeroVariant(v) ? {} : { turnDeg: v.turnDeg, raise: v.raise, closer: v.closer }
        return checkView(solveShot({ ...base, view }, s.subjects, setup).position, framed, s.world, ignore)
      } catch {
        return OPEN
      }
    })
  const choice = chooseView(check, variants)
  if (choice.clear && isZeroVariant(choice.variant)) return { spec: base }
  const v = choice.variant
  const view: ShotView = {
    ...(v.turnDeg ? { turnDeg: v.turnDeg } : {}),
    ...(v.raise ? { raise: v.raise } : {}),
    ...(v.closer !== 1 ? { closer: v.closer } : {}),
    ...(choice.blocker ? { blockedBy: choice.blocker } : {}),
    ...(choice.clear ? {} : { noClearView: true })
  }
  return { spec: { ...base, view }, ...outcome(listNames(base.subjectIds.map(nameOfEntity(scene))), choice, lens) }
}

/**
 * A fixed camera pose (a framing preset) with a clear view of its subjects
 * over the whole shot. Variants move the camera about `look`; the lens widens
 * as it comes closer.
 */
export function clearFixedPose(
  scene: Scene,
  shot: Shot,
  pose: { position: V3; look: V3; focalLength: number },
  subjectIds: string[],
  boxes: SetBox[],
  opts: { maxTurnDeg?: number } = {}
): { position: V3; focalLength: number; variant: ViewVariant; clear: boolean } & ViewOutcome {
  const at = sampler(scene, shot, boxes)
  const samples = spanTimes(0, shot.duration).map(at)
  const ignore = new Set(subjectIds)
  const check = (v: ViewVariant): ViewCheck[] => {
    const cam = variantPosition(pose.position, pose.look, v)
    return samples.map((s) => {
      const framed = subjectIds.map((id) => s.subjects.find((x) => x.id === id)).filter((x): x is ShotSubject => !!x)
      return framed.length === 0 ? OPEN : checkView(cam, framed, s.world, ignore)
    })
  }
  const choice = chooseView(check, viewVariants({ lens: pose.focalLength, maxTurnDeg: opts.maxTurnDeg }))
  return {
    position: variantPosition(pose.position, pose.look, choice.variant),
    focalLength: pose.focalLength * choice.variant.closer,
    variant: choice.variant,
    clear: choice.clear,
    ...outcome(listNames(subjectIds.map(nameOfEntity(scene))), choice, pose.focalLength)
  }
}

/** Seconds between path checks of a follow move. */
const PATH_STEP = 1 / 8
const MAX_INSERTS = 24
/** A follow camera keeps this far from its subject's aim point (m) and this far beyond other people's bodies. */
const FOLLOW_MIN_DIST = 1.5
const FOLLOW_BODY_CLEAR = 0.5
/** A follow camera sees its subject whole: head, chest and pelvis. */
const FOLLOW_VISIBLE = 1

function aimAngles(from: V3, to: V3): { pan: number; tilt: number } {
  const dx = to.x - from.x
  const dz = to.z - from.z
  return { pan: headingOf({ x: dx, y: 0, z: dz }), tilt: Math.atan2(to.y - from.y, Math.max(Math.hypot(dx, dz), 1e-9)) }
}

/**
 * A people-follow move kept clear of the set and other cast: every mark takes
 * the nearest clear variant (staying near the previous mark's), then the
 * evaluated camera path is checked every 1/8 s and a cleared mark goes in
 * wherever it passes through a wall or body, comes within 1.5 m of the
 * subject or half a metre of anyone else, or loses the subject. An added mark
 * starts between its neighbours in the subject's frame (round the subject,
 * never through it).
 */
export function clearFollowMove(
  scene: Scene,
  shot: Shot,
  specs: CameraMarkSpec[],
  subjectId: string,
  boxes: SetBox[]
): { marks: CameraMarkSpec[]; moved: number; added: number; share: number } & ViewOutcome {
  const entity = scene.entities.find((e) => e.id === subjectId)
  if (!entity || specs.length === 0) return { marks: specs, moved: 0, added: 0, share: 1 }
  const at = sampler(scene, shot, boxes)
  const height = entityHeight(entity.assetId, entity.transform.scale, entity.params)
  const ignore = new Set([subjectId])
  const subjectAt = (t: number): ShotSubject | undefined => at(t).subjects.find((s) => s.id === subjectId)
  const lookAt = (t: number): V3 => {
    const s = subjectAt(t)
    return s ? { x: s.position.x, y: s.position.y + height * 0.8, z: s.position.z } : { x: 0, y: height * 0.8, z: 0 }
  }
  const nameOf = nameOfEntity(scene)
  const name = nameOf(subjectId)
  const check = (t: number, cam: V3): ViewCheck => {
    const s = subjectAt(t)
    if (!s) return OPEN
    const c = checkView(cam, [s], at(t).world, ignore)
    if (c.inside) return c
    const look = lookAt(t)
    if (Math.hypot(cam.x - look.x, cam.y - look.y, cam.z - look.z) < FOLLOW_MIN_DIST) return { ...c, inside: `too close to ${name}` }
    const crowd = at(t).world.bodies.find((b) => b.entityId !== subjectId && Math.hypot(cam.x - b.x, cam.y - b.y, cam.z - b.z) < b.r + FOLLOW_BODY_CLEAR)
    return crowd ? { ...c, inside: `right behind ${crowd.name}` } : c
  }
  const pathOf = (marks: CameraMarkSpec[]): ((t: number) => V3) => {
    const camMarks: CameraMark[] = marks.map((m, i) => ({ id: `clear${i}`, ...m, position: { ...m.position } }))
    const ev = new ShotEvaluator(scene, { ...shot, camera: { ...shot.camera, marks: camMarks, trackEntityId: subjectId } })
    return (t) => ev.evaluate(t).camera.position
  }
  const variants = viewVariants({ lens: specs[0]!.focalLength })
  const place = (template: CameraMarkSpec, t: number, base: V3, v: ViewVariant): CameraMarkSpec => {
    const look = lookAt(t)
    const position = variantPosition(base, look, v)
    return { ...template, time: t, position, ...aimAngles(position, look), focalLength: template.focalLength * v.closer }
  }
  let firstMove: ViewChoice | null = null
  let prev: ViewVariant | undefined
  const chosen: { mark: CameraMarkSpec; variant: ViewVariant }[] = []
  for (const m of [...specs].sort((a, b) => a.time - b.time)) {
    const look = lookAt(m.time)
    const choice = chooseView((v) => [check(m.time, variantPosition(m.position, look, v))], variants, prev, FOLLOW_VISIBLE)
    if (!isZeroVariant(choice.variant)) firstMove ??= choice
    prev = choice.variant
    chosen.push({ mark: isZeroVariant(choice.variant) ? m : place(m, m.time, m.position, choice.variant), variant: choice.variant })
  }
  const grid: number[] = []
  for (let t = 0; t < shot.duration - 1e-9; t += PATH_STEP) grid.push(t)
  grid.push(shot.duration)
  // An added mark's starting point: between its neighbours in the subject's frame, swinging round it.
  const between = (t: number, a: CameraMarkSpec, b: CameraMarkSpec): { position: V3; focalLength: number } => {
    const k = (t - a.time) / Math.max(b.time - a.time, 1e-9)
    const la = lookAt(a.time)
    const lb = lookAt(b.time)
    const l = lookAt(t)
    const oa = { x: a.position.x - la.x, y: a.position.y - la.y, z: a.position.z - la.z }
    const ob = { x: b.position.x - lb.x, y: b.position.y - lb.y, z: b.position.z - lb.z }
    const angA = Math.atan2(oa.x, oa.z)
    const turn = Math.atan2(Math.sin(Math.atan2(ob.x, ob.z) - angA), Math.cos(Math.atan2(ob.x, ob.z) - angA))
    const ang = angA + turn * k
    const r = Math.hypot(oa.x, oa.z) + (Math.hypot(ob.x, ob.z) - Math.hypot(oa.x, oa.z)) * k
    return {
      position: { x: l.x + Math.sin(ang) * r, y: l.y + oa.y + (ob.y - oa.y) * k, z: l.z + Math.cos(ang) * r },
      focalLength: a.focalLength + (b.focalLength - a.focalLength) * k
    }
  }
  const asked = pathOf(specs)
  let added = 0
  for (let i = 0; i < MAX_INSERTS; i++) {
    const path = pathOf(chosen.map((c) => c.mark))
    const bad = grid.find((t) => !clearCheck(check(t, path(t)), FOLLOW_VISIBLE) && !chosen.some((c) => Math.abs(c.mark.time - t) < 0.06))
    if (bad === undefined) break
    const before = [...chosen].reverse().find((c) => c.mark.time < bad)
    const after = chosen.find((c) => c.mark.time > bad)
    const start = before && after ? between(bad, before.mark, after.mark) : { position: asked(bad), focalLength: (before ?? after)!.mark.focalLength }
    const look = lookAt(bad)
    const choice = chooseView((v) => [check(bad, variantPosition(start.position, look, v))], variants, undefined, FOLLOW_VISIBLE)
    if (!isZeroVariant(choice.variant)) firstMove ??= choice
    const template = before?.mark ?? after!.mark
    const mark = place({ ...template, focalLength: start.focalLength, easeIn: 0, easeOut: 0, hold: 0, roll: 0 }, bad, start.position, choice.variant)
    chosen.push({ mark, variant: choice.variant })
    chosen.sort((a, b) => a.mark.time - b.mark.time)
    added++
  }
  const marks = chosen.map((c) => c.mark)
  const path = pathOf(marks)
  const share = grid.filter((t) => clearCheck(check(t, path(t)), FOLLOW_VISIBLE)).length / grid.length
  const moved = chosen.filter((c) => !isZeroVariant(c.variant)).length
  const out: { marks: CameraMarkSpec[]; moved: number; added: number; share: number } & ViewOutcome = { marks, moved, added, share }
  if (moved > 0) {
    const how = describeView(firstMove!.variant, specs[0]!.focalLength)
    out.note = `Kept ${name} in view${firstMove!.blocker ? ` past ${firstMove!.blocker}` : ''}: ${moved} of ${marks.length} marks moved (first: ${how})${added ? `, ${added} added` : ''}.`
  }
  if (share < MIN_CLEAR_SHARE - 1e-9) out.warning = `No clear view of ${name} for ${Math.round((1 - share) * 100)}% of the shot, even after moving the camera.`
  return out
}
