// Fork addition (fight-speed, 2026): bot fights stage and re-solve with every solve off the main thread (a stand-in for the worker), to the same result as on it; see MODIFICATIONS.md.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocapClips } from '@engine/mocap/clip'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { parseFightScript } from '@engine/fight/script'
import { createProject } from '@engine/schema'
import type { FightBeat, ProjectDoc, Scene } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { registerFightClips } from './mocap-fight-fixture'

/** Solves on the main thread (through the module), and the real solver for the stand-in. */
const solves = vi.hoisted(() => ({ n: 0, real: null as null | ((...args: unknown[]) => unknown) }))
vi.mock('@engine/fight/solve', async (importOriginal) => {
  const real = await importOriginal<typeof import('@engine/fight/solve')>()
  solves.real = real.solveFight as (...args: unknown[]) => unknown
  return {
    ...real,
    solveFight: (...args: Parameters<typeof real.solveFight>) => {
      solves.n++
      return real.solveFight(...args)
    }
  }
})

const { refightShot, routineFightStaged, stageFightOffThread, updateFightOffThread, useStore } = await import('@renderer/store')
const { offThread, readSoon, setFightSolver } = await import('@renderer/fight-offthread')
const { generatePrompt } = await import('@engine/prompt')
const { getProfile } = await import('@engine/profiles')

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const beatsOf = (text: string): FightBeat[] => (parseFightScript(text, ['A', 'B']) as { beats: FightBeat[] }).beats
const remote = { n: 0 }
const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!

function fresh(duration = 8): void {
  const doc: ProjectDoc = createProject('Bots')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = duration
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

/** The take's fight tracks by fighter label, and the fights (ids left out: each staging makes its own). */
function staged(): string {
  const sc = scene()
  const take = sc.blocking.find((b) => b.id === st().shot()!.blockingTakeId)!
  const label = (id: string): string => sc.entities.find((e) => e.id === id)?.label?.text ?? id
  return JSON.stringify({
    tracks: take.tracks.map((t) => ({ who: label(t.entityId), marks: t.marks.map(({ id: _id, ...m }) => m) })),
    fights: (sc.fights ?? []).map(({ id: _id, fighterIds, ...f }) => ({ ...f, fighters: fighterIds.map(label) })),
    entities: sc.entities.map(({ id: _id, heldBy, ...e }) => ({ ...e, heldBy: heldBy ? label(heldBy.entityId) : null })),
    duration: st().shot()!.duration
  })
}

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
  remote.n = 0
  setFightSolver(async (args) => {
    remote.n++
    await new Promise((r) => setTimeout(r, 1))
    return solves.real!(...args) as Awaited<ReturnType<Parameters<typeof setFightSolver>[0] & object>>
  })
  fresh()
})

afterEach(() => setFightSolver(null))

describe('a bot fight off the main thread', { timeout: 60_000 }, () => {
  const input = { beats: beatsOf('A jab to head -> hit\nB hook to head -> block'), at: { x: 0, z: -2, heading: 0 }, assets: [MALE, FEMALE] as [string, string] }

  it('stages with every solve in the worker, as the main thread stages it, in one undo step', async () => {
    const n = solves.n
    const undo = st().undoStack.length
    const { report } = await stageFightOffThread(input)
    expect(solves.n).toBe(n)
    expect(remote.n).toBeGreaterThan(0)
    expect(st().undoStack.length).toBe(undo + 1)
    const off = staged()
    const sel = st().selection
    fresh()
    const here = st().stageFight(input)
    expect(solves.n).toBeGreaterThan(n)
    expect(JSON.stringify(here.report)).toBe(JSON.stringify(report))
    expect(staged()).toBe(off)
    expect(sel?.kind === 'entities' && sel.entityIds.every((id) => scene().entities.length > 0 && typeof id === 'string')).toBe(true)
  })

  it('re-solves with every solve in the worker, as the main thread does', async () => {
    const { fightId } = st().stageFight(input)
    const patch = { beats: beatsOf('A hook to head -> hit\nB jab to head -> hit') }
    const n = solves.n
    const report = await updateFightOffThread(fightId, patch)
    expect(solves.n).toBe(n)
    const off = staged()
    fresh()
    const again = st().stageFight(input)
    const here = st().updateFight(again.fightId, patch)
    expect(JSON.stringify(here)).toBe(JSON.stringify(report))
    expect(staged()).toBe(off)
  })

  it("a shot the fight grows re-solves the shot's other fight in the worker too", async () => {
    st().stageFight({ ...input, at: { x: 4, z: -2, heading: 0 } })
    const n = solves.n
    const long = beatsOf(['A jab to head -> hit', 'B hook to head -> block', 'A jab to head -> hit', 'B hook to head -> hit', 'A jab to head -> block', 'B jab to head -> hit'].join('\n'))
    const { report } = await stageFightOffThread({ ...input, beats: long })
    expect(report.warnings.join(' ')).toMatch(/Lengthened the shot/)
    expect(solves.n).toBe(n)
  })

  it('a solve missed inside a mutate commits nothing while it solves off the main thread', async () => {
    const { fightId } = st().stageFight(input)
    const doc = st().doc
    const undo = st().undoStack.length
    const seen: boolean[] = []
    setFightSolver(async (args) => {
      // The planning run stopped at this solve inside mutate: the document and the undo stack are as they were.
      seen.push(st().doc === doc && st().undoStack.length === undo)
      return solves.real!(...args) as Awaited<ReturnType<Parameters<typeof setFightSolver>[0] & object>>
    })
    const n = solves.n
    // A shot length edit re-solves its fights inside the mutate (refightShot).
    await offThread(() =>
      st().mutate('shot length', (d) => {
        const sh = d.scenes[0]!.shots[0]!
        sh.duration = 9
        refightShot(d.scenes[0]!, sh)
      })
    )
    expect(seen).toEqual([true])
    expect(solves.n).toBe(n)
    expect(st().undoStack.length).toBe(undo + 1)
    expect(st().shot()!.duration).toBe(9)
    expect(scene().fights!.map((f) => f.id)).toEqual([fightId])
  })

  it('a worker that fails solves on the main thread instead, to the same result', async () => {
    setFightSolver(async () => null)
    const n = solves.n
    const { report } = await stageFightOffThread(input)
    expect(solves.n).toBeGreaterThan(n)
    const failed = staged()
    setFightSolver(null)
    fresh()
    const here = st().stageFight(input)
    expect(JSON.stringify(here.report)).toBe(JSON.stringify(report))
    expect(staged()).toBe(failed)
  })

  it("an input error is the action's own", async () => {
    await expect(stageFightOffThread({ ...input, fighters: ['nobody', 'nobody else'] })).rejects.toThrow(/No fighter/)
  })

  it('a routine bot fight stages off the main thread; routineFightStaged ends with it', async () => {
    const n = solves.n
    st().spawnChoreography({ kind: 'fight', performers: 2, durationS: 6, seed: 4, style: 'sparring', ending: 'finish', bodies: [MALE, FEMALE] }, { x: 0, z: 0, heading: 0 }, true)
    expect(scene().fights ?? []).toHaveLength(0)
    expect(await routineFightStaged()).toBe(null)
    expect(scene().fights).toHaveLength(1)
    expect(solves.n).toBe(n)
  })

  it('without a worker it stages on the main thread, at once', () => {
    setFightSolver(null)
    const n = solves.n
    void stageFightOffThread(input)
    expect(scene().fights).toHaveLength(1)
    expect(solves.n).toBeGreaterThan(n)
  })
})

