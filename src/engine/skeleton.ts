/**
 * Forward kinematics for the procedural person rig (fork addition; see
 * MODIFICATIONS.md).
 *
 * `personDims` is the single source of the mannequin's proportions — the
 * renderer's `buildPerson` builds its bones from it, so engine-side FK and the
 * rendered body can't drift. `poseEffectors` reproduces the renderer's bone
 * hierarchy and joint-override mapping (`animatePerson`, stand gait, no
 * breathing bob) to give exact hand / foot / head positions in the entity's
 * local frame: origin at the ground, facing −Z, +X = the person's right.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { assetSpec } from './assets'
import type { V3 } from './types'

export interface PersonDims {
  H: number
  s: number
  legLen: number
  headR: number
  torsoLen: number
  bodyW: number
  /** Shoulder / hip joint offsets from the midline (classic: bodyW × 0.55 / × 0.28). */
  shoulderX: number
  hipX: number
  shoulderY: number
  upperArmLen: number
  lowerArmLen: number
  upperLegLen: number
  lowerLegLen: number
  /** Rest torso pitch (rotation.x); negative stoops forward. */
  baseLean: number
}

export type Effector =
  | 'handL'
  | 'handR'
  | 'elbowL'
  | 'elbowR'
  | 'footL'
  | 'footR'
  | 'kneeL'
  | 'kneeR'
  | 'head'
  | 'chest'
  | 'pelvis'
  | 'shoulderL'
  | 'shoulderR'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function numParam(params: Record<string, number | string> | undefined, key: string, def: number): number {
  const v = params?.[key]
  return typeof v === 'number' ? v : def
}

/**
 * Studio mannequins (fork): body width and shoulder / hip joint offsets at
 * s = 1, build 1. Their lengths are anatomical fractions of H, and the torso
 * absorbs the rig's fixed torso (0.08 s) and head (0.06 s) offsets so the head
 * top lands at H (the classic formulas put it 0.14 s above).
 */
const MANNEQUIN_WIDTHS: Record<string, { bodyW: number; shoulderX: number; hipX: number }> = {
  'person.mannequinMale': { bodyW: 0.36, shoulderX: 0.2, hipX: 0.09 },
  'person.mannequinFemale': { bodyW: 0.31, shoulderX: 0.165, hipX: 0.1 }
}

/** Mannequin proportions for a person asset (height ×0.8..1.2, build ×0.8..1.3). */
export function personDims(assetId: string, params?: Record<string, number | string>): PersonDims {
  const spec = assetSpec(assetId)
  const hMul = clamp(numParam(params, 'height', 1), 0.8, 1.2)
  const buildMul = clamp(numParam(params, 'build', 1), 0.8, 1.3)
  const H = spec.height * hMul
  const s = H / 1.78 // normalize proportions to a 1.78m reference
  const legLen = H * 0.47
  const headR = H * 0.13 * 0.5
  const torsoLen = H - legLen - headR * 2
  const wide = MANNEQUIN_WIDTHS[assetId]
  if (wide) {
    const mLegLen = H * 0.51
    const mTorsoLen = H - mLegLen - headR * 2 - (0.08 + 0.06) * s
    const upperLegLen = H * 0.235
    return {
      H,
      s,
      legLen: mLegLen,
      headR,
      torsoLen: mTorsoLen,
      bodyW: wide.bodyW * s * buildMul,
      shoulderX: wide.shoulderX * s * buildMul,
      hipX: wide.hipX * s * buildMul,
      shoulderY: mTorsoLen * 0.92,
      upperArmLen: H * 0.185,
      lowerArmLen: H * 0.195,
      upperLegLen,
      lowerLegLen: mLegLen - upperLegLen,
      baseLean: 0
    }
  }
  const bodyW = 0.34 * s * buildMul
  return {
    H,
    s,
    legLen,
    headR,
    torsoLen,
    bodyW,
    shoulderX: bodyW * 0.55,
    hipX: bodyW * 0.28,
    shoulderY: torsoLen * 0.92,
    upperArmLen: torsoLen * 0.5,
    lowerArmLen: torsoLen * 0.48,
    upperLegLen: legLen * 0.52,
    lowerLegLen: legLen * 0.48,
    // Rest torso pitch (rotation.x on a body facing −Z): negative stoops
    // forward. Fork fix: the elderly used to lean back at +0.18.
    baseLean: assetId === 'person.elderly' ? -0.18 : 0
  }
}

/* --------------------------- tiny 3×3 rigid math -------------------------- */

/** Row-major 3×3 rotation. */
export type M3 = [number, number, number, number, number, number, number, number, number]

const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function mul(a: M3, b: M3): M3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8]
  ]
}

/** three.js Euler 'XYZ': R = Rx(x) · Ry(y) · Rz(z). */
function euler(x: number, y: number, z: number): M3 {
  const cx = Math.cos(x)
  const sx = Math.sin(x)
  const cy = Math.cos(y)
  const sy = Math.sin(y)
  const cz = Math.cos(z)
  const sz = Math.sin(z)
  const rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  return mul(mul(rx, ry), rz)
}

