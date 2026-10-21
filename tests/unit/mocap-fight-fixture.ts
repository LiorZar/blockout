// Fork addition (2026): synthetic fight clips on the fixture skeleton for the mocap fight tests; see MODIFICATIONS.md.
/**
 * Made-up fight clips (no Mixamo data): a joint-channel pose per frame
 * (`mocap-clip-fixture.ts`), plus `bent`, a world-space turn put on one core
 * bone every frame, so a wrist or ankle bends off its forearm or shin as a
 * real take's do. `registerFightClips` registers a small fight library under
 * the real library's keys.
 */

import { registerMocapClip, type MocapClipSource } from '@engine/mocap/clip'
import { qmul, type Quat } from '@engine/mocap/quat'
import { MOCAP_BONES } from '@engine/mocap/rig'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const N = MOCAP_BONES.length

/** A clip source with a world-space turn `q` put on one core bone every frame (a bent wrist or ankle). */
export function bent(src: MocapClipSource, bone: number, q: Quat): MocapClipSource {
  const rot = Array.from(src.rot)
  const frames = rot.length / (4 * N)
  for (let f = 0; f < frames; f++) {
    const i = (f * N + bone) * 4
    rot.splice(i, 4, ...qmul(q, [rot[i]!, rot[i + 1]!, rot[i + 2]!, rot[i + 3]!]))
  }
  return { ...src, rot }
}

/** The fixture's fight guard. */
export const GUARD = { shoulderLX: -0.6, elbowL: 1.4, shoulderRX: -0.6, elbowR: 1.4 }

type Pose = Record<string, number>

/** Out to `peak` at frame `at`, back to the guard by frame `n − 1`. */
function strike(peak: Pose, at = 12, n = 25): Pose[] {
  return [...sweep(GUARD, { ...GUARD, ...peak }, at + 1), ...sweep({ ...GUARD, ...peak }, GUARD, n - at).slice(1)]
}

/**
 * A small fight library on `source` under the real keys: the idle loop,
 * jabs, the cross, hooks, head and body hits, blocks, the dodge (it steps
 * back), the knockdown and the KO (they fall back and travel), the get-up.
 */
export function registerFightClips(source: string, only?: string[]): void {
  const clips: Record<string, () => MocapClipSource> = {
    fightIdle: () => syntheticClip(source, Array.from({ length: 31 }, (_, f) => ({ ...GUARD, torsoX: 0.03 * Math.sin((2 * Math.PI * f) / 30) })), { loop: true, inPlace: false }),
    jabHead: () => syntheticClip(source, strike({ shoulderLX: -1.5, elbowL: 0.05 }), { inPlace: false }),
    jabBody: () => syntheticClip(source, strike({ shoulderLX: -1.2, elbowL: 0.05, torsoX: 0.2 }), { inPlace: false }),
    cross: () => syntheticClip(source, strike({ shoulderRX: -1.5, elbowR: 0.05, torsoY: 0.3 }), { inPlace: false }),
    hookHead: () => syntheticClip(source, strike({ shoulderLX: -1.3, shoulderLZ: 0.7, elbowL: 1.4, torsoY: -0.4 }), { inPlace: false }),
    hookBody: () => syntheticClip(source, strike({ shoulderLX: -0.9, shoulderLZ: 0.6, elbowL: 1.3, torsoY: -0.4, torsoX: 0.2 }), { inPlace: false }),
    hitHeadLeft: () => syntheticClip(source, strike({ headY: 0.5, headZ: -0.3 }, 6, 30), { inPlace: false }),
    hitHeadRight: () => syntheticClip(source, strike({ headY: -0.5, headZ: 0.3 }, 6, 30), { inPlace: false }),
    hitHeadBig: () => syntheticClip(source, strike({ headX: -0.6, torsoX: -0.3 }, 6, 30), { inPlace: false }),
    hitStomach: () => syntheticClip(source, strike({ torsoX: 0.5, headX: 0.2 }, 6, 30), { inPlace: false }),
    hitSide: () => syntheticClip(source, strike({ torsoZ: 0.4 }, 6, 30), { inPlace: false }),
    blockHead: () => syntheticClip(source, strike({ shoulderLX: -1.3, shoulderRX: -1.3, elbowL: 2, elbowR: 2 }, 8, 24), { inPlace: false }),
    blockBody: () => syntheticClip(source, strike({ shoulderLX: -0.3, shoulderRX: -0.3, elbowL: 2.1, elbowR: 2.1 }, 8, 24), { inPlace: false }),
    dodge: () => syntheticClip(source, strike({ torsoX: -0.3, headX: -0.2 }, 10, 30), { inPlace: false, hips: (f) => ({ x: 0, y: 0, z: 0.008 * f }) }),
    knockedDown: () => syntheticClip(source, sweep(GUARD, { torsoX: -0.6 }, 40), { inPlace: false, hips: (f) => ({ x: 0, y: -0.05 * Math.min(f, 16), z: 0.025 * Math.min(f, 24) }) }),
    koBack: () => syntheticClip(source, [...Array.from({ length: 10 }, () => GUARD), ...sweep(GUARD, { torsoX: -0.6 }, 40)], { inPlace: false, hips: (f) => ({ x: 0, y: -0.05 * Math.min(Math.max(0, f - 10), 16), z: 0.025 * Math.min(Math.max(0, f - 10), 24) }) }),
    getUpKnockdown: () => syntheticClip(source, sweep({ torsoX: -0.6 }, GUARD, 40), { inPlace: false, hips: (f) => ({ x: 0, y: -0.8 + 0.02 * f, z: 0 }) })
  }
  for (const [id, make] of Object.entries(clips)) if (!only || only.includes(id)) registerMocapClip(id, make())
}
