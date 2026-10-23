// Fork test (shot-clear, docs/plans/2026-10-23-shot-clear.md): a set piece in front of a subject's legs (the gym's
// bench in front of the fighters' feet) counts against a view, and shot words / framing presets move round it.
import { describe, expect, it } from 'vitest'
import {
  MAX_SET_COVER,
  aimAt,
  baseLens,
  checkView,
  chooseOverFrames,
  chooseView,
  clearFixedPose,
  clearShotWords,
  setCover,
  shotSubjects,
  viewFrame,
  viewVariants,
  type SetBox,
  type ViewCheck
} from '@engine/camera-clear'
import { ShotEvaluator } from '@engine/evaluate'
import { createActorMark, createCameraMark, createEntity, createProject } from '@engine/schema'
import { solveShot, type ShotSetup, type ShotSpec, type ShotSubject } from '@engine/shot'
import type { CameraMark, Scene, Shot, V3 } from '@engine/types'

const SETUP: ShotSetup = { sensorId: 'super35', aspect: '16:9', focalLength: 35 }

const person = (id: string, x: number, z: number, heading = 0): ShotSubject => ({
  id,
  assetId: 'person.man',
  scale: 1,
  position: { x, y: 0, z },
  heading
})

/** A weight bench across X at z: 1.2 m long, 0.4 m deep, 0.58 m high. */
const bench = (x: number, z: number, name = 'the bench'): SetBox => ({ entityId: 'kit', name, x, z, hx: 0.6, hz: 0.2, heading: 0, y0: 0, y1: 0.58 })

const frameAt = (cam: V3, look: V3, lens = 35): ReturnType<typeof viewFrame> => viewFrame(aimAt(cam, look), lens, SETUP.sensorId, SETUP.aspect)

describe('set cover', () => {
  const hero = person('hero', 0, 0)
  const cam = { x: 0, y: 1.4, z: 5 }
  const frame = frameAt(cam, { x: 0, y: 1, z: 0 })

  it('a bench between the lens and the legs covers part of the projected box', () => {
    const c = setCover(cam, frame, hero, [bench(0, 1)], new Set())
    expect(c.share).toBeGreaterThan(MAX_SET_COVER)
    expect(c.share).toBeLessThan(0.5)
    expect(c.by).toBe('the bench')
  })

  it('nothing in front, a bench behind or off to the side covers nothing', () => {
    expect(setCover(cam, frame, hero, [], new Set()).share).toBe(0)
    expect(setCover(cam, frame, hero, [bench(0, -2)], new Set()).share).toBe(0)
    expect(setCover(cam, frame, hero, [bench(3, 2)], new Set()).share).toBe(0)
    expect(setCover(cam, frame, hero, [bench(0, 1)], new Set(['kit'])).share).toBe(0)
  })

  it('a camera raised over the bench sees the feet', () => {
    const high = { x: 0, y: 3.2, z: 5 }
    expect(setCover(high, frameAt(high, { x: 0, y: 1, z: 0 }), hero, [bench(0, 1)], new Set()).share).toBeLessThanOrEqual(MAX_SET_COVER)
  })

  it('only the part of the subject in frame counts', () => {
    // A close-up holds the head: the bench in front of the legs is out of frame.
    const close = { x: 0, y: 1.6, z: 1.2 }
    expect(setCover(close, frameAt(close, { x: 0, y: 1.6, z: 0 }, 85), hero, [bench(0, 0.6)], new Set()).share).toBe(0)
  })

  it('checkView reports the cover only when given the frame', () => {
    const plain = checkView(cam, [hero], { boxes: [bench(0, 1)], bodies: [] }, new Set(['hero']))
    expect(plain).toEqual({ inside: null, visible: 1, blocker: null })
    const framed = checkView(cam, [hero], { boxes: [bench(0, 1)], bodies: [] }, new Set(['hero']), frame)
    expect(framed.cover).toBeGreaterThan(MAX_SET_COVER)
    expect(framed.coverBy).toBe('the bench')
  })

  it('chooseView rejects a variant whose set cover is over the limit on any sample', () => {
    const ok: ViewCheck = { inside: null, visible: 1, blocker: null, cover: 0 }
    const covered: ViewCheck = { inside: null, visible: 1, blocker: null, cover: 0.2, coverBy: 'the bench' }
    const variants = viewVariants({ lens: 35, turns: false, closer: false })
    // The asked-for view has one covered sample in eleven (over the 90 % share rule): it still moves.
    const choice = chooseView((v) => (v.raise === 0 ? [covered, ...Array(10).fill(ok)] : Array(11).fill(ok)), variants)
    expect(choice.clear).toBe(true)
    expect(choice.variant.raise).toBe(0.5)
    expect(choice.blocker).toBe('the bench')
  })
})

