import { describe, expect, it } from 'vitest'
import { ASPECT_RATIOS } from '@engine/camera'
import { ShotEvaluator } from '@engine/evaluate'
import { createActorMark, createCameraMark, createEntity, createProject, parseProject, serializeProject } from '@engine/schema'
import { solveShot } from '@engine/shot'
import { evaluateShotTrack } from '@engine/shot-track'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { CameraState, EntityState, ProjectDoc, Scene, Shot, V3 } from '@engine/types'

/** One man walking (0,0,0) → (0,0,-10) over 0..5s, like the evaluate.test.ts fixture. */
function fixture(): { doc: ProjectDoc; scene: Scene; shot: Shot; entityId: string } {
  const doc = createProject('Test')
  const scene = doc.scenes[0]!
  const shot = scene.shots[0]!
  const entity = createEntity('person.man', 'Man', { x: 0, y: 0, z: 0 })
  scene.entities.push(entity)
  const m1 = createActorMark({ x: 0, y: 0, z: 0 }, 0, 'walk')
  const m2 = createActorMark({ x: 0, y: 0, z: -10 }, 5, 'walk')
  m1.easeIn = 0
  m1.easeOut = 0
  m2.easeIn = 0
  m2.easeOut = 0
  scene.blocking[0]!.tracks.push({ entityId: entity.id, marks: [m1, m2] })
  shot.camera.seed = 42
  shot.duration = 5
  return { doc, scene, shot, entityId: entity.id }
}

function project(p: V3, cam: CameraState, aspect: number): { x: number; y: number; depth: number } {
  const tanV = Math.tan(cam.vfov / 2)
  const tanH = tanV * aspect
  const cp = Math.cos(cam.pan)
  const sp = Math.sin(cam.pan)
  const ct = Math.cos(cam.tilt)
  const st = Math.sin(cam.tilt)
  const cr = Math.cos(cam.roll)
  const sr = Math.sin(cam.roll)
  const rot = (v: V3): V3 => {
    const z1 = { x: v.x * cr - v.y * sr, y: v.x * sr + v.y * cr, z: v.z }
    const x1 = { x: z1.x, y: z1.y * ct - z1.z * st, z: z1.y * st + z1.z * ct }
    return { x: x1.x * cp + x1.z * sp, y: x1.y, z: -x1.x * sp + x1.z * cp }
  }
  const right = rot({ x: 1, y: 0, z: 0 })
  const up = rot({ x: 0, y: 1, z: 0 })
  const fwd = rot({ x: 0, y: 0, z: -1 })
  const d = { x: p.x - cam.position.x, y: p.y - cam.position.y, z: p.z - cam.position.z }
  const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
  const depth = dot(d, fwd)
  return { x: dot(d, right) / depth / tanH, y: dot(d, up) / depth / tanV, depth }
}

function headTop(es: EntityState): V3 {
  const dims = personDims('person.man')
  const head = toWorld(poseEffectors(dims, es.joints).head, es.position, es.heading, 1)
  return { x: head.x, y: head.y + dims.headR, z: head.z }
}

