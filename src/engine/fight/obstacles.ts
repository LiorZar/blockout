/**
 * Set props for the fight solver (fork addition; see MODIFICATIONS.md): the
 * static props of a scene as oriented floor boxes, and the geometry the
 * solver needs around them — how far a fighter can be pushed along a line
 * before it meets one, which stretches of a solved path cross one, and the
 * smallest shift of a whole fight that keeps its paths clear.
 *
 * A box's heading follows the entity convention (`object.rotation.y`): local
 * (u, v) → world (x, z) = (u cos h + v sin h, −u sin h + v cos h).
 *
 * PURE: no DOM / three.js / Electron, no randomness.
 */

export interface FightObstacle {
  /** Entity the prop belongs to (a kit's pieces share their kit's id). */
  entityId: string
  /** How warnings name it, e.g. "Park bench" or "a Gym prop at (0.0, 0.0)". */
  name: string
  x: number
  z: number
  /** Half extents along the box's local X and Z (m). */
  hx: number
  hz: number
  heading: number
}

type XZ = { x: number; z: number }

/** A fighter's root keeps this far from a prop (m): about half a body. */
export const BODY_RADIUS = 0.22
/** Body points (head, chest, pelvis, feet) of a fallen fighter keep this far (m). */
export const LIMB_RADIUS = 0.06

function toLocal(o: FightObstacle, p: XZ): XZ {
  const dx = p.x - o.x
  const dz = p.z - o.z
  const c = Math.cos(o.heading)
  const s = Math.sin(o.heading)
  return { x: dx * c - dz * s, z: dx * s + dz * c }
}

function toWorldDir(o: FightObstacle, d: XZ): XZ {
  const c = Math.cos(o.heading)
  const s = Math.sin(o.heading)
  return { x: d.x * c + d.z * s, z: -d.x * s + d.z * c }
}

/** Distance from a point to a box (0 inside). */
export function boxDistance(o: FightObstacle, p: XZ): number {
  const l = toLocal(o, p)
  return Math.hypot(Math.max(0, Math.abs(l.x) - o.hx), Math.max(0, Math.abs(l.z) - o.hz))
}

/** Parameter range [t0, t1] ⊂ [0, 1] where segment a→b (box-local) is inside the box grown by r, or null. */
function clipSegment(o: FightObstacle, a: XZ, b: XZ, r: number): [number, number] | null {
  const la = toLocal(o, a)
  const lb = toLocal(o, b)
  let t0 = 0
  let t1 = 1
  const slabs: [number, number, number][] = [
    [la.x, lb.x - la.x, o.hx + r],
    [la.z, lb.z - la.z, o.hz + r]
  ]
  for (const [p, d, h] of slabs) {
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(p) > h) return null
      continue
    }
    let e0 = (-h - p) / d
    let e1 = (h - p) / d
    if (e0 > e1) [e0, e1] = [e1, e0]
    t0 = Math.max(t0, e0)
    t1 = Math.min(t1, e1)
    if (t0 > t1) return null
  }
  return [t0, t1]
}

/**
 * How far a fighter at `from` can travel along the unit direction `dir` (up
 * to `want` m) before its body (radius r) meets a prop. A prop it already
 * touches only stops it when the move goes deeper in.
 */
export function clearRun(from: XZ, dir: XZ, want: number, r: number, obstacles: FightObstacle[]): { run: number; hit: FightObstacle | null } {
  let run = want
  let hit: FightObstacle | null = null
  for (const o of obstacles) {
    const to = { x: from.x + dir.x * want, z: from.z + dir.z * want }
    const span = clipSegment(o, from, to, r)
    if (!span) continue
    if (span[0] <= 1e-9) {
      // Already touching: blocked only if the move doesn't lead out of the prop.
      const l = toLocal(o, from)
      const out = toWorldDir(o, {
        x: Math.abs(l.x) - o.hx > Math.abs(l.z) - o.hz ? Math.sign(l.x) : 0,
        z: Math.abs(l.x) - o.hx > Math.abs(l.z) - o.hz ? 0 : Math.sign(l.z)
      })
      if (out.x * dir.x + out.z * dir.z >= 0) continue
    }
    const d = span[0] * want
    if (d < run) {
      run = d
      hit = o
    }
  }
  return { run: Math.max(0, run), hit }
}

/** One sampled moment of a fighter: its root and the body points that can land on things. */
export interface PathSample {
  t: number
  root: XZ
  body: XZ[]
}

export interface ObstacleCrossing {
  fighter: 0 | 1
  obstacle: FightObstacle
  t0: number
  t1: number
}

/** The stretches of two fighters' sampled paths that run into a prop (root within BODY_RADIUS, a body point within LIMB_RADIUS). */
export function pathCrossings(paths: [PathSample[], PathSample[]], obstacles: FightObstacle[], shift: XZ = { x: 0, z: 0 }): ObstacleCrossing[] {
  const out: ObstacleCrossing[] = []
  const at = (p: XZ): XZ => ({ x: p.x + shift.x, z: p.z + shift.z })
  paths.forEach((samples, q) => {
    for (const o of obstacles) {
      let open: ObstacleCrossing | null = null
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!
        const next = samples[i + 1]
        const rootHit =
          boxDistance(o, at(s.root)) < BODY_RADIUS - 1e-6 || (!!next && segmentHits(o, at(s.root), at(next.root), BODY_RADIUS - 1e-6))
        const hit = rootHit || s.body.some((b) => boxDistance(o, at(b)) < LIMB_RADIUS - 1e-6)
        if (hit) {
          if (open) open.t1 = s.t
          else {
            open = { fighter: q as 0 | 1, obstacle: o, t0: s.t, t1: s.t }
            out.push(open)
          }
        }
        else open = null
      }
    }
  })
  return out.sort((a, b) => a.t0 - b.t0)
}

function segmentHits(o: FightObstacle, a: XZ, b: XZ, r: number): boolean {
  // Grown-box clip, then confirm on the rounded corners by distance at the span's ends and middle.
  const span = clipSegment(o, a, b, r)
  if (!span) return false
  for (const u of [span[0], (span[0] + span[1]) / 2, span[1]]) {
    if (boxDistance(o, { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }) < r) return true
  }
  return false
}

/**
 * The smallest shift (rings of `step` m out to `maxShift`, 16 directions per
 * ring, nearest first) that keeps both fighters' paths clear of every prop,
 * or null when none does. {0, 0} when they are already clear.
 */
export function clearShift(paths: [PathSample[], PathSample[]], obstacles: FightObstacle[], maxShift = 3, step = 0.25): XZ | null {
  if (obstacles.length === 0) return { x: 0, z: 0 }
  // Only props near the fight can matter.
  const all = [...paths[0], ...paths[1]].flatMap((s) => [s.root, ...s.body])
  if (all.length === 0) return { x: 0, z: 0 }
  const cx = all.reduce((a, p) => a + p.x, 0) / all.length
  const cz = all.reduce((a, p) => a + p.z, 0) / all.length
  const reach = Math.max(...all.map((p) => Math.hypot(p.x - cx, p.z - cz))) + maxShift + BODY_RADIUS
  const near = obstacles.filter((o) => Math.hypot(o.x - cx, o.z - cz) - Math.hypot(o.hx, o.hz) <= reach)
  if (pathCrossings(paths, near).length === 0) return { x: 0, z: 0 }
  for (let ring = 1; ring * step <= maxShift + 1e-9; ring++) {
    const d = ring * step
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8
      const shift = { x: Math.cos(a) * d, z: Math.sin(a) * d }
      if (pathCrossings(paths, near, shift).length === 0) return shift
    }
  }
  return null
}
