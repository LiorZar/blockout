// Fork test (set-routines, docs/plans/2026-10-23-set-routines.md): the Choreographer reads the set off the built kits
// and its routines stay on it: QA's foot chase down the Downtown street and in the Alley, and a dance in the Alley.
import { describe, expect, it } from 'vitest'
import { lastRoutineReport, useStore } from '@renderer/store'
import { routineSet } from '@renderer/routine-set'
import { assetSpec } from '@engine/assets'
import { ShotEvaluator } from '@engine/evaluate'
import { onFloor, solidAt, type RoutineSet } from '@engine/routine-set'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { Entity, ProjectDoc, Scene, Shot } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!
const shot = (): Shot => st().shot()!

function load(kit: string, cast: Entity[] = []): void {
  const doc: ProjectDoc = createProject('Set')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = 8
  sc.entities.push(createEntity(kit, assetSpec(kit).name, { x: 0, y: 0, z: 0 }), ...cast)
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null, toasts: [] })
}

/** QA's chase cast (mocap-qa run2), on plain people. */
function qaCast(): Entity[] {
  return ([['RUNNER', 'person.woman', 0, 8], ['COP 1', 'person.man', -0.6, 10.5], ['COP 2', 'person.man', 0.6, 11.5]] as const).map(([label, asset, x, z]) => {
    const e = createEntity(asset, label, { x, y: 0, z })
    e.label = { text: label, color: '#888888' }
    return e
  })
}

/** Frames (24 fps) where someone's hips stand in a solid or off the floor. */
function offSet(set: RoutineSet): string[] {
  const ev = new ShotEvaluator(scene(), shot())
  const people = scene().entities.filter((e) => e.assetId.startsWith('person.'))
  const bad: string[] = []
  for (let f = 0; f <= 8 * 24; f++) {
    const s = ev.evaluate(f / 24)
    for (const p of people) {
      const e = s.entities.find((x) => x.entityId === p.id)!
      const h = toWorld(poseEffectors(personDims(p.assetId), e.joints, e.clip).pelvis, e.position, e.heading, 1)
      const solid = solidAt(set, h)
      if (solid || !onFloor(set, h)) bad.push(`${p.label?.text ?? p.name}@${(f / 24).toFixed(2)} ${solid?.name ?? 'off the floor'}`)
    }
  }
  return bad
}

describe('the set as the routines see it', () => {
  it('reads Downtown: its tile, its street down Z and its buildings and shop glass', () => {
    load('env.downtown')
    const set = routineSet(scene(), scene().blocking[0])
    expect(set.name).toBe('the Downtown set')
    expect(set.floors.some((f) => Math.abs(f.hx - 18) < 0.01 && Math.abs(f.hz - 18) < 0.01)).toBe(true)
    expect(set.streets).toHaveLength(1)
    expect(set.streets[0]!.hx).toBeCloseTo(4.5, 2)
    expect(set.streets[0]!.hz).toBeCloseTo(18, 2)
    expect(set.solids.some((s) => Math.abs(s.x - 11) < 0.1 && s.hz > 3.9)).toBe(true)
    expect(set.solids.filter((s) => s.hz < 0.06)).toHaveLength(8)
  })

  it('leaves the nightclub light cones and the alley fire escape out', () => {
    load('env.nightclub')
    const club = routineSet(scene(), scene().blocking[0])
    expect(club.solids.some((s) => Math.abs(Math.abs(s.x) - 5) < 0.3 && Math.abs(Math.abs(s.z) - 5) < 0.3)).toBe(false)
    load('env.alley')
    const alley = routineSet(scene(), scene().blocking[0])
    expect(alley.streets).toHaveLength(1)
    expect(alley.solids).toHaveLength(3)
  })
})

describe('routines on the set', () => {
  it("QA's Downtown chase runs down the street, on the tile, and says where it starts", () => {
    load('env.downtown', qaCast())
    const set = routineSet(scene(), scene().blocking[0])
    expect(st().choreographEntities(scene().entities.filter((e) => e.assetId.startsWith('person.')).map((e) => e.id), { kind: 'chase', performers: 3, durationS: 8, seed: 7, ending: 'caught' })).toBe(3)
    expect(offSet(set)).toEqual([])
    expect(lastRoutineReport().notes.join(' ')).toMatch(/along the street of the Downtown set/)
    expect(lastRoutineReport().warnings).toEqual([])
    expect(st().toasts.some((t) => /along the street/.test(t.text))).toBe(true)
  })

  it("QA's chase in the Alley runs as far as the alley holds at a run, then holds, and warns", () => {
    load('env.alley', qaCast())
    const set = routineSet(scene(), scene().blocking[0])
    st().choreographEntities(scene().entities.filter((e) => e.assetId.startsWith('person.')).map((e) => e.id), { kind: 'chase', performers: 3, durationS: 8, seed: 7, ending: 'caught' })
    expect(offSet(set)).toEqual([])
    expect(lastRoutineReport().warnings.join(' ')).toMatch(/The Alley set holds \d\.\d\d s of chase at a run/)
  })

  it("QA's dance turns to fit the Alley", () => {
    load('env.alley')
    const set = routineSet(scene(), scene().blocking[0])
    st().spawnChoreography({ kind: 'dance', performers: 6, durationS: 8, seed: 5, style: 'hiphop', formation: 'vShape', formationChange: true }, { x: 0, z: -1, heading: Math.PI }, true)
    expect(offSet(set)).toEqual([])
    expect(lastRoutineReport().notes.join(' ')).toMatch(/turned \d+°/)
  })
})
