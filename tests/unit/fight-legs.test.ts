// Fork addition (2026): fight rest steps and step-ins stay on the floor, elbows reach a taller head; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Mesh, Vector3, type Object3D } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { ShotEvaluator } from '@engine/evaluate'
import { GAITS } from '@engine/gaits'
import { bodyClearance, torsoShape, torsoSurface } from '@engine/fight/contact'
import { fightMotion, strikeImpacts } from '@engine/fight/moves'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { EntityState, FightDoc } from '@engine/types'

const FPS = 24

/** The qa-fight scripts (.maestro/qa-fight/fights.mjs): every strike, step-in and rest step. */
const FIGHTS: Record<string, string> = {
  punches: `A jab cross to head -> hit, hit power 0.7
B uppercut to head -> hit power 0.8
A haymaker to head -> hit power 0.8
B hook to head -> hit power 0.8
A spinning-backfist to head -> block power 0.8
B spinning-back-fist to head -> ko power 1`,
  combos: `A double-jab-body-shot to body -> hit, hit, hit
B boxing-combo to head -> slip, hit power 0.8
A jab-hook-cross to head -> parry, hit power 0.8
B elbow to head -> hit power 0.8
A knee to body -> hit power 0.8`,
  kicks: `A front kick to body -> hit power 1
B side kick to body -> hit power 1
A teep-push-kick to body -> hit power 1`,
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
  elbows: `A elbow to head -> hit power 1
B elbow to body -> hit power 1
A haymaker to body -> hit power 1`,
  grapples: `A shove to body -> hit power 1
B tackle to body -> hit power 1
A grapple-shove to body -> hit power 1
B takedown-lunge to body -> hit power 1`
}
const PAIRS: [string, string][] = [
  ['person.man', 'person.woman'],
  ['person.child', 'person.elderly'],
  ['person.mannequinMale', 'person.mannequinFemale']
]

