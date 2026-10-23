// Fork test (street-kit, docs/plans/2026-10-23-street-kit.md): the open road, and a Library car chase that stays on it
// from the first frame to the last.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '@renderer/store'
import { buildAsset } from '@renderer/viewport/builders'
import { routineSet } from '@renderer/routine-set'
import { ShotEvaluator } from '@engine/evaluate'
import { createProject } from '@engine/schema'
import { OPEN_ROAD, ROAD_END, ROAD_KERB, ROAD_WALK, roadLayout, roadLength, roadLocal, type RoadPlace } from '@engine/road-kit'
import { VEHICLE_BOXES, vehicleBox, vehicleCorners } from '@engine/vehicles'
import type { Entity, ProjectDoc, V3 } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const FPS = 24

function load(duration: number): void {
  const doc: ProjectDoc = createProject('Chase')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = duration
  sc.shots[0]!.fps = FPS
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

const placeOf = (e: Entity): RoadPlace => ({ x: e.transform.position.x, z: e.transform.position.z, heading: e.transform.rotationY, length: roadLength(e.params) })
const roads = (): Entity[] => st().scene()!.entities.filter((e) => e.assetId === OPEN_ROAD)
const cars = (): Entity[] => st().scene()!.entities.filter((e) => e.assetId.startsWith('vehicle.'))

/** Separating axes of two rectangles (ground footprints, corners in drawing order). */
function overlap(a: V3[], b: V3[]): boolean {
  for (const poly of [a, b])
    for (const [i, j] of [[0, 2], [0, 4]] as [number, number][]) {
      const n = { x: -(poly[j]!.z - poly[i]!.z), z: poly[j]!.x - poly[i]!.x }
      const pa = a.map((q) => q.x * n.x + q.z * n.z)
      const pb = b.map((q) => q.x * n.x + q.z * n.z)
      if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false
    }
  return true
}

/** Every frame of the shot: the worst corner across / along the road, car-car overlaps, the largest heading step. */
function drive(): { across: number; along: number; overlaps: number; turn: number; road: RoadPlace } {
  const road = placeOf(roads()[0]!)
  const ev = new ShotEvaluator(st().scene()!, st().shot()!)
  const n = Math.round(st().shot()!.duration * FPS)
  let across = 0
  let along = 0
  let overlaps = 0
  let turn = 0
  const last = new Map<string, number>()
  for (let f = 0; f <= n; f++) {
    const s = ev.evaluate(f / FPS)
    const boxes = cars().map((c) => {
      const es = s.entities.find((x) => x.entityId === c.id)!
      const prev = last.get(c.id)
      if (prev !== undefined) turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(es.heading - prev), Math.cos(es.heading - prev))))
      last.set(c.id, es.heading)
      const corners = vehicleCorners(vehicleBox(c.assetId)!, es.position, es.heading)
      for (const q of corners) {
        const l = roadLocal(road, q)
        across = Math.max(across, Math.abs(l.across))
        along = Math.max(along, Math.abs(l.along))
      }
      return corners
    })
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i]!, boxes[j]!)) overlaps++
  }
  return { across, along, overlaps, turn, road }
}

describe('the open road', () => {
  it('vehicle boxes are the built meshes', () => {
    for (const [id, b] of Object.entries(VEHICLE_BOXES)) {
      const g = buildAsset(id).group
      g.updateMatrixWorld(true)
      const bb = new THREE.Box3().setFromObject(g)
      expect(Math.abs(bb.max.x - b.hw), id).toBeLessThan(0.02)
      expect(Math.abs(-bb.min.x - b.hw), id).toBeLessThan(0.02)
      expect(Math.abs(bb.max.y - b.h), id).toBeLessThan(0.02)
      expect(Math.abs(-bb.min.z - b.front), id).toBeLessThan(0.02)
      expect(Math.abs(bb.max.z - b.back), id).toBeLessThan(0.02)
    }
  })

  it('lays the same street for the same length, as long as asked, closed at both ends', () => {
    expect(roadLayout(150)).toEqual(roadLayout(150))
    expect(roadLength({ length: 5 })).toBe(40)
    expect(roadLength(undefined)).toBe(120)
    const boxes = roadLayout(150)
    const asphalt = boxes.find((b) => b.part === 'asphalt')!
    expect(asphalt.d).toBeCloseTo(150 + 2 * ROAD_END, 6)
    expect(asphalt.w).toBeCloseTo(2 * ROAD_KERB, 6)
    // Nothing stands in the street along the asphalt; the end blocks close it beyond.
    for (const b of boxes.filter((x) => x.part === 'building')) {
      const inStreet = Math.abs(b.x) - b.w / 2 < ROAD_WALK - 0.2
      if (inStreet) expect(Math.abs(b.z) - b.d / 2).toBeGreaterThanOrEqual(150 / 2 + ROAD_END - 0.2)
    }
    const ends = boxes.filter((b) => b.part === 'building' && Math.abs(b.x) < 1 && b.w > 2 * ROAD_WALK)
    expect(new Set(ends.map((b) => Math.sign(b.z))).size).toBe(2)
    // Each side's front row runs the whole street.
    for (const side of [-1, 1]) {
      const row = boxes.filter((b) => b.part === 'building' && Math.sign(b.x) === side && Math.abs(b.x) < 20 && b.w < 20 && b.h > 5)
      expect(Math.min(...row.map((b) => b.z - b.d / 2))).toBeLessThanOrEqual(-(150 / 2 + ROAD_END) + 1e-6)
      expect(Math.max(...row.map((b) => b.z + b.d / 2))).toBeGreaterThanOrEqual(150 / 2 + ROAD_END - 1e-6)
    }
  })

  it('reads as a street for the set readers', () => {
    load(6)
    st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    const scene = st().scene()!
    const set = routineSet(scene, scene.blocking[0])
    const road = placeOf(roads()[0]!)
    expect(set.streets.some((r) => Math.abs(Math.max(r.hx, r.hz) * 2 - (road.length + 2 * ROAD_END)) < 0.1 && Math.abs(Math.min(r.hx, r.hz) * 2 - 2 * ROAD_KERB) < 0.1)).toBe(true)
    // No solid stands on the asphalt (lamp arms are overhead).
    for (const s of set.solids) {
      const l = roadLocal(road, s)
      if (Math.abs(l.along) < road.length / 2) expect(Math.abs(l.across) + 1e-6 >= ROAD_KERB || Math.max(s.hx, s.hz) > 30, s.name).toBe(true)
    }
  })
})

