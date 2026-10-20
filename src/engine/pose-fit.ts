/**
 * Per-body pose fits for motion keyframes (fork addition; see MODIFICATIONS.md).
 *
 * A motion that rests on two supports (push-ups on hands and toes, a crawl
 * on hands and knees, a kneel on the rear knee and the front sole, a body
 * lying flat) can't hold both on the floor with fixed angles: the classic
 * people, the studio mannequins and the elderly stoop differ by 3–10 cm. A
 * keyframe's `fit` turns some channels (by one amount, each times its
 * coefficient) until the lowest points of two contact groups are level, on
 * the performer's own body; the floor rule (floor.ts `motionRootY`) then
 * rests both on the floor.
 *
 * PURE: no DOM / three.js / Electron. Deterministic (fixed sampling and
 * bisection).
 */

import { bodyShape, type Body, type BodyShape } from './floor'
import { framePoint, poseFrames } from './skeleton'

/** Proxy points by body region; the L / R groups are one side's. */
export type ContactGroup = 'hands' | 'feet' | 'knees' | 'torso' | 'kneeL' | 'kneeR' | 'footL' | 'footR'

/**
 * Level the lowest points of `level` by turning the `by` channels (channel →
 * coefficient) one amount; with `gap`, the first group ends that far above the
 * second (meters on the 1.78 m man, scaled with the body).
 */
export interface PoseFit {
  level: [ContactGroup, ContactGroup]
  by: Record<string, number>
  gap?: number
}

type Joints = Record<string, number>

/** Search range (rad) and samples for the turn, bisection steps, and passes over a keyframe's fits (they couple). */
const RANGE = 0.8
const SAMPLES = 32
const STEPS = 40
const PASSES = 3

function numParam(params: Record<string, number | string> | undefined, key: string, def: number): number {
  const v = params?.[key]
  return typeof v === 'number' ? v : def
}

interface Fitted {
  shape: BodyShape
  groups: Record<ContactGroup, number[]>
}

const FITTED = new Map<string, Fitted>()

/** A body's proxy with its points sorted into contact groups (cached per asset, height, build). */
function fittedShape(body: Body | undefined): Fitted {
  const assetId = body?.assetId.startsWith('person.') ? body.assetId : 'person.man'
  const key = `${assetId}|${numParam(body?.params, 'height', 1)}|${numParam(body?.params, 'build', 1)}`
  let f = FITTED.get(key)
  if (f) return f
  const shape = bodyShape(assetId, body?.params)
  const d = shape.dims
  const groups: Record<ContactGroup, number[]> = { hands: [], feet: [], knees: [], torso: [], kneeL: [], kneeR: [], footL: [], footR: [] }
  shape.balls.forEach((b, i) => {
    if ((b.bone === 'elbowL' || b.bone === 'elbowR') && b.y < -0.6 * d.lowerArmLen) groups.hands.push(i)
    if (b.bone === 'torso' || b.bone === 'pelvis') groups.torso.push(i)
    const side = b.bone.endsWith('L') ? 'L' : 'R'
    const foot = (b.bone === 'kneeL' || b.bone === 'kneeR') && b.y < -0.75 * d.lowerLegLen
    const knee =
      ((b.bone === 'kneeL' || b.bone === 'kneeR') && b.y > -0.3 * d.lowerLegLen) ||
      ((b.bone === 'hipL' || b.bone === 'hipR') && b.y < -0.7 * d.upperLegLen)
    if (foot) {
      groups.feet.push(i)
      groups[`foot${side}`].push(i)
    }
    if (knee) {
      groups.knees.push(i)
      groups[`knee${side}`].push(i)
    }
  })
  f = { shape, groups }
  FITTED.set(key, f)
  return f
}

/** Lowest point of each contact group of a posed body (entity-local, unscaled). */
export function groupLows(body: Body | undefined, joints: Joints | undefined): Record<ContactGroup, number> {
  const { shape, groups } = fittedShape(body)
  const frames = poseFrames(shape.dims, joints)
  const ys = shape.balls.map((b) => framePoint(frames[b.bone], b).y - b.r)
  const out = {} as Record<ContactGroup, number>
  for (const g of Object.keys(groups) as ContactGroup[]) out[g] = Math.min(...groups[g].map((i) => ys[i]!))
  return out
}

function turned(joints: Joints, by: Record<string, number>, amount: number): Joints {
  const out = { ...joints }
  for (const [k, c] of Object.entries(by)) out[k] = Math.round(((joints[k] ?? 0) + c * amount) * 1e6) / 1e6 + 0
  return out
}

/**
 * Apply `fits` to a keyframe pose on `body`, in order, over a few passes
 * (one fit's turn moves the others' groups); each turn is the smallest that
 * levels its pair.
 */
export function fitPose(body: Body | undefined, joints: Joints, fits: PoseFit[]): Joints {
  let out = joints
  const s = fittedShape(body).shape.dims.s
  for (let pass = 0; pass < PASSES; pass++) for (const fit of fits) {
    const gap = (amount: number): number => {
      const lows = groupLows(body, turned(out, fit.by, amount))
      return lows[fit.level[0]] - lows[fit.level[1]] - (fit.gap ?? 0) * s
    }
    // The sign change nearest to no turn, else the sample closest to level.
    let best = 0
    let bestGap = Math.abs(gap(0))
    let bracket: [number, number] | null = null
    const at = Array.from({ length: SAMPLES + 1 }, (_, i) => -RANGE + (2 * RANGE * i) / SAMPLES)
    const g = at.map(gap)
    for (let i = 0; i < SAMPLES; i++) {
      if (Math.abs(g[i]!) < bestGap) {
        bestGap = Math.abs(g[i]!)
        best = at[i]!
      }
      if (Math.sign(g[i]!) !== Math.sign(g[i + 1]!)) {
        const mid = (at[i]! + at[i + 1]!) / 2
        if (!bracket || Math.abs(mid) < Math.abs((bracket[0] + bracket[1]) / 2)) bracket = [at[i]!, at[i + 1]!]
      }
    }
    if (bracket) {
      let [lo, hi] = bracket
      const sLo = Math.sign(gap(lo))
      for (let k = 0; k < STEPS; k++) {
        const m = (lo + hi) / 2
        if (Math.sign(gap(m)) === sLo) lo = m
        else hi = m
      }
      best = (lo + hi) / 2
    }
    out = turned(out, fit.by, best)
  }
  return out
}

const SWAP: Partial<Record<ContactGroup, ContactGroup>> = { kneeL: 'kneeR', kneeR: 'kneeL', footL: 'footR', footR: 'footL' }
const SIDED = /^(shoulder|elbow|hip|knee)([LR])(.*)$/
const NEGATED = new Set(['torsoY', 'headY', 'torsoZ', 'headZ', 'rootY', 'rootZ'])

/** The fits of a mirrored pose (choreography.ts `mirrorJoints`): L and R swap, twist / lean / yaw / roll negate. */
export function mirrorFits(fits: PoseFit[] | undefined): PoseFit[] | undefined {
  if (!fits) return undefined
  const channel = (k: string): string => k.replace(SIDED, (_, a: string, s: string, b: string) => a + (s === 'L' ? 'R' : 'L') + b)
  return fits.map((f) => ({
    level: [SWAP[f.level[0]] ?? f.level[0], SWAP[f.level[1]] ?? f.level[1]],
    by: Object.fromEntries(Object.entries(f.by).map(([k, c]) => [channel(k), NEGATED.has(k) ? -c : c]))
  }))
}