/** Two fighters 1.1 m apart along X at z = 0, facing each other. */
function fightScene(boxes: SetBox[]): { scene: Scene; shot: Shot; boxes: SetBox[] } {
  const doc = createProject('Cover')
  const scene = doc.scenes[0]!
  const a = createEntity('person.man', 'A', { x: -0.55, y: 0, z: 0 })
  a.transform.rotationY = -Math.PI / 2
  const b = createEntity('person.woman', 'B', { x: 0.55, y: 0, z: 0 })
  b.transform.rotationY = Math.PI / 2
  a.id = 'a'
  b.id = 'b'
  scene.entities.push(a, b)
  const shot = scene.shots[0]!
  shot.duration = 2
  return { scene, shot, boxes }
}

describe('shot words keep the set out of the sightline', () => {
  const spec: ShotSpec = { size: 'WS', subjectIds: ['a', 'b'], side: 'line', lineIds: ['a', 'b'], lineSide: 1 }

  /** The camera of the plain WS on +1: which side of the line its lens sits on. */
  const plainCam = (scene: Scene): V3 => {
    const subjects: ShotSubject[] = scene.entities.map((e) => ({ id: e.id, assetId: e.assetId, scale: 1, position: e.transform.position, heading: e.transform.rotationY }))
    return solveShot(spec, subjects, SETUP).position
  }

  it('a bench in front of the fighters\' legs moves the camera, and the new view keeps it under the limit', () => {
    const { scene, shot } = fightScene([])
    const cam = plainCam(scene)
    // The bench a third of the way to the lens, across the sightline.
    const set = [{ ...bench(cam.x / 3, cam.z / 3), heading: Math.atan2(cam.x, cam.z) }]
    const r = clearShotWords(scene, shot, spec, [0, 2], 35, set)
    expect(r.spec.view).toBeDefined()
    expect(r.note).toMatch(/the bench/)
    expect(r.warning).toBeUndefined()
    const subjects: ShotSubject[] = scene.entities.map((e) => ({ id: e.id, assetId: e.assetId, scale: 1, position: e.transform.position, heading: e.transform.rotationY }))
    const solved = solveShot(r.spec, subjects, SETUP)
    const frame = viewFrame(solved, solved.focalLength, SETUP.sensorId, SETUP.aspect)
    for (const s of subjects) expect(setCover(solved.position, frame, s, set, new Set()).share).toBeLessThanOrEqual(MAX_SET_COVER)
  })

  it('an open floor is left exactly as asked', () => {
    const { scene, shot } = fightScene([])
    expect(clearShotWords(scene, shot, spec, [0, 2], 35, [])).toEqual({ spec })
  })
})

describe('framing presets keep the set out of the sightline', () => {
  it('a fixed two-shot rises or swings off a bench in front of the legs', () => {
    const { scene, shot } = fightScene([])
    const pose = { position: { x: 0, y: 1.5, z: 6 }, look: { x: 0, y: 1, z: 0 }, focalLength: 35 }
    const set = [bench(0, 2.4)]
    const r = clearFixedPose(scene, shot, pose, ['a', 'b'], set)
    expect(r.clear).toBe(true)
    expect(r.position).not.toEqual(pose.position)
    expect(r.note).toMatch(/the bench/)
    const open = clearFixedPose(scene, shot, pose, ['a', 'b'], [])
    expect(open.position).toEqual(pose.position)
  })

  it('is checked on every frame: a runner behind a pillar between two samples moves the camera', () => {
    const doc = createProject('Pillar')
    const scene = doc.scenes[0]!
    const shot = scene.shots[0]!
    shot.duration = 2.5
    shot.fps = 24
    const runner = createEntity('person.man', 'RUNNER', { x: -7.5, y: 0, z: 0 })
    runner.id = 'r'
    scene.entities.push(runner)
    scene.blocking[0]!.tracks.push({ entityId: 'r', marks: [createActorMark({ x: -7.5, y: 0, z: 0 }, 0, 'run'), createActorMark({ x: 7.5, y: 0, z: 0 }, 2.5, 'run')] })
    // The runner passes behind the pillar at 1.18–1.33 s, between the samples at 1.0 and 1.5 s.
    const pillar: SetBox = { entityId: 'kit', name: 'the pillar', x: 0, z: 3, hx: 0.075, hz: 0.075, heading: 0, y0: 0, y1: 3 }
    const pose = { position: { x: 0, y: 1.4, z: 6 }, look: { x: 0, y: 1, z: 0 }, focalLength: 18 }
    const r = clearFixedPose(scene, shot, pose, ['r'], [pillar])
    expect(r.position).not.toEqual(pose.position)
    expect(r.note).toMatch(/the pillar/)
    const ev = new ShotEvaluator(scene, shot)
    const frame = viewFrame(aimAt(r.position, pose.look), r.focalLength, 'super35', '16:9')
    for (let f = 0; f <= 60; f++) {
      const s = shotSubjects(scene, ev.evaluate(f / 24).entities)[0]!
      expect(setCover(r.position, frame, s, [pillar], new Set()).share).toBeLessThanOrEqual(MAX_SET_COVER)
    }
  })
})

