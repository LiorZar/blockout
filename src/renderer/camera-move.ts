/**
 * Laying a camera-move preset (fork addition, street-kit; see
 * MODIFICATIONS.md): what SceneManager.applyCameraMove did inline, with no
 * WebGL in it, so tests and probes lay a move exactly as the app does. The
 * preset is generated round the subject's motion from the shot camera's pose
 * at t = 0 (a vehicle passes its box, so the preset's near distances grow
 * with it), then a person's follow move is kept clear of the set and cast
 * (camera-view.ts clearFollowMarks) and any other move is fitted to the set
 * (engine/move-clear.ts, which also keeps a vehicle's box in frame).
 * A follow or aerial move on a moving vehicle also names the rig that keeps up
 * with it (T5), and `putCameraMove` writes a laid move into a document shot,
 * as a staged car chase does for its own camera.
 */

import { entityHeight } from '@engine/assets'
import { findPreset, type CameraMarkSpec, type CameraMoveCategory } from '@engine/camera-moves'
import { ShotEvaluator } from '@engine/evaluate'
import { newId } from '@engine/ids'
import { vehicleBox } from '@engine/vehicles'
import type { RigId, Scene, Shot, V3 } from '@engine/types'
import { clearFollowMarks, clearMoveMarks } from './camera-view'

export interface LaidMove {
  marks: CameraMarkSpec[]
  /** The preset aims at its subject (the shot camera tracks it). */
  track: boolean
  note?: string
  warning?: string
  /** The rig the move needs to keep up with its subject, when the shot's rig is still the default Sticks. */
  rig?: RigId
}

/** The move a staged car chase lays on its lead car: a camera car leading it, the pursuers behind it in frame. */
export const CHASE_CAMERA_MOVE = 'lead'

/** The camera marks preset `presetId` (a preset, old or shared move id: findPreset) lays round `subjectId` in this shot; null for an unknown preset or subject. */
export function layCameraMove(scene: Scene, shot: Shot, presetId: string, subjectId: string): LaidMove | null {
  const preset = findPreset(presetId)
  const entity = scene.entities.find((e) => e.id === subjectId)
  if (!preset || !entity) return null
  const evaluator = new ShotEvaluator(scene, shot)
  const cam0 = evaluator.evaluate(0).camera
  const duration = shot.duration
  const box = vehicleBox(entity.assetId, entity.transform.scale)
  const subjectAt = (t: number): V3 & { heading: number } => {
    const st = evaluator.evaluate(Math.min(Math.max(t, 0), duration))
    const es = st.entities.find((e) => e.entityId === subjectId)
    const p = es?.position ?? entity.transform.position
    return { x: p.x, y: p.y, z: p.z, heading: es?.heading ?? 0 }
  }
  const specs = preset.generate({
    subjectAt,
    subjectHeight: entityHeight(entity.assetId, entity.transform.scale, entity.params),
    camera: { x: cam0.position.x, y: cam0.position.y, z: cam0.position.z, pan: cam0.pan, tilt: cam0.tilt, focalLength: cam0.focalLength },
    duration,
    ...(box ? { subjectBox: { length: box.front + box.back, width: 2 * box.hw, height: box.h } } : {})
  })
  const cleared =
    preset.category === 'tracking' && entity.assetId.startsWith('person.')
      ? clearFollowMarks(scene, shot, specs, subjectId)
      : clearMoveMarks(scene, shot, specs, subjectId, preset.track, preset.name)
  const rig = rideRig(preset.category, entity.assetId, shot.camera.rig, subjectAt, duration)
  return {
    marks: cleared?.marks ?? specs,
    track: preset.track,
    ...(cleared?.note ? { note: cleared.note } : {}),
    ...(cleared?.warning ? { warning: cleared.warning } : {}),
    ...(rig ? { rig } : {})
  }
}

/**
 * The rig a follow or aerial move on a moving vehicle rides so the camera can
 * keep up: a camera car on the ground, a drone in the air. Only over the
 * default Sticks: a rig set by hand stays (and its speed warning with it).
 */
function rideRig(category: CameraMoveCategory, assetId: string, rig: RigId, at: (t: number) => V3, duration: number): RigId | undefined {
  if (rig !== 'sticks' || !assetId.startsWith('vehicle.') || (category !== 'tracking' && category !== 'aerial')) return undefined
  const start = at(0)
  const moves = Array.from({ length: 8 }, (_, k) => at((duration * (k + 1)) / 8)).some((p) => Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z) > 1)
  if (!moves) return undefined
  return category === 'aerial' || start.y > 3 ? 'drone' : 'carMount'
}

/**
 * Lay preset `presetId` round `subjectId` into `shot` (a document copy, inside
 * a mutate): its marks, its aim and the rig it needs. Null for an unknown
 * preset or subject, leaving the shot as it was.
 */
export function putCameraMove(scene: Scene, shot: Shot, presetId: string, subjectId: string): LaidMove | null {
  const laid = layCameraMove(scene, shot, presetId, subjectId)
  if (!laid) return null
  shot.camera.marks = laid.marks.map((spec) => ({
    id: newId('cmark'),
    time: spec.time,
    hold: spec.hold,
    easeIn: spec.easeIn,
    easeOut: spec.easeOut,
    position: { ...spec.position },
    pan: spec.pan,
    tilt: spec.tilt,
    roll: spec.roll,
    focalLength: spec.focalLength
  }))
  if (laid.track) shot.camera.trackEntityId = subjectId
  else delete shot.camera.trackEntityId
  if (laid.rig) shot.camera.rig = laid.rig
  return laid
}
