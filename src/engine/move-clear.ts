/**
 * Occlusion-aware camera moves (fork addition, shot-clear; see MODIFICATIONS.md):
 * a camera-move preset (orbit, push-in, crane …) laid in a set keeps its
 * subject in view. An orbit inside the alley kit rendered only wall.
 *
 * The whole move is fitted at once, so it keeps its shape: about the
 * subject's aim point at each mark's time, its distance comes in on a wider
 * lens (same frame size), it rises, its sweep from the first mark is cut and
 * the cut arc is turned round the subject. The nearest fit whose lens stays
 * out of the set and whose subject's projected box the set covers no more
 * than MOVE_SET_COVER on every frame wins; when none does, the fit clear on
 * the most frames is kept and a warning says so. A clear move is unchanged.
 * People-follow moves keep camera-clear.ts's clearFollowMove.
 *
 * PURE: no DOM / three.js / Electron, no randomness. It runs when a move is laid.
 */

import { aimAt, describeView, frameTimes, insideOf, nameOfEntity, sampler, setCover, viewFrame, type SetBox, type ViewOutcome } from './camera-clear'
import type { CameraMarkSpec } from './camera-moves'
import { ShotEvaluator } from './evaluate'
import { turnXZ } from './shot'
import { trackAim } from './track-aim'
import type { CameraMark, Scene, Shot, V3 } from './types'

/** A set piece may cover this share of a move's subject's projected box on any frame. */
export const MOVE_SET_COVER = 0.2

export interface MoveVariant {
  /** Distance and lens factor (< 1: closer on a wider lens). */
  closer: number
  /** Metres higher. */
  raise: number
  /** The share of the move's sweep round the subject kept, from its first mark. */
  arc: number
  /** The move turned round the subject (degrees); positive moves the camera to its own right. */
  turnDeg: number
}

const CLOSER = [1, 0.85, 0.7, 0.55, 0.45]
const RAISE = [0, 0.5, 1, 1.5, 2.5]
const ARC = [1, 0.75, 0.5, 0.25]
const TURN = [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180]
/** A move that sweeps less than this round its subject has no arc to cut (rad). */
const MIN_SWEEP = (10 * Math.PI) / 180

export const isZeroMove = (v: MoveVariant): boolean => v.closer === 1 && v.raise === 0 && v.arc === 1 && v.turnDeg === 0

/** How far a fit is from the move asked for: a closer step = a 0.5 m rise = 20° of turn = a quarter of the sweep cut. */
export function moveCost(v: MoveVariant): number {
  const closer = CLOSER.indexOf(v.closer)
  return (closer >= 0 ? closer : (1 - v.closer) / 0.15) + v.raise / 0.5 + Math.abs(v.turnDeg) / 20 + (1 - v.arc) / 0.25
}

/** The fits to try, nearest first (lenses ≥ 12 mm; arcs only for a move that sweeps). */
export function moveVariants(lens: number, sweeps: boolean): MoveVariant[] {
  const out: MoveVariant[] = []
  for (const turnDeg of TURN)
    for (const raise of RAISE)
      for (const closer of CLOSER.filter((c) => lens * c >= 12 - 1e-9))
        for (const arc of sweeps ? ARC : [1]) out.push({ closer, raise, arc, turnDeg })
  const key = (v: MoveVariant): number[] => [moveCost(v), Math.abs(v.turnDeg), v.raise, 1 - v.arc, TURN.indexOf(v.turnDeg)]
  return out.sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (Math.abs(ka[i]! - kb[i]!) > 1e-9) return ka[i]! - kb[i]!
    return 0
  })
}

/** Each mark's angle round its pivot (atan2(x, z) of the offset), unwrapped along the move. */
function sweepAngles(specs: CameraMarkSpec[], pivots: V3[]): number[] {
  const out: number[] = []
  for (const [i, m] of specs.entries()) {
    const a = Math.atan2(m.position.x - pivots[i]!.x, m.position.z - pivots[i]!.z)
    const prev = out[i - 1]
    out.push(prev === undefined ? a : prev + Math.atan2(Math.sin(a - prev), Math.cos(a - prev)))
  }
  return out
}

