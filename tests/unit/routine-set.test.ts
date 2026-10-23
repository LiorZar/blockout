// Fork test (set-routines, docs/plans/2026-10-23-set-routines.md): Choreographer routines respect the set. On synthetic
// sets (no library data, no kit geometry): a chase runs along the street, inside the floor and clear of every solid, and
// laps a room instead of leaving it; a dance moves off a prop, turns to fit a narrow strip, and a set too small warns.
import { describe, expect, it } from 'vitest'
import { buildRoutine, type RoutineSpec } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { clearance, onFloor, solidAt, type RoutineSet, type SetRect, type SetSolid } from '@engine/routine-set'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { ActorMark, Scene, Shot, V3 } from '@engine/types'

const FPS = 24
const rect = (x0: number, x1: number, z0: number, z1: number): SetRect => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, heading: 0 })
const solid = (name: string, x0: number, x1: number, z0: number, z1: number): SetSolid => ({ ...rect(x0, x1, z0, z1), name })

/** A 40 m street between two rows of buildings, a lamp post on the kerb. */
const STREET: RoutineSet = {
  floors: [rect(-12, 12, -20, 20)],
  solids: [solid('a building', -12, -6, -20, -1), solid('a building', -12, -6, 1, 20), solid('a building', 6, 12, -20, 20), solid('a lamp post', 3.4, 3.7, 4, 4.3)],
  streets: [rect(-4, 4, -20, 20)],
  name: 'the street'
}
/** A 14 m room with a counter along one wall. */
const ROOM: RoutineSet = {
  floors: [rect(-7, 7, -7, 7)],
  solids: [solid('a wall', -7.2, -7, -7, 7), solid('a wall', 7, 7.2, -7, 7), solid('a wall', -7, 7, -7.2, -7), solid('a wall', -7, 7, 7, 7.2), solid('a counter', -6.5, -5.8, -4, 4)],
  streets: [],
  name: 'the room'
}
/** A 5 m wide alley, 20 m long, a dumpster on one side. */
const ALLEY: RoutineSet = {
  floors: [rect(-2.5, 2.5, -10, 10)],
  solids: [solid('a wall', -2.65, -2.35, -10, 10), solid('a wall', 2.35, 2.65, -10, 10), solid('a dumpster', -1.8, -0.2, 4.5, 5.5)],
  streets: [rect(-2.5, 2.5, -10, 10)],
  name: 'the alley'
}

/** Every performer's root and hips at FPS, the routine laid out as the store lays it. */
function play(spec: RoutineSpec, origin: { x: number; z: number; heading: number }, set: RoutineSet | undefined): { roots: V3[][]; hips: V3[][]; warnings: string[] } {
  const warnings: string[] = []
  const specs = buildRoutine(spec, { origin, ...(set ? { set, warnings } : {}) })
  const scene = {
    id: 's',
    name: 's',
    number: 1,
    environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
    entities: specs.map((e, i) => ({ id: `e${i}`, assetId: e.assetId, name: e.name, transform: { position: { ...e.position }, rotationY: e.rotationY, scale: 1 } })),
    blocking: [{ id: 'take', name: 't', tracks: specs.map((e, i) => ({ entityId: `e${i}`, marks: e.marks.map((m, k) => ({ ...m, id: `e${i}m${k}` }) as ActorMark) })) }],
    shots: []
  } as unknown as Scene
  const shot = { id: 'shot', name: 's', duration: spec.durationS, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
  const ev = new ShotEvaluator(scene, shot)
  const roots: V3[][] = specs.map(() => [])
  const hips: V3[][] = specs.map(() => [])
  for (let f = 0; f <= Math.round(spec.durationS * FPS); f++) {
    const st = ev.evaluate(Math.min(spec.durationS, f / FPS))
    specs.forEach((e, i) => {
      const s = st.entities.find((x) => x.entityId === `e${i}`)!
      roots[i]!.push({ ...s.position })
      hips[i]!.push(toWorld(poseEffectors(personDims(e.assetId), s.joints, s.clip).pelvis, s.position, s.heading, 1))
    })
  }
  return { roots, hips, warnings }
}

/** Frames where some performer's hips are in a solid or off the floor, and the largest root step. */
function audit(set: RoutineSet, r: { roots: V3[][]; hips: V3[][] }): { inSolid: string[]; offFloor: string[]; tight: number; step: number } {
  const inSolid: string[] = []
  const offFloor: string[] = []
  let tight = Infinity
  let step = 0
  r.hips.forEach((hs, i) =>
    hs.forEach((h, f) => {
      const s = solidAt(set, h)
      if (s) inSolid.push(`p${i}@${(f / FPS).toFixed(2)} ${s.name}`)
      if (!onFloor(set, h)) offFloor.push(`p${i}@${(f / FPS).toFixed(2)}`)
      tight = Math.min(tight, clearance(set, r.roots[i]![f]!))
      if (f > 0) step = Math.max(step, Math.hypot(r.roots[i]![f]!.x - r.roots[i]![f - 1]!.x, r.roots[i]![f]!.z - r.roots[i]![f - 1]!.z))
    })
  )
  return { inSolid, offFloor, tight, step }
}

const travelled = (pts: V3[]): number => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) : s), 0)
const chase = (seed: number, ending: 'caught' | 'escape' = 'caught', durationS = 8): RoutineSpec => ({ kind: 'chase', performers: 3, durationS, seed, ending })

