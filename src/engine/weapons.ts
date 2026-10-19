/**
 * Held weapons (fork addition; see MODIFICATIONS.md).
 *
 * A weapon is an ordinary entity whose `heldBy` names a person and a hand.
 * This module owns the math that puts it there: the hand frame of the person
 * rig (position AND orientation, from `personDims` + joints, mirroring the
 * renderer's `animatePerson` stand gait like `skeleton.ts`), each weapon's
 * grip (where the fist closes, how the weapon sits in it, where its tip or
 * muzzle is), idle hold poses, and closed-form off-hand IK for two-handed
 * weapons.
 *
 * Hand frame: origin at the hand point `(0, −lowerArmLen, 0)` of the
 * renderer's `elbowL` / `elbowR` group, with that group's axes: −Y runs down
 * the forearm to the knuckles, −Z is the thumb side (forward when the arm
 * hangs), so a fist's handle runs along Z. A weapon's model frame is its
 * builder's frame (origin on the ground, as every asset).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { assetSpec } from './assets'
import { LABEL_COLOR_NAMES } from './palette'
import { personDims, toWorld, type PersonDims } from './skeleton'
import type { Entity, EntityState, HeldBy, V3 } from './types'

export type Hand = HeldBy['hand']

/** Row-major 3×3 rotation. */
export type M3 = [number, number, number, number, number, number, number, number, number]

export type WeaponKind = 'blade' | 'blunt' | 'polearm' | 'gun' | 'bow' | 'shield'

/** How the business end meets a target (the fight director's contact point). */
export type WeaponStrike = 'edge' | 'point' | 'blunt' | 'shot' | 'bash'

export interface WeaponSpec {
  assetId: string
  kind: WeaponKind
  /**
   * 'hand': rigid in the fist (`rot`). 'shoulder': a long gun whose stock sits
   * at the same side's shoulder, so the barrel runs from the shoulder through
   * the grip, top toward the thumb (`rot` is the fallback when the hand is at
   * the shoulder).
   */
  mount: 'hand' | 'shoulder'
  strike: WeaponStrike
  /** Held with both hands; the off hand reaches `support` when there is one. */
  twoHanded: boolean
  defaultHand: Hand
  /** Model-frame point the main hand closes on. */
  grip: V3
  /** Model-frame business end: blade tip, spear point, bat end, muzzle, arrow rest, shield face. */
  tip: V3
  /** Model-frame unit direction the business end points (blade axis, barrel, arrow). */
  aim: V3
  /** Model-frame point for the off hand of a two-handed weapon. */
  support?: V3
  /**
   * A one-handed carry at rest (spear, staff): the off hand only takes the
   * support point as the holding arm leaves its idle pose. At rest it can't
   * reach a point on the shaft in front, and the one behind is a reach round
   * the back.
   */
  restOneHanded?: boolean
  /** Model → hand-frame rotation for the right hand. */
  rot: M3
  /** Idle hold pose for the holding arm (right-arm channels; mirrored for L). */
  idle: Record<string, number>
}

/* --------------------------- tiny 3×3 rigid math -------------------------- */

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

function transpose(m: M3): M3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
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

function apply(m: M3, p: V3): V3 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z,
    y: m[3] * p.x + m[4] * p.y + m[5] * p.z,
    z: m[6] * p.x + m[7] * p.y + m[8] * p.z
  }
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z })
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

/** Rotation whose columns are where the model's X, Y, Z axes land (x = y × z). */
function columns(y: V3, z: V3): M3 {
  const x = cross(y, z)
  return [x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z]
}

/* ------------------------------- the hand -------------------------------- */

export interface HandFrame {
  /** Hand point, entity-local (ground origin, facing −Z, unscaled). */
  p: V3
  /** Hand-frame axes in entity-local space (row-major; columns are the axes). */
  r: M3
  /** The same side's shoulder joint (where a long gun's stock sits). */
  shoulder: V3
}

interface Frame {
  p: V3
  r: M3
}

function child(parent: Frame, offset: V3, rot: M3): Frame {
  return { p: add(parent.p, apply(parent.r, offset)), r: mul(parent.r, rot) }
}

