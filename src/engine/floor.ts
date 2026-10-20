/**
 * Floor contact for the person rig (fork addition; see MODIFICATIONS.md).
 *
 * `bodyShape` is a proxy of a person's surface: balls and points on the FK
 * bones of `poseFrames` (skeleton.ts). The classic people are capsules and
 * boxes (renderer `buildPerson`), so their proxy is exact up to tessellation;
 * the studio mannequins' points are rings sampled from their section tables
 * (renderer `mannequin-mesh.ts`); a mocap bot's are the support points
 * fitted from its skinned mesh (`mocap/rig.ts`). `lowestY` is the lowest surface point of a
 * posed body, entity-local (root at the origin): the stand gait plus joint
 * offsets, with an optional root pitch for the lying gaits.
 * `tests/unit/floor.test.ts` checks it against the rendered meshes.
 *
 * `motionRootY` is the floor rule for a motion keyframe's root height.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { isMocapAsset, mocapStandIn, mocapVersion } from './mocap/registry'
import { personDims, poseFrames, type Bone, type PersonDims, type ProxyBone } from './skeleton'

/** A ball (r > 0) or a surface point (r = 0) in a bone's frame. */
interface Ball {
  bone: ProxyBone
  x: number
  y: number
  z: number
  r: number
}

export interface BodyShape {
  dims: PersonDims
  balls: Ball[]
}

/** A performer's body, as the document stores it. */
export interface Body {
  assetId: string
  params?: Record<string, number | string>
  scale?: number
}

const RING = 8

function numParam(params: Record<string, number | string> | undefined, key: string, def: number): number {
  const v = params?.[key]
  return typeof v === 'number' ? v : def
}

/** Superellipse ring point (the sculpt's loft profile, exponent n): [along a, along b]. */
function rim(t: number, n: number): [number, number] {
  const c = Math.cos(t)
  const s = Math.sin(t)
  const e = 2 / n
  return [Math.sign(c) * Math.abs(c) ** e, Math.sign(s) * Math.abs(s) ** e]
}

/** Ring angles of the sculpt's front bulges (pecs, bust) and back bulges (lats; glutes), as mannequin-mesh.ts. */
const BUMP_AT = [(246 * Math.PI) / 180, (294 * Math.PI) / 180]
const BACK_AT = [(55 * Math.PI) / 180, (125 * Math.PI) / 180]
const GLUTES_AT = [(70 * Math.PI) / 180, (110 * Math.PI) / 180]

/** A section's bulges: `bump` forward (−z) at BUMP_AT with lobe exponent `sharp`, `back` backward (+z) at `backAt`. */
interface Bulge {
  bump: number
  back: number
  sharp: number
  backAt: number[]
}

/**
 * Points around a section: half-width a (x), half-depth b (z, +z = back),
 * centre (cx, cz). With bulges (mannequin-mesh.ts `ringPoint`) the ring also
 * samples the bulge peaks, where a lying body rests.
 */
function ring(out: Ball[], bone: Bone, y: number, a: number, b: number, cz = 0, cx = 0, n = 2, bulge?: Bulge): void {
  const at = Array.from({ length: RING }, (_, k) => (k / RING) * Math.PI * 2)
  if (bulge?.bump) at.push(...BUMP_AT)
  if (bulge?.back) at.push(...bulge.backAt)
  const lobe = (t: number, peaks: number[], k: number): number => peaks.reduce((acc, p) => acc + Math.max(0, Math.cos(t - p)) ** k, 0)
  for (const t of at) {
    const [u, v] = rim(t, n)
    const front = bulge?.bump ? bulge.bump * lobe(t, BUMP_AT, bulge.sharp) : 0
    const rear = bulge?.back ? bulge.back * lobe(t, bulge.backAt, 4) : 0
    out.push({ bone, x: cx + a * u, y, z: cz + b * v - front + rear, r: 0 })
  }
}

function boxCorners(out: Ball[], bone: Bone, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push({ bone, x: cx + sx * hx, y: cy + sy * hy, z: cz + sz * hz, r: 0 })
}

const SIDES = [
  { s: -1, shoulder: 'shoulderL', elbow: 'elbowL', hip: 'hipL', knee: 'kneeL' },
  { s: 1, shoulder: 'shoulderR', elbow: 'elbowR', hip: 'hipR', knee: 'kneeR' }
] as const

