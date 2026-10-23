// Fork addition (2026): library motions reach the floor and never sink below it; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Mesh, Vector3, type Object3D } from 'three'
import { buildAsset, type BuiltAsset } from '@renderer/viewport/builders'
import { MOTION_PRESETS } from '@engine/motions'
import { buildRoutine, type ChoreoEntitySpec } from '@engine/choreography'
import { choreographMotion, generateSequence } from '@engine/sequences'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import type { ActorMark } from '@engine/types'

const PEOPLE = ['person.man', 'person.woman', 'person.child', 'person.elderly', 'person.mannequinMale', 'person.mannequinFemale']
const FLOOR_MOVES = ['sit-down', 'kneel-tie-shoe', 'crawl', 'knockdown-fall']

const BUILT = new Map<string, BuiltAsset>()

/** Rendered lowest point of a body posed with `joints` (stand gait), above its root. */
function meshLow(assetId: string, joints: Record<string, number> | undefined, gait: ActorMark['gait'] = 'stand'): number {
  let b = BUILT.get(assetId)
  if (!b) {
    b = buildAsset(assetId)
    BUILT.set(assetId, b)
  }
  b.animate!({ gait, phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
  const root: Object3D = b.group
  root.updateMatrixWorld(true)
  let low = Infinity
  const v = new Vector3()
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const pos = o.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).y)
  })
  return low
}

function preset(id: string) {
  return MOTION_PRESETS.find((p) => p.id === id)!
}

describe('apply_motion keeps bodies on the floor', () => {
  it('sit-down, kneel-tie-shoe, crawl and knockdown-fall reach the floor on six bodies', () => {
    for (const id of PEOPLE) {
      for (const pid of FLOOR_MOVES) {
        const p = preset(pid)
        const marks = choreographMotion(pid, { x: 0, y: 0, z: 0 }, 0.7, p.duration, 0, { assetId: id })!
        p.keyframes.forEach((kf, k) => {
          if ((kf.move?.up ?? 0) >= 0) return
          const low = marks[k]!.position.y + meshLow(id, marks[k]!.joints)
          expect(Math.abs(low), `${id} ${pid} @${kf.t}`).toBeLessThan(0.01)
        })
      }
    }
  })

  it('no keyframe of any library motion goes below the floor (man, mannequins)', () => {
    for (const id of ['person.man', 'person.mannequinMale', 'person.mannequinFemale']) {
      for (const p of MOTION_PRESETS) {
        const marks = choreographMotion(p.id, { x: 0, y: 0, z: 0 }, 0, p.duration, 0, { assetId: id })!
        for (const m of marks) expect(m.position.y + meshLow(id, m.joints), `${id} ${p.id} @${m.time}`).toBeGreaterThan(-0.01)
      }
    }
  })

  it('stands on a raised floor: the base height is the floor', () => {
    const marks = choreographMotion('kneel-tie-shoe', { x: 0, y: 0.8, z: 0 }, 0, 2.4, 0, { assetId: 'person.man' })!
    expect(marks[2]!.position.y + meshLow('person.man', marks[2]!.joints)).toBeCloseTo(0.8, 2)
  })

  it('plays as a posed move at every frame: facing kept, no walk cycle, nothing below the floor (all library motions)', () => {
    for (const id of ['person.man', 'person.mannequinFemale']) {
      for (const p of MOTION_PRESETS) {
        const doc = createProject('Floor')
        const scene = doc.scenes[0]!
        const e = createEntity(id, 'P', { x: 0, y: 0, z: 0 })
        e.transform.rotationY = 0.7
        scene.entities.push(e)
        const specs = choreographMotion(p.id, { x: 0, y: 0, z: 0 }, 0.7, p.duration, 0, { assetId: id })!
        const marks: ActorMark[] = specs.map((m, i) => ({ id: `m${i}`, ...m, position: { ...m.position } }))
        scene.blocking[0]!.tracks.push({ entityId: e.id, marks })
        const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: p.duration })
        for (let t = 0; t <= p.duration; t += 1 / 12) {
          const st = ev.evaluate(t).entities[0]!
          const at = `${id} ${p.id} @${t.toFixed(2)}`
          expect(st.gait, at).toBe('stand')
          expect(st.heading, at).toBeCloseTo(0.7, 6)
          expect(st.position.y + meshLow(id, st.joints), at).toBeGreaterThan(-0.01)
        }
      }
    }
  }, 60_000)
})

describe('routines and crowd sequences keep posed marks on the floor', () => {
  it('a dance routine: every posed mark at or above the floor', () => {
    const specs = buildRoutine({ kind: 'dance', performers: 4, durationS: 16, seed: 7, style: 'hiphop' }, { origin: { x: 0, z: 0, heading: 0 } })
    for (const e of specs) {
      for (const m of e.marks) {
        if (!m.joints) continue
        expect(m.position.y + meshLow(e.assetId, m.joints), `${e.name} @${m.time}`).toBeGreaterThan(-0.01)
      }
    }
  })

  it('a crowd fight: every posed mark at or above the floor, and the falls reach it', () => {
    const specs = generateSequence({ type: 'fight', count: 6, style: 'mob', origin: { x: 0, z: 0, heading: 0 }, duration: 8 })
    let down = 0
    for (const e of specs) {
      for (const m of e.marks) {
        if (!m.joints) continue
        const low = m.position.y + meshLow(e.assetId, m.joints)
        expect(low, `${e.name} @${m.time}`).toBeGreaterThan(-0.01)
        if (m.position.y < -0.05 && Math.abs(low) < 0.01) down++
      }
    }
    expect(down).toBeGreaterThan(0)
  })
})

