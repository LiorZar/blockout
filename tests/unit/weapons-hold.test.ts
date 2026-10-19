import { describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { createActorMark, createEntity, createProject, parseProject, serializeProject } from '@engine/schema'
import { personDims, toWorld } from '@engine/skeleton'
import { handFrame, heldPointLocal, idleJoints, weaponSpec } from '@engine/weapons'
import type { Entity, ProjectDoc, Scene, Shot, V3 } from '@engine/types'

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function fixture(): { doc: ProjectDoc; scene: Scene; shot: Shot; man: Entity } {
  const doc = createProject('Weapons')
  const scene = doc.scenes[0]!
  const shot = scene.shots[0]!
  const man = createEntity('person.man', 'Man', { x: 1, y: 0, z: -2 })
  man.transform.rotationY = 0.5
  man.transform.scale = 1.1
  scene.entities.push(man)
  return { doc, scene, shot, man }
}

function hold(scene: Scene, assetId: string, holder: Entity, hand: 'L' | 'R', scale = 1): Entity {
  const w = createEntity(assetId, assetId, { x: 4, y: 0, z: 4 })
  w.transform.scale = scale
  w.heldBy = { entityId: holder.id, hand }
  scene.entities.push(w)
  return w
}

describe('heldBy in the project file', () => {
  it('round-trips through serialize / parse', () => {
    const { doc, scene, man } = fixture()
    const sword = hold(scene, 'prop.sword', man, 'R')
    const { doc: back, issues } = parseProject(serializeProject(doc))
    expect(issues).toEqual([])
    expect(back!.scenes[0]!.entities.find((e) => e.id === sword.id)!.heldBy).toEqual({ entityId: man.id, hand: 'R' })
    expect(serializeProject(back!)).toBe(serializeProject(doc))
  })

  it('drops dangling, malformed and impossible holds on load, keeping the first weapon per hand', () => {
    const { doc, scene, man } = fixture()
    const cup = createEntity('prop.cup', 'Cup', { x: 0, y: 0, z: 0 })
    scene.entities.push(cup)
    const ok = hold(scene, 'prop.sword', man, 'R')
    const second = hold(scene, 'prop.knife', man, 'R')
    const left = hold(scene, 'prop.shield', man, 'L')
    const dangling = hold(scene, 'prop.axe', man, 'L')
    dangling.heldBy = { entityId: 'ent_gone', hand: 'L' }
    const byCup = hold(scene, 'prop.pistol', man, 'R')
    byCup.heldBy = { entityId: cup.id, hand: 'R' }
    const badHand = hold(scene, 'prop.spear', man, 'R')
    ;(badHand as unknown as { heldBy: unknown }).heldBy = { entityId: man.id, hand: 'X' }
    const notWeapon = createEntity('prop.cup', 'Cup 2', { x: 0, y: 0, z: 0 })
    notWeapon.heldBy = { entityId: man.id, hand: 'L' }
    scene.entities.push(notWeapon)
    const junk = hold(scene, 'prop.bow', man, 'L')
    ;(junk as unknown as { heldBy: unknown }).heldBy = 'nope'
    const self = hold(scene, 'prop.staff', man, 'R')
    self.heldBy = { entityId: self.id, hand: 'R' }

    const back = parseProject(serializeProject(doc)).doc!.scenes[0]!.entities
    const heldBy = (id: string): unknown => back.find((e) => e.id === id)!.heldBy
    expect(heldBy(ok.id)).toEqual({ entityId: man.id, hand: 'R' })
    expect(heldBy(left.id)).toEqual({ entityId: man.id, hand: 'L' })
    for (const e of [second, dangling, byCup, badHand, notWeapon, junk, self]) expect(heldBy(e.id), e.name).toBeUndefined()
    expect(back).toHaveLength(scene.entities.length)
  })
})

describe('ShotEvaluator with held weapons', () => {
  it('a held weapon sits in the hand; an idle holder takes the hold pose', () => {
    const { scene, shot, man } = fixture()
    const sword = hold(scene, 'prop.sword', man, 'R')
    const st = new ShotEvaluator(scene, shot).evaluate(0)
    const m = st.entities.find((e) => e.entityId === man.id)!
    const s = st.entities.find((e) => e.entityId === sword.id)!
    const spec = weaponSpec('prop.sword')!
    expect(m.joints).toEqual(idleJoints(spec, 'R'))
    const dims = personDims('person.man')
    const hand = toWorld(handFrame(dims, m.joints, 'R').p, man.transform.position, 0.5, 1.1)
    expect(dist(s.position, hand)).toBeLessThan(1e-12)
    expect(s.heading).toBe(0.5)
  })

  it('a posed arm (motion marks) plays its own pose: the idle hold fades out', () => {
    const { scene, shot, man } = fixture()
    hold(scene, 'prop.sword', man, 'R')
    const mark = createActorMark({ x: 1, y: 0, z: -2 }, 0, 'stand')
    mark.joints = { shoulderRX: -1.5, elbowR: 0.2, shoulderLX: -0.3 }
    scene.blocking[0]!.tracks.push({ entityId: man.id, marks: [mark] })
    const m = new ShotEvaluator(scene, shot).evaluate(0).entities.find((e) => e.entityId === man.id)!
    expect(m.joints).toEqual({ shoulderRX: -1.5, elbowR: 0.2, shoulderLX: -0.3 })
  })

  it('blends the idle hold in smoothly as the arm comes to rest', () => {
    const { scene, shot, man } = fixture()
    hold(scene, 'prop.sword', man, 'R')
    const mark = createActorMark({ x: 1, y: 0, z: -2 }, 0, 'stand')
    mark.joints = { elbowR: 0.3 }
    scene.blocking[0]!.tracks.push({ entityId: man.id, marks: [mark] })
    const m = new ShotEvaluator(scene, shot).evaluate(0).entities.find((e) => e.entityId === man.id)!
    const idle = idleJoints(weaponSpec('prop.sword')!, 'R')
    expect(m.joints!.elbowR).toBeCloseTo(0.3 + idle.elbowR! * 0.5, 12)
  })

  it('static pose sliders (params.joint_*) count toward the hold and the weapon point', () => {
    const { scene, shot, man } = fixture()
    man.params = { joint_shoulderRX: -0.2 }
    const pistol = hold(scene, 'prop.pistol', man, 'R')
    const st = new ShotEvaluator(scene, shot).evaluate(0)
    const m = st.entities.find((e) => e.entityId === man.id)!
    const combined = { ...m.joints, shoulderRX: (m.joints?.shoulderRX ?? 0) - 0.2 }
    const hand = toWorld(handFrame(personDims('person.man'), combined, 'R').p, man.transform.position, 0.5, 1.1)
    expect(dist(st.entities.find((e) => e.entityId === pistol.id)!.position, hand)).toBeLessThan(1e-12)
  })

  it('a two-handed weapon puts the off hand on its support point', () => {
    for (const id of ['prop.rifle', 'prop.shotgun', 'prop.katana', 'prop.baseballBat']) {
      const { scene, shot, man } = fixture()
      hold(scene, id, man, 'R', 1.05)
      const m = new ShotEvaluator(scene, shot).evaluate(0).entities.find((e) => e.entityId === man.id)!
      const dims = personDims('person.man')
      const spec = weaponSpec(id)!
      const support = heldPointLocal(dims, m.joints, 'R', spec, spec.support!, 1.05)
      const offHand = handFrame(dims, m.joints, 'L').p
      expect(dist(support, offHand), id).toBeLessThan(0.001)
    }
  })

  it('spear and staff rest as a one-handed carry; the off hand takes the shaft once the arm moves', () => {
    const thrust = { shoulderRX: 1.3, shoulderRZ: 0.1, elbowR: 0.4 }
    for (const id of ['prop.spear', 'prop.staff']) {
      const rest = fixture()
      hold(rest.scene, id, rest.man, 'R')
      const r = new ShotEvaluator(rest.scene, rest.shot).evaluate(0).entities.find((e) => e.entityId === rest.man.id)!
      expect(r.joints, id).toEqual(idleJoints(weaponSpec(id)!, 'R'))

      const { scene, shot, man } = fixture()
      hold(scene, id, man, 'R')
      const mark = createActorMark({ x: 1, y: 0, z: -2 }, 0, 'stand')
      mark.joints = thrust
      scene.blocking[0]!.tracks.push({ entityId: man.id, marks: [mark] })
      const m = new ShotEvaluator(scene, shot).evaluate(0).entities.find((e) => e.entityId === man.id)!
      const dims = personDims('person.man')
      const spec = weaponSpec(id)!
      const support = heldPointLocal(dims, m.joints, 'R', spec, spec.support!, 1)
      expect(dist(support, handFrame(dims, m.joints, 'L').p), id).toBeLessThan(0.001)
    }
  })

  it('the off hand stays free when it holds its own weapon, and for the bow', () => {
    const { scene, shot, man } = fixture()
    hold(scene, 'prop.rifle', man, 'R')
    hold(scene, 'prop.knife', man, 'L')
    const m = new ShotEvaluator(scene, shot).evaluate(0).entities.find((e) => e.entityId === man.id)!
    expect(m.joints).toEqual({ ...idleJoints(weaponSpec('prop.rifle')!, 'R'), ...idleJoints(weaponSpec('prop.knife')!, 'L') })

    const f = fixture()
    hold(f.scene, 'prop.bow', f.man, 'L')
    const b = new ShotEvaluator(f.scene, f.shot).evaluate(0).entities.find((e) => e.entityId === f.man.id)!
    expect(b.joints).toEqual(idleJoints(weaponSpec('prop.bow')!, 'L'))
  })

  it('a weapon whose holder is gone stays where it was put; unheld weapons are ordinary props', () => {
    const { scene, shot, man } = fixture()
    const sword = hold(scene, 'prop.sword', man, 'R')
    sword.heldBy = { entityId: 'ent_gone', hand: 'R' }
    const loose = createEntity('prop.rifle', 'Rifle', { x: -3, y: 0, z: 1 })
    scene.entities.push(loose)
    const st = new ShotEvaluator(scene, shot).evaluate(0)
    expect(st.entities.find((e) => e.entityId === sword.id)!.position).toEqual({ x: 4, y: 0, z: 4 })
    expect(st.entities.find((e) => e.entityId === loose.id)!.position).toEqual({ x: -3, y: 0, z: 1 })
    expect(st.entities.find((e) => e.entityId === man.id)!.joints).toBeUndefined()
  })

  it('the weapon rides a walking holder', () => {
    const { scene, shot, man } = fixture()
    const sword = hold(scene, 'prop.sword', man, 'R')
    const a = createActorMark({ x: 0, y: 0, z: 0 }, 0, 'walk')
    const b = createActorMark({ x: 0, y: 0, z: -6 }, 4, 'walk')
    scene.blocking[0]!.tracks.push({ entityId: man.id, marks: [a, b] })
    const ev = new ShotEvaluator(scene, shot)
    for (const t of [0, 1.3, 2.7, 4]) {
      const st = ev.evaluate(t)
      const m = st.entities.find((e) => e.entityId === man.id)!
      const s = st.entities.find((e) => e.entityId === sword.id)!
      const hand = toWorld(handFrame(personDims('person.man'), m.joints, 'R').p, m.position, m.heading, 1.1)
      expect(dist(s.position, hand)).toBeLessThan(1e-12)
    }
  })
})