/** Classic grey-box person: the capsules and boxes of `buildPerson`. */
function classicShape(d: PersonDims, w: number): Ball[] {
  const { s } = d
  const out: Ball[] = []
  boxCorners(out, 'pelvis', 0, 0.02 * s, 0, d.bodyW / 2, 0.09 * s, 0.1 * s)
  const tr = d.bodyW * 0.5
  out.push({ bone: 'torso', x: 0, y: 0.15 * d.torsoLen, z: 0, r: tr }, { bone: 'torso', x: 0, y: 0.85 * d.torsoLen, z: 0, r: tr })
  out.push({ bone: 'head', x: 0, y: d.headR + 0.06 * s, z: 0, r: d.headR })
  const armR = 0.055 * s * w
  const legR = 0.075 * s * w
  for (const side of SIDES) {
    out.push({ bone: side.shoulder, x: 0, y: -0.15 * d.upperArmLen, z: 0, r: armR })
    out.push({ bone: side.shoulder, x: 0, y: -0.85 * d.upperArmLen, z: 0, r: armR })
    out.push({ bone: side.elbow, x: 0, y: -0.15 * d.lowerArmLen, z: 0, r: armR * 0.9 })
    out.push({ bone: side.elbow, x: 0, y: -0.85 * d.lowerArmLen, z: 0, r: armR * 0.9 })
    out.push({ bone: side.hip, x: 0, y: -0.15 * d.upperLegLen, z: 0, r: legR })
    out.push({ bone: side.hip, x: 0, y: -0.85 * d.upperLegLen, z: 0, r: legR })
    // The shin capsule's ankle end sits inside the foot box (it pokes 4 mm
    // under the sole at rest), so the box stands for it.
    out.push({ bone: side.knee, x: 0, y: -0.15 * d.lowerLegLen, z: 0, r: legR * 0.85 })
    boxCorners(out, side.knee, 0, -d.lowerLegLen + 0.03 * s, -0.05 * s, legR, 0.03 * s, 0.11 * s)
  }
  return out
}

