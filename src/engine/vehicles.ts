/**
 * Vehicles as the builders draw them (fork addition, street-kit; see
 * MODIFICATIONS.md). The catalog's `footprint` is a rough radius for placement;
 * a car chase needs the real box: a car on the road keeps it inside the kerbs,
 * a camera move keeps its lens out of it and the whole of it in frame.
 *
 * `VEHICLE_BOXES`: half width, height and the reach in front of (−Z) and
 * behind (+Z) the origin, in the asset's own frame (tests/unit/road-kit.test.ts
 * checks them against the built meshes).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { ASPECT_RATIOS } from './camera'
import type { AspectId, V3 } from './types'

export interface VehicleBox {
  /** Half width (m). */
  hw: number
  /** Height over the ground (m). */
  h: number
  /** Reach in front of the origin, along −Z (m). */
  front: number
  /** Reach behind the origin, along +Z (m). */
  back: number
}

export const VEHICLE_BOXES: Record<string, VehicleBox> = {
  'vehicle.sedan': { hw: 0.93, h: 1.6, front: 2.3, back: 2.3 },
  'vehicle.suv': { hw: 0.98, h: 1.88, front: 2.4, back: 2.4 },
  'vehicle.pickup': { hw: 0.98, h: 1.75, front: 2.65, back: 2.65 },
  'vehicle.van': { hw: 1.0, h: 2.28, front: 2.7, back: 2.7 },
  'vehicle.bus': { hw: 1.26, h: 3.2, front: 6, back: 6 },
  'vehicle.truck': { hw: 1.25, h: 4.1, front: 6, back: 7 },
  'vehicle.tank': { hw: 1.7, h: 2.4, front: 3.5, back: 3.5 },
  'vehicle.train': { hw: 1.51, h: 3.92, front: 10, back: 10 },
  'vehicle.motorcycle': { hw: 0.28, h: 1.11, front: 1.33, back: 1.33 },
  'vehicle.bicycle': { hw: 0.2, h: 1.15, front: 1.11, back: 1.11 },
  'vehicle.plane': { hw: 9, h: 5.15, front: 10, back: 10 },
  'vehicle.boat': { hw: 1.1, h: 1.9, front: 3.9, back: 3 }
}

/** The vehicle's box scaled, or undefined for anything that isn't a vehicle. */
export function vehicleBox(assetId: string, scale = 1): VehicleBox | undefined {
  const b = VEHICLE_BOXES[assetId]
  return b && { hw: b.hw * scale, h: b.h * scale, front: b.front * scale, back: b.back * scale }
}

/** The box's 8 corners in the world, for a vehicle at `position` facing `heading`. */
export function vehicleCorners(b: VehicleBox, position: V3, heading: number): V3[] {
  const f = { x: -Math.sin(heading), z: -Math.cos(heading) }
  const r = { x: Math.cos(heading), z: -Math.sin(heading) }
  const out: V3[] = []
  for (const s of [-b.hw, b.hw])
    for (const a of [b.front, -b.back])
      for (const y of [0, b.h]) out.push({ x: position.x + r.x * s + f.x * a, y: position.y + y, z: position.z + r.z * s + f.z * a })
  return out
}

/**
 * How far the furthest of `pts` sits from the frame's middle, as a share of
 * the frame (≤ 1: all in frame; Infinity: one is behind the lens). The camera
 * turns by pan about Y, tilt about X and roll about its view axis, and
 * renders `aspect` wide at its vertical field of view `vfov`.
 */
export function boxReach(pts: V3[], cam: { position: V3; pan: number; tilt: number; roll: number; vfov: number }, aspect: AspectId): number {
  const tanV = Math.tan(cam.vfov / 2)
  const tanH = tanV * ASPECT_RATIOS[aspect]
  const cy = Math.cos(-cam.pan)
  const sy = Math.sin(-cam.pan)
  const cx = Math.cos(-cam.tilt)
  const sx = Math.sin(-cam.tilt)
  const cr = Math.cos(-cam.roll)
  const sr = Math.sin(-cam.roll)
  let reach = 0
  for (const p of pts) {
    const dx = p.x - cam.position.x
    const dy = p.y - cam.position.y
    const dz = p.z - cam.position.z
    const x1 = cy * dx + sy * dz
    const z1 = -sy * dx + cy * dz
    const y2 = cx * dy - sx * z1
    const z2 = sx * dy + cx * z1
    const x3 = cr * x1 - sr * y2
    const y3 = sr * x1 + cr * y2
    if (z2 > -0.05) return Infinity
    reach = Math.max(reach, Math.abs(x3 / -z2 / tanH), Math.abs(y3 / -z2 / tanV))
  }
  return reach
}
