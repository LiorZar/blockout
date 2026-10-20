// Fork test (fix-camera-set, docs/plans/2026-10-20-fix-camera-set.md): apply_framing 2S and people-follow
// camera moves keep the camera in open space with the subject in view (qa-export REPORT.md B3 c, d).
import { describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { clearFollowMarks, clearFramingPose, setBoxes } from '@renderer/camera-view'
import { castWorld, checkView, insideOf, shotSubjects } from '@engine/camera-clear'
import { groupShotPose } from '@engine/framing'
import { CAMERA_MOVE_PRESETS, type CameraMarkSpec } from '@engine/camera-moves'
import { ShotEvaluator } from '@engine/evaluate'
import { assetSpec, entityHeight } from '@engine/assets'
import { horizontalFov, verticalFov } from '@engine/camera'
import { createActorMark, createEntity, createProject } from '@engine/schema'
import type { ProjectDoc, Scene, Shot, V3 } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const scene = (): Scene => st().scene()!
const shot = (): Shot => st().shot()!

function load(kit: string | null): void {
  const doc: ProjectDoc = createProject('Clear')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = 5
  if (kit) sc.entities.push(createEntity(kit, assetSpec(kit).name, { x: 0, y: 0, z: 0 }))
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
}

/** Sample the shot camera every 1/8 s: never inside the set or a body, the share of samples that see every subject, and how near it comes to them (m). */
function audit(ids: string[]): { inside: string[]; seen: number; nearest: number } {
  const sc = scene()
  const sh = shot()
  const ev = new ShotEvaluator(sc, sh)
  const boxes = setBoxes(sc, sh)
  const inside: string[] = []
  let seen = 0
  let n = 0
  let nearest = Infinity
  for (let t = 0; t <= sh.duration + 1e-9; t += 1 / 8, n++) {
    const state = ev.evaluate(Math.min(t, sh.duration))
    const subjects = shotSubjects(sc, state.entities)
    const world = { boxes, bodies: castWorld(subjects, new Set()).bodies }
    const cam = state.camera.position
    const where = insideOf(cam, world)
    if (where) inside.push(`${t.toFixed(2)}s ${where}`)
    const framed = subjects.filter((s) => ids.includes(s.id))
    if (checkView(cam, framed, world, new Set(ids)).visible >= 0.75) seen++
    for (const s of framed) nearest = Math.min(nearest, Math.hypot(cam.x - s.position.x, cam.y - s.position.y - 1.4, cam.z - s.position.z))
  }
  return { inside, seen: seen / n, nearest }
}

/** A camera move's marks as SceneManager.applyCameraMove generates them. */
function generate(presetId: string, subjectId: string): CameraMarkSpec[] {
  const sc = scene()
  const sh = shot()
  const ev = new ShotEvaluator(sc, sh)
  const entity = sc.entities.find((e) => e.id === subjectId)!
  const cam0 = ev.evaluate(0).camera
  return CAMERA_MOVE_PRESETS.find((p) => p.id === presetId)!.generate({
    subjectAt: (t) => {
      const es = ev.evaluate(Math.min(Math.max(t, 0), sh.duration)).entities.find((e) => e.entityId === subjectId)!
      return { x: es.position.x, y: es.position.y, z: es.position.z, heading: es.heading }
    },
    subjectHeight: entityHeight(entity.assetId, entity.transform.scale, entity.params),
    camera: { ...cam0.position, pan: cam0.pan, tilt: cam0.tilt, focalLength: cam0.focalLength },
    duration: sh.duration
  })
}

function writeMarks(specs: CameraMarkSpec[], trackId: string): void {
  st().mutate('camera move', (doc) => {
    const sh = doc.scenes[0]!.shots[0]!
    sh.camera.marks = specs.map((m, i) => ({ id: `m${i}`, ...m, position: { ...m.position } }))
    sh.camera.trackEntityId = trackId
  })
}

describe('apply_framing 2S keeps a clear view', () => {
  it('six dancers in the nightclub: the camera comes inside the room and sees every dancer', () => {
    load('env.nightclub')
    st().spawnChoreography({ kind: 'dance', performers: 6, durationS: 5, seed: 7 }, { x: 0, z: 0, heading: 0 })
    const sc = scene()
    const sh = shot()
    const dancers = sc.entities.filter((e) => e.assetId.startsWith('person.'))
    expect(dancers).toHaveLength(6)
    const s0 = new ShotEvaluator(sc, sh).evaluate(0)
    const lens = s0.camera.focalLength
    const subjects = dancers.map((e) => ({
      pos: s0.entities.find((x) => x.entityId === e.id)!.position,
      height: entityHeight(e.assetId, e.transform.scale, e.params)
    }))
    const asked = groupShotPose(subjects, s0.camera.position, {
      hfov: horizontalFov(sh.camera.sensorId, lens),
      vfov: verticalFov(sh.camera.sensorId, lens, sh.aspect)
    })
    // qa-export B3 (c): the asked-for group shot sits behind the back wall.
    expect(asked.position.z).toBeGreaterThan(10)
    const r = clearFramingPose(sc, sh, { position: asked.position, look: asked.look, focalLength: lens }, dancers.map((e) => e.id))
    expect(r.clear).toBe(true)
    expect(r.note).toMatch(/blocked by the Nightclub set/)
    expect(r.warning).toBeUndefined()
    expect(Math.abs(r.position.x)).toBeLessThan(9.7)
    expect(r.position.z).toBeLessThan(9.7)
    st().mutate('2S', (doc) => {
      const cam = doc.scenes[0]!.shots[0]!.camera
      const d = { x: asked.look.x - r.position.x, y: asked.look.y - r.position.y, z: asked.look.z - r.position.z }
      cam.marks = [{ id: 'm', time: 0, hold: 0, easeIn: 0, easeOut: 0, position: r.position, pan: Math.atan2(-d.x, -d.z), tilt: Math.atan2(d.y, Math.hypot(d.x, d.z)), roll: 0, focalLength: r.focalLength }]
    })
    const a = audit(dancers.map((e) => e.id))
    expect(a.inside).toEqual([])
    expect(a.seen).toBeGreaterThanOrEqual(0.9)
  })

  it('a clear group shot is left exactly as asked', () => {
    load('env.nightclub')
    st().spawnChoreography({ kind: 'dance', performers: 2, durationS: 5, seed: 7 }, { x: 0, z: 0, heading: 0 })
    const sc = scene()
    const ids = sc.entities.filter((e) => e.assetId.startsWith('person.')).map((e) => e.id)
    const position: V3 = { x: 0, y: 1.1, z: 5 }
    const r = clearFramingPose(sc, shot(), { position, look: { x: 0, y: 1, z: 0 }, focalLength: 35 }, ids)
    expect(r.variant).toEqual({ turnDeg: 0, raise: 0, closer: 1 })
    expect(r.note).toBeUndefined()
  })
})

describe('people-follow camera moves keep the runner in view', () => {
  for (const presetId of ['follow-behind', 'lead-the-subject']) {
    it(`a downtown chase, ${presetId}: never inside a wall or body, the runner seen ≥ 90 % of the time`, () => {
      load('env.downtown')
      st().spawnChoreography({ kind: 'chase', performers: 3, durationS: 5, seed: 7, ending: 'caught' }, { x: 0, z: 8, heading: 0 })
      const runner = scene().entities.find((e) => /runner/i.test(e.name) || /runner/i.test(e.label?.text ?? ''))!
      expect(runner).toBeDefined()
      const r = clearFollowMarks(scene(), shot(), generate(presetId, runner.id), runner.id)
      writeMarks(r.marks, runner.id)
      const a = audit([runner.id])
      expect(a.inside).toEqual([])
      expect(a.seen).toBeGreaterThanOrEqual(0.9)
      // Never a close-up of the runner's back: the camera keeps its distance.
      expect(a.nearest).toBeGreaterThan(1.3)
      expect(r.share).toBeGreaterThanOrEqual(0.9)
    })
  }

  it('a follow on open ground is left as the preset made it', () => {
    load(null)
    const walker = createEntity('person.man', 'Walker', { x: 0, y: 0, z: 0 })
    st().mutate('cast', (doc) => {
      const sc = doc.scenes[0]!
      sc.entities.push(walker)
      sc.blocking[0]!.tracks.push({ entityId: walker.id, marks: [createActorMark({ x: 0, y: 0, z: 0 }, 0, 'walk'), createActorMark({ x: 0, y: 0, z: -6 }, 5, 'walk')] })
    })
    const specs = generate('follow-behind', walker.id)
    const r = clearFollowMarks(scene(), shot(), specs, walker.id)
    expect(r.marks).toEqual(specs)
    expect(r.note).toBeUndefined()
  })
})
