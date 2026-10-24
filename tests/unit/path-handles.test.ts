/**
 * Fork (Lior's test, 2026-10-24): a mark's curve handle (MarkBase.handle)
 * bends the legs at that mark (src/engine/path.ts PathHandles, evaluate.ts
 * buildLegs). A handle equal to the leg's own control point changes nothing,
 * so marks without one travel exactly as before.
 */

import { describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { Path, autoHandles, headingOf } from '@engine/path'
import { createActorMark, createCameraMark, createEntity, createProject } from '@engine/schema'
import type { ActorMark, V3 } from '@engine/types'

const A: V3 = { x: 0, y: 0, z: 0 }
const B: V3 = { x: 0, y: 0, z: -10 }

function maxGap(a: Path, b: Path): number {
  const pa = a.polyline()
  const pb = b.polyline()
  expect(pa.length).toBe(pb.length)
  let gap = 0
  for (let i = 0; i < pa.length; i++) {
    gap = Math.max(gap, Math.hypot(pa[i]!.x - pb[i]!.x, pa[i]!.y - pb[i]!.y, pa[i]!.z - pb[i]!.z))
  }
  return gap
}

/** Signed angle between two headings, wrapped to (-π, π]. */
function turn(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a))
}

describe('a leg with handles (Path)', () => {
  it('a handle equal to the automatic one is the same curve, with or without via points', () => {
    for (const points of [
      [A, B],
      [A, { x: 4, y: 0, z: -3 }, { x: -2, y: 1, z: -7 }, B]
    ]) {
      const plain = new Path(points)
      const auto = autoHandles(points)
      expect(maxGap(plain, new Path(points, undefined, { out: auto.out, in: auto.in }))).toBeLessThan(1e-9)
      expect(maxGap(plain, new Path(points, undefined, { out: auto.out }))).toBeLessThan(1e-9)
      expect(maxGap(plain, new Path(points, undefined, { in: auto.in }))).toBeLessThan(1e-9)
    }
  })

  it('an unset leg between two marks stays straight', () => {
    const path = new Path([A, B])
    for (const p of path.polyline()) expect(Math.abs(p.x)).toBeLessThan(1e-9)
  })

  it('leaves along the departure handle and arrives along the arrival handle', () => {
    const out: V3 = { x: 4, y: 0, z: -2 }
    const into: V3 = { x: -3, y: 0, z: -3 }
    const path = new Path([A, B], undefined, { out, in: into })
    expect(path.pointAt(path.length / 2).x).toBeGreaterThan(0.5) // bent off the straight line
    expect(Math.abs(turn(path.headingAt(0), headingOf(out)))).toBeLessThan(0.05)
    expect(Math.abs(turn(path.headingAt(path.length), headingOf(into)))).toBeLessThan(0.05)
    expect(path.pointAt(0).z).toBeCloseTo(0, 9)
    expect(path.pointAt(path.length).z).toBeCloseTo(-10, 9)
  })
})

describe('mark handles in the evaluator', () => {
  function fixture(handle?: V3): { ev: ShotEvaluator; entityId: string } {
    const doc = createProject('Test')
    const scene = doc.scenes[0]!
    const shot = scene.shots[0]!
    shot.duration = 10
    const entity = createEntity('person.man', 'Man', A)
    scene.entities.push(entity)
    const marks: ActorMark[] = [
      createActorMark(A, 0, 'walk'),
      createActorMark(B, 5, 'walk'),
      createActorMark({ x: 10, y: 0, z: -10 }, 10, 'walk')
    ]
    for (const m of marks) {
      m.easeIn = 0
      m.easeOut = 0
    }
    if (handle) marks[1]!.handle = handle
    scene.blocking[0]!.tracks.push({ entityId: entity.id, marks })
    return { ev: new ShotEvaluator(scene, shot), entityId: entity.id }
  }
  const at = (ev: ShotEvaluator, id: string, t: number) => ev.evaluate(t).entities.find((e) => e.entityId === id)!

  it('without a handle the legs corner at the mark, as before', () => {
    const { ev, entityId } = fixture()
    expect(Math.abs(turn(at(ev, entityId, 4.99).heading, at(ev, entityId, 5.01).heading))).toBeGreaterThan(1.4)
    expect(at(ev, entityId, 2.5).position.x).toBeCloseTo(0, 6)
  })

  it('a handle turns the corner into a smooth curve through the mark', () => {
    const handle: V3 = { x: 2, y: 0, z: -2 }
    const { ev, entityId } = fixture(handle)
    // The heading is read off the leg's sampled chords (32 a segment): the
    // last chord in and the first chord out sit either side of the handle.
    const before = at(ev, entityId, 4.99).heading
    const after = at(ev, entityId, 5.01).heading
    expect(Math.abs(turn(before, after))).toBeLessThan(0.15)
    expect(Math.abs(turn(before, headingOf(handle)))).toBeLessThan(0.08)
    expect(Math.abs(turn(after, headingOf(handle)))).toBeLessThan(0.08)
    const pass = at(ev, entityId, 5)
    expect(pass.position.x).toBeCloseTo(0, 6)
    expect(pass.position.z).toBeCloseTo(-10, 6)
    // The lead-in swings out to meet the handle: off the old straight line.
    expect(Math.abs(at(ev, entityId, 4).position.x)).toBeGreaterThan(0.05)
  })

  it('bends the camera path too', () => {
    const doc = createProject('Test')
    const scene = doc.scenes[0]!
    const shot = scene.shots[0]!
    shot.duration = 4
    const c1 = createCameraMark({ x: 0, y: 1.6, z: 0 }, 0, 0, 0, 35)
    const c2 = createCameraMark({ x: 0, y: 1.6, z: -8 }, 4, 0, 0, 35)
    c1.easeIn = c1.easeOut = c2.easeIn = c2.easeOut = 0
    c1.handle = { x: 3, y: 0, z: -1 }
    shot.camera.marks.push(c1, c2)
    const ev = new ShotEvaluator(scene, shot)
    expect(ev.evaluate(2).camera.position.x).toBeGreaterThan(0.5)
    const line = ev.paths().find((p) => p.entityId === 'camera')!
    expect(Math.max(...line.points.map((p) => p.x))).toBeGreaterThan(0.5)
  })
})
