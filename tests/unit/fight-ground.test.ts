// Fork addition (2026): fighters stay on the floor (fight/ground.ts); see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { listFightMoves } from '@engine/fight/moves'
import { parseFightScript } from '@engine/fight/script'
import { MAX_FIGHT_MARKS, solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { bodyLowY } from '@engine/floor'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { FightDoc } from '@engine/types'

const FPS = 24
const SINK = -0.02
const FLOAT = 0.03

function fightOf(script: string): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return { id: 'fight_g', name: 'Ground', fighterIds: ['ent_a', 'ent_b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}

function pair(a: string, b: string): [FighterInput, FighterInput] {
  return [
    { entityId: 'ent_a', assetId: a, scale: 1, start: { x: -0.55, y: 0, z: 0 } },
    { entityId: 'ent_b', assetId: b, scale: 1, start: { x: 0.55, y: 0, z: 0 } }
  ]
}

function stage(fight: FightDoc, fighters: [FighterInput, FighterInput], duration = 40): { sol: FightSolution; ev: ShotEvaluator } {
  const sol = solveFight(fight, fighters, { duration, fps: FPS })
  const project = createProject('Ground')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = duration
  shot.fps = FPS
  fighters.forEach((f, q) => {
    const e = createEntity(f.assetId, f.entityId, { ...f.start })
    e.id = f.entityId
    e.transform.scale = f.scale
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}` })) })
  })
  return { sol, ev: new ShotEvaluator(scene, shot) }
}

/** The worst sink and the worst unreported float of each fighter, per frame through ShotEvaluator. */
function floorCheck(fight: FightDoc, fighters: [FighterInput, FighterInput]): { sol: FightSolution; problems: string[] } {
  const { sol, ev } = stage(fight, fighters)
  const beats = sol.report.beats
  // A reported kick lift lets the kicker leave the floor for that beat.
  const allowed = (q: number, t: number): number => {
    let lift = 0
    beats.forEach((b, k) => {
      const end = beats[k + 1]?.startT ?? sol.report.endT
      if (fight.beats[b.index]!.attacker === q && t >= b.startT - 1e-9 && t <= end + 1e-9) lift = Math.max(lift, ...b.liftM)
    })
    return lift
  }
  const problems: string[] = []
  const worst = [
    { sink: 0, sinkT: 0, float: 0, floatT: 0 },
    { sink: 0, sinkT: 0, float: 0, floatT: 0 }
  ]
  for (let k = 0; k <= Math.ceil(sol.report.endT * FPS); k++) {
    const t = k / FPS
    const st = ev.evaluate(t)
    fighters.forEach((f, q) => {
      const e = st.entities.find((x) => x.entityId === f.entityId)!
      const low = e.position.y + bodyLowY({ assetId: f.assetId, params: f.params, scale: f.scale }, e.joints)
      const w = worst[q]!
      if (low < w.sink) {
        w.sink = low
        w.sinkT = t
      }
      const over = low - allowed(q, t)
      if (over > w.float) {
        w.float = over
        w.floatT = t
      }
    })
  }
  worst.forEach((w, q) => {
    const who = q === 0 ? 'A' : 'B'
    if (w.sink < SINK) problems.push(`${who} sinks ${(w.sink * 100).toFixed(1)} cm at ${w.sinkT.toFixed(2)} s`)
    if (w.float > FLOAT) problems.push(`${who} floats ${(w.float * 100).toFixed(1)} cm at ${w.floatT.toFixed(2)} s (no lift reported)`)
  })
  return { sol, problems }
}

const PAIRS: [string, string][] = [
  ['person.man', 'person.woman'],
  ['person.mannequinFemale', 'person.mannequinMale']
]

/** qa-fight's scripts (bugs 2 and 3): get-ups, low sweeps, lunges, ducks and slips. */
const QA: Record<string, string> = {
  combos: `A double-jab-body-shot to body -> hit, hit, hit
B boxing-combo to head -> slip, hit power 0.8
A jab-hook-cross to head -> parry, hit power 0.8
B elbow to head -> hit power 0.8
A knee to body -> hit power 0.8`,
  kicks3: `B front-kick-combo to body -> hit, hit power 1
A high-kick to head -> hit power 1
B roundhouse to head -> hit power 1
A side kick to head -> hit power 1`,
  kicks2: `A sweep to legs -> hit power 1
B front kick to legs -> hit power 1
A roundhouse to head -> duck power 1
B hook to body -> miss power 0.8
A roundhouse to body -> hit power 1
B spinning back kick to body -> hit power 1`,
  grapples: `A shove to body -> hit power 1
B tackle to body -> hit power 1
A grapple-shove to body -> hit power 1
B takedown-lunge to body -> hit power 1`,
  defenses: `A jab cross to head -> block, parry
B hook to head -> slip
A roundhouse to head -> duck power 1
B hook to body -> duck
A front kick to body -> block power 1
B jab cross to body -> miss, slip`,
  falls: `A spinning back kick to body -> hit power 1
B jab cross to head -> block, hit
A roundhouse to body -> ko power 1`
}

describe('fighters stay on the floor (lowest body point, every frame)', () => {
  for (const [a, b] of PAIRS) {
    for (const [name, script] of Object.entries(QA)) {
      it(`${name}: ${a} vs ${b}`, () => {
        const { sol, problems } = floorCheck(fightOf(script), pair(a, b))
        expect(sol.report.beats.length).toBeGreaterThan(0)
        expect(problems).toEqual([])
      })
    }
    it(`every fight move, hit at full power and followed by a beat (get-ups): ${a} vs ${b}`, () => {
      const problems: string[] = []
      for (const m of listFightMoves()) {
        const { sol, problems: p } = floorCheck(fightOf(`A ${m.id} -> hit power 1\nB jab cross to head -> block, block`), pair(a, b))
        if (sol.report.beats.length === 0) problems.push(`${m.id}: not solved (${sol.report.warnings.join('; ')})`)
        problems.push(...p.map((x) => `${m.id}: ${x}`))
      }
      expect(problems).toEqual([])
    })
  }

  it('a reported kick lift is the kicker’s height off the floor at the impact', () => {
    const fighters = pair('person.woman', 'person.man')
    const fight = fightOf('A roundhouse to head -> hit power 1')
    const { sol, ev } = stage(fight, fighters)
    const rep = sol.report.beats[0]!
    expect(rep.liftM[0]!).toBeGreaterThan(0.1)
    const e = ev.evaluate(rep.impactTimes[0]!).entities.find((x) => x.entityId === 'ent_a')!
    const low = e.position.y + bodyLowY({ assetId: 'person.woman', scale: 1 }, e.joints)
    expect(Math.abs(low - rep.liftM[0]!)).toBeLessThanOrEqual(0.01)
  })

  it('a knockdown on the last beat stays down: no walk from the floor back to guard', () => {
    const fighters = pair('person.man', 'person.woman')
    const fight = fightOf('A jab cross to head -> hit, hit\nB spinning back kick to body -> hit power 1')
    const { sol, ev } = stage(fight, fighters)
    const rep = sol.report.beats[1]!
    expect(rep.physics[0]!.result).toBe('knockdown')
    const after = sol.tracks[0].filter((m) => m.time > rep.impactTimes[0]! + 1e-9)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((m) => m.gait === 'stand')).toBe(true)
    const end = ev.evaluate(sol.report.endT).entities.find((e) => e.entityId === 'ent_a')!
    const pelvis = toWorld(poseEffectors(personDims('person.man'), end.joints).pelvis, end.position, end.heading, 1)
    expect(pelvis.y).toBeLessThan(0.5)
    expect(Math.abs(end.position.y + bodyLowY({ assetId: 'person.man' }, end.joints))).toBeLessThanOrEqual(0.015)
  })

  it('a 20-beat fight stays within the mark cap with the floor marks', () => {
    const lines = ['A low-sweep to legs -> hit power 1', 'B takedown-lunge to body -> block', 'A roundhouse to body -> hit power 1', 'B jab cross to head -> slip, hit']
    const script = Array.from({ length: 20 }, (_, k) => lines[k % lines.length]!).join('\n')
    const { sol } = stage(fightOf(script), pair('person.man', 'person.woman'), 120)
    expect(sol.report.beats.length).toBe(20)
    expect(sol.tracks[0].length).toBeLessThanOrEqual(MAX_FIGHT_MARKS)
    expect(sol.tracks[1].length).toBeLessThanOrEqual(MAX_FIGHT_MARKS)
  })
})
