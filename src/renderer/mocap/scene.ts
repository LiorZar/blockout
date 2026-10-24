/**
 * Mocap bots in the scene loop (fork addition; see MODIFICATIONS.md): what a
 * loaded bot's `AnimInput` gets on top of everyone's each frame — the
 * evaluator's clip, its scale (gait loops run on distance over the scaled
 * stride), its hands, and the crossfade after a change of pose source (a
 * walk arriving at its mark and settling into the idle loop). All a pure
 * function of (document, t): a change is found by bisection over a
 * camera-less evaluator, never remembered from an earlier frame.
 *
 * Fork (chase-feet): around a crossfade the bot's planted feet stay put (`mocap/plant-lock.ts`): `plantInto` finds the window
 * on a fixed grid of earlier times and hands the visual its samples
 * (`AnimInput.plant`), each the input the bot gets then; they are kept per
 * document (the caller's `memo`, a camera-less evaluator), so the grid is
 * worked out once, not every frame.
 */

import { smoothstep } from '@engine/easing'
import { mocapClip } from '@engine/mocap/clip'
import { clipWarp, gaitClipId } from '@engine/mocap/gait-clips'
import { PLANT_RATE, type PlantRoot } from '@engine/mocap/plant-lock'
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
 * Fork (set-routines): the distance a gait input's travelling loop plays at on
 * the bot's foot phase (`EntityState.loopPhase`, cycles from the loop's left
 * touchdown; `loop-phase.ts`), else the input's own.
 */
function onPhase(entity: Entity, input: AnimInput, phase: number | undefined): number {
  const m = personDims(entity.assetId, entity.params).mocap
  const id = phase === undefined || !m ? undefined : gaitClipId(entity.assetId, input.gait, input.speed, input.seated)
  const clip = id ? mocapClip(id) : undefined
  const warp = clip ? clipWarp(m!, clip, entity.assetId) : null
  if (!warp || !(warp.stride > 0)) return input.distance
  return (phase! * (warp.stride / (warp.cycles ?? 1)) + (warp.origin ?? 0)) * (input.scale ?? entity.transform.scale) * m!.k
}

/**
 * Fill a bot's extra inputs. `inputAt` gives the same entity's input at
 * another shot time (without these extras); `fights` and `held` decide the
 * fists (a fighter's hands, a hand holding a weapon; else the marks' `handL`
 * / `handR` channels).
 */
export function botInput(entity: Entity, es: EntityState, input: AnimInput, o: BotInputs, change: ChangeAt = bisect): void {
  input.scale = entity.transform.scale
  if (es.clip) input.clip = es.clip
  input.distance = onPhase(entity, input, es.loopPhase)
  // Fork (chase-feet): a root lifted over the ground (a vault) has its legs off the floor (`swing-legs.ts`).
  if (es.position.y > 0) input.lift = es.position.y
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
  crossfade(entity, es, input, now, o, change)
  // Fork (chase-feet): planted feet held through it (not on a bot holding a weapon: its arm rule reads the pose kind).
  if (o.stateAt && o.memo && o.held.size === 0 && !o.weapons?.length) plantInto(entity, es, input, o)
}

/**
 * What `botInput` reads besides the frame's state: the entity's input at another shot time (`inputAt`, without the
 * extras); its fights and held hands. Fork (chase-feet): `stateAt`, its state at another time, and `memo`, one object
 * per document, turn the plant lock on.
 */
export interface BotInputs {
  inputAt: (t: number) => AnimInput | null
  stateAt?: (t: number) => EntityState | null
  memo?: object
  fights?: FightDoc[]
  held: ReadonlySet<'L' | 'R'>
  weapons?: HeldWeapon[]
}

/** Where a change to pose source `now` falls in [lo, hi] (s): its time, and the input just before it. */
type ChangeAt = (entity: Entity, now: string, lo: number, hi: number, o: BotInputs) => { hi: number; prev: AnimInput | null }

/** A change found by bisection. */
function bisect(entity: Entity, now: string, lo: number, hi: number, o: BotInputs): { hi: number; prev: AnimInput | null } {
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const k = o.inputAt(mid)
    if (k && poseKind(entity.assetId, k) === now) hi = mid
    else lo = mid
  }
  return { hi, prev: o.inputAt(lo) }
}

/** The crossfade after a change of pose source (`now`), found by `change` (bisection). */
function crossfade(entity: Entity, es: EntityState, input: AnimInput, now: string, o: BotInputs, change: ChangeAt): void {
  const t = input.time
  const before = o.inputAt(t - GAIT_BLEND)
  if (!before) return
  const was = poseKind(entity.assetId, before)
  if (was === now || was === 'clip' || (was.startsWith('rig:') && now.startsWith('rig:'))) return
  const { hi, prev } = change(entity, now, t - GAIT_BLEND, t, o)
  // Fork (set-routines): the pose fading out goes on (a travelling loop at the bot's foot phase, as the one fading in),
  // so its planted feet stay put instead of riding the body through the fade.
  if (prev) {
    const from = { ...prev, scale: entity.transform.scale, time: t, ...(input.lift ? { lift: input.lift } : {}) }
    input.from = { input: { ...from, distance: es.loopPhase === undefined ? input.distance : onPhase(entity, from, es.loopPhase) }, w: smoothstep(Math.min(1, (t - hi) / GAIT_BLEND)) }
  }
}

/**
 * Fork (chase-feet): a plant-lock window's samples for the visual (`body.ts`): grid sample `k` is shot time
 * k / `rate`; `k0` the window's start, `k1` the last sample at or before this frame; `at` the root this frame.
 */
