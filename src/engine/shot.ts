/**
 * Shot solver (fork addition; see MODIFICATIONS.md): turns shot words — a
 * size, subjects, an optional over-the-shoulder entity, side, angle, lens and
 * dutch — into an exact camera pose from the subjects' live positions.
 *
 * Exactness: at eye level a single's head-top sits at NDC y = the size's
 * fillFraction, horizontally centred; group shots keep every head and both
 * shoulders in frame; OTS pins the named shoulder near the frame edge and
 * the subject's eyes on the far third (as near the upper third as the size
 * allows), the camera on A's eye line or raised / lowered for the angle. People are measured with rig FK (skeleton.ts); other
 * things by their extent, max(height, 2 × footprint).
 *
 * PURE: no DOM / three.js / Electron. Throws on an unknown subject or an
 * over entity that is the subject — callers fall back to the stored pose.
 */

import { assetSpec } from './assets'
import { ASPECT_RATIOS, SHOT_SIZES, frameSubject, verticalFov } from './camera'
import { headingOf } from './path'
import { personDims, poseEffectors, toWorld } from './skeleton'
import type { AspectId, EntityCategory, SensorId, ShotSizeId, V3 } from './types'

export type ShotSide = 'front' | 'frontLeft' | 'left' | 'backLeft' | 'back' | 'backRight' | 'right' | 'frontRight' | 'line'
export type ShotAngle = 'eye' | 'low' | 'high' | 'overhead' | 'ground'

export interface ShotSpec {
  size: ShotSizeId
  subjectIds: string[]
  over?: { entityId: string; shoulder: 'left' | 'right' }
  side?: ShotSide
  angle?: ShotAngle
  lens?: number
  dutchDeg?: number
  /** Axis for side 'line' (default: the first two subjects, or the nearest other person). */
  lineIds?: [string, string]
  /** Which side of the line axis the camera sits on (sign of (B−A) × (cam−A)); default: solveShot's lineSide. */
  lineSide?: 1 | -1
}

export interface ShotSubject {
  id: string
  assetId: string
  params?: Record<string, number | string>
  scale: number
  position: V3
  heading: number
  joints?: Record<string, number>
}

export interface ShotSetup {
  sensorId: SensorId
  aspect: AspectId
  focalLength: number
}

export interface SolvedShot {
  position: V3
  pan: number
  tilt: number
  roll: number
  focalLength: number
  achievedSize?: ShotSizeId
}

/** Camera azimuth from the subject's facing, clockwise toward its own right (degrees). */
const SIDE_AZIMUTH: Record<Exclude<ShotSide, 'line'>, number> = {
  front: 0,
  frontRight: 45,
  right: 90,
  backRight: 135,
  back: 180,
  backLeft: 225,
  left: 270,
  frontLeft: 315
}

/** Group framing: horizontal margin (m) and the share of frame width the group fills. */
const GROUP_MARGIN = 0.8
const GROUP_FILL = 0.85
/** An over-the-shoulder camera with a line side stays at least this far on its side (m). */
const LINE_CLEARANCE = 0.15

interface Body {
  subject: ShotSubject
  isPerson: boolean
  groundY: number
  /** Aim reference: head centre for people, the base centre for things. */
  ref: V3
  /** Height used for shot sizes: head-top (people) or extent (things), above ground. */
  height: number
  /** Actual standing height (things aim at its middle). */
  bodyHeight: number
  /** Points that must stay in frame for group shots. */
  points: V3[]
  shoulders: { left: V3; right: V3 }
}

interface XZ {
  x: number
  z: number
}

const norm = (v: XZ): XZ | null => {
  const l = Math.hypot(v.x, v.z)
  return l < 1e-6 ? null : { x: v.x / l, z: v.z / l }
}

