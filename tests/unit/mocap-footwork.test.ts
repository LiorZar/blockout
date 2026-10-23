// Fork addition (2026, qa-fixes): a bot's feet step instead of sliding where its marks move or turn the root past its clips (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { parseFightScript } from '@engine/fight/script'
import { solveFight } from '@engine/fight/solve'
import { botPose, clearMocapClips, clipRoot, clipScale, mocapClip, registerMocapClip } from '@engine/mocap/clip'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { BONE_INDEX } from '@engine/mocap/rig'
import { createEntity, createProject } from '@engine/schema'
import { personDims, toWorld } from '@engine/skeleton'
import type { ActorMark, ClipState, EntityState, FightDoc, MarkClip, Scene, Shot, V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { registerFightClips } from './mocap-fight-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const I = BONE_INDEX
const FEET = [
  [I.LeftFoot, I.LeftToeBase],
  [I.RightFoot, I.RightToeBase]
] as const

/** A fighting stance (left foot forward, knees bent), its switch (right foot forward), and a kick off the left foot. */
const STANCE = { hipLX: -0.25, kneeL: 0.25, hipRX: 0.1 }
const SWITCH = { hipRX: -0.25, kneeR: 0.25, hipLX: 0.1 }
const KICK = { hipLX: -0.1, kneeL: 0.1, hipRX: -1.4, kneeR: 0.2 }

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerFightClips(MALE)
  registerMocapClip('stance', syntheticClip(MALE, sweep(STANCE, STANCE, 31), { grounded: true, loop: true }))
  registerMocapClip('switch', syntheticClip(MALE, sweep(SWITCH, SWITCH, 31), { grounded: true, loop: true }))
  registerMocapClip('kick', syntheticClip(MALE, sweep(KICK, KICK, 31), { grounded: true }))
  registerMocapClip('lunge', syntheticClip(MALE, sweep(STANCE, STANCE, 31), { grounded: true, inPlace: false, hips: (f) => ({ x: 0, y: 0, z: (-0.5 * f) / 30 }) }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

let n = 0
function mark(time: number, x: number, z: number, clip: MarkClip, heading = 0): ActorMark {
  return { id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x, y: 0, z }, gait: 'stand', posedMove: true, lockFacing: true, arriveHeading: heading, clip }
}

function evaluator(marks: ActorMark[], duration = 3): ShotEvaluator {
  const doc = createProject('Footwork')
  const scene = doc.scenes[0]!
  const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks })
  return new ShotEvaluator(scene, { ...scene.shots[0]!, duration })
}

const m = (): NonNullable<ReturnType<typeof personDims>['mocap']> => personDims(MALE).mocap!

/** A clip state without its footwork. */
function bare(clip: ClipState): ClipState {
  const out = { ...clip }
  delete out.step
  return out
}

/** A foot's ankle and toe in the world at a state (the engine's pose, as the renderer poses it). */
function foot(st: EntityState, q: 0 | 1): { ankle: V3; toe: V3 } {
  const pose = botPose(m(), st.joints, st.clip)
  const w = (p: V3): V3 => toWorld(p, st.position, st.heading, 1)
  return { ankle: w(pose.P[FEET[q][0]]!), toe: w(pose.P[FEET[q][1]]!) }
}

/**
 * QA's slide measure (`skate-runs.cjs`): per foot, how far its toe moves over the floor between samples where it is on
 * it (toe within 2.5 cm and ankle within 4 cm of their lowest), in all; and the largest such move in one frame (24 fps).
 */
function slides(ev: ShotEvaluator, t0: number, t1: number): { slide: number[]; step: number[] } {
  const dt = 1 / 24
  const rows: { ankle: V3; toe: V3 }[][] = []
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    const st = ev.evaluate(t).entities[0]!
    rows.push([foot(st, 0), foot(st, 1)])
  }
  return ([0, 1] as const).reduce(
    (out, q) => {
      const tf = Math.min(...rows.map((r) => r[q]!.toe.y))
      const af = Math.min(...rows.map((r) => r[q]!.ankle.y))
      let slide = 0
      let step = 0
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1]![q]!
        const b = rows[i]![q]!
        if (!(a.toe.y < tf + 0.025 && b.toe.y < tf + 0.025 && b.ankle.y < af + 0.04)) continue
        const d = Math.hypot(b.toe.x - a.toe.x, b.toe.z - a.toe.z)
        slide += d
        step = Math.max(step, d)
      }
      out.slide.push(slide)
      out.step.push(step)
      return out
    },
    { slide: [] as number[], step: [] as number[] }
  )
}

