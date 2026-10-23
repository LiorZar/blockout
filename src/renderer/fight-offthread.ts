/**
 * Bot fight solves off the main thread (fork addition, fight-speed; see
 * MODIFICATIONS.md). A Y Bot vs X Bot fight takes seconds to solve, which
 * froze the app. `offThread(run)` runs a store action that solves fights
 * (stageFight, updateFight) so its solves happen in a worker: the action
 * first runs in planning mode, where a solve the memo
 * (engine/fight/solve-memo.ts) doesn't have stops it and `store.mutate` edits
 * a throwaway copy (nothing is committed); each solve it stopped at is
 * solved in the worker and remembered; once a planning run finds every solve
 * remembered, the action runs for real and solves nothing. Same code, same
 * inputs: the same result as a solve here.
 *
 * The worker has the engine's bots and clips: every registration the
 * renderer makes (mocap/library.ts) is relayed to it in order, and messages
 * keep their order, so at each request its registry is the main thread's.
 * Without a worker (Vitest, a failed one) the solves run here, as before.
 */

import type { FightSolution } from '@engine/fight/solve'
import { rememberFightSolve, solvingElsewhere, type FightSolveArgs } from '@engine/fight/solve-memo'
import type { MocapClipSource } from '@engine/mocap/clip'
import type { MocapSource } from '@engine/mocap/rig'

/** A bot or clip the engine registered, for the worker to register too. */
export type MocapRegistration = { kind: 'body'; assetId: string; src: MocapSource } | { kind: 'clip'; id: string; src: MocapClipSource }
export type FightWorkerRequest = MocapRegistration | { kind: 'solve'; id: number; args: FightSolveArgs }
export type FightWorkerReply = { id: number; sol?: FightSolution; error?: string }

/** Planning runs before an action runs here anyway (each round solves at least one new fight; a memo this small can't hold more). */
const ROUNDS = 12

let worker: Worker | null = null
let failed = false
let asked = 0
const waiting = new Map<number, (sol: FightSolution | null) => void>()
/** A stand-in for the worker (tests). */
let stand: ((args: FightSolveArgs) => Promise<FightSolution | null>) | null = null
let planning = false
/** Thrown to stop a planning run at a solve the memo doesn't have. */
const STOP = new Error('fight solve off the main thread')

function fightWorker(): Worker | null {
  if (failed || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./fight-worker.ts', import.meta.url), { type: 'module' })
  } catch {
    failed = true
    return null
  }
  worker.onmessage = (e: MessageEvent<FightWorkerReply>): void => {
    const done = waiting.get(e.data.id)
    waiting.delete(e.data.id)
    if (e.data.error) console.warn(`[fight] worker: ${e.data.error}`)
    done?.(e.data.sol ?? null)
  }
  worker.onerror = (e): void => {
    console.warn(`[fight] worker failed: ${e.message}`)
    failed = true
    for (const done of waiting.values()) done(null)
    waiting.clear()
  }
  return worker
}

/** Relay a bot or clip the engine just registered to the worker (mocap/library.ts). */
export function relayMocap(reg: MocapRegistration): void {
  fightWorker()?.postMessage(reg)
}

/** Tests: solve with `fn` instead of the worker (null: the worker again). */
export function setFightSolver(fn: ((args: FightSolveArgs) => Promise<FightSolution | null>) | null): void {
  stand = fn
}

/** Whether a store action is running in planning mode (store.mutate commits nothing). */
export function planningRun(): boolean {
  return planning
}

/** One solve off the main thread; null when there is no worker to do it. */
function solveThere(args: FightSolveArgs): Promise<FightSolution | null> {
  if (stand) return stand(args)
  const w = fightWorker()
  if (!w) return Promise.resolve(null)
  const id = ++asked
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    w.postMessage({ kind: 'solve', id, args } satisfies FightWorkerRequest)
  })
}

/** Run a store action that solves fights with its solves off the main thread: its result (or its error). */
export async function offThread<T>(run: () => T): Promise<T> {
  if (!stand && !fightWorker()) return run()
  for (let round = 0; round < ROUNDS; round++) {
    const missed: { key: string; args: FightSolveArgs }[] = []
    planning = true
    try {
      solvingElsewhere((key, args) => {
        missed.push({ key, args: structuredClone(args) })
        throw STOP
      }, run)
    } catch (e) {
      // The action's own error (a bad input): it throws again for real.
      if (missed.length === 0) throw e
    } finally {
      planning = false
    }
    if (missed.length === 0) break
    const sols = await Promise.all(missed.map((m) => solveThere(m.args)))
    if (sols.some((s) => !s)) break
    missed.forEach((m, k) => rememberFightSolve(m.key, sols[k]!))
  }
  return run()
}
