// Fork test (chase-feet T1, T2, docs/plans/2026-10-23-chase-feet.md): a bot's planted feet stay put through a gait
// crossfade. A run braking to a walk crossfades two loops with the same foot down at spots their strides put apart, and
// the blend dragged that foot along the floor; the plant lock keeps each foot where it planted until it lifts and eases
// the difference out over its swing. Into a standing pose, which never lifts a foot, the feet step to the stance
// (fixture skeleton, synthetic stepping loops; no Mixamo data).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ShotEvaluator } from '@engine/evaluate'
import { GAITS } from '@engine/gaits'
import { clearMocapClips, mocapClip, registerMocapClip } from '@engine/mocap/clip'
import { clipWarp, gaitPose } from '@engine/mocap/gait-clips'
import { plantCorrection, type PlantFoot, type PlantSample } from '@engine/mocap/plant-lock'
import { clearMocapBodies } from '@engine/mocap/registry'
import { swingGaitPose } from '@engine/mocap/swing-legs'
import { createEntity, createProject } from '@engine/schema'
import { personDims } from '@engine/skeleton'
import type { ActorMark, Entity, EntityState, GaitId, Scene, Shot } from '@engine/types'
import { buildAsset, type AnimInput } from '@renderer/viewport/builders'
import { primaryBones } from '@renderer/mocap/extract'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { botInput } from '@renderer/mocap/scene'
import { fixtureCharacter } from './mocap-three-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FPS = 24

/** An in-place stepping loop of one stride over n frames, the legs swinging `amp` rad from phase `shift`. */
function stepping(n: number, shift: number, amp: number): Record<string, number>[] {
  return Array.from({ length: n }, (_, f) => {
    const p = 2 * Math.PI * (f / (n - 1) + shift)
    return { hipLX: amp * Math.sin(p), hipRX: -amp * Math.sin(p), kneeL: 0.9 * Math.max(0, -Math.cos(p)), kneeR: 0.9 * Math.max(0, Math.cos(p)) }
  })
}

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapClip('idle', syntheticClip(MALE, sweep({ torsoX: 0 }, { torsoX: 0.05 }, 31), { loop: true }))
  // A 1 s walk of short strides and a run of long ones, a third of a step apart.
  registerMocapClip('walk', syntheticClip(MALE, stepping(31, 0, 0.3), { loop: true, grounded: true }))
  registerMocapClip('run', syntheticClip(MALE, stepping(17, 0.3, 0.6), { loop: true, grounded: true }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

type P3 = [number, number, number]
interface Frame {
  t: number
  bones: Record<string, P3>
}

/** The bot's bones per frame, posed as SceneManager poses it (its inputs, botInput's extras, the visual's animate). */
function shoot(scene: Scene, shot: Shot, e: Entity, lock = true, from = 0): Frame[] {
  const ev = new ShotEvaluator(scene, { ...shot, camera: { ...shot.camera, marks: [], trackEntityId: undefined } })
  const cache = new Map<number, EntityState>()
  const stateAt = (t: number): EntityState => {
    const time = Math.min(Math.max(0, t), shot.duration)
    let s = cache.get(time)
    if (!s) cache.set(time, (s = ev.evaluate(time).entities.find((x) => x.entityId === e.id)!))
    return s
  }
  const inputOf = (es: EntityState, t: number): AnimInput => {
    let overrides: Record<string, number> | undefined
    if (es.joints) for (const [k, v] of Object.entries(es.joints)) if (v !== 0) (overrides ??= {})[k] = v
    const stride = GAITS[es.gait].strideLength
    return { gait: es.gait, phase: stride > 0 ? (es.distanceTravelled / stride) % 1 : 0, speed: es.speed, distance: es.distanceTravelled, time: t, overrides }
  }
  const inputAt = (t: number): AnimInput => inputOf(stateAt(t), Math.min(Math.max(0, t), shot.duration))
  const vis = buildAsset(e.assetId)
  const bones = primaryBones(vis.group)
  const out: Frame[] = []
  for (let f = from; f < Math.round(shot.duration * FPS); f++) {
    const t = f / FPS
    const es = stateAt(t)
    const input = inputAt(t)
    botInput(e, es, input, { inputAt, held: new Set(), ...(lock ? { stateAt, memo: ev } : {}) })
    vis.animate!(input)
    vis.group.position.set(es.position.x, es.position.y, es.position.z)
    vis.group.rotation.y = es.heading
    vis.group.updateMatrixWorld(true)
    const row: Record<string, P3> = {}
    for (const n of ['Hips', 'LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase']) {
      const w = bones.get(n)!.getWorldPosition(new THREE.Vector3())
      row[n] = [w.x, w.y, w.z]
    }
    out.push({ t, bones: row })
  }
  return out
}

/** QA's skate runs: per foot, the toe's travel over the floor while it is down (toe and ankle near their lowest), runs over 0.25 m/s. */
function slides(frames: Frame[]): { side: string; t0: number; t1: number; d: number }[] {
  const runs: { side: string; t0: number; t1: number; d: number }[] = []
  for (const side of ['Left', 'Right']) {
    const toe = `${side}ToeBase`
    const ank = `${side}Foot`
    const tf = Math.min(...frames.map((r) => r.bones[toe]![1]))
    const af = Math.min(...frames.map((r) => r.bones[ank]![1]))
    let run: { side: string; t0: number; t1: number; d: number } | null = null
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!.bones
      const c = frames[i]!.bones
      const down = a[toe]![1] < tf + 0.025 && c[toe]![1] < tf + 0.025 && c[ank]![1] < af + 0.04
      const d = Math.hypot(c[toe]![0] - a[toe]![0], c[toe]![2] - a[toe]![2])
      if (down && d * FPS > 0.25) {
        run ??= { side: side[0]!, t0: frames[i - 1]!.t, t1: frames[i]!.t, d: 0 }
        run.d += d
        run.t1 = frames[i]!.t
      }
      else if (run) {
        runs.push(run)
        run = null
      }
    }
    if (run) runs.push(run)
  }
  return runs
}

/** A bot running `far` metres in 2 s, then walking 2.4 m in 2 s. */
function braking(far: number): { scene: Scene; shot: Shot; e: Entity } {
  const doc = createProject('Brake')
  const scene = doc.scenes[0]!
  const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  let n = 0
  const mark = (time: number, z: number, gait: GaitId): ActorMark => ({ id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z }, gait })
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 'run'), mark(2, -far, 'run'), mark(4, -far - 2.4, 'walk')] })
  return { scene, shot: { ...scene.shots[0]!, duration: 4, fps: FPS }, e }
}

