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
 * Fork (shot-clear): with the camera's frame, a view also counts the share
 * of each framed subject's projected box that a set piece covers in front of
 * it (`setCover`): the gym's bench in front of the fighters' feet. Shot words
 * and framing presets keep it at MAX_SET_COVER or under on every sample.
 *
 * PURE: no DOM / three.js / Electron, no randomness. It runs when a mark is
 * made; shot words keep the outcome in `ShotSpec.view` for the per-frame solve.
 */

import { assetSpec, entityHeight } from './assets'
import { ASPECT_RATIOS, horizontalFov, verticalFov } from './camera'
import type { CameraMarkSpec } from './camera-moves'
import { ShotEvaluator } from './evaluate'
import { headingOf } from './path'
import { solveShot, subjectPose, turnXZ, type ShotSpec, type ShotSubject, type ShotView } from './shot'
import { toWorld } from './skeleton'
import type { AspectId, CameraMark, EntityState, Scene, SensorId, Shot, V3 } from './types'
import { trackAim } from './track-aim'

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

/** Fork (main-thread): each box's heading cosine and sine, worked out once (the cover check casts hundreds of rays a view). */
const TRIG = new WeakMap<SetBox, { c: number; s: number }>()

function trig(b: SetBox): { c: number; s: number } {
  let t = TRIG.get(b)
  if (!t) {
    t = { c: Math.cos(b.heading), s: Math.sin(b.heading) }
    TRIG.set(b, t)
  }
  return t
}

function local(b: SetBox, p: V3): V3 {
  const dx = p.x - b.x
  const dz = p.z - b.z
  const { c, s } = trig(b)
  return { x: dx * c - dz * s, y: p.y, z: dx * s + dz * c }
}

function inBox(b: SetBox, p: V3, m: number): boolean {
  const l = local(b, p)
  return Math.abs(l.x) < b.hx + m && Math.abs(l.z) < b.hz + m && l.y > b.y0 - m && l.y < b.y1 + m
}

/** The segment a→b meets the box (slabs x, y, z in turn). Fork (main-thread): the same arithmetic, nothing allocated. */
function segmentHitsBox(box: SetBox, a: V3, b: V3): boolean {
  const { c, s } = trig(box)
  const adx = a.x - box.x
  const adz = a.z - box.z
  const bdx = b.x - box.x
  const bdz = b.z - box.z
  const ax = adx * c - adz * s
  const az = adx * s + adz * c
  const bx = bdx * c - bdz * s
  const bz = bdx * s + bdz * c
  let t0 = 0
  let t1 = 1
  for (let k = 0; k < 3; k++) {
    const p = k === 0 ? ax : k === 1 ? a.y : az
    const d = k === 0 ? bx - ax : k === 1 ? b.y - a.y : bz - az
    const lo = k === 0 ? -box.hx : k === 1 ? box.y0 : -box.hz
    const hi = k === 0 ? box.hx : k === 1 ? box.y1 : box.hz
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return false
      continue
    }
    let e0 = (lo - p) / d
    let e1 = (hi - p) / d
    if (e0 > e1) {
      const e = e0
      e0 = e1
      e1 = e
    }
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
      const { dims, fx } = subjectPose(s) // fork (main-thread): posed once per subject
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
  // Fork (shot-clear): a sample's subjects are checked against every variant; pose them once.
  const hit = targetCache.get(s)
  if (hit) return hit
  const out = targetsOf(s)
  targetCache.set(s, out)
  return out
}

const targetCache = new WeakMap<ShotSubject, { p: V3; w: number }[]>()