/** The torso frame of `skeleton.ts` / `animatePerson` (stand gait, no breathing bob). */
function torsoFrame(dims: PersonDims, j: (k: string) => number): Frame {
  const pelvis: Frame = { p: v(0, dims.legLen, 0), r: IDENTITY }
  return child(pelvis, v(0, 0.08 * dims.s, 0), euler(dims.baseLean - j('torsoX'), j('torsoY'), -j('torsoZ')))
}

function shoulderOffset(dims: PersonDims, side: Hand): V3 {
  return v((side === 'L' ? -1 : 1) * dims.shoulderX, dims.shoulderY, 0)
}

/**
 * The hand frame for a pose: the renderer's elbow group, translated to the
 * hand point. Same chain and override signs as `poseEffectors` in
 * `skeleton.ts` (a test pins the two together).
 */
export function handFrame(dims: PersonDims, joints: Record<string, number> | undefined, hand: Hand): HandFrame {
  const j = (k: string): number => joints?.[k] ?? 0
  const torso = torsoFrame(dims, j)
  const shoulderRot =
    hand === 'L' ? euler(-j('shoulderLX'), 0, -j('shoulderLZ')) : euler(-j('shoulderRX'), 0, j('shoulderRZ'))
  const shoulder = child(torso, shoulderOffset(dims, hand), shoulderRot)
  const elbow = child(shoulder, v(0, -dims.upperArmLen, 0), euler(j(hand === 'L' ? 'elbowL' : 'elbowR'), 0, 0))
  return { p: add(elbow.p, apply(elbow.r, v(0, -dims.lowerArmLen, 0))), r: elbow.r, shoulder: shoulder.p }
}

/* ------------------------------- the grips ------------------------------- */

/** Blades, clubs and shafts built upright (+Y to the tip, +X the edge): the tip sits `a` rad off the thumb toward the knuckles. */
function bladeHold(a: number): M3 {
  return columns(v(0, -Math.sin(a), -Math.cos(a)), v(1, 0, 0))
}

/** Guns and the bow, built level (−Z the barrel / arrow, +Y up): barrel along the forearm, top toward the thumb. */
const LEVEL_HOLD: M3 = columns(v(0, 0, -1), v(0, 1, 0))

/** A shield built standing (−Z its face): strapped along the forearm, its face on the pinky side. */
const SHIELD_HOLD: M3 = columns(v(0, 1, 0), v(0, 0, -1))

/** Blade angle off the thumb axis: a thrust ends level, a slash follows through, the point hangs low at rest. */
const BLADE = 1.2

const W = (
  assetId: string,
  kind: WeaponKind,
  strike: WeaponStrike,
  twoHanded: boolean,
  defaultHand: Hand,
  grip: V3,
  tip: V3,
  aim: V3,
  rot: M3,
  idle: Record<string, number>,
  support?: V3
): WeaponSpec => ({
  assetId,
  kind,
  mount: kind === 'gun' && twoHanded ? 'shoulder' : 'hand',
  strike,
  twoHanded,
  defaultHand,
  grip,
  tip,
  aim,
  rot,
  idle,
  ...(support ? { support } : {})
})

const UP = v(0, 1, 0)
const FWD = v(0, 0, -1)

/** Low ready: blades point forward-down ~30°, shafts ~20°, hands at the belt (two-handers at the centreline). */
const BLADE_IDLE = { shoulderRX: 0, shoulderRZ: 0.1, elbowR: 0.65 }
const SHAFT_IDLE = { shoulderRX: 0, shoulderRZ: -0.2, elbowR: 0.85 }
const GUARD_IDLE = { shoulderRX: 0, shoulderRZ: -0.2, elbowR: 0.65 }
/** Long guns at low ready: grip at the chest, muzzle ~30° down, the off hand on the handguard. */
const LONG_GUN_IDLE = { shoulderRX: 0.2, shoulderRZ: -0.6, elbowR: 2.4 }

