import { describe, expect, it } from 'vitest'
import { parseFightScript, defaultTarget } from '@engine/fight/script'
import { listShotMoves, SHOT_MOVES, shotImpacts } from '@engine/fight/moves'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { aimDirectionLocal, heldPointLocal, weaponContact, weaponSpec } from '@engine/weapons'
import type { EntityState, FightDoc, V3 } from '@engine/types'

describe('weapon fight scripts', () => {
  it('reads blade moves: "A sword slash to head -> parry"', () => {
    const r = parseFightScript('A sword slash to head -> parry\nB thrust to body -> hit\nA stab -> block', ['A', 'B'])
    expect('beats' in r).toBe(true)
    if (!('beats' in r)) return
    expect(r.beats[0]).toEqual({ attacker: 0, move: 'sword-slash-combo', target: 'head', outcomes: ['parry'], power: 0.7 })
    expect(r.beats[1]!.move).toBe('sword-thrust')
    expect(r.beats[2]!.move).toBe('knife-lunge')
  })

  it('reads gun shots, aimed at the body by default', () => {
    const r = parseFightScript('B shoots -> hit\nA shoot to head -> ko\nA fire to legs', ['A', 'B'])
    if (!('beats' in r)) throw new Error(r.error)
    expect(r.beats.map((b) => b.move)).toEqual(['pistol-aim-fire', 'pistol-aim-fire', 'pistol-aim-fire'])
    expect(r.beats[0]!.target).toBe('body')
    expect(defaultTarget('pistol-aim-fire')).toBe('body')
  })

  it('a shot fires on the aim keyframe just before the recoil, from the gun hand', () => {
    expect(SHOT_MOVES.has('pistol-aim-fire')).toBe(true)
    expect(shotImpacts('pistol-aim-fire', 'R')).toEqual([{ effector: 'handR', t: 0.35, speed: 15 }])
    expect(shotImpacts('pistol-aim-fire', 'L')[0]!.effector).toBe('handL')
    expect(shotImpacts('jab-cross')).toEqual([])
    expect(listShotMoves().find((m) => m.id === 'pistol-aim-fire')?.impacts).toHaveLength(1)
  })
})

/* ------------------------------ armed fights ------------------------------ */

const FPS = 24

function fightOf(script: string): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return {
    id: 'fight_w',
    name: 'Weapon fight',
    fighterIds: ['ent_a', 'ent_b'],
    beats: r.beats,
    startT: 0.4,
    origin: { x: 0, z: 0, heading: 0 },
    beatGap: 0.35,
    exaggeration: 1.5
  }
}

type Arms = { assetId: string; hand: 'L' | 'R'; scale: number }[]

function pair(aArms: Arms, bArms: Arms = [], gap = 1.1): [FighterInput, FighterInput] {
  return [
    { entityId: 'ent_a', assetId: 'person.man', scale: 1, start: { x: -gap / 2, y: 0, z: 0 }, weapons: aArms },
    { entityId: 'ent_b', assetId: 'person.woman', scale: 1, start: { x: gap / 2, y: 0, z: 0 }, weapons: bArms }
  ]
}

