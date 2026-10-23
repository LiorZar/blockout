/**
 * Clear camera views, renderer side (fork addition, fix-camera-set; see
 * MODIFICATIONS.md): hands the set's geometry (fight-obstacles.ts
 * `cameraBoxes`) to the pure search in src/engine/camera-clear.ts for shot
 * words, fight coverage, framing presets and people-follow moves, and (fork,
 * shot-clear) to src/engine/move-clear.ts for every other camera move.
 */

import { clearFixedPose, clearFollowMove, clearShotWords, type SetBox, type ViewOutcome } from '@engine/camera-clear'
import { coverageClearer } from '@engine/fight/coverage-clear'
import { clearMove } from '@engine/move-clear'
import type { CameraMarkSpec } from '@engine/camera-moves'
import type { ShotSpec } from '@engine/shot'
import type { Scene, Shot, V3 } from '@engine/types'
import { cameraBoxes } from './fight-obstacles'

export { baseLens } from '@engine/camera-clear' // fork (shot-clear)

export function setBoxes(scene: Scene, shot: Shot): SetBox[] {
  return cameraBoxes(scene, scene.blocking.find((b) => b.id === shot.blockingTakeId) ?? scene.blocking[0])
}

/** Shot words for a mark at `time`: clear over the time it drives (to the next camera mark or the shot's end). */
export function clearShotSpec(scene: Scene, shot: Shot, spec: ShotSpec, time: number, focalLength: number): { spec: ShotSpec } & ViewOutcome {
  const tol = 1 / Math.max(1, shot.fps) + 1e-9
  const next = Math.min(shot.duration, ...shot.camera.marks.map((m) => m.time).filter((t) => t > time + tol))
  return clearShotWords(scene, shot, spec, [time, next], focalLength, setBoxes(scene, shot))
}

/**
 * Fight coverage's `clear` option: each framing clear over its span, the set read once (fork, main-thread: the
 * search itself moved to engine/fight/coverage-clear.ts, for the fight worker).
 */
export function shotWordsClearer(scene: Scene, shot: Shot, focalLength: number): (spec: ShotSpec, span: [number, number]) => ShotSpec {
  return coverageClearer(scene, shot, focalLength, setBoxes(scene, shot))
}

/** A framing preset's fixed pose with a clear view of `subjectIds` over the shot. */
export function clearFramingPose(
  scene: Scene,
  shot: Shot,
  pose: { position: V3; look: V3; focalLength: number },
  subjectIds: string[]
): ReturnType<typeof clearFixedPose> {
  return clearFixedPose(scene, shot, pose, subjectIds, setBoxes(scene, shot))
}

/** Fork (shot-clear): any other camera move fitted to the set round its subject (engine/move-clear.ts). */
export function clearMoveMarks(scene: Scene, shot: Shot, specs: CameraMarkSpec[], subjectId: string, track: boolean, name: string): ReturnType<typeof clearMove> {
  return clearMove(scene, shot, specs, subjectId, setBoxes(scene, shot), { track, name })
}

/** A people-follow camera move's marks kept clear of the set and other cast. */
export function clearFollowMarks(scene: Scene, shot: Shot, specs: CameraMarkSpec[], subjectId: string): ReturnType<typeof clearFollowMove> {
  return clearFollowMove(scene, shot, specs, subjectId, setBoxes(scene, shot))
}
