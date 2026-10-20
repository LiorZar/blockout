import { describe, expect, it } from 'vitest'
import { MOTION_PRESETS } from '@engine/motions'
import { DEFENSES, MOVE_ALIASES, REACTIONS, STRIKE_IDS, fightMotion, listFightMoves, strikeImpacts } from '@engine/fight/moves'
import { parseFightScript } from '@engine/fight/script'
import { solveFight } from '@engine/fight/solve'
import { personDims, poseEffectors } from '@engine/skeleton'
import type { FightDoc } from '@engine/types'

const ids = new Set(MOTION_PRESETS.map((m) => m.id))

describe('fork replacements play under the upstream move ids', () => {
  const REF = personDims('person.man')

  for (const [id, fork, effector] of [
    ['haymaker', 'haymaker-swing', 'handR'],
    ['elbow-strike', 'elbow-strike-across', 'elbowR']
  ] as const) {
    it(`${id} plays ${fork}: the wind-up turns the striking shoulder back, the blow comes after it and lands in front`, () => {
      const m = fightMotion(id)!
      expect(m.id).toBe(fork)
      expect(ids.has(fork)).toBe(true)
      const imp = strikeImpacts(id)
      expect(imp.map((i) => i.effector)).toEqual([effector])
      const k = m.keyframes
      const fx = k.map((kf) => poseEffectors(REF, kf.joints))
      const i = k.findIndex((kf) => Math.abs(kf.t - imp[0]!.t) < 1e-9)
      // Wind-up: the keyframe before the blow where the striking shoulder is furthest back.
      const before = fx.slice(1, i).map((f) => f.shoulderR.z)
      const w = 1 + before.indexOf(Math.max(...before))
      expect(w, 'a wind-up keyframe').toBeGreaterThanOrEqual(1)
      expect(k[w]!.t).toBeLessThan(imp[0]!.t)
      expect(fx[w]!.shoulderR.z - fx[0]!.shoulderR.z, 'wind-up turns the striking shoulder back').toBeGreaterThan(0.05)
      expect(fx[i]!.shoulderR.z - fx[0]!.shoulderR.z, 'the blow turns it forward').toBeLessThan(-0.05)
      // The blow lands in front of the body, near the centreline.
      expect(fx[i]![effector].z - fx[i]!.shoulderR.z).toBeLessThan(-0.2)
      expect(Math.abs(fx[i]![effector].x)).toBeLessThan(0.3)
      // Same length, so random fights keep their timing.
      expect(m.duration).toBe(MOTION_PRESETS.find((p) => p.id === id)!.duration)
    })
  }

  it('sword-slash-combo plays sword-slash-two-hand: both hands on the grip (≤ 0.15 m) on every body, two right-hand slashes', () => {
    const m = fightMotion('sword-slash-combo')!
    expect(m.id).toBe('sword-slash-two-hand')
    expect(m.duration).toBe(MOTION_PRESETS.find((p) => p.id === 'sword-slash-combo')!.duration)
    for (const body of ['person.man', 'person.woman', 'person.mannequinMale', 'person.mannequinFemale', 'person.child', 'person.elderly']) {
      const dims = personDims(body)
      for (const kf of m.keyframes) {
        const fx = poseEffectors(dims, kf.joints)
        const gap = Math.hypot(fx.handL.x - fx.handR.x, fx.handL.y - fx.handR.y, fx.handL.z - fx.handR.z)
        expect(gap, `${body} t=${kf.t}`).toBeLessThanOrEqual(0.15)
      }
    }
    const imp = strikeImpacts('sword-slash-combo')
    expect(imp.map((i) => i.effector)).toEqual(['handR', 'handR'])
    expect(imp.map((i) => i.t)).toEqual([0.4, 1.1])
    // Each slash comes after its wind-up: the torso turns into the blow.
    const ty = (t: number): number => m.keyframes.find((kf) => kf.t === t)!.joints.torsoY!
    expect(ty(0)).toBeLessThan(0)
    expect(ty(0.4)).toBeGreaterThan(0)
    expect(ty(0.7)).toBeGreaterThan(0)
    expect(ty(1.1)).toBeLessThan(0)
  })

  it('the fight solver plays the fork keyframes: a haymaker lands on its swing, within 3 cm', () => {
    const r = parseFightScript('A haymaker to head -> hit\nB elbow to body -> hit', ['A', 'B'])
    if ('error' in r) throw new Error(r.error)
    expect(r.beats.map((b) => b.move)).toEqual(['haymaker', 'elbow-strike'])
    const fight: FightDoc = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: r.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
    const sol = solveFight(fight, [
      { entityId: 'a', assetId: 'person.man', scale: 1, start: { x: -0.55, y: 0, z: 0 } },
      { entityId: 'b', assetId: 'person.woman', scale: 1, start: { x: 0.55, y: 0, z: 0 } }
    ], { duration: 12, fps: 24 })
    expect(sol.report.beats, sol.report.warnings.join('; ')).toHaveLength(2)
    sol.report.beats.forEach((b, q) => {
      expect(b.contactErrorM[0]).toBeLessThanOrEqual(0.03)
      const id = q === 0 ? 'haymaker' : 'elbow-strike'
      const mark = sol.tracks[q]!.find((m) => Math.abs(m.time - b.impactTimes[0]!) < 1e-9)!
      const fork = fightMotion(id)!.keyframes.find((kf) => Math.abs(kf.t - strikeImpacts(id)[0]!.t) < 1e-9)!
      expect(mark.joints!.torsoY, id).toBeCloseTo(fork.joints.torsoY!, 9)
    })
  })

  it('upstream motion data is untouched, and the fork motions are not listed as separate strikes', () => {
    expect(MOTION_PRESETS.find((m) => m.id === 'haymaker')!.keyframes[1]!.joints.torsoY).toBe(0.8)
    expect(MOTION_PRESETS.find((m) => m.id === 'elbow-strike')!.keyframes[1]!.joints.torsoY).toBe(0.5)
    expect(fightMotion('jab-cross')).toBe(MOTION_PRESETS.find((m) => m.id === 'jab-cross'))
    for (const fork of ['haymaker-swing', 'elbow-strike-across']) expect(STRIKE_IDS).not.toContain(fork)
  })
})

