/**
 * The open road (fork addition, street-kit; see MODIFICATIONS.md): a city
 * street as long as the shot needs. The street kits are 20–36 m tiles and a
 * 6 s car chase covers ~90 m, so the cars drove off the set into the empty
 * ground within two seconds. `env.openRoad` is one kit whose length is a
 * parameter (`params.length`, the drivable asphalt in metres); a car chase
 * lays one under itself (sequences.ts).
 *
 * Cross-section (the road runs along the kit's Z): asphalt to the kerbs at
 * ±ROAD_KERB with a yellow centre dash and white lane dashes, raised
 * sidewalks to ±ROAD_WALK with a lamp post every 15 m each side (staggered),
 * a front row of buildings with a storefront band and window rows, a taller
 * back row, and an end block across each end ROAD_END past the drivable
 * length, so a camera looking down the street sees a facade, never the empty
 * ground. Every surface sits 2 mm above a standard kit's so a road laid over
 * another kit doesn't flicker.
 *
 * `roadLayout` lists the boxes as plain data (the renderer draws them in
 * renderer/viewport/road-kit.ts); widths and heights vary by an index hash,
 * so the same length always lays the same street.
 *
 * PURE: no DOM / three.js / Electron, no randomness.
 */

export const OPEN_ROAD = 'env.openRoad'
/** Asphalt half width: the kerb line (m). */
export const ROAD_KERB = 5.5
/** The back of the sidewalk, where the front row of buildings starts (m). */
export const ROAD_WALK = 9
/** Asphalt past each end of the drivable length, before the end block (m). */
export const ROAD_END = 10
export const ROAD_DEFAULT_LENGTH = 120
export const ROAD_MIN_LENGTH = 40
export const ROAD_MAX_LENGTH = 2000

/** The outer edge of the back row of buildings (m). */
const OUTER = 36
const LIFT = 0.002
const LAMP_STEP = 15

export type RoadPart = 'ground' | 'asphalt' | 'sidewalk' | 'dash' | 'building' | 'pole' | 'lamp'

export interface RoadBox {
  part: RoadPart
  /** Centre, kit-local (m); the road runs along Z. A ground is a plane at y. */
  x: number
  y: number
  z: number
  /** Size along X, Y, Z (m). */
  w: number
  h: number
  d: number
  color: number
  /** Boxes with the same group are one mesh (a building and its bands, a lamp's arm and head). */
  group?: number
}

/** The drivable length of a road entity's params, clamped. */
export function roadLength(params?: Record<string, number | string>): number {
  const v = params?.length
  const n = typeof v === 'number' && Number.isFinite(v) ? v : ROAD_DEFAULT_LENGTH
  return Math.min(ROAD_MAX_LENGTH, Math.max(ROAD_MIN_LENGTH, n))
}