function targetsOf(s: ShotSubject): { p: V3; w: number }[] {
  if (isPerson(s)) {
    const { fx } = subjectPose(s) // fork (main-thread)
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

// ---------------------------------------------------------------------------
// Set cover (fork, shot-clear)
// ---------------------------------------------------------------------------

/** A set piece may cover this share of a framed subject's projected box (shot words, framing presets). */
export const MAX_SET_COVER = 0.1

/** Where a camera looks and how wide: pan, tilt and the tangents of the frame's half angles. */
export interface ViewFrame {
  pan: number
  tilt: number
  tanH: number
  tanV: number
}

/** The pan and tilt that aim from `from` at `to`. */
export function aimAt(from: V3, to: V3): { pan: number; tilt: number } {
  return aimAngles(from, to)
}

export function viewFrame(aim: { pan: number; tilt: number }, lens: number, sensorId: SensorId, aspect: AspectId): ViewFrame {
  const tanV = Math.tan(verticalFov(sensorId, lens, aspect) / 2)
  return { pan: aim.pan, tilt: aim.tilt, tanH: tanV * ASPECT_RATIOS[aspect], tanV }
}

const NO_COVER = { share: 0, by: null }
/** The grid of rays over a projected box. */
const COVER_NX = 12
const COVER_NY = 16

const coverCache = new WeakMap<ShotSubject, { pts: V3[]; pad: number; mid: V3 }>()

/** A subject's outline points (a person's posed rig, a thing's box corners), their pad and its middle. */
function coverPoints(s: ShotSubject): { pts: V3[]; pad: number; mid: V3 } {
  const hit = coverCache.get(s)
  if (hit) return hit
  let out: { pts: V3[]; pad: number; mid: V3 }
  if (isPerson(s)) {
    const { dims, fx } = subjectPose(s) // fork (main-thread)
    const w = (p: V3): V3 => toWorld(p, s.position, s.heading, s.scale)
    out = { pts: Object.values(fx).map(w), pad: dims.bodyW * 0.5 * s.scale, mid: w(fx.chest) }
  }
  else {
    const spec = assetSpec(s.assetId)
    const hx = spec.footprint * 0.5 * s.scale
    const hz = spec.footprint * s.scale
    const h = spec.height * s.scale
    const pts: V3[] = []
    for (const x of [-hx, hx]) for (const y of [0, h]) for (const z of [-hz, hz]) pts.push(toWorld({ x, y, z }, s.position, s.heading, 1))
    out = { pts, pad: Math.min(hx, hz), mid: { x: s.position.x, y: s.position.y + h * 0.5, z: s.position.z } }
  }
  coverCache.set(s, out)
  return out
}

/**
 * The share of a subject's projected box (its outline points padded, clipped
 * to the frame) that set boxes cover in front of it: rays from the lens over a
 * grid of the box, each stopped at the subject's middle less its pad; a ray
 * that meets a box (entities in `ignore` don't count) is covered. `by`: the
 * first box met.
 */
export function setCover(cam: V3, frame: ViewFrame, s: ShotSubject, boxes: SetBox[], ignore: ReadonlySet<string>): { share: number; by: string | null } {
  const sp = Math.sin(frame.pan)
  const cp = Math.cos(frame.pan)
  const st = Math.sin(frame.tilt)
  const ct = Math.cos(frame.tilt)
  const fwd = { x: -sp * ct, y: st, z: -cp * ct }
  const right = { x: cp, y: 0, z: -sp }
  const up = { x: sp * st, y: ct, z: cp * st }
  const depthOf = (p: V3): number => (p.x - cam.x) * fwd.x + (p.y - cam.y) * fwd.y + (p.z - cam.z) * fwd.z
  const ndcX = (p: V3, z: number): number => ((p.x - cam.x) * right.x + (p.z - cam.z) * right.z) / (z * frame.tanH)
  const ndcY = (p: V3, z: number): number => ((p.x - cam.x) * up.x + (p.y - cam.y) * up.y + (p.z - cam.z) * up.z) / (z * frame.tanV)
  const { pts, pad, mid } = coverPoints(s)
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of pts) {
    const z = depthOf(p)
    if (z <= 0.05) continue
    const x = ndcX(p, z)
    const y = ndcY(p, z)
    x0 = Math.min(x0, x - pad / (z * frame.tanH))
    x1 = Math.max(x1, x + pad / (z * frame.tanH))
    y0 = Math.min(y0, y - pad / (z * frame.tanV))
    y1 = Math.max(y1, y + pad / (z * frame.tanV))
  }
  x0 = Math.max(-1, x0)
  x1 = Math.min(1, x1)
  y0 = Math.max(-1, y0)
  y1 = Math.min(1, y1)
  const depth = depthOf(mid) - pad
  if (!(x1 > x0 && y1 > y0) || depth <= 0.05) return NO_COVER
  // Only boxes that reach in front of the subject and overlap its box on screen.
  const near: SetBox[] = []
  for (const b of boxes) {
    if (ignore.has(b.entityId)) continue
    const c = Math.cos(b.heading)
    const sn = Math.sin(b.heading)
    let zMin = Infinity
    let behind = false
    let bx0 = Infinity
    let bx1 = -Infinity
    let by0 = Infinity
    let by1 = -Infinity
    for (const lx of [-b.hx, b.hx])
      for (const lz of [-b.hz, b.hz])
        for (const y of [b.y0, b.y1]) {
          const p = { x: b.x + lx * c + lz * sn, y, z: b.z - lx * sn + lz * c }
          const z = depthOf(p)
          zMin = Math.min(zMin, z)
          if (z <= 0.05) {
            behind = true
            continue
          }
          bx0 = Math.min(bx0, ndcX(p, z))
          bx1 = Math.max(bx1, ndcX(p, z))
          by0 = Math.min(by0, ndcY(p, z))
          by1 = Math.max(by1, ndcY(p, z))
        }
    if (zMin >= depth) continue
    if (!behind && (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1)) continue
    near.push(b)
  }
  if (near.length === 0) return NO_COVER
  let covered = 0
  let by: string | null = null
  for (let i = 0; i < COVER_NX; i++)
    for (let j = 0; j < COVER_NY; j++) {
      const x = (x0 + ((i + 0.5) / COVER_NX) * (x1 - x0)) * frame.tanH
      const y = (y0 + ((j + 0.5) / COVER_NY) * (y1 - y0)) * frame.tanV
      const end = {
        x: cam.x + (fwd.x + right.x * x + up.x * y) * depth,
        y: cam.y + (fwd.y + up.y * y) * depth,
        z: cam.z + (fwd.z + right.z * x + up.z * y) * depth
      }
      const b = near.find((box) => segmentHitsBox(box, cam, end))
      if (b) {
        covered++
        by ??= b.name
      }
    }
  return { share: covered / (COVER_NX * COVER_NY), by }
}

export interface ViewCheck {
  /** What the camera is inside of, or null. */
  inside: string | null
  /** The least-seen framed subject's visible weight (0..1). */
  visible: number
  /** What hides it, or null. */
  blocker: string | null
  /** Fork (shot-clear), with the camera's frame: the most any set piece covers of a framed subject's projected box. */
  cover?: number
  /** What covers it, or null. */
  coverBy?: string | null
}

/** Fork (shot-clear): with `frame`, the check also measures the set's cover of each framed subject (setCover). */
export function checkView(cam: V3, framed: ShotSubject[], world: ViewWorld, ignore: ReadonlySet<string>, frame?: ViewFrame): ViewCheck {
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
  if (!frame) return { inside, visible, blocker }
  let cover = 0
  let coverBy: string | null = null
  for (const s of framed) {
    const c = setCover(cam, frame, s, world.boxes, ignore)
    if (c.share > cover) [cover, coverBy] = [c.share, c.by]
  }
  return { inside, visible, blocker, cover, coverBy }
}

const clearCheck = (c: ViewCheck, minVisible = MIN_VISIBLE, maxCover = MAX_SET_COVER): boolean =>
  !c.inside && c.visible >= minVisible - 1e-9 && (c.cover ?? 0) <= maxCover + 1e-9

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
 * Fork (shot-clear): `maxCover`, how much of a subject's box the set may
 * cover, holds on every sample (the 90 % share is for the rest).
 */
export function chooseView(
  check: (v: ViewVariant) => ViewCheck[],
  variants: ViewVariant[],
  prev?: ViewVariant,
  minVisible = MIN_VISIBLE,
  maxCover = MAX_SET_COVER
): ViewChoice {
  const clearCheck = (c: ViewCheck): boolean => !c.inside && c.visible >= minVisible - 1e-9 && (c.cover ?? 0) <= maxCover + 1e-9
  const overCover = (c: ViewCheck): boolean => (c.cover ?? 0) > maxCover + 1e-9
  const ordered = prev
    ? variants
        .map((v, i) => ({ v, i, cost: variantCost(v) + 0.75 * variantDistance(v, prev) }))
        .sort((a, b) => a.cost - b.cost || a.i - b.i)
        .map((x) => x.v)
    : variants
  const askedChecks = check(ZERO)
  const problem = askedChecks.find((c) => !clearCheck(c))
  // Fork (shot-clear): a view that fails only on the set's cover is blocked by what covers it.
  const coverOnly = !!problem && !problem.inside && problem.visible >= minVisible - 1e-9
  const blocker = problem ? (coverOnly ? (problem.coverBy ?? null) : (problem.inside ?? problem.blocker)) : null
  let best: { variant: ViewVariant; share: number; inside: number; visible: number; cover: number } | null = null
  for (const variant of ordered) {
    const checks = isZeroVariant(variant) ? askedChecks : check(variant)
    if (checks.length === 0) return { variant, clear: true, share: 1, blocker }
    const inside = checks.filter((c) => c.inside).length
    const share = checks.filter(clearCheck).length / checks.length
    if (inside === 0 && share >= MIN_CLEAR_SHARE - 1e-9 && !checks.some(overCover)) return { variant, clear: true, share, blocker }
    const visible = checks.reduce((s, c) => s + (c.inside ? 0 : c.visible), 0) / checks.length
    const cover = checks.reduce((s, c) => s + (c.cover ?? 0), 0) / checks.length
    // Fork (shot-clear): the least blocked view is clear on the most samples, then inside something on the fewest: a
    // view that grazes a wall on one sample beats one that keeps off the walls and sees only wall.
    if (
      !best ||
      share > best.share + 1e-9 ||
      (Math.abs(share - best.share) <= 1e-9 &&
        (inside < best.inside ||
          (inside === best.inside && (visible > best.visible + 1e-9 || (Math.abs(visible - best.visible) <= 1e-9 && cover < best.cover - 1e-9)))))
    )
      best = { variant, share, inside, visible, cover }
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
    out.push({ id: e.id, assetId: e.assetId, params: e.params, scale: e.transform.scale, position: es.position, heading: es.heading, joints, ...(es.clip ? { clip: es.clip } : {}) })
  }
  return out
}

/** Fork (shot-clear): exported for move-clear.ts. */
export interface Sample {
  t: number
  subjects: ShotSubject[]
  world: ViewWorld
}

export const nameOfEntity = (scene: Scene): ((id: string) => string) => {
  const names = new Map(scene.entities.map((e) => [e.id, e.label?.text || e.name]))
  return (id) => names.get(id) ?? id
}

/** Subjects and occluders of a shot at time t (cached). Fork (shot-clear): exported for move-clear.ts. */
export function sampler(scene: Scene, shot: Shot, boxes: SetBox[], samples: SampleStore = sampleStore(scene, shot, boxes)): (t: number) => Sample {
  const cache = new Map<number, Sample>()
  return (t) => {
    const key = Math.round(t * 1000)
    let s = cache.get(key)
    if (!s) {
      s = samples.at(t)
      cache.set(key, s)
    }
    return s
  }
}

/**
 * Fork (main-thread): a shot's samples by exact time, for several searches over the same scene, shot and set
 * (a fight coverage's framings, an over-the-shoulder beat and its two-shot); each search's sampler keeps its own
 * millisecond lookup on top, so each sees what it saw alone. The scene and shot must not change while it is used.
 */
export interface SampleStore {
  at(t: number): Sample
}

export function sampleStore(scene: Scene, shot: Shot, boxes: SetBox[]): SampleStore {
  const ev = new ShotEvaluator(scene, shot)
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId) ?? scene.blocking[0]
  const moving = new Set((take?.tracks ?? []).filter((tr) => tr.marks.length > 0).map((tr) => tr.entityId))
  const nameOf = nameOfEntity(scene)
  const byTime = new Map<number, Sample>()
  return {
    at: (t) => {
      let s = byTime.get(t)
      if (!s) {
        const subjects = shotSubjects(scene, ev.evaluateEntities(Math.min(Math.max(t, 0), shot.duration))) // fork (main-thread): no camera
        const cast = castWorld(subjects, moving, nameOf)
        s = { t, subjects, world: { boxes: [...boxes, ...cast.boxes], bodies: cast.bodies } }
        byTime.set(t, s)
      }
      return s
    }
  }
}

