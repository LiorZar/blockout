// Fork test (set-routines T3, docs/plans/2026-10-23-set-routines.md): the chase's gait changes at a run. A leg runs into a
// posed move (the runner's fall, the tackle) on the gait it departs with, not a walk at 4–5 m/s, and every travel leg of
// the chase plays a gait its pace fits (a pursuer braking behind the tackle doesn't walk at 3.8 m/s). On bots (fixture
// skeleton, a synthetic trip clip) the caught runner falls from the clip's dive and the tackler dives with it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRoutine, type ChaseEnding, type RoutineSpec } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { GAITS, checkSpeed } from '@engine/gaits'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { RUN_FROM } from '@engine/mocap/library-clips'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { describeShot } from '@engine/prompt-scene'
import { createEntity, createProject } from '@engine/schema'
import type { ActorMark, GaitId, Scene, Shot, V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MAN = 'person.man'
let n = 0
const mark = (time: number, z: number, gait: GaitId, extra: Partial<ActorMark> = {}): ActorMark => ({ id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x: 0, y: 0, z }, gait, arriveHeading: 0, ...extra })

/** The gait a body plays half way along a leg from a `from` mark to a mark `to` 2.4 m on, in 0.5 s (4.8 m/s) or `speed`. */
function legGait(from: GaitId, to: Partial<ActorMark> & { gait: GaitId }, speed = 4.8): GaitId {
  const doc = createProject('Legs')
  const scene = doc.scenes[0]!
  const e = createEntity(MAN, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, from), mark(0.5, -speed / 2, to.gait, to)] })
  return new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 2 }).evaluate(0.25).entities[0]!.gait
}

describe('a leg into a posed move', () => {
  const posed = { gait: 'stand' as GaitId, posedMove: true, joints: { kneeL: 0.3, torsoX: 0.4 } }
  it('keeps the travelling gait it departs with', () => {
    expect(legGait('run', posed)).toBe('run')
    expect(legGait('jog', posed)).toBe('jog')
    expect(legGait('walk', posed)).toBe('walk')
  })
  it('walks from a standstill or at a walking pace, and a plain stand mark is walked to (upstream)', () => {
    expect(legGait('stand', posed)).toBe('walk')
    expect(legGait('run', { gait: 'stand' })).toBe('walk')
    expect(legGait('run', posed, 0.5)).toBe('walk')
  })
})

const DUR = 8
const PEOPLE = [
  ['person.woman', 0, 8],
  ['person.man', -0.6, 10.5],
  ['person.man', 0.6, 11.5]
] as const
const BOTS = [
  ['person.mocapFemale', 0, 8],
  ['person.mocapMale', -0.6, 10.5],
  ['person.mocapMale', 0.6, 11.5]
] as const

function chase(seed: number, ending: ChaseEnding, CAST: readonly (readonly [string, number, number])[] = PEOPLE): { marks: ActorMark[][]; ev: ShotEvaluator; scene: Scene; shot: Shot } {
  const spec: RoutineSpec = { kind: 'chase', performers: 3, durationS: DUR, seed, ending }
  const specs = buildRoutine(spec, { origin: { x: 0, z: 10, heading: 0 }, bodies: CAST.map((c) => ({ assetId: c[0] })) })
  const marks = specs.map((e, i) => e.marks.map((m, k) => ({ ...m, id: `e${i}m${k}` }) as ActorMark))
  const scene = {
    id: 's',
    name: 's',
    number: 1,
    environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
    entities: CAST.map((c, i) => ({ id: `e${i}`, assetId: c[0], name: `e${i}`, label: { text: ['RUNNER', 'COP 1', 'COP 2'][i]!, color: '#888888' }, transform: { position: { x: c[1], y: 0, z: c[2] }, rotationY: specs[i]!.rotationY, scale: 1 } })),
    blocking: [{ id: 'take', name: 't', tracks: marks.map((m, i) => ({ entityId: `e${i}`, marks: m })) }],
    shots: []
  } as unknown as Scene
  const shot = { id: 'shot', name: 's', duration: DUR, fps: 24, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
  return { marks, ev: new ShotEvaluator(scene, shot), scene, shot }
}

const flat = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z)