/** The solution staged as real entities, tracks and held-weapon entities, evaluated through ShotEvaluator. */
function stage(fight: FightDoc, fighters: [FighterInput, FighterInput]): { sol: ReturnType<typeof solveFight>; ev: ShotEvaluator } {
  const sol = solveFight(fight, fighters, { duration: 20, fps: FPS })
  const project = createProject('Armed')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = 20
  shot.fps = FPS
  fighters.forEach((f, q) => {
    const e = createEntity(f.assetId, f.entityId, { ...f.start })
    e.id = f.entityId
    scene.entities.push(e)
    for (const w of f.weapons ?? []) {
      const weapon = createEntity(w.assetId, w.assetId, { x: 9, y: 0, z: 9 })
      weapon.transform.scale = w.scale
      weapon.heldBy = { entityId: e.id, hand: w.hand }
      scene.entities.push(weapon)
    }
    scene.blocking[0]!.tracks.push({
      entityId: e.id,
      marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}`, position: { ...m.position }, joints: m.joints ? { ...m.joints } : undefined }))
    })
  })
  return { sol, ev: new ShotEvaluator(scene, shot) }
}

/** The point a blow aims at (head / body), from evaluated states, as in fight-solve.test.ts. */
function aimPoint(a: EntityState, d: EntityState, dIn: FighterInput, zone: string): V3 {
  const dims = personDims(dIn.assetId, dIn.params)
  const l = Math.hypot(a.position.x - d.position.x, a.position.z - d.position.z)
  const toward = { x: (a.position.x - d.position.x) / l, z: (a.position.z - d.position.z) / l }
  const fx = poseEffectors(dims, d.joints)
  const p = toWorld(zone === 'head' ? fx.head : fx.chest, d.position, d.heading, dIn.scale)
  const k = zone === 'head' ? dims.headR * dIn.scale : 0.3 * dims.bodyW * dIn.scale
  return { x: p.x + toward.x * k, y: p.y, z: p.z + toward.z * k }
}

/** World point of a held weapon's model point, from the holder's evaluated state. */
function weaponPoint(st: EntityState, fIn: FighterInput, arms: Arms[number], point: V3): V3 {
  const spec = weaponSpec(arms.assetId)!
  return toWorld(heldPointLocal(personDims(fIn.assetId, fIn.params), st.joints, arms.hand, spec, point, arms.scale), st.position, st.heading, fIn.scale)
}

const d3 = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

describe('armed fights (solveFight with held weapons)', () => {
  const CASES: [string, Arms, string][] = [
    ['sword slash', [{ assetId: 'prop.sword', hand: 'R', scale: 1 }], 'A sword slash to head -> hit, hit'],
    ['sword thrust', [{ assetId: 'prop.sword', hand: 'R', scale: 1 }], 'A sword thrust to body -> hit'],
    ['knife stab', [{ assetId: 'prop.knife', hand: 'R', scale: 1 }], 'A stab to body -> hit'],
    ['axe slash', [{ assetId: 'prop.axe', hand: 'R', scale: 1.1 }], 'A slash to head -> hit, hit'],
    ['bat swing (two hands)', [{ assetId: 'prop.baseballBat', hand: 'R', scale: 1 }], 'A swing to head -> hit, hit'],
    ['spear thrust (two hands)', [{ assetId: 'prop.spear', hand: 'R', scale: 1 }], 'A thrust to body -> hit'],
    ['katana, jab cross from both hands', [{ assetId: 'prop.katana', hand: 'R', scale: 1 }], 'A jab cross to head -> hit, hit'],
    ['sword in the left hand', [{ assetId: 'prop.sword', hand: 'L', scale: 1 }], 'A thrust to body -> hit']
  ]
  for (const [name, arms, script] of CASES) {
    it(`${name}: the weapon lands within 3 cm on the impact frame, measured through ShotEvaluator`, () => {
      const fight = fightOf(script)
      const fighters = pair(arms)
      const { sol, ev } = stage(fight, fighters)
      const rep = sol.report.beats[0]!
      expect(rep, sol.report.warnings.join('; ')).toBeDefined()
      const spec = weaponSpec(arms[0]!.assetId)!
      rep.impactTimes.forEach((t, i) => {
        expect(rep.contactErrorM[i], `${name} report #${i}`).toBeLessThanOrEqual(0.03)
        const st = ev.evaluate(t)
        const a = st.entities.find((e) => e.entityId === 'ent_a')!
        const d = st.entities.find((e) => e.entityId === 'ent_b')!
        const E = weaponPoint(a, fighters[0], arms[0]!, weaponContact(spec, 'strike'))
        expect(d3(E, aimPoint(a, d, fighters[1], fight.beats[0]!.target)), `${name} blow ${i + 1}`).toBeLessThanOrEqual(0.03)
        expect(Math.abs(t * FPS - Math.round(t * FPS))).toBeLessThan(1e-9)
      })
    })
  }

  it("a parried slash meets the defender's blade", () => {
    const fight = fightOf('A sword slash to head -> block, parry')
    const swordA = { assetId: 'prop.sword', hand: 'R' as const, scale: 1 }
    const swordB = { assetId: 'prop.sword', hand: 'R' as const, scale: 1 }
    const fighters = pair([swordA], [swordB])
    const { sol, ev } = stage(fight, fighters)
    const rep = sol.report.beats[0]!
    const spec = weaponSpec('prop.sword')!
    rep.impactTimes.forEach((t, i) => {
      expect(rep.contactErrorM[i], `report #${i}`).toBeLessThanOrEqual(0.03)
      const st = ev.evaluate(t)
      const a = st.entities.find((e) => e.entityId === 'ent_a')!
      const d = st.entities.find((e) => e.entityId === 'ent_b')!
      const blade = weaponPoint(d, fighters[1], swordB, weaponContact(spec, 'guard'))
      const E = weaponPoint(a, fighters[0], swordA, weaponContact(spec, 'strike'))
      // The guard point is pushed 5 cm toward the attacker, as for an unarmed block.
      expect(d3(E, blade), `blow ${i + 1}`).toBeLessThanOrEqual(0.03 + 0.05 + 1e-6)
    })
  })

  it('a shot: the barrel line passes through the target, the reaction starts on the shot frame, the shooter holds its ground', () => {
    const fight = fightOf('A shoot to body -> hit')
    const pistol = { assetId: 'prop.pistol', hand: 'R' as const, scale: 1 }
    const fighters = pair([pistol], [], 4)
    const { sol, ev } = stage(fight, fighters)
    const rep = sol.report.beats[0]!
    expect(rep, sol.report.warnings.join('; ')).toBeDefined()
    expect(rep.contactErrorM[0]).toBeLessThanOrEqual(0.03)
    const T = rep.impactTimes[0]!
    const st = ev.evaluate(T)
    const a = st.entities.find((e) => e.entityId === 'ent_a')!
    const d = st.entities.find((e) => e.entityId === 'ent_b')!
    const spec = weaponSpec('prop.pistol')!
    const muzzle = weaponPoint(a, fighters[0], pistol, spec.tip)
    const dl = aimDirectionLocal(personDims('person.man'), a.joints, 'R', spec)
    const c = Math.cos(a.heading)
    const s = Math.sin(a.heading)
    const dir = { x: dl.x * c + dl.z * s, y: dl.y, z: -dl.x * s + dl.z * c }
    const target = aimPoint(a, d, fighters[1], 'body')
    const v = { x: target.x - muzzle.x, y: target.y - muzzle.y, z: target.z - muzzle.z }
    const along = v.x * dir.x + v.y * dir.y + v.z * dir.z
    expect(along).toBeGreaterThan(1)
    const miss = Math.hypot(v.x - dir.x * along, v.y - dir.y * along, v.z - dir.z * along)
    expect(miss).toBeLessThanOrEqual(0.03)
    // Shooter: no step-in, and no closing to guard distance afterwards.
    for (const m of sol.tracks[0]) expect(Math.hypot(m.position.x + 2, m.position.z), `t=${m.time}`).toBeLessThan(0.35)
    // Defender: a mark on the shot frame, and reacting right after it.
    expect(sol.tracks[1].some((m) => Math.abs(m.time - T) < 1e-9)).toBe(true)
    const before = ev.evaluate(T - 1 / FPS).entities.find((e) => e.entityId === 'ent_b')!
    const after = ev.evaluate(T + 3 / FPS).entities.find((e) => e.entityId === 'ent_b')!
    const keys = Object.keys({ ...before.joints, ...after.joints })
    expect(keys.some((k) => Math.abs((after.joints?.[k] ?? 0) - (before.joints?.[k] ?? 0)) > 0.05)).toBe(true)
  })

  it('a shot needs a gun; blocking a bullet becomes a miss', () => {
    const none = solveFight(fightOf('A shoot to body -> hit'), pair([]), { duration: 20, fps: FPS })
    expect(none.report.beats).toHaveLength(0)
    expect(none.report.warnings.join(' ')).toContain('has no gun')
    const blocked = solveFight(fightOf('A shoot to body -> block'), pair([{ assetId: 'prop.pistol', hand: 'R', scale: 1 }], [], 4), { duration: 20, fps: FPS })
    expect(blocked.report.beats[0]!.physics[0]!.result).toBe('none')
    expect(blocked.report.warnings.join(' ')).toContain("can't be blocked")
  })

  it('unarmed fighters solve exactly as before (weapons: [] is a no-op)', () => {
    const fight = fightOf('A jab cross to head -> block, hit\nB front kick to body -> hit')
    const plain = solveFight(fight, pair([]).map((f) => ({ ...f, weapons: undefined })) as [FighterInput, FighterInput], { duration: 20, fps: FPS })
    const empty = solveFight(fight, pair([]), { duration: 20, fps: FPS })
    expect(JSON.stringify(empty)).toBe(JSON.stringify(plain))
  })
})
