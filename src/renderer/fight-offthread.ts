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
/** Solves asked of the worker and not answered yet, by memo key (one solve each, however many ask). */
const inFlight = new Map<string, Promise<FightSolution | null>>()
/** Solves the worker didn't answer (an error there): solved here from then on. */
const refused = new Set<string>()
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
  refused.clear()
}

/** Whether a store action is running in planning mode (store.mutate commits nothing). */
export function planningRun(): boolean {
  return planning
}

/** One solve off the main thread, remembered once it is in; null when there is no worker to do it. */
function solveThere(key: string, args: FightSolveArgs): Promise<FightSolution | null> {
  const known = inFlight.get(key)
  if (known) return known
  const w = stand ? null : fightWorker()
  const asking: Promise<FightSolution | null> = stand
    ? stand(args)
    : w
      ? new Promise((resolve) => {
          const id = ++asked
          waiting.set(id, resolve)
          w.postMessage({ kind: 'solve', id, args } satisfies FightWorkerRequest)
        })
      : Promise.resolve(null)
  const done = asking.then((sol) => {
    inFlight.delete(key)
    if (sol) rememberFightSolve(key, sol)
    else refused.add(key)
    return sol
  })
  inFlight.set(key, done)
  return done
}

/** Run `run` in planning mode: its solves the memo doesn't have, or its value when it has them all. */
function plan<T>(run: () => T): { value: T; missed: [] } | { missed: { key: string; args: FightSolveArgs }[] } {
  const missed: { key: string; args: FightSolveArgs }[] = []
  planning = true
  try {
    const value = solvingElsewhere((key, args) => {
      if (refused.has(key)) return
      missed.push({ key, args: structuredClone(args) })
      throw STOP
    }, run)
    if (missed.length === 0) return { value, missed: [] }
  } catch (e) {
    // The action's own error (a bad input): it throws again for real.
    if (missed.length === 0) throw e
  } finally {
    planning = false
  }
  return { missed }
}

/** Run a store action that solves fights with its solves off the main thread: its result (or its error). */
export async function offThread<T>(run: () => T): Promise<T> {
  if (!stand && !fightWorker()) return run()
  for (let round = 0; round < ROUNDS; round++) {
    const { missed } = plan(run)
    if (missed.length === 0) break
    const sols = await Promise.all(missed.map((m) => solveThere(m.key, m.args)))
    if (sols.some((s) => !s)) break
  }
  return run()
}

/**
 * A read that solves fights (a panel's live report, the prompt), for a render: its value when the memo has
 * every solve it needs (or there is no worker: it solves here); else null, and `ready` once the worker has
 * solved what it needs (read it again then).
 */
export function readSoon<T>(read: () => T, ready: () => void): T | null {
  if (!stand && !fightWorker()) return read()
  const p = plan(read)
  if (p.missed.length === 0) return (p as { value: T }).value
  void Promise.all(p.missed.map((m) => solveThere(m.key, m.args))).then(ready)
  return null
}
