// Modified in this fork (2026): leg-end curve handles (PathHandles); see MODIFICATIONS.md.
/**
 * Paths between marks: centripetal Catmull-Rom through
 * [previous mark, ...via points, next mark], arc-length parameterized so
 * easing maps to real distance, not parameter space.
 */

import type { V3 } from './types'

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z }
}

export function dist(a: V3, b: V3): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

/**
 * Heading (yaw) of a horizontal direction. Convention: heading 0 faces -Z
 * and an object built facing -Z faces the heading when rotation.y = heading
 * (matches three.js Y-rotation: forward(θ) = (-sinθ, 0, -cosθ)).
 */
export function headingOf(dir: V3): number {
  return Math.atan2(-dir.x, -dir.z)
}

interface Segment {
  p0: V3
  p1: V3
  p2: V3
  p3: V3
}

function catmullRom(seg: Segment, t: number): V3 {
  // Centripetal parameterization (alpha = 0.5) avoids cusps/self-loops.
  const alpha = 0.5
  const { p0, p1, p2, p3 } = seg
  const d01 = Math.pow(Math.max(dist(p0, p1), 1e-6), alpha)
  const d12 = Math.pow(Math.max(dist(p1, p2), 1e-6), alpha)
  const d23 = Math.pow(Math.max(dist(p2, p3), 1e-6), alpha)

  const t0 = 0
  const t1 = t0 + d01
  const t2 = t1 + d12
  const t3 = t2 + d23
  const tt = t1 + (t2 - t1) * t

  const lerpV = (a: V3, b: V3, ta: number, tb: number, tv: number): V3 => {
    if (Math.abs(tb - ta) < 1e-9) return a
    const u = (tv - ta) / (tb - ta)
    return {
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      z: a.z + (b.z - a.z) * u
    }
  }

  const a1 = lerpV(p0, p1, t0, t1, tt)
  const a2 = lerpV(p1, p2, t1, t2, tt)
  const a3 = lerpV(p2, p3, t2, t3, tt)
  const b1 = lerpV(a1, a2, t0, t2, tt)
  const b2 = lerpV(a2, a3, t1, t3, tt)
  return lerpV(b1, b2, t1, t2, tt)
}

/**
 * Fork (Lior's test): a centripetal Catmull-Rom segment as a cubic Bezier
 * (the same curve: Barry-Goldman's pyramid is the Hermite with these end
 * tangents), so a mark's handle can replace one end's control point.
 */
function bezierControls(seg: Segment): [V3, V3] {
  const { p0, p1, p2, p3 } = seg
  const d01 = Math.pow(Math.max(dist(p0, p1), 1e-6), 0.5)
  const d12 = Math.pow(Math.max(dist(p1, p2), 1e-6), 0.5)
  const d23 = Math.pow(Math.max(dist(p2, p3), 1e-6), 0.5)
  const tangent = (a: V3, b: V3, c: V3, dab: number, dbc: number): V3 => {
    const k = d12 / 3
    const f = (axis: 'x' | 'y' | 'z'): number =>
      k * ((b[axis] - a[axis]) / dab - (c[axis] - a[axis]) / (dab + dbc) + (c[axis] - b[axis]) / dbc)
    return { x: f('x'), y: f('y'), z: f('z') }
  }
  const m1 = tangent(p0, p1, p2, d01, d12)
  const m2 = tangent(p1, p2, p3, d12, d23)
  return [
    { x: p1.x + m1.x, y: p1.y + m1.y, z: p1.z + m1.z },
    { x: p2.x - m2.x, y: p2.y - m2.y, z: p2.z - m2.z }
  ]
}

function bezier(a: V3, c1: V3, c2: V3, b: V3, t: number): V3 {
  const s = 1 - t
  const w0 = s * s * s
  const w1 = 3 * s * s * t
  const w2 = 3 * s * t * t
  const w3 = t * t * t
  return {
    x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
    y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
    z: w0 * a.z + w1 * c1.z + w2 * c2.z + w3 * b.z
  }
}

/** Fork (Lior's test): the curve handles of a leg's two marks (MarkBase.handle). */
export interface PathHandles {
  /** The departure mark's handle: the leg leaves toward mark + out. */
  out?: V3
  /** The arrival mark's handle: the leg arrives from mark - in. */
  in?: V3
}