/* Mannequin sections ([y, a, b, cz]), a subset of mannequin-mesh.ts. */
type Sec = [number, number, number, number?]
/* The sculpt's pelvis and torso tables in full ([y, a, b, cz, cx, bump, back], mannequin-mesh.ts). */
type Sculpt = [number, number, number, number?, number?, number?, number?]
const PELVIS_M: Sculpt[] = [[-0.086, 0.03, 0.03, 0.006], [-0.08, 0.075, 0.062, 0.006], [-0.068, 0.118, 0.084, 0.006], [-0.05, 0.14, 0.094, 0.008, 0, 0, 0.01], [-0.03, 0.152, 0.1, 0.01, 0, 0, 0.016], [0.02, 0.16, 0.104, 0.008, 0, 0, 0.012], [0.07, 0.148, 0.098, 0.004], [0.116, 0.134, 0.09, 0.003]]
const PELVIS_F: Sculpt[] = [[-0.086, 0.03, 0.03, 0.012], [-0.08, 0.085, 0.066, 0.014], [-0.068, 0.135, 0.09, 0.016], [-0.05, 0.163, 0.102, 0.018, 0, 0, 0.016], [-0.03, 0.18, 0.11, 0.018, 0, 0, 0.024], [0.02, 0.182, 0.106, 0.012, 0, 0, 0.016], [0.07, 0.152, 0.094, 0.006], [0.116, 0.123, 0.084, 0.004]]
const TORSO_M: Sculpt[] = [
  [0.06, 0.134, 0.09, 0.004], [0.12, 0.13, 0.092, 0.002], [0.22, 0.128, 0.094, -0.002], [0.34, 0.136, 0.098, -0.006], [0.46, 0.152, 0.104, -0.01, 0, 0, 0.008],
  [0.56, 0.166, 0.11, -0.012, 0, 0.004, 0.014], [0.63, 0.173, 0.112, -0.012, 0, 0.016, 0.018], [0.71, 0.178, 0.112, -0.01, 0, 0.021, 0.018], [0.79, 0.18, 0.108, -0.006, 0, 0.016, 0.016],
  [0.86, 0.178, 0.1, -0.002, 0, 0.006, 0.012], [0.92, 0.175, 0.092, 0.003, 0, 0, 0.008], [0.95, 0.168, 0.087, 0.006], [0.98, 0.15, 0.081, 0.008], [1.02, 0.124, 0.074, 0.011], [1.06, 0.098, 0.066, 0.014], [1.1, 0.074, 0.058, 0.016]
]
const TORSO_F: Sculpt[] = [
  [0.06, 0.12, 0.081, 0.004], [0.12, 0.114, 0.08, 0.002], [0.24, 0.106, 0.078], [0.36, 0.113, 0.082, -0.002], [0.45, 0.125, 0.087, -0.004, 0, 0.004], [0.5, 0.131, 0.089, -0.005, 0, 0.022],
  [0.56, 0.136, 0.091, -0.006, 0, 0.05], [0.62, 0.141, 0.092, -0.006, 0, 0.056], [0.68, 0.145, 0.091, -0.005, 0, 0.038], [0.74, 0.149, 0.089, -0.004, 0, 0.012, 0.004], [0.8, 0.152, 0.086, -0.002, 0, 0.003, 0.006],
  [0.87, 0.151, 0.082, 0, 0, 0, 0.006], [0.93, 0.146, 0.076, 0.004], [0.96, 0.136, 0.072, 0.006], [0.99, 0.12, 0.067, 0.008], [1.03, 0.098, 0.06, 0.01], [1.07, 0.074, 0.052, 0.012], [1.1, 0.058, 0.047, 0.012]
]
// Deltoid cap (shoulder group), y in s, [y, a, b, cz, cx outward].
const DELTOID: Sculpt[] = [[0.04, 0.016, 0.018], [0.036, 0.04, 0.044, 0, 0.004], [0.024, 0.06, 0.064, 0, 0.008], [0.004, 0.074, 0.078, 0, 0.012], [-0.03, 0.076, 0.08, -0.002, 0.014], [-0.07, 0.068, 0.072, -0.003, 0.01], [-0.11, 0.054, 0.06, -0.004, 0.004], [-0.14, 0.042, 0.048, -0.004]]
// Head: y about the head centre, all in head radii.
const HEAD: Sec[] = [[-0.99, 0.16, 0.12, -0.5], [-0.92, 0.34, 0.3, -0.4], [-0.75, 0.5, 0.55, -0.2], [-0.52, 0.6, 0.72, -0.07], [-0.22, 0.65, 0.81, 0], [0.12, 0.68, 0.85, 0.02], [0.44, 0.65, 0.83, 0.04], [0.72, 0.52, 0.67, 0.05], [0.91, 0.31, 0.41, 0.05], [1, 0.08, 0.1, 0.05]]
const UPPER_ARM: Sec[] = [[0, 0.056, 0.058], [-0.18, 0.06, 0.064, -0.004], [-0.42, 0.058, 0.066, -0.01], [-0.68, 0.05, 0.054, -0.006], [-0.985, 0.037, 0.039]]
const FOREARM: Sec[] = [[-0.08, 0.048, 0.05], [-0.22, 0.05, 0.047], [-0.45, 0.039, 0.036], [-0.745, 0.024, 0.029]]
const THIGH_M: Sec[] = [[-0.1, 0.104, 0.104, -0.01], [-0.35, 0.096, 0.096, -0.014], [-0.62, 0.078, 0.078, -0.008], [-0.85, 0.062, 0.062], [-0.99, 0.054, 0.054]]
const THIGH_F: Sec[] = [[-0.1, 0.11, 0.1, -0.006], [-0.35, 0.09, 0.09, -0.008], [-0.62, 0.072, 0.072, -0.005], [-0.85, 0.056, 0.056], [-0.99, 0.05, 0.05]]
const SHIN: Sec[] = [[-0.1, 0.051, 0.058, 0.01], [-0.25, 0.058, 0.072, 0.024], [-0.45, 0.048, 0.058, 0.016], [-0.68, 0.036, 0.04, 0.006], [-0.8, 0.031, 0.034, 0.003]]
// Foot: [forward of the ankle, half-width, half-height, centre height], in s.
const FOOT: Sec[] = [[-0.07, 0.02, 0.022, 0.032], [-0.058, 0.032, 0.036, 0.038], [-0.025, 0.036, 0.05, 0.05], [0.03, 0.041, 0.042, 0.042], [0.085, 0.047, 0.028, 0.028], [0.125, 0.046, 0.02, 0.02], [0.16, 0.038, 0.016, 0.016], [0.178, 0.02, 0.009, 0.01]]

