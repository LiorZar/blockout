// Fork addition (2026): mocap clips on actor marks, through the evaluator (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { bodyLowY } from '@engine/floor'
import { clearMocapClips, clipRoot, clipScale, mocapClip, registerMocapClip } from '@engine/mocap/clip'
import { BLEND } from '@engine/mocap/clip-marks'
import { clearMocapBodies, registerMocapBody } from '@engine/mocap/registry'
import { createEntity, createProject, parseProject, serializeProject } from '@engine/schema'
import { choreographMotion } from '@engine/sequences'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { heldPointLocal, weaponSpec } from '@engine/weapons'
import type { ActorMark, Entity, MarkClip, ProjectDoc, Scene, V3 } from '@engine/types'
import { fixtureSource } from './mocap-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function registerClips(): void {
  const raise = sweep({ shoulderLX: 0 }, { shoulderLX: -1.5, elbowL: 0.6 }, 31)
  registerMocapClip('raise', syntheticClip(MALE, raise))
  registerMocapClip('travel', syntheticClip(MALE, raise, { inPlace: false, hips: (f) => ({ x: 0.1 * Math.sin(f / 5), y: 0, z: (-1.2 * f) / 30 }) }))
  registerMocapClip('crouch', syntheticClip(MALE, sweep({}, { hipLX: -1.2, hipRX: -1.2, kneeL: 2.2, kneeR: 2.2, torsoX: 0.5 }, 11), { grounded: true }))
}