/** Evenly spaced sample times over a span (about two a second, 2–13; one for an instant). */
function spanTimes(t0: number, t1: number): number[] {
  if (t1 - t0 < 1e-3) return [t0]
  const n = Math.min(13, Math.max(2, Math.ceil((t1 - t0) / 0.5) + 1))
  return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1))
}

/** Fork (shot-clear): every frame of a span at `fps`. */
export function frameTimes(t0: number, t1: number, fps: number): number[] {
  const out: number[] = []
  for (let f = Math.ceil(t0 * fps - 1e-6); f / fps <= t1 + 1e-9; f++) out.push(f / fps)
  return out
}

/**
 * Fork (shot-clear): chooseView over the sample `times`, then the choice on
 * every frame: a frame where the camera is inside something or the set covers
 * a subject (a fighter's step swings a held framing into a wall between two
 * samples) joins the samples and the search runs again.
 */
export function chooseOverFrames(checkAt: (t: number, v: ViewVariant) => ViewCheck, times: number[], frames: number[], variants: ViewVariant[]): ViewChoice {
  const fails = (v: ViewVariant, t: number): boolean => {
    const c = checkAt(t, v)
    return !!c.inside || (c.cover ?? 0) > MAX_SET_COVER + 1e-9
  }
  let ts = times
  let choice = chooseView((v) => ts.map((t) => checkAt(t, v)), variants)
  for (let pass = 0; pass < 4 && choice.clear; pass++) {
    const bad = frames.filter((t) => fails(choice.variant, t))
    if (bad.length === 0) return choice
    ts = [...ts, ...bad].sort((a, b) => a - b)
    choice = chooseView((v) => ts.map((t) => checkAt(t, v)), variants)
  }
  if (choice.clear && !frames.some((t) => fails(choice.variant, t))) return choice
  // No view holds on every frame: of the samples' pick and a coarse grid of the variants, the one clear on the most
  // frames (every third), else the nearest. The samples alone kept a view that sat in a wall between them.
  const grid = frames.filter((_, i) => i % 3 === 0)
  const coarse = (v: ViewVariant): boolean => [0, 20, 40, 60, 90, 120, 180].includes(Math.abs(v.turnDeg)) && [0, 1, 2.5].includes(v.raise) && [1, 0.7, 0.45].includes(v.closer)
  let best = { variant: choice.variant, share: -1 }
  for (const v of [choice.variant, ...variants.filter((x) => coarse(x) && x !== choice.variant)]) {
    const share = grid.filter((t) => clearCheck(checkAt(t, v))).length / Math.max(1, grid.length)
    if (share > best.share + 1e-9 || (Math.abs(share - best.share) <= 1e-9 && variantCost(v) < variantCost(best.variant) - 1e-9)) best = { variant: v, share }
  }
  return { ...choice, variant: best.variant, clear: false, share: best.share }
}