/** Studio mannequin: rings from the sculpt's section tables (mannequin-mesh.ts `dressMannequin`). */
function mannequinShape(d: PersonDims, female: boolean, build: number): Ball[] {
  const { s, headR } = d
  const W = s * build
  const out: Ball[] = []
  for (const [y, a, b, cz = 0, , bump = 0, back = 0] of female ? PELVIS_F : PELVIS_M)
    ring(out, 'pelvis', y * s, a * W, b * W, cz * W, 0, 2.4, { bump: bump * W, back: back * W, sharp: 12, backAt: GLUTES_AT })
  for (const [y, a, b, cz = 0, , bump = 0, back = 0] of female ? TORSO_F : TORSO_M)
    ring(out, 'torso', y * d.torsoLen, a * W, b * W, cz * W, 0, 2.3, { bump: bump * W, back: back * W, sharp: female ? 14 : 8, backAt: BACK_AT })
  const hc = headR + 0.06 * s
  for (const [y, a, b, cz = 0] of HEAD) ring(out, 'head', hc + y * headR, a * headR, b * headR, cz * headR, 0, 2.15)
  out.push({ bone: 'head', x: 0, y: hc - 0.25 * headR, z: -0.95 * headR, r: 0 }) // nose tip
  const lw = W * (female ? 0.86 : 1)
  const kw = W * (female ? 0.9 : 1)
  const hw = W * (female ? 0.9 : 1)
  const hl = s * (female ? 0.93 : 1)
  for (const side of SIDES) {
    const medial = -side.s
    const dw = lw * (female ? 0.94 : 1)
    for (const [y, a, b, cz = 0, cx = 0] of DELTOID) ring(out, side.shoulder, y * s, a * dw, b * dw, cz * dw, cx * dw * side.s)
    for (const [y, a, b, cz = 0] of UPPER_ARM) ring(out, side.shoulder, y * d.upperArmLen, a * lw, b * lw, cz * lw)
    for (const [y, a, b, cz = 0] of FOREARM) ring(out, side.elbow, y * d.lowerArmLen, a * lw, b * lw, cz * lw)
    const yw = -0.75 * d.lowerArmLen
    ring(out, side.elbow, yw - 0.055 * hl, 0.021 * hw, 0.043 * hw)
    ring(out, side.elbow, yw - 0.1 * hl, 0.014 * hw, 0.036 * hw)
    // Curled fingers: the knuckle bend and the tip, toward the midline.
    out.push({ bone: side.elbow, x: medial * 0.031 * hl, y: yw - 0.126 * hl, z: 0, r: 0.014 * hw })
    out.push({ bone: side.elbow, x: medial * 0.079 * hl, y: yw - 0.122 * hl, z: 0, r: 0.008 * hw })
    out.push({ bone: side.elbow, x: medial * 0.02 * hw, y: yw - 0.085 * hl, z: -0.068 * hw, r: 0.01 * hw }) // thumb tip
    ring(out, side.hip, 0.02 * s, 0.095 * W, 0.098 * W)
    for (const [y, a, b, cz = 0] of female ? THIGH_F : THIGH_M) ring(out, side.hip, y * d.upperLegLen, a * W, b * W, cz * W)
    out.push({ bone: side.knee, x: 0, y: 0, z: 0, r: 0.042 * kw })
    // Kneecap: an ellipsoid (0.04, 0.05, 0.024) kw in front of the joint.
    for (const lat of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const cl = Math.cos(lat * Math.PI)
      ring(out, side.knee, 0.008 * s + Math.sin(lat * Math.PI) * 0.05 * kw, 0.04 * kw * cl, 0.024 * kw * cl, -0.04 * kw)
    }
    ring(out, side.knee, -0.008 * s, 0.05 * kw, 0.05 * kw)
    for (const [y, a, b, cz = 0] of SHIN) ring(out, side.knee, y * d.lowerLegLen, a * kw, b * kw, cz * kw)
    ring(out, side.knee, -d.lowerLegLen + 0.085 * s, 0.03 * kw, 0.032 * kw)
    for (const [f, a, b, cz = 0] of FOOT) {
      for (let k = 0; k < RING; k++) {
        const [u, v] = rim((k / RING) * Math.PI * 2, 2.6)
        out.push({ bone: side.knee, x: a * kw * u, y: -d.lowerLegLen + (cz + b * v) * s, z: -f * s, r: 0 })
      }
    }
  }
  return out
}