describe('live shot marks', () => {
  it('a single MCU shot mark keeps the walker framed at t = 0, 2.5, 5', () => {
    const { scene, shot, entityId } = fixture()
    const mark = createCameraMark({ x: 9, y: 9, z: 9 }, 0, 0, 0, 35)
    mark.shot = { size: 'MCU', subjectIds: [entityId], side: 'right' }
    shot.camera.marks.push(mark)
    const ev = new ShotEvaluator(scene, shot)
    for (const t of [0, 2.5, 5]) {
      const state = ev.evaluate(t)
      const man = state.entities.find((e) => e.entityId === entityId)!
      const p = project(headTop(man), state.camera, ASPECT_RATIOS[shot.aspect])
      expect(p.depth).toBeGreaterThan(0)
      expect(Math.abs(p.y - 0.92)).toBeLessThan(0.01)
      expect(Math.abs(p.x)).toBeLessThan(0.01)
    }
  })

  it('two shot marks hold the framing through the blend', () => {
    const { scene, shot, entityId } = fixture()
    const a = createCameraMark({ x: 0, y: 0, z: 0 }, 0, 0, 0, 35)
    const b = createCameraMark({ x: 0, y: 0, z: 0 }, 5, 0, 0, 35)
    a.shot = { size: 'MCU', subjectIds: [entityId], side: 'right' }
    b.shot = { size: 'MCU', subjectIds: [entityId], side: 'right' }
    shot.camera.marks.push(a, b)
    const ev = new ShotEvaluator(scene, shot)
    for (const t of [0, 1.3, 2.5, 4.1, 5]) {
      const state = ev.evaluate(t)
      const man = state.entities.find((e) => e.entityId === entityId)!
      const p = project(headTop(man), state.camera, ASPECT_RATIOS[shot.aspect])
      expect(Math.abs(p.y - 0.92)).toBeLessThan(0.01)
      expect(Math.abs(p.x)).toBeLessThan(0.01)
    }
  })

  it('blend from a plain mark to a shot mark reaches the solved pose at the shot mark time', () => {
    const { scene, shot, entityId } = fixture()
    const plain = createCameraMark({ x: 5, y: 1.6, z: 0 }, 0, 0.3, 0.05, 35)
    const framed = createCameraMark({ x: 0, y: 0, z: 0 }, 2, 0, 0, 50)
    framed.shot = { size: 'CU', subjectIds: [entityId], side: 'left' }
    shot.camera.marks.push(plain, framed)
    const ev = new ShotEvaluator(scene, shot)
    const at0 = ev.evaluate(0).camera
    expect(at0.position).toEqual({ x: 5, y: 1.6, z: 0 })
    expect(at0.pan).toBeCloseTo(0.3, 12)
    const state = ev.evaluate(2)
    const man = state.entities.find((e) => e.entityId === entityId)!
    const solved = solveShot(
      framed.shot,
      [{ id: entityId, assetId: 'person.man', scale: 1, position: man.position, heading: man.heading, joints: man.joints }],
      { sensorId: shot.camera.sensorId, aspect: shot.aspect, focalLength: 50 }
    )
    expect(state.camera.position.x).toBeCloseTo(solved.position.x, 9)
    expect(state.camera.position.y).toBeCloseTo(solved.position.y, 9)
    expect(state.camera.position.z).toBeCloseTo(solved.position.z, 9)
    expect(state.camera.pan).toBeCloseTo(solved.pan, 9)
    expect(state.camera.tilt).toBeCloseTo(solved.tilt, 9)
    expect(state.camera.focalLength).toBe(50)
    const mid = ev.evaluate(1).camera
    expect(mid.position.x).toBeLessThan(5)
    expect(mid.position.x).not.toBeCloseTo(solved.position.x, 3)
  })

  it('missing subject falls back to the stored pose', () => {
    const { scene, shot } = fixture()
    const mark = createCameraMark({ x: 2, y: 1.5, z: 3 }, 0, 0.4, -0.1, 50)
    mark.shot = { size: 'MCU', subjectIds: ['ent_deleted'] }
    shot.camera.marks.push(mark)
    const cam = new ShotEvaluator(scene, shot).evaluate(1).camera
    expect(cam.position).toEqual({ x: 2, y: 1.5, z: 3 })
    expect(cam.pan).toBeCloseTo(0.4, 12)
    expect(cam.tilt).toBeCloseTo(-0.1, 12)
    expect(cam.focalLength).toBe(50)
  })

  it('aim lock is skipped while the active mark has a shot', () => {
    const { scene, shot, entityId } = fixture()
    const other = createEntity('person.woman', 'Other', { x: 6, y: 0, z: 6 })
    scene.entities.push(other)
    shot.camera.trackEntityId = other.id
    const mark = createCameraMark({ x: 0, y: 0, z: 0 }, 0, 0, 0, 35)
    mark.shot = { size: 'MS', subjectIds: [entityId], side: 'right' }
    shot.camera.marks.push(mark)
    const state = new ShotEvaluator(scene, shot).evaluate(2)
    const man = state.entities.find((e) => e.entityId === entityId)!
    const p = project(headTop(man), state.camera, ASPECT_RATIOS[shot.aspect])
    expect(Math.abs(p.x)).toBeLessThan(0.01)
  })

  it('evaluateShotTrack uses stored poses when solve returns null', () => {
    const a = createCameraMark({ x: 0, y: 1, z: 0 }, 0, 0, 0, 35)
    const b = createCameraMark({ x: 10, y: 1, z: 0 }, 2, 1, 0, 85)
    a.easeIn = a.easeOut = b.easeIn = b.easeOut = 0
    const r = evaluateShotTrack([a, b], 1, () => null)
    expect(r.position.x).toBeCloseTo(5, 9) // smoothstep(0.5) = 0.5
    expect(r.pan).toBeCloseTo(0.5, 9)
    expect(r.focalLength).toBeCloseTo(60, 9)
    expect(evaluateShotTrack([a, b], 3, () => null).position.x).toBe(10)
    expect(evaluateShotTrack([a, b], -1, () => null).position.x).toBe(0)
  })

  it('parseProject keeps marks[0].shot', () => {
    const { doc, shot, entityId } = fixture()
    const mark = createCameraMark({ x: 1, y: 1.5, z: 3 }, 0, 0, 0, 35)
    mark.shot = {
      size: 'MCU',
      subjectIds: [entityId],
      over: { entityId: 'ent_x', shoulder: 'right' },
      lens: 50,
      dutchDeg: 10,
      lineIds: [entityId, 'ent_x'],
      lineSide: -1
    }
    shot.camera.marks.push(mark)
    const back = parseProject(serializeProject(doc))
    expect(back.issues).toEqual([])
    expect(back.doc!.scenes[0]!.shots[0]!.camera.marks[0]!.shot).toEqual(mark.shot)
    const viaStringify = parseProject(JSON.stringify(doc))
    expect(viaStringify.doc!.scenes[0]!.shots[0]!.camera.marks[0]!.shot).toEqual(mark.shot)
  })
})