export const WEAPON_SPECS: WeaponSpec[] = [
  W('prop.sword', 'blade', 'edge', false, 'R', v(0, 0.075, 0), v(0, 0.95, 0), UP, bladeHold(BLADE), BLADE_IDLE),
  W('prop.katana', 'blade', 'edge', true, 'R', v(0, 0.22, 0), v(-0.015, 0.99, 0), UP, bladeHold(BLADE), GUARD_IDLE, v(0, 0.08, 0)),
  W('prop.knife', 'blade', 'point', false, 'R', v(0, 0.055, 0), v(0, 0.29, 0), UP, bladeHold(BLADE), BLADE_IDLE),
  W('prop.axe', 'blade', 'edge', false, 'R', v(0, 0.1, 0), v(0.13, 0.66, 0), UP, bladeHold(BLADE), BLADE_IDLE),
  W('prop.baseballBat', 'blunt', 'blunt', true, 'R', v(0, 0.17, 0), v(0, 0.82, 0), UP, bladeHold(BLADE), GUARD_IDLE, v(0, 0.07, 0)),
  { ...W('prop.spear', 'polearm', 'point', true, 'R', v(0, 0.95, 0), v(0, 2.04, 0), UP, bladeHold(BLADE), SHAFT_IDLE, v(0, 0.5, 0)), restOneHanded: true },
  { ...W('prop.staff', 'polearm', 'blunt', true, 'R', v(0, 0.65, 0), v(0, 1.7, 0), UP, bladeHold(BLADE), SHAFT_IDLE, v(0, 0.2, 0)), restOneHanded: true },
  W('prop.pistol', 'gun', 'shot', false, 'R', v(0, 0.07, 0.035), v(0, 0.145, -0.12), FWD, LEVEL_HOLD, {
    shoulderRX: -0.3,
    shoulderRZ: 0.05,
    elbowR: 0.6
  }),
  W('prop.rifle', 'gun', 'shot', true, 'R', v(0, 0.07, 0.13), v(0, 0.165, -0.58), FWD, LEVEL_HOLD, LONG_GUN_IDLE, v(0, 0.12, -0.24)),
  W('prop.shotgun', 'gun', 'shot', true, 'R', v(0, 0.075, 0.14), v(0, 0.165, -0.6), FWD, LEVEL_HOLD, LONG_GUN_IDLE, v(0, 0.115, -0.24)),
  // Bow ready at the waist: forearm level, limbs upright, arrow forward.
  W('prop.bow', 'bow', 'shot', true, 'L', v(0, 0.75, 0), v(0, 0.78, -0.03), FWD, LEVEL_HOLD, {
    shoulderRX: 0.05,
    shoulderRZ: 0.15,
    elbowR: 1.45
  }),
  W('prop.shield', 'shield', 'bash', false, 'L', v(0, 0.23, 0.06), v(0, 0.35, -0.03), FWD, SHIELD_HOLD, {
    shoulderRX: -0.75,
    shoulderRZ: 0.1,
    elbowR: 1.95
  })
]

const SPEC_BY_ID = new Map(WEAPON_SPECS.map((w) => [w.assetId, w]))

/** The weapon spec for an asset, or undefined when it can't be held. */
export function weaponSpec(assetId: string): WeaponSpec | undefined {
  return SPEC_BY_ID.get(assetId)
}

/** Only the person rig has hands. */
export function canHoldWeapons(assetId: string): boolean {
  return assetId.startsWith('person.')
}

/* ------------------------------ holding math ----------------------------- */

const MIRROR_X: M3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1]

/** The model axis that lands on the hand's ±X (the weapon's lateral axis). */
function lateralAxis(rot: M3): 0 | 1 | 2 {
  const a = [Math.abs(rot[0]), Math.abs(rot[1]), Math.abs(rot[2])]
  return a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2
}

/**
 * Model point → hand-frame point: `r · (scale · p) + t`. The left hand holds
 * the mirror image of the right-hand hold (reflected through the hand's X and
 * the weapon's lateral axis, so it stays a proper rotation).
 */