const OPEN: ViewCheck = { inside: null, visible: 1, blocker: null }

/**
 * Fork (main-thread): a view check made once per time and variant. chooseOverFrames re-runs chooseView over a
 * growing set of samples and every frame of the span, asking the same checks again.
 */
function checkedOnce(checkAt: (t: number, v: ViewVariant) => ViewCheck): (t: number, v: ViewVariant) => ViewCheck {
  const done = new Map<string, ViewCheck>()
  return (t, v) => {
    const key = `${t} ${v.turnDeg} ${v.raise} ${v.closer}`
    let c = done.get(key)
    if (!c) {
      c = checkAt(t, v)
      done.set(key, c)
    }
    return c
  }
}

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

/**
 * Fork (shot-clear): the lens new shot words start from. A mark gives back the
 * lens it was asked for, not what a clear view or a shoulder made of it: a
 * plain mark its own, shot words their `lens`, else their focal length over
 * the view's `closer`; an over-the-shoulder mark with no lens picked its own
 * and says nothing. `prefer` (the mark being re-framed) first, then the latest
 * mark that says, else 35 mm. Fight coverage re-run on its own marks would
 * otherwise start from the last framing's lens (an over-the-shoulder 68 mm put
 * an alley's wide two-shot 14 m back, behind a wall).
 */
