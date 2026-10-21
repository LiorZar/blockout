// Fork addition (2026): the store keeps a bot fight's solution: reading a fight solves nothing, an edit to its inputs solves again (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocapClips } from '@engine/mocap/clip'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { parseFightScript } from '@engine/fight/script'
import { createProject } from '@engine/schema'
import type { FightBeat, ProjectDoc, Scene } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { registerFightClips } from './mocap-fight-fixture'

const solves = vi.hoisted(() => ({ n: 0 }))
vi.mock('@engine/fight/solve', async (importOriginal) => {
  const real = await importOriginal<typeof import('@engine/fight/solve')>()
  return {
    ...real,
    solveFight: (...args: Parameters<typeof real.solveFight>) => {
      solves.n++
      return real.solveFight(...args)
    }
  }
})

const { slowFight, slowRoutine, solveInScene, useStore } = await import('@renderer/store')

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const beatsOf = (text: string): FightBeat[] => (parseFightScript(text, ['A', 'B']) as { beats: FightBeat[] }).beats

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerFightClips(MALE)
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

beforeEach(() => {
  const doc: ProjectDoc = createProject('Bots')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = 8
  useStore.setState({ doc, sceneId: scene.id, shotId: scene.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
})

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!

describe('a bot fight in the store', { timeout: 30_000 }, () => {
  it('is read back without solving again; each read is its own copy', () => {
    const { fightId, report } = st().stageFight({ beats: beatsOf('A jab to head -> hit\nB jab to head -> block'), at: { x: 0, z: 0, heading: 0 }, assets: [MALE, FEMALE] })
    const fight = scene().fights!.find((f) => f.id === fightId)!
    const n = solves.n
    const first = solveInScene(scene(), st().shot()!, fight)
    expect(solves.n).toBe(n)
    expect(first.report).toEqual(report)
    first.report.warnings.push('scribbled on')
    first.tracks[0]![0]!.time = 99
    const again = solveInScene(scene(), st().shot()!, fight)
    expect(solves.n).toBe(n)
    expect(again.report).toEqual(report)
    expect(again.tracks[0]![0]!.time).toBe(0)
  })

  it('a library loaded after the first solve solves again (the clip registry is in the key)', () => {
    clearMocapClips()
    const { fightId, report } = st().stageFight({ beats: beatsOf('A jab to head -> hit'), at: { x: 0, z: 0, heading: 0 }, assets: [MALE, FEMALE] })
    expect(report.beats[0]!.plays.startsWith('mocap:')).toBe(false)
    const fight = scene().fights!.find((f) => f.id === fightId)!
    registerFightClips(MALE)
    const n = solves.n
    const after = solveInScene(scene(), st().shot()!, fight)
    expect(solves.n).toBe(n + 1)
    expect(after.report.beats[0]!.plays.startsWith('mocap:')).toBe(true)
  })

  it('solves again when an input changes: a fighter moved, the script, the shot length', () => {
    const { fightId } = st().stageFight({ beats: beatsOf('A jab to head -> hit'), at: { x: 0, z: 0, heading: 0 }, assets: [MALE, FEMALE] })
    const fight = (): NonNullable<Scene['fights']>[number] => scene().fights!.find((f) => f.id === fightId)!
    const a = fight().fighterIds[0]!
    let n = solves.n
    st().mutate('move fighter', (doc) => {
      doc.scenes[0]!.entities.find((e) => e.id === a)!.transform.position.x += 0.2
    })
    solveInScene(scene(), st().shot()!, fight())
    expect(solves.n).toBe(n + 1)
    n = solves.n
    solveInScene(scene(), st().shot()!, { ...fight(), beats: beatsOf('A jab to head -> block') })
    expect(solves.n).toBe(n + 1)
    n = solves.n
    solveInScene(scene(), { ...st().shot()!, duration: 9 }, fight())
    expect(solves.n).toBe(n + 1)
  })

  it('a fight with a loaded bot is slow to solve (the app says so first); people and mannequins are not', () => {
    expect(slowFight({ beats: [], assets: [MALE, 'person.woman'] })).toBe(true)
    expect(slowFight({ beats: [] })).toBe(false)
    expect(slowFight({ beats: [], assets: ['person.mannequinMale', 'person.mannequinFemale'] })).toBe(false)
    const { fightId } = st().stageFight({ beats: beatsOf('A jab to head -> hit'), at: { x: 0, z: 0, heading: 0 }, assets: [MALE, FEMALE] })
    expect(slowFight({ fightId })).toBe(true)
  })

  it('a routine fight with a bot says so first and stages after a frame; with people it stages at once, no notice', async () => {
    const add = (assetId: string, x: number): string => {
      st().addEntity(assetId, { x, y: 0, z: 0 })
      return scene().entities[scene().entities.length - 1]!.id
    }
    const spec = { kind: 'fight' as const, performers: 2, durationS: 6, seed: 4, style: 'sparring', ending: 'finish' as const }
    expect(slowRoutine({ ...spec, bodies: [MALE, 'person.woman'] })).toBe(true)
    expect(slowRoutine(spec)).toBe(false)
    expect(slowRoutine({ ...spec, kind: 'dance' }, [])).toBe(false)
    const notices = (): number => st().toasts.filter((t) => t.text === 'Staging fight…').length
    // People: synchronous, no notice.
    const [m, w] = [add('person.man', -0.6), add('person.woman', 0.6)]
    st().setSelection({ kind: 'entities', entityIds: [m, w] })
    st().choreographSelected(spec)
    expect(scene().fights?.length).toBe(1)
    expect(notices()).toBe(0)
    // Bots: the notice first, the fight once a frame has gone by.
    const [a, b] = [add(MALE, 3), add(FEMALE, 4.2)]
    expect(slowRoutine(spec, [a, b])).toBe(true)
    st().setSelection({ kind: 'entities', entityIds: [a, b] })
    st().choreographSelected(spec)
    expect(notices()).toBe(1)
    expect(scene().fights?.length).toBe(1)
    await new Promise((r) => setTimeout(r, 120))
    expect(scene().fights?.length).toBe(2)
  })

  it('a two-performer fight sequence with Mocap bodies stages two bots, saying so first', async () => {
    const before = st().toasts.filter((t) => t.text === 'Staging fight…').length
    const notices = (): number => st().toasts.filter((t) => t.text === 'Staging fight…').length - before
    st().spawnSequence({ type: 'fight', count: 2, style: 'paired', bodies: [MALE, FEMALE] })
    expect(notices()).toBe(1)
    expect(scene().fights ?? []).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 120))
    const fight = scene().fights![0]!
    expect(fight.fighterIds.map((id) => scene().entities.find((e) => e.id === id)!.assetId)).toEqual([MALE, FEMALE])
    // With people it stages at once, no notice.
    st().spawnSequence({ type: 'fight', count: 2, style: 'paired' })
    expect(scene().fights).toHaveLength(2)
    expect(notices()).toBe(1)
  })
})