describe('a chase on the set', () => {
  for (const seed of [7, 3, 21])
    for (const ending of ['caught', 'escape'] as const)
      it(`runs down the street, on the floor and clear of the buildings (seed ${seed}, ${ending})`, () => {
        // Clicked near the street's far end, facing back up it: upstream ran 5 m and then through the end of the set.
        const r = play(chase(seed, ending), { x: 1, z: 15, heading: 0 }, STREET)
        const a = audit(STREET, r)
        expect(a.inSolid).toEqual([])
        expect(a.offFloor).toEqual([])
        expect(a.tight).toBeGreaterThan(0.3)
        expect(a.step).toBeLessThanOrEqual(0.45)
        // It runs, and it runs along the street (on the asphalt, x within ±4 m).
        expect(travelled(r.roots[0]!)).toBeGreaterThan(20)
        for (const p of r.roots[0]!) expect(Math.abs(p.x)).toBeLessThan(4)
        expect(r.warnings).toEqual([])
      })

  it('laps a room it cannot cross in a straight line, and stays in it', () => {
    for (const seed of [7, 3, 21]) {
      const r = play(chase(seed), { x: 0, z: 3, heading: 0.4 }, ROOM)
      const a = audit(ROOM, r)
      expect(a.inSolid).toEqual([])
      expect(a.offFloor).toEqual([])
      expect(a.step).toBeLessThanOrEqual(0.45)
      expect(travelled(r.roots[0]!)).toBeGreaterThan(20)
    }
  })

  it('runs the alley, round the dumpster', () => {
    for (const seed of [7, 3, 21]) {
      const r = play(chase(seed, 'caught', 5), { x: 0, z: 8, heading: 0 }, ALLEY)
      const a = audit(ALLEY, r)
      expect(a.inSolid).toEqual([])
      expect(a.offFloor).toEqual([])
      expect(a.step).toBeLessThanOrEqual(0.45)
    }
  })

  it('says so when the set has no room for the chase', () => {
    const tiny: RoutineSet = { floors: [rect(-3, 3, -3, 3)], solids: [], streets: [], name: 'the cupboard' }
    const r = play(chase(7), { x: 0, z: 0, heading: 0 }, tiny)
    expect(r.warnings.join(' ')).toMatch(/the cupboard/i)
    expect(audit(tiny, r).offFloor).toEqual([])
  })
})

describe('a dance on the set', () => {
  const dance = (performers: number, extra: Partial<RoutineSpec> = {}): RoutineSpec => ({ kind: 'dance', performers, durationS: 8, seed: 11, style: 'mixed', formation: 'line', ...extra })

  it('steps off a prop in its spot, keeping its facing', () => {
    const set: RoutineSet = { floors: [rect(-10, 10, -10, 10)], solids: [solid('a pillar', 0.2, 1.2, -0.5, 0.5)], streets: [] }
    const r = play(dance(4), { x: 0, z: 0, heading: Math.PI }, set)
    const a = audit(set, r)
    expect(a.inSolid).toEqual([])
    expect(a.tight).toBeGreaterThan(0.3)
    expect(r.warnings).toEqual([])
    const specs = buildRoutine(dance(4), { origin: { x: 0, z: 0, heading: Math.PI }, set })
    for (const e of specs) expect(e.rotationY).toBeCloseTo(Math.PI, 6)
  })

  it('turns to fit a narrow alley, walking between formations inside it', () => {
    const r = play(dance(6, { formationChange: true, formation: 'vShape' }), { x: 0, z: 0, heading: Math.PI }, ALLEY)
    const a = audit(ALLEY, r)
    expect(a.inSolid).toEqual([])
    expect(a.offFloor).toEqual([])
  })

  it('warns when nothing fits', () => {
    const tiny: RoutineSet = { floors: [rect(-1.5, 1.5, -1.5, 1.5)], solids: [], streets: [], name: 'the lift' }
    const r = play(dance(6), { x: 0, z: 0, heading: 0 }, tiny)
    expect(r.warnings.join(' ')).toMatch(/the lift/i)
  })
})

describe('without a set', () => {
  it('lays every routine exactly as before', () => {
    const empty: RoutineSet = { floors: [], solids: [], streets: [] }
    for (const spec of [chase(7), dance4(), { kind: 'fight', performers: 4, durationS: 8, seed: 3 } as RoutineSpec]) {
      const origin = { x: 1, z: 2, heading: 0.3 }
      expect(buildRoutine(spec, { origin, set: empty, warnings: [] })).toEqual(buildRoutine(spec, { origin }))
    }
  })
})

function dance4(): RoutineSpec {
  return { kind: 'dance', performers: 4, durationS: 8, seed: 11, style: 'mixed', formation: 'line', formationChange: true }
}