/** A routine as the store lays it down; `upstream` drops the fork's posedMove flags. */
function routineScene(specs: ChoreoEntitySpec[], duration: number, upstream: boolean): ShotEvaluator {
  const doc = createProject('Routine')
  const scene = doc.scenes[0]!
  for (const spec of specs) {
    const e = createEntity(spec.assetId, spec.name, { ...spec.position })
    e.transform.rotationY = spec.rotationY
    scene.entities.push(e)
    const marks: ActorMark[] = spec.marks.map((m, i) => ({ id: `m${i}`, ...m, position: { ...m.position }, posedMove: upstream ? undefined : m.posedMove }))
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks })
  }
  return new ShotEvaluator(scene, { ...scene.shots[0]!, duration })
}

/** The marks bracketing t (null outside the track). */
function legAt(spec: ChoreoEntitySpec, t: number): [ChoreoEntitySpec['marks'][number], ChoreoEntitySpec['marks'][number]] | null {
  const ms = [...spec.marks].sort((a, b) => a.time - b.time)
  for (let i = 0; i < ms.length - 1; i++) if (t >= ms[i]!.time && t <= ms[i + 1]!.time) return [ms[i]!, ms[i + 1]!]
  return null
}

/** True while t is inside a leg between two motion-playback marks (the only legs the fork changes). */
function inPosedLeg(spec: ChoreoEntitySpec, t: number): boolean {
  const leg = legAt(spec, t)
  return !!leg && !!leg[0].posedMove && !!leg[1].posedMove
}

describe('travel legs keep upstream behaviour (only motion playback is a posed move)', () => {
  const routines: [string, ChoreoEntitySpec[], number][] = [
    ['chase caught', buildRoutine({ kind: 'chase', performers: 3, durationS: 10, seed: 11, ending: 'caught' }, { origin: { x: 0, z: 0, heading: 0.4 } }), 10],
    ['chase escape', buildRoutine({ kind: 'chase', performers: 2, durationS: 8, seed: 5, ending: 'escape' }, { origin: { x: 2, z: -3, heading: -1.1 } }), 8],
    ['dance with formation changes', buildRoutine({ kind: 'dance', performers: 4, durationS: 16, seed: 7, style: 'mixed', formationChange: true }, { origin: { x: 0, z: 0, heading: 0 } }), 16]
  ]
  for (const [name, specs, duration] of routines) {
    it(`${name}: outside motion playback, heading, gait and position match upstream at every frame`, () => {
      const fork = routineScene(specs, duration, false)
      const up = routineScene(specs, duration, true)
      for (let t = 0; t <= duration; t += 1 / 24) {
        const a = fork.evaluate(t).entities
        const b = up.evaluate(t).entities
        specs.forEach((spec, i) => {
          if (inPosedLeg(spec, t)) return
          const at = `${name} ${spec.name} @${t.toFixed(2)}`
          expect(Math.atan2(Math.sin(a[i]!.heading - b[i]!.heading), Math.cos(a[i]!.heading - b[i]!.heading)), at).toBeCloseTo(0, 9)
          // Fork (set-routines T3): a leg into a motion runs on the gait it departs with (evaluate.ts `legGait`); upstream walks.
          const leg = legAt(spec, t)
          const into = !!leg && !leg[0].posedMove && !!leg[1].posedMove && a[i]!.gait === leg[0].gait && b[i]!.gait === 'walk'
          if (!into) expect(a[i]!.gait, at).toBe(b[i]!.gait)
          expect(a[i]!.position.x, at).toBeCloseTo(b[i]!.position.x, 9)
          expect(a[i]!.position.y, at).toBeCloseTo(b[i]!.position.y, 9)
          expect(a[i]!.position.z, at).toBeCloseTo(b[i]!.position.z, 9)
        })
      }
    })
  }

  it('chase runners face their direction of travel on the path', () => {
    const [, specs, duration] = routines[0]!
    const ev = routineScene(specs, duration, false)
    let checked = 0
    for (let t = 0; t + 1 / 24 <= duration; t += 1 / 24) {
      const now = ev.evaluate(t).entities
      const next = ev.evaluate(t + 1 / 24).entities
      specs.forEach((spec, i) => {
        // Path legs only: upstream lays some path marks inside a vault's
        // keyframes (the runner darts ahead and back), unchanged by the fork.
        const leg = legAt(spec, t)
        if (!leg || leg[0].joints || leg[1].joints || legAt(spec, t + 1 / 24)?.[1] !== leg[1]) return
        const dx = next[i]!.position.x - now[i]!.position.x
        const dz = next[i]!.position.z - now[i]!.position.z
        if (Math.hypot(dx, dz) < 0.05) return
        const travel = Math.atan2(-dx, -dz)
        const off = Math.atan2(Math.sin(now[i]!.heading - travel), Math.cos(now[i]!.heading - travel))
        expect(Math.abs(off), `${spec.name} @${t.toFixed(2)}`).toBeLessThan(0.2)
        checked++
      })
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('only motion-playback marks are posed moves', () => {
    for (const [, specs] of routines) {
      for (const spec of specs) for (const m of spec.marks) if (m.posedMove) expect(m.joints, spec.name).toBeDefined()
      for (const spec of specs) for (const m of spec.marks) if (m.gait === 'walk' || m.gait === 'jog' || m.gait === 'run') expect(m.posedMove && !m.joints, spec.name).toBeFalsy()
    }
  })
})
