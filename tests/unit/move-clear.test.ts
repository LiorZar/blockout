// Fork test (shot-clear T2, docs/plans/2026-10-23-shot-clear.md): camera-move presets laid in a set keep their subject
// in view (BACKLOG "Occlusion-aware camera moves": an orbit inside the alley kit rendered only wall).
import { describe, expect, it } from 'vitest'
import { aimAt, insideOf, setCover, shotSubjects, viewFrame, type SetBox } from '@engine/camera-clear'
import { CAMERA_MOVE_PRESETS, type CameraMarkSpec } from '@engine/camera-moves'
import { MOVE_SET_COVER, clearMove, fitMoveMarks, moveVariants } from '@engine/move-clear'
import { entityHeight } from '@engine/assets'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { trackAim } from '@engine/track-aim'
import type { Scene, Shot, V3 } from '@engine/types'

/** An alley: two 8 m walls 5 m apart along Z. */
const ALLEY: SetBox[] = [-1, 1].map((side) => ({ entityId: 'kit', name: `the ${side < 0 ? 'left' : 'right'} wall`, x: side * 2.5, z: 0, hx: 0.15, hz: 10, heading: 0, y0: 0, y1: 8 }))

function staged(): { scene: Scene; shot: Shot; hero: string } {
  const doc = createProject('Moves')
  const scene = doc.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = 6
  shot.fps = 24
  const hero = createEntity('person.man', 'HERO', { x: 0, y: 0, z: 0 })
  hero.id = 'hero'
  scene.entities.push(hero)
  return { scene, shot, hero: 'hero' }
}

/** A preset's marks around the hero from a camera 5 m in front of it (down the alley), as the app lays them. */
function laid(scene: Scene, shot: Shot, presetId: string): CameraMarkSpec[] {
  const ev = new ShotEvaluator(scene, shot)
  const hero = scene.entities.find((e) => e.id === 'hero')!
  return CAMERA_MOVE_PRESETS.find((p) => p.id === presetId)!.generate({
    subjectAt: (t) => {
      const s = ev.evaluate(t).entities.find((e) => e.entityId === 'hero')!
      return { ...s.position, heading: s.heading }
    },
    subjectHeight: entityHeight(hero.assetId, 1),
    camera: { x: 0, y: 1.6, z: -5, pan: Math.PI, tilt: 0, focalLength: 35 },
    duration: shot.duration
  })
}

/** Every frame of a move: the lens inside the set, and the set's cover of the hero over MOVE_SET_COVER. */
function blockedFrames(scene: Scene, shot: Shot, marks: CameraMarkSpec[], boxes: SetBox[]): { inside: number; covered: number } {
  const ev = new ShotEvaluator(scene, { ...shot, camera: { ...shot.camera, marks: marks.map((m, i) => ({ id: `m${i}`, ...m })), trackEntityId: 'hero' } })
  const hero = scene.entities.find((e) => e.id === 'hero')!
  let inside = 0
  let covered = 0
  for (let f = 0; f <= shot.duration * 24; f++) {
    const s = ev.evaluate(f / 24)
    const subject = shotSubjects(scene, s.entities).find((x) => x.id === 'hero')!
    if (insideOf(s.camera.position, { boxes, bodies: [] })) inside++
    const aim = aimAt(s.camera.position, trackAim(hero, subject))
    if (setCover(s.camera.position, viewFrame(aim, s.camera.focalLength, 'super35', '16:9'), subject, boxes, new Set(['hero'])).share > MOVE_SET_COVER) covered++
  }
  return { inside, covered }
}

