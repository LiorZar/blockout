// Fork addition (main-thread, 2026): a fight's camera coverage (each framing's clear view, camera-clear.ts) is
// remembered by everything it reads, so the store's two runs of an action (offThread's planning run and the real one)
// work it out once, and the fight worker can work it out instead; see MODIFICATIONS.md.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '@engine/schema'
import { parseFightScript } from '@engine/fight/script'
import type { FightBeat, ProjectDoc } from '@engine/types'

const covers = vi.hoisted(() => ({ n: 0 }))
vi.mock('@engine/fight/coverage-clear', async (importOriginal) => {
  const real = await importOriginal<typeof import('@engine/fight/coverage-clear')>()
  return {
    ...real,
    clearCoverage: (...args: Parameters<typeof real.clearCoverage>) => {
      covers.n++
      return real.clearCoverage(...args)
    }
  }
})

const { clearCoverage } = await import('@engine/fight/coverage-clear')
const { clearCoverageMemo, coverageKey } = await import('@engine/fight/coverage-memo')
const { useStore, solveInScene } = await import('@renderer/store')
const { setBoxes } = await import('@renderer/camera-view')

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const SCRIPT = 'A jab cross to head -> block, hit\nB front kick to body -> hit\nA hook to head -> block'

/** A fight among the gym's kit, and the arguments of its master coverage. */
function args(): Parameters<typeof clearCoverage> {
  const doc: ProjectDoc = createProject('Coverage memo')
  const sc0 = doc.scenes[0]!
  sc0.shots[0]!.duration = 8
  useStore.setState({ doc, sceneId: sc0.id, shotId: sc0.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
  st().addEntity('env.gym', { x: 0, y: 0, z: 0 })
  const beats = (parseFightScript(SCRIPT, ['BRUNO', 'KIRA']) as { beats: FightBeat[] }).beats
  const { fightId } = st().stageFight({ beats, at: { x: 0, z: -2, heading: 0 }, assets: ['person.man', 'person.woman'], labels: ['BRUNO', 'KIRA'] })
  const sc = st().scene()!
  const sh = st().shot()!
  const fight = sc.fights!.find((f) => f.id === fightId)!
  const report = solveInScene(sc, sh, fight).report
  return [sc, sh, fight, report, 'punch-in', 1, { reach: [0, 0], focalLength: 35, boxes: setBoxes(sc, sh) }]
}

describe('remembered fight coverage', { timeout: 60_000 }, () => {
  beforeEach(() => {
    covers.n = 0
  })

  it('works a coverage out once for the same inputs, each caller its own copy, equal to working it out', () => {
    const a = args()
    const first = clearCoverageMemo(...a)
    expect(covers.n).toBe(1)
    first[0]!.shot.size = 'ECU'
    first[0]!.time = 99
    const again = clearCoverageMemo(...structuredClone(a))
    expect(covers.n).toBe(1)
    expect(again[0]!.shot.size).not.toBe('ECU')
    expect(JSON.stringify(again)).toBe(JSON.stringify(clearCoverage(...a)))
  })

  it('works it out again when the shot, the set, the mode, the side or the lens change', () => {
    const a = args()
    clearCoverageMemo(...a)
    let n = covers.n
    const [sc, sh, fight, report, mode, side, input] = a
    clearCoverageMemo(sc, { ...sh, fps: 30 }, fight, report, mode, side, input)
    expect(covers.n).toBe(++n)
    clearCoverageMemo(sc, sh, fight, report, mode, side, { ...input, boxes: input.boxes.slice(1) })
    expect(covers.n).toBe(++n)
    clearCoverageMemo(sc, sh, fight, report, 'master', side, input)
    expect(covers.n).toBe(++n)
    clearCoverageMemo(sc, sh, fight, report, mode, -1, input)
    expect(covers.n).toBe(++n)
    clearCoverageMemo(sc, sh, fight, report, mode, side, { ...input, focalLength: 50 })
    expect(covers.n).toBe(++n)
    expect(coverageKey(...a)).toBe(coverageKey(...structuredClone(a)))
  })

  it("the fight's marks laid again with fresh ids (an action's next run) read the same coverage", () => {
    const a = args()
    const b = structuredClone(a)
    for (const take of b[0].blocking) for (const tr of take.tracks) for (const m of tr.marks) m.id = `${m.id}-again`
    for (const m of b[1].camera.marks) m.id = `${m.id}-again`
    expect(b[0].blocking.some((take) => take.tracks.some((tr) => tr.marks.length > 0))).toBe(true)
    expect(coverageKey(...b)).toBe(coverageKey(...a))
    b[0].blocking[0]!.tracks.find((tr) => tr.marks.length > 0)!.marks[0]!.time += 0.01
    expect(coverageKey(...b)).not.toBe(coverageKey(...a))
  })

  it("the store's coverage reads it: a second identical coverage works nothing out", () => {
    const a = args()
    const fightId = a[2].id
    const before = st().doc
    st().coverFight(fightId, 'punch-in', 'right')
    const marks = JSON.stringify(st().shot()!.camera.marks.map(({ id: _id, ...m }) => m))
    const n = covers.n
    // The same document again (as offThread's real run follows its planning run).
    useStore.setState({ doc: before })
    st().coverFight(fightId, 'punch-in', 'right')
    expect(covers.n).toBe(n)
    expect(JSON.stringify(st().shot()!.camera.marks.map(({ id: _id, ...m }) => m))).toBe(marks)
  })
})