describe('the plant lock', () => {
  it('keeps a planted foot put through a run braking to a walk, wherever the change falls', () => {
    let before = 0
    for (const far of [7, 7.4, 7.8, 8.2, 8.6, 9]) {
      const { scene, shot, e } = braking(far)
      const near = (r: { t0: number }): boolean => r.t0 > 1.9 && r.t0 < 3
      before = Math.max(before, ...slides(shoot(scene, shot, e, false)).filter(near).map((r) => r.d))
      const after = slides(shoot(scene, shot, e)).filter(near)
      expect(Math.max(0, ...after.map((r) => r.d)), `run ${far} m: ${JSON.stringify(after)}`).toBeLessThan(0.02)
    }
    // Without it the blend drags a foot (the bug).
    expect(before).toBeGreaterThan(0.05)
  })

  it('steps the feet into a standing pose instead of gliding them there', () => {
    let glide = 0
    for (const [far, stand] of [[2.4, 'idle'], [2.55, 'idle'], [2.4, 'rig'], [2.7, 'rig']] as const) {
      const doc = createProject('Stop')
      const scene = doc.scenes[0]!
      const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
      scene.entities.push(e)
      let n = 0
      const mark = (time: number, z: number, gait: GaitId, joints?: Record<string, number>): ActorMark => ({ id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z }, gait, ...(joints ? { joints, posedMove: true } : {}) })
      // Walking in, then stopping: on the idle loop, or on a keyframe stand (hands on hips).
      const pose = stand === 'rig' ? { shoulderLZ: 0.6, shoulderRZ: 0.6, elbowL: 1.4, elbowR: 1.4 } : undefined
      scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 'walk'), mark(2, -far, 'walk'), mark(2.4, -far, 'stand', pose)] })
      const shot = { ...scene.shots[0]!, duration: 3.5, fps: FPS }
      const near = (r: { t0: number }): boolean => r.t0 > 1.8
      const before = slides(shoot(scene, shot, e, false)).filter(near)
      const after = slides(shoot(scene, shot, e)).filter(near)
      glide = Math.max(glide, ...before.map((r) => r.d))
      // What's left is a swinging foot touching down at the crossfade's end (3.4 cm at 2.7 m, as without the lock).
      expect(Math.max(0, ...after.map((r) => r.d)), `${stand} ${far} m: ${JSON.stringify(after)} (without: ${JSON.stringify(before)})`).toBeLessThan(0.035)
    }
    // Without it a planted foot glides into the stance (the bug).
    expect(glide).toBeGreaterThan(0.1)
  })

  it('keeps the run loop\'s planted feet under a keyframe beat\'s leg channels', () => {
    for (const speed of [3, 4.5]) {
      const doc = createProject('Beat')
      const scene = doc.scenes[0]!
      const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
      scene.entities.push(e)
      let n = 0
      const mark = (time: number, joints?: Record<string, number>): ActorMark => ({ id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z: -speed * time }, gait: 'run', ...(joints ? { joints } : {}) })
      // A stumble's legs riding the run (chase-tracks' `ride`): the keys every 0.3 s.
      const beat: Record<string, number>[] = [{}, { hipLX: -0.6, hipRX: 0.4, kneeL: 0.4, kneeR: 0.9, torsoX: 0.8 }, { hipLX: 0.4, hipRX: 0.5, kneeL: 0.7, kneeR: 0.6, torsoX: 0.5 }, { hipLX: 0, hipRX: 0, kneeL: 0.2, kneeR: 0.2, torsoX: 0.15 }]
      const track = (beat: Record<string, number>[]): void => {
        scene.blocking[0]!.tracks = [{ entityId: e.id, marks: [mark(0), ...beat.map((j, i) => mark(1 + 0.3 * i, j)), mark(3)] }]
      }
      track(beat)
      const shot = { ...scene.shots[0]!, duration: 3, fps: FPS }
      const during = (r: { t0: number }): boolean => r.t0 > 0.95 && r.t0 < 2.1
      const frames = shoot(scene, shot, e)
      const after = slides(frames).filter(during)
      expect(Math.max(0, ...after.map((r) => r.d)), `${speed} m/s: ${JSON.stringify(after)}`).toBeLessThan(0.02)
      // The swinging legs still take the beat's channels (against the same beat with its torso only).
      track(beat.map((j): Record<string, number> => (j.torsoX !== undefined ? { torsoX: j.torsoX } : {})))
      const torso = shoot(scene, shot, e)
      const apart = (f: number): number => Math.max(...['LeftFoot', 'RightFoot'].map((b) => Math.hypot(...frames[f]!.bones[b]!.map((v, i) => v - torso[f]!.bones[b]![i]!))))
      expect(Math.max(...Array.from({ length: 24 }, (_, i) => apart(24 + i)))).toBeGreaterThan(0.1)
      // And the beat's crouch: its bent legs lower the hips.
      const sink = Math.max(...Array.from({ length: 24 }, (_, i) => torso[24 + i]!.bones.Hips![1] - frames[24 + i]!.bones.Hips![1]))
      expect(sink).toBeGreaterThan(0.03)
    }
  })

  it('poses a bot lifted off the floor (a vault) with the beat\'s whole legs, as before', () => {
    const m = personDims(MALE).mocap!
    const clip = mocapClip('run')!
    const warp = clipWarp(m, clip, MALE)
    const tuck = { torsoX: 0.8, hipLX: 0.8, hipRX: 0.8, kneeL: 1.6, kneeR: 1.6 }
    let floor = 0
    for (const d of [0, 0.3, 0.7, 1.1, 1.6]) {
      const was = gaitPose(m, clip, warp, d, 0, tuck).pose
      expect(swingGaitPose(m, clip, warp, d, 0, tuck, 0.5).pose).toEqual(was)
      floor = Math.max(floor, ...swingGaitPose(m, clip, warp, d, 0, tuck).pose.P.map((p, b) => Math.hypot(p.x - was.P[b]!.x, p.z - was.P[b]!.z)))
    }
    // On the floor, a foot the loop has down goes where the loop has it instead.
    expect(floor).toBeGreaterThan(0.05)
    // The bot's input carries its root's height over the ground.
    const doc = createProject('Vault')
    const scene = doc.scenes[0]!
    const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    const mark = (id: string, time: number, y: number): ActorMark => ({ id, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y, z: -4 * time }, gait: 'run', joints: tuck })
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark('a', 0, 0), mark('b', 1, 0.5), mark('c', 2, 0.5)] })
    const es = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 2 }).evaluate(1.5).entities.find((x) => x.entityId === e.id)!
    const input: AnimInput = { gait: es.gait, phase: 0, speed: es.speed, distance: es.distanceTravelled, time: 1.5 }
    botInput(e, es, input, { inputAt: () => null, held: new Set() })
    expect(es.position.y).toBeGreaterThan(0.4)
    expect(input.lift).toBe(es.position.y)
  })

  it('leaves the loops alone away from the change', () => {
    const { scene, shot, e } = braking(8)
    const a = shoot(scene, shot, e, false)
    const b = shoot(scene, shot, e)
    for (const f of [0, 12, 36, 90]) expect(b[f]!.bones).toEqual(a[f]!.bones)
  })

  it('poses a frame the same whatever was drawn before it (its window on a fixed grid)', () => {
    const { scene, shot, e } = braking(7.4)
    const forward = shoot(scene, shot, e)
    // A fresh evaluator and visual, each frame of the change drawn alone, last first.
    for (const f of [56, 52, 50, 49]) expect(shoot(scene, shot, e, true, f)[0]!.bones, `frame ${f}`).toEqual(forward[f]!.bones)
  })
})

