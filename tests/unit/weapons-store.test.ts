import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, releaseHeldBy } from '@renderer/store'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { generatePrompt } from '@engine/prompt'
import { BUILTIN_PROFILES } from '@engine/profiles'
import { LABEL_COLOR_NAMES } from '@engine/palette'
import { parseFightScript } from '@engine/fight/script'
import type { Entity, ProjectDoc, Scene } from '@engine/types'

function load(): { man: Entity; woman: Entity; cup: Entity } {
  const doc: ProjectDoc = createProject('Weapons store')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = 12
  const man = createEntity('person.man', 'Man', { x: 1, y: 0, z: -2 })
  man.transform.rotationY = 0.4
  man.label = { text: 'A', color: LABEL_COLOR_NAMES.red }
  const woman = createEntity('person.woman', 'Woman', { x: -1, y: 0, z: -2 })
  const cup = createEntity('prop.cup', 'Cup', { x: 0, y: 0, z: 0 })
  scene.entities.push(man, woman, cup)
  useStore.setState({
    doc,
    sceneId: scene.id,
    shotId: scene.shots[0]!.id,
    time: 0,
    undoStack: [],
    redoStack: [],
    selection: null
  })
  return { man, woman, cup }
}

const scene = (): Scene => useStore.getState().scene()!
const byId = (id: string): Entity => scene().entities.find((e) => e.id === id)!
const stateOf = (id: string): { x: number; z: number } => {
  const s = useStore.getState()
  const st = new ShotEvaluator(s.scene()!, s.shot()!).evaluate(s.time).entities.find((e) => e.entityId === id)!
  return { x: st.position.x, z: st.position.z }
}

