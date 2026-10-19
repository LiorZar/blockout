import { describe, expect, it } from 'vitest'
import { impact, snapAmplitude, snapCurve, type ImpactInput } from '@engine/fight/physics'
import { personDims } from '@engine/skeleton'

const MAN = personDims('person.man')
const g = 9.81

const base = (over: Partial<ImpactInput>): ImpactInput => ({
  moveId: 'jab-cross',
  effector: 'handR',
  speed: 8,
  power: 0.7,
  outcome: 'hit',
  defender: MAN,
  defenderBuild: 1,
  exaggeration: 1,
  ...over
})

/** The plan's formulas, restated for the expectations. */
function expected(me: number, speed: number, power: number, exaggeration: number, H = 1.78, build = 1) {
  const J = me * speed * power * 1.3
  const md = 72 * (H / 1.78) ** 2 * build
  const v0 = (exaggeration * J) / md
  const h = 0.55 * H
  const w = Math.sqrt(g / h)
  const xcp = v0 / w
  const s = H / 1.78
  const f = 0.12 * s
  const legLen = H * 0.47
  return { J, v0, w, h, xcp, f, legLen }
}

describe('impact', () => {
  it('a jab (hand, 8 m/s, power 0.7) on a 1.78 m man is absorb', () => {
    const r = impact(base({}))
    const e = expected(2.9, 8, 0.7, 1)
    expect(r.result).toBe('absorb')
    expect(r.impulse).toBeCloseTo(e.J, 9)
    expect(r.v0).toBeCloseTo(e.v0, 9)
    expect(r.capture).toBeCloseTo(e.xcp, 9)
    expect(r.capture).toBeLessThanOrEqual(e.f)
    expect(r.stepBack).toBe(0)
    expect(r.slide).toBe(0)
  })

  it('a haymaker (hand, 10 m/s, power 1, exaggeration 1.5) is stagger', () => {
    const r = impact(base({ moveId: 'haymaker', speed: 10, power: 1, exaggeration: 1.5 }))
    const e = expected(2.9, 10, 1, 1.5)
    expect(r.result).toBe('stagger')
    expect(r.stepBack).toBeCloseTo(e.xcp - e.f + 0.1, 9)
    expect(r.stepBack).toBeGreaterThan(0)
    expect(r.stepDuration).toBeCloseTo(0.25 + (0.4 * e.xcp) / (0.6 * e.legLen), 9)
    expect(r.fallDuration).toBe(0)
  })

  it('a spinning back kick (foot, 12 m/s, power 1, exaggeration 2) is knockdown', () => {
    const r = impact(base({ moveId: 'spinning-back-kick', effector: 'footR', speed: 12, power: 1, exaggeration: 2 }))
    const e = expected(6, 12, 1, 2)
    expect(r.result).toBe('knockdown')
    expect(r.slide).toBeCloseTo(Math.min(2.5, 1.2 * e.xcp), 9)
    const theta0 = Math.min(0.5, Math.max(0.05, e.v0 / (e.h * e.w)))
    expect(r.fallDuration).toBeCloseTo(Math.acosh(Math.PI / 2 / theta0) / e.w, 9)
    expect(r.fallDuration).toBeGreaterThanOrEqual(0.3)
    expect(r.fallDuration).toBeLessThanOrEqual(1.5)
  })

  it('uses the effective mass of the striking limb, and 20 kg for shoves and tackles', () => {
    expect(impact(base({ effector: 'elbowR', speed: 5, power: 1 })).impulse).toBeCloseTo(4 * 5 * 1.3, 9)
    expect(impact(base({ effector: 'kneeL', speed: 5, power: 1 })).impulse).toBeCloseTo(6 * 5 * 1.3, 9)
    expect(impact(base({ moveId: 'shove-two-hands', effector: 'handL', speed: 5, power: 1 })).impulse).toBeCloseTo(20 * 5 * 1.3, 9)
    expect(impact(base({ moveId: 'tackle-lunge', effector: 'handL', speed: 5, power: 1 })).impulse).toBeCloseTo(20 * 5 * 1.3, 9)
  })

  it('a block gives an impulse of exactly 0.35× the hit impulse', () => {
    const hit = impact(base({ speed: 10, power: 1 }))
    expect(impact(base({ speed: 10, power: 1, outcome: 'block' })).impulse).toBeCloseTo(0.35 * hit.impulse, 12)
    expect(impact(base({ speed: 10, power: 1, outcome: 'parry' })).impulse).toBeCloseTo(0.35 * hit.impulse, 12)
  })

  it('slip, duck and miss transfer nothing', () => {
    for (const outcome of ['slip', 'duck', 'miss'] as const) {
      const r = impact(base({ speed: 12, power: 1, outcome, exaggeration: 3 }))
      expect(r.result).toBe('none')
      expect(r.impulse).toBe(0)
      expect(r.v0).toBe(0)
    }
  })

  it('ko forces knockdown', () => {
    const r = impact(base({ outcome: 'ko' }))
    expect(r.result).toBe('knockdown')
    expect(r.slide).toBeGreaterThan(0)
    expect(r.fallDuration).toBeGreaterThan(0)
  })

  it('a heavier defender moves less', () => {
    const light = impact(base({ speed: 10, power: 1, defender: personDims('person.woman'), defenderBuild: 0.8 }))
    const heavy = impact(base({ speed: 10, power: 1, defender: personDims('person.man', { height: 1.2, build: 1.3 }), defenderBuild: 1.3 }))
    expect(heavy.v0).toBeLessThan(light.v0)
  })

  it('results are deterministic: identical calls give identical objects', () => {
    const input = base({ moveId: 'roundhouse-kick', effector: 'footR', speed: 9, power: 0.9, exaggeration: 2 })
    expect(impact(input)).toEqual(impact({ ...input }))
  })
})

describe('snap spring', () => {
  it('snapCurve starts at 0, its first peak is ≤ A, and it decays below 0.1·A by 0.6 s', () => {
    const A = 0.4
    const curve = snapCurve(A, 0.6, 15)
    expect(curve[0]).toEqual({ t: 0, value: 0 })
    expect(curve).toHaveLength(10)
    expect(curve[curve.length - 1]!.t).toBeCloseTo(0.6, 12)
    const peak = Math.max(...curve.map((p) => Math.abs(p.value)))
    expect(peak).toBeLessThanOrEqual(A)
    expect(Math.abs(curve[curve.length - 1]!.value)).toBeLessThan(0.1 * A)
    // Exact closed form.
    const wn = 14
    const zeta = 0.35
    const wd = wn * Math.sqrt(1 - zeta * zeta)
    for (const p of curve) expect(p.value).toBeCloseTo(A * Math.exp(-zeta * wn * p.t) * Math.sin(wd * p.t), 12)
  })

  it('snapAmplitude = clamp(0.012 · exaggeration · J, 0.05, 0.9)', () => {
    expect(snapAmplitude(20, 1.5)).toBeCloseTo(0.36, 12)
    expect(snapAmplitude(0.5, 1)).toBe(0.05)
    expect(snapAmplitude(500, 3)).toBe(0.9)
  })
})