export function holdTransform(spec: WeaponSpec, hand: Hand, weaponScale: number): { r: M3; t: V3 } {
  let r = spec.rot
  if (hand === 'L') {
    const lat = lateralAxis(spec.rot)
    const flip: M3 = [lat === 0 ? -1 : 1, 0, 0, 0, lat === 1 ? -1 : 1, 0, 0, 0, lat === 2 ? -1 : 1]
    r = mul(mul(MIRROR_X, spec.rot), flip)
  }
  const tR = scale(apply(spec.rot, spec.grip), -weaponScale)
  const t = hand === 'L' ? v(-tR.x, tR.y, tR.z) : tR
  return { r, t }
}

/** Hand-frame rotation and offset of the weapon model inside the elbow group (for the renderer). */
export function heldInElbow(dims: PersonDims, spec: WeaponSpec, hand: Hand, weaponScale: number): { r: M3; t: V3 } {
  const h = holdTransform(spec, hand, weaponScale)
  return { r: h.r, t: add(h.t, v(0, -dims.lowerArmLen, 0)) }
}

const dotv = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
const unit = (a: V3): V3 => scale(a, 1 / len(a))
const perp = (a: V3, axis: V3): V3 => sub(a, scale(axis, dotv(a, axis)))

/**
 * Weapon model → holder space rotation for a hand pose, in whatever space
 * the inputs are (entity-local from FK, or world from the rendered rig).
 * The grip sits on `hand`; a model point lands at `hand + R · (s · (p − grip))`.
 */
export function weaponRotation(spec: WeaponSpec, side: Hand, frame: { hand: V3; handRot: M3; shoulder: V3 }): M3 {
  const rigid = mul(frame.handRot, holdTransform(spec, side, 1).r)
  if (spec.mount === 'hand') return rigid
  const rigidBarrel = apply(rigid, spec.aim)
  const d = sub(frame.hand, frame.shoulder)
  const n = len(d)
  // Hand at the shoulder: ease back to the rigid hold instead of a degenerate line.
  const w = clamp((n - 0.05) / 0.05, 0, 1)
  const dir = unit(n > 1e-9 ? add(scale(d, w / n), scale(rigidBarrel, 1 - w)) : rigidBarrel)
  const thumb = apply(frame.handRot, v(0, 0, -1))
  let up = add(perp(thumb, dir), scale(perp(v(0, 1, 0), dir), 0.25))
  if (len(up) < 1e-6) up = perp(apply(rigid, v(0, 1, 0)), dir)
  return columns(unit(up), scale(dir, -1))
}

/** A weapon model point held in `hand`, entity-local to the holder (unscaled by the holder). */
export function heldPointLocal(
  dims: PersonDims,
  joints: Record<string, number> | undefined,
  hand: Hand,
  spec: WeaponSpec,
  modelPoint: V3,
  weaponScale: number
): V3 {
  const f = handFrame(dims, joints, hand)
  const r = weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder })
  return add(f.p, apply(r, scale(sub(modelPoint, spec.grip), weaponScale)))
}

/** Unit direction the weapon's business end points, entity-local to the holder. */
export function aimDirectionLocal(
  dims: PersonDims,
  joints: Record<string, number> | undefined,
  hand: Hand,
  spec: WeaponSpec
): V3 {
  const f = handFrame(dims, joints, hand)
  return unit(apply(weaponRotation(spec, hand, { hand: f.p, handRot: f.r, shoulder: f.shoulder }), spec.aim))
}

/** The idle hold pose for the holding arm. */
export function idleJoints(spec: WeaponSpec, hand: Hand): Record<string, number> {
  if (hand === 'R') return { ...spec.idle }
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(spec.idle)) out[k.replace('R', 'L')] = val
  return out
}

/**
 * Closed-form two-bone IK for one arm (shoulder X/Z, elbow): the joint values
 * that put the hand on an entity-local target, given the torso channels in
 * `joints`. Targets out of reach straighten the arm toward them; too-close
 * targets fold it fully.
 */