describe('the base lens for new shot words', () => {
  const mark = (time: number, focalLength: number, shot?: ShotSpec): CameraMark => ({ ...createCameraMark({ x: 0, y: 1.6, z: 5 }, time, 0, 0, focalLength), ...(shot ? { shot } : {}) })
  const two: ShotSpec = { size: 'WS', subjectIds: ['a', 'b'] }

  it('a plain mark keeps its lens; nothing at all is 35 mm', () => {
    expect(baseLens([])).toBe(35)
    expect(baseLens([mark(0, 50)])).toBe(50)
  })

  it('shot words give back the lens they were asked for, not what a clear view or a shoulder made of it', () => {
    // A WS moved 45 % closer on a wider lens was asked on 35 mm.
    expect(baseLens([mark(0, 35 * 0.55, { ...two, view: { closer: 0.55 } })])).toBeCloseTo(35, 9)
    expect(baseLens([mark(0, 40, { ...two, lens: 50, view: { closer: 0.8 } })])).toBe(50)
    // An over-the-shoulder mark with no lens picked its own (68 mm): the latest mark that says what was asked counts.
    const ots: ShotSpec = { size: 'MCU', subjectIds: ['b'], over: { entityId: 'a', shoulder: 'right' } }
    expect(baseLens([mark(0, 24, two), mark(4, 68, ots)])).toBe(24)
    expect(baseLens([mark(4, 68, ots)])).toBe(35)
  })

  it('the mark being re-framed comes first', () => {
    const first = mark(0, 50)
    expect(baseLens([first, mark(4, 24)], first)).toBe(50)
  })
})

describe('the least blocked view', () => {
  it('sees the subject most of the time rather than keeping off every wall while it sees nothing', () => {
    const ok: ViewCheck = { inside: null, visible: 1, blocker: null }
    const grazing: ViewCheck = { inside: 'the alley wall', visible: 1, blocker: null }
    const walled: ViewCheck = { inside: null, visible: 0, blocker: 'the alley wall', cover: 1, coverBy: 'the alley wall' }
    const vs = viewVariants({ lens: 35, raise: false, closer: false })
    // The asked view sees only wall; a swing grazes the wall on one sample in ten.
    const pick = chooseView((v) => (v.turnDeg === 0 ? Array(10).fill(walled) : [grazing, ...Array(9).fill(ok)]), vs)
    expect(pick.clear).toBe(false)
    expect(pick.variant.turnDeg).not.toBe(0)
  })
})

describe('a shot words mark moved closer on a wider lens', () => {
  it('plays at the lens and distance its view asked for, not closer twice', () => {
    const { scene, shot } = fightScene([])
    const spec: ShotSpec = { size: 'WS', subjectIds: ['a', 'b'], side: 'line', lineIds: ['a', 'b'], lineSide: 1, view: { closer: 0.55, turnDeg: 20 } }
    // As writeCoverage and setShotAtTime store it: the solved pose and focal length (35 mm × 0.55).
    const solved = new ShotEvaluator(scene, shot).solveShotAt(spec, 0, 35)!
    expect(solved.focalLength).toBeCloseTo(35 * 0.55, 9)
    shot.camera.marks = [{ ...createCameraMark({ ...solved.position }, 0, solved.pan, solved.tilt, solved.focalLength), shot: spec }]
    const cam = new ShotEvaluator(scene, shot).evaluate(1).camera
    expect(cam.focalLength).toBeCloseTo(35 * 0.55, 6)
    expect(Math.hypot(cam.position.x - solved.position.x, cam.position.y - solved.position.y, cam.position.z - solved.position.z)).toBeLessThan(1e-6)
  })
})

describe('no view holds on every frame', () => {
  it('says so, rather than keeping the last re-search that only looked clear on the samples it had', () => {
    const ok: ViewCheck = { inside: null, visible: 1, blocker: null, cover: 0 }
    const wall: ViewCheck = { inside: 'the wall', visible: 0, blocker: 'the wall', cover: 1, coverBy: 'the wall' }
    const frames = Array.from({ length: 121 }, (_, f) => f / 24)
    const times = [0, 1, 2, 3, 4, 5]
    const variants = viewVariants({ lens: 35, raise: false, closer: false })
    // The five nearest swings each sit in the wall for a different 10 frames between the samples; the rest always do.
    const blocks: Record<number, number> = { 0: 2, 20: 26, [-20]: 50, 40: 74, [-40]: 98 }
    const checkAt = (t: number, v: { turnDeg: number }): ViewCheck => {
      const f = Math.round(t * 24)
      const b = blocks[v.turnDeg]
      return b === undefined || (f >= b && f < b + 10) ? wall : ok
    }
    const choice = chooseOverFrames(checkAt, times, frames, variants)
    expect(choice.clear).toBe(false)
    // All five are as clear (110 of 121 frames): the nearest is kept.
    expect(choice.variant.turnDeg).toBe(0)
    expect(choice.share).toBeGreaterThan(0.85)
  })
})
