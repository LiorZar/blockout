/**
 * Closed-form impact physics (fork addition; see MODIFICATIONS.md). No
 * rigid-body simulation: every number is a deterministic formula, baked into
 * marks by the fight solver.
 *
 *   impulse  J  = m_e · speed · power · (1 + e)      (block / parry × 0.35)
 *   defender v0 = exaggeration · J / m_d,  m_d = 72 · (H/1.78)² · build
 *   capture  x  = v0 / ω,  ω = √(g / h),  h = 0.55 · H  (inverted pendulum)
 *   x ≤ foot half-length → absorb; x ≤ 0.6 · legLen → stagger; else knockdown,
 *   falling in acosh((π/2)/θ0)/ω. Head/torso snap: a damped spring.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { Effector, PersonDims } from '../skeleton'
import type { FightOutcome } from '../types'

export interface ImpactInput {
  moveId: string
  effector: Effector
  speed: number
  power: number
  outcome: FightOutcome
  defender: PersonDims
  defenderBuild: number
  exaggeration: number
}

export interface ImpactResult {
  impulse: number
  v0: number
  capture: number
  result: 'none' | 'absorb' | 'stagger' | 'knockdown'
  stepBack: number
  stepDuration: number
  slide: number
  fallDuration: number
}

const G = 9.81
const RESTITUTION = 0.3
const DEFENDED = 0.35
export const EFFECTIVE_MASS = { hand: 2.9, elbow: 4.0, foot: 6.0, knee: 6.0 } as const
/** Whole-body pushes put the attacker's mass behind the hands. */
const BODY_MOVES = new Set(['shove-two-hands', 'tackle-lunge'])
const BODY_MASS = 20

const SNAP_WN = 14
const SNAP_ZETA = 0.35

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function effectiveMass(moveId: string, effector: Effector): number {
  if (BODY_MOVES.has(moveId)) return BODY_MASS
  if (effector.startsWith('elbow')) return EFFECTIVE_MASS.elbow
  if (effector.startsWith('foot')) return EFFECTIVE_MASS.foot
  if (effector.startsWith('knee')) return EFFECTIVE_MASS.knee
  return EFFECTIVE_MASS.hand
}

export function impact(input: ImpactInput): ImpactResult {
  const none: ImpactResult = {
    impulse: 0,
    v0: 0,
    capture: 0,
    result: 'none',
    stepBack: 0,
    stepDuration: 0,
    slide: 0,
    fallDuration: 0
  }
  if (input.outcome === 'slip' || input.outcome === 'duck' || input.outcome === 'miss') return none

  const d = input.defender
  let J = effectiveMass(input.moveId, input.effector) * input.speed * input.power * (1 + RESTITUTION)
  if (input.outcome === 'block' || input.outcome === 'parry') J *= DEFENDED
  const md = 72 * (d.H / 1.78) ** 2 * input.defenderBuild
  const v0 = (input.exaggeration * J) / md
  const h = 0.55 * d.H
  const w = Math.sqrt(G / h)
  const capture = v0 / w
  const foot = 0.12 * d.s
  const stepLimit = 0.6 * d.legLen

  const base = { ...none, impulse: J, v0, capture }
  if (input.outcome !== 'ko' && capture <= foot) return { ...base, result: 'absorb' }
  if (input.outcome !== 'ko' && capture <= stepLimit) {
    return {
      ...base,
      result: 'stagger',
      stepBack: capture - foot + 0.1,
      stepDuration: 0.25 + (0.4 * capture) / stepLimit
    }
  }
  const theta0 = clamp(v0 / (h * w), 0.05, 0.5)
  return {
    ...base,
    result: 'knockdown',
    slide: Math.min(2.5, 1.2 * capture),
    fallDuration: Math.acosh(Math.PI / 2 / theta0) / w
  }
}

/** Damped-spring head/torso snap θ(t) = A·e^(−ζωn t)·sin(ωd t), sampled from t = 0. */
export function snapCurve(amplitude: number, durationS: number, sampleHz: number): { t: number; value: number }[] {
  const wd = SNAP_WN * Math.sqrt(1 - SNAP_ZETA * SNAP_ZETA)
  const n = Math.floor(durationS * sampleHz + 1e-9)
  const out: { t: number; value: number }[] = []
  for (let k = 0; k <= n; k++) {
    const t = k / sampleHz
    out.push({ t, value: amplitude * Math.exp(-SNAP_ZETA * SNAP_WN * t) * Math.sin(wd * t) })
  }
  return out
}

export function snapAmplitude(impulse: number, exaggeration: number): number {
  return clamp(0.012 * exaggeration * impulse, 0.05, 0.9)
}