function fightOf(script: string): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return { id: 'fight_l', name: 'Legs', fighterIds: ['ent_a', 'ent_b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}

function pair(a: string, b: string): [FighterInput, FighterInput] {
  return [
    { entityId: 'ent_a', assetId: a, scale: 1, start: { x: -0.55, y: 0, z: 0 } },
    { entityId: 'ent_b', assetId: b, scale: 1, start: { x: 0.55, y: 0, z: 0 } }
  ]
}

function stage(fight: FightDoc, fighters: [FighterInput, FighterInput], duration = 40): { sol: FightSolution; ev: ShotEvaluator } {
  const sol = solveFight(fight, fighters, { duration, fps: FPS })
  const project = createProject('Legs')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = duration
  shot.fps = FPS
  fighters.forEach((f, q) => {
    const e = createEntity(f.assetId, f.entityId, { ...f.start })
    e.id = f.entityId
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}` })) })
  })
  return { sol, ev: new ShotEvaluator(scene, shot) }
}

/** Lowest rendered vertex of the legs and feet (the meshes under hipL / hipR), world y. */
function footLow(root: Object3D): number {
  let low = Infinity
  const v = new Vector3()
  root.updateMatrixWorld(true)
  for (const hip of ['hipL', 'hipR']) {
    root.getObjectByName(hip)!.traverse((o) => {
      if (!(o instanceof Mesh)) return
      const pos = o.geometry.getAttribute('position')
      for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).y)
    })
  }
  return low
}

/** The built body posed as SceneManager.applyTime poses it: gait, stride phase and the evaluated joints. */
function render(built: ReturnType<typeof buildAsset>, es: EntityState, t: number): Object3D {
  const stride = GAITS[es.gait].strideLength
  const overrides: Record<string, number> = {}
  for (const [k, v] of Object.entries(es.joints ?? {})) if (v !== 0) overrides[k] = v
  built.animate!({ gait: es.gait, phase: stride > 0 ? (es.distanceTravelled / stride) % 1 : 0, speed: es.speed, distance: es.distanceTravelled, time: t, overrides })
  built.group.position.set(es.position.x, es.position.y, es.position.z)
  built.group.rotation.y = es.heading
  return built.group
}

describe('fight rest steps and step-ins keep the feet on the floor (six bodies)', () => {
  for (const [a, b] of PAIRS) {
    it(`every walk frame of the qa-fight scripts: the lowest foot within ±2 cm (${a} vs ${b})`, () => {
      const off: string[] = []
      let frames = 0
      for (const [name, script] of Object.entries(FIGHTS)) {
        const fighters = pair(a, b)
        const { sol, ev } = stage(fightOf(script), fighters)
        const built = fighters.map((f) => buildAsset(f.assetId))
        for (let k = 0; k <= Math.ceil(sol.report.endT * FPS); k++) {
          const t = k / FPS
          const st = ev.evaluate(t)
          fighters.forEach((f, q) => {
            const es = st.entities.find((e) => e.entityId === f.entityId)!
            if (!GAITS[es.gait].travels) return
            frames++
            const low = footLow(render(built[q]!, es, t))
            if (Math.abs(low) > 0.02) off.push(`${name} ${q === 0 ? 'A' : 'B'} ${es.gait} @${t.toFixed(2)}: ${(low * 100).toFixed(1)} cm`)
          })
        }
      }
      expect(frames).toBeGreaterThan(100)
      expect(off).toEqual([])
    }, 60000)
  }
})

/** The attacker's torso lean (rad) at a beat's impact on top of the move's own torso. */
function leanAt(fight: FightDoc, sol: FightSolution, ev: ShotEvaluator, beat: number, attacker: string): number {
  const move = fight.beats[sol.report.beats[beat]!.index]!.move
  const imp = strikeImpacts(move)[0]!
  const kf = fightMotion(move)!.keyframes.find((k) => Math.abs(k.t - imp.t) < 1e-9)!
  const es = ev.evaluate(sol.report.beats[beat]!.impactTimes[0]!).entities.find((e) => e.entityId === attacker)!
  const d = (k: string): number => (es.joints?.[k] ?? 0) - (kf.joints[k] ?? 0)
  return Math.hypot(d('torsoX'), d('torsoZ'))
}

/** How far the attacker's torso (its surface toward the defender at three heights) and head stay out of the defender's body (m). */
function spacingAt(ev: ShotEvaluator, t: number, atk: FighterInput, def: FighterInput): number {
  const st = ev.evaluate(t)
  const a = st.entities.find((e) => e.entityId === atk.entityId)!
  const d = st.entities.find((e) => e.entityId === def.entityId)!
  const da = personDims(atk.assetId)
  const dd = personDims(def.assetId)
  const l = Math.hypot(d.position.x - a.position.x, d.position.z - a.position.z)
  const toward = { x: (d.position.x - a.position.x) / l, z: (d.position.z - a.position.z) / l }
  const points = [0.3, 0.6, 0.9].map((y) => torsoSurface(torsoShape(atk.assetId, undefined, da), da, 1, a.joints, a.position, a.heading, toward, y))
  const head = toWorld(poseEffectors(da, a.joints).head, a.position, a.heading, 1)
  points.push({ x: head.x + toward.x * da.headR, y: head.y, z: head.z + toward.z * da.headR })
  return Math.min(...points.map((p) => bodyClearance(torsoShape(def.assetId, undefined, dd), dd, 1, 1, d.joints, d.position, d.heading, p)))
}

describe('arm blows reach a taller head: elbows on the jaw, a torso lean', () => {
  const LANDS: [string, string][] = [
    ['person.man', 'person.woman'],
    ['person.mannequinMale', 'person.mannequinFemale']
  ]
  for (const [a, b] of LANDS) {
    it(`lands on the head surface within ±1.5 cm, the bodies apart (${b} → ${a})`, () => {
      const fight = fightOf('B elbow to head -> hit power 0.8')
      const fighters = pair(a, b)
      const { sol, ev } = stage(fight, fighters)
      const rep = sol.report.beats[0]!
      expect(rep.contactErrorM[0]!).toBeLessThanOrEqual(0.015)
      expect(sol.report.warnings.filter((w) => w.includes("can't reach"))).toEqual([])
      expect(leanAt(fight, sol, ev, 0, 'ent_b')).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-6)
      // A clinch: the chests may touch (qa-fight accepted a 2.7 cm core intrusion), no deeper.
      expect(spacingAt(ev, rep.impactTimes[0]!, fighters[1], fighters[0])).toBeGreaterThanOrEqual(-0.035)
      // The rendered elbow on the defender's head (classic: its sphere), on the jaw (below the head's middle).
      if (a === 'person.man') {
        const st = ev.evaluate(rep.impactTimes[0]!)
        const atk = st.entities.find((e) => e.entityId === 'ent_b')!
        const def = st.entities.find((e) => e.entityId === 'ent_a')!
        const body = buildAsset(b)
        body.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: atk.joints })
        body.group.position.set(atk.position.x, atk.position.y, atk.position.z)
        body.group.rotation.y = atk.heading
        body.group.updateMatrixWorld(true)
        const elbow = body.group.getObjectByName('elbowR')!.getWorldPosition(new Vector3())
        const dims = personDims(a)
        const head = toWorld(poseEffectors(dims, def.joints).head, def.position, def.heading, 1)
        const gap = Math.hypot(elbow.x - head.x, elbow.y - head.y, elbow.z - head.z) - dims.headR
        expect(Math.abs(gap)).toBeLessThanOrEqual(0.015)
        expect(elbow.y).toBeLessThan(head.y)
      }
    })
  }

  for (const [a, b] of [['person.mannequinMale', 'person.woman'], ['person.man', 'person.mannequinFemale'], ['person.elderly', 'person.child']] as const) {
    it(`lands, or warns with the gap left; any lean ≤ 20° (${b} → ${a})`, () => {
      const fight = fightOf('B elbow to head -> hit power 0.8')
      const fighters = pair(a, b)
      const { sol, ev } = stage(fight, fighters)
      const err = sol.report.beats[0]!.contactErrorM[0]!
      const warning = sol.report.warnings.find((w) => w.includes("can't reach"))
      if (err <= 0.015) expect(warning).toBeUndefined()
      else expect(warning).toContain(`${(err * 100).toFixed(1)} cm off`)
      expect(leanAt(fight, sol, ev, 0, 'ent_b')).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-6)
    })
  }

  it('a lean never takes the child into the elderly body (it stood 7.6 cm clear upright)', () => {
    const fighters = pair('person.elderly', 'person.child')
    const { sol, ev } = stage(fightOf('B elbow to head -> hit power 0.8'), fighters)
    expect(spacingAt(ev, sol.report.beats[0]!.impactTimes[0]!, fighters[1], fighters[0])).toBeGreaterThanOrEqual(-0.01)
  })

  it('an elbow the jaw aim leaves short leans in and lands (elderly → man; 3.6 cm off upright)', () => {
    const fight = fightOf('B elbow to head -> hit power 0.8')
    const fighters = pair('person.man', 'person.elderly')
    const { sol, ev } = stage(fight, fighters)
    const lean = leanAt(fight, sol, ev, 0, 'ent_b')
    expect(lean).toBeGreaterThan(0.05)
    expect(lean).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-6)
    expect(sol.report.beats[0]!.contactErrorM[0]!).toBeLessThanOrEqual(0.015)
    expect(spacingAt(ev, sol.report.beats[0]!.impactTimes[0]!, fighters[1], fighters[0])).toBeGreaterThanOrEqual(-0.035)
  })

  it('head kicks keep their lift and lean nothing', () => {
    for (const script of ['A high-kick to head -> hit power 1', 'B roundhouse to head -> hit power 1']) {
      const fight = fightOf(script)
      const { sol, ev } = stage(fight, pair('person.man', 'person.woman'))
      expect(sol.report.beats[0]!.liftM[0]!, script).toBeGreaterThan(0)
      expect(leanAt(fight, sol, ev, 0, script.startsWith('A') ? 'ent_a' : 'ent_b'), script).toBeLessThan(1e-9)
    }
  })
})
