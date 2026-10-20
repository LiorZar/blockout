/**
 * Set props for the fight solver (fork addition; see MODIFICATIONS.md): the
 * floor footprints of a scene's static props, read off their built geometry
 * (kits included — the gym's benches and racks live inside env.gym), as the
 * oriented boxes of src/engine/fight/obstacles.ts.
 *
 * Only geometry in the body's height band counts (floors, rugs and ceilings
 * don't block anyone). People, animals and weapons are never props, and
 * neither is anything that moves in the take, rides another entity or is
 * hidden from exports. Footprints are cached per asset and parameters.
 */

import * as THREE from 'three'
import { assetSpec } from '@engine/assets'
import type { FightObstacle } from '@engine/fight/obstacles'
import type { BlockingTake, Entity, Scene } from '@engine/types'
import { buildAsset } from './viewport/builders'

const BAND_LO = 0.2
const BAND_HI = 1.7
const NOT_PROPS = new Set(['people', 'animals', 'weapons'])

type Footprint = { x: number; z: number; hx: number; hz: number }

const cache = new Map<string, Footprint[]>()

/** Asset-local footprints of an asset's meshes in the body band. */
function footprints(e: Entity): Footprint[] {
  const key = `${e.assetId}|${JSON.stringify(e.params ?? {})}`
  const hit = cache.get(key)
  if (hit) return hit
  const out: Footprint[] = []
  const group = buildAsset(e.assetId, e.params).group
  group.updateMatrixWorld(true)
  const bb = new THREE.Box3()
  group.traverseVisible((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    bb.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
    if (bb.max.y < BAND_LO || bb.min.y > BAND_HI) return
    out.push({ x: (bb.min.x + bb.max.x) / 2, z: (bb.min.z + bb.max.z) / 2, hx: (bb.max.x - bb.min.x) / 2, hz: (bb.max.z - bb.min.z) / 2 })
  })
  cache.set(key, out)
  return out
}

function union(parts: Footprint[]): Footprint[] {
  if (parts.length === 0) return []
  const x0 = Math.min(...parts.map((f) => f.x - f.hx))
  const x1 = Math.max(...parts.map((f) => f.x + f.hx))
  const z0 = Math.min(...parts.map((f) => f.z - f.hz))
  const z1 = Math.max(...parts.map((f) => f.z + f.hz))
  return [{ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 }]
}

/** The static props of a scene that a fight in `take` must keep clear of. */
export function fightObstacles(scene: Scene, take: BlockingTake | undefined): FightObstacle[] {
  const moving = new Set((take?.tracks ?? []).filter((t) => t.marks.length > 0).map((t) => t.entityId))
  const out: FightObstacle[] = []
  for (const e of scene.entities) {
    if (NOT_PROPS.has(assetSpec(e.assetId).category) || e.assetId.startsWith('person.')) continue
    if (e.heldBy || e.attachedTo || e.excludeFromExport || moving.has(e.id)) continue
    const { position: p, rotationY: h, scale } = e.transform
    const k = scale > 0 ? scale : 1
    const c = Math.cos(h)
    const s = Math.sin(h)
    const kit = assetSpec(e.assetId).category === 'environment'
    // A kit's pieces block one by one; a lone prop is one footprint.
    const parts = footprints(e)
    for (const f of kit ? parts : union(parts)) {
      // Asset-local → world (object.rotation.y = h).
      const x = p.x + (f.x * c + f.z * s) * k
      const z = p.z + (-f.x * s + f.z * c) * k
      out.push({
        entityId: e.id,
        name: kit ? `a ${e.name} prop at (${x.toFixed(1)}, ${z.toFixed(1)})` : e.label?.text || e.name,
        x,
        z,
        hx: f.hx * k,
        hz: f.hz * k,
        heading: h
      })
    }
  }
  return out
}
