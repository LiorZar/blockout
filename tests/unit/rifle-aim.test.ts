import { describe, expect, it } from 'vitest'
import { mirrorJoints } from '@engine/choreography'
import { ShotEvaluator } from '@engine/evaluate'
import { listShotMoves, SHOT_MOVES, shotImpacts, STRIKE_IDS } from '@engine/fight/moves'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import { MOTION_PRESETS } from '@engine/motions'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import type { EntityState, FightDoc, V3 } from '@engine/types'
import { aimDirectionLocal, handFrame, heldPointLocal, holdJoints, SUPPORT_SLACK, supportReach, weaponSpec, type Hand } from '@engine/weapons'

const LONG_GUNS = ['prop.rifle', 'prop.shotgun']
const BODIES = ['person.man', 'person.woman', 'person.mannequinMale', 'person.mannequinFemale', 'person.child', 'person.elderly']
const RIFLE_AIM = MOTION_PRESETS.find((m) => m.id === 'rifle-aim-fire')

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z)
const deg = (rad: number): number => (rad * 180) / Math.PI

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('shouldered long guns', () => {
  it('have a stock point, and the stock (not the grip line) rides the shoulder line while the hand is up (carried below 45°)', () => {
    const rnd = rng(5)
    const keys = ['shoulderLX', 'shoulderRX', 'shoulderLZ', 'shoulderRZ', 'elbowL', 'elbowR', 'torsoX', 'torsoY', 'torsoZ']
    let checked = 0
    for (const id of LONG_GUNS) {
      const spec = weaponSpec(id)!
      expect(spec.mount, id).toBe('shoulder')
      expect(spec.stock, id).toBeDefined()
      const stockLen = len(sub(spec.stock!, spec.grip))
      for (const body of BODIES) {
        const dims = personDims(body)
        for (let n = 0; n < 12; n++) {
          const joints = Object.fromEntries(keys.map((k) => [k, (rnd() - 0.5) * 2.4]))
          for (const hand of ['L', 'R'] as Hand[]) {
            const f = handFrame(dims, joints, hand)
            const reach = len(sub(f.shoulder, f.p))
            // Fork: a hand far below the shoulder carries the gun (weapons-carry.test.ts).
            if (reach < 0.1 || deg(Math.asin((f.shoulder.y - f.p.y) / reach)) > 45) continue
            const butt = heldPointLocal(dims, joints, hand, spec, spec.stock!, 1)
            const onLine = { x: f.p.x + ((f.shoulder.x - f.p.x) * stockLen) / reach, y: f.p.y + ((f.shoulder.y - f.p.y) * stockLen) / reach, z: f.p.z + ((f.shoulder.z - f.p.z) * stockLen) / reach }
            expect(len(sub(butt, onLine)), `${id} ${body} ${hand}`).toBeLessThan(1e-9)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })
})

describe('rifle-aim-fire', () => {
  it('is a fork fight motion that gun beats fire, not a melee strike', () => {
    expect(RIFLE_AIM).toBeDefined()
    expect(RIFLE_AIM!.category).toBe('fight')
    expect(SHOT_MOVES.has('rifle-aim-fire')).toBe(true)
    expect(STRIKE_IDS).not.toContain('rifle-aim-fire')
    expect(shotImpacts('rifle-aim-fire', 'R')).toHaveLength(1)
  })

  it('aims, holds, fires, kicks the muzzle up in recoil, and recovers', () => {
    const k = RIFLE_AIM!.keyframes
    const shot = shotImpacts('rifle-aim-fire', 'R')[0]!
    const i = k.findIndex((kf) => kf.t === shot.t)
    expect(i).toBeGreaterThan(1)
    // The aim is held from the mount to the shot.
    expect(k[i - 1]!.joints).toEqual(k[i]!.joints)
    expect(shot.t - k[i - 1]!.t).toBeGreaterThanOrEqual(0.2)
    const dims = personDims('person.man')
    const spec = weaponSpec('prop.rifle')!
    const pitch = (j: Record<string, number>): number => {
      const d = aimDirectionLocal(dims, holdJoints(dims, j, [{ spec, hand: 'R', scale: 1 }]), 'R', spec)
      return Math.asin(d.y)
    }
    expect(deg(pitch(k[i + 1]!.joints) - pitch(k[i]!.joints))).toBeGreaterThanOrEqual(3)
    // Recovery: back on target after the recoil.
    expect(k.slice(i + 2).some((kf) => JSON.stringify(kf.joints) === JSON.stringify(k[i]!.joints))).toBe(true)
  })

  for (const id of LONG_GUNS) {
    for (const hand of ['R', 'L'] as Hand[]) {
      it(`${id} in the ${hand} hand at the aim keyframe: barrel level and forward, stock in the shoulder, support hand on the fore-end`, () => {
        const shot = shotImpacts('rifle-aim-fire', 'R')[0]!
        const aim = RIFLE_AIM!.keyframes.find((kf) => kf.t === shot.t)!.joints
        const joints = hand === 'R' ? aim : mirrorJoints(aim)
        const spec = weaponSpec(id)!
        const off: Hand = hand === 'R' ? 'L' : 'R'
        for (const body of BODIES) {
          const dims = personDims(body)
          const held = holdJoints(dims, joints, [{ spec, hand, scale: 1 }])
          const dir = aimDirectionLocal(dims, held, hand, spec)
          const off3 = deg(Math.acos(Math.min(1, -dir.z)))
          expect(off3, `${body} barrel off forward (deg)`).toBeLessThanOrEqual(3)
          const butt = heldPointLocal(dims, held, hand, spec, spec.stock!, 1)
          const shoulder = poseEffectors(dims, held)[hand === 'R' ? 'shoulderR' : 'shoulderL']
          expect(len(sub(butt, shoulder)), `${body} stock to shoulder`).toBeLessThanOrEqual(0.06)
          // The support hand closes on the fore-end: on the support point, or slid back along the gun
          // (at most halfway to the grip) when the arm can't reach it, and then reported.
          const reach = supportReach(dims, held, hand, spec, 1)
          expect(len(sub(handFrame(dims, held, off).p, reach.point)), `${body} support hand`).toBeLessThanOrEqual(0.01)
          expect(reach.shortM, `${body} support hand short`).toBeLessThanOrEqual(0.01)
          expect(reach.slideM, `${body} slide`).toBeLessThanOrEqual(len(sub(spec.grip, spec.support!)) / 2 + 1e-9)
          if (body !== 'person.child') expect(reach.slideM, `${body} slide`).toBeLessThanOrEqual(SUPPORT_SLACK)
          else expect(reach.slideM, 'a child slides the support hand back').toBeGreaterThan(SUPPORT_SLACK)
          // Upright: the gun's top within 10° of straight up.
          const top = sub(heldPointLocal(dims, held, hand, spec, { ...spec.grip, y: spec.grip.y + 1 }, 1), heldPointLocal(dims, held, hand, spec, spec.grip, 1))
          expect(deg(Math.acos(Math.min(1, top.y))), `${body} cant`).toBeLessThanOrEqual(10)
        }
      })
    }
  }
})

/* --------------------------------- gun beats -------------------------------- */

const FPS = 24
type Arms = { assetId: string; hand: Hand; scale: number }

function fightOf(script: string): FightDoc {
  const r = parseFightScript(script, ['A', 'B'])
  if ('error' in r) throw new Error(r.error)
  return { id: 'fight_r', name: 'Rifle', fighterIds: ['ent_a', 'ent_b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}

function gunFight(script: string, gun: Arms, attacker = 'person.man'): { fighters: [FighterInput, FighterInput]; sol: ReturnType<typeof solveFight>; ev: ShotEvaluator } {
  const fighters: [FighterInput, FighterInput] = [
    { entityId: 'ent_a', assetId: attacker, scale: 1, start: { x: -2, y: 0, z: 0 }, weapons: [gun] },
    { entityId: 'ent_b', assetId: 'person.woman', scale: 1, start: { x: 2, y: 0, z: 0 } }
  ]
  const sol = solveFight(fightOf(script), fighters, { duration: 10, fps: FPS })
  const project = createProject('Rifle')
  const scene = project.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = 10
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
  return { fighters, sol, ev: new ShotEvaluator(scene, shot) }
}

/** Distance from the defender's body target to the attacker's barrel line at the shot, from evaluated states. */
function barrelMiss(a: EntityState, d: EntityState, fighters: [FighterInput, FighterInput], gun: Arms): number {
  const spec = weaponSpec(gun.assetId)!
  const dims = personDims(fighters[0].assetId)
  const muzzle = toWorld(heldPointLocal(dims, a.joints, gun.hand, spec, spec.tip, 1), a.position, a.heading, 1)
  const dl = aimDirectionLocal(dims, a.joints, gun.hand, spec)
  const c = Math.cos(a.heading)
  const s = Math.sin(a.heading)
  const dir = { x: dl.x * c + dl.z * s, y: dl.y, z: -dl.x * s + dl.z * c }
  const dDims = personDims('person.woman')
  const l = Math.hypot(a.position.x - d.position.x, a.position.z - d.position.z)
  const chest = toWorld(poseEffectors(dDims, d.joints).chest, d.position, d.heading, 1)
  const k = (0.3 * dDims.bodyW) / l
  const target = { x: chest.x + (a.position.x - d.position.x) * k, y: chest.y, z: chest.z + (a.position.z - d.position.z) * k }
  const v = sub(target, muzzle)
  const along = v.x * dir.x + v.y * dir.y + v.z * dir.z
  expect(along).toBeGreaterThan(1)
  return Math.hypot(v.x - dir.x * along, v.y - dir.y * along, v.z - dir.z * along)
}

describe('gun beats pick the aim from the gun', () => {
  const aimTorsoY = RIFLE_AIM!.keyframes.find((kf) => kf.t === shotImpacts('rifle-aim-fire', 'R')[0]!.t)!.joints.torsoY!

  for (const [assetId, hand, attacker] of [
    ['prop.rifle', 'R', 'person.man'],
    ['prop.shotgun', 'R', 'person.mannequinMale'],
    ['prop.rifle', 'L', 'person.mannequinFemale'],
    ['prop.rifle', 'R', 'person.elderly'],
    ['prop.shotgun', 'L', 'person.child'],
    ['prop.rifle', 'R', 'person.woman']
  ] as [string, Hand, string][]) {
    it(`${assetId} in the ${hand} hand (${attacker}): a shouldered aim, the barrel line through the target within 3 cm`, () => {
      const gun = { assetId, hand, scale: 1 }
      const { fighters, sol, ev } = gunFight('A shoot to body -> hit', gun, attacker)
      const rep = sol.report.beats[0]!
      expect(rep, sol.report.warnings.join('; ')).toBeDefined()
      expect(rep.contactErrorM[0]).toBeLessThanOrEqual(0.03)
      const T = rep.impactTimes[0]!
      const st = ev.evaluate(T)
      const a = st.entities.find((e) => e.entityId === 'ent_a')!
      const d = st.entities.find((e) => e.entityId === 'ent_b')!
      expect(barrelMiss(a, d, fighters, gun)).toBeLessThanOrEqual(0.03)
      // The shouldered aim (mirrored for the left hand), not the pistol's arms-out aim.
      const mark = sol.tracks[0].find((m) => Math.abs(m.time - T) < 1e-9)!
      expect(mark.joints!.torsoY).toBeCloseTo(hand === 'R' ? aimTorsoY : -aimTorsoY, 9)
      const spec = weaponSpec(assetId)!
      const dims = personDims(attacker)
      const butt = heldPointLocal(dims, a.joints, hand, spec, spec.stock!, 1)
      expect(len(sub(butt, poseEffectors(dims, a.joints)[hand === 'R' ? 'shoulderR' : 'shoulderL']))).toBeLessThanOrEqual(0.06)
      // A body that can't reach the fore-end gets a report line.
      const slid = supportReach(dims, a.joints, hand, spec, 1).slideM > SUPPORT_SLACK
      expect(rep.warnings.some((w) => w.includes('fore-end')), rep.warnings.join('; ')).toBe(slid)
      expect(slid).toBe(attacker === 'person.child')
    })
  }

  it('a pistol keeps pistol-aim-fire', () => {
    const pistolAim = MOTION_PRESETS.find((m) => m.id === 'pistol-aim-fire')!
    const { sol } = gunFight('A shoot to body -> hit', { assetId: 'prop.pistol', hand: 'R', scale: 1 })
    const T = sol.report.beats[0]!.impactTimes[0]!
    const mark = sol.tracks[0].find((m) => Math.abs(m.time - T) < 1e-9)!
    const kf = pistolAim.keyframes.find((k) => k.t === shotImpacts('pistol-aim-fire', 'R')[0]!.t)!
    expect(mark.joints!.torsoY).toBeCloseTo(kf.joints.torsoY!, 9)
  })

  it('list_fight_moves names the guns each aim is for', () => {
    const shots = listShotMoves()
    expect(shots.find((m) => m.id === 'rifle-aim-fire')?.guns).toEqual(['prop.rifle', 'prop.shotgun'])
    expect(shots.find((m) => m.id === 'pistol-aim-fire')?.guns).toEqual(['prop.pistol'])
  })
})
