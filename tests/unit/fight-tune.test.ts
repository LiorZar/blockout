import { describe, expect, it } from 'vitest'
import { fightCoverage } from '@engine/fight/coverage'
import { STRIKE_IDS, STRIKE_SPEED, strikeImpacts } from '@engine/fight/moves'
import { impact, snapAmplitude, type ImpactInput, type ImpactResult } from '@engine/fight/physics'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { personDims } from '@engine/skeleton'
import type { FightDoc } from '@engine/types'

const MAN = personDims('person.man')
const RANK: Record<ImpactResult['result'], number> = { none: 0, absorb: 1, stagger: 2, knockdown: 3 }

/** Impact `i` of a strike at its nominal speed, man on man at exaggeration 1.5. */
function blow(moveId: string, i: number, power: number, over: Partial<ImpactInput> = {}): ImpactResult {
  const imp = strikeImpacts(moveId)[i]!
  return impact({
    moveId,
    effector: imp.effector,
    speed: imp.speed,
    power,
    outcome: 'hit',
    defender: MAN,
    defenderBuild: 1,
    exaggeration: 1.5,
    attacker: MAN,
    attackerBuild: 1,
    ...over
  })
}

describe('hit power (brief table, exaggeration 1.5, same-size fighters)', () => {
  it('STRIKE_SPEED gives every strike one nominal speed per detected impact', () => {
    for (const id of STRIKE_IDS) {
      expect(STRIKE_SPEED[id], id).toHaveLength(strikeImpacts(id).length)
      expect(strikeImpacts(id).map((i) => i.speed), id).toEqual(STRIKE_SPEED[id])
    }
  })

  it('a jab is absorbed, with a visible head snap', () => {
    const r = blow('jab-cross', 0, 0.7)
    expect(r.result).toBe('absorb')
    expect(snapAmplitude(r.impulse, 1.5)).toBeGreaterThanOrEqual(0.2)
  })

  it('cross, hook, uppercut and haymaker stagger from power 0.8 up', () => {
    for (const [id, i] of [['jab-cross', 1], ['hook-punch', 0], ['uppercut', 0], ['haymaker', 0]] as const) {
      for (const power of [0.8, 1]) expect(blow(id, i, power).result, `${id} @${power}`).toBe('stagger')
    }
  })

  it('front and side kicks stagger; roundhouse and spinning back kick knock down', () => {
    expect(blow('front-kick', 0, 1).result).toBe('stagger')
    expect(blow('side-kick', 0, 1).result).toBe('stagger')
    expect(blow('roundhouse-kick', 0, 1).result).toBe('knockdown')
    expect(blow('spinning-back-kick', 0, 1).result).toBe('knockdown')
  })

  it('a blocked or parried blow is clearly weaker than the same blow landing', () => {
    for (const id of STRIKE_IDS) {
      strikeImpacts(id).forEach((_, i) => {
        const hit = blow(id, i, 1)
        for (const outcome of ['block', 'parry'] as const) {
          const def = blow(id, i, 1, { outcome })
          expect(def.impulse, `${id} ${outcome}`).toBeCloseTo(0.5 * hit.impulse, 9)
          expect(def.capture, `${id} ${outcome}`).toBeLessThan(hit.capture)
          expect(RANK[def.result], `${id} ${outcome}`).toBeLessThanOrEqual(RANK[hit.result])
        }
      })
    }
    // A knockdown kick, guarded, only staggers; a staggering hook, guarded, is absorbed.
    expect(blow('roundhouse-kick', 0, 1, { outcome: 'block' }).result).toBe('stagger')
    expect(blow('hook-punch', 0, 0.9, { outcome: 'parry' }).result).toBe('absorb')
  })

  it('a build-1.3 fighter hit by a child moves less than the child hit back', () => {
    const child = personDims('person.child')
    const big = personDims('person.man', { build: 1.3 })
    const onBig = blow('jab-cross', 1, 0.8, { attacker: child, attackerBuild: 1, defender: big, defenderBuild: 1.3 })
    const onChild = blow('jab-cross', 1, 0.8, { attacker: big, attackerBuild: 1.3, defender: child, defenderBuild: 1 })
    expect(onBig.impulse).toBeLessThan(onChild.impulse)
    expect(onBig.v0).toBeLessThan(onChild.v0)
    expect(RANK[onBig.result]).toBeLessThan(RANK[onChild.result])
  })
})

/* ------------------------------ through the solver ------------------------------ */

const FPS = 24

