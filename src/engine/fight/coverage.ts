/**
 * Fight coverage (fork addition; see MODIFICATIONS.md): beat-aware camera
 * marks built from live shot words, all on one side of the A–B fight line so
 * the camera never crosses it.
 *
 *   master         one wide two-shot, side-on to the line
 *   punch-in       a medium two-shot that pushes in to an MCU on the defender
 *                  for every big hit (stagger, knockdown, KO) and back out
 *   over-shoulder  per beat, an MCU on the defender over the attacker's
 *                  shoulder on the camera's side of the line
 *   follow         per beat, a medium on the attacker (the store adds a
 *                  handheld rig)
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { ShotSpec } from '../shot'
import type { FightDoc } from '../types'
import type { FightSolution } from './solve'

export type CoverageMode = NonNullable<FightDoc['coverage']>

export interface CoverageMark {
  time: number
  shot: ShotSpec
  easeIn: number
  easeOut: number
  hold: number
}

/** Seconds a cut-free move takes between two coverage framings. */
const MOVE_S = 0.4
const MIN_GAP = 0.05

export function fightCoverage(
  fight: FightDoc,
  report: FightSolution['report'],
  mode: CoverageMode,
  lineSide: 1 | -1
): CoverageMark[] {
  const [a, b] = fight.fighterIds
  const line = { side: 'line' as const, lineIds: [a, b] as [string, string], lineSide }
  const two = (size: ShotSpec['size']): ShotSpec => ({ size, subjectIds: [a, b], ...line })
  const out: CoverageMark[] = []
  const push = (time: number, shot: ShotSpec, easeIn = 0.3, easeOut = 0.3): void => {
    const t = Math.max(0, time)
    const prev = out[out.length - 1]
    if (prev && t < prev.time + MIN_GAP) return
    // Hold the previous framing until a short move into this one.
    if (prev) prev.hold = Math.max(0, t - MOVE_S - prev.time)
    out.push({ time: t, shot, easeIn, easeOut, hold: 0 })
  }
  const attackerOf = (index: number): 0 | 1 => fight.beats[index]!.attacker

  if (mode === 'master') {
    push(fight.startT - 0.3, two('WS'))
    return out
  }

  if (mode === 'punch-in') {
    const big: { t: number; defender: string }[] = []
    for (const beat of report.beats) {
      const doc = fight.beats[beat.index]!
      const n = beat.impactTimes.length
      beat.impactTimes.forEach((t, i) => {
        const outcome = doc.outcomes[doc.outcomes.length - n + i]
        const ph = beat.physics[i]!
        if (ph.result === 'stagger' || ph.result === 'knockdown' || outcome === 'ko') {
          big.push({ t, defender: fight.fighterIds[doc.attacker === 0 ? 1 : 0] })
        }
      })
    }
    push(0, two('MS'))
    big.forEach((hit, k) => {
      push(hit.t - 0.2, { size: 'MCU', subjectIds: [hit.defender], ...line }, 0.6, 0.3)
      const next = big[k + 1]
      if (!next || next.t - 0.2 > hit.t + 0.7) push(hit.t + 0.7, two('MS'))
    })
    return out
  }

  for (const beat of report.beats) {
    const attacker = attackerOf(beat.index)
    const atkId = fight.fighterIds[attacker]
    const defId = fight.fighterIds[attacker === 0 ? 1 : 0]
    if (mode === 'over-shoulder') {
      // A faces along A→B, so its right shoulder is on side +1; B's is on side −1.
      const shoulder = (attacker === 0) === (lineSide === 1) ? 'right' : 'left'
      push(beat.startT - 0.3, { size: 'MCU', subjectIds: [defId], over: { entityId: atkId, shoulder }, ...line })
    }
    else push(beat.startT - 0.2, { size: 'MS', subjectIds: [atkId], ...line })
  }
  return out
}
