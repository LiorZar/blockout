/**
 * Shared overlay resources (fork addition, main-thread; see MODIFICATIONS.md).
 *
 * SceneManager rebuilds every mark's spike tape on every document change and
 * the selected lane's time labels on every selection change. A staged bot
 * fight lays ~800 marks, and each `markMesh` made two box geometries, a
 * material, a canvas, a texture and a sprite material (and each label a
 * canvas and a texture): ~50 ms on the commit, and hundreds of textures to
 * upload on the next frame. Marks now share them: the tape's geometries and
 * material per colour, the number's texture and sprite material per number,
 * a time label's per text and colour. Each is made once by the builders'
 * own `markMesh` / `labelSprite` and cloned (`Object3D.clone` shares
 * geometry and material), so marks look as before; shared resources are
 * flagged and a rebuild never disposes them. A number is a canvas the first
 * time: past a couple of dozen new ones in one task (a staging's hundreds)
 * they are made while the editor idles and join their marks a moment later.
 *
 * `warmOverlay` compiles the overlay's and the selection's shader programs
 * (`compileAsync`) and takes them into use while the editor idles, so the
 * first marks of a staged fight and its selection box and gizmo don't link
 * them on the frame that shows them. Editor chrome only: nothing here is in
 * an export.
 */

import * as THREE from 'three'
import { labelSprite, markMesh } from './builders'

const SHARED = 'overlayShared'

/** Whether a geometry, material or texture is shared by the overlay (never disposed by a rebuild). */
export function isShared(r: { userData: Record<string, unknown> } | null | undefined): boolean {
  return !!r?.userData[SHARED]
}

function share<T extends { userData: Record<string, unknown> }>(r: T): T {
  r.userData[SHARED] = true
  return r
}

/** A template's own geometry, materials and maps, flagged shared. */
function shareAll(o: THREE.Object3D): void {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh || c instanceof THREE.Sprite) {
      if (!(c instanceof THREE.Sprite)) share(c.geometry)
      const mats = Array.isArray(c.material) ? c.material : [c.material]
      for (const m of mats as THREE.Material[]) {
        share(m)
        const map = (m as THREE.SpriteMaterial).map
        if (map) share(map)
      }
    }
  })
}

/** The tape of a colour (markMesh's two bars), and the number sprite of an index. */
const tapes = new Map<string, THREE.Mesh[]>()
const numbers = new Map<number, THREE.Sprite>()
const labels = new Map<string, THREE.Sprite>()

/** Run `f` when the editor idles. */
function idle(f: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(f)
  else setTimeout(f, 0)
}

/** A template part that won't be used: its own resources freed (they were never drawn). */
function disposeOf(o: THREE.Mesh | THREE.Sprite): void {
  if (!(o instanceof THREE.Sprite)) o.geometry.dispose()
  const m = o.material as THREE.Material & { map?: THREE.Texture | null }
  m.map?.dispose()
  m.dispose()
}

/** markMesh(color, index)'s halves this cache doesn't have yet (the tape of the colour, the number), made by markMesh and shared. */
function make(color: string, index: number): void {
  const g = markMesh(color, index)
  const bars = g.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
  const sprite = g.children.find((c): c is THREE.Sprite => c instanceof THREE.Sprite)!
  // The half already shared is dropped (never drawn); the other half becomes the shared one.
  if (tapes.has(color)) for (const b of bars) disposeOf(b)
  else {
    for (const b of bars) shareAll(b)
    tapes.set(color, bars)
  }
  if (numbers.has(index)) disposeOf(sprite)
  else {
    shareAll(sprite)
    numbers.set(index, sprite)
  }
}

/**
 * New numbers made at once in one task: a mark added, a lane edited. Past that (a staged fight lays hundreds of marks,
 * and each new number is a canvas) they are made a slice at a time while the editor idles and join their marks then.
 */
const NEW_NUMBERS_AT_ONCE = 24
const NUMBERS_A_SLICE = 48
let madeNow = 0
/** Marks waiting for their number, by index. */
const waiting = new Map<number, { color: string; marks: THREE.Group[] }>()
let slicing = false

