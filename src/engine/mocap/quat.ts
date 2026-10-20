/**
 * Quaternion and vector helpers for the mocap body kind (fork addition; see
 * MODIFICATIONS.md). Quaternions are [x, y, z, w], as three.js stores them;
 * rotation matrices are row-major 3×3, as `skeleton.ts` uses them.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { M3 } from '../skeleton'
import type { V3 } from '../types'

export type Quat = [number, number, number, number]

export const QI: Quat = [0, 0, 0, 1]

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z })
export const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const vscale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })
export const vdot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const vlen = (a: V3): number => Math.hypot(a.x, a.y, a.z)

/** a · b (b first, then a). */
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ]
}

export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** Rotate a vector. */
export function qrot(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q
  const tx = 2 * (y * v.z - z * v.y)
  const ty = 2 * (z * v.x - x * v.z)
  const tz = 2 * (x * v.y - y * v.x)
  return { x: v.x + w * tx + y * tz - z * ty, y: v.y + w * ty + z * tx - x * tz, z: v.z + w * tz + x * ty - y * tx }
}

/** three.js Euler 'XYZ' (R = Rx · Ry · Rz), as `skeleton.ts` `euler`. */
export function qeuler(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2)
  const c2 = Math.cos(y / 2)
  const c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2)
  const s2 = Math.sin(y / 2)
  const s3 = Math.sin(z / 2)
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]
}

/** q raised to t (the same axis, t times the angle; the shorter arc). */
export function qpow(q: Quat, t: number): Quat {
  const s = q[3] < 0 ? -1 : 1
  const w = Math.min(1, s * q[3])
  const half = Math.acos(w)
  const sin = Math.sin(half)
  if (sin < 1e-12) return QI
  const k = (s * Math.sin(half * t)) / sin
  return [q[0] * k, q[1] * k, q[2] * k, Math.cos(half * t)]
}

/** The smallest rotation taking direction `from` onto direction `to`. */
export function qswing(from: V3, to: V3): Quat {
  const a = vscale(from, 1 / (vlen(from) || 1))
  const b = vscale(to, 1 / (vlen(to) || 1))
  const d = vdot(a, b)
  if (d < -1 + 1e-12) {
    // Opposite: half a turn about any axis square to `a`.
    const axis = Math.abs(a.x) < 0.9 ? v3(0, -a.z, a.y) : v3(a.z, 0, -a.x)
    const n = vlen(axis)
    return [axis.x / n, axis.y / n, axis.z / n, 0]
  }
  return qnorm([a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, 1 + d])
}

/** Row-major rotation matrix of a unit quaternion. */
export function qtoM3(q: Quat): M3 {
  const [x, y, z, w] = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ]
}
