// Fork addition (2026, bot-slides): after a blow the push that keeps two bots apart eases in over frames instead of landing in one (skinned fixture bots, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { parseFightScript } from '@engine/fight/script'
import { solveFight } from '@engine/fight/solve'
import { clearMocapClips } from '@engine/mocap/clip'
import { clearMocapBodies } from '@engine/mocap/registry'
import type { FightDoc, Scene, Shot } from '@engine/types'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { fixtureCharacter } from './mocap-three-fixture'
import { registerFightClips } from './mocap-fight-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const FPS = 24

beforeAll(() => {
  // Skinned bots: the solver keeps their skins apart after each blow (`separate`).
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapTemplate(FEMALE, fixtureCharacter(0.93))
  registerFightClips(MALE)
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

function staged(script: string, gap: number): { ev: ShotEvaluator; warnings: string[]; impacts: number[] } {
  const parsed = parseFightScript(script, ['A', 'B'])
  if (!('beats' in parsed)) throw new Error(parsed.error)
  const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
  const sol = solveFight(fight, [MALE, FEMALE].map((assetId, q) => ({ entityId: q ? 'b' : 'a', assetId, scale: 1, start: { x: q ? gap : -gap, y: 0, z: 0 } })) as never, { duration: 6, fps: FPS })
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
  const ev = new ShotEvaluator(scene, { id: 'shot', name: 's', duration: 6, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot)
  return { ev, warnings: sol.report.warnings, impacts: sol.report.beats.flatMap((b) => b.impactTimes) }
}

describe('the push after a blocked blow', () => {
  it('eases the defender back a few centimetres a frame, not all of it on the frame after the blow', () => {
    // Blocked jabs whose follow-through runs into the guard: the defender rocks back (separate's push).
    for (const [script, gap] of [
      ['A jab cross to head -> block, hit', 0.55],
      ['A jab to head -> block', 0.8]
    ] as const) {
      const { ev, warnings, impacts } = staged(script, gap)
      expect(warnings.some((w) => /rocks back|further back/.test(w)), `${script}: ${JSON.stringify(warnings)}`).toBe(true)
      // The first blow is blocked and absorbed: after it the defender moves only by the push.
      const T = impacts[0]!
      let prev = ev.evaluate(T).entities.find((e) => e.entityId === 'b')!.position
      for (let k = 1; k <= 8; k++) {
        const p = ev.evaluate(T + k / FPS).entities.find((e) => e.entityId === 'b')!.position
        // At most SEP_RATE (1 m/s), 4.2 cm a frame (it was 8.9 cm on the frame after the blow).
        expect(Math.hypot(p.x - prev.x, p.z - prev.z), `${script} gap ${gap}: frame ${k} after the blow`).toBeLessThan(0.045)
        prev = p
      }
    }
  })
})
