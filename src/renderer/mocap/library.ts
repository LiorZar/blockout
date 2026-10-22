/**
 * The local Mixamo library in the renderer (fork addition; see
 * MODIFICATIONS.md). At startup `loadMocapLibrary` asks the main process for
 * the manifest; with one, it parses the first male and female character
 * (three's FBXLoader), registers each with the engine as
 * `person.mocapMale` / `person.mocapFemale` and keeps the parsed scene as the
 * template every bot visual clones; then it samples every clip (phase 2) and
 * registers it. Without a library nothing loads and the bots stay hidden.
 * `mocapReady` resolves once loading is over (exports wait for it),
 * `onMocapLoaded` / `useMocapLoaded` tell the scene and the panels.
 */

import { useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { registerMocapClip } from '@engine/mocap/clip'
import { isMocapAsset, mocapLoadDone, mocapRig, registerMocapBody, trackMocapLoad } from '@engine/mocap/registry'
import type { MocapManifest, MocapManifestClip } from '../../shared/mocap-library'
import { readClipTake } from './clips'
import { extractMocap, fileUnit, primaryBones } from './extract'

const BODY_ASSET = { male: 'person.mocapMale', female: 'person.mocapFemale' } as const

export interface MocapTemplate {
  /** The parsed character (never shown; visuals clone it). */
  root: THREE.Group
  /** Metres per file unit. */
  unit: number
  name: string
  /** Each mixamorig bone's bind transform under its parent, by name. */
  bindLocal: Map<string, THREE.Matrix4>
}

const TEMPLATES = new Map<string, MocapTemplate>()
const LISTENERS = new Set<() => void>()
let loading: Promise<void> | null = null
let clips: MocapManifestClip[] = []
let loads = 0
/** Fork (qa-fixes): clips sampled and registered so far. */
let sampled = 0

/** Every bone's bind pose under its parent, from the skinned meshes' bind matrices. */
function bindLocals(root: THREE.Group): Map<string, THREE.Matrix4> {
  root.updateMatrixWorld(true)
  const world = new Map<THREE.Object3D, THREE.Matrix4>()
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    mesh.skeleton.bones.forEach((b, i) => {
      if (!world.has(b)) world.set(b, mesh.skeleton.boneInverses[i]!.clone().invert())
    })
  })
  const out = new Map<string, THREE.Matrix4>()
  for (const [name, bone] of primaryBones(root)) {
    const parent = bone.parent!
    const pw = world.get(parent) ?? parent.matrixWorld
    out.set(name, new THREE.Matrix4().copy(pw).invert().multiply(world.get(bone) ?? bone.matrixWorld))
  }
  return out
}

/** Register a parsed character as a bot (the loader's way in, and the tests'). */
export function registerMocapTemplate(assetId: string, root: THREE.Group, name = assetId): MocapTemplate {
  const unit = fileUnit(root)
  registerMocapBody(assetId, extractMocap(root, unit))
  const t: MocapTemplate = { root, unit, name, bindLocal: bindLocals(root) }
  TEMPLATES.set(assetId, t)
  return t
}

export function mocapTemplate(assetId: string): MocapTemplate | undefined {
  return mocapRig(assetId) ? TEMPLATES.get(assetId) : undefined
}

/** The library's clips (phase 2 plays them). */
export function mocapClips(): MocapManifestClip[] {
  return clips
}