describe('bot footwork', () => {
  it('steps the feet where the marks carry the root past an in-place clip; a planted foot stays put', () => {
    const ev = evaluator([mark(0, 0, 0, { id: 'stance', at: 0 }), mark(0.2, 0, 0, { id: 'stance', at: 0.2 }), mark(0.7, 0, -0.6, { id: 'stance', at: 0.7 }), mark(1.2, 0, -0.6, { id: 'stance', at: 1.2 })])
    const { slide } = slides(ev, 0, 1.2)
    for (const s of slide) expect(s).toBeLessThan(0.05)
    // Each foot ends up 60 cm on, where the clip puts it over the new spot.
    for (const q of [0, 1] as const) {
      const a = foot(ev.evaluate(0).entities[0]!, q).ankle
      const b = foot(ev.evaluate(1.2).entities[0]!, q).ankle
      expect(b.z - a.z).toBeCloseTo(-0.6, 3)
      expect(b.x - a.x).toBeCloseTo(0, 3)
    }
    // Lifted while it steps (each foot's highest ankle over its planted height).
    const lift = [0, 1].map((q) => {
      let hi = 0
      for (let t = 0.2; t <= 0.7; t += 1 / 96) hi = Math.max(hi, foot(ev.evaluate(t).entities[0]!, q as 0 | 1).ankle.y)
      return hi - foot(ev.evaluate(0).entities[0]!, q as 0 | 1).ankle.y
    })
    for (const l of lift) expect(l).toBeGreaterThan(0.03)
  })

  it('takes several steps for a long move, each at most MAX_STEP', () => {
    const ev = evaluator([mark(0, 0, 0, { id: 'stance', at: 0 }), mark(1.2, 0, 1.5, { id: 'stance', at: 1.2 })])
    const st = ev.evaluate(0.6).entities[0]!
    expect(st.clip?.step?.n).toBeGreaterThanOrEqual(4)
    const { slide } = slides(ev, 0, 1.2)
    for (const s of slide) expect(s).toBeLessThan(0.05)
  })

  it('keeps the feet planted while the marks turn the body on the spot', () => {
    const ev = evaluator([mark(0, 0, 0, { id: 'stance', at: 0 }), mark(0.5, 0, 0, { id: 'stance', at: 0.5 }, 0.8), mark(1, 0, 0, { id: 'stance', at: 1 }, 0.8)])
    const { slide } = slides(ev, 0, 1)
    for (const s of slide) expect(s).toBeLessThan(0.05)
  })

  it('a crossfade to a switched stance steps each foot to its new spot instead of sliding both', () => {
    const ev = evaluator([mark(0, 0, 0, { id: 'stance', at: 0 }), mark(0.3, 0, 0, { id: 'stance', at: 0.3 }), mark(0.5, 0, 0, { id: 'switch', at: 0.5 }), mark(1, 0, 0, { id: 'switch', at: 1 })])
    const { slide } = slides(ev, 0, 1)
    for (const s of slide) expect(s).toBeLessThan(0.05)
    // The ends are the clips' own poses.
    const plain = (t: number, q: 0 | 1): V3 => {
      const st = ev.evaluate(t).entities[0]!
      return toWorld(botPose(m(), st.joints, bare(st.clip!)).P[FEET[q][0]]!, st.position, st.heading, 1)
    }
    for (const q of [0, 1] as const) for (const t of [0.3, 0.5]) expect(Math.hypot(foot(ev.evaluate(t).entities[0]!, q).ankle.x - plain(t, q).x, foot(ev.evaluate(t).entities[0]!, q).ankle.z - plain(t, q).z)).toBeLessThan(1e-6)
  })

  it("moves only the legs: a foot off the floor, the hips and the hands are the clip's", () => {
    const ev = evaluator([mark(0, 0, 0, { id: 'kick', at: 0 }), mark(0.5, 0, -0.3, { id: 'kick', at: 0.5 }, 0.3)])
    const st = ev.evaluate(0.25).entities[0]!
    expect(st.clip?.step).toBeDefined()
    const a = botPose(m(), st.joints, st.clip)
    const b = botPose(m(), st.joints, bare(st.clip!))
    const d = (bone: number): number => Math.hypot(a.P[bone]!.x - b.P[bone]!.x, a.P[bone]!.y - b.P[bone]!.y, a.P[bone]!.z - b.P[bone]!.z)
    for (const bone of [I.Hips, I.Head, I.LeftHand, I.RightHand, I.RightFoot, I.RightToeBase]) expect(d(bone)).toBeLessThan(1e-9)
    expect(d(I.LeftFoot)).toBeGreaterThan(0.05)
  })

  it("leaves a run alone whose marks follow the clip's own travel", () => {
    const c = mocapClip('lunge')!
    const k = clipScale(m(), c.hipH)
    const r = (t: number): { x: number; z: number } => clipRoot(c, t)
    const ev = evaluator([mark(0, 0, 0, { id: 'lunge', at: 0 }), mark(0.5, (r(0.5).x - r(0).x) * k, (r(0.5).z - r(0).z) * k, { id: 'lunge', at: 0.5 }), mark(1, (r(1).x - r(0).x) * k, (r(1).z - r(0).z) * k, { id: 'lunge', at: 1 })])
    for (const t of [0.1, 0.4, 0.75]) expect(ev.evaluate(t).entities[0]!.clip?.step).toBeUndefined()
  })
})

