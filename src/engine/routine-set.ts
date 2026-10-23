/**
 * Routines on the set (fork addition, set-routines; see MODIFICATIONS.md).
 * The Choreographer's chase ran its serpentine wherever the editor camera
 * pointed, through buildings and off the kit's tile, and a dance stood where
 * it was clicked even half inside a wall. Here the set comes in as data (read
 * off the built kit in `renderer/routine-set.ts`): the floor a performer
 * stands on, the solid footprints a body can't pass, and the streets.
 *
 * - `clearance` is how far a point is from the nearest solid and from the
 *   floor's edge; a performer's root keeps ROUTE_CLEAR (hips, arm swing, the
 *   weave's slack).
 * - `chaseRoute` lays a chase along the street nearest the click (else the
 *   longest clear straight run through it), the routine's own travel
 *   direction breaking ties. The runner starts at the click while the room
 *   ahead holds the run; otherwise the route slides back along the run. When
 *   a straight run can't hold the chase at a running pace it turns at the
 *   end (straight runs, at most 100° a corner, the longest next run first,
 *   SELF_GAP from its own earlier stretches: a lap, never back through
 *   itself). Corners are rounded inside the clear space and the caller's
 *   weave rides on top, cut back wherever it would leave it (on a street,
 *   it stays on the street).
 * - `fitGroup` moves a routine that stands in one place (a dance, a ring
 *   fight) to the nearest spot where every slot and walk between slots is
 *   clear, turning it only if no shift fits.
 *
 * A box's heading follows the entity convention, as `fight/obstacles.ts`:
 * local (u, v) → world (x, z) = (u cos h + v sin h, −u sin h + v cos h).
 *
 * PURE: no DOM / three.js / Electron, no randomness.
 */

export interface SetRect {
  x: number
  z: number
  /** Half extents along the box's local X and Z (m). */
  hx: number
  hz: number
  heading: number
}

export interface SetSolid extends SetRect {
  /** How warnings name it, e.g. "a Downtown building at (11.0, −12.0)". */
  name: string
}

export interface RoutineSet {
  /** Walkable floor (a kit's ground, its street and kerbs): performers stay on it. None: open ground everywhere. */
  floors: SetRect[]
  /** Footprints a body can't pass (walls, buildings, glass, props) in the body's height band. */
  solids: SetSolid[]
  /** Long flat strips a chase runs along (a street's asphalt, an alley's ground). */
  streets: SetRect[]
  /** How warnings name the set ("the Alley"). */
  name?: string
}

type XZ = { x: number; z: number }

/** A performer's root keeps this far from a solid and from the floor's edge (m). */
export const ROUTE_CLEAR = 0.6
/** A lap keeps this far from its own earlier stretches (m). */
const SELF_GAP = 3
/** A street counts when it is within this of the click (m). */
const STREET_NEAR = 8
/** Off a street, a chase starts from the most open spot this near the click (m). */
const OPEN_NEAR = 3
/** The sharpest corner a chase takes (degrees). */
const MAX_TURN = 100
/** How far a group may move to fit (m). */
const MAX_SHIFT = 8

const sub = (a: XZ, b: XZ): XZ => ({ x: a.x - b.x, z: a.z - b.z })
const add = (a: XZ, b: XZ, k = 1): XZ => ({ x: a.x + b.x * k, z: a.z + b.z * k })
const dot = (a: XZ, b: XZ): number => a.x * b.x + a.z * b.z
const len = (a: XZ): number => Math.hypot(a.x, a.z)
const rotate = (d: XZ, rad: number): XZ => ({ x: d.x * Math.cos(rad) + d.z * Math.sin(rad), z: -d.x * Math.sin(rad) + d.z * Math.cos(rad) })
const forwardOf = (heading: number): XZ => ({ x: -Math.sin(heading), z: -Math.cos(heading) })

/** True when there is a set to respect (any floor or solid). */
export const isSet = (set: RoutineSet | undefined): set is RoutineSet => !!set && (set.floors.length > 0 || set.solids.length > 0)

