/**
 * Laying a camera-move preset (fork addition, street-kit; see
 * MODIFICATIONS.md): what SceneManager.applyCameraMove did inline, with no
 * WebGL in it, so tests and probes lay a move exactly as the app does. The
 * preset is generated round the subject's motion from the shot camera's pose
 * at t = 0 (a vehicle passes its box, so the preset's near distances grow
 * with it), then a person's follow move is kept clear of the set and cast
 * (camera-view.ts clearFollowMarks) and any other move is fitted to the set
 * (engine/move-clear.ts, which also keeps a vehicle's box in frame).
 */

import { entityHeight } from '@engine/assets'
import { CAMERA_MOVE_PRESETS, type CameraMarkSpec } from '@engine/camera-moves'
import { ShotEvaluator } from '@engine/evaluate'
import { vehicleBox } from '@engine/vehicles'
import type { Scene, Shot } from '@engine/types'
import { clearFollowMarks, clearMoveMarks } from './camera-view'

export interface LaidMove {
  marks: CameraMarkSpec[]
  /** The preset aims at its subject (the shot camera tracks it). */
  track: boolean
  note?: string
  warning?: string
}

/** The camera marks preset `presetId` lays round `subjectId` in this shot; null for an unknown preset or subject. */
export function layCameraMove(scene: Scene, shot: Shot, presetId: string, subjectId: string): LaidMove | null {
  const preset = CAMERA_MOVE_PRESETS.find((p) => p.id === presetId)
  const entity = scene.entities.find((e) => e.id === subjectId)
  if (!preset || !entity) return null
  const evaluator = new ShotEvaluator(scene, shot)
  const cam0 = evaluator.evaluate(0).camera
  const duration = shot.duration
  const box = vehicleBox(entity.assetId, entity.transform.scale)
  const specs = preset.generate({
    subjectAt: (t) => {
      const st = evaluator.evaluate(Math.min(Math.max(t, 0), duration))
      const es = st.entities.find((e) => e.entityId === subjectId)
      const p = es?.position ?? entity.transform.position
      return { x: p.x, y: p.y, z: p.z, heading: es?.heading ?? 0 }
    },
    subjectHeight: entityHeight(entity.assetId, entity.transform.scale, entity.params),
    camera: { x: cam0.position.x, y: cam0.position.y, z: cam0.position.z, pan: cam0.pan, tilt: cam0.tilt, focalLength: cam0.focalLength },
    duration,
    ...(box ? { subjectBox: { length: box.front + box.back, width: 2 * box.hw, height: box.h } } : {})
  })
  const cleared =
    preset.category === 'follow' && entity.assetId.startsWith('person.')
      ? clearFollowMarks(scene, shot, specs, subjectId)
      : clearMoveMarks(scene, shot, specs, subjectId, preset.track, preset.name)
  return {
    marks: cleared?.marks ?? specs,
    track: preset.track,
    ...(cleared?.note ? { note: cleared.note } : {}),
    ...(cleared?.warning ? { warning: cleared.warning } : {})
  }
}
