// Fork test (set-routines T3, docs/plans/2026-10-23-set-routines.md): a bot's gait loops play on one foot phase. A loop's
// warp finds its left-foot touchdown and how many strides it holds; the phase runs on over a gait change at the distance
// walked over each loop's stride; and a crossfade at the change plays both loops with the same foot down (fixture
// skeleton, synthetic stepping loops; no Mixamo data).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { GAITS } from '@engine/gaits'
import { clearMocapClips, mocapClip, mocapClipPose, registerMocapClip } from '@engine/mocap/clip'
import type { MocapPose } from '@engine/mocap/fk'
import { clipWarp, gaitClipTime } from '@engine/mocap/gait-clips'
import { loopStride } from '@engine/mocap/loop-phase'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { BONE_INDEX } from '@engine/mocap/rig'
import { createEntity, createProject } from '@engine/schema'
import { personDims } from '@engine/skeleton'
import type { ActorMark, EntityState, GaitId } from '@engine/types'
import type { AnimInput } from '@renderer/viewport/builders'
import { botInput } from '@renderer/mocap/scene'
import { fixtureSource } from './mocap-fixture'
import { syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'

/** An in-place stepping loop of `strides` strides over n frames: each leg swings back on the floor and comes forward bent, from phase `shift`. */
function stepping(n: number, strides: number, shift: number): Record<string, number>[] {
  return Array.from({ length: n }, (_, f) => {
    const p = 2 * Math.PI * ((strides * f) / (n - 1) + shift)
    return { hipLX: 0.45 * Math.sin(p), hipRX: -0.45 * Math.sin(p), kneeL: 0.9 * Math.max(0, -Math.cos(p)), kneeR: 0.9 * Math.max(0, Math.cos(p)) }
  })
}

const dims = () => personDims(MALE).mocap!
const pose = (id: string, t: number): MocapPose => mocapClipPose({ rig: dims().rig, k: 1 }, { id, t })!
/** The foot lower in a pose: 'L' or 'R'. */
const down = (p: MocapPose): 'L' | 'R' => (p.P[BONE_INDEX.LeftFoot]!.y < p.P[BONE_INDEX.RightFoot]!.y ? 'L' : 'R')

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  // Under the gait loops' library keys: a 1 s walk of one stride, a run of one stride starting a third of a step on, and
  // a "jog" holding two strides.
  registerMocapClip('walk', syntheticClip(MALE, stepping(31, 1, 0), { loop: true, grounded: true }))
  registerMocapClip('run', syntheticClip(MALE, stepping(17, 1, 0.3), { loop: true, grounded: true }))
  registerMocapClip('jog', syntheticClip(MALE, stepping(61, 2, 0.6), { loop: true, grounded: true }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('a bot\'s foot phase', () => {
  it('a loop\'s warp finds its left touchdown and its strides', () => {
    for (const [id, strides] of [['walk', 1], ['run', 1], ['jog', 2]] as const) {
      const clip = mocapClip(id)!
      const warp = clipWarp({ rig: dims().rig, k: 1 }, clip, MALE)!
      expect(warp.cycles, id).toBe(strides)
      const t = gaitClipTime(clip, warp, warp.origin!, 0)
      // At the touchdown the left foot is down, a quarter of a stride before it the right one was.
      expect(down(pose(id, t + 0.02 * (clip.duration / strides))), id).toBe('L')
      expect(down(pose(id, t - 0.25 * (clip.duration / strides))), id).toBe('R')
    }
  })

  it('runs on over a gait change, at the distance walked over each loop\'s stride', () => {
    const doc = createProject('Phase')
    const scene = doc.scenes[0]!
    const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    let n = 0
    const mark = (time: number, z: number, gait: GaitId): ActorMark => ({ id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z }, gait })
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 'walk'), mark(2, -2, 'walk'), mark(3, -6, 'run')] })
    const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 4 })
    const at = (t: number): EntityState => ev.evaluate(t).entities[0]!
    const walk = loopStride(e, 'walk')
    const run = loopStride(e, 'run')
    expect(at(1).loopPhase!).toBeCloseTo(1 / walk, 6)
    expect(at(2).loopPhase!).toBeCloseTo(2 / walk, 6)
    expect(at(2.5).loopPhase!).toBeCloseTo(2 / walk + 2 / run, 6)
    // A clip of two strides counts two foot cycles: its stride is half the loop's.
    expect(loopStride(e, 'jog') * 2).toBeCloseTo(clipWarp({ rig: dims().rig, k: 1 }, mocapClip('jog')!, MALE)!.stride * dims().k, 6)
    // A body that plays no loops has no foot phase.
    const man = createEntity('person.man', 'M', { x: 0, y: 0, z: 0 })
    scene.entities.push(man)
    scene.blocking[0]!.tracks.push({ entityId: man.id, marks: [mark(0, 0, 'walk'), mark(2, -2, 'walk')] })
    expect(new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 4 }).evaluate(1).entities.find((x) => x.entityId === man.id)!.loopPhase).toBeUndefined()
  })

  it('a crossfade at a gait change plays both loops with the same foot down, wherever the change falls', () => {
    // A run braking to a walk at 2 s, the run this far.
    for (const far of [7, 7.4, 7.8, 8.2, 8.6, 9]) {
      const doc = createProject('Fade')
      const scene = doc.scenes[0]!
      const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
      scene.entities.push(e)
      let n = 0
      const mark = (time: number, z: number, gait: GaitId): ActorMark => ({ id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z }, gait })
      scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 'run'), mark(2, -far, 'run'), mark(4, -far - 2, 'walk')] })
      const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 4 })
      const inputAt = (t: number): AnimInput => {
        const es = ev.evaluate(Math.min(Math.max(0, t), 4)).entities[0]!
        return { gait: es.gait, phase: (es.distanceTravelled / GAITS[es.gait].strideLength) % 1 || 0, speed: es.speed, distance: es.distanceTravelled, time: t }
      }
      const playing = (input: AnimInput): { id: string; t: number } => {
        const id = input.gait === 'walk' ? 'walk' : 'run'
        const clip = mocapClip(id)!
        return { id, t: gaitClipTime(clip, clipWarp({ rig: dims().rig, k: 1 }, clip, MALE), input.distance / dims().k, input.time) }
      }
      let faded = 0
      for (let t = 2.02; t < 2.25; t += 0.02) {
        const input = inputAt(t)
        botInput(e, ev.evaluate(t).entities[0]!, input, { inputAt, held: new Set() })
        expect(input.from, `${t.toFixed(2)} s`).toBeDefined()
        const a = playing(input.from!.input)
        const b = playing(input)
        expect(a.id).toBe('run')
        expect(b.id).toBe('walk')
        // The same foot down in the loop fading out and the one fading in, away from the change of foot.
        const fa = pose(a.id, a.t)
        const fb = pose(b.id, b.t)
        const gap = (p: MocapPose): number => Math.abs(p.P[BONE_INDEX.LeftFoot]!.y - p.P[BONE_INDEX.RightFoot]!.y)
        if (gap(fa) > 0.03 && gap(fb) > 0.03) {
          expect(down(fa), `run ${far} m, ${t.toFixed(2)} s`).toBe(down(fb))
          faded++
        }
      }
      expect(faded).toBeGreaterThan(3)
    }
  })
})