/** Does a move sweep round its subject (more than MIN_SWEEP)? */
export function moveSweeps(specs: CameraMarkSpec[], pivots: V3[]): boolean {
  const th = sweepAngles(specs, pivots)
  return th.some((a) => Math.abs(a - th[0]!) > MIN_SWEEP)
}

/**
 * A move's marks fitted by a variant, about each mark's pivot (the subject's
 * aim point at its time): its angle's sweep from the first mark cut to `arc`
 * and turned, its distance and lens times `closer`, raised. A tracking move
 * aims at the pivot; any other keeps its aim's offset from it.
 */
export function fitMoveMarks(specs: CameraMarkSpec[], pivots: V3[], v: MoveVariant, track: boolean): CameraMarkSpec[] {
  if (isZeroMove(v)) return specs
  const th = sweepAngles(specs, pivots)
  const turn = (v.turnDeg * Math.PI) / 180
  return specs.map((m, i) => {
    const L = pivots[i]!
    const r = Math.hypot(m.position.x - L.x, m.position.z - L.z)
    const a = th[0]! + v.arc * (th[i]! - th[0]!)
    const flat = turnXZ({ x: Math.sin(a) * r * v.closer, z: Math.cos(a) * r * v.closer }, turn)
    const position = { x: L.x + flat.x, y: Math.max(0.2, L.y + (m.position.y - L.y) * v.closer + v.raise), z: L.z + flat.z }
    const now = aimAt(position, L)
    let { pan, tilt } = now
    if (!track) {
      const asked = aimAt(m.position, L)
      pan += Math.atan2(Math.sin(m.pan - asked.pan), Math.cos(m.pan - asked.pan))
      tilt += m.tilt - asked.tilt
    }
    return { ...m, position, pan, tilt, focalLength: m.focalLength * v.closer }
  })
}

/** What a fit changed, e.g. "its sweep cut to half, 45% closer on a 16 mm lens". */
export function describeMove(v: MoveVariant, lens: number): string {
  const parts: string[] = []
  if (v.arc < 1) parts.push(`its sweep cut to ${v.arc === 0.75 ? 'three quarters' : v.arc === 0.5 ? 'half' : 'a quarter'}`)
  if (v.turnDeg) parts.push(`turned ${Math.abs(v.turnDeg)}° to the camera's ${v.turnDeg > 0 ? 'right' : 'left'}`)
  const view = describeView({ closer: v.closer, raise: v.raise }, lens)
  if (view) parts.push(view)
  return parts.join(', ')
}

/** Fits for the least blocked search when no fit is clear (a coarse grid, every frame each). */
const FALLBACK_TURN = [0, 40, -40, 90, -90, 180]
const FALLBACK_RAISE = [0, 1, 2.5]
const FALLBACK_CLOSER = [1, 0.7, 0.45]
const FALLBACK_ARC = [1, 0.5, 0.25]

/**
 * A preset move (`specs`, nearest first as the preset laid it) fitted to the
 * set round `subjectId`: unchanged when its lens stays out of the set and the
 * set covers no more than MOVE_SET_COVER of the subject on every frame, else
 * the nearest fit that does, else the fit clear on the most frames, with a
 * warning. `track`: the move aims at the subject (the preset's aim lock).
 */
