// Fork addition (2026): routines and sequences give mocap bots the Fight Director's clips: strikes and defenses on the keyframe moves' impact and ready times, falls on their landing, get-ups standing at their end, the guard bounce on shot time (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRoutine, type ChoreoMarkSpec } from '@engine/choreography'
import { clipImpactTime, defenseReadyTime, fallLandTime, moveClips } from '@engine/fight/clip-moves'
import { DEFENSES, strikeImpacts } from '@engine/fight/moves'
import { clearMocapClips, mocapClip, registerMocapClip } from '@engine/mocap/clip'
import { clipPlays, tagPlay, type ClipRunMark, type MotionPlay } from '@engine/mocap/library-clips'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { bodyLowY } from '@engine/floor'
import { MOTION_PRESETS } from '@engine/motions'
import { personDims, poseEffectors } from '@engine/skeleton'
import { fixtureSource } from './mocap-fixture'
import { GUARD, registerFightClips } from './mocap-fight-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const preset = (id: string): (typeof MOTION_PRESETS)[number] => MOTION_PRESETS.find((p) => p.id === id)!

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerFightClips(MALE)
  // The rest of the falls and get-ups, and the shove reaction.
  const down = (f: number): { x: number; y: number; z: number } => ({ x: 0, y: -0.05 * Math.min(f, 16), z: -0.02 * Math.min(f, 24) })
  registerMocapClip('koStomach', syntheticClip(MALE, sweep(GUARD, { torsoX: 0.8 }, 40), { inPlace: false, hips: down }))
  for (const id of ['getUpBack', 'getUpStomach']) registerMocapClip(id, syntheticClip(MALE, sweep({ torsoX: 0.6 }, GUARD, 30), { inPlace: false, hips: (f) => ({ x: 0, y: -0.8 + 0.027 * f, z: 0 }) }))
  registerMocapClip('shoveReact', syntheticClip(MALE, sweep(GUARD, { ...GUARD, torsoX: -0.3 }, 20), { inPlace: false, hips: (f) => ({ x: 0, y: 0, z: 0.01 * f }) }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

/** A preset laid down as a routine lays it (playMotion): its keyframes from `startT`, tagged with the play. */
function laid(id: string, startT: number, mirror = false): { play: MotionPlay; marks: ChoreoMarkSpec[] } {
  const p = preset(id)
  const play: MotionPlay = { presetId: id, pos: { x: 1, y: 0, z: -2 }, heading: 0.3, startT, endT: startT + p.duration, ...(mirror ? { mirror } : {}) }
  const marks = p.keyframes.map((kf) => tagPlay(play, { time: startT + kf.t, position: { ...play.pos }, gait: 'stand' as const, easeIn: 0, easeOut: 0, hold: 0, joints: { ...kf.joints }, arriveHeading: 0.3, posedMove: true }))
  return { play, marks }
}

/** A clip's time at `t` on the marks (clip time runs linearly between a run's marks). */
function clipAt(marks: (ChoreoMarkSpec | ClipRunMark)[], id: string, t: number): number {
  for (let k = 1; k < marks.length; k++) {
    const a = marks[k - 1] as ClipRunMark
    const b = marks[k] as ClipRunMark
    if (a.clip?.id !== id || b.clip?.id !== id || t < a.time - 1e-9 || t > b.time + 1e-9) continue
    return a.clip.at + ((t - a.time) / (b.time - a.time)) * (b.clip.at - a.clip.at)
  }
  return NaN
}

describe('routines and sequences on mocap bots', () => {
  it('a strike plays its clips, each impact frame on the keyframe move’s impact', () => {
    const { play, marks } = laid('jab-cross', 1)
    const out = clipPlays(marks, { assetId: MALE })
    const blows = moveClips('jab-cross', 'head')!
    const impacts = strikeImpacts('jab-cross')
    expect(blows.map((b) => b.clip)).toEqual(['jabHead', 'cross'])
    blows.forEach((b, i) => expect(clipAt(out, b.clip, play.startT + impacts[i]!.t), b.clip).toBeCloseTo(clipImpactTime(b), 5))
    expect(out.every((m) => (m as ClipRunMark).clip)).toBe(true)
    expect(out[0]!.time).toBeGreaterThanOrEqual(play.startT - 1e-9)
    expect(out[out.length - 1]!.time).toBeLessThanOrEqual(play.endT + 1e-9)
    // Mirrored (a routine's mirrored exchange), the runs are too.
    expect(clipPlays(laid('jab-cross', 1, true).marks, { assetId: MALE }).every((m) => (m as ClipRunMark).clip.mirror)).toBe(true)
  })

  it('a defense plays its clip with the guard frame on the keyframe defense’s ready time', () => {
    for (const [id, clip, ready] of [['block-high', 'blockBody', DEFENSES.block.readyFraction], ['block-low', 'blockBody', DEFENSES.block.readyFraction], ['dodge-left', 'dodge', DEFENSES.slip.readyFraction]] as const) {
      const { play, marks } = laid(id, 2)
      const out = clipPlays(marks, { assetId: MALE })
      expect(clipAt(out, clip, play.startT + ready * preset(id).duration), id).toBeCloseTo(defenseReadyTime(clip), 5)
    }
    // Dodging left is the dodge clip mirrored (it slips to the right as captured); right, as captured.
    expect((clipPlays(laid('dodge-left', 0).marks, { assetId: MALE })[0] as ClipRunMark).clip.mirror).toBe(true)
    expect((clipPlays(laid('dodge-right', 0).marks, { assetId: MALE })[0] as ClipRunMark).clip.mirror).toBeUndefined()
  })

  it('a fall plays the fall clip for the way it falls, its floor-contact frame on the keyframe fall’s landing', () => {
    const body = { assetId: MALE }
    const dims = personDims(MALE)
    for (const [id, ko] of [['knocked-down', false], ['knockdown-fall', false], ['ko-collapse', true]] as const) {
      // The keyframe landing: the hips down to a tenth of their drop above the body's lowest point.
      const keys = preset(id).keyframes.map((kf) => ({ t: kf.t, y: poseEffectors(dims, kf.joints).pelvis.y - bodyLowY(body, kf.joints), front: poseEffectors(dims, kf.joints).head.z < poseEffectors(dims, kf.joints).pelvis.z }))
      const lo = Math.min(...keys.map((k) => k.y))
      const at = lo + 0.1 * (keys[0]!.y - lo)
      const k = keys.findIndex((x) => x.y <= at + 1e-9)
      const u = k > 0 ? (keys[k - 1]!.y - at) / (keys[k - 1]!.y - keys[k]!.y) : 1
      const land = k > 0 ? keys[k - 1]!.t + (keys[k]!.t - keys[k - 1]!.t) * u : keys[0]!.t
      const want = ko ? (keys[k]!.front ? 'koStomach' : 'koBack') : 'knockedDown'
      const { play, marks } = laid(id, 3)
      const out = clipPlays(marks, body) as ClipRunMark[]
      expect(out[0]!.clip.id, id).toBe(want)
      expect(clipAt(out, want, play.startT + land), id).toBeCloseTo(fallLandTime(want), 5)
    }
  })

  it('a get-up matches the fall before it and stands at the keyframe get-up’s end; a fallen bot stays down meanwhile', () => {
    const fall = laid('knocked-down', 1)
    const up = laid('get-up-from-ground', 6)
    // A routine's plain stand mark holding the fallen fighter (resolveFight).
    const held = { time: 4, position: { x: 1, y: 0, z: -2 }, gait: 'stand' as const, easeIn: 0, easeOut: 0, hold: 0 }
    const out = clipPlays([...fall.marks, held, ...up.marks], { assetId: MALE }) as ClipRunMark[]
    const hold = out.find((m) => Math.abs(m.time - 4) < 1e-9)!
    const fallEnd = out.filter((m) => m.clip.id === 'knockedDown').pop()!
    expect(hold.clip).toEqual(fallEnd.clip)
    const last = out[out.length - 1]!
    expect(last.clip.id).toBe('getUpKnockdown')
    expect(last.time).toBeCloseTo(up.play.endT, 6)
    expect(last.clip.at).toBeCloseTo(mocapClip('getUpKnockdown')!.duration, 6)
    // After a KO onto the front, the get-up from the front.
    const front = clipPlays([...laid('ko-collapse', 1).marks, ...up.marks], { assetId: MALE }) as ClipRunMark[]
    const fellOn = front[0]!.clip.id
    expect(front[front.length - 1]!.clip.id).toBe(fellOn === 'koStomach' ? 'getUpStomach' : 'getUpBack')
  })

  it('the guard bounce is the fight idle on shot time; a push-back at a reaction’s end moves its run’s end there', () => {
    const bounce = clipPlays(laid('boxing-guard-bounce', 2.5).marks, { assetId: MALE }) as ClipRunMark[]
    expect(bounce.every((m) => m.clip.id === 'fightIdle' && Math.abs(m.clip.at - m.time) < 1e-6)).toBe(true)
    const stagger = laid('stagger-back', 1)
    const push = { time: stagger.play.endT, position: { x: 1, y: 0, z: -1.4 }, gait: 'stand' as const, easeIn: 0, easeOut: 0, hold: 0 }
    const out = clipPlays([...stagger.marks, push], { assetId: MALE }) as ClipRunMark[]
    expect(out.every((m) => m.clip?.id === 'shoveReact')).toBe(true)
    expect(out[out.length - 1]!.position).toMatchObject({ x: 1, z: -1.4 })
  })

  it('a move with no clip, and anyone not a loaded bot, keep the keyframes', () => {
    for (const id of ['spinning-back-kick', 'low-sweep', 'teep-push-kick', 'shove-two-hands']) {
      const { marks } = laid(id, 0)
      expect(clipPlays(marks, { assetId: MALE }), id).toEqual(marks)
    }
    const { marks } = laid('jab-cross', 0)
    expect(clipPlays(marks, { assetId: 'person.man' })).toBe(marks)
    expect(clipPlays(marks, { assetId: 'person.mannequinMale' })).toBe(marks)
  })

  it('a fight routine of bots gives the strikes and defenses their clips; the exchange keeps its timing', () => {
    const spec = { kind: 'fight' as const, performers: 3, durationS: 12, seed: 7, style: 'sparring' }
    const bots = buildRoutine({ ...spec, bodies: [MALE, MALE] }, { origin: { x: 0, z: 0, heading: 0 }, bodies: [{ assetId: MALE }, { assetId: MALE }, { assetId: MALE }] })
    const people = buildRoutine(spec, { origin: { x: 0, z: 0, heading: 0 } })
    const clips = new Set(bots.flatMap((e) => e.marks.map((m) => (m as ClipRunMark).clip?.id).filter(Boolean)))
    expect([...clips].some((c) => ['jabHead', 'cross', 'hookHead'].includes(c!))).toBe(true)
    // The routine keeps its span; each performer's marks stay in time order.
    bots.forEach((e, i) => {
      // (an idle clip fills to the routine's end, where a keyframe loop stops at its last whole keyframe)
      expect(e.marks[e.marks.length - 1]!.time).toBeGreaterThanOrEqual(people[i]!.marks[people[i]!.marks.length - 1]!.time - 1e-9)
      expect(e.marks[e.marks.length - 1]!.time).toBeLessThanOrEqual(spec.durationS + 1e-9)
      for (let k = 1; k < e.marks.length; k++) expect(e.marks[k]!.time).toBeGreaterThanOrEqual(e.marks[k - 1]!.time)
    })
  })
})