describe('a Library car chase on its open road', () => {
  for (const style of ['straight', 'weaving'])
    for (const count of [2, 3, 4])
      for (const duration of [6, 15])
        it(`${style}, ${count} cars, ${duration} s: every car inside the kerbs on every frame`, () => {
          load(duration)
          st().spawnSequence({ type: 'carChase', count, style, origin: { x: 3, z: -2, heading: 0.4 } })
          expect(roads()).toHaveLength(1)
          expect(cars()).toHaveLength(count)
          const r = drive()
          expect(r.across).toBeLessThanOrEqual(ROAD_KERB)
          // On the drivable length, with room left past the last car and the lead.
          expect(r.along).toBeLessThanOrEqual(r.road.length / 2 - 39)
          expect(r.overlaps).toBe(0)
          // A smooth line: no heading snap (at most 2° a frame).
          expect((r.turn * 180) / Math.PI).toBeLessThan(2)
        })

  it('stages the cars and the road as one undo step, the road unselected', () => {
    load(6)
    st().mutate('setup', () => {}) // ends any coalescing run with the previous test's staging
    st().spawnSequence({ type: 'carChase', count: 3, style: 'weaving', origin: { x: 0, z: 0, heading: 0 } })
    const sel = st().selection
    expect(sel?.kind === 'entities' ? sel.entityIds.length : 0).toBe(3)
    st().undo()
    expect(st().scene()!.entities).toHaveLength(0)
  })

  it('placed on an open road, runs along it and lengthens it', () => {
    load(6)
    st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    const before = placeOf(roads()[0]!)
    const firstCars = new Set(cars().map((c) => c.id))
    st().mutate('longer shot', (doc) => {
      doc.scenes[0]!.shots[0]!.duration = 15
    })
    // Clicked 3 m off the road's centre line, 20 m along it, facing almost back along it.
    const at = { x: before.x + Math.cos(before.heading) * 3 - Math.sin(before.heading) * 20, z: before.z - Math.sin(before.heading) * 3 - Math.cos(before.heading) * 20 }
    st().spawnSequence({ type: 'carChase', count: 2, style: 'weaving', origin: { ...at, heading: before.heading + Math.PI - 0.3 } })
    expect(roads()).toHaveLength(1)
    const after = placeOf(roads()[0]!)
    expect(after.heading).toBeCloseTo(before.heading, 9)
    expect(after.length).toBeGreaterThan(before.length)
    // The new chase drives along the road's centre line, inside the kerbs, on its drivable length.
    const ev = new ShotEvaluator(st().scene()!, st().shot()!)
    for (let f = 0; f <= 15 * FPS; f++) {
      const s = ev.evaluate(f / FPS)
      for (const c of cars().filter((x) => !firstCars.has(x.id))) {
        const es = s.entities.find((x) => x.entityId === c.id)!
        for (const q of vehicleCorners(vehicleBox(c.assetId)!, es.position, es.heading)) {
          const l = roadLocal(after, q)
          expect(Math.abs(l.across)).toBeLessThanOrEqual(ROAD_KERB)
          expect(Math.abs(l.along)).toBeLessThanOrEqual(after.length / 2)
        }
      }
    }
  })
})
