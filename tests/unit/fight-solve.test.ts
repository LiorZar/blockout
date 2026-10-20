import { describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { torsoShape, torsoSurface } from '@engine/fight/contact'
import { DEFENSES, REACTIONS, strikeImpacts } from '@engine/fight/moves'
import { parseFightScript } from '@engine/fight/script'
import { CLINCH_MOVES, MAX_FIGHT_MARKS, solveFight, type FighterInput } from '@engine/fight/solve'
import { MOTION_PRESETS } from '@engine/motions'
import { createEntity, createProject } from '@engine/schema'
import { bodyLowY } from '@engine/floor'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { ActorMark, EntityState, FightDoc, V3 } from '@engine/types'

function mark(time: number, x: number, z: number, heading: number, gait: ActorMark['gait'], lockFacing?: boolean): ActorMark {
  return { id: `m${time}`, time, hold: 0, easeIn: 0, easeOut: 0, position: { x, y: 0, z }, gait, arriveHeading: heading, lockFacing }
}

describe('lockFacing marks (evaluator)', () => {
  it('keeps the blended arriveHeading while travelling, instead of the travel direction', () => {
    const doc = createProject('Lock')
    const scene = doc.scenes[0]!
    const e = createEntity('person.man', 'M', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    // Back off +Z (travel heading would be π) while facing −Z (heading 0 → 0.4).
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 0, 0, 'stand', true), mark(1, 0, 1, 0.4, 'stand', true)] })
    const ev = new ShotEvaluator(scene, scene.shots[0]!)
    const mid = ev.evaluate(0.5).entities[0]!
    expect(mid.heading).toBeCloseTo(0.2, 9)
    expect(mid.position.z).toBeCloseTo(0.5, 6)
    expect(mid.gait).toBe('stand')
    expect(ev.evaluate(1).entities[0]!.heading).toBeCloseTo(0.4, 9)
  })

  it("keeps the mark's own gait on a stationary leg", () => {
    const doc = createProject('Lock')
    const scene = doc.scenes[0]!
    const e = createEntity('person.man', 'M', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 0, 1, 'stand', true), mark(1, 0, 0, 1, 'stand', true), mark(2, 0, -2, 1, 'walk', true)] })
    const ev = new ShotEvaluator(scene, scene.shots[0]!)
    expect(ev.evaluate(0.5).entities[0]!.gait).toBe('stand')
    expect(ev.evaluate(0.5).entities[0]!.heading).toBeCloseTo(1, 9)
    expect(ev.evaluate(1.5).entities[0]!.gait).toBe('walk')
    expect(ev.evaluate(1.5).entities[0]!.heading).toBeCloseTo(1, 9)
  })

  it('marks without lockFacing behave exactly as upstream', () => {
    const doc = createProject('Plain')
    const scene = doc.scenes[0]!
    const e = createEntity('person.man', 'M', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: [mark(0, 0, 0, 0, 'stand'), mark(1, 0, 1, 0.4, 'stand')] })
    const mid = new ShotEvaluator(scene, scene.shots[0]!).evaluate(0.5).entities[0]!
    expect(Math.abs(mid.heading)).toBeCloseTo(Math.PI, 9) // travel heading toward +Z
    expect(mid.gait).toBe('walk')
  })
})

/* ------------------------------ contact solver ----------------------------- */

const FPS = 24

function fightOf(script: string, over: Partial<FightDoc> = {}): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return {
    id: 'fight_t',
    name: 'Test fight',
    fighterIds: ['ent_a', 'ent_b'],
    beats: r.beats,
    startT: 0.4,
    origin: { x: 0, z: 0, heading: 0 },
    beatGap: 0.35,
    exaggeration: 1.5,
    ...over
  }
}

function pair(a: Partial<FighterInput> = {}, b: Partial<FighterInput> = {}): [FighterInput, FighterInput] {
  return [
    { entityId: 'ent_a', assetId: 'person.man', scale: 1, start: { x: -0.55, y: 0, z: 0 }, ...a },
    { entityId: 'ent_b', assetId: 'person.woman', scale: 1, start: { x: 0.55, y: 0, z: 0 }, ...b }
  ]
}