export interface PlantInput {
  rate: number
  k0: number
  k1: number
  at: PlantRoot
  /** A crossfade runs this frame, or the pose stands still (as `PlantGridSample`'s). */
  mixed: boolean
  still: boolean
  /** One object per document: the samples' feet are worked out once under it. */
  memo: object
  /** Grid sample `k`: the input the bot gets then (its crossfade too), its root, and whether a crossfade runs there (`mixed`) or the pose stands still (`still`). */
  sample: (k: number) => PlantGridSample | null
}

export interface PlantGridSample {
  input: AnimInput
  at: PlantRoot
  mixed: boolean
  still: boolean
}

/** Seconds without a crossfade after which a window is over (a held foot is let go of by then, `plant-lock.ts`). */
const PLANT_GAP = 1.05

const TRAVEL_GAITS = new Set<GaitId>(['walk', 'jog', 'run', 'crouch'])

/** One grid sample of a bot: its pose kind (and the kind its raw input reads, as `crossfade` compares), and, once asked for, the whole sample. */
interface Grid {
  kind: string
  raw: string
  travels: boolean
  full?: PlantGridSample | null
}

const GRIDS = new WeakMap<object, Map<string, Map<number, Grid | null>>>()
const CHANGES = new WeakMap<object, Map<string, { hi: number; prev: AnimInput | null }>>()

/** Whether an input plays a travelling gait loop (its feet plant and lift on the distance walked). */
function travelsOn(assetId: string, input: AnimInput, kind: string): boolean {
  return kind !== 'clip' && !kind.startsWith('rig:') && TRAVEL_GAITS.has(input.gait) && kind === gaitClipId(assetId, input.gait, input.speed, input.seated) && input.speed >= 0.05
}

/** Fork (chase-feet): the plant-lock window around this frame, if any (see the module header). */
function plantInto(entity: Entity, es: EntityState, input: AnimInput, o: BotInputs): void {
  let byEntity = GRIDS.get(o.memo!)
  if (!byEntity) GRIDS.set(o.memo!, (byEntity = new Map()))
  let grid = byEntity.get(entity.id)
  if (!grid) byEntity.set(entity.id, (grid = new Map()))
  const cells = grid
  const rate = PLANT_RATE
  const back = Math.round(GAIT_BLEND * rate)
  const cell = (k: number): Grid | null => {
    if (k < 0) return null
    let g = cells.get(k)
    if (g === undefined) {
      const time = k / rate
      const raw = o.inputAt(time)
      const st = o.stateAt!(time)
      if (raw && st) {
        const kind = poseKind(entity.assetId, { ...raw, ...(st.clip ? { clip: st.clip } : {}) })
        g = { kind, raw: poseKind(entity.assetId, raw), travels: travelsOn(entity.assetId, raw, kind) }
      }
      else g = null
      cells.set(k, g)
    }
    return g
  }
  // A crossfade at sample k (crossfade's rule on the grid).
  const mixed = (k: number): boolean => {
    const now = cell(k)
    const was = cell(k - back)
    if (!now || !was || now.kind === 'clip') return false
    return was.raw !== now.kind && was.raw !== 'clip' && !(was.raw.startsWith('rig:') && now.kind.startsWith('rig:'))
  }
  const k1 = Math.floor(input.time * rate + 1e-9)
  const gap = Math.ceil(PLANT_GAP * rate)
  let km = -1
  for (let k = k1; k >= 0 && k > k1 - gap; k--)
    if (mixed(k)) {
      km = k
      break
    }
  if (km < 0) return
  // The window's start: its first crossfade sample, crossfades less than PLANT_GAP apart joined.
  let k0 = km
  for (let k = km - 1, quiet = 0; k >= 0 && quiet < gap; k--) {
    if (mixed(k)) {
      k0 = k
      quiet = 0
    }
    else quiet++
  }
  // A crossfade's change, found once between the two grid samples either side of it (not once per sample).
  let changes = CHANGES.get(o.memo!)
  if (!changes) CHANGES.set(o.memo!, (changes = new Map()))
  const found = changes
  const onGrid: ChangeAt = (ent, now, lo, hi, oo) => {
    let j = Math.floor(hi * rate + 1e-9)
    while (j > 0 && j / rate > lo && cell(j - 1)?.raw === now) j--
    const key = `${entity.id}|${j}|${now}`
    let c = found.get(key)
    if (!c) found.set(key, (c = bisect(ent, now, Math.max(lo, (j - 1) / rate), j / rate, oo)))
    return c
  }
  const sample = (k: number): PlantGridSample | null => {
    const g = cell(k)
    if (!g) return null
    if (g.full === undefined) {
      const time = k / rate
      const raw = o.inputAt(time)
      const st = o.stateAt!(time)
      if (raw && st) {
        // The input the frame at that time gets (its crossfade included), without a lock of its own.
        botInput(entity, st, raw, { ...o, stateAt: undefined, memo: undefined }, onGrid)
        g.full = { input: raw, at: { x: st.position.x, z: st.position.z, heading: st.heading }, mixed: mixed(k), still: !g.travels }
      }
      else g.full = null
    }
    return g.full
  }
  const travels = travelsOn(entity.assetId, input, poseKind(entity.assetId, input))
  input.plant = { rate, k0, k1, at: { x: es.position.x, z: es.position.z, heading: es.heading }, mixed: !!input.from, still: !travels, memo: o.memo!, sample }
}
