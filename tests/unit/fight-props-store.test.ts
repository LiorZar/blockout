// Fork test (gap 8, docs/plans/2026-10-19-fix-fight.md): the store gives fights the set's props.
import { beforeEach, describe, expect, it } from 'vitest'
import { solveInScene, useStore } from '@renderer/store'
import { fightObstacles } from '@renderer/fight-obstacles'
import { boxDistance, pathCrossings } from '@engine/fight/obstacles'
import { createEntity, createProject } from '@engine/schema'
import { parseFightScript } from '@engine/fight/script'
import type { FightBeat, ProjectDoc, Scene } from '@engine/types'

const SWORD_BAT = `A slash to head -> parry, hit
B swing to body -> block, hit power 1
A thrust to body -> hit`
const beatsOf = (text: string): FightBeat[] => (parseFightScript(text, ['A', 'B']) as { beats: FightBeat[] }).beats

function load(withGym: { x: number; z: number; rotationY: number } | null = { x: 0, z: 0, rotationY: 0 }): void {
  const doc: ProjectDoc = createProject('Props')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = 14
  if (withGym) {
    const gym = createEntity('env.gym', 'Gym', { x: withGym.x, y: 0, z: withGym.z })
    gym.transform.rotationY = withGym.rotationY
    scene.entities.push(gym)
  }
  useStore.setState({ doc, sceneId: scene.id, shotId: scene.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!
const near = (x: number, z: number): boolean => fightObstacles(scene(), scene().blocking[0]).some((o) => boxDistance(o, { x, z }) < 1e-6)
const PROP = /stopped at|runs into/

describe('set props in the store (gap 8)', () => {
  beforeEach(() => load())

  it("reads the gym kit's benches, rack posts and walls off its geometry", () => {
    for (const x of [-6, -3, 0]) expect(near(x, 0), `bench at x ${x}`).toBe(true)
    for (const x of [3.4, 4.6, 6.4, 7.6]) expect(near(x, 2), `post at x ${x}`).toBe(true)
    expect(near(-10, 0) && near(10, 0) && near(0, 10)).toBe(true)
    // Open floor between the props is clear.
    expect(near(0, -4)).toBe(false)
    expect(near(-1.5, 0)).toBe(false)
  })

  it('moves and turns the footprints with the kit', () => {
    load({ x: 5, z: 0, rotationY: Math.PI / 2 })
    expect(near(5, 0)).toBe(true)
    expect(near(5, 6)).toBe(true)
    expect(near(-1, 0)).toBe(false)
  })

  it('a fight staged on top of a bench moves to the nearest clear spot and says so', () => {
    const { report } = st().stageFight({ beats: beatsOf(SWORD_BAT), at: { x: 0, z: 0, heading: 0 }, weapons: ['prop.sword', 'prop.baseballBat'] })
    expect(report.warnings.some((w) => /Moved the fight/.test(w)), report.warnings.join('\n')).toBe(true)
    expect(report.warnings.filter((w) => PROP.test(w))).toEqual([])
    const fight = scene().fights![0]!
    const sol = solveInScene(scene(), st().shot()!, fight)
    const obstacles = fightObstacles(scene(), scene().blocking[0])
    expect(pathCrossings(sol.paths, obstacles)).toEqual([])
    expect(Math.hypot(fight.origin.x, fight.origin.z)).toBeLessThanOrEqual(3 + 1e-9)
  })

  it('fighters placed across a bench keep their spots and the report warns', () => {
    const a = createEntity('person.man', 'A', { x: -0.6, y: 0, z: 0 })
    const b = createEntity('person.woman', 'B', { x: 0.6, y: 0, z: 0 })
    st().mutate('cast', (doc) => doc.scenes[0]!.entities.push(a, b))
    const { report } = st().stageFight({ beats: beatsOf(SWORD_BAT), at: { x: 0, z: 0, heading: 0 }, fighters: [a.id, b.id] })
    expect(report.warnings.some((w) => PROP.test(w))).toBe(true)
    expect(scene().entities.find((e) => e.id === a.id)!.transform.position.x).toBe(-0.6)
  })

  it('a fight on open floor is left where it was put', () => {
    const { report } = st().stageFight({ beats: beatsOf(SWORD_BAT), at: { x: 0, z: -5, heading: 0 } })
    expect(report.warnings.filter((w) => PROP.test(w) || /Moved the fight/.test(w))).toEqual([])
    expect(scene().fights![0]!.origin).toEqual({ x: 0, z: -5, heading: 0 })
  })
})

describe('qa-clara bugs 2 and 3 (store)', () => {
  beforeEach(() => load(null))

  it('the scene solve (get_fight) gives the same report as stage_fight for a rifle fight', () => {
    const { fightId, report } = st().stageFight({ beats: beatsOf('A shoot to body -> hit'), at: { x: 0, z: 0, heading: 0 }, weapons: ['prop.rifle', null] })
    expect(report.beats).toHaveLength(1)
    const again = solveInScene(scene(), st().shot()!, scene().fights!.find((f) => f.id === fightId)!).report
    expect(again.warnings).toEqual(report.warnings)
    expect(again.beats.map((b) => [b.impactTimes, b.contactErrorM])).toEqual(report.beats.map((b) => [b.impactTimes, b.contactErrorM]))
  })

  it('over-shoulder coverage of katana vs spear frames every beat wide, on the line', () => {
    st().stageFight({
      beats: beatsOf('A slash to head -> parry, hit\nB thrust to body -> block, hit power 1\nA slash to body -> ko power 1'),
      at: { x: 0, z: 0, heading: 0 },
      weapons: ['prop.katana', 'prop.spear'],
      coverage: 'over-shoulder'
    })
    const marks = st().shot()!.camera.marks
    expect(marks.length).toBeGreaterThan(0)
    for (const m of marks) expect(m.shot).toMatchObject({ size: 'WS', side: 'line' })
  })
})