describe('fitting a move', () => {
  const pivots: V3[] = [0, 1, 2].map(() => ({ x: 0, y: 1.4, z: 0 }))
  const orbit: CameraMarkSpec[] = [0, 90, 180].map((deg, i) => {
    const a = (deg * Math.PI) / 180
    const position = { x: Math.sin(a) * 4, y: 1.6, z: Math.cos(a) * 4 }
    return { time: i, position, ...aimAt(position, pivots[i]!), roll: 0, focalLength: 35, easeIn: 0, easeOut: 0, hold: 0 }
  })

  it('the asked-for fit is the move itself', () => {
    expect(fitMoveMarks(orbit, pivots, { closer: 1, raise: 0, arc: 1, turnDeg: 0 }, true)).toBe(orbit)
  })

  it('comes closer on a wider lens, rises, cuts and turns the sweep', () => {
    const fit = fitMoveMarks(orbit, pivots, { closer: 0.5, raise: 1, arc: 0.5, turnDeg: 90 }, true)
    expect(Math.hypot(fit[2]!.position.x, fit[2]!.position.z)).toBeCloseTo(2, 9)
    expect(fit[2]!.focalLength).toBeCloseTo(17.5, 9)
    expect(fit[0]!.position.y).toBeCloseTo(1.4 + 0.2 * 0.5 + 1, 9)
    // The sweep 0° → 180° cut to 0° → 90°, then turned 90°: 90° → 180°.
    const deg = (m: CameraMarkSpec): number => (Math.atan2(m.position.x, m.position.z) * 180) / Math.PI
    expect(deg(fit[0]!)).toBeCloseTo(90, 6)
    expect(Math.abs(deg(fit[2]!))).toBeCloseTo(180, 6)
    // A tracking move aims at the pivot.
    expect(fit[1]!.pan).toBeCloseTo(aimAt(fit[1]!.position, pivots[1]!).pan, 9)
  })

  it('lists the nearest fits first, lenses ≥ 12 mm, arcs only for a move that sweeps', () => {
    const vs = moveVariants(35, true)
    expect(vs[0]).toEqual({ closer: 1, raise: 0, arc: 1, turnDeg: 0 })
    expect(vs.every((v) => 35 * v.closer >= 12)).toBe(true)
    expect(moveVariants(35, false).every((v) => v.arc === 1)).toBe(true)
    expect(moveVariants(20, true).every((v) => v.closer >= 0.6)).toBe(true)
  })
})

describe('camera moves in a set keep the subject in view', () => {
  for (const presetId of ['orbit-360', 'orbit-90-right', 'crane-up-reveal', 'slow-push-in'])
    it(`${presetId} in an alley: the lens stays out of the walls and they cover at most a fifth of the hero, or it warns`, () => {
      const { scene, shot } = staged()
      const specs = laid(scene, shot, presetId)
      const r = clearMove(scene, shot, specs, 'hero', ALLEY, { track: true, name: presetId })
      const after = blockedFrames(scene, shot, r.marks, ALLEY)
      if (!r.warning) expect(after).toEqual({ inside: 0, covered: 0 })
      else expect(r.share).toBeGreaterThan(0)
    })

  it('an orbit in the alley is fitted, not warned, and says how', () => {
    const { scene, shot } = staged()
    const specs = laid(scene, shot, 'orbit-360')
    expect(blockedFrames(scene, shot, specs, ALLEY).covered).toBeGreaterThan(24)
    const r = clearMove(scene, shot, specs, 'hero', ALLEY, { track: true, name: 'Orbit 360°' })
    expect(r.warning).toBeUndefined()
    expect(r.note).toMatch(/^Orbit 360° fitted to the set round HERO \(blocked by the (left|right) wall\): /)
    expect(blockedFrames(scene, shot, r.marks, ALLEY)).toEqual({ inside: 0, covered: 0 })
  })

  it('on open ground a move is left exactly as the preset laid it', () => {
    const { scene, shot } = staged()
    const specs = laid(scene, shot, 'orbit-360')
    expect(clearMove(scene, shot, specs, 'hero', [], { track: true, name: 'Orbit 360°' })).toEqual({ marks: specs, variant: { closer: 1, raise: 0, arc: 1, turnDeg: 0 }, share: 1 })
  })

  it('warns when no fit can see the subject (a closet with the camera outside)', () => {
    const { scene, shot } = staged()
    const closet: SetBox[] = [
      { entityId: 'kit', name: 'the closet', x: 0, z: -0.8, hx: 0.8, hz: 0.05, heading: 0, y0: 0, y1: 8 },
      { entityId: 'kit', name: 'the closet', x: 0, z: 0.8, hx: 0.8, hz: 0.05, heading: 0, y0: 0, y1: 8 },
      { entityId: 'kit', name: 'the closet', x: -0.8, z: 0, hx: 0.05, hz: 0.8, heading: 0, y0: 0, y1: 8 },
      { entityId: 'kit', name: 'the closet', x: 0.8, z: 0, hx: 0.05, hz: 0.8, heading: 0, y0: 0, y1: 8 }
    ]
    const r = clearMove(scene, shot, laid(scene, shot, 'orbit-90-right'), 'hero', closet, { track: true, name: 'Orbit 90° Right' })
    expect(r.warning).toMatch(/^Orbit 90° Right can't keep HERO in view here past the closet: \d+% of the move is still blocked\.$/)
  })
})