function bodyOf(s: ShotSubject): Body {
  const scale = s.scale
  if (s.assetId.startsWith('person.')) {
    const dims = personDims(s.assetId, s.params)
    const fx = poseEffectors(dims, s.joints)
    const w = (p: V3): V3 => toWorld(p, s.position, s.heading, scale)
    const head = w(fx.head)
    const top = head.y + dims.headR * scale
    const left = w(fx.shoulderL)
    const right = w(fx.shoulderR)
    return {
      subject: s,
      isPerson: true,
      groundY: s.position.y,
      ref: head,
      height: top - s.position.y,
      bodyHeight: top - s.position.y,
      points: [{ x: head.x, y: top, z: head.z }, head, left, right],
      shoulders: { left, right }
    }
  }
  const spec = assetSpec(s.assetId)
  const bodyHeight = spec.height * scale
  const extent = Math.max(spec.height, 2 * spec.footprint) * scale
  const fwd = { x: -Math.sin(s.heading), z: -Math.cos(s.heading) }
  const half = spec.footprint * scale
  const mid = s.position.y + bodyHeight / 2
  const shoulderY = s.position.y + bodyHeight * 0.85
  const side = { x: Math.cos(s.heading), z: -Math.sin(s.heading) }
  return {
    subject: s,
    isPerson: false,
    groundY: s.position.y,
    ref: { x: s.position.x, y: mid, z: s.position.z },
    height: extent,
    bodyHeight,
    points: [
      { x: s.position.x + fwd.x * half, y: mid, z: s.position.z + fwd.z * half },
      { x: s.position.x - fwd.x * half, y: mid, z: s.position.z - fwd.z * half },
      { x: s.position.x, y: s.position.y + bodyHeight, z: s.position.z }
    ],
    shoulders: {
      left: { x: s.position.x - side.x * 0.2 * scale, y: shoulderY, z: s.position.z - side.z * 0.2 * scale },
      right: { x: s.position.x + side.x * 0.2 * scale, y: shoulderY, z: s.position.z + side.z * 0.2 * scale }
    }
  }
}

/** Aim height for a size: centre of the visible region (people) or the body's middle (things). */
function aimY(body: Body, distanceInfo: { targetHeight: number }): number {
  if (body.isPerson) return body.groundY + distanceInfo.targetHeight
  return body.groundY + Math.min(distanceInfo.targetHeight, body.bodyHeight / 2)
}

/** Direction from a subject toward the camera for a side (horizontal unit). */
function sideDirection(spec: ShotSpec, first: Body, byId: Map<string, Body>, all: ShotSubject[], lineSide: 1 | -1): XZ {
  const side = spec.side ?? (spec.subjectIds.length > 1 ? 'line' : 'frontRight')
  if (side === 'line') {
    let a: XZ | null = null
    let b: XZ | null = null
    const pos = (id: string): XZ | null => {
      const s = byId.get(id)?.subject ?? all.find((x) => x.id === id)
      return s ? { x: s.position.x, z: s.position.z } : null
    }
    if (spec.lineIds) {
      a = pos(spec.lineIds[0])
      b = pos(spec.lineIds[1])
    } else if (spec.subjectIds.length > 1) {
      a = pos(spec.subjectIds[0]!)
      b = pos(spec.subjectIds[1]!)
    } else {
      // Single on the line: the axis runs to the nearest other person.
      const me = first.subject
      let best: ShotSubject | null = null
      let bestD = Infinity
      for (const s of all) {
        if (s.id === me.id || !s.assetId.startsWith('person.')) continue
        const d = Math.hypot(s.position.x - me.position.x, s.position.z - me.position.z)
        if (d < bestD) {
          bestD = d
          best = s
        }
      }
      if (best) {
        a = { x: me.position.x, z: me.position.z }
        b = { x: best.position.x, z: best.position.z }
      }
    }
    const axis = a && b ? norm({ x: b.x - a.x, z: b.z - a.z }) : null
    const sign = spec.lineSide ?? lineSide
    if (axis) return { x: -axis.z * sign, z: axis.x * sign }
    return sideDirection({ ...spec, side: 'frontRight' }, first, byId, all, lineSide)
  }
  const az = (SIDE_AZIMUTH[side] * Math.PI) / 180
  const h = first.subject.heading
  const fwd = { x: -Math.sin(h), z: -Math.cos(h) }
  const right = { x: Math.cos(h), z: -Math.sin(h) }
  return { x: fwd.x * Math.cos(az) + right.x * Math.sin(az), z: fwd.z * Math.cos(az) + right.z * Math.sin(az) }
}