describe('the chase\'s gaits fit its pace', () => {
  for (const ending of ['caught', 'escape'] as const)
    for (const seed of [7, 3, 21])
      it(`${ending}, seed ${seed}: no travel leg is too fast for its gait, and the legs into the fall and the tackle run`, () => {
        const { marks, ev } = chase(seed, ending)
        marks.forEach((ms, i) => {
          for (let k = 1; k < ms.length; k++) {
            const a = ms[k - 1]!
            const b = ms[k]!
            if (b.joints || b.posedMove || b.clip || b.time - a.time < 1e-6) continue
            const v = flat(a.position, b.position) / (b.time - a.time)
            // A leg into a stand mark walks there (upstream).
            const plays: GaitId = GAITS[b.gait].travels ? b.gait : 'walk'
            const verdict = checkSpeed(plays, v)
            expect(verdict.ok || verdict.kind !== 'tooFast', `e${i} ${a.time.toFixed(2)}–${b.time.toFixed(2)} s: ${plays} at ${v.toFixed(2)} m/s`).toBe(true)
          }
          // A posed move entered at a run (the caught runner's fall, the tackle): the leg into it runs.
          const k = ms.findIndex((m, j) => j > 0 && m.posedMove && !ms[j - 1]!.posedMove && !ms[j - 1]!.joints)
          if (k < 0) return
          const a = ms[k - 1]!
          const b = ms[k]!
          if (flat(a.position, b.position) / (b.time - a.time) < 3.5) return
          const st = ev.evaluate((a.time + b.time) / 2).entities.find((x) => x.entityId === `e${i}`)!
          expect(st.gait, `e${i} into the posed move at ${b.time.toFixed(2)} s`).toBe(a.gait)
          expect(['jog', 'run']).toContain(a.gait)
        })
      })
})

describe('the caught chase on bots', () => {
  beforeAll(() => {
    registerMocapBody('person.mocapMale', fixtureSource())
    registerMocapBody('person.mocapFemale', fixtureSource(0.93))
    // A made-up root-motion fall under the library's key: 2 s, the body pitching forward as it travels.
    registerMocapClip('trip', syntheticClip('person.mocapMale', sweep({}, { torsoX: 1.2 }, 61), { inPlace: false, hips: (f) => ({ x: 0, y: -0.012 * f, z: -0.03 * f }) }))
  })
  afterAll(() => {
    clearMocapClips()
    clearMocapBodies()
  })

  it('the runner falls from the trip clip\'s dive, and the tackler dives with it, still named as the tackle', () => {
    for (const seed of [7, 3, 21]) {
      const { marks, scene, shot } = chase(seed, 'caught', BOTS)
      const fall = marks[0]!.find((m) => m.clip)!
      expect(fall.clip, `seed ${seed} runner`).toMatchObject({ id: 'trip', at: RUN_FROM.trip })
      expect(fall.time).toBeCloseTo(DUR - 1.6, 6)
      const dive = marks[1]!.find((m) => m.clip)!
      expect(dive.clip, `seed ${seed} tackler`).toMatchObject({ id: 'trip', at: RUN_FROM.trip, as: 'tackle-lunge' })
      expect(dive.time).toBeCloseTo(DUR - 1.6, 6)
      // Nobody falls through the runner: the tackler's dive starts behind it.
      const h = fall.arriveHeading!
      expect((dive.position.x - fall.position.x) * -Math.sin(h) + (dive.position.z - fall.position.z) * -Math.cos(h)).toBeLessThan(-0.3)
      const words = describeShot(scene, shot).action.join(' ')
      expect(words).toMatch(/COP 1[^.]*tackle/)
      expect(words).not.toMatch(/COP 1[^.]*trips/)
    }
  })
})
