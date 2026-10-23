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
 * Weapons and falls (fork, qa-clara bug 3): with `reach` (each fighter's
 * longest weapon, grip to business end) the framing opens up so the weapons
 * stay in frame, and a defender who goes down is seen whole, never as a
 * close-up of a body on the floor. A shoulder a metre from the defender
 * can't frame more than an MCU over it, so an over-shoulder beat that needs
 * more becomes a two-shot on the camera's side of the line: full (FS) for a
 * fall or a short weapon (axe, bat), wide (WS) for a sword, katana, spear or
 * long gun; a fall is always a WS two-shot, which holds both fighters whole
 * (a two-shot is fitted to the bodies, not the flung limbs, so FS clips
 * them). Punch-in still pushes in on an armed hit (to an MS two-shot, which
 * holds the weapon and the target) and widens only for a fall.
 *
 * Showing the blow (fork, qa-fight bug 10): each beat's framing is sized to
 * its target (head MCU, body MS, legs FS); over-the-shoulder sits high so
 * the attacker's guard stays under the defender's face; follow is a
 * handheld two-shot led by the attacker.
 *
 * Clear views (fork, fix-camera-set): with `clear`, every framing is given a
 * clear view of the set and cast over the time it drives (camera-clear.ts).
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { ShotSpec } from '../shot'
import type { FightBeat, FightDoc } from '../types'
import type { FightSolution } from './solve'

export type CoverageMode = NonNullable<FightDoc['coverage']>

export interface CoverageMark {
  time: number
  shot: ShotSpec
  easeIn: number
  easeOut: number
  hold: number
}

export interface CoverageOptions {
  /** Each fighter's longest held weapon, grip to business end (m); 0 unarmed. */
  reach?: [number, number]
  /** Gives a framing a clear view over [its time, the next framing's time] (the store passes camera-clear.ts's). */
  clear?: (shot: ShotSpec, span: [number, number]) => ShotSpec
}

/** Weapon reach class: 0 unarmed (or a knife, pistol, shield), 1 short (axe, bat), 2 long (sword, katana, spear, long gun). */
const reachClass = (reach: number): 0 | 1 | 2 => (reach >= 0.7 ? 2 : reach >= 0.3 ? 1 : 0)

/** Seconds a cut-free move takes between two coverage framings (fork, main-thread: exported for coverage-clear.ts). */
export const MOVE_S = 0.4
const MIN_GAP = 0.05

export function fightCoverage(
  fight: FightDoc,
  report: FightSolution['report'],
  mode: CoverageMode,
  lineSide: 1 | -1,
  opts: CoverageOptions = {}
): CoverageMark[] {
  const marks = coverageMarks(fight, report, mode, lineSide, opts)
  const clear = opts.clear
  return clear ? marks.map((m, i) => ({ ...m, shot: clear(m.shot, [m.time, marks[i + 1]?.time ?? Infinity]) })) : marks
}