/** Pan/tilt that aim from `from` at `to` (tilt positive = up). */
function aimAt(from: V3, to: V3): { pan: number; tilt: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const flat = Math.hypot(dx, dz)
  return { pan: headingOf({ x: dx, y: 0, z: dz }), tilt: Math.atan2(dy, Math.max(flat, 1e-9)) }
}

/** NDC of a world point for a camera pose (matches the renderer's 'YXZ' camera). */
function ndc(p: V3, pos: V3, pan: number, tilt: number, tanV: number, tanH: number): { x: number; y: number; depth: number } {
  const cp = Math.cos(pan)
  const sp = Math.sin(pan)
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  const right = { x: cp, y: 0, z: -sp }
  const up = { x: sp * st, y: ct, z: cp * st }
  const fwd = { x: -sp * ct, y: st, z: -cp * ct }
  const d = { x: p.x - pos.x, y: p.y - pos.y, z: p.z - pos.z }
  const depth = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z
  return {
    x: (d.x * right.x + d.y * right.y + d.z * right.z) / depth / tanH,
    y: (d.x * up.x + d.y * up.y + d.z * up.z) / depth / tanV,
    depth
  }
}

/** Camera height for an angle (overhead is handled by the caller). */
function cameraY(angle: ShotAngle, aim: number, groundY: number): number {
  if (angle === 'low') return groundY + 0.5
  if (angle === 'high') return aim + 1.5
  if (angle === 'ground') return groundY + 0.15
  return aim
}

/** Nearest named size for a frame height at the subject (in subject heights). */
function nearestSize(frameOverHeight: number): ShotSizeId {
  let best: ShotSizeId = 'MS'
  let bestErr = Infinity
  for (const s of Object.values(SHOT_SIZES)) {
    const err = Math.abs(Math.log(frameOverHeight) - Math.log(s.visibleFraction / s.fillFraction))
    if (err < bestErr) {
      bestErr = err
      best = s.id
    }
  }
  return best
}

/**
 * OTS composition (NDC): the near shoulder joint on A's side of the frame, the
 * subject's eyes on the far third line. The shoulder's height in frame is
 * whatever keeps the camera nearest its target height (A's eye line, or the
 * angle's), within these bounds.
 */
const OTS_SHOULDER_X = 0.7
const OTS_SHOULDER_Y = { min: -0.8, max: 0.5 }
const OTS_EYES_X = 1 / 3
/** Camera to the near shoulder (m): the distance when no lens is given, and the closest a size may bring it. */
const OTS_SHOULDER_DIST = 0.6
const OTS_MIN_SHOULDER_DIST = 0.45
/** A high or low angle the camera can't reach from the size's distance backs it off, up to this factor. */
const OTS_MAX_BACKOFF = 4
/** A wide size on a long lens would swing the camera round to A's side: it stays within this of the A–B axis (rad). */
const OTS_MAX_OFF_AXIS = (40 * Math.PI) / 180

/** World direction of a camera-space vector for pan/tilt (no roll). */
function toWorldDir(v: V3, pan: number, tilt: number): V3 {
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  const y = v.y * ct - v.z * st
  const z1 = v.y * st + v.z * ct
  return { x: v.x * Math.cos(pan) + z1 * Math.sin(pan), y, z: -v.x * Math.sin(pan) + z1 * Math.cos(pan) }
}