/** Stage the solution as real entities + tracks and evaluate through ShotEvaluator. */
function stage(fight: FightDoc, fighters: [FighterInput, FighterInput], duration = 20) {
  const sol = solveFight(fight, fighters, { duration, fps: FPS })
  const project = createProject('Fight')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = duration
  shot.fps = FPS
  fighters.forEach((f, q) => {
    const e = createEntity(f.assetId, f.entityId, { ...f.start })
    e.id = f.entityId
    e.transform.scale = f.scale
    if (f.params) e.params = { ...f.params }
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({
      entityId: e.id,
      marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}`, position: { ...m.position }, joints: m.joints ? { ...m.joints } : undefined }))
    })
  })
  return { sol, ev: new ShotEvaluator(scene, shot) }
}

const hz = (v: { x: number; z: number }): { x: number; z: number } => {
  const l = Math.hypot(v.x, v.z)
  return { x: v.x / l, z: v.z / l }
}

/** Effector and aimed-at point for blow i of a beat, from evaluated states. */
function blow(st: { entities: EntityState[] }, fight: FightDoc, fighters: [FighterInput, FighterInput], beatIndex: number, i: number) {
  const beat = fight.beats[beatIndex]!
  const aIn = fighters[beat.attacker]
  const dIn = fighters[beat.attacker === 0 ? 1 : 0]
  const a = st.entities.find((e) => e.entityId === aIn.entityId)!
  const d = st.entities.find((e) => e.entityId === dIn.entityId)!
  const effector = strikeImpacts(beat.move)[i]!.effector
  const aDims = personDims(aIn.assetId, aIn.params)
  const dDims = personDims(dIn.assetId, dIn.params)
  const E = toWorld(poseEffectors(aDims, a.joints)[effector], a.position, a.heading, aIn.scale)
  const toward = hz({ x: a.position.x - d.position.x, z: a.position.z - d.position.z })
  const fx = poseEffectors(dDims, d.joints)
  const w = (p: V3): V3 => toWorld(p, d.position, d.heading, dIn.scale)
  const push = (p: V3, k: number): V3 => ({ x: p.x + toward.x * k, y: p.y, z: p.z + toward.z * k })
  let T: V3
  if (beat.target === 'head') T = push(w(fx.head), dDims.headR * dIn.scale)
  else if (beat.target === 'legs') {
    const l = w(fx.kneeL)
    const r = w(fx.kneeR)
    const ref = { x: d.position.x + toward.x, z: d.position.z + toward.z }
    const lead = Math.hypot(l.x - ref.x, l.z - ref.z) <= Math.hypot(r.x - ref.x, r.z - ref.z) ? l : r
    T = push(lead, 0.08)
  }
  // Body (fork, contact.ts): the torso's surface — chest, lower torso for a knee, midsection for a kick.
  else T = torsoSurface(torsoShape(dIn.assetId, dIn.params, dDims), dDims, dIn.scale, d.joints, d.position, d.heading, toward, effector.startsWith('knee') ? 0.2 : effector.startsWith('foot') ? 0.3 : 0.55)
  const head = w(fx.head)
  return {
    E,
    T,
    error: Math.hypot(E.x - T.x, E.y - T.y, E.z - T.z),
    clearance: Math.hypot(E.x - head.x, E.y - head.y, E.z - head.z) - dDims.headR * dIn.scale,
    a,
    d,
    effector
  }
}

const SIX = `A jab cross to head -> hit, hit
B hook to head -> hit
A front kick to body -> hit
B roundhouse to body -> hit
A knee to body -> hit
B jab cross to body -> block, hit`

const onGrid = (t: number): boolean => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-9

describe('solveFight', () => {
  it('every hit lands within 3 cm on the impact frame', () => {
    const fight = fightOf(SIX)
    const fighters = pair()
    const { sol, ev } = stage(fight, fighters)
    expect(sol.report.beats).toHaveLength(6)
    let hitsChecked = 0
    for (const rep of sol.report.beats) {
      const outcomes = fight.beats[rep.index]!.outcomes
      rep.impactTimes.forEach((t, i) => {
        expect(onGrid(t), `beat ${rep.index + 1} impact ${i + 1} on the frame grid`).toBe(true)
        const outcome = outcomes[outcomes.length - rep.impactTimes.length + i] ?? 'block'
        if (outcome !== 'hit' && outcome !== 'ko') return
        const b = blow(ev.evaluate(t), fight, fighters, rep.index, i)
        expect(b.error, `beat ${rep.index + 1} blow ${i + 1} (${b.effector})`).toBeLessThanOrEqual(0.03)
        expect(rep.contactErrorM[i]!).toBeLessThanOrEqual(0.03)
        hitsChecked++
      })
    }
    expect(hitsChecked).toBe(7)
    expect(sol.report.warnings.filter((w) => w.includes("can't reach"))).toEqual([])
  })

  it("defender's reaction starts on the impact frame", () => {
    const fight = fightOf(SIX)
    const { sol } = stage(fight, pair())
    for (const rep of sol.report.beats) {
      const beat = fight.beats[rep.index]!
      const defTrack = sol.tracks[beat.attacker === 0 ? 1 : 0]
      const lastT = rep.impactTimes[rep.impactTimes.length - 1]!
      const first = defTrack.find((m) => m.time >= lastT - 1e-9)!
      expect(Math.abs(first.time - lastT), `beat ${rep.index + 1}`).toBeLessThanOrEqual(1e-9)
      const ph = rep.physics[rep.physics.length - 1]!
      const id =
        ph.result === 'knockdown'
          ? REACTIONS.knockdown
          : ph.result === 'stagger'
            ? REACTIONS.stagger
            : beat.target === 'head'
              ? REACTIONS.head
              : REACTIONS.body
      const kf0 = MOTION_PRESETS.find((m) => m.id === id)!.keyframes[0]!.joints
      for (const [k, v] of Object.entries(kf0)) expect(first.joints![k] ?? 0, `beat ${rep.index + 1} ${k}`).toBeCloseTo(v, 9)
    }
  })

  it('blocks are up by impact', () => {
    const fight = fightOf('A jab cross to head -> block, block\nB front kick to body -> block\nA hook to head -> parry')
    const fighters = pair()
    const { sol, ev } = stage(fight, fighters)
    expect(sol.report.beats).toHaveLength(3)
    const upHigh = MOTION_PRESETS.find((m) => m.id === DEFENSES.block.high)!.keyframes[1]!.joints
    const upLow = MOTION_PRESETS.find((m) => m.id === DEFENSES.block.low)!.keyframes[1]!.joints
    for (const rep of sol.report.beats) {
      const beat = fight.beats[rep.index]!
      for (const e of rep.contactErrorM) expect(e, `beat ${rep.index + 1} lands on the guard`).toBeLessThanOrEqual(0.03)
      if (beat.outcomes[0] === 'parry') continue
      const up = beat.target === 'head' ? upHigh : upLow
      for (const t of rep.impactTimes) {
        const d = ev.evaluate(t).entities.find((e) => e.entityId === fighters[beat.attacker === 0 ? 1 : 0].entityId)!
        for (const k of ['shoulderLX', 'shoulderRX']) {
          expect(Math.abs((d.joints?.[k] ?? 0) - (up[k] ?? 0)), `beat ${rep.index + 1} ${k}`).toBeLessThanOrEqual(0.05)
        }
      }
    }
  })

  it('slips and ducks clear by ≥ 25 cm', () => {
    const fight = fightOf('A jab cross to head -> slip, slip\nB hook to head -> duck\nA uppercut to head -> miss\nB jab cross to head -> duck, slip')
    const fighters = pair()
    const { sol, ev } = stage(fight, fighters)
    expect(sol.report.beats).toHaveLength(4)
    for (const rep of sol.report.beats) {
      rep.impactTimes.forEach((t, i) => {
        const b = blow(ev.evaluate(t), fight, fighters, rep.index, i)
        expect(b.clearance, `beat ${rep.index + 1} blow ${i + 1}`).toBeGreaterThanOrEqual(0.25 - 1e-3)
        expect(rep.clearanceM[i]!).toBeGreaterThanOrEqual(0.25 - 1e-3)
      })
    }
  })

  it('knockdown slides the defender along the impulse direction by ImpactResult.slide ± 5 cm', () => {
    const fight = fightOf('A jab cross to head -> block, hit\nB roundhouse to body -> ko power 1')
    const { sol, ev } = stage(fight, pair())
    const rep = sol.report.beats[1]!
    const ph = rep.physics[0]!
    expect(ph.result).toBe('knockdown')
    const t = rep.impactTimes[0]!
    const at = ev.evaluate(t)
    const a0 = at.entities.find((e) => e.entityId === 'ent_a')!
    const b0 = at.entities.find((e) => e.entityId === 'ent_b')!
    const dir = hz({ x: a0.position.x - b0.position.x, z: a0.position.z - b0.position.z })
    const after = ev.evaluate(t + ph.fallDuration + 1).entities.find((e) => e.entityId === 'ent_a')!
    const moved = (after.position.x - a0.position.x) * dir.x + (after.position.z - a0.position.z) * dir.z
    expect(Math.abs(moved - ph.slide)).toBeLessThanOrEqual(0.05)
    expect(after.position.y).toBeLessThan(-0.3) // down on the ground
  })

  it('pelvises never closer than 0.35 m (outside clinch beats)', () => {
    const fight = fightOf(`A jab cross to head -> hit, hit
B hook to head -> hit
A front kick to body -> parry
B roundhouse to body -> hit
A uppercut to head -> hit
B jab cross to head -> slip, hit
A knee to body -> hit`)
    const fighters = pair()
    const { sol, ev } = stage(fight, fighters)
    const clinch = sol.report.beats
      .filter((r) => CLINCH_MOVES.has(fight.beats[r.index]!.move))
      .map((r) => [r.startT - 0.6, r.impactTimes[r.impactTimes.length - 1]! + 1.5] as const)
    let samples = 0
    for (let k = 0; k / FPS <= sol.report.endT; k++) {
      const t = k / FPS
      if (clinch.some(([s, e]) => t >= s && t <= e)) continue
      const st = ev.evaluate(t)
      const p = st.entities.map((e, q) => toWorld(poseEffectors(personDims(fighters[q]!.assetId), e.joints).pelvis, e.position, e.heading, 1))
      expect(Math.hypot(p[0]!.x - p[1]!.x, p[0]!.z - p[1]!.z), `t=${t.toFixed(3)}`).toBeGreaterThanOrEqual(0.35 - 1e-6)
      samples++
    }
    expect(samples).toBeGreaterThan(100)
  })

  it('unreachable beat reports its error and a warning', () => {
    const { sol } = stage(fightOf('A sweep to head -> hit'), pair())
    expect(sol.report.beats[0]!.contactErrorM[0]!).toBeGreaterThan(0.03)
    expect(sol.report.warnings.some((w) => w.includes('Beat 1') && w.includes("can't reach"))).toBe(true)
    expect(sol.report.beats[0]!.warnings.length).toBeGreaterThan(0)
  })

  it('a head kick on a taller opponent lifts the kicker just enough to land, and reports the lift', () => {
    const fight = fightOf('B roundhouse to head -> hit\nA front kick to body -> hit')
    const fighters = pair()
    const { sol, ev } = stage(fight, fighters)
    const [kick, body] = sol.report.beats
    expect(kick!.contactErrorM[0]!).toBeLessThanOrEqual(0.03)
    expect(kick!.liftM[0]!).toBeGreaterThan(0.1)
    expect(kick!.liftM[0]!).toBeLessThanOrEqual(0.5)
    expect(sol.report.warnings.filter((w) => w.includes("can't reach"))).toEqual([])
    const t = kick!.impactTimes[0]!
    const st = ev.evaluate(t)
    const b = blow(st, fight, fighters, 0, 0)
    expect(b.error).toBeLessThanOrEqual(0.03)
    // Floor contact (fork, ground.ts): the lift is the lowest body point's height off the floor.
    const low = (e: EntityState): number => e.position.y + bodyLowY({ assetId: 'person.woman' }, e.joints)
    expect(low(b.a)).toBeCloseTo(kick!.liftM[0]!, 6)
    // Ramped in and landed: on the ground at the beat's start and after it.
    expect(Math.abs(low(ev.evaluate(kick!.startT).entities.find((e) => e.entityId === 'ent_b')!))).toBeLessThanOrEqual(0.015)
    expect(Math.abs(low(ev.evaluate(t + 1.2).entities.find((e) => e.entityId === 'ent_b')!))).toBeLessThanOrEqual(0.015)
    // Only as much as needed: a reachable kick doesn't lift.
    expect(body!.liftM).toEqual([0])
  })

  it('blocks and parries meet the blow within 3 cm, even a front kick parried by an equal-height man', () => {
    const fight = fightOf('A front kick to body -> parry\nB jab cross to head -> block, parry\nA roundhouse to body -> block')
    const fighters = pair({}, { assetId: 'person.man' })
    const { sol } = stage(fight, fighters)
    expect(sol.report.beats).toHaveLength(3)
    for (const rep of sol.report.beats) {
      for (const e of rep.contactErrorM) expect(e, `beat ${rep.index + 1}`).toBeLessThanOrEqual(0.03)
    }
  })

  it('beats past the shot end are dropped with a warning', () => {
    const { sol } = stage(fightOf(SIX), pair(), 4)
    expect(sol.report.beats.length).toBeLessThan(6)
    expect(sol.report.beats.length).toBeGreaterThan(0)
    for (const r of sol.report.beats) expect(r.impactTimes[r.impactTimes.length - 1]!).toBeLessThanOrEqual(4 - 0.3 + 1e-9)
    const dropped = sol.report.warnings.filter((w) => w.includes('past the end of the shot'))
    expect(dropped.length).toBe(6 - sol.report.beats.length)
    expect(dropped[0]).toMatch(/^Beat \d+ dropped/)
  })

  it('a beat at an explicit time starts there', () => {
    const { sol } = stage(fightOf('A jab cross to head -> hit at 2s'), pair())
    expect(Math.abs(sol.report.beats[0]!.startT - 2)).toBeLessThanOrEqual(0.5 / FPS + 1e-9)
  })

  it('a step-in faster than 2.5 m/s pushes the beat later', () => {
    const fight = fightOf('A jab cross to head -> hit')
    const fighters = pair({ start: { x: -3.5, y: 0, z: 0 } })
    const { sol, ev } = stage(fight, fighters)
    const rep = sol.report.beats[0]!
    expect(rep.warnings.some((w) => w.includes('delayed'))).toBe(true)
    expect(blow(ev.evaluate(rep.impactTimes[1]!), fight, fighters, 0, 1).error).toBeLessThanOrEqual(0.03)
    const tr = sol.tracks[0]
    for (let k = 1; k < tr.length; k++) {
      const d = Math.hypot(tr[k]!.position.x - tr[k - 1]!.position.x, tr[k]!.position.z - tr[k - 1]!.position.z)
      if (d > 0.05) expect(d / (tr[k]!.time - tr[k - 1]!.time), `leg ${k}`).toBeLessThanOrEqual(2.5 + 1e-6)
    }
  })

  it('20-beat fight stays ≤ 400 marks per track', () => {
    const lines = ['A jab cross to head -> block, hit', 'B hook to head -> hit', 'A front kick to body -> parry', 'B uppercut to head -> slip', 'A hook to body -> hit']
    const script = Array.from({ length: 20 }, (_, k) => lines[k % lines.length]!).join('\n')
    const { sol } = stage(fightOf(script), pair(), 90)
    expect(sol.report.beats).toHaveLength(20)
    expect(sol.tracks[0].length).toBeLessThanOrEqual(MAX_FIGHT_MARKS)
    expect(sol.tracks[1].length).toBeLessThanOrEqual(MAX_FIGHT_MARKS)
  })

  it('drops trailing beats with a warning when a track would pass the mark cap', () => {
    const script = Array.from({ length: 120 }, (_, k) => (k % 2 === 0 ? 'A jab cross to head -> hit, hit' : 'B hook to head -> hit')).join('\n')
    const { sol } = stage(fightOf(script), pair(), 600)
    expect(sol.tracks[0].length).toBeLessThanOrEqual(MAX_FIGHT_MARKS)
    expect(sol.tracks[1].length).toBeLessThanOrEqual(MAX_FIGHT_MARKS)
    expect(sol.report.warnings.some((w) => w.includes('mark limit'))).toBe(true)
    const solved = sol.report.beats.map((r) => r.index)
    expect(solved).toEqual(solved.map((_, k) => k))
  })

  it('mixed sizes: child (height 0.8) vs man (height 1.2, build 1.3)', () => {
    const fight = fightOf(`A front kick to legs -> hit
B front kick to body -> hit
A roundhouse to legs -> hit
B knee to head -> hit`)
    const fighters = pair({ assetId: 'person.child', params: { height: 0.8 } }, { assetId: 'person.man', params: { height: 1.2, build: 1.3 } })
    const { sol, ev } = stage(fight, fighters)
    expect(sol.report.beats).toHaveLength(4)
    for (const rep of sol.report.beats) {
      rep.impactTimes.forEach((t, i) => {
        expect(blow(ev.evaluate(t), fight, fighters, rep.index, i).error, `beat ${rep.index + 1}`).toBeLessThanOrEqual(0.03)
      })
    }
  })

  it('deterministic: two solves give equal JSON', () => {
    const a = solveFight(fightOf(SIX), pair(), { duration: 20, fps: FPS })
    const b = solveFight(fightOf(SIX), pair(), { duration: 20, fps: FPS })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
