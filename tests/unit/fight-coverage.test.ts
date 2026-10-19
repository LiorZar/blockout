import { describe, expect, it } from 'vitest'
import { ASPECT_RATIOS } from '@engine/camera'
import { ShotEvaluator } from '@engine/evaluate'
import { fightCoverage, type CoverageMode } from '@engine/fight/coverage'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { createCameraMark, createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { CameraState, EntityState, FightDoc, V3 } from '@engine/types'

const FPS = 24
const SCRIPT = `A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1`

const FIGHTERS: [FighterInput, FighterInput] = [
  { entityId: 'ent_a', assetId: 'person.man', scale: 1, start: { x: -0.55, y: 0, z: -3 } },
  { entityId: 'ent_b', assetId: 'person.woman', scale: 1, start: { x: 0.55, y: 0, z: -3 } }
]

function fightOf(script: string, exaggeration = 1.5): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return { id: 'fight_c', name: 'Cover', fighterIds: ['ent_a', 'ent_b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: -3, heading: 0 }, beatGap: 0.35, exaggeration }
}

/** Stage the fight, apply the coverage marks to the shot camera, return an evaluator. */
function covered(mode: CoverageMode, lineSide: 1 | -1, script = SCRIPT, exaggeration = 1.5) {
  const fight = fightOf(script, exaggeration)
  const sol: FightSolution = solveFight(fight, FIGHTERS, { duration: 12, fps: FPS })
  const project = createProject('Cover')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = 12
  shot.fps = FPS
  FIGHTERS.forEach((f, q) => {
    const e = createEntity(f.assetId, f.entityId, { ...f.start })
    e.id = f.entityId
    scene.entities.push(e)
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${e.id}-${k}` })) })
  })
  const marks = fightCoverage(fight, sol.report, mode, lineSide)
  for (const m of marks) {
    const cm = createCameraMark({ x: 0, y: 1.6, z: 5 }, m.time, 0, 0, 35)
    cm.easeIn = m.easeIn
    cm.easeOut = m.easeOut
    cm.hold = m.hold
    cm.shot = m.shot
    shot.camera.marks.push(cm)
  }
  return { fight, sol, marks, ev: new ShotEvaluator(scene, shot) }
}

function project(p: V3, cam: CameraState): { x: number; y: number; depth: number } {
  const tanV = Math.tan(cam.vfov / 2)
  const tanH = tanV * ASPECT_RATIOS['16:9']
  const cp = Math.cos(cam.pan)
  const sp = Math.sin(cam.pan)
  const ct = Math.cos(cam.tilt)
  const st = Math.sin(cam.tilt)
  const cr = Math.cos(cam.roll)
  const sr = Math.sin(cam.roll)
  const rot = (v: V3): V3 => {
    const z1 = { x: v.x * cr - v.y * sr, y: v.x * sr + v.y * cr, z: v.z }
    const x1 = { x: z1.x, y: z1.y * ct - z1.z * st, z: z1.y * st + z1.z * ct }
    return { x: x1.x * cp + x1.z * sp, y: x1.y, z: -x1.x * sp + x1.z * cp }
  }
  const right = rot({ x: 1, y: 0, z: 0 })
  const up = rot({ x: 0, y: 1, z: 0 })
  const fwd = rot({ x: 0, y: 0, z: -1 })
  const d = { x: p.x - cam.position.x, y: p.y - cam.position.y, z: p.z - cam.position.z }
  const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
  const depth = dot(d, fwd)
  return { x: dot(d, right) / depth / tanH, y: dot(d, up) / depth / tanV, depth }
}

function head(es: EntityState, q: number): { centre: V3; top: V3 } {
  const dims = personDims(FIGHTERS[q]!.assetId)
  const c = toWorld(poseEffectors(dims, es.joints).head, es.position, es.heading, 1)
  return { centre: c, top: { x: c.x, y: c.y + dims.headR, z: c.z } }
}

const lineCross = (a: V3, b: V3, cam: V3): number => (b.x - a.x) * (cam.z - a.z) - (b.z - a.z) * (cam.x - a.x)

describe('fightCoverage', () => {
  it("master keeps both fighters' heads inside |NDC| ≤ 0.95 at every 1/24 s", () => {
    const { ev, sol, marks } = covered('master', 1)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.shot).toMatchObject({ size: 'WS', subjectIds: ['ent_a', 'ent_b'], side: 'line' })
    for (let k = 0; k / FPS <= sol.report.endT; k++) {
      const st = ev.evaluate(k / FPS)
      st.entities.forEach((e, q) => {
        for (const p of [head(e, q).centre, head(e, q).top]) {
          const n = project(p, st.camera)
          expect(n.depth, `t=${(k / FPS).toFixed(2)}`).toBeGreaterThan(0)
          expect(Math.abs(n.x), `t=${(k / FPS).toFixed(2)} x`).toBeLessThanOrEqual(0.95)
          expect(Math.abs(n.y), `t=${(k / FPS).toFixed(2)} y`).toBeLessThanOrEqual(0.95)
        }
      })
    }
  })

  it('punch-in arrives at MCU on the defender at each big impact', () => {
    // At ×3 the cross, the spinning back kick and the KO roundhouse are all big hits.
    const script = `A jab cross to head -> block, hit
A spinning back kick to body -> hit power 1
B roundhouse to head -> ko power 1`
    const { ev, sol, fight, marks } = covered('punch-in', 1, script, 3)
    const big = sol.report.beats.flatMap((b) =>
      b.impactTimes
        .map((t, i) => ({ t, ph: b.physics[i]!, outcome: fight.beats[b.index]!.outcomes.at(i - b.impactTimes.length) ?? 'block', defender: fight.beats[b.index]!.attacker === 0 ? 1 : 0 }))
        .filter((x) => x.ph.result === 'stagger' || x.ph.result === 'knockdown' || x.outcome === 'ko')
    )
    expect(big.length).toBeGreaterThanOrEqual(2)
    expect(marks.length).toBeGreaterThanOrEqual(3)
    for (const b of big) {
      const st = ev.evaluate(b.t)
      const n = project(head(st.entities[b.defender]!, b.defender).top, st.camera)
      expect(Math.abs(n.y - 0.92), `impact at ${b.t.toFixed(2)}`).toBeLessThanOrEqual(0.03)
      expect(Math.abs(n.x)).toBeLessThanOrEqual(0.05)
    }
  })

  for (const mode of ['master', 'punch-in', 'over-shoulder', 'follow'] as const) {
    for (const lineSide of [1, -1] as const) {
      it(`camera never crosses the fight line (${mode}, side ${lineSide})`, () => {
        const { ev, sol } = covered(mode, lineSide)
        for (let k = 0; k / FPS <= sol.report.endT; k++) {
          const st = ev.evaluate(k / FPS)
          const [a, b] = st.entities
          const c = lineCross(a!.position, b!.position, st.camera.position)
          expect(Math.sign(c), `t=${(k / FPS).toFixed(2)}`).toBe(lineSide)
        }
      })
    }
  }

  it("over-shoulder puts the camera behind the attacker's lineSide shoulder for each beat", () => {
    for (const lineSide of [1, -1] as const) {
      const { ev, sol, fight, marks } = covered('over-shoulder', lineSide)
      expect(marks).toHaveLength(sol.report.beats.length)
      for (const b of sol.report.beats) {
        const attacker = fight.beats[b.index]!.attacker
        const t = Math.max(0, b.startT - 0.3)
        const st = ev.evaluate(t)
        const atk = st.entities[attacker]!
        const def = st.entities[attacker === 0 ? 1 : 0]!
        const dims = personDims(FIGHTERS[attacker]!.assetId)
        const fx = poseEffectors(dims, atk.joints)
        const shoulders = [toWorld(fx.shoulderL, atk.position, atk.heading, 1), toWorld(fx.shoulderR, atk.position, atk.heading, 1)]
        const a = st.entities[0]!.position
        const bb = st.entities[1]!.position
        const onSide = shoulders.find((s) => Math.sign(lineCross(a, bb, s)) === lineSide)!
        const cam = st.camera.position
        expect(Math.hypot(cam.x - onSide.x, cam.y - onSide.y, cam.z - onSide.z), `beat ${b.index + 1}`).toBeLessThan(0.7)
        // Behind the attacker: farther from the defender than the attacker is.
        expect(Math.hypot(cam.x - def.position.x, cam.z - def.position.z)).toBeGreaterThan(Math.hypot(atk.position.x - def.position.x, atk.position.z - def.position.z))
        const m = marks.find((x) => Math.abs(x.time - t) < 1e-9)!
        expect(m.shot.over?.entityId).toBe(FIGHTERS[attacker]!.entityId)
        expect(m.shot.subjectIds).toEqual([FIGHTERS[attacker === 0 ? 1 : 0]!.entityId])
      }
    }
  })

  it("follow puts one MS mark on each beat's attacker", () => {
    const { sol, fight, marks } = covered('follow', 1)
    expect(marks).toHaveLength(sol.report.beats.length)
    sol.report.beats.forEach((b, k) => {
      const m = marks[k]!
      expect(m.time).toBeCloseTo(Math.max(0, b.startT - 0.2), 9)
      expect(m.shot.size).toBe('MS')
      expect(m.shot.subjectIds).toEqual([FIGHTERS[fight.beats[b.index]!.attacker]!.entityId])
    })
  })

  it('is deterministic and time-ordered', () => {
    for (const mode of ['master', 'punch-in', 'over-shoulder', 'follow'] as const) {
      const a = covered(mode, 1).marks
      expect(covered(mode, 1).marks).toEqual(a)
      for (let k = 1; k < a.length; k++) expect(a[k]!.time).toBeGreaterThan(a[k - 1]!.time)
    }
  })
})
