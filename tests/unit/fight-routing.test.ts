// Fork test (gap 3, docs/plans/2026-10-19-fix-fight.md): a two-person fight always goes through the fight solver.
import { beforeEach, describe, expect, it } from 'vitest'
import { solveInScene, useStore } from '@renderer/store'
import { createEntity, createProject } from '@engine/schema'
import { CONTACT_TOLERANCE } from '@engine/fight/solve'
import type { FightDoc, ProjectDoc, Scene } from '@engine/types'

function load(): void {
  const doc: ProjectDoc = createProject('Routing')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = 10
  useStore.setState({ doc, sceneId: scene.id, shotId: scene.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!

/** The fight is solved: blows land, and any blow the bodies can't reach is reported. */
function expectLands(fight: FightDoc): void {
  const rep = solveInScene(scene(), st().shot()!, fight).report
  expect(rep.beats.length).toBeGreaterThan(0)
  let landed = 0
  for (const b of rep.beats) {
    const outcomes = fight.beats[b.index]!.outcomes
    b.contactErrorM.forEach((e, i) => {
      const o = outcomes[outcomes.length - b.contactErrorM.length + i] ?? 'block'
      if (o !== 'hit' && o !== 'ko') return
      if (e <= CONTACT_TOLERANCE) landed++
      else expect(b.warnings.some((w) => w.includes("can't reach")), `beat ${b.index + 1} blow ${i + 1} is reported`).toBe(true)
    })
  }
  expect(landed).toBeGreaterThan(0)
}

describe('two-person fights use the fight solver (gap 3)', () => {
  beforeEach(load)

  it('spawnChoreography kind fight with 2 performers stages a solved fight (finish = KO)', () => {
    st().spawnChoreography({ kind: 'fight', performers: 2, durationS: 10, seed: 3, style: 'brawl', ending: 'finish' }, { x: 0, z: -4, heading: 0 })
    const fights = scene().fights ?? []
    expect(fights).toHaveLength(1)
    const fight = fights[0]!
    expect(scene().entities.filter((e) => e.assetId.startsWith('person.'))).toHaveLength(2)
    expect(fight.beats.at(-1)!.outcomes.at(-1)).toBe('ko')
    expectLands(fight)
  })

  it('the same seed stages the same fight', () => {
    const spec = { kind: 'fight' as const, performers: 2, durationS: 10, seed: 11, style: 'martial-arts', ending: 'sparring' }
    st().spawnChoreography(spec, { x: 0, z: 0, heading: 0 })
    const a = scene().fights![0]!.beats
    load()
    st().spawnChoreography(spec, { x: 0, z: 0, heading: 0 })
    expect(scene().fights![0]!.beats).toEqual(a)
    expect(a.flatMap((b) => b.outcomes)).not.toContain('ko')
  })

  it('choreographEntities on 2 people fights them with the solver and keeps their bodies', () => {
    const a = createEntity('person.mannequinMale', 'Red', { x: -1, y: 0, z: 0 })
    const b = createEntity('person.woman', 'Blue', { x: 1, y: 0, z: 0 })
    st().mutate('cast', (doc) => doc.scenes[0]!.entities.push(a, b))
    const applied = st().choreographEntities([a.id, b.id], { kind: 'fight', performers: 2, durationS: 10, seed: 5, style: 'sparring', ending: 'finish' })
    expect(applied).toBe(2)
    const fight = scene().fights![0]!
    expect(fight.fighterIds).toEqual([a.id, b.id])
    expect(scene().entities.map((e) => e.assetId)).toEqual(['person.mannequinMale', 'person.woman'])
    expectLands(fight)
  })

  it('a 2-performer Sequences fight is a solved fight too', () => {
    st().spawnSequence({ type: 'fight', count: 2, style: 'paired', origin: { x: 0, z: 0, heading: 0 } })
    expect(scene().fights).toHaveLength(1)
    expectLands(scene().fights![0]!)
  })

  it('bigger crowds keep the crowd brawl', () => {
    st().spawnChoreography({ kind: 'fight', performers: 4, durationS: 10, seed: 3, style: 'brawl' }, { x: 0, z: 0, heading: 0 })
    st().spawnSequence({ type: 'fight', count: 6, style: 'paired', origin: { x: 20, z: 0, heading: 0 } })
    expect(scene().fights ?? []).toHaveLength(0)
    expect(scene().entities.filter((e) => e.assetId.startsWith('person.')).length).toBeGreaterThanOrEqual(10)
  })
})