function atOnce(): boolean {
  if (madeNow === 0)
    queueMicrotask(() => {
      madeNow = 0
    })
  return madeNow++ < NEW_NUMBERS_AT_ONCE
}

function makeWaiting(): void {
  slicing = false
  let n = 0
  for (const [index, w] of waiting) {
    if (n++ === NUMBERS_A_SLICE) break
    waiting.delete(index)
    if (!numbers.has(index)) make(w.color, index)
    const number = numbers.get(index)!
    // A mark the overlay has rebuilt away since gets none.
    for (const g of w.marks) if (g.parent) g.add(number.clone())
  }
  if (waiting.size > 0 && !slicing) {
    slicing = true
    idle(makeWaiting)
  }
}

/** markMesh(color, index), its resources shared with every other mark of that colour and number (see NEW_NUMBERS_AT_ONCE). */
export function sharedMarkMesh(color: string, index: number): THREE.Group {
  if (!tapes.has(color) || (!numbers.has(index) && !waiting.has(index) && atOnce())) make(color, index)
  const group = new THREE.Group()
  group.name = 'mark'
  for (const m of tapes.get(color)!) group.add(m.clone())
  const number = numbers.get(index)
  if (number) group.add(number.clone())
  else {
    const w = waiting.get(index)
    if (w) w.marks.push(group)
    else waiting.set(index, { color, marks: [group] })
    if (!slicing) {
      slicing = true
      idle(makeWaiting)
    }
  }
  return group
}

/** labelSprite(text, color), its texture and material shared with every label of that text and colour. */
export function sharedLabelSprite(text: string, color: string): THREE.Sprite {
  const key = `${color}\n${text}`
  let s = labels.get(key)
  if (!s) {
    s = labelSprite(text, color)
    shareAll(s)
    labels.set(key, s)
  }
  return s.clone()
}

/** One of each overlay object (a mark, a time label, a path line, a chevron), kept so their programs stay compiled. */
let warm: THREE.Group | null = null
/** The fog each renderer's overlay programs were compiled for (fog is in their key). */
const warmed = new WeakMap<THREE.WebGLRenderer, string>()

/** A WebGLProgram as three keeps it: `getUniforms` takes it into use (its link checked, its uniforms read) the first time. */
type Program = { getUniforms(): unknown }

/**
 * An object's programs taken into use, one per idle slice. Without KHR_parallel_shader_compile three's compileAsync
 * resolves at once and a program's link still stalls the first frame that draws with it (three's "may cause a stall
 * when it's first used"); this way the stall is spent while the editor idles.
 */
function takeIntoUse(renderer: THREE.WebGLRenderer, root: THREE.Object3D): void {
  const programs = new Set<Program>()
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      const p = (renderer.properties.get(mat) as { currentProgram?: Program }).currentProgram
      if (p) programs.add(p)
    }
  })
  const next = (): void => {
    const p = programs.values().next().value
    if (!p) return
    programs.delete(p)
    p.getUniforms()
    idle(next)
  }
  idle(next)
}

/**
 * Compile the overlay's shader programs for the scene's current state in the background, with `extra` objects of the
 * scene's chrome (the selection box, the gizmo), once per renderer and fog, then take them into use while the editor
 * idles (takeIntoUse). Call after the scene's environment (fog) is set.
 */
export function warmOverlay(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, extra: THREE.Object3D[] = []): void {
  const fog = !scene.fog ? 'none' : (scene.fog as THREE.FogExp2).isFogExp2 ? 'exp2' : 'linear'
  if (warmed.get(renderer) === fog) return
  warmed.set(renderer, fog)
  if (!warm) {
    warm = new THREE.Group()
    warm.add(sharedMarkMesh('#f5a524', 1), sharedLabelSprite('t=0.0s', '#f5a524'))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
      new THREE.LineDashedMaterial({ color: 0x7dd3fc, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.8 })
    )
    line.computeLineDistances()
    const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 4), new THREE.MeshBasicMaterial({ color: 0xf5a524, transparent: true, opacity: 0.9 }))
    warm.add(line, chevron)
  }
  for (const o of [warm, ...extra]) void renderer.compileAsync(o, camera, scene).then(() => takeIntoUse(renderer, o), () => undefined)
}
