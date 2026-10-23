// Fork test (gap 2, docs/plans/2026-10-19-fix-fight.md): a fight follows the shot's fps and duration.
import { beforeEach, describe, expect, it } from 'vitest'
import { refightShot, useStore } from '@renderer/store'
import { createProject } from '@engine/schema'
import { parseFightScript } from '@engine/fight/script'
import type { ProjectDoc, Scene, Shot } from '@engine/types'

const SCRIPT = `A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1`

function load(): void {
  const doc: ProjectDoc = createProject('Refight')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = 10
  scene.shots[0]!.fps = 24
  useStore.setState({ doc, sceneId: scene.id, shotId: scene.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!
const shot = (): Shot => st().shot()!

/** Set the shot's fps / duration the way set_shot, the Timeline and the Inspector do: one mutate with the re-solve. */
function retime(patch: { fps?: number; duration?: number }, label = 'shot timing'): ReturnType<typeof refightShot> {
  let out: ReturnType<typeof refightShot> = []
  st().mutate(label, (doc) => {
    const sc = doc.scenes.find((s) => s.id === st().sceneId)!
    const sh = sc.shots.find((s) => s.id === st().shotId)!
    if (patch.fps !== undefined) sh.fps = patch.fps
    if (patch.duration !== undefined) sh.duration = patch.duration
    out = refightShot(sc, sh)
  })
  return out
}

/** Every impact time of a re-solved fight, and whether the attacker has a mark exactly there. */
function impacts(res: ReturnType<typeof refightShot>, fightId: string): { t: number; marked: boolean }[] {
  const rep = res.find((r) => r.fightId === fightId)!.report
  const fight = scene().fights!.find((f) => f.id === fightId)!
  const take = scene().blocking.find((b) => b.id === shot().blockingTakeId)!
  return rep.beats.flatMap((b) => {
    const atk = fight.fighterIds[fight.beats[b.index]!.attacker]
    const marks = take.tracks.find((t) => t.entityId === atk)!.marks
    return b.impactTimes.map((t) => ({ t, marked: marks.some((m) => Math.abs(m.time - t) < 1e-9) }))
  })
}

describe('fights follow the shot timing (gap 2)', () => {
  beforeEach(load)

  it('24 → 30 fps puts every impact on the 30 fps grid, in the same undo step', () => {
    const beats = (parseFightScript(SCRIPT, ['A', 'B']) as { beats: never[] }).beats
    const { fightId } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 } })
    const at24 = impacts(retime({}, 'probe'), fightId)
    expect(at24.length).toBeGreaterThan(4)
    for (const i of at24) expect(Math.abs(i.t * 24 - Math.round(i.t * 24))).toBeLessThan(1e-6)
    const marks24 = structuredClone(scene().blocking)
    const at30 = impacts(retime({ fps: 30 }), fightId)
    expect(at30.length).toBe(at24.length)
    for (const i of at30) {
      expect(Math.abs(i.t * 30 - Math.round(i.t * 30)), `impact at ${i.t}`).toBeLessThan(1e-6)
      expect(i.marked, `a mark on the impact frame ${i.t}`).toBe(true)
    }
    // The 24 fps grid is not the 30 fps grid: at least one impact moved.
    expect(at30.some((i, k) => Math.abs(i.t - at24[k]!.t) > 1e-6)).toBe(true)
    // One undo takes back the fps and the re-solve together.
    st().undo()
    expect(shot().fps).toBe(24)
    expect(scene().blocking).toEqual(marks24)
  })

  it('a shorter shot drops the beats past its end with a warning; a longer one brings them back', () => {
    const beats = (parseFightScript(SCRIPT, ['A', 'B']) as { beats: never[] }).beats
    const { fightId, report } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 } })
    expect(report.beats).toHaveLength(4)
    const short = retime({ duration: 4 })
    const r = short.find((x) => x.fightId === fightId)!.report
    expect(r.beats.length).toBeLessThan(4)
    expect(r.warnings.some((w) => /past the end of the shot/.test(w))).toBe(true)
    // No fight mark is left past the new end's last beat.
    const take = scene().blocking.find((b) => b.id === shot().blockingTakeId)!
    const fight = scene().fights!.find((f) => f.id === fightId)!
    for (const id of fight.fighterIds) {
      const last = take.tracks.find((t) => t.entityId === id)!.marks.at(-1)!
      expect(last.time).toBeLessThanOrEqual(r.endT + 1e-9)
    }
    const long = retime({ duration: 10 })
    expect(long.find((x) => x.fightId === fightId)!.report.beats).toHaveLength(4)
  })

  it('leaves fights whose fighters have no fight marks in this shot alone', () => {
    const beats = (parseFightScript(SCRIPT, ['A', 'B']) as { beats: never[] }).beats
    const { fightId } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 } })
    const fight = scene().fights!.find((f) => f.id === fightId)!
    st().mutate('clear', (doc) => {
      const take = doc.scenes[0]!.blocking[0]!
      take.tracks = take.tracks.filter((t) => !fight.fighterIds.includes(t.entityId))
    })
    expect(retime({ fps: 30 })).toEqual([])
  })

  it('re-solves a fight coverage camera, and leaves a hand-made camera alone', () => {
    const beats = (parseFightScript(SCRIPT, ['A', 'B']) as { beats: never[] }).beats
    const { fightId } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 }, coverage: 'punch-in' })
    const camTimes = (): number[] => shot().camera.marks.map((m) => m.time)
    const before = camTimes()
    retime({ duration: 4 })
    expect(camTimes()).not.toEqual(before)
    st().dropCameraMark({ x: 0, y: 1.6, z: 6 }, 0, 0, 35)
    const mine = camTimes()
    retime({ duration: 10 })
    expect(camTimes()).toEqual(mine)
    expect(scene().fights!.find((f) => f.id === fightId)).toBeTruthy()
  })
})