describe('strikeImpacts', () => {
  it('jab-cross has two hand impacts, rear hand first (the motion fires the right cross at 0.3 s, then the left)', () => {
    const imp = strikeImpacts('jab-cross')
    expect(imp.map((i) => i.effector)).toEqual(['handR', 'handL'])
    expect(imp[0]!.t).toBeCloseTo(0.3, 9)
    expect(imp[1]!.t).toBeCloseTo(0.9, 9)
  })

  it('front-kick has one foot impact', () => {
    const imp = strikeImpacts('front-kick')
    expect(imp).toHaveLength(1)
    expect(imp[0]!.effector).toBe('footR')
    expect(imp[0]!.t).toBeCloseTo(0.55, 9)
  })

  it('hook-punch, haymaker and uppercut each have exactly one hand impact', () => {
    for (const id of ['hook-punch', 'haymaker', 'uppercut']) {
      const imp = strikeImpacts(id)
      expect(imp, id).toHaveLength(1)
      expect(imp[0]!.effector, id).toMatch(/^hand[LR]$/)
    }
    expect(strikeImpacts('hook-punch')[0]!.effector).toBe('handL')
    expect(strikeImpacts('uppercut')[0]!.t).toBeCloseTo(0.6, 9)
  })

  it('knee and elbow strikes hit with the knee and the elbow', () => {
    expect(strikeImpacts('knee-strike').map((i) => i.effector)).toEqual(['kneeR'])
    expect(strikeImpacts('elbow-strike').map((i) => i.effector)).toEqual(['elbowR'])
  })

  it('a lunge strikes with the hand, not the stepping foot', () => {
    for (const id of ['sword-thrust', 'knife-lunge']) {
      for (const i of strikeImpacts(id)) expect(i.effector, id).toMatch(/^hand/)
    }
  })

  it('every STRIKE_ID has ≥ 1 impact and every impact speed is in [2, 15]', () => {
    expect(STRIKE_IDS.length).toBeGreaterThan(10)
    for (const id of STRIKE_IDS) {
      const imp = strikeImpacts(id)
      expect(imp.length, id).toBeGreaterThanOrEqual(1)
      for (let k = 0; k < imp.length; k++) {
        expect(imp[k]!.speed, id).toBeGreaterThanOrEqual(2)
        expect(imp[k]!.speed, id).toBeLessThanOrEqual(15)
        if (k > 0) expect(imp[k]!.t - imp[k - 1]!.t, id).toBeGreaterThanOrEqual(0.15 - 1e-9)
      }
    }
  })

  it('STRIKE_IDS are fight motions and exclude defenses, reactions and ranged weapons', () => {
    const fight = new Set(MOTION_PRESETS.filter((m) => m.category === 'fight').map((m) => m.id))
    const excluded = new Set([
      ...Object.values(DEFENSES).flatMap((d) => [d.high, d.low]),
      ...Object.values(REACTIONS),
      'pistol-aim-fire',
      'rifle-aim-sweep',
      'bow-draw-loose'
    ])
    for (const id of STRIKE_IDS) {
      expect(fight.has(id), id).toBe(true)
      expect(excluded.has(id), id).toBe(false)
    }
    for (const id of ['jab-cross', 'hook-punch', 'haymaker', 'uppercut', 'front-kick', 'roundhouse-kick', 'knee-strike', 'elbow-strike', 'side-kick', 'spinning-back-kick', 'low-sweep', 'shove-two-hands', 'tackle-lunge']) {
      expect(STRIKE_IDS, id).toContain(id)
    }
  })

  it('is memoised and returns [] for unknown or non-strike motions', () => {
    expect(strikeImpacts('jab-cross')).toBe(strikeImpacts('jab-cross'))
    expect(strikeImpacts('moonwalk')).toEqual([])
    expect(strikeImpacts('boxing-guard-bounce')).toEqual([])
  })
})

