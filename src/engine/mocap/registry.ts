/**
 * The registered mocap bodies (fork addition; see MODIFICATIONS.md). The
 * renderer reads Y Bot and X Bot out of the user's local Mixamo library and
 * registers them here; until then (or with no library) a bot id stands in as
 * the matching studio mannequin everywhere, so nothing breaks and old
 * projects open. `mocapVersion` changes on every registration, for caches.
 *
 * PURE: no DOM / three.js / Electron. State is set once at startup (before
 * exports, which wait for the library), never on the `state(t)` path.
 */

import { assetSpec } from '../assets'
import type { PersonDims } from '../skeleton'
import { fitMocapRig, type MocapRig, type MocapSource } from './rig'

/** The bots and the studio mannequin each stands in as. */
export const MOCAP_STAND_IN: Readonly<Record<string, string>> = {
  'person.mocapMale': 'person.mannequinMale',
  'person.mocapFemale': 'person.mannequinFemale'
}

const IDS = new Set(Object.keys(MOCAP_STAND_IN))
const RIGS = new Map<string, MocapRig>()
let version = 0

export function isMocapAsset(assetId: string): boolean {
  return IDS.has(assetId)
}

/** Fit and register a bot from its source (throws on a skeleton that isn't Mixamo's). */
export function registerMocapBody(assetId: string, src: MocapSource): MocapRig {
  if (!IDS.has(assetId)) throw new Error(`${assetId} isn't a mocap body`)
  const rig = fitMocapRig(src, assetSpec(assetId).height)
  RIGS.set(assetId, rig)
  version++
  return rig
}

/** Fork (qa-fixes, mocap-qa bug 3): the library load in flight (the renderer's), and whether it has ended. */
let loading: Promise<void> | null = null
let loaded = true

/** The renderer's library load: until it ends, bots have bodies but not yet all their clips. */
export function trackMocapLoad(p: Promise<void>): void {
  loading = p
  loaded = false
  void p.then(
    () => {
      if (loading === p) loaded = true
    },
    () => {
      if (loading === p) loaded = true
    }
  )
}

/** Whether no library load is running (it ended, or none started). */
export function mocapLoadDone(): boolean {
  return loaded
}

/** Wait for the library load at most `ms`: true once it has ended, false on the timeout. */
export async function waitForMocap(ms: number): Promise<boolean> {
  if (loaded || !loading) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const done = await Promise.race([loading.then(() => true, () => true), late])
  clearTimeout(timer)
  return done
}

/** Forget every registered bot (tests). */
export function clearMocapBodies(): void {
  RIGS.clear()
  version++
}

export function mocapRig(assetId: string): MocapRig | undefined {
  return RIGS.get(assetId)
}

export function mocapVersion(): number {
  return version
}

/** The asset a body evaluates and renders as: a bot that isn't loaded stands in as its mannequin. */
export function mocapStandIn(assetId: string): string {
  return IDS.has(assetId) && !RIGS.has(assetId) ? MOCAP_STAND_IN[assetId]! : assetId
}

/** A loaded bot's dims (height ×0.8..1.2; build doesn't apply to a skinned body), else undefined. */
export function mocapDims(assetId: string, params?: Record<string, number | string>): PersonDims | undefined {
  const rig = RIGS.get(assetId)
  if (!rig) return undefined
  const h = params?.height
  const k = Math.min(1.2, Math.max(0.8, typeof h === 'number' ? h : 1))
  const d = rig.dims
  return {
    H: d.H * k,
    s: d.s * k,
    legLen: d.legLen * k,
    headR: d.headR * k,
    torsoLen: d.torsoLen * k,
    bodyW: d.bodyW * k,
    shoulderX: d.shoulderX * k,
    hipX: d.hipX * k,
    shoulderY: d.shoulderY * k,
    upperArmLen: d.upperArmLen * k,
    lowerArmLen: d.lowerArmLen * k,
    upperLegLen: d.upperLegLen * k,
    lowerLegLen: d.lowerLegLen * k,
    baseLean: 0,
    mocap: { rig, k }
  }
}
