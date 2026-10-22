/**
 * Held weapons as the fight checks see them (fork addition, fight-polish;
 * see MODIFICATIONS.md): each weapon a few capsules (a segment and a
 * radius, in its model frame as the builders build it: blade, haft, cross
 * guard, axe head, gun body), the shield a stack of them across its disc.
 * A blade or shaft is then kept out of a body as a fist is, measured
 * against the same skins (fight/solve.ts, mocap/surface.ts): a capsule's
 * depth is its axis points' depth plus its radius.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { ClipState, V3 } from './types'
import type { PersonDims } from './skeleton'
import { handFrame, weaponRestLift, weaponRotation, type Hand, type WeaponSpec } from './weapons'

/** A capsule: the segment a → b (model frame, m) and its radius. */
export interface WeaponPiece {
  a: V3
  b: V3
  r: number
}

const c = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): WeaponPiece => ({ a: { x: ax, y: ay, z: az }, b: { x: bx, y: by, z: bz }, r })

/** The shield's disc (radius 0.35 m about y 0.35, its face across Z, the rim to 0.364): chords across it every 2.5 cm, each as long as the disc is wide beside it. */
const SHIELD_DISC: WeaponPiece[] = Array.from({ length: 29 }, (_, k) => {
  const y = (k - 14) * 0.025
  const h = Math.sqrt(Math.max(0, 0.364 ** 2 - Math.max(0, Math.abs(y) - 0.0125) ** 2))
  return c(-h, 0.35 + y, 0, h, 0.35 + y, 0, 0.018)
})

/** Model-frame capsules per weapon (before the rest lift), from builders.ts / weapon-builders.ts. */
const PIECES: Record<string, WeaponPiece[]> = {
  'prop.sword': [c(0, 0.165, 0, 0, 0.935, 0, 0.015), c(-0.065, 0.14, 0, 0.065, 0.14, 0, 0.02), c(0, 0, 0, 0, 0.12, 0, 0.025)],
  'prop.katana': [c(0, 0.017, 0, 0, 0.253, 0, 0.017), c(-0.03, 0.282, 0, 0.03, 0.282, 0, 0.015), c(0, 0.282, -0.03, 0, 0.282, 0.03, 0.015), c(-0.021, 0.282, -0.021, 0.021, 0.282, 0.021, 0.015), c(-0.021, 0.282, 0.021, 0.021, 0.282, -0.021, 0.015), c(0, 0.305, 0, 0, 0.655, 0, 0.015), c(0, 0.665, 0, -0.016, 0.975, 0, 0.014)],
  'prop.knife': [c(0, 0.011, 0, 0, 0.099, 0, 0.012), c(-0.014, 0.115, 0, 0.014, 0.115, 0, 0.011), c(0.002, 0.133, 0, -0.004, 0.275, 0, 0.013)],
  'prop.axe': [c(0, 0.018, 0, 0, 0.702, 0, 0.018), c(0, 0.64, 0, 0.09, 0.64, 0, 0.035), c(0.125, 0.578, 0, 0.125, 0.712, 0, 0.018), c(-0.04, 0.64, 0, -0.02, 0.64, 0, 0.025)],
  'prop.baseballBat': [c(0, 0.015, 0, 0, 0.3, 0, 0.022), c(0, 0.3, 0, 0, 0.6, 0, 0.029), c(0, 0.6, 0, 0, 0.88, 0, 0.035)],
  'prop.spear': [c(0, 0.016, 0, 0, 1.82, 0, 0.016), c(0, 1.855, 0, 0, 1.93, 0, 0.035), c(0, 1.93, 0, 0, 2.04, 0, 0.012)],
  'prop.staff': [c(0, 0.021, 0, 0, 1.679, 0, 0.021)],
  'prop.shield': [...SHIELD_DISC, c(0, 0.29, -0.03, 0, 0.41, -0.03, 0.028), c(-0.04, 0.3, -0.03, -0.04, 0.4, -0.03, 0.028), c(0.04, 0.3, -0.03, 0.04, 0.4, -0.03, 0.028), c(-0.06, 0.35, -0.03, 0.06, 0.35, -0.03, 0.028), c(-0.05, 0.23, 0.045, 0.05, 0.23, 0.045, 0.018), c(-0.06, 0.45, 0.03, 0.06, 0.45, 0.03, 0.017)],
  'prop.pistol': [c(0, 0.145, -0.12, 0, 0.145, 0.07, 0.022), c(0, 0.117, -0.07, 0, 0.117, 0, 0.02), c(0, 0.02, 0.05, 0, 0.12, 0.03, 0.025)],
  'prop.rifle': [c(0, 0.155, -0.4, 0, 0.155, 0.44, 0.045), c(0, 0.165, -0.58, 0, 0.165, -0.4, 0.012), c(0, 0.035, -0.065, 0, 0.13, -0.04, 0.03), c(0, 0.035, 0.14, 0, 0.11, 0.12, 0.025), c(0, 0.22, 0.015, 0, 0.22, 0.045, 0.02), c(0, 0.1, 0.445, 0, 0.18, 0.445, 0.03)],
  'prop.shotgun': [c(0, 0.15, -0.32, 0, 0.15, 0.2, 0.05), c(0, 0.15, 0.14, 0, 0.12, 0.44, 0.055), c(0, 0.135, -0.5, 0, 0.135, -0.09, 0.013), c(0, 0.165, -0.6, 0, 0.165, -0.3, 0.017), c(0, 0.045, 0.15, 0, 0.12, 0.13, 0.025)],
  'prop.bow': [c(0, 0.65, 0, 0, 0.85, 0, 0.025), c(0, 0.86, 0, 0, 1.433, 0.177, 0.013), c(0, 0.64, 0, 0, 0.067, 0.177, 0.013), c(0, 0.067, 0.177, 0, 1.433, 0.177, 0.004)]
}

