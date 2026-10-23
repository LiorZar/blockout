// Fork test (shot-clear, docs/plans/2026-10-23-shot-clear.md): fight coverage keeps the set out of the line from the
// lens to the fighters, every frame, on the real kits: the gym's bench, an alley fight along the alley, a fight by the
// downtown bus shelter.
import { describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { setBoxes, shotWordsClearer } from '@renderer/camera-view'
import { MAX_SET_COVER, clearShotWords, setCover, shotSubjects, viewFrame } from '@engine/camera-clear'
import { ShotEvaluator } from '@engine/evaluate'
import { createActorMark, createEntity, createProject } from '@engine/schema'
import { parseFightScript } from '@engine/fight/script'
import type { ShotSpec } from '@engine/shot'
import type { FightDoc, ProjectDoc } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const SCRIPT = 'A jab cross to head -> block, hit\nB front kick to body -> hit\nB spinning back kick to body -> hit power 1\nA hook to head -> block'

function stage(kit: string, x: number, z: number, heading: number): string {
  const doc: ProjectDoc = createProject('Shot clear')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = 11.5
  sc.shots[0]!.fps = 24
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
  st().addEntity(kit, { x: 0, y: 0, z: 0 })
  const beats = (parseFightScript(SCRIPT, ['BRUNO', 'KIRA']) as { beats: never[] }).beats
  return st().stageFight({ beats, at: { x, z, heading }, assets: ['person.man', 'person.woman'], labels: ['BRUNO', 'KIRA'] }).fightId
}

/** Frames (24 fps) where a set piece covers more than MAX_SET_COVER of a fighter's projected box, and the worst share. */
function coveredFrames(fightId: string): { over: number; worst: number } {
  const sc = st().scene()!
  const sh = st().shot()!
  const fight = sc.fights!.find((f: FightDoc) => f.id === fightId)!
  const boxes = setBoxes(sc, sh)
  const ev = new ShotEvaluator(sc, sh)
  let over = 0
  let worst = 0
  for (let f = 0; f < Math.round(sh.duration * 24); f++) {
    const s = ev.evaluate(f / 24)
    const frame = viewFrame(s.camera, s.camera.focalLength, sh.camera.sensorId, sh.aspect)
    const fighters = shotSubjects(sc, s.entities).filter((x) => fight.fighterIds.includes(x.id))
    const share = Math.max(...fighters.map((x) => setCover(s.camera.position, frame, x, boxes, new Set()).share))
    worst = Math.max(worst, share)
    if (share > MAX_SET_COVER + 0.02) over++
  }
  return { over, worst }
}

const MODES = ['master', 'punch-in', 'over-shoulder', 'follow'] as const

describe('fight coverage keeps the set out of the sightline', () => {
  it('the gym bench stays out of the way of the fighters, both sides of the line', () => {
    const id = stage('env.gym', 0, -2, 0)
    for (const mode of MODES)
      for (const side of ['left', 'right'] as const) {
        st().coverFight(id, mode, side)
        expect({ mode, side, ...coveredFrames(id) }).toMatchObject({ over: 0 })
      }
  })

  it('a fight along the alley: no wall in front, whatever coverage ran before', () => {
    const id = stage('env.alley', 0, 3, Math.PI / 2)
    for (const mode of MODES)
      for (const side of ['left', 'right'] as const) {
        st().coverFight(id, mode, side)
        expect({ mode, side, ...coveredFrames(id) }).toMatchObject({ over: 0 })
      }
  })

  it('a framing is checked from the start of the move into it, not only from its mark', () => {
    // A walker crosses behind a vending machine just before the framing's mark.
    const doc: ProjectDoc = createProject('Lead-in')
    const sc = doc.scenes[0]!
    const sh = sc.shots[0]!
    sh.duration = 3
    const hero = createEntity('person.man', 'HERO', { x: -3, y: 0, z: 0 })
    sc.entities.push(hero)
    sc.blocking[0]!.tracks.push({ entityId: hero.id, marks: [createActorMark({ x: -3, y: 0, z: 0 }, 0), createActorMark({ x: 3, y: 0, z: 0 }, 3)] })
    const spec: ShotSpec = { size: 'MS', subjectIds: [hero.id], side: 'right' }
    const ev = new ShotEvaluator(sc, sh)
    const cam = ev.solveShotAt(spec, 1.6, 35)!.position
    const at = ev.evaluate(1.6).entities.find((e) => e.entityId === hero.id)!.position
    const machine = createEntity('prop.vendingMachine', 'the vending machine', { x: (cam.x + at.x) / 2, y: 0, z: (cam.z + at.z) / 2 })
    machine.transform.rotationY = Math.atan2(cam.x - at.x, cam.z - at.z)
    sc.entities.push(machine)
    useStore.setState({ doc, sceneId: sc.id, shotId: sh.id, time: 0, undoStack: [], redoStack: [], selection: null })
    // From the mark on the view is clear; in the move into it, the machine stands in front of the walker.
    expect(clearShotWords(sc, sh, spec, [2, 3], 35, setBoxes(sc, sh))).toEqual({ spec })
    expect(clearShotWords(sc, sh, spec, [1.6, 1.6], 35, setBoxes(sc, sh)).spec.view).toBeDefined()
    expect(shotWordsClearer(sc, sh, 35)(spec, [2, 3]).view).toBeDefined()
  })

  it('by the bus shelter: an over-the-shoulder beat with no clear view becomes a two-shot', () => {
    const id = stage('env.downtown', -6.5, 2.8, Math.PI / 2)
    st().coverFight(id, 'over-shoulder', 'left')
    expect(coveredFrames(id).over).toBe(0)
    const marks = st().shot()!.camera.marks
    expect(marks.some((m) => m.shot?.subjectIds.length === 2 && m.shot.size === 'MS')).toBe(true)
  })
})