beforeAll(() => {
  registerMocapBody(MALE, fixtureSource())
  registerMocapBody(FEMALE, fixtureSource(0.93))
  registerClips()
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

let n = 0
function mark(time: number, position: V3, extra: Partial<ActorMark> = {}): ActorMark {
  return { id: `m${n++}`, time, hold: 0, easeIn: 0, easeOut: 0, position, gait: 'stand', posedMove: true, arriveHeading: 0.4, ...extra }
}

function stage(assetId: string, marks: ActorMark[], duration = 6): { doc: ProjectDoc; scene: Scene; e: Entity; ev: () => ShotEvaluator } {
  const doc = createProject('Clips')
  const scene = doc.scenes[0]!
  const e = createEntity(assetId, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks })
  return { doc, scene, e, ev: () => new ShotEvaluator(scene, { ...scene.shots[0]!, duration }) }
}

const clip = (id: string, at: number, mirror?: boolean): MarkClip => (mirror ? { id, at, mirror } : { id, at })

describe('clip marks in the evaluator', () => {
  it('runs the clip time linearly between two marks on the same clip, and holds it outside them', () => {
    const { ev } = stage(MALE, [mark(1, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 0) }), mark(3, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1) })])
    const e = ev()
    expect(e.evaluate(2).entities[0]!.clip).toEqual({ id: 'raise', t: 0.5 })
    expect(e.evaluate(2.5).entities[0]!.clip!.t).toBeCloseTo(0.75, 12)
    expect(e.evaluate(0.2).entities[0]!.clip).toEqual({ id: 'raise', t: 0 })
    expect(e.evaluate(5).entities[0]!.clip).toEqual({ id: 'raise', t: 1 })
    // The pose follows: the left hand rises through the run.
    const d = personDims(MALE)
    const hand = (t: number): V3 => {
      const st = e.evaluate(t).entities[0]!
      return poseEffectors(d, st.joints, st.clip).handL
    }
    expect(hand(3).y).toBeGreaterThan(hand(1).y + 0.4)
  })

  it('keeps the marks\' joints as an overlay on the clip', () => {
    const { ev } = stage(MALE, [mark(0, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 0), joints: { elbowR: 1.2 } }), mark(2, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1), joints: { elbowR: 1.2 } })])
    const st = ev().evaluate(1).entities[0]!
    expect(st.joints).toEqual({ elbowR: 1.2 })
    const d = personDims(MALE)
    const plain = poseEffectors(d, undefined, st.clip)
    const over = poseEffectors(d, st.joints, st.clip)
    expect(dist(over.handL, plain.handL)).toBeLessThan(1e-9)
    expect(dist(over.handR, plain.handR)).toBeGreaterThan(0.1)
  })

  it('moves a root-motion clip by its hips track, turned to the heading and scaled to the bot', () => {
    for (const id of [MALE, FEMALE]) {
      const c = mocapClip('travel')!
      const m = personDims(id).mocap!
      const k = clipScale(m, c.hipH)
      const h = 0.4
      const start = { x: 2, y: 0, z: -1 }
      const r0 = clipRoot(c, 0)
      const r1 = clipRoot(c, 1)
      const end = toWorld({ x: (r1.x - r0.x) * k, y: 0, z: (r1.z - r0.z) * k }, start, h, 1)
      const { ev } = stage(id, [mark(0, start, { clip: clip('travel', 0) }), mark(1, end, { clip: clip('travel', 1) })])
      const e = ev()
      for (const t of [0, 0.3, 0.55, 1]) {
        const r = clipRoot(c, t)
        const want = toWorld({ x: (r.x - r0.x) * k, y: 0, z: (r.z - r0.z) * k }, start, h, 1)
        expect(dist(e.evaluate(t).entities[0]!.position, want), `${id} @${t}`).toBeLessThan(1e-9)
      }
      // A moved end mark spreads the difference along the run.
      const { ev: ev2 } = stage(id, [mark(0, start, { clip: clip('travel', 0) }), mark(1, { ...end, x: end.x + 0.5 }, { clip: clip('travel', 1) })])
      expect(ev2().evaluate(0.5).entities[0]!.position.x - e.evaluate(0.5).entities[0]!.position.x).toBeCloseTo(0.25, 9)
      // Mirrored, it travels the other way across.
      const sway = clipRoot(c, 0.25, true).x
      expect(sway).toBeCloseTo(-clipRoot(c, 0.25).x, 12)
    }
  })

  it('stands a clip mark on its floor height, and the pose on its lowest point', () => {
    const { ev } = stage(MALE, [mark(0, { x: 0, y: 0.5, z: 0 }, { clip: clip('crouch', 0) }), mark(1, { x: 0, y: 0.5, z: 0 }, { clip: clip('crouch', 1 / 3) })])
    for (const t of [0, 0.4, 1]) {
      const st = ev().evaluate(t).entities[0]!
      expect(st.position.y).toBeCloseTo(0.5, 12)
      expect(st.position.y + bodyLowY({ assetId: MALE }, st.joints, st.clip)).toBeCloseTo(0.5, 9)
    }
  })

  it('crossfades a posed leg between clips, or from a keyframe pose on its lowest point', () => {
    const kf = { kneeL: 1, hipLX: -0.5 }
    const { ev } = stage(MALE, [
      mark(0, { x: 0, y: 0.2, z: 0 }, { joints: kf }),
      mark(1, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1) }),
      mark(2, { x: 0, y: 0, z: 0 }, { clip: clip('crouch', 0) })
    ])
    const e = ev()
    const a = e.evaluate(0.5).entities[0]!
    expect(a.clip).toEqual({ id: 'raise', t: 1, w: 0.5 })
    // The floor line: from the keyframe's lowest point (root 0.2 up) to the clip's floor.
    const low0 = 0.2 + bodyLowY({ assetId: MALE }, kf)
    expect(a.position.y).toBeCloseTo(low0 / 2, 9)
    const b = e.evaluate(1.25).entities[0]!
    expect(b.clip).toEqual({ id: 'crouch', t: 0, w: 0.25, from: { id: 'raise', t: 1 } })
    // A travel leg into a clip blends it in over its last BLEND seconds only.
    const { ev: ev2 } = stage(MALE, [mark(0, { x: 0, y: 0, z: 0 }, { posedMove: false, gait: 'walk' }), mark(3, { x: 0, y: 0, z: -3 }, { posedMove: false, gait: 'walk', clip: clip('raise', 0) })])
    const e2 = ev2()
    expect(e2.evaluate(2).entities[0]!.clip).toBeUndefined()
    expect(e2.evaluate(3 - BLEND / 2).entities[0]!.clip).toEqual({ id: 'raise', t: 0, w: 0.5 })
    expect(e2.evaluate(3 - BLEND / 2).entities[0]!.gait).toBe('walk')
  })

  it('a held weapon rides the clip pose\'s hand', () => {
    const { scene, e, ev } = stage(MALE, [mark(0, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 0) }), mark(1, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1) })])
    const gun = createEntity('prop.pistol', 'Gun', { x: 3, y: 0, z: 3 })
    gun.heldBy = { entityId: e.id, hand: 'L' }
    scene.entities.push(gun)
    const s = ev().evaluate(1).entities
    const holder = s.find((x) => x.entityId === e.id)!
    const w = s.find((x) => x.entityId === gun.id)!
    const d = personDims(MALE)
    const grip = toWorld(heldPointLocal(d, holder.joints, 'L', weaponSpec('prop.pistol')!, weaponSpec('prop.pistol')!.grip, 1, holder.clip), holder.position, holder.heading, 1)
    expect(dist(w.position, grip)).toBeLessThan(1e-9)
    expect(w.position.y).toBeGreaterThan(1.2)
  })

  it('other bodies ignore the clip and stand on its floor', () => {
    const { ev } = stage('person.man', [mark(0, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 0) }), mark(2, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1) })])
    const st = ev().evaluate(1).entities[0]!
    expect(st.position.y).toBe(0)
    expect(poseEffectors(personDims('person.man'), st.joints, st.clip)).toEqual(poseEffectors(personDims('person.man'), undefined))
  })
})

