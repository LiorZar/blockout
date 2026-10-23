/**
 * Speed warnings that know what a vehicle can do (fork addition, street-kit;
 * see MODIFICATIONS.md). Upstream checks every travel leg against a person's
 * gait speeds times the asset's `speedScale`, so a car "running" at a chase's
 * 15 m/s read as too slow (a car's run started at 26 m/s) and was told to
 * jog. A road vehicle (anything on wheels or rails; not a plane) is checked
 * on its evaluated path instead: its top speed, and its acceleration over a
 * half-second window (a car rounds a mark's corner, or launches, in about
 * that), split into speeding up, braking and cornering, each against the
 * class's limits. A camera that follows a moving subject warns when its
 * marks travel faster than its rig can.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { RigId, V3 } from './types'

export interface VehicleLimits {
  /** Top speed (m/s). */
  top: number
  /** Hardest launch, braking and cornering (m/s²). */
  accel: number
  brake: number
  corner: number
}

const CAR: VehicleLimits = { top: 70, accel: 9, brake: 11, corner: 11 }

export const VEHICLE_LIMITS: Record<string, VehicleLimits> = {
  'vehicle.sedan': CAR,
  'vehicle.suv': { top: 60, accel: 8, brake: 10, corner: 9.5 },
  'vehicle.pickup': { top: 55, accel: 7, brake: 10, corner: 9 },
  'vehicle.van': { top: 50, accel: 6, brake: 9, corner: 8 },
  'vehicle.bus': { top: 30, accel: 2.5, brake: 7, corner: 4 },
  'vehicle.truck': { top: 35, accel: 2.5, brake: 7, corner: 4 },
  'vehicle.tank': { top: 20, accel: 3, brake: 6, corner: 5 },
  'vehicle.train': { top: 90, accel: 1.5, brake: 3, corner: 2 },
  'vehicle.motorcycle': { top: 85, accel: 10, brake: 11, corner: 12 },
  'vehicle.bicycle': { top: 20, accel: 3, brake: 6, corner: 6 },
  'vehicle.boat': { top: 30, accel: 4, brake: 4, corner: 5 }
}

/** The limits of a road (or rail, or water) vehicle; undefined for anything else, which keeps upstream's gait check. */
export function vehicleLimits(assetId: string): VehicleLimits | undefined {
  return VEHICLE_LIMITS[assetId]
}

/** How fast a camera rig can follow (m/s): an operator or a dolly at a run, a cinema drone, a camera car. */
export const RIG_TOP_SPEED: Record<RigId, number> = {
  sticks: 8,
  dolly: 8,
  steadicam: 8,
  handheld: 8,
  crane: 8,
  drone: 30,
  carMount: 70
}

/** The acceleration window: half a second, centred. */
const HALF_WINDOW = 0.25
/** Samples a second. */
const RATE = 48

export type MotionIssueKind = 'top' | 'accel' | 'brake' | 'corner'

export interface MotionIssue {
  kind: MotionIssueKind
  /** When (s). */
  t: number
  /** Speed (m/s) for 'top'; acceleration (m/s²) for the rest. */
  value: number
  /** Speed at that time (m/s). */
  speed: number
}

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
const len = (a: V3): number => Math.sqrt(dot(a, a))

/** Velocity at t from positions `at`, by a centred difference kept inside [t0, t1]. */
function velocity(at: (t: number) => V3, t: number, t0: number, t1: number): V3 {
  const h = 1 / (2 * RATE)
  const a = Math.max(t0, t - h)
  const b = Math.min(t1, t + h)
  return b - a < 1e-9 ? { x: 0, y: 0, z: 0 } : scale(sub(at(b), at(a)), 1 / (b - a))
}

/** Velocities on a grid of RATE a second over [t0, t1]: times and vectors. */
function velocities(at: (t: number) => V3, t0: number, t1: number): { t: number; v: V3 }[] {
  const n = Math.max(1, Math.ceil((t1 - t0) * RATE))
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = t0 + ((t1 - t0) * k) / n
    return { t, v: velocity(at, t, t0, t1) }
  })
}

