// Fork test (street-kit T5, docs/plans/2026-10-23-street-kit.md): a staged car chase lays its own camera, leading the
// lead car on a camera car, in the same undo step, when nobody has moved the shot camera yet; a follow (or aerial) move on
// a moving vehicle rides a rig that keeps up unless the rig was set by hand.
import { describe, expect, it } from 'vitest'
import { useStore } from '@renderer/store'
import { CHASE_CAMERA_MOVE, layCameraMove } from '@renderer/camera-move'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { boxReach, vehicleBox, vehicleCorners } from '@engine/vehicles'
import type { CameraMark, ProjectDoc, RigId } from '@engine/types'

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const FPS = 24

function fresh(duration = 6): void {
  const doc: ProjectDoc = createProject('Chase')
  const sc = doc.scenes[0]!
  sc.shots[0]!.duration = duration
  sc.shots[0]!.fps = FPS
  useStore.setState({ doc, sceneId: sc.id, shotId: sc.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
  st().mutate('setup', () => {}) // ends any coalescing run with the previous test's staging
}

const lead = (): string => st().scene()!.entities.find((e) => e.label?.text === 'LEAD')!.id

/** The frames the lead car's drawn box is partly out of the shot camera's frame. */
function leadOut(): number {
  const scene = st().scene()!
  const shot = st().shot()!
  const id = lead()
  const box = vehicleBox(scene.entities.find((e) => e.id === id)!.assetId)!
  const ev = new ShotEvaluator(scene, shot)
  let out = 0
  for (let f = 0; f <= shot.duration * FPS; f++) {
    const s = ev.evaluate(f / FPS)
    const es = s.entities.find((x) => x.entityId === id)!
    if (boxReach(vehicleCorners(box, es.position, es.heading), s.camera, shot.aspect) > 1 + 1e-9) out++
  }
  return out
}

describe('a staged car chase lays its camera', () => {
  it('leads the lead car on a camera car, in the same undo step', () => {
    fresh()
    st().spawnSequence({ type: 'carChase', count: 3, style: 'weaving', origin: { x: 0, z: 0, heading: 0 } })
    const cam = st().shot()!.camera
    expect(cam.marks.length).toBeGreaterThan(1)
    expect(cam.trackEntityId).toBe(lead())
    expect(cam.rig).toBe('carMount')
    expect(cam.mountEntityId).toBeUndefined()
    st().undo()
    expect(st().shot()!.camera.marks).toEqual([])
    expect(st().shot()!.camera.trackEntityId).toBeUndefined()
    expect(st().shot()!.camera.rig).toBe('sticks')
    expect(st().scene()!.entities.length).toBe(0)
  })

  it('is the chase move, as layCameraMove lays it', () => {
    fresh()
    st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    const shot = st().shot()!
    const bare = { ...shot, camera: { ...shot.camera, marks: [], rig: 'sticks' as RigId } }
    delete bare.camera.trackEntityId
    const laid = layCameraMove(st().scene()!, bare, CHASE_CAMERA_MOVE, lead())!
    expect(shot.camera.marks.map(({ id: _id, ...m }) => m)).toEqual(laid.marks)
  })

  it('keeps the lead car in frame on every frame with no warning: both styles, 2–4 cars, 6 s and 15 s', () => {
    for (const style of ['straight', 'weaving'])
      for (const count of [2, 3, 4])
        for (const duration of [6, 15]) {
          fresh(duration)
          st().spawnSequence({ type: 'carChase', count, style, origin: { x: 3, z: -2, heading: 0.4 } })
          const at = `${style} ${count} cars ${duration} s`
          expect(leadOut(), at).toBe(0)
          expect(new ShotEvaluator(st().scene()!, st().shot()!).warnings().map((w) => w.message), at).toEqual([])
        }
  })

  it('leaves a camera that already has marks alone', () => {
    fresh()
    const mark: CameraMark = { id: 'c0', time: 0, hold: 0, easeIn: 0, easeOut: 0, position: { x: 4, y: 2, z: 9 }, pan: 0.3, tilt: -0.1, roll: 0, focalLength: 50 }
    st().mutate('camera', (d) => {
      d.scenes[0]!.shots[0]!.camera.marks = [mark]
    })
    st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    const cam = st().shot()!.camera
    expect(cam.marks).toEqual([mark])
    expect(cam.trackEntityId).toBeUndefined()
    expect(cam.rig).toBe('sticks')
  })

  it('keeps a rig set by hand', () => {
    fresh()
    st().mutate('rig', (d) => {
      d.scenes[0]!.shots[0]!.camera.rig = 'steadicam'
    })
    st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    expect(st().shot()!.camera.marks.length).toBeGreaterThan(1)
    expect(st().shot()!.camera.rig).toBe('steadicam')
  })

  it('a foot chase keeps the camera as it was', () => {
    fresh()
    st().spawnSequence({ type: 'footChase', count: 3, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    expect(st().shot()!.camera.marks).toEqual([])
  })
})

describe('the rig a laid move rides', () => {
  function chaseRig(presetId: string, rig: RigId = 'sticks'): RigId | undefined {
    fresh()
    st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
    const shot = st().shot()!
    return layCameraMove(st().scene()!, { ...shot, camera: { ...shot.camera, marks: [], rig } }, presetId, lead())!.rig
  }

  it('a follow on a moving car rides a camera car; an aerial one a drone', () => {
    for (const id of ['follow-behind', 'lead-the-subject', 'side-track-left', 'side-dolly-past']) expect(chaseRig(id), id).toBe('carMount')
    for (const id of ['overhead-track-follow', 'drone-strafe-reveal', 'flyover']) expect(chaseRig(id), id).toBe('drone')
  })

  it('an orbit, a push or a pan leaves the rig to the user', () => {
    for (const id of ['orbit-90-left', 'slow-push-in', 'static-pan-across']) expect(chaseRig(id), id).toBeUndefined()
  })

  it('a rig set by hand stays', () => {
    expect(chaseRig('follow-behind', 'handheld')).toBeUndefined()
    expect(chaseRig('overhead-track-follow', 'crane')).toBeUndefined()
  })

  it('a parked car and a walking person keep the rig', () => {
    fresh()
    const car = createEntity('vehicle.sedan', 'Parked', { x: 0, y: 0, z: 0 })
    const hero = createEntity('person.man', 'Hero', { x: 4, y: 0, z: 0 })
    st().mutate('cast', (d) => {
      const sc = d.scenes[0]!
      sc.entities.push(car, hero)
      sc.blocking[0]!.tracks.push({
        entityId: hero.id,
        marks: [
          { id: 'a', time: 0, hold: 0, easeIn: 0, easeOut: 0, position: { x: 4, y: 0, z: 0 }, gait: 'walk' },
          { id: 'b', time: 6, hold: 0, easeIn: 0, easeOut: 0, position: { x: 4, y: 0, z: -8 }, gait: 'walk' }
        ]
      })
    })
    expect(layCameraMove(st().scene()!, st().shot()!, 'follow-behind', car.id)!.rig).toBeUndefined()
    expect(layCameraMove(st().scene()!, st().shot()!, 'follow-behind', hero.id)!.rig).toBeUndefined()
  })

  it('the rig chosen keeps up: a follow on the chase warns on Sticks and not on the rig it gets', () => {
    for (const id of ['follow-behind', 'overhead-track-follow']) {
      fresh()
      st().spawnSequence({ type: 'carChase', count: 2, style: 'straight', origin: { x: 0, z: 0, heading: 0 } })
      const shot = st().shot()!
      const laid = layCameraMove(st().scene()!, { ...shot, camera: { ...shot.camera, marks: [], rig: 'sticks' } }, id, lead())!
      const camera = { ...shot.camera, marks: laid.marks.map((m, i) => ({ id: `m${i}`, ...m })), trackEntityId: lead() }
      const warns = (rig: RigId): number => new ShotEvaluator(st().scene()!, { ...shot, camera: { ...camera, rig } }).warnings().filter((w) => w.entityId === 'camera').length
      expect(warns('sticks'), id).toBe(1)
      expect(warns(laid.rig!), id).toBe(0)
    }
  })
})