describe('reads that solve fights, off the main thread', { timeout: 60_000 }, () => {
  const input = { beats: beatsOf('A jab to head -> hit\nB hook to head -> block'), at: { x: 0, z: -2, heading: 0 }, assets: [MALE, FEMALE] as [string, string] }
  const profile = getProfile('seedance-2')
  /** A staged fight whose prompt solve the memo doesn't have: a prop in the scene (the store's solve has it, the prompt's doesn't). */
  const withProp = (): void => {
    st().addEntity('prop.barrel', { x: 6, y: 0, z: 6 })
    st().stageFight(input)
  }
  const prompt = (ready: () => void): string | null => readSoon(() => generatePrompt(scene(), st().shot()!, profile), ready)
  const until = async (ok: () => boolean): Promise<void> => {
    for (let k = 0; k < 500 && !ok(); k++) await new Promise((r) => setTimeout(r, 5))
  }

  it('a prompt reads null at first, then the prompt once the worker has solved; nothing solved here', async () => {
    withProp()
    const n = solves.n
    let ready = 0
    expect(prompt(() => ready++)).toBe(null)
    await until(() => ready > 0)
    expect(ready).toBe(1)
    expect(prompt(() => ready++)).toMatch(/jab/)
    expect(solves.n).toBe(n)
    expect(remote.n).toBe(1)
  })

  it('a solve read twice before the worker answers is asked once', async () => {
    withProp()
    let ready = 0
    expect(prompt(() => ready++)).toBe(null)
    expect(prompt(() => ready++)).toBe(null)
    await until(() => ready > 1)
    expect(remote.n).toBe(1)
    expect(prompt(() => ready++)).toMatch(/jab/)
  })

  it('a solve the worker refuses is solved here the next time it is read', async () => {
    withProp()
    setFightSolver(async () => {
      remote.n++
      return null
    })
    const n = solves.n
    let ready = 0
    expect(prompt(() => ready++)).toBe(null)
    await until(() => ready > 0)
    expect(prompt(() => ready++)).toMatch(/jab/)
    expect(solves.n).toBe(n + 1)
    expect(remote.n).toBe(1)
  })

  it("MCP set_shot re-solves the shot's bot fight in the worker; get_fight then reads it back", async () => {
    let invoke: ((id: string, action: string, params: unknown) => void) | null = null
    const answers = new Map<string, (r: { ok: boolean; data?: unknown; error?: string }) => void>()
    vi.stubGlobal('window', { blockout: { onControlInvoke: (cb: typeof invoke) => ((invoke = cb), () => undefined), controlResult: (id: string, r: { ok: boolean }) => answers.get(id)?.(r) } })
    const { registerControlHandler } = await import('@renderer/control/handler')
    const off = registerControlHandler()
    const rpc = (action: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
      new Promise((resolve) => {
        const id = `${action}-${Math.random()}`
        answers.set(id, resolve)
        invoke!(id, action, params)
      })
    try {
      const { fightId } = st().stageFight(input)
      const n = solves.n
      const set = await rpc('set_shot', { duration: 9 })
      expect(set.ok, set.error).toBe(true)
      expect(st().shot()!.duration).toBe(9)
      expect((set.data as { fights?: unknown[] }).fights).toHaveLength(1)
      expect(remote.n).toBeGreaterThan(0)
      const asked = remote.n
      const got = await rpc('get_fight', { fightId })
      expect(got.ok, got.error).toBe(true)
      expect(remote.n).toBe(asked)
      expect(solves.n).toBe(n)
    } finally {
      off()
      vi.unstubAllGlobals()
    }
  })
})

