/**
 * Remembered fight solves (fork addition, fight-speed; see MODIFICATIONS.md).
 * A bot fight takes seconds to solve, so the last solutions are kept by
 * everything a solve reads: the fight, the fighters' inputs, the shot's
 * timing, the options, the loaded bots and clips. Reading a fight again (the
 * store's get_fight, the Fight Director's live report, the prompt on every
 * edit) returns a copy of its solution; an edit that changes an input
 * misses. The off-thread solves (renderer/fight-offthread.ts) put theirs in
 * by the same key.
 *
 * PURE and deterministic: a solution is a function of its key. Not on the
 * `state(t)` path.
 */

import { mocapClipVersion } from '../mocap/clip'
import { mocapVersion } from '../mocap/registry'
import { solveFight, type FightSolution } from './solve'

export type FightSolveArgs = Parameters<typeof solveFight>

const SOLVES = new Map<string, FightSolution>()
const KEPT = 16

/** Everything a solve reads, as one string (no props and an empty prop list solve alike). */
export function fightSolveKey(...[fight, fighters, shot, opts = {}]: FightSolveArgs): string {
  const props = opts.obstacles && opts.obstacles.length > 0 ? opts.obstacles : []
  return JSON.stringify([fight, fighters, { duration: shot.duration, fps: shot.fps }, props, !!opts.paths, mocapVersion(), mocapClipVersion()])
}

/** A copy of the solution remembered under `key`, if there is one. */
export function knownFightSolve(key: string): FightSolution | undefined {
  const known = SOLVES.get(key)
  if (!known) return undefined
  SOLVES.delete(key)
  SOLVES.set(key, known)
  return structuredClone(known)
}

/** Remember a solution under `key` (a copy: the caller keeps its own). */
export function rememberFightSolve(key: string, sol: FightSolution): void {
  SOLVES.delete(key)
  if (SOLVES.size >= KEPT) SOLVES.delete(SOLVES.keys().next().value!)
  SOLVES.set(key, structuredClone(sol))
}

/** solveFight, remembered: the same inputs solve once. */
export function solveFightMemo(...args: FightSolveArgs): FightSolution {
  const key = fightSolveKey(...args)
  const known = knownFightSolve(key)
  if (known) return known
  const sol = solveFight(...args)
  rememberFightSolve(key, sol)
  return sol
}