export function solveArmIK(
  dims: PersonDims,
  joints: Record<string, number> | undefined,
  side: Hand,
  target: V3
): Record<string, number> {
  const j = (k: string): number => joints?.[k] ?? 0
  const torso = torsoFrame(dims, j)
  let q = sub(apply(transpose(torso.r), sub(target, torso.p)), shoulderOffset(dims, side))
  const u = dims.upperArmLen
  const l = dims.lowerArmLen
  const d = len(q)
  const dClamped = clamp(d, Math.abs(u - l) + 1e-9, u + l)
  if (d < 1e-9) q = v(0, -dClamped, 0)
  else if (dClamped !== d) q = scale(q, dClamped / d)
  const cosE = clamp((dClamped * dClamped - u * u - l * l) / (2 * u * l), -1, 1)
  const e = Math.acos(cosE)
  const a = u + l * Math.cos(e)
  const bz = -l * Math.sin(e)
  const rz = Math.abs(a) < 1e-12 ? 0 : Math.asin(clamp(q.x / a, -1, 1))
  const y = -a * Math.cos(rz)
  const rx = Math.atan2(q.z, q.y) - Math.atan2(bz, y)
  // Wrap rx into (−π, π] so the stored channel stays small.
  const wrapped = Math.atan2(Math.sin(rx), Math.cos(rx))
  return side === 'L'
    ? { shoulderLX: -wrapped, shoulderLZ: -rz, elbowL: e }
    : { shoulderRX: -wrapped, shoulderRZ: rz, elbowR: e }
}

/* ------------------------------ in the scene ------------------------------ */

/** Arm channels whose size says how far a motion has taken the arm from rest. */
const ARM_CHANNELS: Record<Hand, string[]> = {
  L: ['shoulderLX', 'shoulderLZ', 'elbowL'],
  R: ['shoulderRX', 'shoulderRZ', 'elbowR']
}

/** An arm posed this far (rad, largest channel) plays its own pose; the idle hold has faded out. */
const IDLE_FADE = 0.6

/** The Inspector's static pose sliders (`params.joint_*`), which the renderer adds on top of the marks. */
function staticJoints(entity: Entity): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, val] of Object.entries(entity.params ?? {})) {
    if (key.startsWith('joint_') && typeof val === 'number' && val !== 0) out[key.slice(6)] = val
  }
  return out
}

function sumJoints(a: Record<string, number> | undefined, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a }
  for (const [k, val] of Object.entries(b)) out[k] = (out[k] ?? 0) + val
  return out
}

/** A hold the scene can honour: a weapon, in a person's hand, both present. */
function validHold(entity: Entity, byId: Map<string, Entity>): { spec: WeaponSpec; holder: Entity; hand: Hand } | null {
  const held = entity.heldBy
  if (!held) return null
  const spec = weaponSpec(entity.assetId)
  const holder = byId.get(held.entityId)
  if (!spec || !holder || holder.id === entity.id || !canHoldWeapons(holder.assetId)) return null
  if (held.hand !== 'L' && held.hand !== 'R') return null
  return { spec, holder, hand: held.hand }
}

/**
 * Forward-migrate `heldBy` (schema.ts): drop malformed, dangling and
 * impossible holds, and keep only the first weapon in each hand.
 */
export function sanitizeHolds(entities: Entity[]): void {
  const byId = new Map(entities.map((e) => [e.id, e]))
  const taken = new Set<string>()
  for (const entity of entities) {
    const raw = (entity as { heldBy?: unknown }).heldBy
    if (raw === undefined) continue
    const ok =
      typeof raw === 'object' && raw !== null && typeof (raw as HeldBy).entityId === 'string' && validHold(entity, byId)
    const slot = ok ? `${entity.heldBy!.entityId}:${entity.heldBy!.hand}` : ''
    if (!ok || taken.has(slot)) {
      delete entity.heldBy
      continue
    }
    entity.heldBy = { entityId: entity.heldBy!.entityId, hand: entity.heldBy!.hand }
    taken.add(slot)
  }
}

/** A weapon in one hand, as `holdJoints` needs it. */
export interface HeldWeapon {
  spec: WeaponSpec
  hand: Hand
  /** The weapon entity's scale. */
  scale: number
}