function toLocal(r: SetRect, p: XZ): XZ {
  const dx = p.x - r.x
  const dz = p.z - r.z
  const c = Math.cos(r.heading)
  const s = Math.sin(r.heading)
  return { x: dx * c - dz * s, z: dx * s + dz * c }
}

/** Distance from a point to a box (0 inside). */
export function rectDistance(r: SetRect, p: XZ): number {
  const l = toLocal(r, p)
  return Math.hypot(Math.max(0, Math.abs(l.x) - r.hx), Math.max(0, Math.abs(l.z) - r.hz))
}

/** How deep a point is inside a box (distance to its nearest edge; ≤ 0 outside). */
function insideDepth(r: SetRect, p: XZ): number {
  const l = toLocal(r, p)
  const ex = r.hx - Math.abs(l.x)
  const ez = r.hz - Math.abs(l.z)
  return ex > 0 && ez > 0 ? Math.min(ex, ez) : -Math.hypot(Math.max(0, -ex), Math.max(0, -ez))
}

/** Whether a point stands on the set's floor (anywhere when it has none). */
export function onFloor(set: RoutineSet, p: XZ): boolean {
  return set.floors.length === 0 || set.floors.some((f) => insideDepth(f, p) > 0)
}

/** The solid a point stands in, if any. */
export function solidAt(set: RoutineSet, p: XZ): SetSolid | undefined {
  return set.solids.find((s) => rectDistance(s, p) === 0)
}

/** How far a point is from the nearest solid and from the floor's edge (0 inside a solid or off the floor). */
export function clearance(set: RoutineSet, p: XZ): number {
  let d = Infinity
  for (const s of set.solids) {
    const q = rectDistance(s, p)
    if (q < d) d = q
  }
  if (set.floors.length > 0) {
    let depth = -Infinity
    for (const f of set.floors) depth = Math.max(depth, insideDepth(f, p))
    d = Math.min(d, Math.max(0, depth))
  }
  return d
}

/** How far from `p` along unit `u` the root stays clear (up to `max`), stopping where `avoid` says. */
function runLength(set: RoutineSet, p: XZ, u: XZ, max: number, avoid?: (q: XZ) => boolean): number {
  const step = 0.1
  let s = 0
  while (s + step <= max + 1e-9) {
    const q = add(p, u, s + step)
    if (clearance(set, q) < ROUTE_CLEAR || avoid?.(q)) break
    s += step
  }
  return s
}

/** The nearest clear point to `p` (rings every 0.25 m up to `max`), or null. */
function nearestClear(set: RoutineSet, p: XZ, max = 12): XZ | null {
  if (clearance(set, p) >= ROUTE_CLEAR) return p
  for (let r = 0.25; r <= max + 1e-9; r += 0.25) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.25))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const q = { x: p.x + Math.sin(a) * r, z: p.z + Math.cos(a) * r }
      if (clearance(set, q) >= ROUTE_CLEAR) return q
    }
  }
  return null
}

/** A street's long axis (world, unit) and half length / width. */
function streetAxis(r: SetRect): { u: XZ; half: number; halfW: number } {
  return r.hz >= r.hx
    ? { u: { x: Math.sin(r.heading), z: Math.cos(r.heading) }, half: r.hz, halfW: r.hx }
    : { u: { x: Math.cos(r.heading), z: -Math.sin(r.heading) }, half: r.hx, halfW: r.hz }
}

/** Distance from a point to segment a–b. */
function segDistance(p: XZ, a: XZ, b: XZ): number {
  const ab = sub(b, a)
  const k = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-12, dot(ab, ab))))
  return len(sub(p, add(a, ab, k)))
}

/* ------------------------------- chases -------------------------------- */

export interface RouteNeed {
  /** Room behind the runner's start (the pursuers' lead-in), m. */
  back: number
  /** Route wanted ahead of the runner's start (the routine's own pace), m. */
  ahead: number
  /** The least route ahead that still makes a running pace, m. */
  aheadMin: number
}

export interface ChaseRoute {
  /** The route, from the lead-in's start to its end (every ~0.25 m). */
  pts: XZ[]
  /** Arc distance of the runner's start along `pts`. */
  start: number
  /** Route length from the runner's start to the end. */
  ahead: number
  /** Corners the route turns. */
  turns: number
  /** It runs along a street. */
  street: boolean
}