describe("the Fight Director's bots step", () => {
  it('a step-in and a walk back to guard between clips are posed crossfades whose feet step, not a walk under a clip blend', () => {
    const parsed = parseFightScript('A jab cross to head -> hit, hit power 0.5\nB hook to head -> hit power 0.5', ['A', 'B'])
    if (!('beats' in parsed)) throw new Error(parsed.error)
    const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
    const sol = solveFight(fight, [MALE, FEMALE].map((assetId, q) => ({ entityId: q ? 'b' : 'a', assetId, scale: 1, start: { x: q ? 0.55 : -0.55, y: 0, z: 0 } })) as never, { duration: 12, fps: 24 })
    const ids = ['a', 'b']
    const scene = {
      id: 's',
      name: 's',
      number: 1,
      environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
      entities: ids.map((id, q) => ({ id, assetId: q ? FEMALE : MALE, name: id, transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } })),
      blocking: [{ id: 'take', name: 't', tracks: ids.map((id, q) => ({ entityId: id, marks: sol.tracks[q]!.map((mk, k) => ({ ...mk, id: `${id}${k}` })) })) }],
      shots: []
    } as unknown as Scene
    const ev = new ShotEvaluator(scene, { id: 'shot', name: 's', duration: 12, fps: 24, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot)
    let travelled = 0
    sol.tracks.forEach((marks, q) => {
      for (let k = 1; k < marks.length; k++) {
        const [a, b] = [marks[k - 1]!, marks[k]!]
        if (!a.clip || !b.clip) continue
        expect(a.posedMove && b.posedMove, `${ids[q]} ${a.time.toFixed(2)}→${b.time.toFixed(2)}`).toBe(true)
        if (Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) < 0.1) continue
        // A real move between two clips: the feet step over it.
        travelled++
        const st = ev.evaluate((a.time + b.time) / 2).entities.find((e) => e.entityId === ids[q])!
        expect(st.clip?.step, `${ids[q]} ${a.time.toFixed(2)}→${b.time.toFixed(2)}`).toBeDefined()
      }
    })
    expect(travelled).toBeGreaterThan(0)
  })

  it('a keyframe move steps in on the idle and plays over it (bot-slides): no stance crossfade, the pivot foot planted, the kicking foot back on its spot', () => {
    const parsed = parseFightScript('A spinning-back-kick to body -> hit power 0.5', ['A', 'B'])
    if (!('beats' in parsed)) throw new Error(parsed.error)
    const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
    const sol = solveFight(fight, [MALE, FEMALE].map((assetId, q) => ({ entityId: q ? 'b' : 'a', assetId, scale: 1, start: { x: q ? 0.8 : -0.8, y: 0, z: 0 } })) as never, { duration: 8, fps: 24 })
    expect(sol.report.beats[0]!.plays).toBe('spinning-back-kick')
    const marks = sol.tracks[0]
    // Every mark plays the idle on shot time: the move is its overlay.
    for (const mk of marks) expect(mk.clip, `t ${mk.time.toFixed(3)}`).toEqual({ id: 'fightIdle', at: mk.time })
    // The step-in: the idle moving under its feet, then the move where it stands.
    const t0 = sol.report.beats[0]!.startT
    const first = marks.findIndex((mk) => Math.abs(mk.time - t0) < 1e-6)
    const [before, kf] = [marks[first - 1]!, marks[first]!]
    expect(Math.hypot(kf.position.x - before.position.x, kf.position.z - before.position.z)).toBeGreaterThan(0.05)
    const end = marks.findIndex((mk, k) => k > first && mk.time > t0 + 1.3 - 1e-6)
    for (let k = first; k <= end; k++) expect(Math.hypot(marks[k]!.position.x - kf.position.x, marks[k]!.position.z - kf.position.z)).toBeLessThan(1e-9)
    // From its first key to its last the pivot (left) foot doesn't move; the kicking (right) foot ends where it started and never slides.
    const scene = {
      id: 's',
      name: 's',
      number: 1,
      environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
      entities: ['a', 'b'].map((id, q) => ({ id, assetId: q ? FEMALE : MALE, name: id, transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } })),
      blocking: [{ id: 'take', name: 't', tracks: [{ entityId: 'a', marks: marks.map((mk, k) => ({ ...mk, id: `a${k}` })) }] }],
      shots: []
    } as unknown as Scene
    const ev = new ShotEvaluator(scene, { id: 'shot', name: 's', duration: 8, fps: 24, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot)
    const t1 = marks[end]!.time
    const at = (t: number, q: 0 | 1): V3 => foot(ev.evaluate(t).entities.find((e) => e.entityId === 'a')!, q).ankle
    for (let t = t0; t <= t1 + 1e-9; t += 1 / 24) expect(Math.hypot(at(t, 0).x - at(t0, 0).x, at(t, 0).z - at(t0, 0).z), `pivot t ${t.toFixed(3)}`).toBeLessThan(0.01)
    expect(Math.hypot(at(t1, 1).x - at(t0, 1).x, at(t1, 1).z - at(t0, 1).z)).toBeLessThan(0.01)
    const { slide } = slides(ev, t0, t1)
    for (const s of slide) expect(s).toBeLessThan(0.05)
  })
})