/** Pan/tilt (no roll) that turn camera-space vector `w` onto world vector `v` of the same length. */
function orient(w: V3, v: V3): { pan: number; tilt: number } {
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))
  // w.y·cos t − w.z·sin t = v.y, written as rho·cos(t − phi)
  const rho = Math.max(Math.hypot(w.y, w.z), 1e-9)
  const phi = Math.atan2(-w.z, w.y)
  const c = Math.acos(Math.min(1, Math.max(-1, v.y / rho)))
  const t1 = wrap(phi + c)
  const t2 = wrap(phi - c)
  const tilt = Math.abs(t1) <= Math.abs(t2) ? t1 : t2
  const z1 = w.y * Math.sin(tilt) + w.z * Math.cos(tilt)
  return { pan: wrap(Math.atan2(v.x, v.z) - Math.atan2(w.x, z1)), tilt }
}

interface OtsPose {
  position: V3
  pan: number
  tilt: number
  /** Camera-space ray to the eyes, for re-aiming after a line push. */
  eyesRay: V3
  /** Frame height at the eyes' depth (m). */
  frameHeight: number
}

/**
 * Over the shoulder: the near shoulder joint lands at (±OTS_SHOULDER_X,
 * shoulderY) on A's side of the frame and the subject's eyes on the far third
 * line, exactly (two rays from one camera, no roll). `frameHeight` is the
 * size's frame height at the subject; null keeps the camera `shoulderDist`
 * from the shoulder. The distance is clamped so the camera stays behind the
 * shoulder and both points fit — then the size gives way. `frame` (people)
 * puts the eyes as near the upper third as the size allows: the head-top
 * (`top` m above the eyes) no higher than the `fill` line, the visible region's
 * bottom (`bottom` m below the eyes) inside the frame; null centres the eyes.
 */
function placeOts(
  eyes: V3,
  shoulder: V3,
  nearSide: 1 | -1,
  shoulderY: number,
  frame: { fill: number; top: number; bottom: number } | null,
  frameHeight: number | null,
  shoulderDist: number,
  tanV: number,
  tanH: number
): OtsPose {
  const ray = (x: number, y: number): V3 => {
    const l = Math.hypot(x * tanH, y * tanV, 1)
    return { x: (x * tanH) / l, y: (y * tanV) / l, z: -1 / l }
  }
  const v = { x: shoulder.x - eyes.x, y: shoulder.y - eyes.y, z: shoulder.z - eyes.z }
  const len2 = v.x * v.x + v.y * v.y + v.z * v.z
  const rS = ray(nearSide * OTS_SHOULDER_X, shoulderY)
  let rE = rS
  let D = 0
  let dS = 0
  let ey = 0
  for (let i = 0; i < 4; i++) {
    rE = ray(-nearSide * OTS_EYES_X, ey)
    const c = rE.x * rS.x + rE.y * rS.y + rE.z * rS.z
    const sin2 = Math.max(0, 1 - c * c)
    // Camera-to-eyes distance for a camera-to-shoulder distance (law of cosines, far root).
    const forShoulder = (ds: number): number => ds * c + Math.sqrt(Math.max(0, len2 - ds * ds * sin2))
    const near = forShoulder(OTS_MIN_SHOULDER_DIST)
    const far = sin2 > 1e-12 ? 0.999 * Math.sqrt(len2 / sin2) : Infinity
    D = frameHeight === null ? forShoulder(shoulderDist) : Math.max(near, Math.min(far, frameHeight / (2 * tanV * -rE.z)))
    dS = D * c - Math.sqrt(Math.max(0, len2 - D * D * sin2))
    if (frame) {
      const half = D * -rE.z * tanV
      ey = Math.min(frame.fill - frame.top / half, Math.max(1 / 3, -1 + frame.bottom / half))
    }
  }
  const w = { x: dS * rS.x - D * rE.x, y: dS * rS.y - D * rE.y, z: dS * rS.z - D * rE.z }
  const { pan, tilt } = orient(w, v)
  const back = toWorldDir(rE, pan, tilt)
  return {
    position: { x: eyes.x - back.x * D, y: eyes.y - back.y * D, z: eyes.z - back.z * D },
    pan,
    tilt,
    eyesRay: rE,
    frameHeight: 2 * D * -rE.z * tanV
  }
}