/**
 * A chase route on the set from `origin` (its heading faces back along the
 * routine's travel, as upstream's serpentine runs), long enough for `need`
 * where the set allows. `lateral(s)` is the weave wanted at arc s from the
 * runner's start. Null when no clear spot is near the click.
 */
export function chaseRoute(set: RoutineSet, origin: { x: number; z: number; heading: number }, need: RouteNeed, lateral: (s: number) => number): ChaseRoute | null {
  const travel = { x: -forwardOf(origin.heading).x, z: -forwardOf(origin.heading).z }
  const cap = need.back + need.ahead + 4
  // The first run: along the nearest street, else the longest clear line through the click.
  let street: { r: SetRect; u: XZ; half: number; halfW: number } | null = null
  for (const r of set.streets) {
    const d = rectDistance(r, origin)
    if (d > STREET_NEAR) continue
    const s = { r, ...streetAxis(r) }
    if (!street || d < rectDistance(street.r, origin) - 1e-6) street = s
  }
  let anchor: XZ | null
  let axis: XZ
  if (street) {
    const u = street.u
    axis = dot(u, travel) < 0 ? { x: -u.x, z: -u.z } : u
    const c = { x: street.r.x, z: street.r.z }
    const n = { x: u.z, z: -u.x }
    const along = Math.max(-street.half, Math.min(street.half, dot(sub(origin, c), u)))
    // Lanes across the street every 0.25 m, each from the click's spot along it (slid to the nearest clear
    // spot on the lane): the longest clear run; about equal, the lane nearest the street's middle.
    const halfLane = Math.max(0, street.halfW - ROUTE_CLEAR)
    let best: { p: XZ; l: number; off: number } | null = null
    for (let o = -halfLane; o <= halfLane + 1e-9; o += 0.25) {
      const on = add(add(c, u, along), n, o)
      let p: XZ | null = null
      for (let k = 0; k <= 4 * street.half && !p; k++)
        for (const q of k ? [add(on, u, -k * 0.25), add(on, u, k * 0.25)] : [on])
          if (Math.abs(dot(sub(q, c), u)) <= street.half && clearance(set, q) >= ROUTE_CLEAR) {
            p = q
            break
          }
      if (!p) continue
      const l = runLength(set, p, axis, cap) + runLength(set, p, { x: -axis.x, z: -axis.z }, cap)
      if (!best || l > best.l + 0.5 || (Math.abs(l - best.l) <= 0.5 && Math.abs(o) < Math.abs(best.off))) best = { p, l, off: o }
    }
    anchor = best?.p ?? nearestClear(set, add(c, u, along))
  }
  else {
    // Off a street, start from the most open spot within OPEN_NEAR of the click (a chase along a wall has no room for a camera).
    let open: { p: XZ; score: number } | null = null
    for (let i = -OPEN_NEAR; i <= OPEN_NEAR + 1e-9; i += 0.5)
      for (let j = -OPEN_NEAR; j <= OPEN_NEAR + 1e-9; j += 0.5) {
        const d = Math.hypot(i, j)
        if (d > OPEN_NEAR + 1e-9) continue
        const p = { x: origin.x + i, z: origin.z + j }
        const c = clearance(set, p)
        const score = Math.min(c, OPEN_NEAR) - 0.4 * d
        if (c >= ROUTE_CLEAR && (!open || score > open.score + 1e-9)) open = { p, score }
      }
    anchor = open?.p ?? nearestClear(set, origin)
    axis = travel
    if (anchor) {
      // The longest clear line through the anchor; within 10 % of it, the one nearest the travel direction.
      const lines: { u: XZ; l: number; off: number }[] = []
      for (let deg = 0; deg < 180; deg += 5) {
        const u = rotate(travel, (deg * Math.PI) / 180)
        lines.push({ u, l: runLength(set, anchor, u, cap) + runLength(set, anchor, { x: -u.x, z: -u.z }, cap), off: Math.min(deg, 180 - deg) })
      }
      const longest = Math.max(...lines.map((c) => c.l))
      const pick = lines.filter((c) => c.l >= longest * 0.9).sort((a, b) => a.off - b.off)[0]!
      axis = dot(pick.u, travel) < 0 ? { x: -pick.u.x, z: -pick.u.z } : pick.u
    }
  }
  if (!anchor) return null
  // The straight run through the anchor; the runner starts at it while the room ahead holds the run.
  const bR = runLength(set, anchor, { x: -axis.x, z: -axis.z }, cap)
  const fR = runLength(set, anchor, axis, cap)
  let s0 = Math.max(need.back - bR, Math.min(0, fR - need.ahead))
  if (s0 > fR) s0 = fR
  const leadIn = add(anchor, axis, Math.max(-bR, s0 - need.back))
  const corners: XZ[] = [leadIn, add(anchor, axis, fR)]
  let ahead = fR - s0
  // Laps: when the straight run can't hold a running pace, turn at its end.
  if (ahead < need.aheadMin) {
    let dir = axis
    let turnSide = 0
    for (let turn = 0; turn < 8 && ahead < need.ahead; turn++) {
      const p = corners[corners.length - 1]!
      const earlier = corners.slice(0, -1)
      const avoid = (q: XZ): boolean => {
        for (let i = 1; i < earlier.length; i++) if (segDistance(q, earlier[i - 1]!, earlier[i]!) < SELF_GAP) return true
        return false
      }
      let best: { d: XZ; l: number; deg: number } | null = null
      // Longest first; about equal: keep turning the same way (a lap), then the gentler turn.
      const better = (c: { l: number; deg: number }, b: { l: number; deg: number } | null): boolean => {
        if (!b) return true
        if (Math.abs(c.l - b.l) > 0.5) return c.l > b.l
        const cs = Math.sign(c.deg) === turnSide ? 1 : 0
        const bs = Math.sign(b.deg) === turnSide ? 1 : 0
        return cs !== bs ? cs > bs : Math.abs(c.deg) < Math.abs(b.deg)
      }
      for (let deg = 20; deg <= MAX_TURN; deg += 10)
        for (const side of [1, -1]) {
          const d = rotate(dir, (side * deg * Math.PI) / 180)
          const l = runLength(set, p, d, need.ahead - ahead + 4, avoid)
          if (l >= 2 && better({ l, deg: side * deg }, best)) best = { d, l, deg: side * deg }
        }
      if (!best) break
      corners.push(add(p, best.d, best.l))
      dir = best.d
      turnSide ||= Math.sign(best.deg)
      ahead += best.l
    }
  }
  // Round the corners inside the clear space, then sample the route.
  const base = filleted(set, corners)
  const startArc = Math.min(need.back, bR + s0)
  // Weave: the caller's lateral offset, none near a corner, cut back where it would leave the clear space (or the street).
  const n = base.pts.length
  const tangent = (i: number): XZ => {
    const a = base.pts[Math.max(0, i - 1)]!
    const b = base.pts[Math.min(n - 1, i + 1)]!
    const d = sub(b, a)
    const l = Math.max(1e-9, len(d))
    return { x: d.x / l, z: d.z / l }
  }
  const nearCorner = (s: number): number => Math.min(Infinity, ...base.bends.map(([a, b]) => (s < a ? a - s : s > b ? s - b : 0)))
  const taper = (s: number): number => {
    const d = nearCorner(s)
    const u = Math.max(0, Math.min(1, (d - 1) / 3))
    return u * u * (3 - 2 * u)
  }
  const inStreet = (q: XZ): boolean => {
    if (!street) return true
    const l = dot(sub(q, { x: street.r.x, z: street.r.z }), { x: street.u.z, z: -street.u.x })
    return Math.abs(l) <= street.halfW - ROUTE_CLEAR + 1e-9
  }
  const ok = (q: XZ, onStreet: boolean): boolean => clearance(set, q) >= ROUTE_CLEAR && (!onStreet || inStreet(q))
  const normals = base.pts.map((_, i) => {
    const t = tangent(i)
    return { x: t.z, z: -t.x }
  })
  const onStreetAt = base.pts.map((p) => inStreet(p))
  const fit = (w: number[]): number[] =>
    w.map((v, i) => {
      let k = v
      for (let j = 0; j < 12 && Math.abs(k) > 0.02 && !ok(add(base.pts[i]!, normals[i]!, k), onStreetAt[i]!); j++) k *= 0.75
      return Math.abs(k) <= 0.02 || !ok(add(base.pts[i]!, normals[i]!, k), onStreetAt[i]!) ? 0 : k
    })
  let w = fit(base.arcs.map((a) => lateral(a - startArc) * taper(a)))
  for (let pass = 0; pass < 2; pass++) {
    const k = 8
    w = fit(w.map((_, i) => {
      let s = 0
      let c = 0
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) {
        s += w[j]!
        c++
      }
      return s / c
    }))
  }
  const pts = base.pts.map((p, i) => add(p, normals[i]!, w[i]!))
  // Arcs on the woven route.
  const arcs: number[] = [0]
  for (let i = 1; i < pts.length; i++) arcs.push(arcs[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)))
  const at = (a: number): number => {
    let i = 1
    while (i < base.arcs.length - 1 && base.arcs[i]! < a) i++
    const f = (a - base.arcs[i - 1]!) / Math.max(1e-9, base.arcs[i]! - base.arcs[i - 1]!)
    return arcs[i - 1]! + (arcs[i]! - arcs[i - 1]!) * Math.max(0, Math.min(1, f))
  }
  const start = at(startArc)
  return { pts, start, ahead: arcs[arcs.length - 1]! - start, turns: corners.length - 2, street: !!street }
}

