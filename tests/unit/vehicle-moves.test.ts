// Fork test (street-kit, docs/plans/2026-10-23-street-kit.md): the camera-move presets sized for a vehicle. A move on
// a car keeps the lens out of every car and the car's whole box in frame, or warns; a person's moves are as before.
import { describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { layCameraMove } from '@renderer/camera-move'
import { clearFollowMarks, clearMoveMarks } from '@renderer/camera-view'
import { CAMERA_MOVE_PRESETS } from '@engine/camera-moves'
import { entityHeight } from '@engine/assets'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { boxReach, vehicleBox, vehicleCorners } from '@engine/vehicles'
import type { ProjectDoc } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const FPS = 24

/** A 6 s car chase (`count` cars; 1 = the lead alone), the camera 25 m up the road looking back at it. */
function chase(count: number, style = 'straight'): string {
  const doc: ProjectDoc = createProject('Moves')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = 6
  sc.shots[0]!.fps = FPS
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
  st().mutate('setup', () => {}) // ends any coalescing run with the previous test's staging
  st().spawnSequence({ type: 'carChase', count: Math.max(2, count), style, origin: { x: 0, z: 0, heading: 0 } })
  st().mutate('setup', (d) => {
    const s = d.scenes[0]!
    if (count === 1) {
      const gone = s.entities.filter((e) => e.name === 'Chase car 1').map((e) => e.id)
      s.entities = s.entities.filter((e) => !gone.includes(e.id))
      for (const b of s.blocking) b.tracks = b.tracks.filter((t) => !gone.includes(t.entityId))
    }
    s.shots[0]!.camera.marks = [{ id: 'c0', time: 0, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 1.7, z: -25 }, pan: Math.PI, tilt: 0, roll: 0, focalLength: 35 }]
  })
  return st().scene()!.entities.find((e) => e.label?.text === 'LEAD')!.id
}

/** Lay a preset on `subjectId` and play it: frames with the lens in a car, frames with the subject's box out of frame. */
function play(presetId: string, subjectId: string): { inside: number; out: number; warning?: string } {
  const scene = st().scene()!
  const shot = st().shot()!
  const laid = layCameraMove(scene, shot, presetId, subjectId)!
  st().mutate('move', (d) => {
    const sh = d.scenes[0]!.shots[0]!
    sh.camera.marks = laid.marks.map((m, i) => ({ id: `m${i}`, ...m, position: { ...m.position } }))
    if (laid.track) sh.camera.trackEntityId = subjectId
    else delete sh.camera.trackEntityId
  })
  const ev = new ShotEvaluator(st().scene()!, st().shot()!)
  const cars = scene.entities.filter((e) => vehicleBox(e.assetId))
  let inside = 0
  let out = 0
  for (let f = 0; f <= 6 * FPS; f++) {
    const s = ev.evaluate(f / FPS)
    const boxOf = (id: string): ReturnType<typeof vehicleCorners> => {
      const e = scene.entities.find((x) => x.id === id)!
      const es = s.entities.find((x) => x.entityId === id)!
      return vehicleCorners(vehicleBox(e.assetId)!, es.position, es.heading)
    }
    const p = s.camera.position
    if (cars.some((c) => {
      const q = boxOf(c.id)
      const xs = q.map((v) => v.x)
      const ys = q.map((v) => v.y)
      const zs = q.map((v) => v.z)
      // The boxes turn little in a chase; their axis-aligned bounds are a conservative inside test.
      return p.x > Math.min(...xs) && p.x < Math.max(...xs) && p.y > Math.min(...ys) && p.y < Math.max(...ys) && p.z > Math.min(...zs) && p.z < Math.max(...zs)
    })) inside++
    if (boxReach(boxOf(subjectId), s.camera, shot.aspect) > 1 + 1e-9) out++
  }
  return { inside, out, warning: laid.warning }
}

describe('camera moves on a vehicle', () => {
  it('follow-behind on the lead car alone: the lens out of the car, the whole car in frame', () => {
    const lead = chase(1)
    const r = play('follow-behind', lead)
    expect(r.inside).toBe(0)
    expect(r.out).toBe(0)
  })

  it('in a 4-car chase: follow-behind, side-track and lead-the-subject keep the lens out of every car', () => {
    for (const style of ['straight', 'weaving'])
      for (const id of ['follow-behind', 'side-track-left', 'lead-the-subject', 'slow-push-in', 'orbit-90-left']) {
        const lead = chase(4, style)
        const r = play(id, lead)
        expect(r.inside, `${style} ${id}`).toBe(0)
        expect(r.out === 0 || !!r.warning, `${style} ${id}: ${r.out} frames out, no warning`).toBe(true)
      }
  }, 20_000) // fork (shared-camera-moves): side-track-left now rides the flank the set fits longest

  it('a whip pan off the car says so', () => {
    const lead = chase(1)
    const r = play('whip-pan', lead)
    expect(r.out).toBeGreaterThan(0)
    expect(r.warning).toMatch(/out of frame/)
  })
})

describe('camera moves on a person', () => {
  it('lay exactly the marks they did before', () => {
    const doc: ProjectDoc = createProject('People')
    const sc = doc.scenes[0]!
    sc.shots[0]!.duration = 5
    const hero = createEntity('person.man', 'HERO', { x: 0, y: 0, z: 0 })
    sc.entities.push(createEntity('env.alley', 'Alley', { x: 0, y: 0, z: 0 }), hero)
    sc.blocking[0]!.tracks.push({
      entityId: hero.id,
      marks: [
        { id: 'a', time: 0, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z: 2 }, gait: 'stand' },
        { id: 'b', time: 5, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z: -2 }, gait: 'walk' }
      ]
    })
    sc.shots[0]!.camera.marks = [{ id: 'c0', time: 0, hold: 0, easeIn: 0, easeOut: 0, position: { x: 3, y: 1.6, z: -3 }, pan: 0.8, tilt: 0, roll: 0, focalLength: 35 }]
    useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
    const scene = st().scene()!
    const shot = st().shot()!
    const ev = new ShotEvaluator(scene, shot)
    const c0 = ev.evaluate(0).camera
    for (const preset of CAMERA_MOVE_PRESETS) {
      const specs = preset.generate({
        subjectAt: (t) => {
          const es = ev.evaluate(Math.min(Math.max(t, 0), shot.duration)).entities.find((e) => e.entityId === hero.id)!
          return { x: es.position.x, y: es.position.y, z: es.position.z, heading: es.heading }
        },
        subjectHeight: entityHeight(hero.assetId, 1, hero.params),
        camera: { ...c0.position, pan: c0.pan, tilt: c0.tilt, focalLength: c0.focalLength },
        duration: shot.duration
      })
      const was = preset.category === 'tracking' ? clearFollowMarks(scene, shot, specs, hero.id) : clearMoveMarks(scene, shot, specs, hero.id, preset.track, preset.name)
      const now = layCameraMove(scene, shot, preset.id, hero.id)!
      expect(now.marks, preset.id).toEqual(was.marks)
      expect(now.warning, preset.id).toBe(was.warning)
    }
  })
})
