/**
 * The set for the Choreographer's routines (fork addition, set-routines; see
 * MODIFICATIONS.md), read off the built geometry of a scene's kits and props
 * as the plain data of src/engine/routine-set.ts:
 * - floors: a kit's pieces whose top is under WALK_TOP (its ground, street,
 *   kerbs and lawns), the tile a routine stays on;
 * - streets: a kit's flat strips at least 12 m long, 3 m wide and 2.5 times
 *   longer than wide (asphalt, an alley's ground);
 * - solids: pieces between WALK_TOP and HEAD (walls, buildings, shop glass,
 *   counters, benches); a lone prop is one footprint.
 * Overhead pieces, whatever a kit's own animation moves and editor-only
 * dressing don't count. People, animals and weapons are never set, and
 * neither is anything that moves in the take, rides another entity or is
 * hidden from exports. Pieces are cached per asset and parameters.
 */

import * as THREE from 'three'
import { assetSpec } from '@engine/assets'
import type { RoutineSet, SetRect, SetSolid } from '@engine/routine-set'
import type { BlockingTake, Entity, Scene } from '@engine/types'
import { buildAsset } from './viewport/builders'

const WALK_TOP = 0.35
const HEAD = 1.9
const NOT_PROPS = new Set(['people', 'animals', 'weapons'])

type Piece = { kind: 'floor' | 'street' | 'solid'; x: number; z: number; hx: number; hz: number }

const cache = new Map<string, Piece[]>()

/** What a kit's animation moves (sampled at a few times against its rest). */
function moving(built: ReturnType<typeof buildAsset>): Set<THREE.Object3D> {
  const out = new Set<THREE.Object3D>()
  if (!built.animate) return out
  const pose = (time: number): Map<THREE.Object3D, THREE.Matrix4> => {
    built.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time })
    built.group.updateMatrixWorld(true)
    const m = new Map<THREE.Object3D, THREE.Matrix4>()
    built.group.traverse((o) => m.set(o, o.matrixWorld.clone()))
    return m
  }
  const rest = pose(0)
  for (const time of [1.3, 3.7]) for (const [o, m] of pose(time)) if (!m.equals(rest.get(o)!)) out.add(o)
  pose(0)
  return out
}

/** Asset-local pieces of an asset. */
function pieces(e: Entity): Piece[] {
  const key = `${e.assetId}|${JSON.stringify(e.params ?? {})}`
  const hit = cache.get(key)
  if (hit) return hit
  const out: Piece[] = []
  const built = buildAsset(e.assetId, e.params)
  built.group.updateMatrixWorld(true)
  const moves = moving(built)
  const bb = new THREE.Box3()
  built.group.traverseVisible((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || moves.has(mesh)) return
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData?.editorOnly) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    bb.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
    const f = { x: (bb.min.x + bb.max.x) / 2, z: (bb.min.z + bb.max.z) / 2, hx: (bb.max.x - bb.min.x) / 2, hz: (bb.max.z - bb.min.z) / 2 }
    if (bb.max.y <= WALK_TOP) {
      if (f.hx * f.hz * 4 < 1) return
      const long = Math.max(f.hx, f.hz) * 2
      const wide = Math.min(f.hx, f.hz) * 2
      const street = bb.max.y - bb.min.y <= 0.05 && long >= 12 && wide >= 3 && long >= wide * 2.5
      out.push({ kind: street ? 'street' : 'floor', ...f })
    }
    else if (bb.min.y < HEAD) out.push({ kind: 'solid', ...f })
  })
  cache.set(key, out)
  return out
}

/** The set a routine in `take` stays on: the scene's kits and static props. */
export function routineSet(scene: Scene, take: BlockingTake | undefined): RoutineSet {
  const moves = new Set((take?.tracks ?? []).filter((t) => t.marks.length > 0).map((t) => t.entityId))
  const set: RoutineSet = { floors: [], solids: [], streets: [] }
  const kits: string[] = []
  for (const e of scene.entities) {
    if (NOT_PROPS.has(assetSpec(e.assetId).category) || e.assetId.startsWith('person.')) continue
    if (e.heldBy || e.attachedTo || e.excludeFromExport || moves.has(e.id)) continue
    const { position: p, rotationY: h, scale } = e.transform
    const k = scale > 0 ? scale : 1
    const c = Math.cos(h)
    const s = Math.sin(h)
    const kit = assetSpec(e.assetId).category === 'environment'
    // Asset-local → world (object.rotation.y = h).
    const world = (f: { x: number; z: number; hx: number; hz: number }): SetRect => ({ x: p.x + (f.x * c + f.z * s) * k, z: p.z + (-f.x * s + f.z * c) * k, hx: f.hx * k, hz: f.hz * k, heading: h })
    const parts = pieces(e)
    if (kit) {
      kits.push(e.name)
      for (const f of parts) {
        const r = world(f)
        if (f.kind === 'solid') set.solids.push({ ...r, name: `the ${e.name} set at (${r.x.toFixed(1)}, ${r.z.toFixed(1)})` })
        else {
          set.floors.push(r)
          if (f.kind === 'street') set.streets.push(r)
        }
      }
      continue
    }
    // A lone prop blocks as one footprint.
    const solids = parts.filter((f) => f.kind === 'solid')
    if (solids.length === 0) continue
    const x0 = Math.min(...solids.map((f) => f.x - f.hx))
    const x1 = Math.max(...solids.map((f) => f.x + f.hx))
    const z0 = Math.min(...solids.map((f) => f.z - f.hz))
    const z1 = Math.max(...solids.map((f) => f.z + f.hz))
    const solid: SetSolid = { ...world({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 }), name: e.label?.text || e.name }
    set.solids.push(solid)
  }
  if (kits.length > 0) set.name = kits.length === 1 ? `the ${kits[0]} set` : 'the set'
  return set
}
