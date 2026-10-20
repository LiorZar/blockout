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
