// Fork addition (2026): the motion library on mocap bots — preset → clip, clip-only motions, clip runs in apply_motion, routines, sequences and prompts (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRoutine, mirrorJoints } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { clearMocapClips, clipRoot, clipScale, mocapClip, mocapClipPose, registerMocapClip } from '@engine/mocap/clip'
import { BLEND, clipStateAt } from '@engine/mocap/clip-marks'
import { clipWarp } from '@engine/mocap/gait-clips'
import {
  CLIP_MOTIONS,
  PRESET_CLIPS,
  clipMotionName,
  clipMotionPreset,
  clipMotionPresets,
  clipRun,
  motionClip,
  motionHasClip
} from '@engine/mocap/library-clips'
import { BONE_INDEX } from '@engine/mocap/rig'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { MOTION_PRESETS } from '@engine/motions'
import { describeShot } from '@engine/prompt-scene'
import { createEntity, createProject } from '@engine/schema'
import { choreographMotion, generateSequence } from '@engine/sequences'
import { personDims, toWorld } from '@engine/skeleton'
import type { ActorMark, V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  // Synthetic clips under real library keys (no Mixamo data).
  registerMocapClip('pushUp', syntheticClip(MALE, sweep({ shoulderLX: -1.4 }, { shoulderLX: -1.2 }, 31), { loop: true }))
  registerMocapClip('fallBack', syntheticClip(MALE, sweep({}, { torsoX: -0.6 }, 46), { inPlace: false, hips: (f) => ({ x: 0.01 * f, y: 0, z: 0.02 * f }) }))
  registerMocapClip('crawl', syntheticClip(MALE, sweep({}, {}, 31), { loop: true, hips: (f) => ({ x: 0, y: 0, z: 0.02 * f }) }))
  for (const key of ['danceSalsa', 'danceHipHop', 'danceRunningMan', 'danceUprock', 'danceShuffle', 'danceKickStep', 'danceHouse', 'danceSamba', 'danceSwing', 'danceTwist', 'backflip'])
    registerMocapClip(key, syntheticClip(MALE, sweep({ hipLX: 0 }, { hipLX: -0.3 }, 61), { loop: key !== 'backflip' }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('the motion library on bots', () => {
  it('maps presets onto library clips in a fork table, MOTION_PRESETS untouched, and lists the clips with no preset', () => {
    for (const id of Object.keys(PRESET_CLIPS)) expect(MOTION_PRESETS.some((p) => p.id === id), id).toBe(true)
    expect(MOTION_PRESETS.every((p) => p.keyframes.length > 0)).toBe(true)
    const mapped = new Set(Object.values(PRESET_CLIPS).map((c) => c.clip))
    for (const c of CLIP_MOTIONS) expect(mapped.has(c.clip), c.clip).toBe(false)
    // Only clips the library has are offered.
    expect(clipMotionPresets().map((p) => p.id)).toEqual(['mocap-backflip'])
    expect(clipMotionPreset('mocap-backflip')).toMatchObject({ name: 'Backflip', category: 'stunt', keyframes: [] })
    expect(clipMotionPreset('mocap-sneak')).toBeUndefined()
    expect(motionHasClip('push-ups')).toBe(true)
    expect(motionHasClip('jab-cross')).toBe(false)
  })

  it('plays a clip on a loaded bot only', () => {
    expect(motionClip('push-ups', { assetId: MALE })).toEqual({ clip: 'pushUp' })
    expect(motionClip('push-ups', { assetId: 'person.man' })).toBeNull()
    expect(motionClip('wave', { assetId: MALE })).toBeNull()
    expect(motionClip('mocap-backflip', { assetId: FEMALE })).toEqual({ clip: 'backflip' })
    clearMocapBodies()
    try {
      expect(motionClip('push-ups', { assetId: MALE })).toBeNull()
    } finally {
      registerMocapBody(MALE, fixtureSource())
      registerMocapBody(FEMALE, fixtureSource(0.93))
    }
  })

  it('lays a clip run as two marks: a loop fills the span, a one-shot plays out and holds', () => {
    const pos = { x: 1, y: 0, z: -2 }
    const loop = clipRun({ clip: 'pushUp' }, { assetId: MALE }, pos, 0.5, 2, 9)
    expect(loop).toHaveLength(2)
    expect(loop.map((m) => [m.time, m.clip.at])).toEqual([[2, 0], [9, 7]])
    expect(loop.every((m) => m.posedMove && m.arriveHeading === 0.5 && m.gait === 'stand' && m.easeIn === 0 && m.easeOut === 0)).toBe(true)
    expect(dist(loop[1]!.position, pos)).toBeLessThan(1e-12)
    const once = clipRun({ clip: 'backflip' }, { assetId: MALE }, pos, 0, 0, 9)
    expect(once[1]!.time).toBeCloseTo(mocapClip('backflip')!.duration, 9)
    expect(clipRun({ clip: 'backflip' }, { assetId: MALE }, pos, 0, 0, 9, true)[0]!.clip).toEqual({ id: 'backflip', at: 0, mirror: true })
  })

  it('moves a root-motion run along the clip\'s travel and an in-place travelling loop along its stride, turned to the heading', () => {
    for (const id of [MALE, FEMALE]) {
      const m = personDims(id).mocap!
      const pos = { x: 0, y: 0, z: 0 }
      const c = mocapClip('fallBack')!
      const run = clipRun({ clip: 'fallBack' }, { assetId: id, scale: 1.1 }, pos, 0.7, 0, 10)
      const k = clipScale(m, c.hipH) * 1.1
      const a = clipRoot(c, 0)
      const b = clipRoot(c, c.duration)
      expect(dist(run[1]!.position, toWorld({ x: (b.x - a.x) * k, y: 0, z: (b.z - a.z) * k }, pos, 0.7, 1))).toBeLessThan(1e-9)
      const crawl = clipRun({ clip: 'crawl' }, { assetId: id }, pos, 0, 0, 2)
      const stride = clipWarp(m, mocapClip('crawl')!, id)!.stride
      expect(crawl[1]!.position.z).toBeCloseTo((-stride * 2) / mocapClip('crawl')!.duration, 6)
    }
  })

  it('plays an in-place travelling run on its warp: the body moves evenly and a planted foot stays put', () => {
    // The contacts slide back faster and faster through the loop (0.3 to 0.7 m/s).
    const legs = sweep({ hipLX: -0.2, hipRX: 0.2 }, { hipLX: -0.2, hipRX: 0.2 }, 31)
    registerMocapClip('accel', syntheticClip(MALE, legs, { loop: true, hips: (f) => ({ x: 0, y: 0, z: 0.3 * (f / 30) + 0.2 * (f / 30) ** 2 }) }))
    const m = personDims(MALE).mocap!
    const pos = { x: 1, y: 0, z: 2 }
    const run = clipRun({ clip: 'accel' }, { assetId: MALE }, pos, 0.4, 0, 1)
    expect(dist(run[1]!.position, pos)).toBeCloseTo(0.5, 6)
    const doc = createProject('Warp')
    const scene = doc.scenes[0]!
    const e = createEntity(MALE, 'A', pos)
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: run.map((mk, i) => ({ id: `w${i}`, ...mk })) })
    const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 1 })
    const foot = (t: number): V3 => {
      const st = ev.evaluate(t).entities[0]!
      return toWorld(mocapClipPose(m, st.clip!)!.P[BONE_INDEX.LeftFoot]!, st.position, st.heading, 1)
    }
    const planted = foot(0)
    for (const t of [0.2, 0.5, 0.8, 0.95]) {
      expect(dist({ ...foot(t), y: 0 }, { ...planted, y: 0 }), `t=${t}`).toBeLessThan(1e-4)
      expect(dist(ev.evaluate(t).entities[0]!.position, pos)).toBeCloseTo(0.5 * t, 6)
    }
  })

  it('apply_motion (choreographMotion) gives a bot the clip run and anyone else the keyframes', () => {
    const pos = { x: 0, y: 0, z: 0 }
    const bot = choreographMotion('push-ups', pos, 0, 6, 0, { assetId: MALE })!
    expect(bot).toHaveLength(2)
    expect(bot[0]!.clip).toEqual({ id: 'pushUp', at: 0 })
    const man = choreographMotion('push-ups', pos, 0, 6, 0, { assetId: 'person.man' })!
    expect(man.length).toBeGreaterThan(2)
    expect(man.every((m) => !m.clip)).toBe(true)
    // A preset with no clip keeps its keyframes on a bot; a clip-only motion plays on bots only.
    expect(choreographMotion('wave', pos, 0, 6, 0, { assetId: MALE })!.every((m) => !m.clip)).toBe(true)
    expect(choreographMotion('mocap-backflip', pos, 0, 6, 0, { assetId: 'person.man' })).toBeNull()
  })

  it('apply_motion mirrors the travel of a flipped clip run with its pose', () => {
    const pos = { x: 1, y: 0, z: 2 }
    const plain = choreographMotion('fall-backwards', pos, 0.4, 6, 0, { assetId: MALE })!
    const flipped = choreographMotion('fall-backwards', pos, 0.4, 6, 0, { assetId: MALE }, true)!
    expect(flipped.map((m) => m.clip)).toEqual(plain.map((m) => ({ ...m.clip, mirror: true })))
    // The travel in the performer's own frame: sideways flips, forward stays.
    const local = (p: V3): V3 => {
      const d = { x: p.x - pos.x, z: p.z - pos.z }
      return { x: d.x * Math.cos(0.4) - d.z * Math.sin(0.4), y: 0, z: d.x * Math.sin(0.4) + d.z * Math.cos(0.4) }
    }
    const a = local(plain[1]!.position)
    const b = local(flipped[1]!.position)
    expect(Math.abs(a.x)).toBeGreaterThan(0.1)
    expect(b.x).toBeCloseTo(-a.x, 9)
    expect(b.z).toBeCloseTo(a.z, 9)
    // The evaluator plays it there: the performer ends on the second mark.
    const doc = createProject('Mirror')
    const scene = doc.scenes[0]!
    const e = createEntity(MALE, 'A', pos)
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: flipped.map((m, i) => ({ id: `f${i}`, ...m })) })
    const st = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 6 }).evaluate(flipped[1]!.time).entities[0]!
    expect(dist({ ...st.position, y: 0 }, { ...flipped[1]!.position, y: 0 })).toBeLessThan(1e-9)
  })

  it('routines and sequences cast as bots play their motions as clip runs, each run crossfading into the next', () => {
    const spec = { kind: 'dance' as const, performers: 4, durationS: 16, seed: 7, style: 'latin', bodies: [MALE, FEMALE] as [string, string] }
    const bots = buildRoutine(spec, { origin: { x: 0, z: 0, heading: 0 } })
    const classic = buildRoutine({ ...spec, bodies: undefined }, { origin: { x: 0, z: 0, heading: 0 } })
    const clipped = bots.flatMap((e) => e.marks.filter((m) => m.clip))
    expect(clipped.length).toBeGreaterThan(0)
    expect(classic.flatMap((e) => e.marks).some((m) => m.clip)).toBe(false)
    expect(bots[0]!.marks.length).toBeLessThan(classic[0]!.marks.length)
    // Back-to-back runs leave a crossfade between them.
    for (const e of bots)
      for (let i = 1; i + 1 < e.marks.length; i++) {
        const [a, b] = [e.marks[i]!, e.marks[i + 1]!]
        if (a.clip && b.clip && a.clip.id !== b.clip.id) expect(b.time - a.time).toBeGreaterThanOrEqual(BLEND - 1e-6)
      }
    const seq = generateSequence({ type: 'dance', count: 4, style: 'salsa-step', origin: { x: 0, z: 0, heading: 0.3 }, duration: 8, bodies: [MALE, FEMALE] })
    expect(seq.map((e) => e.assetId)).toEqual([MALE, FEMALE, MALE, FEMALE])
    for (const e of seq) {
      expect(e.marks.map((m) => m.clip?.id)).toEqual(['danceSalsa', 'danceSalsa'])
      expect(e.marks[0]!.arriveHeading).toBe(0.3)
    }
    const plain = generateSequence({ type: 'dance', count: 4, style: 'salsa-step', origin: { x: 0, z: 0, heading: 0.3 }, duration: 8 })
    expect(plain.flatMap((e) => e.marks).some((m) => m.clip)).toBe(false)
  })

  it('a clip that starts over crossfades instead of playing backwards', () => {
    const m = (time: number, at: number): ActorMark => ({ id: `m${time}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z: 0 }, gait: 'stand', posedMove: true, clip: { id: 'backflip', at } })
    const st = clipStateAt({ leg: { from: m(2, 2), to: m(2.5, 0), departTime: 2, arriveTime: 2.5 }, atMark: null, legProgress: 0.5 }, 2.25, 0.5)
    expect(st).toEqual({ id: 'backflip', t: 0, w: 0.5, from: { id: 'backflip', t: 2 } })
  })

  it('mirrors the hand channels with the rest of the pose', () => {
    expect(mirrorJoints({ handL: 1, elbowR: 0.4 })).toEqual({ handR: 1, elbowL: 0.4 })
  })

  it('names a clip run in the prompt by its motion', () => {
    expect(clipMotionName('pushUp')?.id).toBe('push-ups')
    expect(clipMotionName('backflip')?.name).toBe('Backflip')
    const doc = createProject('Prompt')
    const scene = doc.scenes[0]!
    const e = createEntity(MALE, 'A', { x: 0, y: 0, z: 0 })
    e.label = { text: 'A', color: '#e5484d' }
    scene.entities.push(e)
    const marks = choreographMotion('push-ups', { x: 0, y: 0, z: 0 }, 0, 4, 0, { assetId: MALE })!.map((m, i) => ({ id: `k${i}`, ...m }))
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks })
    const words = describeShot(scene, scene.shots[0]!).action.join(' ')
    expect(words.toLowerCase()).toContain('push')
    // And the bot is where the run puts it.
    const st = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 4 }).evaluate(2).entities[0]!
    expect(st.clip).toEqual({ id: 'pushUp', t: 2 })
  })
})