export function baseLens(marks: CameraMark[], prefer?: CameraMark): number {
  const asked = (m: CameraMark): number | null =>
    !m.shot ? m.focalLength : m.shot.lens !== undefined ? m.shot.lens : m.shot.over ? null : m.focalLength / (m.shot.view?.closer ?? 1)
  if (prefer) {
    const a = asked(prefer)
    if (a !== null) return a
  }
  for (const m of [...marks].sort((a, b) => b.time - a.time)) {
    const a = asked(m)
    if (a !== null) return a
  }
  return 35
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
  boxes: SetBox[],
  samples?: SampleStore
): { spec: ShotSpec } & ViewOutcome {
  const base: ShotSpec = { ...spec }
  delete base.view
  const lens = base.lens ?? focalLength
  const ots = !!base.over
  const overhead = base.angle === 'overhead'
  const line = (base.side ?? (base.subjectIds.length > 1 ? 'line' : 'frontRight')) === 'line'
  const variants = viewVariants({ lens, turns: !ots && !overhead, raise: !overhead, closer: !ots, maxTurnDeg: line ? 60 : 180 })
  const at = sampler(scene, shot, boxes, samples)
  const t1 = Math.max(span[0], span[1])
  const ignore = new Set([...base.subjectIds, ...(base.over ? [base.over.entityId] : [])])
  const setup = { sensorId: shot.camera.sensorId, aspect: shot.aspect, focalLength }
  const checkAt = (t: number, v: ViewVariant): ViewCheck => {
    const s = at(t)
    const framed = base.subjectIds.map((id) => s.subjects.find((x) => x.id === id)).filter((x): x is ShotSubject => !!x)
    if (framed.length < base.subjectIds.length) return OPEN
    try {
      const view: ShotView = isZeroVariant(v) ? {} : { turnDeg: v.turnDeg, raise: v.raise, closer: v.closer }
      const solved = solveShot({ ...base, view }, s.subjects, setup)
      // Fork (shot-clear): and the set kept out of the sightline (setCover).
      return checkView(solved.position, framed, s.world, ignore, viewFrame(solved, solved.focalLength, shot.camera.sensorId, shot.aspect))
    } catch {
      return OPEN
    }
  }
  const choice = chooseOverFrames(checkedOnce(checkAt), spanTimes(span[0], t1), frameTimes(span[0], t1, shot.fps || 24), variants)
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
  const ignore = new Set(subjectIds)
  const checkAt = (t: number, v: ViewVariant): ViewCheck => {
    const cam = variantPosition(pose.position, pose.look, v)
    const frame = viewFrame(aimAngles(cam, pose.look), pose.focalLength * v.closer, shot.camera.sensorId, shot.aspect) // fork (shot-clear)
    const s = at(t)
    const framed = subjectIds.map((id) => s.subjects.find((x) => x.id === id)).filter((x): x is ShotSubject => !!x)
    return framed.length === 0 ? OPEN : checkView(cam, framed, s.world, ignore, frame)
  }
  const variants = viewVariants({ lens: pose.focalLength, maxTurnDeg: opts.maxTurnDeg })
  const choice = chooseOverFrames(checkedOnce(checkAt), spanTimes(0, shot.duration), frameTimes(0, shot.duration, shot.fps || 24), variants)
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
/** Fork (set-routines): a follow move whose asked path is clear less than this share of the time tries one steady offset first. */
const STEADY_BELOW = 0.75
/** A follow camera keeps this far from its subject's aim point (m). */
const FOLLOW_MIN_DIST = 1.5
/**
 * Fork (set-routines): other cast keeps this far from a follow camera's lens
 * (m), and anyone between the lens and the subject fills at most this share
 * of the frame (a chase's pursuers filled a third to a half of a
 * follow-behind frame). Cast beyond the subject is the scene.
 */
const FOLLOW_CAST_CLEAR = 2.5
const FOLLOW_CAST_SHARE = 0.1
/** A follow camera sees its subject whole: head, chest and pelvis. */
const FOLLOW_VISIBLE = 1

/**
 * Fork (set-routines): the first other person a follow camera at `cam`,
 * aimed at `look` on a `lens` mm lens, has too near (within
 * FOLLOW_CAST_CLEAR) or, in front of the subject, too big (over
 * FOLLOW_CAST_SHARE of the frame, the posed body's projected box).
 */
export function crowdedBy(subjects: ShotSubject[], subjectId: string, cam: V3, look: V3, lens: number, shot: Shot, nameOf: (id: string) => string): string | null {
  const dist = (p: V3): number => Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z)
  const chestOf = (s: ShotSubject): V3 => toWorld(subjectPose(s).fx.chest, s.position, s.heading, s.scale)
  const subject = subjects.find((s) => s.id === subjectId)
  const front = subject && isPerson(subject) ? dist(chestOf(subject)) : dist(look)
  const { pan, tilt } = aimAngles(cam, look)
  const tanH = Math.tan(horizontalFov(shot.camera.sensorId, lens) / 2)
  const tanV = Math.tan(verticalFov(shot.camera.sensorId, lens, shot.aspect) / 2)
  const fwd = { x: -Math.sin(pan) * Math.cos(tilt), y: Math.sin(tilt), z: -Math.cos(pan) * Math.cos(tilt) }
  const right = { x: Math.cos(pan), y: 0, z: -Math.sin(pan) }
  const up = { x: Math.sin(pan) * Math.sin(tilt), y: Math.cos(tilt), z: Math.cos(pan) * Math.sin(tilt) }
  for (const s of subjects) {
    if (s.id === subjectId || !isPerson(s)) continue
    const { dims, fx } = subjectPose(s)
    const pts = Object.values(fx).map((p) => toWorld(p, s.position, s.heading, s.scale))
    const pad = dims.bodyW * 0.5 * s.scale
    if (Math.min(...pts.map(dist)) - pad < FOLLOW_CAST_CLEAR) return `right behind ${nameOf(s.id)}`
    // Only cast nearer the lens than the subject (by half a metre) is held to the share: beside or beyond it is the scene.
    if (dist(toWorld(fx.chest, s.position, s.heading, s.scale)) >= front - 0.5) continue
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const p of pts) {
      const d = { x: p.x - cam.x, y: p.y - cam.y, z: p.z - cam.z }
      const z = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z
      if (z <= 0.05) continue
      const x = (d.x * right.x + d.z * right.z) / (z * tanH)
      const y = (d.x * up.x + d.y * up.y + d.z * up.z) / (z * tanV)
      x0 = Math.min(x0, x - pad / (z * tanH))
      x1 = Math.max(x1, x + pad / (z * tanH))
      y0 = Math.min(y0, y - pad / (z * tanV))
      y1 = Math.max(y1, y + pad / (z * tanV))
    }
    const share = (Math.max(0, Math.min(1, x1) - Math.max(-1, x0)) * Math.max(0, Math.min(1, y1) - Math.max(-1, y0))) / 4
    if (share > FOLLOW_CAST_SHARE) return `with ${nameOf(s.id)} filling the frame`
  }
  return null
}

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
    return s ? trackAim(entity, s) : { x: 0, y: height * 0.8, z: 0 } // fork (set-routines): where the tracking camera aims
  }
  const nameOf = nameOfEntity(scene)
  const name = nameOf(subjectId)
  const check = (t: number, cam: V3, lens: number): ViewCheck => {
    const s = subjectAt(t)
    if (!s) return OPEN
    const c = checkView(cam, [s], at(t).world, ignore)
    if (c.inside) return c
    const look = lookAt(t)
    if (Math.hypot(cam.x - look.x, cam.y - look.y, cam.z - look.z) < FOLLOW_MIN_DIST) return { ...c, inside: `too close to ${name}` }
    const crowd = crowdedBy(at(t).subjects, subjectId, cam, look, lens, shot, nameOf) // fork (set-routines)
    return crowd ? { ...c, inside: crowd } : c
  }
  const pathOf = (marks: CameraMarkSpec[]): ((t: number) => { position: V3; focalLength: number }) => {
    const camMarks: CameraMark[] = marks.map((m, i) => ({ id: `clear${i}`, ...m, position: { ...m.position } }))
    const ev = new ShotEvaluator(scene, { ...shot, camera: { ...shot.camera, marks: camMarks, trackEntityId: subjectId } })
    return (t) => ev.evaluate(t).camera
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
  const sorted = [...specs].sort((a, b) => a.time - b.time)
  // Fork (set-routines): what blocks most of the move (a chase's pursuers behind its runner) gets one steady offset for the
  // whole move, swung, raised or both, when one keeps every check clear: a camera that dodges mark by mark lurches.
  const coarse: number[] = []
  for (let t = 0; t < shot.duration - 1e-9; t += PATH_STEP) coarse.push(t)
  coarse.push(shot.duration)
  const clearShare = (marks: CameraMarkSpec[]): number => {
    const p = pathOf(marks)
    return coarse.filter((t) => clearCheck(check(t, p(t).position, p(t).focalLength), FOLLOW_VISIBLE)).length / coarse.length
  }
  if (clearShare(sorted) < STEADY_BELOW) {
    const steady = variants.filter((v) => v.closer === 1 && !isZeroVariant(v)).find((v) => clearShare(sorted.map((m) => place(m, m.time, m.position, v))) === 1)
    if (steady) {
      firstMove = { variant: steady, clear: true, share: 1, blocker: chooseView((v) => [check(sorted[0]!.time, variantPosition(sorted[0]!.position, lookAt(sorted[0]!.time), v), sorted[0]!.focalLength)], [{ turnDeg: 0, raise: 0, closer: 1 }]).blocker }
      for (const m of sorted) chosen.push({ mark: place(m, m.time, m.position, steady), variant: steady })
    }
  }
  if (chosen.length === 0)
    for (const m of sorted) {
      const look = lookAt(m.time)
      const choice = chooseView((v) => [check(m.time, variantPosition(m.position, look, v), m.focalLength * v.closer)], variants, prev, FOLLOW_VISIBLE)
      if (!isZeroVariant(choice.variant)) firstMove ??= choice
      prev = choice.variant
      chosen.push({ mark: isZeroVariant(choice.variant) ? m : place(m, m.time, m.position, choice.variant), variant: choice.variant })
    }
  const grid: number[] = []
  // Fork (set-routines): every frame, so cast that crosses in front between two checks is caught too.
  for (let t = 0; t < shot.duration - 1e-9; t += Math.min(PATH_STEP, 1 / (shot.fps || 24))) grid.push(t)
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
    // Fork (set-routines): a mark may go on any frame without one (the path checks every frame).
    const bad = grid.find((t) => !clearCheck(check(t, path(t).position, path(t).focalLength), FOLLOW_VISIBLE) && !chosen.some((c) => Math.abs(c.mark.time - t) < Math.min(0.06, 0.5 / (shot.fps || 24))))
    if (bad === undefined) break
    const before = [...chosen].reverse().find((c) => c.mark.time < bad)
    const after = chosen.find((c) => c.mark.time > bad)
    const start = before && after ? between(bad, before.mark, after.mark) : { position: asked(bad).position, focalLength: (before ?? after)!.mark.focalLength }
    const look = lookAt(bad)
    const choice = chooseView((v) => [check(bad, variantPosition(start.position, look, v), start.focalLength * v.closer)], variants, undefined, FOLLOW_VISIBLE)
    if (!isZeroVariant(choice.variant)) firstMove ??= choice
    const template = before?.mark ?? after!.mark
    const mark = place({ ...template, focalLength: start.focalLength, easeIn: 0, easeOut: 0, hold: 0, roll: 0 }, bad, start.position, choice.variant)
    chosen.push({ mark, variant: choice.variant })
    chosen.sort((a, b) => a.mark.time - b.mark.time)
    added++
  }
  const marks = chosen.map((c) => c.mark)
  const path = pathOf(marks)
  const share = grid.filter((t) => clearCheck(check(t, path(t).position, path(t).focalLength), FOLLOW_VISIBLE)).length / grid.length
  const moved = chosen.filter((c) => !isZeroVariant(c.variant)).length
  const out: { marks: CameraMarkSpec[]; moved: number; added: number; share: number } & ViewOutcome = { marks, moved, added, share }
  if (moved > 0) {
    const how = describeView(firstMove!.variant, specs[0]!.focalLength)
    out.note = `Kept ${name} in view${firstMove!.blocker ? ` past ${firstMove!.blocker}` : ''}: ${moved} of ${marks.length} marks moved (first: ${how})${added ? `, ${added} added` : ''}.`
  }
  if (share < MIN_CLEAR_SHARE - 1e-9) out.warning = `No clear view of ${name} for ${Math.round((1 - share) * 100)}% of the shot, even after moving the camera.`
  return out
}