/**
 * A polyline through `corners` with its corners rounded (radius ≤ 2 m, smaller
 * where the arc would leave the clear space), sampled every ~0.25 m, with the
 * arc ranges of the bends.
 */
function filleted(set: RoutineSet, corners: XZ[]): { pts: XZ[]; arcs: number[]; bends: [number, number][] } {
  const pts: XZ[] = [corners[0]!]
  const arcs: number[] = [0]
  const bends: [number, number][] = []
  const push = (p: XZ): void => {
    const last = pts[pts.length - 1]!
    const d = len(sub(p, last))
    if (d < 1e-6) return
    pts.push(p)
    arcs.push(arcs[arcs.length - 1]! + d)
  }
  const line = (a: XZ, b: XZ): void => {
    const d = len(sub(b, a))
    const k = Math.max(1, Math.ceil(d / 0.25))
    for (let i = 1; i <= k; i++) push(add(a, sub(b, a), i / k))
  }
  let cursor = corners[0]!
  for (let i = 1; i < corners.length - 1; i++) {
    const p = corners[i]!
    const a = sub(cursor, p)
    const b = sub(corners[i + 1]!, p)
    const la = len(a)
    const lb = len(b)
    const ua = { x: a.x / la, z: a.z / la }
    const ub = { x: b.x / lb, z: b.z / lb }
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(ua, ub))))
    const tanHalf = Math.tan(theta / 2)
    // The arc's tangent points sit r / tan(θ/2) from the corner.
    let r = Math.min(2, (0.45 * Math.min(la, lb)) * tanHalf)
    let arc: XZ[] = []
    for (; r >= 0.3; r *= 0.7) {
      const t = r / Math.max(1e-6, tanHalf)
      const pa = add(p, ua, t)
      const pb = add(p, ub, t)
      const bis = { x: ua.x + ub.x, z: ua.z + ub.z }
      const bl = Math.max(1e-9, len(bis))
      const c = add(p, { x: bis.x / bl, z: bis.z / bl }, r / Math.max(1e-6, Math.sin(theta / 2)))
      const a0 = Math.atan2(pa.x - c.x, pa.z - c.z)
      let a1 = Math.atan2(pb.x - c.x, pb.z - c.z)
      while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI
      while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI
      const k = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / 0.25))
      arc = Array.from({ length: k + 1 }, (_, j) => {
        const ang = a0 + ((a1 - a0) * j) / k
        return { x: c.x + Math.sin(ang) * r, z: c.z + Math.cos(ang) * r }
      })
      if (arc.every((q) => clearance(set, q) >= ROUTE_CLEAR * 0.9)) break
      arc = []
    }
    if (arc.length === 0) {
      line(cursor, p)
      bends.push([arcs[arcs.length - 1]!, arcs[arcs.length - 1]!])
      cursor = p
      continue
    }
    line(cursor, arc[0]!)
    const b0 = arcs[arcs.length - 1]!
    for (const q of arc.slice(1)) push(q)
    bends.push([b0, arcs[arcs.length - 1]!])
    cursor = arc[arc.length - 1]!
  }
  line(cursor, corners[corners.length - 1]!)
  return { pts, arcs, bends }
}

