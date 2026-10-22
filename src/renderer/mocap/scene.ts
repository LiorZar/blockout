/**
 * Mocap bots in the scene loop (fork addition; see MODIFICATIONS.md): what a
 * loaded bot's `AnimInput` gets on top of everyone's each frame — the
 * evaluator's clip, its scale (gait loops run on distance over the scaled
 * stride), its hands, and the crossfade after a change of pose source (a
 * walk arriving at its mark and settling into the idle loop). All a pure
 * function of (document, t): a change is found by bisection over a
 * camera-less evaluator, never remembered from an earlier frame.
 */

import { smoothstep } from '@engine/easing'
import { gaitClipId } from '@engine/mocap/gait-clips'
import { personDims } from '@engine/skeleton'
import type { Entity, EntityState, FightDoc, GaitId } from '@engine/types'
import { holdLoop, loopArm } from '@engine/weapon-hold'
import type { HeldWeapon } from '@engine/weapons'
import type { AnimInput } from '../viewport/builders'

/** Seconds a change of gait pose crossfades over. */
export const GAIT_BLEND = 0.25

const STILL = new Set<GaitId>(['stand', 'gesture'])

/** Joint offsets that move the body (the hand channels only shape the fingers). */
export const movesBody = (ov: Record<string, number> | undefined): boolean => !!ov && Object.entries(ov).some(([k, v]) => v !== 0 && !k.startsWith('hand'))

/** Which pose source a bot shows for an input: a mark clip, a gait's loop, or the keyframe rig. */
export function poseKind(assetId: string, input: AnimInput): string {
  if (input.clip && (input.clip.w ?? 1) >= 1) return 'clip'
  if (movesBody(input.overrides) && STILL.has(input.gait)) return `rig:${input.gait}`
  return gaitClipId(assetId, input.gait, input.speed, input.seated) ?? `rig:${input.gait}`
}

/**
 * Fill a bot's extra inputs. `inputAt` gives the same entity's input at
 * another shot time (without these extras); `fights` and `held` decide the
 * fists (a fighter's hands, a hand holding a weapon; else the marks' `handL`
 * / `handR` channels).
 */
export function botInput(entity: Entity, es: EntityState, input: AnimInput, o: { inputAt: (t: number) => AnimInput | null; fights?: FightDoc[]; held: ReadonlySet<'L' | 'R'>; weapons?: HeldWeapon[] }): void {
  input.scale = entity.transform.scale
  if (es.clip) input.clip = es.clip
  // held-weapons: on a crouch, sit or lie loop the loop's own arms hold the weapons, each arm moved off the body where
  // the loop's fist is in it, as on a clip (weapon-hold.ts).
  const loop = !es.clip && o.weapons?.length ? holdLoop(entity.assetId, input.gait, input.speed, input.seated) : undefined
  if (loop) {
    const dims = personDims(entity.assetId, entity.params)
    const distance = input.distance / ((input.scale ?? 1) * (dims.mocap?.k ?? 1))
    for (const w of o.weapons!) {
      const arm = loopArm(dims, entity.assetId, loop, distance, input.time, w.spec, w.hand, w.scale)
      if (!arm) continue
      const ov: Record<string, number> = { ...input.overrides }
      for (const [k, v] of Object.entries(arm)) ov[k] = (ov[k] ?? 0) + v
      input.overrides = ov
    }
  }
  const fighter = !!o.fights?.some((f) => f.fighterIds.includes(entity.id))
  const hand = (h: 'L' | 'R'): number => (fighter || o.held.has(h) ? 1 : Math.min(1, Math.max(0, input.overrides?.[`hand${h}`] ?? 0)))
  const L = hand('L')
  const R = hand('R')
  if (L > 0 || R > 0) input.hands = { L, R }
  const now = poseKind(entity.assetId, input)
  if (now === 'clip') return
  const t = input.time
  const before = o.inputAt(t - GAIT_BLEND)
  if (!before) return
  const was = poseKind(entity.assetId, before)
  if (was === now || was === 'clip' || (was.startsWith('rig:') && now.startsWith('rig:'))) return
  let lo = t - GAIT_BLEND
  let hi = t
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const k = o.inputAt(mid)
    if (k && poseKind(entity.assetId, k) === now) hi = mid
    else lo = mid
  }
  const prev = o.inputAt(lo)
  if (prev) input.from = { input: { ...prev, scale: entity.transform.scale }, w: smoothstep(Math.min(1, (t - hi) / GAIT_BLEND)) }
}
