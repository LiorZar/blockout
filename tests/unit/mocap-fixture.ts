// Fork addition (2026): a hand-built mixamorig skeleton for the mocap body tests; see MODIFICATIONS.md.
/**
 * A made-up T-pose skeleton with Mixamo's bone names and hierarchy, and a
 * grey-box surface (boxes, cylinders, an ellipsoid head) on its bones. No
 * Mixamo data: every number here is invented. Entity space: metres, facing
 * −Z, +X the character's right; `fixtureSource` scales it by `k`.
 */

import { qeuler, qmul, qswing, type Quat } from '@engine/mocap/quat'
import type { MocapSource } from '@engine/mocap/rig'
import type { V3 } from '@engine/types'

type BoneDef = [name: string, parent: string | null, x: number, y: number, z: number]

const LEFT: BoneDef[] = [
  ['LeftShoulder', 'Spine2', -0.06, 1.42, 0.035],
  ['LeftArm', 'LeftShoulder', -0.18, 1.42, 0.06],
  ['LeftForeArm', 'LeftArm', -0.46, 1.42, 0.06],
  ['LeftHand', 'LeftForeArm', -0.73, 1.42, 0.06],
  ['LeftHandMiddle1', 'LeftHand', -0.86, 1.42, 0.06],
  ['LeftHandIndex1', 'LeftHand', -0.855, 1.42, 0.03],
  ['LeftUpLeg', 'Hips', -0.09, 0.9, 0],
  ['LeftLeg', 'LeftUpLeg', -0.095, 0.5, 0.005],
  ['LeftFoot', 'LeftLeg', -0.09, 0.09, 0.025],
  ['LeftToeBase', 'LeftFoot', -0.092, 0.03, -0.11],
  ['LeftToe_End', 'LeftToeBase', -0.092, 0.03, -0.2]
]

const mirror = (d: BoneDef): BoneDef => [d[0].replace('Left', 'Right'), d[1]?.replace('Left', 'Right') ?? null, -d[2], d[3], d[4]]

/** Parent-first: the trunk, the left side, the right side. */
export const FIXTURE_BONES: BoneDef[] = [
  ['Hips', null, 0, 0.97, 0],
  ['Spine', 'Hips', 0, 1.07, 0.012],
  ['Spine1', 'Spine', 0, 1.19, 0.02],
  ['Spine2', 'Spine1', 0, 1.32, 0.035],
  ['Neck', 'Spine2', 0, 1.47, 0.03],
  ['Head', 'Neck', 0, 1.57, 0],
  ['HeadTop_End', 'Head', 0, 1.76, -0.05],
  ...LEFT.slice(0, 6),
  ...LEFT.slice(0, 6).map(mirror),
  ...LEFT.slice(6),
  ...LEFT.slice(6).map(mirror)
]

/** Each bone's bind rotation: local +Y toward its first child, twisted a little (Mixamo's bones aren't axis-aligned). */
function bindRotations(): Quat[] {
  return FIXTURE_BONES.map(([name, , x, y, z], i) => {
    const child = FIXTURE_BONES.find((d) => d[1] === name)
    const dir = child ? { x: child[2] - x, y: child[3] - y, z: child[4] - z } : { x: 0, y: 1, z: 0 }
    return qmul(qswing({ x: 0, y: 1, z: 0 }, dir), qeuler(0, 0.2 + 0.05 * i, 0))
  })
}

type Surface = { bone: string; points: V3[] }

function box(bone: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n = 5): Surface {
  const points: V3[] = []
  for (let a = 0; a <= n; a++)
    for (let b = 0; b <= n; b++) {
      const u = a / n
      const v = b / n
      const x = x0 + (x1 - x0) * u
      const y = y0 + (y1 - y0) * v
      const z = z0 + (z1 - z0) * v
      points.push({ x, y, z: z0 }, { x, y, z: z1 }, { x, y: y0, z }, { x, y: y1, z }, { x: x0, y, z: z0 + (z1 - z0) * u }, { x: x1, y, z: z0 + (z1 - z0) * u })
    }
  return { bone, points }
}

