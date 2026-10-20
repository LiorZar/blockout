// Fork addition (2026): a mocap bot sits on a seat prop when one takes its hips, on the floor otherwise (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { gaitClipId } from '@engine/mocap/gait-clips'
import { SEAT_ASSETS, clipMotion, clipPlays, runTravel, seatSpots, seatUnder, tagPlay } from '@engine/mocap/library-clips'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { createEntity } from '@engine/schema'
import { choreographMotion } from '@engine/sequences'
import { toWorld } from '@engine/skeleton'
import type { V3 } from '@engine/types'
import { poseKind } from '@renderer/mocap/scene'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z)

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  // Synthetic clips under the library's keys: stepping back 0.45 m into a sit, two sitting loops.
  const SIT = { hipLX: -1.5, hipRX: -1.5, kneeL: 1.5, kneeR: 1.5 }
  registerMocapClip('standToSit', syntheticClip(MALE, sweep({}, SIT, 61), { inPlace: false, hips: (f) => ({ x: 0, y: 0, z: 0.0075 * f }) }))
  registerMocapClip('sitChair', syntheticClip(MALE, sweep(SIT, { ...SIT, torsoX: 0.1 }, 31), { loop: true, inPlace: false }))
  registerMocapClip('sitFloor', syntheticClip(MALE, sweep({ hipLX: -1.5, hipRX: -1.5 }, { hipLX: -1.5, hipRX: -1.5, torsoX: 0.1 }, 31), { loop: true, inPlace: false, grounded: true }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

const chair = (x: number, z: number, assetId = 'furniture.chair'): ReturnType<typeof createEntity> => createEntity(assetId, 'Seat', { x, y: 0, z })

describe('a bot sits on a seat prop, or on the floor', () => {
  it('finds a seat prop under a point: catalog seats only, within their footprint, on the same floor', () => {
    for (const id of ['furniture.chair', 'furniture.stool', 'furniture.couch', 'furniture.armchair', 'furniture.officeChair', 'prop.bench']) expect(SEAT_ASSETS.has(id), id).toBe(true)
    expect(SEAT_ASSETS.has('furniture.diningTable')).toBe(false)
    const entities = [chair(0, 0), chair(3, 0, 'furniture.diningTable'), chair(-3, 0, 'prop.bench')]
    const seats = seatSpots(entities)
    expect(seats.map((s) => s.assetId)).toEqual(['furniture.chair', 'prop.bench'])
    expect(seatUnder(seats, { x: 0.1, y: 0, z: -0.15 })?.assetId).toBe('furniture.chair')
    expect(seatUnder(seats, { x: 0.6, y: 0, z: 0 })).toBeUndefined()
    expect(seatUnder(seats, { x: 3, y: 0, z: 0 })).toBeUndefined()
    expect(seatUnder(seats, { x: -2.3, y: 0, z: 0 })?.assetId).toBe('prop.bench')
    // Another floor, or a bigger chair.
    expect(seatUnder(seats, { x: 0, y: 3, z: 0 })).toBeUndefined()
    expect(seatUnder(seatSpots([{ ...chair(0, 0), transform: { ...chair(0, 0).transform, scale: 2 } }]), { x: 0.5, y: 0, z: 0 })).toBeDefined()
    // Where the seat is at a time, when given.
    expect(seatUnder(seatSpots(entities, () => ({ x: 9, y: 0, z: 9 })), { x: 0, y: 0, z: 0 })).toBeUndefined()
  })

  it('sit-down on a bot over a seat: stands, sits back onto it (the hips land where they are), then sits in the chair', () => {
    const pos = { x: 1, y: 0, z: 2 }
    const marks = clipMotion('sit-down', { assetId: MALE }, pos, 0.5, 8, 0, false, seatSpots([chair(1.1, 2.05)]))!
    expect(marks.map((m) => m.clip.id)).toEqual(['standToSit', 'standToSit', 'sitChair', 'sitChair'])
    expect(dist(marks[1]!.position, pos)).toBeLessThan(0.3)
    // The stand-to-sit runs along its own travel and ends with the hips over the seat.
    const back = runTravel('standToSit', { assetId: MALE }, 0, marks[1]!.clip.at)
    expect(dist(toWorld(back, marks[0]!.position, 0.5, 1), marks[1]!.position)).toBeLessThan(1e-9)
    expect(dist(toWorld(runTravel('standToSit', { assetId: MALE }, 0, 2), marks[0]!.position, 0.5, 1), pos)).toBeLessThan(1e-9)
    // The chair idle takes over from where it sat, after a crossfade, and fills the span.
    expect(dist(marks[2]!.position, toWorld(runTravel('standToSit', { assetId: MALE }, 0, 2), marks[0]!.position, 0.5, 1))).toBeLessThan(1e-9)
    expect(marks[2]!.time - marks[1]!.time).toBeGreaterThan(0.2)
    expect(marks[3]!.time).toBe(8)
  })

  it('sit-down in front of a seat sits back onto it; with no seat it sits on the floor', () => {
    const pos = { x: 0, y: 0, z: 0 }
    const landing = toWorld(runTravel('standToSit', { assetId: MALE }, 0, 2), pos, 0, 1)
    const behind = clipMotion('sit-down', { assetId: MALE }, pos, 0, 8, 0, false, seatSpots([chair(landing.x, landing.z)]))!
    expect(behind[0]!.position).toEqual(pos)
    expect(behind[1]!.clip.id).toBe('standToSit')
    for (const seats of [[], seatSpots([chair(0, 0, 'furniture.diningTable')]), seatSpots([chair(4, 4)])]) {
      const floor = clipMotion('sit-down', { assetId: MALE }, pos, 0, 8, 0, false, seats)!
      expect(floor.map((m) => [m.clip.id, m.time])).toEqual([['sitFloor', 0], ['sitFloor', 8]])
      expect(dist(floor[1]!.position, pos)).toBeLessThan(1e-12)
    }
    // apply_motion's path takes the seats; routines and sequences (no seats) sit on the floor.
    expect(choreographMotion('sit-down', pos, 0, 8, 0, { assetId: MALE }, false, seatSpots([chair(0, 0)]))!.map((m) => m.clip!.id)[0]).toBe('standToSit')
    const play = { presetId: 'sit-down', pos, startT: 1, endT: 5 }
    const run = clipPlays([tagPlay(play, { time: 1 }), tagPlay(play, { time: 5 })], { assetId: MALE })
    expect(run.map((m) => ('clip' in m ? (m as { clip: { id: string } }).clip.id : '-'))).toEqual(['sitFloor', 'sitFloor'])
    // Anyone else keeps the keyframes.
    expect(clipMotion('sit-down', { assetId: 'person.man' }, pos, 0, 8, 0, false, seatSpots([chair(0, 0)]))).toBeNull()
  })

  it('the sit gait plays the chair idle on a seat and the floor sit elsewhere', () => {
    expect(gaitClipId(MALE, 'sit', 0, true)).toBe('sitChair')
    expect(gaitClipId(MALE, 'sit', 0, false)).toBe('sitFloor')
    expect(gaitClipId(MALE, 'sit', 0)).toBe('sitFloor')
    expect(poseKind(MALE, { gait: 'sit', phase: 0, speed: 0, distance: 0, time: 0, seated: true })).toBe('sitChair')
    expect(poseKind(MALE, { gait: 'sit', phase: 0, speed: 0, distance: 0, time: 0 })).toBe('sitFloor')
  })
})
