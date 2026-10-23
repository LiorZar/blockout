// Fork addition (2026, bot-slides): a bot whose first leg sets off at its first mark reads that leg's speed on frame 0, so it doesn't stand and crossfade into its gait (fixture skeleton); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { createEntity, createProject } from '@engine/schema'
import type { ActorMark, GaitId } from '@engine/types'
import { fixtureSource } from './mocap-fixture'

const BOT = 'person.mocapMale'

beforeAll(() => {
  registerMocapBody(BOT, fixtureSource())
})

afterAll(() => {
  clearMocapBodies()
})

function first(assetId: string, hold = 0): { at0: number; after: number } {
  const doc = createProject('First frame')
  const scene = doc.scenes[0]!
  const e = createEntity(assetId, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  const mark = (id: string, time: number, z: number, gait: GaitId): ActorMark => ({ id, time, hold: id === 'a' ? hold : 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z }, gait })
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark('a', 0, 0, 'run'), mark('b', 2, -8, 'run')] })
  const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 3 })
  return { at0: ev.evaluate(0).entities[0]!.speed, after: ev.evaluate(1 / 24).entities[0]!.speed }
}

describe('a bot on its first mark', () => {
  it('reads its first leg speed on frame 0 when the leg sets off there', () => {
    const { at0, after } = first(BOT)
    expect(after).toBeCloseTo(4, 3)
    expect(at0).toBeCloseTo(after, 3)
  })

  it('still stands on frame 0 while it holds there, and other bodies read 0 as upstream does', () => {
    expect(first(BOT, 0.5).at0).toBe(0)
    expect(first('person.man').at0).toBe(0)
  })
})
