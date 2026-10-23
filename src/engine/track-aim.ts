/**
 * Where a camera that tracks a subject aims (fork addition, set-routines; see
 * MODIFICATIONS.md). Upstream aims at 0.8 of the subject's height above its
 * root, a standing chest: a person who falls flat or sits low drops out of the
 * bottom of the frame while the camera keeps looking at the air above them
 * (the caught runner of a chase, under a lead-the-subject camera). A person
 * whose head is below that point is aimed at instead: the camera eases from
 * the standing point to the middle of the body (between hips and head) as
 * the head drops (all of it once the head is LOW_SPAN below the standing
 * point). A standing person, and anything that isn't a person, is aimed at
 * exactly as before.
 *
 * PURE: no DOM / three.js / Electron.
 */

import { entityHeight } from './assets'
import { personDims, poseEffectors, toWorld } from './skeleton'
import type { Entity, EntityState, V3 } from './types'

/** The head this far below the standing aim point turns the aim fully onto the body (m). */
const LOW_SPAN = 0.6
/** Where the easing starts: the head this far below the standing aim point (m). */
const LOW_START = 0.2

export function trackAim(entity: Pick<Entity, 'assetId' | 'params' | 'transform'>, state: Pick<EntityState, 'position' | 'heading' | 'joints' | 'clip'>): V3 {
  const scale = entity.transform.scale
  const up = entityHeight(entity.assetId, scale, entity.params) * 0.8
  const stand = { x: state.position.x, y: state.position.y + up, z: state.position.z }
  if (!entity.assetId.startsWith('person.')) return stand
  const fx = poseEffectors(personDims(entity.assetId, entity.params), state.joints, state.clip)
  const head = toWorld(fx.head, state.position, state.heading, scale)
  const k = Math.min(1, Math.max(0, (stand.y - LOW_START - head.y) / LOW_SPAN))
  if (k === 0) return stand
  const pelvis = toWorld(fx.pelvis, state.position, state.heading, scale)
  const body = { x: (head.x + pelvis.x) / 2, y: (head.y + pelvis.y) / 2, z: (head.z + pelvis.z) / 2 }
  const e = k * k * (3 - 2 * k)
  return { x: stand.x + (body.x - stand.x) * e, y: stand.y + (body.y - stand.y) * e, z: stand.z + (body.z - stand.z) * e }
}
