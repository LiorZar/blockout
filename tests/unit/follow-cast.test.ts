// Fork test (set-routines T2, docs/plans/2026-10-23-set-routines.md): a chase's follow cameras keep the other cast out
// of the lens (BACKLOG "Chase follow-behind"), and a tracking camera keeps a person who falls flat in the frame.
import { describe, expect, it } from 'vitest'
import { buildRoutine } from '@engine/choreography'
import { clearFollowMove } from '@engine/camera-clear'
import { CAMERA_MOVE_PRESETS } from '@engine/camera-moves'
import { horizontalFov } from '@engine/camera'
import { entityHeight } from '@engine/assets'
import { ShotEvaluator } from '@engine/evaluate'
import { createActorMark, createCameraMark, createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { MOTION_PRESETS } from '@engine/motions'
import { bodyLowY } from '@engine/floor'
import type { ActorMark, CameraState, Scene, Shot, V3 } from '@engine/types'

const FPS = 24

/** Normalized frame coordinates of a world point (x, y in −1..1 inside the frame; z: depth). */
function project(p: V3, cam: CameraState, shot: Shot): { x: number; y: number; z: number } {
  const tanV = Math.tan(cam.vfov / 2)
  const tanH = Math.tan(horizontalFov(shot.camera.sensorId, cam.focalLength) / 2)
  const d = { x: p.x - cam.position.x, y: p.y - cam.position.y, z: p.z - cam.position.z }
  const [sp, cp, st, ct] = [Math.sin(cam.pan), Math.cos(cam.pan), Math.sin(cam.tilt), Math.cos(cam.tilt)]
  const z = -d.x * sp * ct + d.y * st - d.z * cp * ct
  return { x: (d.x * cp - d.z * sp) / (Math.max(z, 1e-3) * tanH), y: (d.x * sp * st + d.y * ct + d.z * cp * st) / (Math.max(z, 1e-3) * tanV), z }
}

const inFrame = (q: { x: number; y: number; z: number }): boolean => q.z > 0 && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1

describe('follow cameras keep the other cast out of the lens', () => {
  for (const seed of [7, 3])
    it(`follow-behind on a chase's runner: nobody within 2.5 m of the lens, nobody in front of the runner over 10 % of the frame (seed ${seed})`, () => {
      const cast = ['person.woman', 'person.man', 'person.man']
      const specs = buildRoutine({ kind: 'chase', performers: 3, durationS: 8, seed, ending: 'caught' }, { origin: { x: 0, z: 10, heading: 0 } })
      const scene = {
        id: 's',
        name: 's',
        number: 1,
        environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
        entities: specs.map((e, i) => ({ id: `e${i}`, assetId: cast[i]!, name: e.name, transform: { position: { ...e.position }, rotationY: e.rotationY, scale: 1 } })),
        blocking: [{ id: 'take', name: 't', tracks: specs.map((e, i) => ({ entityId: `e${i}`, marks: e.marks.map((m, k) => ({ ...m, id: `e${i}m${k}` }) as ActorMark) })) }],
        shots: []
      } as unknown as Scene
      const shot = { id: 'shot', name: 's', duration: 8, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
      const ev0 = new ShotEvaluator(scene, shot)
      const marks = CAMERA_MOVE_PRESETS.find((p) => p.id === 'follow')!.generate({
        subjectAt: (t) => {
          const s = ev0.evaluate(Math.min(Math.max(t, 0), 8)).entities.find((e) => e.entityId === 'e0')!
          return { ...s.position, heading: s.heading }
        },
        subjectHeight: entityHeight('person.woman', 1),
        camera: { x: 0, y: 1.6, z: 20, pan: 0, tilt: 0, focalLength: 35 },
        duration: 8
      })
      const r = clearFollowMove(scene, shot, marks, 'e0', [])
      shot.camera.marks = r.marks.map((m, i) => ({ id: `c${i}`, ...m }))
      shot.camera.trackEntityId = 'e0'
      const ev = new ShotEvaluator(scene, shot)
      const near: string[] = []
      const big: string[] = []
      for (let f = 0; f < 8 * FPS; f++) {
        const st = ev.evaluate(f / FPS)
        const cam = st.camera
        const body = (i: number): { pts: V3[]; chest: V3; pad: number } => {
          const s = st.entities.find((e) => e.entityId === `e${i}`)!
          const dims = personDims(cast[i]!)
          const fx = poseEffectors(dims, s.joints, s.clip)
          return { pts: Object.values(fx).map((p) => toWorld(p, s.position, s.heading, 1)), chest: toWorld(fx.chest, s.position, s.heading, 1), pad: dims.bodyW * 0.5 }
        }
        const dist = (p: V3): number => Math.hypot(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z)
        const runnerAt = dist(body(0).chest)
        for (const i of [1, 2]) {
          const b = body(i)
          if (Math.min(...b.pts.map(dist)) - b.pad < 2.5) near.push(`e${i}@${(f / FPS).toFixed(2)}`)
          if (dist(b.chest) >= runnerAt - 0.5) continue
          const q = b.pts.map((p) => ({ ...project(p, cam, shot), d: dist(p) })).filter((p) => p.z > 0.05)
          const tanH = Math.tan(horizontalFov(shot.camera.sensorId, cam.focalLength) / 2)
          const tanV = Math.tan(cam.vfov / 2)
          const x0 = Math.min(...q.map((p) => p.x - b.pad / (p.z * tanH)))
          const x1 = Math.max(...q.map((p) => p.x + b.pad / (p.z * tanH)))
          const y0 = Math.min(...q.map((p) => p.y - b.pad / (p.z * tanV)))
          const y1 = Math.max(...q.map((p) => p.y + b.pad / (p.z * tanV)))
          const share = (Math.max(0, Math.min(1, x1) - Math.max(-1, x0)) * Math.max(0, Math.min(1, y1) - Math.max(-1, y0))) / 4
          if (share > 0.1) big.push(`e${i}@${(f / FPS).toFixed(2)} ${(share * 100).toFixed(0)}%`)
        }
      }
      expect(near).toEqual([])
      expect(big).toEqual([])
    })
})

describe('a tracking camera keeps a fallen person in frame', () => {
  it('aims at the body on the ground, not at the air where its chest stood', () => {
    const doc = createProject('T')
    const scene = doc.scenes[0]!
    const shot = scene.shots[0]!
    shot.duration = 2
    shot.camera.rigIntensity = 0
    const man = createEntity('person.man', 'Runner', { x: 0, y: 0, z: 0 })
    scene.entities.push(man)
    // The fall's last pose, pitched onto the floor (the root channel), resting on it.
    const flat = { ...MOTION_PRESETS.find((p) => p.id === 'trip-and-fall-flat')!.keyframes.at(-1)!.joints, rootX: 1.35 }
    const m0 = createActorMark({ x: 0, y: 0, z: 0 }, 0, 'stand')
    const m1 = createActorMark({ x: 0, y: -bodyLowY({ assetId: 'person.man' }, flat), z: 0 }, 1, 'stand')
    m1.joints = { ...flat }
    m1.posedMove = true
    scene.blocking[0]!.tracks.push({ entityId: man.id, marks: [m0, m1] })
    // A lead camera 2.5 m ahead of the body at 1.8 m, aimed by the track.
    shot.camera.marks.push(createCameraMark({ x: 0, y: 1.8, z: -2.5 }, 0, 0, 0, 35))
    shot.camera.trackEntityId = man.id
    const ev = new ShotEvaluator(scene, shot)
    const st = ev.evaluate(1.5)
    const s = st.entities[0]!
    const fx = poseEffectors(personDims('person.man'), s.joints, s.clip)
    const head = toWorld(fx.head, s.position, s.heading, 1)
    const hips = toWorld(fx.pelvis, s.position, s.heading, 1)
    expect(head.y).toBeLessThan(0.8) // the pose really is down
    expect(inFrame(project(head, st.camera, shot))).toBe(true)
    expect(inFrame(project(hips, st.camera, shot))).toBe(true)
    // Standing, the aim is exactly upstream's: 0.8 of its height over the root.
    const up = ev.evaluate(0)
    const tilt = Math.atan2(entityHeight('person.man', 1) * 0.8 - 1.8, 2.5)
    expect(up.camera.tilt).toBeCloseTo(tilt, 6)
  })
})
