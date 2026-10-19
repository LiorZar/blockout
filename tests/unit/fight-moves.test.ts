import { describe, expect, it } from 'vitest'
import { MOTION_PRESETS } from '@engine/motions'
import { DEFENSES, MOVE_ALIASES, REACTIONS, STRIKE_IDS, listFightMoves, strikeImpacts } from '@engine/fight/moves'

const ids = new Set(MOTION_PRESETS.map((m) => m.id))

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