/** Sample a parsed clip file and register it with the engine (the loader's way in, and the tests'). */
export function registerClipTake(id: string, root: THREE.Object3D, source: string, opts: { fps?: number; loop?: boolean; inPlace?: boolean } = {}): void {
  const t = TEMPLATES.get(source)
  const take = (root as THREE.Object3D & { animations?: THREE.AnimationClip[] }).animations?.[0]
  if (!t || !take) throw new Error(`clip ${id}: ${t ? 'no take in the file' : `${source} isn't loaded`}`)
  registerMocapClip(id, readClipTake(root, take, { unit: t.unit, fps: opts.fps ?? 30, source, loop: opts.loop, inPlace: opts.inPlace }))
}

function notify(): void {
  loads++
  for (const l of LISTENERS) l()
}

/** Load the library once (a missing or broken one leaves the bots hidden). */
export function loadMocapLibrary(): Promise<void> {
  const fresh = !loading
  loading ??= (async () => {
    const api = window.blockout
    let manifest: MocapManifest | null = null
    try {
      manifest = (await api?.mocapList?.()) ?? null
    } catch {
      manifest = null
    }
    if (!manifest) return
    clips = manifest.clips
    for (const c of manifest.characters) {
      const assetId = BODY_ASSET[c.body]
      if (TEMPLATES.has(assetId)) continue
      try {
        const root = new FBXLoader().parse(await api.mocapRead(c.file), '')
        const t = registerMocapTemplate(assetId, root, c.name)
        const rig = mocapRig(assetId)!
        console.log(`[mocap] ${c.name} as ${assetId}: ${t.bindLocal.size} bones, ${rig.points.length} floor points, ${rig.capsules.length} capsules`)
      } catch (e) {
        console.warn(`[mocap] ${c.name} (${c.file}) didn't load: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    notify()
    // Phase 2: the clips, each sampled once into plain data (bots play them from the engine).
    const byName = new Map(manifest.characters.map((c) => [c.name, BODY_ASSET[c.body]]))
    let ok = 0
    for (const c of manifest.clips) {
      const source = (c.character && byName.get(c.character)) || BODY_ASSET.male
      if (!TEMPLATES.has(source)) continue
      try {
        const root = new FBXLoader().parse(await api.mocapRead(c.file), '')
        registerClipTake(c.key, root, source, { fps: c.fps, loop: c.loop, inPlace: c.inPlace })
        ok++
        sampled++
      } catch (e) {
        console.warn(`[mocap] clip ${c.key} (${c.file}) didn't load: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    console.log(`[mocap] library: ${manifest.characters.length} characters, ${manifest.clips.length} clips, ${ok} sampled`)
    notify()
  })()
  // Fork (qa-fixes, mocap-qa bug 3): tools that cast or move bots wait for it (control/handler.ts, store.ts fightNotice).
  if (fresh) trackMocapLoad(loading)
  return loading
}

/** Fork (qa-fixes): whether the library has finished loading (bodies and every clip), the bots loaded and the clips sampled. */
export function mocapStatus(): { ready: boolean; bots: string[]; clips: number } {
  return { ready: mocapLoadDone(), bots: [...TEMPLATES.keys()], clips: sampled }
}

/** Resolves when the library has loaded (or there is none). */
export function mocapReady(): Promise<void> {
  return loading ?? Promise.resolve()
}

export function onMocapLoaded(cb: () => void): () => void {
  LISTENERS.add(cb)
  return () => LISTENERS.delete(cb)
}

/** Re-renders a panel when the library loads; true once a bot is available. */
export function useMocapLoaded(): boolean {
  useSyncExternalStore(onMocapLoaded, () => loads)
  return TEMPLATES.size > 0
}

/** A bot asset the user can place right now. */
export function mocapAvailable(assetId: string): boolean {
  return !!mocapTemplate(assetId)
}

/** Whether pickers and list_assets offer an asset: everything but a bot that isn't loaded. */
export function assetListed(assetId: string): boolean {
  return !isMocapAsset(assetId) || mocapAvailable(assetId)
}

/** The male / female body pairs the Fight Director and the Choreographer spawn; Mocap only with the library. */
export const BODY_SETS: { id: 'classic' | 'mannequin' | 'mocap'; name: string; assets?: [string, string] }[] = [
  { id: 'classic', name: 'Classic' },
  { id: 'mannequin', name: 'Mannequin', assets: ['person.mannequinMale', 'person.mannequinFemale'] },
  { id: 'mocap', name: 'Mocap (Mixamo)', assets: ['person.mocapMale', 'person.mocapFemale'] }
]

export type BodySetId = (typeof BODY_SETS)[number]['id']

/** The body sets on offer now, and the default: Mocap when the library has loaded. */
export function bodySets(loaded: boolean): { sets: typeof BODY_SETS; preferred: BodySetId } {
  return { sets: BODY_SETS.filter((b) => b.id !== 'mocap' || loaded), preferred: loaded ? 'mocap' : 'classic' }
}