/** The surface proxy of a person asset (height / build params as `personDims`). */
export function bodyShape(assetId: string, params?: Record<string, number | string>): BodyShape {
  const dims = personDims(assetId, params)
  // Fork: a mocap bot's support points (mocap/rig.ts), scaled by its height.
  if (dims.mocap) {
    const k = dims.mocap.k
    return { dims, balls: dims.mocap.rig.points.map((q) => ({ bone: q.frame, x: q.p.x * k, y: q.p.y * k, z: q.p.z * k, r: 0 })) }
  }
  const id = mocapStandIn(assetId)
  const build = Math.min(1.3, Math.max(0.8, numParam(params, 'build', 1)))
  const mannequin = id === 'person.mannequinMale' || id === 'person.mannequinFemale'
  return { dims, balls: mannequin ? mannequinShape(dims, id === 'person.mannequinFemale', build) : classicShape(dims, build) }
}

/**
 * Lowest surface point of a posed body, entity-local (root at the origin,
 * unscaled): the stand gait plus `joints` (motions.ts conventions), tipped
 * by `rootPitch` (the root's rotation.x, as the lying gaits use).
 */
export function lowestY(shape: BodyShape, joints: Record<string, number> | undefined, rootPitch = 0): number {
  const frames = poseFrames(shape.dims, joints)
  const c = Math.cos(rootPitch)
  const s = Math.sin(rootPitch)
  let low = Infinity
  for (const b of shape.balls) {
    // framePoint's y and z, inline (the hot loop of every grounding).
    const { p, r } = frames[b.bone]!
    const py = p.y + r[3] * b.x + r[4] * b.y + r[5] * b.z
    const pz = p.z + r[6] * b.x + r[7] * b.y + r[8] * b.z
    const y = py * c - pz * s - b.r
    if (y < low) low = y
  }
  return low
}

const SHAPES = new Map<string, BodyShape>()

/** Lowest surface point of a performer's posed body, in meters above its root (scaled). */
export function bodyLowY(body: Body | undefined, joints: Record<string, number> | undefined): number {
  const assetId = body?.assetId.startsWith('person.') ? body.assetId : 'person.man'
  const key = `${assetId}|${numParam(body?.params, 'height', 1)}|${numParam(body?.params, 'build', 1)}${isMocapAsset(assetId) ? `|${mocapVersion()}` : ''}`
  let shape = SHAPES.get(key)
  if (!shape) {
    shape = bodyShape(assetId, body?.params)
    SHAPES.set(key, shape)
  }
  return lowestY(shape, joints) * (body?.scale ?? 1)
}

/**
 * Root height of a motion keyframe on a floor at `baseY` (fork floor rule).
 * A keyframe that doesn't lift the body (`up <= 0`) rests the body's lowest
 * point (`low`, from `bodyLowY`) on the floor: the library's drops were
 * authored for other proportions (their depth is a direction, not a
 * distance), and many crouches, lunges and falls fold the legs with no drop
 * at all. A lifted keyframe keeps its authored height unless a body part
 * would go below the floor. Rounded to the micrometre.
 */
export function motionRootY(baseY: number, up: number, low: number): number {
  const y = up > 0 ? Math.max(baseY + up, baseY - low) : baseY - low
  return Math.round(y * 1e6) / 1e6 + 0 // + 0: no −0
}

/**
 * Root height on a posed move between two keyframes (fork): the body's
 * lowest point travels in a straight line from keyframe to keyframe, so a
 * body folding down onto the floor never dips through it (as the root's own
 * straight line would let it), and one turning over on the floor (a
 * push-up, a cartwheel, a fall) never hovers above it. `u` is the eased leg
 * progress the joints are blended with.
 */
export function posedMoveY(
  body: Body,
  from: { y: number; joints: Record<string, number> },
  to: { y: number; joints: Record<string, number> },
  joints: Record<string, number> | undefined,
  u: number
): number {
  const a = from.y + bodyLowY(body, from.joints)
  const b = to.y + bodyLowY(body, to.joints)
  return a + (b - a) * u - bodyLowY(body, joints)
}