/** A cylinder of radius r around the segment a → b. */
function cylinder(bone: string, a: V3, b: V3, r: number): Surface {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const len = Math.hypot(d.x, d.y, d.z)
  const u = { x: d.x / len, y: d.y / len, z: d.z / len }
  const p = Math.abs(u.y) < 0.9 ? { x: u.z, y: 0, z: -u.x } : { x: 1, y: 0, z: 0 }
  const pl = Math.hypot(p.x, p.y, p.z)
  const e1 = { x: p.x / pl, y: p.y / pl, z: p.z / pl }
  const e2 = { x: u.y * e1.z - u.z * e1.y, y: u.z * e1.x - u.x * e1.z, z: u.x * e1.y - u.y * e1.x }
  const points: V3[] = []
  for (let i = 0; i <= 6; i++)
    for (let k = 0; k < 12; k++) {
      const t = (k / 12) * Math.PI * 2
      const c = Math.cos(t) * r
      const s = Math.sin(t) * r
      const f = i / 6
      points.push({ x: a.x + d.x * f + e1.x * c + e2.x * s, y: a.y + d.y * f + e1.y * c + e2.y * s, z: a.z + d.z * f + e1.z * c + e2.z * s })
    }
  return { bone, points }
}

function ellipsoid(bone: string, c: V3, rx: number, ry: number, rz: number): Surface {
  const points: V3[] = []
  for (let i = 0; i <= 8; i++)
    for (let k = 0; k < 12; k++) {
      const lat = -Math.PI / 2 + (i / 8) * Math.PI
      const lon = (k / 12) * Math.PI * 2
      points.push({ x: c.x + rx * Math.cos(lat) * Math.cos(lon), y: c.y + ry * Math.sin(lat), z: c.z + rz * Math.cos(lat) * Math.sin(lon) })
    }
  return { bone, points }
}

const at = (name: string): V3 => {
  const d = FIXTURE_BONES.find((b) => b[0] === name)!
  return { x: d[2], y: d[3], z: d[4] }
}

/** The grey-box surface, per bone (the fingers on Index1, a non-core bone). */
export function fixtureSurfaces(): Surface[] {
  const out: Surface[] = [
    box('Hips', -0.16, 0.16, 0.88, 1.04, -0.1, 0.1),
    box('Spine', -0.15, 0.15, 1.04, 1.15, -0.1, 0.11),
    box('Spine1', -0.155, 0.155, 1.15, 1.27, -0.11, 0.11),
    box('Spine2', -0.17, 0.17, 1.27, 1.42, -0.12, 0.12),
    box('Neck', -0.05, 0.05, 1.44, 1.56, -0.03, 0.08),
    ellipsoid('Head', { x: 0, y: 1.66, z: -0.01 }, 0.08, 0.11, 0.1)
  ]
  for (const s of [-1, 1]) {
    const sd = s < 0 ? 'Left' : 'Right'
    out.push(
      box(`${sd}Shoulder`, Math.min(s * 0.04, s * 0.17), Math.max(s * 0.04, s * 0.17), 1.4, 1.46, -0.05, 0.08),
      cylinder(`${sd}Arm`, at(`${sd}Arm`), at(`${sd}ForeArm`), 0.05),
      cylinder(`${sd}ForeArm`, at(`${sd}ForeArm`), at(`${sd}Hand`), 0.04),
      box(`${sd}Hand`, Math.min(s * 0.73, s * 0.86), Math.max(s * 0.73, s * 0.86), 1.408, 1.432, 0.01, 0.11),
      box(`${sd}HandIndex1`, Math.min(s * 0.86, s * 0.94), Math.max(s * 0.86, s * 0.94), 1.41, 1.43, 0.015, 0.105),
      cylinder(`${sd}UpLeg`, at(`${sd}UpLeg`), at(`${sd}Leg`), 0.075),
      cylinder(`${sd}Leg`, at(`${sd}Leg`), at(`${sd}Foot`), 0.055),
      box(`${sd}Foot`, s * 0.09 - 0.045, s * 0.09 + 0.045, 0, 0.1, -0.11, 0.06),
      box(`${sd}ToeBase`, s * 0.092 - 0.04, s * 0.092 + 0.04, 0, 0.05, -0.21, -0.11)
    )
  }
  return out
}

/** The fixture as the renderer would register it, scaled by k. */
export function fixtureSource(k = 1): MocapSource {
  const names = FIXTURE_BONES.map((d) => d[0])
  const q = bindRotations()
  const bones = FIXTURE_BONES.map(([name, parent, x, y, z], i) => ({ name, parent: parent ? names.indexOf(parent) : -1, p: { x: x * k, y: y * k, z: z * k }, q: q[i]! }))
  const p: number[] = []
  const bone: number[] = []
  for (const s of fixtureSurfaces()) {
    for (const v of s.points) {
      p.push(v.x * k, v.y * k, v.z * k)
      bone.push(names.indexOf(s.bone))
    }
  }
  return { bones, verts: { p, bone } }
}
