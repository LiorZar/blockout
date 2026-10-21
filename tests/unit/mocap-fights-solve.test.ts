// Fork addition (2026): the Fight Director on mocap bots — the clip solve: impact frames on the target, the overlay ramp, reactions by side, the idle, knockdowns, the keyframe fallback (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { clipImpactTime, defenseReadyTime, reactionOnset } from '@engine/fight/clip-moves'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { skinDepth, skinPoints } from '@engine/mocap/surface'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { EntityState, FightDoc, Scene, Shot, V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { registerFightClips } from './mocap-fight-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const FPS = 24
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerFightClips(MALE)
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

function solve(script: string, assets: [string, string] = [MALE, FEMALE], duration = 20): { sol: FightSolution; ev: ShotEvaluator } {
  const parsed = parseFightScript(script, ['A', 'B'])
  if (!('beats' in parsed)) throw new Error(parsed.error)
  const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
  const input = (id: string, assetId: string, x: number): FighterInput => ({ entityId: id, assetId, scale: 1, start: { x, y: 0, z: 0 } })
  const sol = solveFight(fight, [input('a', assets[0], -0.55), input('b', assets[1], 0.55)], { duration, fps: FPS })
  const scene = {
    id: 's',
    name: 's',
    number: 1,
    environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
    entities: ['a', 'b'].map((id, q) => ({ id, assetId: assets[q], name: id, transform: { position: { x: q ? 0.55 : -0.55, y: 0, z: 0 }, rotationY: 0, scale: 1 } })),
    blocking: [{ id: 'take', name: 't', tracks: ['a', 'b'].map((id, q) => ({ entityId: id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${id}${k}` })) })) }],
    shots: []
  } as unknown as Scene
  const shot = { id: 'shot', name: 's', duration, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
  return { sol, ev: new ShotEvaluator(scene, shot) }
}

describe('the Fight Director on mocap bots', { timeout: 30_000 }, () => {
  it('plays a combo as its clips, each impact frame on the beat frame and the fist skin to skin on the head, the report naming the effectors', () => {
    for (const assets of [[MALE, FEMALE], [FEMALE, MALE]] as [string, string][]) {
      const { sol, ev } = solve('A jab cross to head -> hit, hit power 0.5', assets)
      const beat = sol.report.beats[0]!
      expect(beat.plays).toBe('mocap:jabHead+cross')
      expect(beat.effectors).toEqual(['handL', 'handR'])
      const clips = ['jabHead', 'cross']
      beat.impactTimes.forEach((T, i) => {
        expect(Math.abs(T * FPS - Math.round(T * FPS))).toBeLessThan(1e-9)
        const st = ev.evaluate(T)
        const a = st.entities.find((e) => e.entityId === 'a')!
        const d = st.entities.find((e) => e.entityId === 'b')!
        // The clip's own impact frame, on the beat's frame.
        expect(a.clip?.id).toBe(clips[i])
        expect(a.clip!.t).toBeCloseTo(clipImpactTime({ clip: clips[i]!, effector: beat.effectors![i] as 'handL' }), 9)
        // Skin to skin: the fist's skin (its support points near the palm) just touches the head's (their support hull).
        const e = beat.effectors![i] as 'handL'
        const ma = personDims(assets[0]).mocap!
        const md = personDims(assets[1]).mocap!
        const palm = poseEffectors(personDims(assets[0]), a.joints, a.clip)[e]
        const fist = skinPoints(ma, a.joints, a.clip, e, palm).map((p) => toWorld(p, a.position, a.heading, 1))
        const head = skinPoints(md, d.joints, d.clip, 'head').map((p) => toWorld(p, d.position, d.heading, 1))
        expect(Math.abs(skinDepth(fist, head)), `${assets} blow ${i + 1}`).toBeLessThan(0.001)
        // Nothing of the fist is inside the head, and part of it is at its skin.
        expect(Math.min(...fist.map((q) => Math.min(...head.map((p) => dist(p, q)))))).toBeLessThan(0.05)
        expect(beat.contactErrorM[i]).toBeLessThan(0.001)
      })
    }
  })

  it('ramps the reach overlay in before the impact and out after it, the clip running under it', () => {
    const { sol, ev } = solve('A jab cross to head -> hit, hit power 0.5')
    const T = sol.report.beats[0]!.impactTimes[0]!
    const marks = sol.tracks[0]
    const impact = marks.find((m) => Math.abs(m.time - T) < 1e-9)!
    const tau = impact.clip!.at
    const pitch = impact.joints!
    expect(Object.values(pitch).some((v) => Math.abs(v) > 1e-3)).toBe(true)
    // Every mark of the jab's run carries the overlay scaled by the ramp: zero 0.2 s before the impact and 0.25 s after it.
    const run = marks.filter((m) => m.clip?.id === 'jabHead')
    expect(run.length).toBeGreaterThan(5)
    for (const m of run) {
      const d = m.clip!.at - tau
      const w = Math.max(0, d < 0 ? 1 + d / 0.2 : 1 - d / 0.25)
      for (const [key, v] of Object.entries(pitch)) expect(m.joints?.[key] ?? 0, `at ${m.clip!.at}`).toBeCloseTo(v * w, 9)
    }
    expect(run.some((m) => Math.abs(m.clip!.at - (tau - 0.2)) < 1e-9 && Object.values(m.joints ?? {}).every((v) => v === 0))).toBe(true)
    expect(run.some((m) => Math.abs(m.clip!.at - (tau + 0.25)) < 1e-9 && Object.values(m.joints ?? {}).every((v) => v === 0))).toBe(true)
    // Between marks the clip time runs on linearly.
    const a = (t: number): EntityState => ev.evaluate(t).entities.find((e) => e.entityId === 'a')!
    expect(a(T - 0.05).clip!.id).toBe('jabHead')
    expect(a(T - 0.05).clip!.t).toBeLessThan(tau)
  })

  it('reacts on the impact frame with the hit from the side the blow lands on', () => {
    const { sol, ev } = solve('A jab cross to head -> hit, hit power 0.2')
    const beat = sol.report.beats[0]!
    const [T1, T2] = beat.impactTimes
    const d = (t: number): EntityState => ev.evaluate(t).entities.find((e) => e.entityId === 'b')!
    // The left jab lands on the right side of the head (the head goes left); the cross, from the right, on the left.
    expect(beat.physics.map((ph) => ph.result).every((r) => r === 'none' || r === 'absorb'), JSON.stringify(beat.physics.map((ph) => ph.result))).toBe(true)
    expect(d(T1!).clip).toMatchObject({ id: 'hitHeadLeft', t: reactionOnset('hitHeadLeft') })
    expect(d(T2!).clip).toMatchObject({ id: 'hitHeadRight', t: reactionOnset('hitHeadRight') })
    // A staggering blow takes the big head hit.
    const big = solve('A jab cross to head -> hit, hit power 1')
    const b = big.sol.report.beats[0]!
    expect(b.physics[1]!.result).toBe('stagger')
    expect(big.ev.evaluate(b.impactTimes[1]!).entities.find((e) => e.entityId === 'b')!.clip?.id).toBe('hitHeadBig')
  })

  it('blocks with its guard frame on the impact, the blow on the guard hand', () => {
    const { sol, ev } = solve('A hook to head -> block power 0.5')
    const beat = sol.report.beats[0]!
    expect(beat.plays).toBe('mocap:hookHead')
    const d = ev.evaluate(beat.impactTimes[0]!).entities.find((e) => e.entityId === 'b')!
    // Bare hands block a head blow on the shell (fight-polish).
    expect(d.clip?.id).toBe('blockBody')
    expect(d.clip!.t).toBeCloseTo(defenseReadyTime('blockBody'), 9)
    expect(beat.contactErrorM[0]).toBeLessThan(0.001)
  })

  it('holds the fight idle on shot time between beats and to the end of the shot', () => {
    const { sol } = solve('A jab cross to head -> hit, hit power 0.5\nB hook to head -> hit power 0.5', [MALE, FEMALE], 12)
    for (const marks of sol.tracks) {
      const idle = marks.filter((m) => m.clip?.id === 'fightIdle')
      expect(idle.length).toBeGreaterThan(3)
      for (const m of idle) expect(m.clip!.at).toBeCloseTo(m.time, 9)
      expect(marks[0]!.clip?.id).toBe('fightIdle')
      expect(marks[marks.length - 1]!).toMatchObject({ time: 12, clip: { id: 'fightIdle', at: 12 } })
      // Every bot fight mark is a posed move, or the end of a walk.
      for (let i = 1; i < marks.length; i++) if (!marks[i]!.posedMove) expect(marks[i]!.gait).toBe('walk')
    }
  })

  it('a knockout plays the KO clip on the physics root: it falls the physics slide away from the blow and stays down', () => {
    const { sol, ev } = solve('A jab cross to head -> hit, ko power 1')
    const beat = sol.report.beats[0]!
    const T = beat.impactTimes[1]!
    expect(beat.physics[1]!.result).toBe('knockdown')
    const d = (t: number): EntityState => ev.evaluate(t).entities.find((e) => e.entityId === 'b')!
    expect(d(T).clip).toMatchObject({ id: 'koBack', t: reactionOnset('koBack') })
    const a = ev.evaluate(T).entities.find((e) => e.entityId === 'a')!
    const away = { x: d(T).position.x - a.position.x, z: d(T).position.z - a.position.z }
    const end = sol.tracks[1][sol.tracks[1].length - 1]!
    const moved = { x: end.position.x - d(T).position.x, z: end.position.z - d(T).position.z }
    expect((moved.x * away.x + moved.z * away.z) / Math.hypot(away.x, away.z)).toBeCloseTo(beat.physics[1]!.slide, 2)
    expect(end.clip?.id).toBe('koBack')
  })

  it('a move with no clip plays its keyframes on the bot, crossfaded from the idle', () => {
    const { sol, ev } = solve('A spinning-backfist to head -> hit power 0.5')
    const beat = sol.report.beats[0]!
    expect(beat.plays).toBe('spinning-backfist')
    expect(beat.contactErrorM[0]).toBeLessThan(0.001)
    const marks = sol.tracks[0]
    const first = marks.findIndex((m) => !m.clip)
    expect(marks[first - 1]!.clip?.id).toBe('fightIdle')
    const mid = (marks[first - 1]!.time + marks[first]!.time) / 2
    const w = ev.evaluate(mid).entities.find((e) => e.entityId === 'a')!.clip?.w
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThan(1)
  })

  it('a landed blow gets through a guard held in front of the face: the arm in its way drops, then comes back', () => {
    // Head hits that start with both hands up in front of the face.
    const face = { shoulderLX: -1.5, elbowL: 1.8, shoulderLZ: -0.8, shoulderRX: -1.5, elbowR: 1.8, shoulderRZ: -0.8 }
    for (const id of ['hitHeadLeft', 'hitHeadRight']) registerMocapClip(id, syntheticClip(MALE, sweep(face, { ...face, headX: -0.3 }, 20), { inPlace: false }))
    try {
      const { sol, ev } = solve('A jab cross to head -> hit, hit power 0.2')
      const beat = sol.report.beats[0]!
      for (const e of beat.contactErrorM) expect(e).toBeLessThan(0.001)
      const T = beat.impactTimes[0]!
      const d = (t: number): EntityState => ev.evaluate(t).entities.find((e) => e.entityId === 'b')!
      const drop = Math.max(d(T).joints?.shoulderLX ?? 0, d(T).joints?.shoulderRX ?? 0)
      expect(drop).toBeGreaterThan(0.05)
      expect(Math.max(d(T + 0.45).joints?.shoulderLX ?? 0, d(T + 0.45).joints?.shoulderRX ?? 0)).toBeLessThan(1e-9)
    } finally {
      registerFightClips(MALE, ['hitHeadLeft', 'hitHeadRight'])
    }
  })
})
