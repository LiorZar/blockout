// Fork addition (fight-speed, 2026): fight solves are remembered in the engine, by everything a solve reads: the store and the prompt share them, a reader's edits stay its own; see MODIFICATIONS.md.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocapClips } from '@engine/mocap/clip'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { parseFightScript } from '@engine/fight/script'
import type { FighterInput } from '@engine/fight/solve'
import { getProfile } from '@engine/profiles'
import { generatePrompt } from '@engine/prompt'
import { createProject } from '@engine/schema'
import type { FightBeat, FightDoc, ProjectDoc, Scene } from '@engine/types'
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

const { solveFightMemo } = await import('@engine/fight/solve-memo')
const { useStore } = await import('@renderer/store')

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const beatsOf = (text: string): FightBeat[] => (parseFightScript(text, ['A', 'B']) as { beats: FightBeat[] }).beats

function fight(script = 'A jab to head -> hit\nB jab to head -> block'): FightDoc {
  return { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: beatsOf(script), startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}
const input = (q: number, assetId = q ? FEMALE : MALE): FighterInput => ({ entityId: q ? 'b' : 'a', assetId, scale: 1, start: { x: q ? 0.55 : -0.55, y: 0, z: 0 } })
const timing = { duration: 8, fps: 24 }

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerFightClips(MALE)
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('remembered fight solves', { timeout: 30_000 }, () => {
  it('solves the same inputs once; each caller gets its own copy', () => {
    const n = solves.n
    const first = solveFightMemo(fight(), [input(0), input(1)], timing)
    expect(solves.n).toBe(n + 1)
    first.report.warnings.push('scribbled on')
    first.tracks[0]![0]!.time = 99
    const again = solveFightMemo(fight(), [input(0), input(1)], timing)
    expect(solves.n).toBe(n + 1)
    expect(again.report.warnings).not.toContain('scribbled on')
    expect(again.tracks[0]![0]!.time).toBe(0)
    expect(JSON.stringify(again.tracks)).toBe(JSON.stringify(solveFightMemo(fight(), [input(0), input(1)], timing).tracks))
  })

  it('solves again when an input, the timing, the options or the clip registry change', () => {
    solveFightMemo(fight(), [input(0), input(1)], timing)
    let n = solves.n
    solveFightMemo(fight('A jab to head -> block'), [input(0), input(1)], timing)
    expect(solves.n).toBe(++n)
    solveFightMemo(fight(), [{ ...input(0), start: { x: -0.6, y: 0, z: 0 } }, input(1)], timing)
    expect(solves.n).toBe(++n)
    solveFightMemo(fight(), [input(0), input(1)], { duration: 9, fps: 24 })
    expect(solves.n).toBe(++n)
    solveFightMemo(fight(), [input(0), input(1)], timing, { paths: true })
    expect(solves.n).toBe(++n)
    registerFightClips(MALE)
    solveFightMemo(fight(), [input(0), input(1)], timing)
    expect(solves.n).toBe(++n)
  })

  it('no props is no props: no options and an empty obstacle list are one solve', () => {
    solveFightMemo(fight('B jab to head -> hit'), [input(0), input(1)], timing)
    const n = solves.n
    solveFightMemo(fight('B jab to head -> hit'), [input(0), input(1)], timing, { obstacles: [] })
    expect(solves.n).toBe(n)
  })

  // Fork (main-thread): the solver never reads a fight's camera coverage, so a coverage mode re-solves nothing.
  it("a fight's coverage is not a solve input", async () => {
    const plain = solveFightMemo(fight('A hook to head -> hit'), [input(0), input(1)], timing)
    const n = solves.n
    for (const coverage of ['master', 'punch-in', 'over-shoulder', 'follow'] as const) {
      const covered = solveFightMemo({ ...fight('A hook to head -> hit'), coverage }, [input(0), input(1)], timing)
      expect(JSON.stringify(covered)).toBe(JSON.stringify(plain))
    }
    expect(solves.n).toBe(n)
    const { solveFight } = await import('@engine/fight/solve')
    expect(JSON.stringify(solveFight({ ...fight('A hook to head -> hit'), coverage: 'follow' }, [input(0), input(1)], timing))).toBe(JSON.stringify(plain))
  })
})

describe('the prompt of a scene with a fight', { timeout: 30_000 }, () => {
  const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
  const scene = (): Scene => st().scene()!

  beforeEach(() => {
    const doc: ProjectDoc = createProject('Bots')
    const sc = doc.scenes[0]!
    sc.shots[0]!.duration = 8
    useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
  })

  it("reads the staged fight's solve (no props), and solves nothing again on an edit elsewhere", () => {
    st().stageFight({ beats: beatsOf('A jab to head -> hit\nB hook to head -> block'), at: { x: 0, z: -2, heading: 0 }, assets: [MALE, FEMALE] })
    const n = solves.n
    const profile = getProfile('seedance-2')
    const before = generatePrompt(scene(), st().shot()!, profile)
    expect(before).toMatch(/jab/)
    st().addEntity('prop.barrel', { x: 6, y: 0, z: 6 })
    st().mutate('rename', (doc) => {
      doc.scenes[0]!.name = 'Renamed'
    })
    generatePrompt(scene(), st().shot()!, profile)
    expect(solves.n).toBe(n)
  })
})
