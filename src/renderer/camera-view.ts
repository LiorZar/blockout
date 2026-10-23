/**
 * Clear camera views, renderer side (fork addition, fix-camera-set; see
 * MODIFICATIONS.md): hands the set's geometry (fight-obstacles.ts
 * `cameraBoxes`) to the pure search in src/engine/camera-clear.ts for shot
 * words, fight coverage, framing presets and people-follow moves.
 */

import { clearFixedPose, clearFollowMove, clearShotWords, type SetBox, type ViewOutcome } from '@engine/camera-clear'
import type { CameraMarkSpec } from '@engine/camera-moves'
import type { ShotSpec } from '@engine/shot'
import type { Scene, Shot, V3 } from '@engine/types'
import { cameraBoxes } from './fight-obstacles'

export { baseLens } from '@engine/camera-clear' // fork (shot-clear)

/** Fork (shot-clear): how long fight coverage takes to move into a framing (fight/coverage.ts MOVE_S). */
const COVERAGE_MOVE_S = 0.4

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
 * Fight coverage's `clear` option: each framing clear over its span, the set read once.
 * Fork (shot-clear): each framing is checked from the start of the move into it (coverage moves over the
 * MOVE_S before a framing's time, fight/coverage.ts), when the camera is already on its way to it. An
 * over-the-shoulder beat with no clear view (it can only rise: a bus shelter's roof over the shoulder) becomes
 * the medium two-shot on the same side of the line, which can come closer, rise or swing.
 */
export function shotWordsClearer(scene: Scene, shot: Shot, focalLength: number): (spec: ShotSpec, span: [number, number]) => ShotSpec {
  const boxes = setBoxes(scene, shot)
  return (spec, span) => {
    const s: [number, number] = [Math.max(0, span[0] - COVERAGE_MOVE_S), Math.min(span[1], shot.duration)]
    const asked = clearShotWords(scene, shot, spec, s, focalLength, boxes).spec
    if (!spec.over || !spec.lineIds || !asked.view?.noClearView) return asked
    const two: ShotSpec = { size: 'MS', subjectIds: [...spec.lineIds], side: 'line', lineIds: spec.lineIds, ...(spec.lineSide ? { lineSide: spec.lineSide } : {}) }
    const alt = clearShotWords(scene, shot, two, s, focalLength, boxes).spec
    return alt.view?.noClearView ? asked : alt
  }
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

/** A people-follow camera move's marks kept clear of the set and other cast. */
export function clearFollowMarks(scene: Scene, shot: Shot, specs: CameraMarkSpec[], subjectId: string): ReturnType<typeof clearFollowMove> {
  return clearFollowMove(scene, shot, specs, subjectId, setBoxes(scene, shot))
}
