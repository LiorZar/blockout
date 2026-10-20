// Fork addition (2026): synthetic mocap clips on the fixture skeleton for the clip tests; see MODIFICATIONS.md.
/**
 * Made-up clips: each frame is a rig pose (joint channels) of a registered
 * fixture bot, written out as the renderer registers a real take (world
 * rotations and the hips joint in the file's entity space). No Mixamo data.
 */

import { bodyLowY } from '@engine/floor'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import { qeuler, qmul, type Quat } from '@engine/mocap/quat'
import { mocapRig } from '@engine/mocap/registry'
import type { MocapClipSource } from '@engine/mocap/clip'
import type { V3 } from '@engine/types'

export interface SyntheticOptions {
  fps?: number
  loop?: boolean
  inPlace?: boolean
  /** Hips offset per frame (rig metres): travel, bob. */
  hips?: (f: number) => V3
  /** Drop the hips so every frame's lowest point is on the floor (as a real take is). */
  grounded?: boolean
  /** Bones beyond the core turned about their parent's z (rad), every frame: fingers. */
  curl?: Record<string, number>
}

/** A clip source from one joint-channel pose per frame, captured on `source`. */
export function syntheticClip(source: string, poses: Record<string, number>[], o: SyntheticOptions = {}): MocapClipSource {
  const rig = mocapRig(source)!
  const m = { rig, k: 1 }
  const rot: number[] = []
  const hips: number[] = []
  const names = Object.keys(o.curl ?? {})
  const xrot: number[] = []
  const N = rig.restQ.length
  poses.forEach((joints, f) => {
    const pose = mocapPose(m, jointLocals(joints))
    pose.G.forEach((g, i) => rot.push(...qmul(g, rig.restQ[i]!)))
    // The extras: each turned by its curl under its parent, written out as world rotations.
    const XG: Quat[] = []
    rig.extra.forEach((x, e) => {
      const gp = x.parent < N ? pose.G[x.parent]! : XG[x.parent - N]!
      const a = o.curl?.[x.name]
      XG[e] = a === undefined ? gp : qmul(gp, qeuler(0, 0, a))
    })
    for (const name of names) {
      const e = rig.extra.findIndex((x) => x.name === name)
      xrot.push(...qmul(XG[e]!, rig.extra[e]!.restQ))
    }
    const d = o.hips?.(f) ?? { x: 0, y: o.grounded ? -bodyLowY({ assetId: source }, joints) : 0, z: 0 }
    const p = pose.P[0]!
    hips.push((p.x + d.x) / rig.scale + rig.centre.x, (p.y + d.y) / rig.scale + rig.centre.y, (p.z + d.z) / rig.scale + rig.centre.z)
  })
  return { source, fps: o.fps ?? 30, loop: o.loop, inPlace: o.inPlace ?? true, rot, hips, ...(names.length ? { extra: { names, rot: xrot } } : {}) }
}

/** n frames easing a channel set from a to b (linear in the channels). */
export function sweep(a: Record<string, number>, b: Record<string, number>, n: number): Record<string, number>[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  return Array.from({ length: n }, (_, f) => Object.fromEntries(keys.map((k) => [k, (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * (n > 1 ? f / (n - 1) : 0)])))
}