function coverageMarks(
  fight: FightDoc,
  report: FightSolution['report'],
  mode: CoverageMode,
  lineSide: 1 | -1,
  opts: CoverageOptions
): CoverageMark[] {
  const [a, b] = fight.fighterIds
  const armed = reachClass(Math.max(0, ...(opts.reach ?? [0, 0])))
  /** The defender of a report beat goes down (a knockdown that lands, or a KO). */
  const falls = (beat: FightSolution['report']['beats'][number]): boolean => {
    const doc = fight.beats[beat.index]!
    const n = beat.impactTimes.length
    return beat.impactTimes.some((_, i) => {
      const outcome = doc.outcomes[doc.outcomes.length - n + i]
      return outcome === 'ko' || (beat.physics[i]!.result === 'knockdown' && outcome === 'hit')
    })
  }
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
  type Beat = FightSolution['report']['beats'][number]

  if (mode === 'master') {
    push(fight.startT - 0.3, two('WS'))
    return out
  }

  /** The tightest single on the defender that still shows where the blow lands: head MCU, body MS, legs FS. */
  const zoneSize = (zone: FightBeat['target']): ShotSpec['size'] => (zone === 'head' ? 'MCU' : zone === 'body' ? 'MS' : 'FS')
  /** A side-on two-shot that holds both fighters, the target and the weapons. */
  const twoFor = (beat: Beat): ShotSpec => two(armed > 0 || fight.beats[beat.index]!.target === 'legs' ? (armed === 2 ? 'WS' : 'FS') : 'MS')

  if (mode === 'punch-in') {
    // Per beat: a two-shot that holds the blow's target; at every big hit, a push in on the defender sized to the target.
    type Ev = { t: number; kind: 'base' | 'punch' | 'out'; shot?: ShotSpec }
    const evs: Ev[] = []
    report.beats.forEach((beat, k) => {
      const doc = fight.beats[beat.index]!
      evs.push({ t: k === 0 ? 0 : beat.startT - 0.3, kind: 'base', shot: twoFor(beat) })
      const n = beat.impactTimes.length
      beat.impactTimes.forEach((t, i) => {
        const outcome = doc.outcomes[doc.outcomes.length - n + i]
        const ph = beat.physics[i]!
        if (ph.result === 'stagger' || ph.result === 'knockdown' || outcome === 'ko') {
          const down = outcome === 'ko' || (ph.result === 'knockdown' && outcome === 'hit')
          const defender = fight.fighterIds[doc.attacker === 0 ? 1 : 0]
          // A hit pushes in: unarmed on the defender, sized to the target; armed to an MS two-shot, which holds
          // the attacker's weapon and the target. A fall widens to a WS two-shot, so both stay whole in frame.
          const shot: ShotSpec = down
            ? two('WS')
            : armed > 0
              ? two('MS')
              : { size: zoneSize(doc.target), subjectIds: [defender], ...line }
          evs.push({ t: t - 0.2, kind: 'punch', shot })
          // A fall stays wide until the next beat; a hit pulls back out after it lands.
          if (!down) evs.push({ t: t + 0.7, kind: 'out' })
        }
      })
    })
    if (report.beats.length === 0) evs.push({ t: 0, kind: 'base', shot: two(armed === 0 ? 'MS' : 'FS') })
    const order = { base: 0, punch: 1, out: 2 }
    evs.sort((x, y) => x.t - y.t || order[x.kind] - order[y.kind])
    let base: ShotSpec | null = null
    let last: ShotSpec | null = null
    let inPunch = false
    const same = (x: ShotSpec | null, y: ShotSpec | null): boolean => !!x && !!y && JSON.stringify(x) === JSON.stringify(y)
    evs.forEach((e, k) => {
      if (e.kind === 'base') {
        base = e.shot!
        // A new beat ends a fall's wide hold; a push-in still running finishes first.
        if (inPunch && last?.subjectIds.length === 2) inPunch = false
        if (!inPunch && !same(last, base)) push(e.t, (last = base))
      }
      else if (e.kind === 'punch') {
        push(e.t, (last = e.shot!), 0.6, 0.3)
        inPunch = true
      }
      else {
        // Stay pushed in when the next big hit comes before the pull-out would.
        const next = evs.slice(k + 1).find((x) => x.kind === 'punch')
        if (next && next.t <= e.t + 1e-9) return
        inPunch = false
        if (base && !same(last, base)) push(e.t, (last = base))
      }
    })
    return out
  }

  for (const beat of report.beats) {
    const attacker = attackerOf(beat.index)
    const atkId = fight.fighterIds[attacker]
    const defId = fight.fighterIds[attacker === 0 ? 1 : 0]
    const zone = fight.beats[beat.index]!.target
    if (mode === 'over-shoulder') {
      // A faces along A→B, so its right shoulder is on side +1; B's is on side −1.
      const shoulder = (attacker === 0) === (lineSide === 1) ? 'right' : 'left'
      // A shoulder a metre away can't hold a weapon, a fall or a blow to the legs: a two-shot does.
      if (armed > 0 || falls(beat) || zone === 'legs') push(beat.startT - 0.3, two(armed === 2 || falls(beat) ? 'WS' : 'FS'))
      // High over the shoulder, so the attacker's guard stays under the defender's face.
      else push(beat.startT - 0.3, { size: zoneSize(zone), subjectIds: [defId], over: { entityId: atkId, shoulder }, angle: 'high', ...line })
    }
    // Follow: on the attacker, with the defender and the target in frame (a handheld two-shot, attacker first; wide for a fall).
    else push(beat.startT - 0.2, { ...(falls(beat) ? two('WS') : twoFor(beat)), subjectIds: [atkId, defId] })
  }
  return out
}