describe('a staged fight fits in the shot (qa-fight bug 6)', () => {
  beforeEach(() => {
    load()
    st().mutate('5 s shot', (doc) => {
      doc.scenes[0]!.shots[0]!.duration = 5
    })
  })

  it('stageFight lengthens a 5 s shot so all four example beats play, in one undo step', () => {
    const beats = (parseFightScript(SCRIPT, ['A', 'B']) as { beats: never[] }).beats
    const undoDepth = st().undoStack.length
    const { report } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 } })
    expect(report.beats).toHaveLength(4)
    expect(report.warnings.filter((w) => /past the end/.test(w))).toEqual([])
    expect(report.warnings.some((w) => /Lengthened the shot from 5\.0 s to \d+\.\d s/.test(w))).toBe(true)
    expect(shot().duration).toBeGreaterThanOrEqual(report.endT)
    expect(st().undoStack.length).toBe(undoDepth + 1)
    st().undo()
    expect(shot().duration).toBe(5)
    expect(scene().fights ?? []).toHaveLength(0)
  })

  it("a fight whose beats all play leaves the shot alone, even if its last reaction runs past the end (export-h3's 15 s H3 cap)", () => {
    st().mutate('15 s', (doc) => {
      doc.scenes[0]!.shots[0]!.duration = 15
    })
    const text = ['A slash to head -> block', 'B haymaker to head -> parry', 'A thrust to body -> slip', 'B front kick to body -> block', 'A slash to head -> block', 'B roundhouse to head -> duck', 'A slash to body -> ko'].join('\n')
    const beats = (parseFightScript(text, ['A', 'B']) as { beats: never[] }).beats
    const { report } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 }, weapons: ['prop.katana', 'prop.baseballBat'] })
    expect(report.beats).toHaveLength(7)
    expect(shot().duration).toBe(15)
    expect(report.warnings.some((w) => /Lengthened/.test(w))).toBe(false)
  })

  it('stage and update both say when the fight runs past the shot, and the length that shows it all (qa-fixes, mocap-qa bug 8)', () => {
    // A KO whose fall runs on past the blow: where the blow lands and the fight ends, in a roomy shot.
    const beats = (parseFightScript('A jab cross to head -> hit, ko power 1', ['A', 'B']) as { beats: never[] }).beats
    const roomy = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 } }).report
    const blow = roomy.beats[0]!.impactTimes[1]!
    expect(roomy.endT).toBeGreaterThan(blow + 0.6)
    // A shot that ends between the two: every beat plays, so the shot stays as it is.
    load()
    const cut = Math.ceil((blow + 0.4) * 2) / 2
    st().mutate('cut', (doc) => {
      doc.scenes[0]!.shots[0]!.duration = cut
    })
    const { fightId, report } = st().stageFight({ beats, at: { x: 0, z: 0, heading: 0 } })
    expect(shot().duration).toBe(cut)
    expect(report.endT).toBeGreaterThan(cut)
    const need = (Math.ceil((report.endT + 0.5) * 2) / 2).toFixed(1)
    expect(report.warnings).toContain(`The fight ends at ${report.endT.toFixed(1)} s, after the shot's ${cut.toFixed(1)} s: set the shot to ${need} s to see it all`)
    const again = st().updateFight(fightId, { exaggeration: 1.5 })
    expect(again.warnings.some((w) => w.startsWith(`The fight ends at ${again.endT.toFixed(1)} s, after the shot's ${cut.toFixed(1)} s`))).toBe(true)
    // A fight inside its shot says nothing of the kind.
    st().mutate('roomy', (doc) => {
      doc.scenes[0]!.shots[0]!.duration = 10
    })
    expect(st().updateFight(fightId, { exaggeration: 1.5 }).warnings.some((w) => /^The fight ends at/.test(w))).toBe(false)
  })

  it('updateFight lengthens the shot for a longer script; a fight that fits leaves it alone', () => {
    const one = (parseFightScript('A jab cross to head -> hit', ['A', 'B']) as { beats: never[] }).beats
    const { fightId, report } = st().stageFight({ beats: one, at: { x: 0, z: 0, heading: 0 } })
    expect(report.warnings.some((w) => /Lengthened/.test(w))).toBe(false)
    expect(shot().duration).toBe(5)
    const beats = (parseFightScript(SCRIPT, ['A', 'B']) as { beats: never[] }).beats
    const rep = st().updateFight(fightId, { beats })
    expect(rep.beats).toHaveLength(4)
    expect(shot().duration).toBeGreaterThanOrEqual(rep.endT)
  })
})