export function solveShot(spec: ShotSpec, subjects: ShotSubject[], setup: ShotSetup, lineSide: 1 | -1 = 1): SolvedShot {
  if (spec.subjectIds.length === 0) throw new Error('A shot needs at least one subject')
  const byId = new Map<string, Body>()
  for (const id of spec.subjectIds) {
    const s = subjects.find((x) => x.id === id)
    if (!s) throw new Error(`Shot subject not found: ${id}`)
    byId.set(id, bodyOf(s))
  }
  const bodies = spec.subjectIds.map((id) => byId.get(id)!)
  const first = bodies[0]!
  const roll = ((spec.dutchDeg ?? 0) * Math.PI) / 180

  if (spec.over) {
    if (spec.subjectIds.includes(spec.over.entityId)) throw new Error('The over-the-shoulder entity cannot be the subject')
    const overSubject = subjects.find((x) => x.id === spec.over!.entityId)
    if (!overSubject) throw new Error(`Over-the-shoulder entity not found: ${spec.over.entityId}`)
    const over = bodyOf(overSubject)
    const shoulder = spec.over.shoulder === 'right' ? over.shoulders.right : over.shoulders.left
    const away =
      norm({ x: over.ref.x - first.ref.x, z: over.ref.z - first.ref.z }) ??
      { x: Math.sin(overSubject.heading), z: Math.cos(overSubject.heading) }
    const perp = { x: -away.z, z: away.x }
    const centre = { x: overSubject.position.x, z: overSubject.position.z }
    let out = (shoulder.x - centre.x) * perp.x + (shoulder.z - centre.z) * perp.z
    if (Math.abs(out) < 1e-6) {
      const right = { x: Math.cos(overSubject.heading), z: -Math.sin(overSubject.heading) }
      out = (right.x * perp.x + right.z * perp.z) * (spec.over.shoulder === 'right' ? 1 : -1)
    }
    // A's side of the frame (+1 = right): the camera sits outside the named shoulder.
    const nearSide = out >= 0 ? 1 : -1
    const size = SHOT_SIZES[spec.size]
    const wanted = (first.height * size.visibleFraction) / size.fillFraction
    const eyes = first.ref
    // Camera height to aim for: A's eye line (A's point of view); above A's head for high (and
    // overhead, which an OTS can't be), A's chest for low, near the floor for ground.
    const eyeLine = over.isPerson ? over.ref.y : shoulder.y + 0.12
    const angle = spec.angle ?? 'eye'
    const camHeight =
      angle === 'high' || angle === 'overhead'
        ? eyeLine + 0.6
        : angle === 'low'
          ? shoulder.y - 0.5
          : angle === 'ground'
            ? over.groundY + 0.15
            : eyeLine
    const frame = first.isPerson
      ? {
          fill: size.fillFraction,
          top: first.groundY + first.height - eyes.y,
          bottom: eyes.y - (first.groundY + first.height * (1 - size.visibleFraction))
        }
      : null
    const placeAt = (f: number, frameHeight: number | null, shoulderDist = OTS_SHOULDER_DIST): OtsPose => {
      const tanV = Math.tan(verticalFov(setup.sensorId, f, setup.aspect) / 2)
      const tanH = tanV * ASPECT_RATIOS[setup.aspect]
      const at = (shoulderY: number): OtsPose => placeOts(eyes, shoulder, nearSide, shoulderY, frame, frameHeight, shoulderDist, tanV, tanH)
      // The lower the shoulder sits in frame, the higher the camera: bisect for the target height.
      let lo = OTS_SHOULDER_Y.min
      let hi = OTS_SHOULDER_Y.max
      const highest = at(lo)
      if (highest.position.y <= camHeight) return highest
      const lowest = at(hi)
      if (lowest.position.y >= camHeight) return lowest
      let pose = highest
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        pose = at(mid)
        if (pose.position.y > camHeight) lo = mid
        else hi = mid
      }
      return pose
    }
    // A high or low camera close behind A would drop the shoulder out of frame: back off (from `lo`, the
    // frame height or the shoulder distance) until the angle's height is reached, or as far as allowed.
    const reaches = (p: OtsPose): boolean => Math.abs(p.position.y - camHeight) < 0.02
    const backOff = (lo: number, place: (v: number) => OtsPose): { pose: OtsPose; at: number } => {
      const near = place(lo)
      if (angle === 'eye' || reaches(near)) return { pose: near, at: lo }
      let hi = lo * OTS_MAX_BACKOFF
      let pose = place(hi)
      if (!reaches(pose)) return { pose, at: hi }
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2
        const p = place(mid)
        if (reaches(p)) {
          hi = mid
          pose = p
        }
        else lo = mid
      }
      return { pose, at: hi }
    }
    let focalLength = spec.lens ?? 35
    let ots: OtsPose
    let frameAt = wanted
    if (spec.lens === undefined) {
      // No lens: the camera stays OTS_SHOULDER_DIST from the shoulder (farther for an angle) and the lens frames the size from there.
      for (let i = 0; i < 8; i++) {
        const f = focalLength
        focalLength = Math.min(135, Math.max(12, (f * backOff(OTS_SHOULDER_DIST, (d) => placeAt(f, null, d)).pose.frameHeight) / wanted))
      }
      ots = backOff(OTS_SHOULDER_DIST, (d) => placeAt(focalLength, null, d)).pose
    }
    else {
      // With a lens an angle can loosen the frame (achievedSize says what that gave).
      const backed = backOff(wanted, (h) => placeAt(focalLength, h))
      ots = backed.pose
      frameAt = backed.at
    }
    const offAxis = (p: OtsPose): number => {
      const cam = norm({ x: p.position.x - eyes.x, z: p.position.z - eyes.z })
      return cam ? Math.acos(Math.min(1, Math.max(-1, cam.x * away.x + cam.z * away.z))) : 0
    }
    if (spec.lens !== undefined && offAxis(ots) > OTS_MAX_OFF_AXIS) {
      // Keep the camera behind A: tighten the frame until it is (achievedSize says what that gave).
      let lo = 0
      let hi = frameAt
      ots = placeAt(focalLength, 0)
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        const p = placeAt(focalLength, mid)
        if (offAxis(p) > OTS_MAX_OFF_AXIS) hi = mid
        else {
          lo = mid
          ots = p
        }
      }
    }
    const position = ots.position
    let aim = { pan: ots.pan, tilt: ots.tilt }
    // On a fight line with a side: never let a swinging shoulder carry the camera across it.
    const ends = spec.lineIds?.map((id) => subjects.find((x) => x.id === id)?.position)
    if (spec.lineSide && ends?.[0] && ends[1]) {
      const axis = norm({ x: ends[1].x - ends[0].x, z: ends[1].z - ends[0].z })
      if (axis) {
        const n = { x: -axis.z * spec.lineSide, z: axis.x * spec.lineSide }
        const d = (position.x - ends[0].x) * n.x + (position.z - ends[0].z) * n.z
        if (d < LINE_CLEARANCE) {
          position.x += n.x * (LINE_CLEARANCE - d)
          position.z += n.z * (LINE_CLEARANCE - d)
          // Re-aim so the eyes keep their place in frame.
          const to = { x: eyes.x - position.x, y: eyes.y - position.y, z: eyes.z - position.z }
          const l = Math.max(Math.hypot(to.x, to.y, to.z), 1e-9)
          aim = orient(ots.eyesRay, { x: to.x / l, y: to.y / l, z: to.z / l })
        }
      }
    }
    const d = Math.hypot(eyes.x - position.x, eyes.y - position.y, eyes.z - position.z)
    const tanV = Math.tan(verticalFov(setup.sensorId, focalLength, setup.aspect) / 2)
    const achievedSize = nearestSize((2 * d * -ots.eyesRay.z * tanV) / Math.max(first.height, 1e-3))
    return { position, pan: aim.pan, tilt: aim.tilt, roll, focalLength, achievedSize }
  }

  const lens = spec.lens ?? setup.focalLength
  const angle = spec.angle ?? 'eye'
  const dir = sideDirection(spec, first, byId, subjects, lineSide)

  // Vertical requirement from the tallest subject.
  let tallest = first
  for (const b of bodies) if (b.height > tallest.height) tallest = b
  const framing = frameSubject(spec.size, tallest.height, setup.sensorId, lens, setup.aspect)
  const aimHeight = aimY(tallest, framing)
  let distance = framing.distance
  let aim: V3 = { x: first.ref.x, y: aimHeight, z: first.ref.z }

  const vfov = verticalFov(setup.sensorId, lens, setup.aspect)
  const tanV = Math.tan(vfov / 2)
  const tanH = tanV * ASPECT_RATIOS[setup.aspect]

  if (bodies.length > 1) {
    // Horizontal requirement: the group's spread across the view fills 85% of the width.
    const right = { x: dir.z, z: -dir.x } // camera right when looking along −dir
    const pts = bodies.flatMap((b) => b.points)
    const across = pts.map((p) => p.x * right.x + p.z * right.z)
    const lo = Math.min(...across)
    const hi = Math.max(...across)
    const cx = bodies.reduce((s, b) => s + b.ref.x, 0) / bodies.length
    const cz = bodies.reduce((s, b) => s + b.ref.z, 0) / bodies.length
    const shift = (lo + hi) / 2 - (cx * right.x + cz * right.z)
    aim = { x: cx + right.x * shift, y: aimHeight, z: cz + right.z * shift }
    distance = Math.max(distance, (hi - lo + GROUP_MARGIN) / (2 * tanH) / GROUP_FILL)
  }

  const place = (d: number): { position: V3; pan: number; tilt: number } => {
    if (angle === 'overhead') {
      return { position: { x: aim.x, y: aim.y + d, z: aim.z }, pan: first.subject.heading, tilt: -Math.PI / 2 }
    }
    const position = { x: aim.x + dir.x * d, y: cameraY(angle, aim.y, first.groundY), z: aim.z + dir.z * d }
    if (angle === 'eye') return { position, pan: headingOf({ x: -dir.x, y: 0, z: -dir.z }), tilt: 0 }
    return { position, ...aimAt(position, aim) }
  }

  let pose = place(distance)
  if (bodies.length > 1 && angle !== 'overhead') {
    // Depth differences can push a near subject out of frame — back off until all fit.
    const fits = (p: { position: V3; pan: number; tilt: number }): boolean =>
      bodies.every((b) =>
        b.points.every((pt) => {
          const q = ndc(pt, p.position, p.pan, p.tilt, tanV, tanH)
          return q.depth > 0.1 && Math.abs(q.x) <= 0.9 && Math.abs(q.y) <= 0.93
        })
      )
    for (let i = 0; i < 60 && !fits(pose); i++) {
      distance *= 1.05
      pose = place(distance)
    }
  }
  return { position: pose.position, pan: pose.pan, tilt: pose.tilt, roll, focalLength: lens }
}

/** What a shot can frame, in pick order: people, then vehicles and animals, then the rest — never set kits. */
const FRAMING_ORDER: EntityCategory[] = ['people', 'vehicles', 'animals']

export function framingCandidates<T extends { assetId: string }>(entities: T[]): T[] {
  const rank = (e: T): number => {
    const i = FRAMING_ORDER.indexOf(assetSpec(e.assetId).category)
    return i < 0 ? FRAMING_ORDER.length : i
  }
  return entities
    .filter((e) => assetSpec(e.assetId).category !== 'environment')
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map((x) => x.e)
}
