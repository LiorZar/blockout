// Fork test (fix-routines, docs/plans/2026-10-20-fix-routines.md): the Choreographer's Duration is the routine's length.
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { buildRoutine, type RoutineSpec } from '@engine/choreography'
import { createEntity, createProject } from '@engine/schema'
import type { ProjectDoc, Scene } from '@engine/types'

function load(shotDuration: number): void {
  const doc: ProjectDoc = createProject('Duration')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = shotDuration
  useStore.setState({ doc, sceneId: scene.id, shotId: scene.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!
const lastMarkTime = (): number =>
  Math.max(...scene().blocking[0]!.tracks.flatMap((t) => t.marks.map((m) => m.time)))
const spec = (over: Partial<RoutineSpec>): RoutineSpec => ({ kind: 'chase', performers: 2, durationS: 8, seed: 5, ...over })

describe('Choreographer Duration (fix-routines)', () => {
  beforeEach(() => load(5))

  it('a chase of Duration 8 on a 5 s shot runs 8 s and the shot grows to 8 s', () => {
    st().spawnChoreography(spec({}), { x: 0, z: 0, heading: 0 })
    expect(st().shot()!.duration).toBe(8)
    expect(lastMarkTime()).toBeCloseTo(8, 6)
  })

  it('a dance of Duration 8 on a 5 s shot ends on its freeze at 8 s', () => {
    st().spawnChoreography(spec({ kind: 'dance', performers: 6 }), { x: 0, z: 0, heading: 0 })
    expect(st().shot()!.duration).toBe(8)
    expect(lastMarkTime()).toBeCloseTo(8, 6)
  })

  it('one undo puts the shot length and the cast back', () => {
    st().spawnChoreography(spec({}), { x: 0, z: 0, heading: 0 })
    st().undo()
    expect(st().shot()!.duration).toBe(5)
    expect(scene().entities.length).toBe(0)
  })

  it('a longer shot is never shortened', () => {
    load(10)
    st().spawnChoreography(spec({ durationS: 4 }), { x: 0, z: 0, heading: 0 })
    expect(st().shot()!.duration).toBe(10)
    expect(lastMarkTime()).toBeCloseTo(4, 6)
  })

  it('Apply to selection uses the Duration too', () => {
    const a = createEntity('person.man', 'A', { x: 0, y: 0, z: 0 })
    const b = createEntity('person.woman', 'B', { x: 1.4, y: 0, z: 0 })
    st().mutate('cast', (doc) => doc.scenes[0]!.entities.push(a, b))
    st().choreographEntities([a.id, b.id], spec({ durationS: 7 }))
    expect(st().shot()!.duration).toBe(7)
    expect(lastMarkTime()).toBeCloseTo(7, 6)
  })

  it('a dance never runs past its Duration (whole phrases are cut at the end)', () => {
    for (const durationS of [5, 6.3, 8, 12]) {
      const routine = buildRoutine(spec({ kind: 'dance', performers: 4, durationS }), { origin: { x: 0, z: 0, heading: 0 } })
      const last = Math.max(...routine.flatMap((p) => p.marks.map((m) => m.time)))
      expect(last, `dance ${durationS} s`).toBeLessThanOrEqual(durationS + 1e-9)
    }
  })
})