describe('store: holding weapons', () => {
  let cast: ReturnType<typeof load>
  beforeEach(() => {
    cast = load()
  })

  it('spawns a weapon into the usual hand with its own colour and no text', () => {
    const { weaponId } = useStore.getState().spawnHeldWeapon('prop.sword', cast.man.id)
    const sword = byId(weaponId!)
    expect(sword.heldBy).toEqual({ entityId: cast.man.id, hand: 'R' })
    expect(sword.label?.text).toBe('')
    expect(sword.label?.color).not.toBe(LABEL_COLOR_NAMES.red)
    const shield = byId(useStore.getState().spawnHeldWeapon('prop.shield', cast.man.id).weaponId!)
    expect(shield.heldBy).toEqual({ entityId: cast.man.id, hand: 'L' })
    expect(shield.label?.color).not.toBe(sword.label?.color)
  })

  it('a new weapon in a full hand sets the old one down where the hand was', () => {
    const swordId = useStore.getState().spawnHeldWeapon('prop.sword', cast.man.id).weaponId!
    const at = stateOf(swordId)
    const axeId = useStore.getState().spawnHeldWeapon('prop.axe', cast.man.id, 'R').weaponId!
    const sword = byId(swordId)
    expect(sword.heldBy).toBeUndefined()
    expect(sword.transform.position.x).toBeCloseTo(at.x, 9)
    expect(sword.transform.position.z).toBeCloseTo(at.z, 9)
    expect(sword.transform.position.y).toBe(0)
    expect(sword.transform.rotationY).toBeCloseTo(0.4, 12)
    expect(byId(axeId).heldBy?.hand).toBe('R')
  })

  it('holdWeapon moves a placed weapon into a hand, switching hands keeps one weapon per hand', () => {
    const s = useStore.getState()
    s.addEntity('prop.spear', { x: 5, y: 0, z: 5 })
    const spearId = scene().entities.find((e) => e.assetId === 'prop.spear')!.id
    expect(s.holdWeapon(spearId, cast.woman.id)).toBeNull()
    expect(byId(spearId).heldBy).toEqual({ entityId: cast.woman.id, hand: 'R' })
    expect(s.holdWeapon(spearId, cast.woman.id, 'L')).toBeNull()
    expect(byId(spearId).heldBy).toEqual({ entityId: cast.woman.id, hand: 'L' })
    expect(s.holdWeapon(spearId, cast.man.id, 'L')).toBeNull()
    expect(byId(spearId).heldBy).toEqual({ entityId: cast.man.id, hand: 'L' })
  })

  it('refuses non-weapons and non-people, and changes nothing', () => {
    const s = useStore.getState()
    const swordId = s.spawnHeldWeapon('prop.sword', cast.man.id).weaponId!
    const before = JSON.stringify(useStore.getState().doc)
    expect(s.holdWeapon(cast.cup.id, cast.man.id)).toMatch(/isn't a weapon/)
    expect(s.holdWeapon(swordId, cast.cup.id)).toMatch(/only people hold weapons/)
    expect(s.spawnHeldWeapon('prop.cup', cast.man.id).error).toMatch(/isn't a weapon/)
    expect(JSON.stringify(useStore.getState().doc)).toBe(before)
  })

  it('dropWeapon stands it at the hand; undo puts it back in the hand', () => {
    const swordId = useStore.getState().spawnHeldWeapon('prop.sword', cast.man.id).weaponId!
    const at = stateOf(swordId)
    useStore.getState().dropWeapon(swordId)
    expect(byId(swordId).heldBy).toBeUndefined()
    expect(byId(swordId).transform.position.x).toBeCloseTo(at.x, 9)
    useStore.getState().undo()
    expect(byId(swordId).heldBy).toEqual({ entityId: cast.man.id, hand: 'R' })
  })

  it('deleting a holder sets its weapons down first (releaseHeldBy)', () => {
    const swordId = useStore.getState().spawnHeldWeapon('prop.sword', cast.man.id).weaponId!
    const at = stateOf(swordId)
    const s = useStore.getState()
    s.mutate('delete', (doc) => {
      const sc = doc.scenes[0]!
      releaseHeldBy(sc, s.shotId, s.time, new Set([cast.man.id]))
      sc.entities = sc.entities.filter((e) => e.id !== cast.man.id)
    })
    const sword = byId(swordId)
    expect(sword.heldBy).toBeUndefined()
    expect(sword.transform.position.x).toBeCloseTo(at.x, 9)
    expect(sword.transform.position.z).toBeCloseTo(at.z, 9)
  })

  it('stageFight with weapons arms the fighters (one undo step) and every blow and shot lands within 3 cm', () => {
    const before = scene().entities.length
    const script = parseFightScript('A sword slash to head -> hit, hit\nB shoot to body -> hit\nA thrust to body -> parry', ['A', 'B'])
    if ('error' in script) throw new Error(script.error)
    const { report } = useStore.getState().stageFight({ beats: script.beats, at: { x: 0, z: -6, heading: 0 }, weapons: ['prop.sword', 'prop.pistol'] })
    const added = scene().entities.slice(before)
    expect(added.map((e) => e.assetId).sort()).toEqual(['person.man', 'person.woman', 'prop.pistol', 'prop.sword'])
    const sword = added.find((e) => e.assetId === 'prop.sword')!
    const pistol = added.find((e) => e.assetId === 'prop.pistol')!
    expect(sword.heldBy?.hand).toBe('R')
    expect(scene().entities.find((e) => e.id === pistol.heldBy?.entityId)?.label?.text).toBe('B')
    expect(report.warnings, report.warnings.join('; ')).toEqual([])
    expect(report.beats).toHaveLength(3)
    for (const b of report.beats) for (const e of b.contactErrorM) expect(e).toBeLessThanOrEqual(0.03)
    useStore.getState().undo()
    expect(scene().entities).toHaveLength(before)
  })

  it('re-solving a fight uses what the fighters hold now', () => {
    const script = parseFightScript('A thrust to body -> hit', ['A', 'B'])
    if ('error' in script) throw new Error(script.error)
    const s = useStore.getState()
    const { fightId } = s.stageFight({ beats: script.beats, at: { x: 0, z: -6, heading: 0 }, fighters: [cast.man.id, cast.woman.id] })
    const bare = useStore.getState().scene()!.blocking[0]!.tracks.find((t) => t.entityId === cast.man.id)!.marks.map((m) => m.position.x)
    useStore.getState().spawnHeldWeapon('prop.spear', cast.man.id)
    const report = useStore.getState().updateFight(fightId, {})
    expect(report.beats[0]!.contactErrorM[0]).toBeLessThanOrEqual(0.03)
    const armed = useStore.getState().scene()!.blocking[0]!.tracks.find((t) => t.entityId === cast.man.id)!.marks.map((m) => m.position.x)
    // The spear's reach puts the attacker farther back than the bare-handed thrust.
    expect(armed).not.toEqual(bare)
  })

  it('the prompt names a held weapon with its holder and hand', () => {
    const s = useStore.getState()
    s.spawnHeldWeapon('prop.sword', cast.man.id)
    s.spawnHeldWeapon('prop.shield', cast.woman.id)
    const prompt = generatePrompt(scene(), useStore.getState().shot()!, BUILTIN_PROFILES[0]!)
    expect(prompt).toMatch(/a sword \(the \w+ shape\) in A's right hand/)
    expect(prompt).toMatch(/a round shield \(the \w+ shape\) in the woman's left hand/)
    expect(prompt).not.toContain('("")')
  })
})
