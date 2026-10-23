// Fork test (street-kit, docs/plans/2026-10-23-street-kit.md): speed warnings that know what a car can do. A car's
// marks that ask for an implausible top speed, launch, stop or corner warn once each, as does a follow camera that
// can't keep up with its subject on its rig; the Library car chase stages with none; people keep the gait check.
import { describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { ShotEvaluator, type SpeedWarning } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import type { ActorMark, CameraMark, ProjectDoc, RigId } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()

const mark = (id: string, time: number, x: number, z: number, o: Partial<ActorMark> = {}): ActorMark => ({
  id,
  time,
  hold: 0,
  easeIn: 0,
  easeOut: 0,
  position: { x, y: 0, z },
  gait: 'run',
  ...o
})

const cam = (id: string, time: number, z: number): CameraMark => ({
  id,
  time,
  hold: 0,
  easeIn: 0,
  easeOut: 0,
  position: { x: 4, y: 1.6, z },
  pan: 0,
  tilt: 0,
  roll: 0,
  focalLength: 35
})

/** The warnings of a shot with one actor on `marks` (and optionally the camera on `camMarks`, tracking it). */
function warn(assetId: string, marks: ActorMark[], duration = 6, camera?: { marks: CameraMark[]; rig: RigId }): SpeedWarning[] {
  const doc: ProjectDoc = createProject('Speed')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = duration
  const e = createEntity(assetId, 'CAR', { ...marks[0]!.position })
  e.label = { text: 'CAR', color: '#e04040' }
  sc.entities.push(e)
  sc.blocking[0]!.tracks.push({ entityId: e.id, marks })
  if (camera) {
    sc.shots[0]!.camera.marks = camera.marks
    sc.shots[0]!.camera.rig = camera.rig
    sc.shots[0]!.camera.trackEntityId = e.id
  }
  return new ShotEvaluator(sc, sc.shots[0]!).warnings()
}

const text = (ws: SpeedWarning[]): string => ws.map((w) => w.message ?? '').join(' | ')

describe('vehicle speed warnings', () => {
  it('a car asked to go faster than a car can', () => {
    const ws = warn('vehicle.sedan', [mark('a', 0, 0, 0), mark('b', 6, 0, -540)])
    expect(ws).toHaveLength(1)
    expect(ws[0]!.message).toMatch(/90 m\/s .*top speed/)
  })

  it('a car that leaps from standing to speed', () => {
    // The shot ends as it arrives (no stop in the shot).
    const ws = warn('vehicle.sedan', [mark('a', 2, 0, 0, { gait: 'stand' }), mark('b', 4, 0, -30)], 4)
    expect(ws).toHaveLength(1)
    expect(ws[0]!.message).toMatch(/speeds up/)
    expect(ws[0]!.toMarkId).toBe('b')
  })

  it('a car that stops dead', () => {
    const ws = warn('vehicle.sedan', [mark('a', 0, 0, 0), mark('b', 2, 0, -30, { hold: 4 })])
    expect(ws).toHaveLength(1)
    expect(ws[0]!.message).toMatch(/brakes/)
  })

  it('a car that turns a hard corner at speed', () => {
    const ws = warn('vehicle.sedan', [mark('a', 0, 0, 0), mark('b', 2, 0, -30), mark('c', 4, -30, -30)], 4)
    expect(text(ws)).toMatch(/corners/)
    expect(ws.every((w) => /corners/.test(w.message ?? ''))).toBe(true)
  })

  it('an eased start, stop and a wide turn are fine', () => {
    expect(warn('vehicle.sedan', [mark('a', 0, 0, 0, { easeOut: 1 }), mark('b', 6, 0, -45, { easeIn: 1 })])).toHaveLength(0)
    const arc = Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * (Math.PI / 2)
      return { x: -40 + 40 * Math.cos(a), y: 0, z: -40 * Math.sin(a) }
    })
    expect(warn('vehicle.sedan', [mark('a', 0, 0, 0), mark('b', 6, arc[12]!.x, arc[12]!.z, { via: arc.slice(1, 12) })])).toHaveLength(0)
  })

  it('a follow camera that can not keep up on its rig', () => {
    const car = [mark('a', 0, 0, 0), mark('b', 6, 0, -90)]
    const follow = [cam('c0', 0, 6), cam('c1', 6, -84)]
    const ws = warn('vehicle.sedan', car, 6, { marks: follow, rig: 'sticks' })
    expect(ws).toHaveLength(1)
    expect(ws[0]!.entityId).toBe('camera')
    expect(ws[0]!.message).toMatch(/can't keep up/)
    expect(warn('vehicle.sedan', car, 6, { marks: follow, rig: 'carMount' })).toHaveLength(0)
    expect(warn('vehicle.sedan', car, 6, { marks: follow, rig: 'drone' })).toHaveLength(0)
  })

  it('people keep the gait check', () => {
    const ws = warn('person.man', [mark('a', 0, 0, 0, { gait: 'walk' }), mark('b', 2, 0, -20, { gait: 'walk' })])
    expect(ws).toHaveLength(1)
    expect(ws[0]!.verdict.kind).toBe('tooFast')
    expect(ws[0]!.message).toBeUndefined()
  })
})

describe('the Library car chase', () => {
  for (const style of ['straight', 'weaving'])
    for (const count of [2, 3, 4])
      for (const duration of [6, 15])
        it(`${style}, ${count} cars, ${duration} s: stages with no warning`, () => {
          const doc: ProjectDoc = createProject('Chase')
          const sc = doc.scenes[0]!
          sc.shots[0]!.duration = duration
          useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
          st().spawnSequence({ type: 'carChase', count, style, origin: { x: 0, z: 0, heading: 0.3 } })
          expect(new ShotEvaluator(st().scene()!, st().shot()!).warnings().map((w) => w.message ?? w.verdict.kind)).toEqual([])
        })
})