export function clearMove(
  scene: Scene,
  shot: Shot,
  specs: CameraMarkSpec[],
  subjectId: string,
  boxes: SetBox[],
  opts: { track: boolean; name: string }
): { marks: CameraMarkSpec[]; variant: MoveVariant; share: number } & ViewOutcome {
  const zero: MoveVariant = { closer: 1, raise: 0, arc: 1, turnDeg: 0 }
  const entity = scene.entities.find((e) => e.id === subjectId)
  if (!entity || specs.length === 0) return { marks: specs, variant: zero, share: 1 }
  const at = sampler(scene, shot, boxes)
  const subjectAt = (t: number): ReturnType<typeof at>['subjects'][number] | undefined => at(t).subjects.find((s) => s.id === subjectId)
  const pivotAt = (t: number): V3 => {
    const s = subjectAt(t)
    return s ? trackAim(entity, s) : { ...entity.transform.position }
  }
  const pivots = specs.map((m) => pivotAt(m.time))
  const name = nameOfEntity(scene)(subjectId)
  // The camera alone (no cast): the path the marks make; a tracking move's aim is taken from the subject below.
  const cameraOnly = { ...scene, entities: [], blocking: [] } as Scene
  const pathOf = (marks: CameraMarkSpec[]): ((t: number) => { position: V3; pan: number; tilt: number; focalLength: number }) => {
    const camMarks: CameraMark[] = marks.map((m, i) => ({ id: `fit${i}`, ...m, position: { ...m.position } }))
    const ev = new ShotEvaluator(cameraOnly, { ...shot, camera: { ...shot.camera, marks: camMarks, trackEntityId: undefined } })
    return (t) => ev.evaluate(t).camera
  }
  const ignore = new Set([subjectId])
  const check = (path: ReturnType<typeof pathOf>, t: number): { ok: boolean; by: string | null } => {
    const s = subjectAt(t)
    if (!s) return { ok: true, by: null }
    const c = path(t)
    const aim = opts.track ? aimAt(c.position, trackAim(entity, s)) : c
    const world = at(t).world
    const inside = insideOf(c.position, world)
    if (inside) return { ok: false, by: inside }
    const cover = setCover(c.position, viewFrame(aim, c.focalLength, shot.camera.sensorId, shot.aspect), s, world.boxes, ignore)
    return cover.share <= MOVE_SET_COVER + 1e-9 ? { ok: true, by: null } : { ok: false, by: cover.by }
  }
  const frames = frameTimes(0, shot.duration, shot.fps || 24)
  // Every sixth frame first: most fits fail early.
  const order = [...frames.filter((_, i) => i % 6 === 0), ...frames.filter((_, i) => i % 6 !== 0)]
  const lens = specs[0]!.focalLength
  const asked = pathOf(specs)
  const blockedAt = order.map((t) => check(asked, t)).find((c) => !c.ok)
  if (!blockedAt) return { marks: specs, variant: zero, share: 1 }
  const blocker = blockedAt.by
  for (const v of moveVariants(lens, moveSweeps(specs, pivots))) {
    if (isZeroMove(v)) continue
    const marks = fitMoveMarks(specs, pivots, v, opts.track)
    const path = pathOf(marks)
    if (order.every((t) => check(path, t).ok)) {
      return { marks, variant: v, share: 1, note: `${opts.name} fitted to the set round ${name}${blocker ? ` (blocked by ${blocker})` : ''}: ${describeMove(v, lens)}.` }
    }
  }
  // No fit is clear: the one clear on the most frames (ties: the nearest).
  let best = { v: zero, marks: specs, share: -1 }
  const sweeps = moveSweeps(specs, pivots)
  for (const turnDeg of FALLBACK_TURN)
    for (const raise of FALLBACK_RAISE)
      for (const closer of FALLBACK_CLOSER.filter((c) => lens * c >= 12 - 1e-9))
        for (const arc of sweeps ? FALLBACK_ARC : [1]) {
          const v = { closer, raise, arc, turnDeg }
          const marks = fitMoveMarks(specs, pivots, v, opts.track)
          const path = pathOf(marks)
          const share = frames.filter((t) => check(path, t).ok).length / frames.length
          if (share > best.share + 1e-9 || (Math.abs(share - best.share) <= 1e-9 && moveCost(v) < moveCost(best.v))) best = { v, marks, share }
        }
  const how = describeMove(best.v, lens)
  return {
    marks: best.marks,
    variant: best.v,
    share: best.share,
    ...(how ? { note: `${opts.name} fitted to the set round ${name}: ${how}.` } : {}),
    warning: `${opts.name} can't keep ${name} in view here${blocker ? ` past ${blocker}` : ''}: ${Math.round((1 - best.share) * 100)}% of the move is still blocked.`
  }
}
