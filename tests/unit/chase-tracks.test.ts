// Fork test (qa-fixes, docs/plans/2026-10-23-qa-fixes.md): the Choreographer's foot chase runs on tracks. QA's chase (mocap-qa
// bugs 1, 2, 5) on plain people: no root jumps through the scripted beats, the pursuers start behind the runner on their own
// spots, nobody runs through anybody before the tackle, and a beat over the run keeps the run's floor.
import { describe, expect, it } from 'vitest'
import { buildRoutine, type ChaseEnding, type RoutineSpec } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { ActorMark, Scene, Shot, V3 } from '@engine/types'

const FPS = 24
const DUR = 8
// QA's cast: RUNNER, COP 1, COP 2 at (0, 8), (-0.6, 10.5), (0.6, 11.5), facing heading 0; choreograph_entities stages around their centroid.
const CAST = [
  ['person.woman', 0, 8],
  ['person.man', -0.6, 10.5],
  ['person.man', 0.6, 11.5]
] as const

function stage(seed: number, ending: ChaseEnding): { ev: ShotEvaluator; marks: ActorMark[][] } {
  const spec: RoutineSpec = { kind: 'chase', performers: 3, durationS: DUR, seed, ending }
  const origin = { x: 0, z: (8 + 10.5 + 11.5) / 3, heading: 0 }
  const specs = buildRoutine(spec, { origin, bodies: CAST.map((c) => ({ assetId: c[0] })) })
  const marks = specs.map((e, i) => e.marks.map((m, k) => ({ ...m, id: `e${i}m${k}` }) as ActorMark))
  const scene = {
    id: 's',
    name: 's',
    number: 1,
    environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
    entities: CAST.map((c, i) => ({ id: `e${i}`, assetId: c[0], name: `e${i}`, transform: { position: { x: c[1], y: 0, z: c[2] }, rotationY: specs[i]!.rotationY, scale: 1 } })),
    blocking: [{ id: 'take', name: 't', tracks: marks.map((m, i) => ({ entityId: `e${i}`, marks: m })) }],
    shots: []
  } as unknown as Scene
  const shot = { id: 'shot', name: 's', duration: DUR, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
  return { ev: new ShotEvaluator(scene, shot), marks }
}

/** Every frame: each performer's root and hips (world). */
function frames(ev: ShotEvaluator): { roots: V3[][]; hips: V3[][] } {
  const roots: V3[][] = CAST.map(() => [])
  const hips: V3[][] = CAST.map(() => [])
  for (let f = 0; f < DUR * FPS; f++) {
    const st = ev.evaluate(f / FPS)
    CAST.forEach((c, i) => {
      const e = st.entities.find((x) => x.entityId === `e${i}`)!
      roots[i]!.push(e.position)
      hips[i]!.push(toWorld(poseEffectors(personDims(c[0]), e.joints).pelvis, e.position, e.heading, 1))
    })
  }
  return { roots, hips }
}

const flat = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z)

describe('the Choreographer chase on tracks (mocap-qa bugs 1, 2, 5)', () => {
  for (const ending of ['caught', 'escape'] as const)
    for (const seed of [7, 3, 21]) {
      it(`${ending}, seed ${seed}: no root moves more than 0.45 m in a frame at 24 fps`, () => {
        const { roots } = frames(stage(seed, ending).ev)
        for (const r of roots)
          for (let f = 1; f < r.length; f++) expect(flat(r[f]!, r[f - 1]!), `frame ${f}`).toBeLessThanOrEqual(0.45)
      })

      it(`${ending}, seed ${seed}: the pursuers start behind the runner, each on its own spot`, () => {
        const { marks } = stage(seed, ending)
        const first = marks.map((m) => m[0]!)
        expect(first.every((m) => m.time === 0)).toBe(true)
        const h = first[0]!.arriveHeading!
        const fwd = { x: -Math.sin(h), z: -Math.cos(h) }
        for (const p of first.slice(1)) expect((p.position.x - first[0]!.position.x) * fwd.x + (p.position.z - first[0]!.position.z) * fwd.z).toBeLessThan(-3)
        expect(flat(first[1]!.position, first[2]!.position)).toBeGreaterThan(1.2)
      })

      it(`${ending}, seed ${seed}: no two bodies' hips come within 35 cm before the tackle`, () => {
        const { hips } = frames(stage(seed, ending).ev)
        const contact = ending === 'caught' ? Math.round((DUR - 1.6 + 0.6) * FPS) : DUR * FPS
        for (let f = 0; f < contact; f++)
          for (let a = 0; a < hips.length; a++)
            for (let b = a + 1; b < hips.length; b++) expect(flat(hips[a]![f]!, hips[b]![f]!), `${a}-${b} at ${(f / FPS).toFixed(2)} s`).toBeGreaterThanOrEqual(0.35)
      })
    }

  it('a beat over the run keeps the run on the floor: its marks keep their own height (the vault lifts, the skid does not sink)', () => {
    const { marks } = stage(7, 'caught')
    const beat = marks[0]!.filter((m) => m.joints && m.gait === 'run')
    expect(beat.length).toBeGreaterThan(4)
    for (const m of beat) expect(m.position.y).toBeGreaterThanOrEqual(0)
    expect(Math.max(...beat.map((m) => m.position.y))).toBeGreaterThan(0.4)
  })
})

describe('a frame on a mark keeps the leg it arrives on moving (qa-fixes)', () => {
  it('the speed at a mark passed through at a run is the run speed, not 0', () => {
    const marks = [0, 1, 2].map((t, k) => ({ id: `m${k}`, time: t, position: { x: 0, y: 0, z: -5 * t }, gait: 'run', easeIn: 0, easeOut: 0, hold: 0 }) as ActorMark)
    const scene = {
      id: 's',
      name: 's',
      number: 1,
      environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
      entities: [{ id: 'p', assetId: 'person.man', name: 'p', transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } }],
      blocking: [{ id: 'take', name: 't', tracks: [{ entityId: 'p', marks }] }],
      shots: []
    } as unknown as Scene
    const shot = { id: 'shot', name: 's', duration: 2, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
    const ev = new ShotEvaluator(scene, shot)
    expect(ev.evaluate(1).entities[0]!.speed).toBeCloseTo(5, 3)
    expect(ev.evaluate(0.5).entities[0]!.speed).toBeCloseTo(5, 3)
  })
})