describe('plantCorrection', () => {
  const foot = (x: number, up: number, hip = 0): PlantFoot => ({ toe: { x, z: 0 }, ankle: { x: x - 0.15, z: 0 }, toeUp: up, ankleUp: up + 0.05, hip: { x: hip, z: 0 }, hipY: 0.9, ankleY: 0.08, leg: 0.88 })
  const at = (t: number, L: PlantFoot, o: Partial<PlantSample> = {}): PlantSample => ({ t, L, R: foot(0, 0.2), mixed: true, ...o })

  it('cancels a planted foot\'s travel, then eases it out over the swing', () => {
    // Down from 0 to 0.1 s while the pose slides it 5 cm, then up.
    const s = [0, 1, 2, 3, 4, 5].map((i) => at(i * 0.02, foot(0.01 * i, 0)))
    expect(plantCorrection(s).L.x).toBeCloseTo(-0.05, 9)
    const lifted = [...s, at(0.12, foot(0.07, 0.1)), at(0.22, foot(0.2, 0.15)), at(0.32, foot(0.3, 0.1))]
    expect(plantCorrection(lifted.slice(0, 7)).L.x).toBeCloseTo(-0.05 * (1 - 0.1 ** 2 * (3 - 0.2)), 9)
    expect(plantCorrection(lifted).L.x).toBeCloseTo(0, 9)
  })

  it('steps a foot off a hold it can\'t reach, through the air', () => {
    // The hips run on 0.2 m a sample over a foot the pose slides along with them.
    const s = Array.from({ length: 12 }, (_, i) => at(i * 0.02, foot(0.2 * i * 0.5, 0, 0.2 * i)))
    const steps = s.map((_, n) => plantCorrection(s.slice(0, n + 1)).L)
    expect(Math.max(...steps.map((m) => m.up))).toBeGreaterThan(0.03)
    expect(steps.at(-1)!.x).toBeCloseTo(0, 9)
  })

  it('in a standing pose, steps a held foot to its spot once the other foot stands, the one further off first', () => {
    // L held 4 cm off its spot, R 2 cm off; then the pose stands still.
    const both = (t: number, l: number, r: number, still = false): PlantSample => ({ t, L: foot(l, 0), R: foot(r, 0), mixed: !still, still })
    const s = [both(0, 0, 0), both(0.02, 0.04, 0.02), both(0.04, 0.04, 0.02, true)]
    const first = plantCorrection(s)
    expect(first.L.x).toBeCloseTo(-0.04, 9)
    const mid = plantCorrection([...s, both(0.14, 0.04, 0.02, true)])
    expect(mid.L.up).toBeGreaterThan(0.03)
    expect(mid.R).toEqual({ x: -0.02, z: 0, up: 0 })
    // L down again on its spot: R's turn.
    const next = plantCorrection([...s, both(0.14, 0.04, 0.02, true), both(0.26, 0.04, 0.02, true), both(0.36, 0.04, 0.02, true), both(0.46, 0.04, 0.02, true)])
    expect(next.L.x).toBeCloseTo(0, 9)
    expect(next.R.up).toBeGreaterThan(0.03)
    // With the other foot in the air it waits.
    const waits = plantCorrection([both(0, 0, 0), both(0.02, 0.04, 0.02), { ...both(0.04, 0.04, 0.02, true), R: foot(0.02, 0.2) }, { ...both(0.2, 0.04, 0.02, true), R: foot(0.02, 0.2) }])
    expect(waits.L).toEqual({ x: -0.04, z: 0, up: 0 })
  })
})