/** Deterministic hash in [0, 1). */
const hash = (i: number, salt: number): number => {
  const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const BUILDING_GREYS = [0x83838b, 0x8c8c94, 0x7a7a82, 0x92929a]
const STOREFRONT = 0x50505a
const WINDOWS = 0x5c6370

/** A building with its bands round it: a storefront band at street level (front row) and a window row every 3.5 m. */
function building(out: RoadBox[], b: { x: number; z: number; w: number; h: number; d: number; color: number }, storefront: boolean): void {
  const group = out.length
  out.push({ part: 'building', x: b.x, y: b.h / 2, z: b.z, w: b.w, h: b.h, d: b.d, color: b.color, group })
  const band = (y: number, h: number, color: number, o: number): void => {
    out.push({ part: 'building', x: b.x, y, z: b.z, w: b.w + 2 * o, h, d: b.d + 2 * o, color, group })
  }
  if (storefront) band(1.75, 3.5, STOREFRONT, 0.15)
  for (let y = storefront ? 5.5 : 3; y + 1.2 <= b.h - 1; y += 3.5) band(y + 0.6, 1.2, WINDOWS, 0.05)
}

/** One row of buildings on one side, between `x0` and `x1` (|x|), along the whole street. */
function row(out: RoadBox[], side: number, x0: number, x1: number, half: number, front: boolean): void {
  const salt = (front ? 1 : 3) + (side > 0 ? 0 : 1)
  let z = -half
  for (let i = 0; z < half - 1e-6; i++) {
    const width = Math.min(half - z, (front ? 10 : 12) + (front ? 8 : 10) * hash(i, salt))
    const height = front ? 9 + 19 * hash(i, salt + 10) : 16 + 20 * hash(i, salt + 10)
    const color = BUILDING_GREYS[Math.floor(hash(i, salt + 20) * BUILDING_GREYS.length)]!
    building(out, { x: (side * (x0 + x1)) / 2, z: z + width / 2, w: x1 - x0, h: height, d: width, color }, front)
    // The front row has an alley now and then (its back row closes it).
    z += width + (front && hash(i, salt + 30) > 0.72 ? 3 : 0)
  }
}

/** The boxes of an open road with `length` m of drivable asphalt (clamped). */
export function roadLayout(length: number): RoadBox[] {
  const L = Math.min(ROAD_MAX_LENGTH, Math.max(ROAD_MIN_LENGTH, length))
  const half = L / 2 + ROAD_END
  const out: RoadBox[] = []
  out.push({ part: 'ground', x: 0, y: LIFT, z: 0, w: 2 * OUTER, h: 0, d: 2 * (half + 14), color: 0x6e6e74 })
  out.push({ part: 'asphalt', x: 0, y: 0.011 + LIFT, z: 0, w: 2 * ROAD_KERB, h: 0.02, d: 2 * half, color: 0x53545c })
  for (const side of [-1, 1]) out.push({ part: 'sidewalk', x: (side * (ROAD_KERB + ROAD_WALK)) / 2, y: 0.075 + LIFT, z: 0, w: ROAD_WALK - ROAD_KERB, h: 0.15, d: 2 * half, color: 0x9a9aa2 })
  // A yellow centre dash every 4 m, a white lane dash every 9 m between each lane pair.
  for (let z = -half + 2; z + 1.5 <= half - 2; z += 4) out.push({ part: 'dash', x: 0, y: 0.026 + LIFT, z: z + 0.75, w: 0.15, h: 0.02, d: 1.5, color: 0xd0d060 })
  for (const x of [-ROAD_KERB / 2, ROAD_KERB / 2])
    for (let z = -half + 2; z + 3 <= half - 2; z += 9) out.push({ part: 'dash', x, y: 0.026 + LIFT, z: z + 1.5, w: 0.15, h: 0.02, d: 3, color: 0xdadada })
  // Lamp posts at the kerb, every LAMP_STEP m each side, staggered; the arm reaches over the road.
  for (const side of [-1, 1])
    for (let z = -half + (side < 0 ? LAMP_STEP / 2 : LAMP_STEP); z <= half - 2; z += LAMP_STEP) {
      const px = side * (ROAD_KERB + 0.5)
      const group = out.length + 1
      out.push({ part: 'pole', x: px, y: 3.5 + LIFT, z, w: 0.22, h: 7, d: 0.22, color: 0x55555f })
      out.push({ part: 'lamp', x: px - side * 0.9, y: 6.95 + LIFT, z, w: 1.8, h: 0.12, d: 0.16, color: 0x55555f, group })
      out.push({ part: 'lamp', x: px - side * 1.6, y: 6.83 + LIFT, z, w: 0.55, h: 0.14, d: 0.34, color: 0xd8d8c8, group })
    }
  for (const side of [-1, 1]) {
    row(out, side, ROAD_WALK, 21, half, true)
    row(out, side, 23, OUTER, half, false)
  }
  // The end blocks close the street's vista.
  for (const end of [-1, 1]) building(out, { x: 0, z: end * (half + 7), w: 2 * OUTER, h: 26, d: 14, color: 0x86868e }, true)
  return out
}

export interface RoadPlace {
  x: number
  z: number
  /** The entity's rotationY: the road runs along its heading (forward = (−sin h, −cos h)). */
  heading: number
  /** Drivable length (m). */
  length: number
}

const forwardOf = (h: number): { x: number; z: number } => ({ x: -Math.sin(h), z: -Math.cos(h) })
const rightOf = (h: number): { x: number; z: number } => ({ x: Math.cos(h), z: -Math.sin(h) })

/** A point's place on a road: across (+ to its right) and along (+ forward) from its centre. */
export function roadLocal(road: { x: number; z: number; heading: number }, p: { x: number; z: number }): { across: number; along: number } {
  const d = { x: p.x - road.x, z: p.z - road.z }
  const f = forwardOf(road.heading)
  const r = rightOf(road.heading)
  return { across: d.x * r.x + d.z * r.z, along: d.x * f.x + d.z * f.z }
}

/** The world point at (across, along) on a road. */
export function roadWorld(road: { x: number; z: number; heading: number }, across: number, along: number): { x: number; z: number } {
  const f = forwardOf(road.heading)
  const r = rightOf(road.heading)
  return { x: road.x + r.x * across + f.x * along, z: road.z + r.z * across + f.z * along }
}

/** The road along `heading` through `origin` from `from` to `to` m along it (forward positive). */
export function roadSpan(origin: { x: number; z: number }, heading: number, from: number, to: number): RoadPlace {
  const mid = roadWorld({ ...origin, heading }, 0, (from + to) / 2)
  return { x: mid.x, z: mid.z, heading, length: Math.max(ROAD_MIN_LENGTH, to - from) }
}

/** Whether a point is on a road's street (asphalt or sidewalk, the end blocks' apron included). */
export function onRoad(road: RoadPlace, p: { x: number; z: number }): boolean {
  const l = roadLocal(road, p)
  return Math.abs(l.across) <= ROAD_WALK && Math.abs(l.along) <= road.length / 2 + ROAD_END
}
