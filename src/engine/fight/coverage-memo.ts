/**
 * Remembered fight coverage (fork addition, main-thread; see
 * MODIFICATIONS.md). A coverage's framings each look for a clear view on
 * every frame they drive (coverage-clear.ts), a few hundred ms on a bot
 * fight; a store action runs twice under offThread (its planning run, then
 * the real one), and the fight worker works a coverage out by the same key
 * (renderer/fight-offthread.ts, as solve-memo.ts does for solves), each
 * mark's solved view with it (the camera mark the store lays).
 *
 * PURE and deterministic: the marks are a function of their key. Not on the
 * `state(t)` path.
 */

import { ShotEvaluator } from '../evaluate'
import { mocapClipVersion } from '../mocap/clip'
import { mocapVersion } from '../mocap/registry'
import type { SolvedShot } from '../shot'
import type { CoverageMark } from './coverage'
import { clearCoverage, type CoverageArgs } from './coverage-clear'

/** A coverage mark and its view solved at the lens asked for (`solveShotAt`; null when it can't be): what the store lays. */
export type CoveredMark = CoverageMark & { solved: SolvedShot | null }

/** Each of a coverage's marks with its view solved, on the scene and shot it was worked out for. */
export function withViews(args: CoverageArgs, marks: CoverageMark[]): CoveredMark[] {
  const [scene, shot, , , , , input] = args
  const ev = new ShotEvaluator(scene, shot)
  return marks.map((m) => ({ ...m, solved: ev.solveShotAt(m.shot, m.time, input.focalLength) }))
}

const COVERS = new Map<string, CoveredMark[]>()
const KEPT = 16

/**
 * Everything a coverage reads, as one string: the scene and shot whole, the fight, its report, the mode, side and
 * input, the loaded bots and clips. Not the marks' ids: an action's every run lays its fight's marks with fresh ones
 * (the planning run's and the real run's differ), and no evaluation reads them.
 */
export function coverageKey(...args: CoverageArgs): string {
  return JSON.stringify([...args, mocapVersion(), mocapClipVersion()], (k, v: unknown) => (k === 'marks' && Array.isArray(v) ? v.map(withoutId) : v))
}

const withoutId = (m: unknown): unknown => (m && typeof m === 'object' ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'id')) : m)

/** A copy of the coverage remembered under `key`, if there is one. */
export function knownCoverage(key: string): CoveredMark[] | undefined {
  const known = COVERS.get(key)
  if (!known) return undefined
  COVERS.delete(key)
  COVERS.set(key, known)
  return structuredClone(known)
}

/** Remember a coverage under `key` (a copy: the caller keeps its own). */
export function rememberCoverage(key: string, marks: CoveredMark[]): void {
  COVERS.delete(key)
  if (COVERS.size >= KEPT) COVERS.delete(COVERS.keys().next().value!)
  COVERS.set(key, structuredClone(marks))
}

/** While set, where a coverage the memo doesn't have goes first (renderer/fight-offthread.ts: stop, to work it out off the main thread). */
let elsewhere: ((key: string, args: CoverageArgs) => void) | null = null

/** Run `run` with every coverage the memo doesn't have handed to `miss` first: it throws to stop the run, or returns to have it worked out here. */
export function coveringElsewhere<T>(miss: (key: string, args: CoverageArgs) => void, run: () => T): T {
  const was = elsewhere
  elsewhere = miss
  try {
    return run()
  } finally {
    elsewhere = was
  }
}

/** clearCoverage and its marks' views, remembered: the same inputs are worked out once. */
export function clearCoverageMemo(...args: CoverageArgs): CoveredMark[] {
  const key = coverageKey(...args)
  const known = knownCoverage(key)
  if (known) return known
  if (elsewhere) elsewhere(key, args)
  const marks = withViews(args, clearCoverage(...args))
  rememberCoverage(key, marks)
  return marks
}