function fastest(grid: { t: number; v: V3 }[], top: number): MotionIssue | null {
  let worst: MotionIssue | null = null
  for (const { t, v } of grid) {
    const speed = len(v)
    if (speed > top + 1e-6 && (!worst || speed > worst.value)) worst = { kind: 'top', t, value: speed, speed }
  }
  return worst
}

/** The fastest moment of a path over [t0, t1], when it beats `top`. */
export function topSpeedIssue(at: (t: number) => V3, t0: number, t1: number, top: number): MotionIssue | null {
  return fastest(velocities(at, t0, t1), top)
}

/**
 * The worst moment of each kind a vehicle's path (`at`, over the shot's
 * [t0, t1]) breaks its limits: top speed, and over each half-second window
 * inside the shot the change of speed (speeding up, braking) and the turn at
 * the mean speed (cornering, v ω).
 */
export function vehicleIssues(at: (t: number) => V3, t0: number, t1: number, limits: VehicleLimits): MotionIssue[] {
  const worst = new Map<MotionIssueKind, MotionIssue>()
  const keep = (i: MotionIssue): void => {
    const was = worst.get(i.kind)
    if (!was || i.value > was.value) worst.set(i.kind, i)
  }
  const grid = velocities(at, t0, t1)
  const top = fastest(grid, limits.top)
  if (top) keep(top)
  const dt = grid.length > 1 ? grid[1]!.t - grid[0]!.t : 1
  const w = Math.max(1, Math.round(HALF_WINDOW / dt))
  for (let k = w; k + w < grid.length; k++) {
    const before = grid[k - w]!.v
    const after = grid[k + w]!.v
    const span = grid[k + w]!.t - grid[k - w]!.t
    const sb = len(before)
    const sa = len(after)
    const along = (sa - sb) / span
    const turn = sb > 0.5 && sa > 0.5 ? Math.acos(Math.max(-1, Math.min(1, dot(before, after) / (sa * sb)))) : 0
    const across = (((sa + sb) / 2) * turn) / span
    const { t, v } = grid[k]!
    const speed = len(v)
    if (along > limits.accel) keep({ kind: 'accel', t, value: along, speed })
    if (-along > limits.brake) keep({ kind: 'brake', t, value: -along, speed })
    if (across > limits.corner) keep({ kind: 'corner', t, value: across, speed })
  }
  return (['top', 'accel', 'brake', 'corner'] as MotionIssueKind[]).flatMap((kind) => (worst.has(kind) ? [worst.get(kind)!] : []))
}

const kmh = (v: number): string => `${Math.round(v * 3.6)} km/h`

/** A vehicle issue in words, e.g. "LEAD corners at 14.2 m/s² (1.4 g) at 2.0 s; a sedan car grips about 11 — widen the turn or slow it." */
export function vehicleMessage(name: string, noun: string, i: MotionIssue, limits: VehicleLimits): string {
  const at = `at ${i.t.toFixed(1)} s`
  const g = `${(i.value / 9.81).toFixed(1)} g`
  switch (i.kind) {
    case 'top':
      return `${name} reaches ${Math.round(i.value)} m/s (${kmh(i.value)}) ${at}, past ${noun}'s top speed of about ${limits.top} m/s: move its marks closer or give it more time.`
    case 'accel':
      return `${name} speeds up at ${i.value.toFixed(1)} m/s² (${g}) ${at}; ${noun} manages about ${limits.accel}: ease its start or give it more time.`
    case 'brake':
      return `${name} brakes at ${i.value.toFixed(1)} m/s² (${g}) ${at}; ${noun} stops at about ${limits.brake}: ease its stop or give it more room.`
    case 'corner':
      return `${name} corners at ${i.value.toFixed(1)} m/s² (${g}) ${at} at ${Math.round(i.speed)} m/s; ${noun} grips about ${limits.corner}: widen the turn or slow it.`
  }
}

/** A follow camera too fast for its rig, in words. */
export function cameraMessage(subject: string, rigName: string, speed: number, top: number): string {
  const better = speed <= RIG_TOP_SPEED.drone ? 'Car mount or Drone' : 'Car mount'
  return `The camera follows ${subject} at ${speed.toFixed(1)} m/s (${kmh(speed)}): a ${rigName} rig can't keep up (about ${top} m/s); set the rig to ${better}.`
}
