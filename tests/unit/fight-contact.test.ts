// Fork addition (2026): body blows land on the body surface, body misses miss, short attackers reach (fight/contact.ts); see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { DoubleSide, Mesh, Raycaster, Triangle, Vector3, type Object3D } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { ShotEvaluator } from '@engine/evaluate'
import { strikeImpacts } from '@engine/fight/moves'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { createEntity, createProject } from '@engine/schema'
import { framePoint, personDims, poseEffectors, poseFrames, toWorld } from '@engine/skeleton'
import type { EntityState, FightDoc, V3 } from '@engine/types'
import { heldPointLocal, weaponContact, weaponSpec } from '@engine/weapons'

const FPS = 24
type Arms = { assetId: string; hand: 'L' | 'R'; scale: number }[]

function fightOf(script: string): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return { id: 'fight_c', name: 'Contact', fighterIds: ['ent_a', 'ent_b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}

function pair(a: string, b: string, aArms: Arms = []): [FighterInput, FighterInput] {
  return [
    { entityId: 'ent_a', assetId: a, scale: 1, start: { x: -0.55, y: 0, z: 0 }, ...(aArms.length > 0 ? { weapons: aArms } : {}) },
    { entityId: 'ent_b', assetId: b, scale: 1, start: { x: 0.55, y: 0, z: 0 } }
  ]
}

function stage(fight: FightDoc, fighters: [FighterInput, FighterInput], duration = 40): { sol: FightSolution; ev: ShotEvaluator } {
  const sol = solveFight(fight, fighters, { duration, fps: FPS })
  const project = createProject('Contact')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = duration
  shot.fps = FPS
  fighters.forEach((f, q) => {
    const e = createEntity(f.assetId, f.entityId, { ...f.start })
    e.id = f.entityId
    scene.entities.push(e)
    for (const w of f.weapons ?? []) {
      const weapon = createEntity(w.assetId, w.assetId, { x: 9, y: 0, z: 9 })
      weapon.heldBy = { entityId: e.id, hand: w.hand }
      scene.entities.push(weapon)
    }
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}` })) })
  })
  return { sol, ev: new ShotEvaluator(scene, shot) }
}

/** The defender's built body, posed as evaluated. */
function posed(f: FighterInput, st: EntityState): Object3D {
  const b = buildAsset(f.assetId, f.params)
  b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: st.joints })
  b.group.position.set(st.position.x, st.position.y, st.position.z)
  b.group.rotation.y = st.heading
  b.group.scale.setScalar(f.scale)
  b.group.updateMatrixWorld(true)
  return b.group
}

/** Signed distance (m) from a point to a closed mesh: negative inside. */
function signedGap(m: Mesh, p: Vector3): number {
  const pos = m.geometry.getAttribute('position')
  const idx = m.geometry.getIndex()
  const v = (i: number): Vector3 => new Vector3().fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld)
  const tri = new Triangle()
  const q = new Vector3()
  let best = Infinity
  for (let t = 0; t < (idx ? idx.count : pos.count) / 3; t++) {
    tri.set(v(3 * t), v(3 * t + 1), v(3 * t + 2))
    tri.closestPointToPoint(p, q)
    const dd = q.distanceTo(p)
    if (Number.isFinite(dd)) best = Math.min(best, dd)
  }
  const mat = m.material as { side: number }
  const side = mat.side
  mat.side = DoubleSide
  const hits = new Raycaster(p, new Vector3(0.123, 0.0371, 0.991).normalize()).intersectObject(m, false)
  mat.side = side
  return hits.length % 2 === 1 ? -best : best
}

/** The torso mesh: the mannequins' sculpted chest, the classic capsule. */
function torsoMesh(root: Object3D): Mesh {
  let found: Mesh | null = null
  root.traverse((o) => {
    if (found || !(o instanceof Mesh)) return
    if (o.name === 'chestMesh' || (o.parent?.name === 'torso' && o.geometry.type === 'CapsuleGeometry')) found = o
  })
  return found!
}

/** Nearest body surface over every visible mesh of the body (negative = inside one). */
function bodyGap(root: Object3D, p: Vector3): number {
  let best = Infinity
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible || o.userData?.isLabel) return
    best = Math.min(best, signedGap(o, p))
  })
  return best
}

/** World point of blow i of a beat: the effector, or the held weapon's strike point. */
function strikePoint(fighters: [FighterInput, FighterInput], a: EntityState, attacker: 0 | 1, effector: string): V3 {
  const f = fighters[attacker]
  const dims = personDims(f.assetId, f.params)
  const side = effector.endsWith('L') ? 'L' : 'R'
  const w = f.weapons?.find((x) => x.hand === side && effector.startsWith('hand'))
  if (!w) return toWorld(poseEffectors(dims, a.joints)[effector as 'handR'], a.position, a.heading, f.scale)
  const spec = weaponSpec(w.assetId)!
  return toWorld(heldPointLocal(dims, a.joints, w.hand, spec, weaponContact(spec, 'strike'), w.scale), a.position, a.heading, f.scale)
}

/** Every blow of a fight with its outcome, effector and evaluated states at the impact. */
function blows(fight: FightDoc, fighters: [FighterInput, FighterInput], sol: FightSolution, ev: ShotEvaluator) {
  return sol.report.beats.flatMap((rep) => {
    const beat = fight.beats[rep.index]!
    const imps = strikeImpacts(beat.move)
    const outcomes = [...Array(Math.max(0, imps.length - beat.outcomes.length)).fill('block'), ...beat.outcomes]
    return rep.impactTimes.map((t, i) => {
      const st = ev.evaluate(t)
      const a = st.entities.find((e) => e.entityId === fighters[beat.attacker].entityId)!
      const d = st.entities.find((e) => e.entityId === fighters[beat.attacker === 0 ? 1 : 0].entityId)!
      const effector = imps[i]!.effector
      return { rep, i, beat, outcome: outcomes[i] as string, effector, a, d, point: strikePoint(fighters, a, beat.attacker, effector) }
    })
  })
}

const BODY_BLOWS = `A jab cross to body -> hit, hit
B hook to body -> hit
A double-jab-body-shot to body -> hit, hit, hit
B elbow to body -> hit
A knee to body -> hit
B front kick to body -> hit
A roundhouse to body -> hit
B side kick to body -> hit
A teep-push-kick to body -> hit`

const PAIRS: [string, string][] = [
  ['person.man', 'person.woman'],
  ['person.woman', 'person.man'],
  ['person.mannequinMale', 'person.mannequinFemale'],
  ['person.mannequinFemale', 'person.mannequinMale']
]

describe('body blows land on the body surface (the built torso mesh)', () => {
  for (const [a, b] of PAIRS) {
    it(`fists, elbows, knees and kicks within ±1.5 cm: ${a} vs ${b}`, () => {
      const fight = fightOf(BODY_BLOWS)
      const fighters = pair(a, b)
      const { sol, ev } = stage(fight, fighters)
      expect(sol.report.beats).toHaveLength(9)
      const off: string[] = []
      for (const x of blows(fight, fighters, sol, ev)) {
        if (x.outcome !== 'hit') continue
        const dIn = fighters[x.beat.attacker === 0 ? 1 : 0]
        const gap = signedGap(torsoMesh(posed(dIn, x.d)), new Vector3(x.point.x, x.point.y, x.point.z))
        if (Math.abs(gap) > 0.015) off.push(`beat ${x.rep.index + 1} blow ${x.i + 1} (${x.effector}): ${(gap * 100).toFixed(1)} cm`)
      }
      expect(off).toEqual([])
    })
  }

  it('a sword thrust and a knife stab end on the surface too', () => {
    for (const [arms, script] of [
      [[{ assetId: 'prop.sword', hand: 'R', scale: 1 }], 'A sword thrust to body -> hit'],
      [[{ assetId: 'prop.knife', hand: 'R', scale: 1 }], 'A stab to body -> hit']
    ] as [Arms, string][]) {
      const fight = fightOf(script)
      const fighters = pair('person.man', 'person.woman', arms)
      const { sol, ev } = stage(fight, fighters)
      const [x] = blows(fight, fighters, sol, ev)
      const gap = signedGap(torsoMesh(posed(fighters[1], x!.d)), new Vector3(x!.point.x, x!.point.y, x!.point.z))
      expect(Math.abs(gap), script).toBeLessThanOrEqual(0.015)
    }
  })
})

describe('body kicks land on the midsection', () => {
  it('between the belt and the lower ribs, on every body', () => {
    for (const [a, b] of PAIRS) {
      const fight = fightOf('A front kick to body -> hit\nB roundhouse to body -> hit\nA side kick to body -> hit\nB teep-push-kick to body -> hit\nA spinning back kick to body -> hit')
      const fighters = pair(a, b)
      const { sol, ev } = stage(fight, fighters)
      for (const x of blows(fight, fighters, sol, ev)) {
        const dIn = fighters[x.beat.attacker === 0 ? 1 : 0]
        const dims = personDims(dIn.assetId, dIn.params)
        // Height of the foot up the defender's torso, as a fraction of its length.
        const torso = poseFrames(dims, x.d.joints).torso
        const origin = toWorld(framePoint(torso, { x: 0, y: 0, z: 0 }), x.d.position, x.d.heading, dIn.scale)
        const f = (x.point.y - origin.y) / (dims.torsoLen * dIn.scale)
        expect(f, `${a} vs ${b} beat ${x.rep.index + 1}`).toBeGreaterThanOrEqual(0.1)
        expect(f, `${a} vs ${b} beat ${x.rep.index + 1}`).toBeLessThanOrEqual(0.45)
      }
    }
  })

  it("the woman's body side kick on the man lifts her less than at the chest (45 cm)", () => {
    const { sol } = stage(fightOf('B side kick to body -> hit power 1'), pair('person.man', 'person.woman'))
    expect(sol.report.beats[0]!.contactErrorM[0]!).toBeLessThanOrEqual(0.03)
    expect(sol.report.beats[0]!.liftM[0]!).toBeLessThanOrEqual(0.3)
  })
})

describe('body and legs misses clear the body by ≥ 10 cm', () => {
  const MISSES = `B hook to body -> miss power 0.8
A jab cross to body -> miss, slip
B front kick to body -> duck
A front kick to legs -> miss
B roundhouse to legs -> slip
A uppercut to body -> miss`
  for (const [a, b] of PAIRS) {
    it(`${a} vs ${b}`, () => {
      const fight = fightOf(MISSES)
      const fighters = pair(a, b)
      const { sol, ev } = stage(fight, fighters)
      expect(sol.report.beats).toHaveLength(6)
      const close: string[] = []
      for (const x of blows(fight, fighters, sol, ev)) {
        const dIn = fighters[x.beat.attacker === 0 ? 1 : 0]
        const gap = bodyGap(posed(dIn, x.d), new Vector3(x.point.x, x.point.y, x.point.z))
        if (gap < 0.1) close.push(`beat ${x.rep.index + 1} blow ${x.i + 1} (${x.outcome}): ${(gap * 100).toFixed(1)} cm`)
        expect(x.rep.clearanceM[x.i]!, `beat ${x.rep.index + 1} reported clearance`).toBeGreaterThanOrEqual(0.1)
      }
      expect(close).toEqual([])
    })
  }
})

describe('a shorter attacker reaches a taller head', () => {
  const CASES: [string, string, string][] = [
    ['person.man', 'person.woman', 'B elbow to head -> hit power 0.8'],
    ['person.mannequinMale', 'person.mannequinFemale', 'B elbow to head -> hit power 0.8'],
    ['person.mannequinMale', 'person.mannequinFemale', 'B haymaker to head -> hit power 1'],
    ['person.man', 'person.woman', 'A side kick to head -> hit power 1']
  ]
  for (const [a, b, script] of CASES) {
    it(`${script} (${a} vs ${b}): lands, or the warning stays`, () => {
      const { sol } = stage(fightOf(script), pair(a, b))
      const err = sol.report.beats[0]!.contactErrorM[0]!
      const warned = sol.report.warnings.some((w) => w.includes("can't reach"))
      expect(err <= 0.03 || warned).toBe(true)
      expect(warned).toBe(err > 0.03)
    })
  }

  it('the side kick to a shorter head lands within 3 cm, the mannequin elbows within 3.5 cm, the classic elbow within 8 cm', () => {
    const side = stage(fightOf('A side kick to head -> hit power 1'), pair('person.man', 'person.woman')).sol.report.beats[0]!
    expect(side.contactErrorM[0]!).toBeLessThanOrEqual(0.03)
    const elbowM = stage(fightOf('B elbow to head -> hit power 0.8'), pair('person.mannequinMale', 'person.mannequinFemale')).sol.report.beats[0]!
    expect(elbowM.contactErrorM[0]!).toBeLessThanOrEqual(0.035)
    const elbow = stage(fightOf('B elbow to head -> hit power 0.8'), pair('person.man', 'person.woman')).sol.report.beats[0]!
    expect(elbow.contactErrorM[0]!).toBeLessThanOrEqual(0.08)
  })

  it("the woman's body side kick on the man stays near the floor (it lifted her 45 cm at the chest)", () => {
    const { sol } = stage(fightOf('B side kick to body -> hit power 1'), pair('person.man', 'person.woman'))
    expect(sol.report.beats[0]!.contactErrorM[0]!).toBeLessThanOrEqual(0.03)
    expect(sol.report.beats[0]!.liftM[0]!).toBeLessThanOrEqual(0.1)
  })

  it('a blow that still can’t reach keeps its warning', () => {
    const { sol } = stage(fightOf('A sweep to head -> hit'), pair('person.man', 'person.woman'))
    expect(sol.report.beats[0]!.contactErrorM[0]!).toBeGreaterThan(0.03)
    expect(sol.report.warnings.some((w) => w.includes("can't reach"))).toBe(true)
  })
})
