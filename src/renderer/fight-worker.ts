/**
 * The fight solver's worker (fork addition, fight-speed; see
 * MODIFICATIONS.md). renderer/fight-offthread.ts relays every bot and clip
 * the renderer registers, in order, and asks for solves: each is the
 * engine's solveFight, here instead of on the main thread. Fork
 * (main-thread): and for a fight's coverage, the engine's clearCoverage.
 */

import { clearCoverage } from '@engine/fight/coverage-clear'
import { solveFight } from '@engine/fight/solve'
import { registerMocapClip } from '@engine/mocap/clip'
import { registerMocapBody } from '@engine/mocap/registry'
import type { FightWorkerReply, FightWorkerRequest } from './fight-offthread'

const ctx = self as unknown as { onmessage: ((e: MessageEvent<FightWorkerRequest>) => void) | null; postMessage(m: FightWorkerReply): void }

/** A registration that failed here: the registries no longer match the main thread's, so no solve is answered (the main thread solves it). */
let broken = ''

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

ctx.onmessage = (e) => {
  const m = e.data
  if (m.kind !== 'solve' && m.kind !== 'cover') {
    if (broken) return
    try {
      if (m.kind === 'body') registerMocapBody(m.assetId, m.src)
      else registerMocapClip(m.id, m.src)
    } catch (err) {
      broken = `registering ${m.kind === 'body' ? m.assetId : m.id}: ${message(err)}`
    }
    return
  }
  if (broken) {
    ctx.postMessage({ id: m.id, error: broken })
    return
  }
  try {
    ctx.postMessage(m.kind === 'solve' ? { id: m.id, sol: solveFight(...m.args) } : { id: m.id, cover: clearCoverage(...m.args) })
  } catch (err) {
    ctx.postMessage({ id: m.id, error: message(err) })
  }
}