function apply(m: M3, v: V3): V3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z
  }
}

/** A bone frame: its origin and rotation, entity-local. */
export interface Frame {
  p: V3
  r: M3
}

/** Child frame: offset in the parent's frame, then the child's own rotation. */
function child(parent: Frame, offset: V3, rot: M3): Frame {
  const o = apply(parent.r, offset)
  return { p: { x: parent.p.x + o.x, y: parent.p.y + o.y, z: parent.p.z + o.z }, r: mul(parent.r, rot) }
}

/** A bone-local point in entity-local coordinates. */
export function framePoint(f: Frame, local: V3): V3 {
  const o = apply(f.r, local)
  return { x: f.p.x + o.x, y: f.p.y + o.y, z: f.p.z + o.z }
}

const point = framePoint

const v = (x: number, y: number, z: number): V3 => ({ x, y, z })

export type Bone = 'pelvis' | 'torso' | 'head' | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR' | 'hipL' | 'hipR' | 'kneeL' | 'kneeR'

/**
 * The rig's bone frames for a pose (fork): the hierarchy and joint mapping
 * of `animatePerson`'s stand gait (the motions.ts conventions on a −Z-facing
 * body): shoulder / hip / torso / head X channels and the left abduction
 * channels are subtracted, the right abduction channels and elbow bends
 * added, knee bends and torso/head Z channels subtracted.
 *
 * Root channels (motion playback): `rootX` pitch (positive tips the body
 * forward, prone), `rootY` yaw (positive counter-clockwise from above),
 * `rootZ` roll (positive to the right) turn the whole body about the pelvis
 * joint (the pelvis frame's Euler XYZ: −rootX, rootY, −rootZ).
 */
export function poseFrames(dims: PersonDims, joints: Record<string, number> | undefined): Record<Bone, Frame> {
  const j = (k: string): number => joints?.[k] ?? 0
  const root: Frame = { p: v(0, 0, 0), r: IDENTITY }
  const pelvis = child(root, v(0, dims.legLen, 0), euler(-j('rootX'), j('rootY'), -j('rootZ')))
  const torso = child(pelvis, v(0, 0.08 * dims.s, 0), euler(dims.baseLean - j('torsoX'), j('torsoY'), -j('torsoZ')))
  const head = child(torso, v(0, dims.torsoLen, 0), euler(-j('headX'), j('headY'), -j('headZ')))
  const shoulderL = child(torso, v(-dims.shoulderX, dims.shoulderY, 0), euler(-j('shoulderLX'), 0, -j('shoulderLZ')))
  const shoulderR = child(torso, v(dims.shoulderX, dims.shoulderY, 0), euler(-j('shoulderRX'), 0, j('shoulderRZ')))
  const elbowL = child(shoulderL, v(0, -dims.upperArmLen, 0), euler(j('elbowL'), 0, 0))
  const elbowR = child(shoulderR, v(0, -dims.upperArmLen, 0), euler(j('elbowR'), 0, 0))
  const hipL = child(pelvis, v(-dims.hipX, 0, 0), euler(-j('hipLX'), 0, -j('hipLZ')))
  const hipR = child(pelvis, v(dims.hipX, 0, 0), euler(-j('hipRX'), 0, j('hipRZ')))
  const kneeL = child(hipL, v(0, -dims.upperLegLen, 0), euler(-j('kneeL'), 0, 0))
  const kneeR = child(hipR, v(0, -dims.upperLegLen, 0), euler(-j('kneeR'), 0, 0))
  return { pelvis, torso, head, shoulderL, shoulderR, elbowL, elbowR, hipL, hipR, kneeL, kneeR }
}

/**
 * Effector positions for a pose, entity-local (ground origin, facing −Z),
 * from `poseFrames`.
 */
export function poseEffectors(dims: PersonDims, joints: Record<string, number> | undefined): Record<Effector, V3> {
  const { pelvis, torso, head, shoulderL, shoulderR, elbowL, elbowR, kneeL, kneeR } = poseFrames(dims, joints)
  const toe = v(0, -dims.lowerLegLen + 0.03 * dims.s, -0.16 * dims.s)
  return {
    handL: point(elbowL, v(0, -dims.lowerArmLen, 0)),
    handR: point(elbowR, v(0, -dims.lowerArmLen, 0)),
    elbowL: elbowL.p,
    elbowR: elbowR.p,
    footL: point(kneeL, toe),
    footR: point(kneeR, toe),
    kneeL: kneeL.p,
    kneeR: kneeR.p,
    head: point(head, v(0, dims.headR + 0.06 * dims.s, 0)),
    chest: point(torso, v(0, 0.55 * dims.torsoLen, 0)),
    pelvis: pelvis.p,
    shoulderL: shoulderL.p,
    shoulderR: shoulderR.p
  }
}

/** Entity-local → world: scale, yaw by heading (object.rotation.y), translate. */
export function toWorld(local: V3, position: V3, heading: number, scale: number): V3 {
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  const x = local.x * scale
  const y = local.y * scale
  const z = local.z * scale
  return { x: position.x + x * c + z * s, y: position.y + y, z: position.z - x * s + z * c }
}