/**
 * The holder's joints with its weapons' grip poses (pure; the evaluator and
 * the fight solver share it): each weapon's idle hold blends into its arm as
 * far as that arm is at rest, and the free off hand of a two-handed weapon
 * reaches the support point. `fixed` are the static pose sliders, which the
 * renderer adds on top. Returns `joints` itself when nothing changes.
 */
export function holdJoints(
  dims: PersonDims,
  joints: Record<string, number> | undefined,
  held: HeldWeapon[],
  fixed: Record<string, number> = {}
): Record<string, number> | undefined {
  const hands: Partial<Record<Hand, HeldWeapon>> = {}
  for (const h of held) hands[h.hand] ??= h
  const out: Record<string, number> = { ...joints }
  const rest: Partial<Record<Hand, number>> = {}
  let touched = false
  for (const hand of ['R', 'L'] as Hand[]) {
    const h = hands[hand]
    if (!h) continue
    const combined = sumJoints(out, fixed)
    const posed = Math.max(0, ...ARM_CHANNELS[hand].map((k) => Math.abs(combined[k] ?? 0)))
    const w = clamp(1 - posed / IDLE_FADE, 0, 1)
    rest[hand] = w
    if (w <= 0) continue
    for (const [k, val] of Object.entries(idleJoints(h.spec, hand))) out[k] = (out[k] ?? 0) + val * w
    touched = true
  }
  for (const hand of ['R', 'L'] as Hand[]) {
    const h = hands[hand]
    const off: Hand = hand === 'R' ? 'L' : 'R'
    if (!h?.spec.support || hands[off]) continue
    const reach = h.spec.restOneHanded ? 1 - (rest[hand] ?? 0) : 1
    if (reach <= 0) continue
    const combined = sumJoints(out, fixed)
    const target = heldPointLocal(dims, combined, hand, h.spec, h.spec.support, h.scale)
    for (const [k, val] of Object.entries(solveArmIK(dims, combined, off, target))) {
      const from = out[k] ?? 0
      out[k] = from + (val - (fixed[k] ?? 0) - from) * reach
    }
    touched = true
  }
  return touched ? out : joints
}

/**
 * The evaluator hook (evaluate.ts, after marriages): each holder takes its
 * weapons' grip poses (`holdJoints`), and every held weapon's state moves to
 * its grip in the hand. A scene without held weapons is left untouched.
 */
export function applyHolds(entities: Entity[], states: EntityState[]): void {
  if (!entities.some((e) => e.heldBy)) return
  const byId = new Map(entities.map((e) => [e.id, e]))
  const stateOf = new Map(states.map((st) => [st.entityId, st]))
  const holders = new Map<string, { holder: Entity; hands: Partial<Record<Hand, { weapon: Entity; spec: WeaponSpec }>> }>()
  for (const weapon of entities) {
    const h = validHold(weapon, byId)
    if (!h || !stateOf.has(weapon.id) || !stateOf.has(h.holder.id)) continue
    const entry = holders.get(h.holder.id) ?? { holder: h.holder, hands: {} }
    if (entry.hands[h.hand]) continue
    entry.hands[h.hand] = { weapon, spec: h.spec }
    holders.set(h.holder.id, entry)
  }
  for (const { holder, hands } of holders.values()) {
    const st = stateOf.get(holder.id)!
    const fixed = staticJoints(holder)
    const dims = personDims(holder.assetId, holder.params)
    const held: HeldWeapon[] = (['R', 'L'] as Hand[])
      .filter((hand) => hands[hand])
      .map((hand) => ({ spec: hands[hand]!.spec, hand, scale: hands[hand]!.weapon.transform.scale }))
    st.joints = holdJoints(dims, st.joints, held, fixed)
    const combined = sumJoints(st.joints, fixed)
    for (const hand of ['R', 'L'] as Hand[]) {
      const h = hands[hand]
      if (!h) continue
      const ws = stateOf.get(h.weapon.id)!
      const grip = heldPointLocal(dims, combined, hand, h.spec, h.spec.grip, h.weapon.transform.scale)
      ws.position = toWorld(grip, st.position, st.heading, holder.transform.scale)
      ws.heading = st.heading
      ws.gait = 'stand'
      ws.speed = st.speed
      ws.distanceTravelled = st.distanceTravelled
      delete ws.joints
    }
  }
}