function fightOf(script: string): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return { id: 'fight_t', name: 'Tune', fighterIds: ['ent_a', 'ent_b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}

function men(weapon?: string, hand: 'L' | 'R' = 'R'): [FighterInput, FighterInput] {
  return [
    { entityId: 'ent_a', assetId: 'person.man', scale: 1, start: { x: -0.55, y: 0, z: 0 }, weapons: weapon ? [{ assetId: weapon, hand, scale: 1 }] : [] },
    { entityId: 'ent_b', assetId: 'person.man', scale: 1, start: { x: 0.55, y: 0, z: 0 } }
  ]
}

/** Physics of the landed blows ('hit' outcomes) of a one-beat fight; armed blows land within 3 cm. */
function landed(script: string, weapon?: string): ImpactResult[] {
  const fight = fightOf(script)
  const sol = solveFight(fight, men(weapon), { duration: 10, fps: FPS })
  const rep = sol.report.beats[0]!
  // (Bare-handed, the slash's backhand can't reach a head: the solver warns, as before this tune.)
  if (weapon) for (const e of rep.contactErrorM) expect(e, `${script} with ${weapon}`).toBeLessThanOrEqual(0.03)
  const outcomes = fight.beats[0]!.outcomes
  return rep.physics.filter((_, i) => (outcomes[outcomes.length - rep.physics.length + i] ?? 'block') === 'hit')
}

describe('weapons hit harder (solveFight, man on man)', () => {
  it('a sword, katana or knife hit at least staggers', () => {
    for (const [weapon, script] of [
      ['prop.sword', 'A slash to head -> hit'],
      ['prop.sword', 'A thrust to body -> hit'],
      ['prop.katana', 'A slash to head -> hit'],
      ['prop.knife', 'A stab to body -> hit']
    ] as const) {
      const hits = landed(script, weapon)
      expect(hits.length, `${weapon}: ${script}`).toBeGreaterThan(0)
      for (const ph of hits) expect(RANK[ph.result], `${weapon}: ${script}`).toBeGreaterThanOrEqual(RANK.stagger)
    }
  })

  it('a bat, axe or staff hit at power 1 knocks down', () => {
    for (const weapon of ['prop.baseballBat', 'prop.axe', 'prop.staff']) {
      const hits = landed('A swing to body -> hit power 1', weapon)
      expect(hits.length, weapon).toBeGreaterThan(0)
      for (const ph of hits) expect(ph.result, weapon).toBe('knockdown')
    }
  })

  it('a weapon hits harder than the same blow bare-handed', () => {
    const bare = landed('A slash to head -> hit')[0]!
    const armed = landed('A slash to head -> hit', 'prop.sword')[0]!
    expect(armed.impulse).toBeGreaterThan(1.5 * bare.impulse)
  })
})

describe('a guarded blow that staggers reads', () => {
  it('rocks the defender back (torso and head) while the guard holds, and drives it back a step', () => {
    const fight = fightOf('A front kick to body -> parry')
    const fighters = men()
    const sol = solveFight(fight, fighters, { duration: 6, fps: FPS })
    const rep = sol.report.beats[0]!
    const ph = rep.physics[0]!
    expect(ph.result).toBe('stagger')
    expect(ph.stepBack).toBeGreaterThanOrEqual(0.25)
    const project = createProject('Guard')
    const scene = project.scenes[0]!
    const shot = scene.shots[0]!
    shot.duration = 6
    shot.fps = FPS
    fighters.forEach((f, q) => {
      const e = createEntity(f.assetId, f.entityId, { ...f.start })
      e.id = f.entityId
      scene.entities.push(e)
      scene.blocking[0]!.tracks.push({ entityId: e.id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}` })) })
    })
    const ev = new ShotEvaluator(scene, shot)
    const T = rep.impactTimes[0]!
    const b = (t: number) => ev.evaluate(t).entities.find((e) => e.entityId === 'ent_b')!
    const at = b(T)
    const rocked = b(T + 0.2)
    expect(rocked.joints!.torsoX! - (at.joints!.torsoX ?? 0)).toBeLessThanOrEqual(-0.15)
    expect(rocked.joints!.headX! - (at.joints!.headX ?? 0)).toBeLessThanOrEqual(-0.1)
    const after = b(T + ph.stepDuration)
    expect(after.position.x - at.position.x).toBeGreaterThanOrEqual(0.25)
  })
})

describe('punch-in coverage on the Design script', () => {
  it('pushes in on the hook, the front kick and the roundhouse', () => {
    const fight = fightOf(`A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1`)
    const fighters: [FighterInput, FighterInput] = [
      { entityId: 'ent_a', assetId: 'person.man', scale: 1, start: { x: -0.55, y: 0, z: -3 } },
      { entityId: 'ent_b', assetId: 'person.woman', scale: 1, start: { x: 0.55, y: 0, z: -3 } }
    ]
    const sol = solveFight(fight, fighters, { duration: 12, fps: FPS })
    expect(sol.report.beats).toHaveLength(4)
    const marks = fightCoverage(fight, sol.report, 'punch-in', 1)
    for (const beat of sol.report.beats.slice(1)) {
      const t = beat.impactTimes[beat.impactTimes.length - 1]!
      const push = marks.find((m) => m.shot.size === 'MCU' && Math.abs(m.time - (t - 0.2)) < 1e-9)
      expect(push, `beat ${beat.index + 1} at ${t.toFixed(2)} s`).toBeDefined()
    }
  })
})