/**
 * Fork (Lior's test): the handles a leg's two marks act with when they have
 * none (offsets of the leg's own end control points), where the viewport
 * draws an unset handle.
 */
export function autoHandles(points: V3[]): { out: V3; in: V3 } {
  const pts = points.length >= 2 ? points : [points[0] ?? v3(), points[0] ?? v3()]
  const seg = (i: number): Segment => {
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p0 = pts[i - 1] ?? { x: p1.x + (p1.x - p2.x), y: p1.y + (p1.y - p2.y), z: p1.z + (p1.z - p2.z) }
    const p3 = pts[i + 2] ?? { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y), z: p2.z + (p2.z - p1.z) }
    return { p0, p1, p2, p3 }
  }
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const c1 = bezierControls(seg(0))[0]
  const c2 = bezierControls(seg(pts.length - 2))[1]
  return { out: sub(c1, first), in: sub(last, c2) }
}

export class Path {
  private points: V3[]
  private samples: V3[] = []
  private cumulative: number[] = []
  readonly length: number

  /**
   * @param points ordered control points the path passes through
   *               (departure mark, via…, arrival mark)
   * @param handles  fork: curve handles at the departure / arrival mark
   */
  constructor(points: V3[], samplesPerSegment = 32, handles: PathHandles = {}) {
    this.points = points.length >= 2 ? points : [points[0] ?? v3(), points[0] ?? v3()]
    const pts = this.points
    const segs: Segment[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i]!
      const p2 = pts[i + 1]!
      const p0 = pts[i - 1] ?? { x: p1.x + (p1.x - p2.x), y: p1.y + (p1.y - p2.y), z: p1.z + (p1.z - p2.z) }
      const p3 = pts[i + 2] ?? { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y), z: p2.z + (p2.z - p1.z) }
      segs.push({ p0, p1, p2, p3 })
    }

    // Dense sampling → arc-length table.
    let acc = 0
    let prev: V3 | null = null
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s]!
      const from = s === 0 ? 0 : 1 // avoid duplicating shared endpoints
      // Fork: a handle replaces its end's control point; a segment without one is upstream's.
      const out = s === 0 ? handles.out : undefined
      const into = s === segs.length - 1 ? handles.in : undefined
      let controls: [V3, V3] | null = null
      if (out || into) {
        controls = bezierControls(seg)
        if (out) controls[0] = { x: seg.p1.x + out.x, y: seg.p1.y + out.y, z: seg.p1.z + out.z }
        if (into) controls[1] = { x: seg.p2.x - into.x, y: seg.p2.y - into.y, z: seg.p2.z - into.z }
      }
      for (let k = from; k <= samplesPerSegment; k++) {
        const t = k / samplesPerSegment
        const p = controls ? bezier(seg.p1, controls[0], controls[1], seg.p2, t) : catmullRom(seg, t)
        if (prev) acc += dist(prev, p)
        this.samples.push(p)
        this.cumulative.push(acc)
        prev = p
      }
    }
    this.length = acc
  }

  /** Point at a given distance along the path. */
  pointAt(distance: number): V3 {
    const d = Math.min(this.length, Math.max(0, distance))
    const cum = this.cumulative
    // binary search
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! < d) lo = mid + 1
      else hi = mid
    }
    const i = Math.max(1, lo)
    const d0 = cum[i - 1]!
    const d1 = cum[i]!
    const p0 = this.samples[i - 1]!
    const p1 = this.samples[i]!
    const u = d1 - d0 < 1e-9 ? 0 : (d - d0) / (d1 - d0)
    return {
      x: p0.x + (p1.x - p0.x) * u,
      y: p0.y + (p1.y - p0.y) * u,
      z: p0.z + (p1.z - p0.z) * u
    }
  }

  /** Travel heading at a distance (yaw of the tangent). */
  headingAt(distance: number): number {
    const eps = Math.max(this.length * 0.001, 0.01)
    const a = this.pointAt(Math.max(0, distance - eps))
    const b = this.pointAt(Math.min(this.length, distance + eps))
    const d = sub(b, a)
    if (Math.abs(d.x) < 1e-9 && Math.abs(d.z) < 1e-9) return 0
    return headingOf(d)
  }

  /** Dense polyline for rendering the path in the viewport / diagrams. */
  polyline(): V3[] {
    return this.samples
  }
}