/* ------------------------------- groups -------------------------------- */

export interface GroupLayout {
  /** Spots the performers stand on, local (right, forward) to the routine's origin. */
  slots: XZ[]
  /** Straight walks between spots (formation changes), local. */
  walks: [XZ, XZ][]
}

export interface GroupFit {
  origin: { x: number; z: number; heading: number }
  /** How far it moved (m) and turned (degrees). */
  moved: number
  turnedDeg: number
  /** Everything clear. */
  fits: boolean
}

/** Local (right, forward) → world, as choreography's `place`. */
function placeAt(o: { x: number; z: number; heading: number }, l: XZ): XZ {
  const c = Math.cos(o.heading)
  const s = Math.sin(o.heading)
  return { x: o.x + l.x * c - l.z * s, z: o.z - l.x * s - l.z * c }
}

/**
 * The nearest origin (shift first, up to MAX_SHIFT, then a turn in 15° steps)
 * where every slot and every walk of `layout` keeps ROUTE_CLEAR.
 */
export function fitGroup(set: RoutineSet, origin: { x: number; z: number; heading: number }, layout: GroupLayout): GroupFit {
  const pts: XZ[] = [...layout.slots]
  for (const [a, b] of layout.walks) {
    const d = len(sub(b, a))
    const k = Math.max(1, Math.ceil(d / 0.3))
    for (let i = 1; i < k; i++) pts.push(add(a, sub(b, a), i / k))
  }
  const reach = Math.max(0, ...pts.map(len))
  // A clearance grid around the origin (0.25 m), read conservatively.
  const CELL = 0.25
  const ext = MAX_SHIFT + reach + 1
  const nx = Math.ceil((2 * ext) / CELL) + 1
  const grid = new Float32Array(nx * nx)
  for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = clearance(set, { x: origin.x - ext + i * CELL, z: origin.z - ext + j * CELL })
  const clearAt = (p: XZ): number => {
    const i = Math.round((p.x - origin.x + ext) / CELL)
    const j = Math.round((p.z - origin.z + ext) / CELL)
    if (i < 0 || j < 0 || i >= nx || j >= nx) return clearance(set, p)
    return grid[j * nx + i]! - CELL * 0.71
  }
  const fitsAt = (o: { x: number; z: number; heading: number }): boolean => pts.every((p) => clearAt(placeAt(o, p)) >= ROUTE_CLEAR)
  const turns = [0]
  for (let d = 15; d <= 180; d += 15) turns.push(d, -d)
  for (const deg of turns) {
    if (deg === -180) continue
    const heading = origin.heading + (deg * Math.PI) / 180
    for (let r = 0; r <= MAX_SHIFT + 1e-9; r += 0.25) {
      const n = r === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * r) / 0.35))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const o = { x: origin.x + Math.sin(a) * r, z: origin.z + Math.cos(a) * r, heading }
        if (fitsAt(o)) return { origin: o, moved: r, turnedDeg: deg, fits: true }
      }
    }
  }
  return { origin, moved: 0, turnedDeg: 0, fits: false }
}

/** The nearest solid to a group's spots, for a warning. */
export function nearestSolid(set: RoutineSet, origin: { x: number; z: number; heading: number }, layout: GroupLayout): string {
  let best = Infinity
  let name = set.floors.length ? 'the edge of the floor' : 'the set'
  for (const l of layout.slots) {
    const p = placeAt(origin, l)
    for (const s of set.solids) {
      const d = rectDistance(s, p)
      if (d < best) [best, name] = [d, s.name]
    }
  }
  return name
}