describe('clip marks in the project file', () => {
  it('round-trips through serialize / parse', () => {
    const { doc } = stage(MALE, [mark(0, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 0) }), mark(2, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1, true) })])
    const { doc: back, issues } = parseProject(serializeProject(doc))
    expect(issues).toEqual([])
    expect(back!.scenes[0]!.blocking[0]!.tracks[0]!.marks.map((m) => m.clip)).toEqual([{ id: 'raise', at: 0 }, { id: 'raise', at: 1, mirror: true }])
    expect(serializeProject(back!)).toBe(serializeProject(doc))
  })

  it('drops a malformed clip on load and keeps the mark', () => {
    const { doc } = stage(MALE, [mark(0, { x: 0, y: 0, z: 0 }), mark(1, { x: 0, y: 0, z: 0 }), mark(2, { x: 0, y: 0, z: 0 }, { clip: clip('raise', 1) })])
    const marks = doc.scenes[0]!.blocking[0]!.tracks[0]!.marks as unknown as Record<string, unknown>[]
    marks[0]!.clip = 'raise'
    marks[1]!.clip = { id: 'raise', at: 'soon', mirror: 1 }
    marks[2]!.clip = { id: 'raise', at: 1, mirror: 'yes' }
    const back = parseProject(serializeProject(doc)).doc!.scenes[0]!.blocking[0]!.tracks[0]!.marks
    expect(back.length).toBe(3)
    expect(back[0]!.clip).toBeUndefined()
    expect(back[1]!.clip).toBeUndefined()
    expect(back[2]!.clip).toEqual({ id: 'raise', at: 1 })
  })

  it('leaves an old project (no clip marks) as it was: same file, no clip state, the same evaluation with or without clips loaded', () => {
    const doc = createProject('Old')
    const scene = doc.scenes[0]!
    const e = createEntity(MALE, 'P', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    const specs = choreographMotion('push-ups', { x: 0, y: 0, z: 0 }, 0, 4, 0, { assetId: MALE })!
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: specs.map((m, i) => ({ id: `k${i}`, ...m, position: { ...m.position } })) })
    const json = serializeProject(doc)
    expect(json).not.toContain('"clip"')
    expect(serializeProject(parseProject(json).doc!)).toBe(json)
    const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 4 })
    const before = [0, 0.7, 1.9, 3.3].map((t) => ev.evaluate(t).entities)
    for (const st of before.flat()) expect('clip' in st).toBe(false)
    clearMocapClips()
    try {
      expect([0, 0.7, 1.9, 3.3].map((t) => ev.evaluate(t).entities)).toStrictEqual(before)
    } finally {
      registerClips()
    }
  })
})