/**
 * Where a weapon meets things (model frame). 'strike': a blade 80 % of the
 * way to its tip, a club 90 %, a point at the tip, a shield's face, a gun's
 * muzzle (a pistol-whip). 'guard', where it takes a blow: mid-blade or
 * mid-shaft, the shield's face; the grip for guns and the bow (the hand takes it).
 */
export function weaponContact(spec: WeaponSpec, role: 'strike' | 'guard'): V3 {
  const along = (f: number): V3 => add(spec.grip, scale(sub(spec.tip, spec.grip), f))
  if (role === 'guard') return spec.kind === 'shield' ? spec.tip : spec.kind === 'gun' || spec.kind === 'bow' ? spec.grip : along(0.45)
  if (spec.strike === 'edge') return along(0.8)
  if (spec.strike === 'blunt') return along(0.9)
  return spec.tip
}

/* ----------------------------- editing holds ------------------------------ */

/** Why `holder` can't take `weapon` into a hand, or null when it can. */
export function holdError(weapon: Entity | undefined, holder: Entity | undefined): string | null {
  if (!weapon) return 'No such weapon.'
  if (!weaponSpec(weapon.assetId)) return `${weapon.name} isn't a weapon a person can hold.`
  if (!holder) return 'No such person.'
  if (holder.id === weapon.id || !canHoldWeapons(holder.assetId)) return `${holder.name} has no hands — only people hold weapons.`
  return null
}

/** The hand a weapon goes in: the one asked for, else the weapon's usual hand. */
export function handFor(weapon: Entity, hand?: Hand): Hand {
  return hand ?? weaponSpec(weapon.assetId)?.defaultHand ?? 'R'
}

/** Weapons other than `exceptId` in that hand of that holder (to set down before a new one goes in). */
export function weaponsInHand(entities: Entity[], holderId: string, hand: Hand, exceptId?: string): Entity[] {
  return entities.filter((e) => e.id !== exceptId && e.heldBy?.entityId === holderId && e.heldBy.hand === hand)
}

/** Put `weapon` in `holder`'s hand; a marriage on the weapon is dropped (the hand wins). */
export function putInHand(weapon: Entity, holder: Entity, hand: Hand): void {
  weapon.heldBy = { entityId: holder.id, hand }
  delete weapon.attachedTo
  delete weapon.attachedLocal
}

/** Set a weapon down where its grip is (`at`, from the evaluator), standing, facing `heading`. */
export function setDown(weapon: Entity, at: V3, heading: number): void {
  delete weapon.heldBy
  weapon.transform.position = { x: at.x, y: 0, z: at.z }
  weapon.transform.rotationY = heading
}

/* --------------------------------- prompt -------------------------------- */

/**
 * Prompt words for a held weapon — "a sword (the green shape) in A's right
 * hand" — or null when it isn't held. The colour tells the video model which
 * grey shape is the weapon.
 */
export function heldWeaponWords(weapon: Entity, entities: Entity[]): string | null {
  const held = weapon.heldBy
  const holder = held ? entities.find((e) => e.id === held.entityId) : undefined
  if (!held || !holder || !weaponSpec(weapon.assetId)) return null
  const who = holder.label?.text || assetSpec(holder.assetId).promptNoun.replace(/^an? /, 'the ')
  const color = Object.entries(LABEL_COLOR_NAMES).find(([, hex]) => hex === weapon.label?.color?.toLowerCase())?.[0]
  const tag = weapon.label?.text ? ` ("${weapon.label.text}")` : color ? ` (the ${color} shape)` : ''
  return `${assetSpec(weapon.assetId).promptNoun}${tag} in ${who}'s ${held.hand === 'L' ? 'left' : 'right'} hand`
}
