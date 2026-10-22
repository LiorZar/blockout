// Fork addition (2026): a Choreographer routine's fall holds on keyframe bodies until the performer's next move, as it does on the mocap bots (mocap-backlog); see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { buildRoutine, mirrorJoints, type ChoreoEntitySpec, type ChoreoMarkSpec, type RoutineSpec } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { bodyLowY } from '@engine/floor'
import { MOTION_PRESETS } from '@engine/motions'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors } from '@engine/skeleton'

const ORIGIN = { origin: { x: 0, z: 0, heading: 0 } }
const BODIES: [string, string][] = [
  ['person.man', 'person.woman'],
  ['person.mannequinMale', 'person.mannequinFemale']
]
const FALLS = ['knockdown-fall', 'ko-collapse', 'trip-and-fall-flat'].map((id) => MOTION_PRESETS.find((p) => p.id === id)!)
const same = (a: Record<string, number> | undefined, b: Record<string, number>): boolean => !!a && JSON.stringify(a) === JSON.stringify(b)

/** A body's pelvis over its lowest point, as a share of its standing height: down under 0.8. */
function pelvisShare(assetId: string, joints?: Record<string, number>): number {
  const pelvis = (j?: Record<string, number>): number => poseEffectors(personDims(assetId), j).pelvis.y - bodyLowY({ assetId }, j)
  return pelvis(joints) / pelvis({})
}

/** The routine's performers on a shot, as the store drops them in; `down(i, t)`: performer i is down. */
function staged(specs: ChoreoEntitySpec[], duration: number): { down: (i: number, t: number) => boolean } {
  const doc = createProject('KO')
  const scene = doc.scenes[0]!
  const ids = specs.map((s) => {
    const e = createEntity(s.assetId, s.name, { ...s.position })
    e.transform.rotationY = s.rotationY
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: s.marks.map((m, k) => ({ ...m, id: `m${k}`, position: { ...m.position }, joints: m.joints ? { ...m.joints } : undefined })) })
    return e.id
  })
  const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration })
  return {
    down: (i, t) => pelvisShare(specs[i]!.assetId, ev.evaluate(t).entities.find((x) => x.entityId === ids[i])!.joints) < 0.8
  }
}

/** Each fall in a performer's marks: the mark of its second-to-last keyframe, and the fall's last pose. */
function falls(marks: ChoreoMarkSpec[]): { at: number; last: Record<string, number> }[] {
  const out: { at: number; last: Record<string, number> }[] = []
  marks.forEach((m, j) => {
    for (const f of FALLS) {
      const kf = f.keyframes
      for (const mirror of [false, true]) {
        const pick = (joints: Record<string, number>): Record<string, number> => (mirror ? mirrorJoints(joints) : joints)
        const before = pick(kf[kf.length - 2]!.joints)
        if (same(m.joints, before) && !same(marks[j - 1]?.joints, before)) out.push({ at: j, last: pick(kf[kf.length - 1]!.joints) })
      }
    }
  })
  return out
}

/**
 * Every fall in a routine: the marks after it hold its last pose (and the
 * body is down on them, where that pose is down: a trip can't lie flat on
 * keyframes) until the performer's next move; with none, to the end.
 * Returns how many falls it checked and how many held to the end.
 */
function checkFalls(spec: RoutineSpec): { falls: number; toEnd: number } {
  const specs = buildRoutine(spec, ORIGIN)
  const { down } = staged(specs, spec.durationS)
  let n = 0
  let toEnd = 0
  specs.forEach((s, i) => {
    for (const f of falls(s.marks)) {
      n++
      const after = s.marks.slice(f.at + 1)
      const held = after.findIndex((m) => !same(m.joints, f.last))
      const span = held === -1 ? after : after.slice(0, held)
      expect(span.length, `${s.name} seed ${spec.seed}: the fall's last pose at t=${after[0]?.time.toFixed(3)}`).toBeGreaterThan(0)
      if (pelvisShare(s.assetId, f.last) >= 0.8) continue
      for (const m of span) expect(down(i, m.time), `${s.name} seed ${spec.seed}: down at t=${m.time.toFixed(3)}`).toBe(true)
      if (held === -1) {
        toEnd++
        expect(down(i, spec.durationS), `${s.name} seed ${spec.seed}: down at the end`).toBe(true)
      }
    }
  })
  return { falls: n, toEnd }
}

describe('routine falls on keyframe bodies', () => {
  for (const bodies of BODIES) {
    it(`a two-person brawl: every fall holds until the next move, a finish's KO to the end (${bodies[0]})`, () => {
      let toEnd = 0
      let n = 0
      for (let seed = 1; seed <= 12; seed++) {
        const r = checkFalls({ kind: 'fight', performers: 2, durationS: 16, seed, style: 'brawl', ending: 'finish', bodies })
        n += r.falls
        toEnd += r.toEnd
      }
      expect(n, 'falls checked').toBeGreaterThan(0)
      expect(toEnd, 'KOs that stay down to the end').toBeGreaterThan(0)
    })

    it(`a one-vs-many hero who falls stays down until the next move (${bodies[0]})`, () => {
      let n = 0
      for (let seed = 1; seed <= 12; seed++) n += checkFalls({ kind: 'fight', performers: 4, durationS: 12, seed, style: 'martial-arts', bodies }).falls
      expect(n, 'falls checked').toBeGreaterThan(0)
    })
  }
})