/** A weapon's capsules in its model frame (on the floor, as `weaponRestLift` lifts the model); [] for anything else. */
export function weaponPieces(assetId: string): WeaponPiece[] {
  const y = weaponRestLift(assetId)
  return (PIECES[assetId] ?? []).map((p) => ({ a: { ...p.a, y: p.a.y + y }, b: { ...p.b, y: p.b.y + y }, r: p.r }))
}

/** Axis points are sampled at most this far apart (m). */
const STEP = 0.015

/** A capsule as its axis points (every STEP or closer) and its radius. */
export interface WeaponSamples {
  p: V3[]
  r: number
}

/** Each of a weapon's capsules as axis points (model frame), made once per weapon (read only). */
const SAMPLES = new Map<string, WeaponSamples[]>()
export function weaponSamples(assetId: string): WeaponSamples[] {
  let out = SAMPLES.get(assetId)
  if (!out) {
    out = weaponPieces(assetId).map(({ a, b, r }) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / STEP))
      return { p: Array.from({ length: n + 1 }, (_, k) => ({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, z: a.z + ((b.z - a.z) * k) / n })), r }
    })
    SAMPLES.set(assetId, out)
  }
  return out
}

/**
 * A held weapon's capsules (axis points and radius), entity-local to its
 * holder (unscaled by the holder), for a pose: the hand frame and the
 * weapon's rotation in it as `heldPointLocal` puts every point. With
 * `world` (the holder's placement), in world space instead, as
 * skeleton.ts `toWorld` takes entity-local points there (radius scaled too).
 */
export function heldWeaponSamples(dims: PersonDims, joints: Record<string, number> | undefined, hand: Hand, spec: WeaponSpec, weaponScale: number, clip?: ClipState, world?: { position: V3; heading: number; scale: number }): WeaponSamples[] {
  const f = handFrame(dims, joints, hand, clip)
  const m = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder, torso: f.torso })
  const g = spec.grip
  const at = (q: V3): V3 => {
    const x = (q.x - g.x) * weaponScale
    const y = (q.y - g.y) * weaponScale
    const z = (q.z - g.z) * weaponScale
    return { x: f.p.x + m[0] * x + m[1] * y + m[2] * z, y: f.p.y + m[3] * x + m[4] * y + m[5] * z, z: f.p.z + m[6] * x + m[7] * y + m[8] * z }
  }
  if (!world) return weaponSamples(spec.assetId).map((s) => ({ p: s.p.map(at), r: s.r * weaponScale }))
  // (One pass: the same sums as `at` then `toWorld`.)
  const P = world.position
  const k = world.scale
  const c = Math.cos(world.heading)
  const sn = Math.sin(world.heading)
  const placed = (q: V3): V3 => {
    const x = (q.x - g.x) * weaponScale
    const y = (q.y - g.y) * weaponScale
    const z = (q.z - g.z) * weaponScale
    const lx = (f.p.x + m[0] * x + m[1] * y + m[2] * z) * k
    const ly = (f.p.y + m[3] * x + m[4] * y + m[5] * z) * k
    const lz = (f.p.z + m[6] * x + m[7] * y + m[8] * z) * k
    return { x: P.x + lx * c + lz * sn, y: P.y + ly, z: P.z - lx * sn + lz * c }
  }
  return weaponSamples(spec.assetId).map((s) => ({ p: s.p.map(placed), r: s.r * weaponScale * k }))
}
