/**
 * Who a framing preset or camera move is built around. Pure: the viewport
 * passes in the scene's entities and the current (or explicit) selection.
 *
 * Rules, in order — results keep scene order:
 *   1. at least `minSelected` selected ids that exist in the scene → those
 *   2. otherwise every person (`person.*`)
 *   3. otherwise the first two entities that aren't set kits (`env.*`)
 *   4. otherwise nothing
 * A set kit is never picked by fallback: a camera locked on the street reads
 * as an empty shot to a video model. A *selected* kit is skipped too while the
 * scene has cast (people, vehicles, animals) — placing a set leaves it
 * selected — unless the ids were passed explicitly (`explicit`).
 */

import type { V3 } from './types'

const isKit = (e: { assetId: string }): boolean => e.assetId.startsWith('env.')
const isCast = (e: { assetId: string }): boolean => /^(person|vehicle|animal)\./.test(e.assetId)

export function pickFramingSubjectIds(
  entities: { id: string; assetId: string }[],
  selectedIds: string[],
  minSelected: number,
  opts: { explicit?: boolean } = {}
): string[] {
  const skipKits = !opts.explicit && entities.some(isCast)
  const selected = entities.filter((e) => selectedIds.includes(e.id) && !(skipKits && isKit(e)))
  if (selected.length > 0 && selected.length >= minSelected) return selected.map((e) => e.id)
  const people = entities.filter((e) => e.assetId.startsWith('person.'))
  if (people.length > 0) return people.map((e) => e.id)
  return entities
    .filter((e) => !isKit(e))
    .slice(0, 2)
    .map((e) => e.id)
}

/**
 * The 2-shot / group framing preset (moved here from SceneManager.applyFraming
 * by the fork, fix-camera-set, so it can be tested): perpendicular to the line
 * from the first subject to the last, on the camera's current side of it (the
 * 180° rule), far enough back for the group's spread and the tallest subject.
 */
export function groupShotPose(
  subjects: { pos: V3; height: number }[],
  camPos: V3,
  fov: { hfov: number; vfov: number }
): { position: V3; look: V3 } {
  const a = subjects[0]!
  const b = subjects[subjects.length - 1]!
  const mid = { x: 0, y: 0, z: 0 }
  for (const s of subjects) {
    mid.x += s.pos.x / subjects.length
    mid.y += s.pos.y / subjects.length
    mid.z += s.pos.z / subjects.length
  }
  let axis = { x: b.pos.x - a.pos.x, z: b.pos.z - a.pos.z }
  const l = Math.hypot(axis.x, axis.z)
  axis = l * l < 1e-6 ? { x: 1, z: 0 } : { x: axis.x / l, z: axis.z / l }
  let perp = { x: axis.z, z: -axis.x }
  if ((camPos.x - mid.x) * perp.x + (camPos.z - mid.z) * perp.z < 0) perp = { x: -perp.x, z: -perp.z }
  let span = 0
  for (const s of subjects) span = Math.max(span, Math.abs((s.pos.x - mid.x) * axis.x + (s.pos.z - mid.z) * axis.z) * 2)
  span += 1.6 // shoulder margin on both ends
  const tallest = Math.max(...subjects.map((s) => s.height))
  const dist = Math.max(span / 2 / Math.tan(fov.hfov / 2), (tallest + 0.4) / 2 / Math.tan(fov.vfov / 2), 1.5)
  return {
    position: { x: mid.x + perp.x * dist, y: mid.y + tallest * 0.62, z: mid.z + perp.z * dist },
    look: { x: mid.x, y: mid.y + tallest * 0.55, z: mid.z }
  }
}
