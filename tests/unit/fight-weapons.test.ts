import { describe, expect, it } from 'vitest'
import { formatFightScript, parseFightScript, defaultTarget } from '@engine/fight/script'
import { SHIELD_BLOCK, fightMotion, listShotMoves, SHOT_MOVES, shotImpacts } from '@engine/fight/moves'
import { mirrorJoints } from '@engine/choreography'
import { torsoShape, torsoSurface } from '@engine/fight/contact'
import { MOTION_PRESETS } from '@engine/motions'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { aimDirectionLocal, heldPointLocal, holdJoints, weaponContact, weaponSpec, type Hand } from '@engine/weapons'
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
  // Body blows land on the torso's surface at the chest (fork, contact.ts).
  if (zone !== 'head') return torsoSurface(torsoShape(dIn.assetId, dIn.params, dims), dims, dIn.scale, d.joints, d.position, d.heading, toward, 0.55)
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

  for (const hand of ['R', 'L'] as const) {
    it(`a two-handed slash keeps both hands on the grip at every blow (sword in the ${hand} hand)`, () => {
      const fight = fightOf('A sword slash to head -> hit, hit')
      const fighters = pair([{ assetId: 'prop.sword', hand, scale: 1 }])
      const { sol, ev } = stage(fight, fighters)
      const rep = sol.report.beats[0]!
      expect(rep, sol.report.warnings.join('; ')).toBeDefined()
      const dims = personDims('person.man')
      rep.impactTimes.forEach((t, i) => {
        expect(rep.contactErrorM[i]).toBeLessThanOrEqual(0.03)
        const a = ev.evaluate(t).entities.find((e) => e.entityId === 'ent_a')!
        const fx = poseEffectors(dims, a.joints)
        expect(d3(fx.handL, fx.handR), `blow ${i + 1}: hands apart`).toBeLessThanOrEqual(0.15)
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

  for (const hand of ['L', 'R'] as const) {
    it(`a bow in the ${hand} hand: "A shoot" looses on bow-draw-loose's loose keyframe, the arrow line through the target`, () => {
      const loose = MOTION_PRESETS.find((m) => m.id === 'bow-draw-loose')!.keyframes.find((kf) => kf.t === 1.4)!
      const fight = fightOf('A shoot to body -> hit')
      const bow = { assetId: 'prop.bow', hand, scale: 1 }
      const fighters = pair([bow], [], 5)
      const { sol, ev } = stage(fight, fighters)
      const rep = sol.report.beats[0]!
      expect(rep, sol.report.warnings.join('; ')).toBeDefined()
      expect(rep.contactErrorM[0]).toBeLessThanOrEqual(0.03)
      const T = rep.impactTimes[0]!
      // The loose keyframe (the draw hand opens after full draw), mirrored for a right-hand bow.
      const mark = sol.tracks[0].find((m) => Math.abs(m.time - T) < 1e-9)!
      expect(mark.joints![hand === 'L' ? 'elbowR' : 'elbowL']).toBeCloseTo(loose.joints.elbowR!, 9)
      const st = ev.evaluate(T)
      const a = st.entities.find((e) => e.entityId === 'ent_a')!
      const d = st.entities.find((e) => e.entityId === 'ent_b')!
      const spec = weaponSpec('prop.bow')!
      const rest = weaponPoint(a, fighters[0], bow, spec.tip)
      const dl = aimDirectionLocal(personDims('person.man'), a.joints, hand, spec)
      const c = Math.cos(a.heading)
      const s = Math.sin(a.heading)
      const dir = { x: dl.x * c + dl.z * s, y: dl.y, z: -dl.x * s + dl.z * c }
      const target = aimPoint(a, d, fighters[1], 'body')
      const v = { x: target.x - rest.x, y: target.y - rest.y, z: target.z - rest.z }
      const along = v.x * dir.x + v.y * dir.y + v.z * dir.z
      expect(along).toBeGreaterThan(1)
      expect(Math.hypot(v.x - dir.x * along, v.y - dir.y * along, v.z - dir.z * along), 'arrow line miss').toBeLessThanOrEqual(0.03)
      // The archer holds its ground.
      for (const m of sol.tracks[0]) expect(Math.hypot(m.position.x + 2.5, m.position.z), `t=${m.time}`).toBeLessThan(0.35)
    })
  }

  it('the bow is a shot move: its loose, from the bow hand, listed with the bow', () => {
    expect(SHOT_MOVES.has('bow-draw-loose')).toBe(true)
    expect(shotImpacts('bow-draw-loose')).toEqual([{ effector: 'handL', t: 1.4, speed: 15 }])
    expect(listShotMoves().find((m) => m.id === 'bow-draw-loose')?.guns).toEqual(['prop.bow'])
    const r = parseFightScript('A bow draw loose to body -> hit', ['A', 'B'])
    if (!('beats' in r)) throw new Error(r.error)
    expect(r.beats[0]!.move).toBe('bow-draw-loose')
  })

  it('a shot echoes as "shoot", and the report names the aim that plays (rifle, pistol, bow)', () => {
    const r = parseFightScript('A shoot to body -> hit\nA fire to head -> ko', ['A', 'B'])
    if ('error' in r) throw new Error(r.error)
    const text = formatFightScript(r.beats, ['A', 'B'])
    expect(text).toBe('A shoot to body -> hit\nA shoot to head -> ko')
    const again = parseFightScript(text, ['A', 'B'])
    if ('error' in again) throw new Error(again.error)
    expect(again.beats).toEqual(r.beats)
    for (const [gun, hand, plays] of [['prop.rifle', 'R', 'rifle-aim-fire'], ['prop.pistol', 'R', 'pistol-aim-fire'], ['prop.bow', 'L', 'bow-draw-loose']] as const) {
      const sol = solveFight(fightOf('A shoot to body -> hit'), pair([{ assetId: gun, hand, scale: 1 }], [], 5), { duration: 20, fps: FPS })
      expect(sol.report.beats[0]?.plays, gun).toBe(plays)
    }
    const none = solveFight(fightOf('A shoot to body -> hit'), pair([]), { duration: 20, fps: FPS })
    expect(none.report.warnings.join(' ')).toContain('(A shoot → body)')
    expect(none.report.warnings.join(' ')).not.toContain('pistol-aim-fire')
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

/* --------------------------------- shields -------------------------------- */

const BODIES = ['person.man', 'person.woman', 'person.mannequinMale', 'person.mannequinFemale', 'person.child', 'person.elderly']
const SHIELD = weaponSpec('prop.shield')!
const deg = (rad: number): number => (rad * 180) / Math.PI

/** Unit normal of the shield's face (its model −Z), holder-local, for a held pose. */
function shieldNormal(dims: ReturnType<typeof personDims>, joints: Record<string, number> | undefined, hand: Hand): V3 {
  const c = heldPointLocal(dims, joints, hand, SHIELD, SHIELD.tip, 1)
  const b = heldPointLocal(dims, joints, hand, SHIELD, { ...SHIELD.tip, z: SHIELD.tip.z - 1 }, 1)
  return { x: b.x - c.x, y: b.y - c.y, z: b.z - c.z }
}

describe('shields face the threat', () => {
  for (const [upstream, fork, from, to] of [
    ['shield-block', 'shield-block-face', 1, -1],
    ['shield-brace', 'shield-brace-face', 0, 0]
  ] as const) {
    it(`${fork} (for ${upstream}): the face within 10° of forward at every braced keyframe, either hand, every body`, () => {
      const m = MOTION_PRESETS.find((p) => p.id === fork)!
      expect(m, fork).toBeDefined()
      expect(MOTION_PRESETS.find((p) => p.id === upstream)).toBeDefined()
      const kfs = m.keyframes.slice(from, to === 0 ? undefined : to)
      for (const body of BODIES) {
        const dims = personDims(body)
        for (const hand of ['L', 'R'] as Hand[]) {
          for (const kf of kfs) {
            const joints = hand === 'L' ? kf.joints : mirrorJoints(kf.joints)
            const held = holdJoints(dims, joints, [{ spec: SHIELD, hand, scale: 1 }])
            const n = shieldNormal(dims, held, hand)
            expect(deg(Math.acos(Math.min(1, -n.z))), `${body} ${hand} t=${kf.t}`).toBeLessThanOrEqual(10)
          }
        }
      }
    })
  }

  it('a shield holder blocks with the shield blocks (low at the chest, high at the head)', () => {
    expect(SHIELD_BLOCK.low).toBe('shield-block-face')
    expect(SHIELD_BLOCK.high).toBe('shield-block-high')
    for (const id of [SHIELD_BLOCK.low, SHIELD_BLOCK.high]) expect(fightMotion(id), id).toBeDefined()
  })

  for (const [name, aArms, bArms, script] of [
    ['sword slash on a shield (L), high', [{ assetId: 'prop.sword', hand: 'R', scale: 1 }], [{ assetId: 'prop.shield', hand: 'L', scale: 1 }], 'A sword slash to head -> block, block'],
    ['jab cross on a shield (L), body', [], [{ assetId: 'prop.shield', hand: 'L', scale: 1 }], 'A jab cross to body -> block, block'],
    ['axe on sword-and-shield: blows land on the shield', [{ assetId: 'prop.axe', hand: 'R', scale: 1 }], [{ assetId: 'prop.sword', hand: 'R', scale: 1 }, { assetId: 'prop.shield', hand: 'L', scale: 1 }], 'A slash to head -> block, block'],
    ['a shield in the right hand', [{ assetId: 'prop.sword', hand: 'R', scale: 1 }], [{ assetId: 'prop.shield', hand: 'R', scale: 1 }], 'A thrust to body -> block']
  ] as [string, Arms, Arms, string][]) {
    it(`${name}: on the impact frame the blow meets the shield (≤ 3 cm) and its face points at the attacker (≤ 25°)`, () => {
      const fight = fightOf(script)
      const fighters = pair(aArms, bArms)
      const { sol, ev } = stage(fight, fighters)
      const rep = sol.report.beats[0]!
      expect(rep, sol.report.warnings.join('; ')).toBeDefined()
      const shieldArms = bArms.find((w) => w.assetId === 'prop.shield')!
      rep.impactTimes.forEach((t, i) => {
        expect(rep.contactErrorM[i], `report #${i}`).toBeLessThanOrEqual(0.03)
        const st = ev.evaluate(t)
        const a = st.entities.find((e) => e.entityId === 'ent_a')!
        const d = st.entities.find((e) => e.entityId === 'ent_b')!
        const dims = personDims(fighters[1].assetId)
        // The blow lands on the shield face: the attacker's strike point at the shield's guard point (+5 cm toward A).
        const spec = aArms[0] ? weaponSpec(aArms[0].assetId)! : null
        const E = spec ? weaponPoint(a, fighters[0], aArms[0]!, weaponContact(spec, 'strike')) : null
        const face = weaponPoint(d, fighters[1], shieldArms, weaponContact(SHIELD, 'guard'))
        if (E) expect(d3(E, face), `blow ${i + 1} on the shield`).toBeLessThanOrEqual(0.03 + 0.05 + 1e-6)
        const nl = shieldNormal(dims, d.joints, shieldArms.hand)
        const c = Math.cos(d.heading)
        const s = Math.sin(d.heading)
        const n = { x: nl.x * c + nl.z * s, y: nl.y, z: -nl.x * s + nl.z * c }
        const to = { x: a.position.x - d.position.x, z: a.position.z - d.position.z }
        const l = Math.hypot(to.x, to.z)
        const cos = (n.x * to.x + n.z * to.z) / l / Math.hypot(n.x, n.y, n.z)
        expect(deg(Math.acos(Math.min(1, cos))), `blow ${i + 1}: shield face to the attacker`).toBeLessThanOrEqual(25)
      })
    })
  }
})