describe('duplicate strikes', () => {
  it('the fight catalog lists spinning-backfist once; spinning-back-fist stays an alias of it', () => {
    expect(STRIKE_IDS).toContain('spinning-backfist')
    expect(STRIKE_IDS).not.toContain('spinning-back-fist')
    expect(listFightMoves().filter((m) => /spinning.?back.?fist/.test(m.id)).map((m) => m.id)).toEqual(['spinning-backfist'])
    expect(MOVE_ALIASES['spinning-back-fist']).toBe('spinning-backfist')
    for (const text of ['A spinning back fist to head -> hit', 'A spinning-back-fist to head -> hit', 'A spinning backfist to head -> hit']) {
      const r = parseFightScript(text, ['A', 'B'])
      if ('error' in r) throw new Error(r.error)
      expect(r.beats[0]!.move, text).toBe('spinning-backfist')
    }
    // A saved beat with the old id plays the kept move.
    expect(strikeImpacts('spinning-back-fist')).toEqual(strikeImpacts('spinning-backfist'))
    expect(fightMotion('spinning-back-fist')!.id).toBe('spinning-backfist')
    const fight: FightDoc = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: [{ attacker: 0, move: 'spinning-back-fist', target: 'head', outcomes: ['hit'], power: 0.7 }], startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
    const sol = solveFight(fight, [
      { entityId: 'a', assetId: 'person.man', scale: 1, start: { x: -0.55, y: 0, z: 0 } },
      { entityId: 'b', assetId: 'person.man', scale: 1, start: { x: 0.55, y: 0, z: 0 } }
    ], { duration: 6, fps: 24 })
    expect(sol.report.beats, sol.report.warnings.join('; ')).toHaveLength(1)
    expect(sol.report.beats[0]!.contactErrorM[0]).toBeLessThanOrEqual(0.03)
  })
})

describe('move tables', () => {
  it('every alias and every DEFENSES/REACTIONS id exists in MOTION_PRESETS', () => {
    for (const [alias, id] of Object.entries(MOVE_ALIASES)) expect(ids.has(id), `${alias} → ${id}`).toBe(true)
    for (const d of Object.values(DEFENSES)) {
      expect(ids.has(d.high), d.high).toBe(true)
      expect(ids.has(d.low), d.low).toBe(true)
      expect(d.readyFraction).toBeGreaterThan(0)
      expect(d.readyFraction).toBeLessThan(1)
    }
    for (const id of Object.values(REACTIONS)) expect(ids.has(id), id).toBe(true)
    expect(MOVE_ALIASES['jab cross']).toBe('jab-cross')
    expect(MOVE_ALIASES.roundhouse).toBe('roundhouse-kick')
    expect(DEFENSES.block).toEqual({ high: 'block-high', low: 'block-low', readyFraction: 0.4 })
  })

  it('listFightMoves lists every strike with its name and impacts', () => {
    const list = listFightMoves()
    expect(list.map((m) => m.id)).toEqual(STRIKE_IDS)
    const jab = list.find((m) => m.id === 'jab-cross')!
    expect(jab.name).toBe('Jab / Cross')
    expect(jab.impacts).toHaveLength(2)
  })
})
