// Fork test (fix-camera-set, docs/plans/2026-10-20-fix-camera-set.md): shot words and fight coverage keep
// the camera in open space with the subject in view, reading the set's real geometry.
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { assetSpec } from '@engine/assets'
import { cameraBoxes } from '@renderer/fight-obstacles'
import { checkView, insideOf, shotSubjects, viewNote, type SetBox } from '@engine/camera-clear'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { parseFightScript } from '@engine/fight/script'
import type { ShotSpec } from '@engine/shot'
import type { Entity, FightBeat, ProjectDoc, Scene, Shot, V3 } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!
const shot = (): Shot => st().shot()!
const boxesOf = (): SetBox[] => cameraBoxes(scene(), scene().blocking[0])

function load(kit: string | null, cast: Entity[] = [], duration = 5): void {
  const doc: ProjectDoc = createProject('Clear')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = duration
  if (kit) sc.entities.push(createEntity(kit, assetSpec(kit).name, { x: 0, y: 0, z: 0 }))
  sc.entities.push(...cast)
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

const person = (name: string, x: number, z: number, headingDeg: number): Entity => {
  const e = createEntity('person.man', name, { x, y: 0, z })
  e.transform.rotationY = (headingDeg * Math.PI) / 180
  e.label = { text: name, color: '#e04040' }
  return e
}

/** The shot camera and how well it sees `ids` at t. */
function viewAt(t: number, ids: string[]): { cam: V3; inside: string | null; visible: number } {
  const ev = new ShotEvaluator(scene(), shot())
  const state = ev.evaluate(t)
  const subjects = shotSubjects(scene(), state.entities)
  const world = { boxes: boxesOf(), bodies: [] }
  const framed = subjects.filter((s) => ids.includes(s.id))
  const c = checkView(state.camera.position, framed, world, new Set(ids))
  return { cam: state.camera.position, inside: insideOf(state.camera.position, world), visible: c.visible }
}

describe('the set as camera boxes', () => {
  it('reads walls at full height, skips floors and the turning light cones', () => {
    load('env.nightclub')
    const boxes = boxesOf()
    expect(boxes.some((b) => Math.abs(b.z - 10) < 0.2 && b.hx > 9 && b.y1 > 3.9)).toBe(true)
    expect(boxes.every((b) => b.y1 >= 0.35)).toBe(true)
    // The cones turn with the kit's animation, so no fixed box can stand for them.
    expect(boxes.some((b) => Math.abs(Math.abs(b.x) - 5) < 0.3 && Math.abs(Math.abs(b.z) - 5) < 0.3)).toBe(false)
    expect(boxes.find((b) => Math.abs(b.z - 10) < 0.2)!.name).toMatch(/the Nightclub set at/)
  })

  it('reads the downtown buildings and their shop glass', () => {
    load('env.downtown')
    const boxes = boxesOf()
    expect(boxes.some((b) => Math.abs(b.x - 11) < 0.1 && b.y1 > 9)).toBe(true)
    expect(boxes.filter((b) => b.hz < 0.06 && Math.abs(b.y1 - 2.75) < 0.01)).toHaveLength(8)
  })
})

describe('shot words keep a clear view', () => {
  let b: Entity
  beforeEach(() => {
    // B stands 1.5 m from the nightclub's back wall, facing it (clear of the DJ booth).
    b = person('B', 5, 8.5, 180)
    load('env.nightclub', [b])
  })

  it('a view behind the wall comes inside the room and says so', () => {
    const spec: ShotSpec = { size: 'MS', subjectIds: [b.id], side: 'front' }
    const id = st().setShotAtTime(spec, 0)
    const mark = shot().camera.marks.find((m) => m.id === id)!
    expect(mark.shot!.view).toBeDefined()
    expect(mark.shot!.view!.blockedBy).toMatch(/Nightclub/)
    expect(mark.shot!.view!.noClearView).toBeUndefined()
    const v = viewAt(0, [b.id])
    expect(v.inside).toBeNull()
    expect(v.cam.z).toBeLessThan(9.7)
    expect(v.visible).toBeGreaterThanOrEqual(0.75)
    const note = viewNote(scene(), mark.shot!, mark.focalLength)
    expect(note.note).toMatch(/^The view of B was blocked by the Nightclub set at .*: /)
    expect(note.warning).toBeUndefined()
  })

  it('a clear view is left exactly as asked', () => {
    const spec: ShotSpec = { size: 'MS', subjectIds: [b.id], side: 'back' }
    const id = st().setShotAtTime(spec, 0)
    const mark = shot().camera.marks.find((m) => m.id === id)!
    expect(mark.shot).toEqual(spec)
  })

  it('warns when no clear view exists', () => {
    // Inside a downtown building.
    const hidden = person('H', 11, -12, 0)
    load('env.downtown', [hidden])
    const id = st().setShotAtTime({ size: 'MS', subjectIds: [hidden.id] }, 0)
    const mark = shot().camera.marks.find((m) => m.id === id)!
    expect(mark.shot!.view?.noClearView).toBe(true)
    expect(viewNote(scene(), mark.shot!, mark.focalLength).warning).toMatch(/^No clear view of H/)
  })
})

describe('fight coverage keeps a clear view', () => {
  const beats = (text: string): FightBeat[] => (parseFightScript(text, ['A', 'B']) as { beats: FightBeat[] }).beats

  it('a master shot on the wall side of the line stays in the room', () => {
    load('env.gym', [], 6)
    const { fightId } = st().stageFight({ beats: beats('A jab cross to head -> block, hit\nB hook to body -> hit'), at: { x: 0, z: 5, heading: 0 } })
    st().coverFight(fightId, 'master', 'right')
    const fight = scene().fights!.find((f) => f.id === fightId)!
    const marks = shot().camera.marks
    expect(marks.some((m) => m.shot?.view)).toBe(true)
    let seen = 0
    const n = 25
    for (let i = 0; i < n; i++) {
      const v = viewAt((shot().duration * i) / (n - 1), fight.fighterIds)
      expect(v.inside, `t ${i}`).toBeNull()
      expect(v.cam.z).toBeLessThan(9.8)
      if (v.visible >= 0.75) seen++
    }
    expect(seen / n).toBeGreaterThanOrEqual(0.9)
  })

  it('open-floor coverage is unchanged', () => {
    load('env.gym', [], 6)
    const { fightId } = st().stageFight({ beats: beats('A jab cross to head -> block, hit'), at: { x: 0, z: -4, heading: 0 } })
    st().coverFight(fightId, 'master', 'left')
    expect(shot().camera.marks.every((m) => !m.shot?.view)).toBe(true)
  })
})
