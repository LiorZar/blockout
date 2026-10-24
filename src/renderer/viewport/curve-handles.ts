/**
 * Fork (Lior's test, 2026-10-24): curve handles on the selected lane's marks,
 * so a path can be bent by hand (MarkBase.handle, engine/path.ts).
 *
 * Each mark shows a knob on its incoming and outgoing side. A mark without a
 * handle shows them dim, where its legs' own control points are; dragging
 * either knob (left button, across the knob's height) sets the mark's handle,
 * the other knob mirrors it, and the path follows live, one undo step a drag.
 * A double-click on a knob makes the mark automatic again. Editor chrome: the
 * group lives in the overlay and stays out of every export and diagram.
 */

import * as THREE from 'three'
import { autoHandles } from '@engine/path'
import type { MarkBase, V3 } from '@engine/types'

/** A knob takes a press this close to it on screen (px). */
const PICK_PX = 12
const KNOB_RADIUS = 0.11
/** A drag ray meeting the knob's plane further away than this is ignored (an edge-on view). */
const MAX_DRAG_M = 200

export interface CurveHandleHooks {
  /** The camera the viewport shows now. */
  camera(): THREE.Camera
  /** Write a mark's handle; null makes the mark automatic again. */
  setHandle(markId: string, handle: V3 | null): void
}

interface Knob {
  markId: string
  side: 'in' | 'out'
  mark: V3
  at: V3
  set: boolean
}

const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k })

export class CurveHandles {
  readonly group = new THREE.Group()
  private readonly canvas: HTMLCanvasElement
  private readonly hooks: CurveHandleHooks
  private readonly geometry = new THREE.SphereGeometry(KNOB_RADIUS, 12, 8)
  private disposables: { dispose(): void }[] = []
  private knobs: Knob[] = []
  private drag: { knob: Knob; pointerId: number; plane: THREE.Plane; handle: V3 | null } | null = null
  private frame = 0

  constructor(canvas: HTMLCanvasElement, hooks: CurveHandleHooks) {
    this.canvas = canvas
    this.hooks = hooks
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('dblclick', this.onDoubleClick)
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    cancelAnimationFrame(this.frame)
    this.clear()
    this.geometry.dispose()
  }

  /** Knobs for one lane's marks (null: none), in the lane's colour. */
  rebuild(marks: readonly MarkBase[] | null, color: THREE.Color): void {
    this.clear()
    if (!marks || marks.length < 2) return
    const sorted = [...marks].sort((a, b) => a.time - b.time)
    sorted.forEach((m, i) => {
      const prev = sorted[i - 1]
      const next = sorted[i + 1]
      const p = m.position
      if (prev) {
        const h = m.handle ?? autoHandles([prev.position, ...(m.via ?? []), p]).in
        this.knobs.push({ markId: m.id, side: 'in', mark: p, at: add(p, h, -1), set: !!m.handle })
      }
      if (next) {
        const h = m.handle ?? autoHandles([p, ...(next.via ?? []), next.position]).out
        this.knobs.push({ markId: m.id, side: 'out', mark: p, at: add(p, h), set: !!m.handle })
      }
    })
    const solid = new THREE.MeshBasicMaterial({ color })
    const dim = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
    const line = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    this.disposables.push(solid, dim, line)
    for (const k of this.knobs) {
      const knob = new THREE.Mesh(this.geometry, k.set ? solid : dim)
      knob.position.set(k.at.x, k.at.y + 0.03, k.at.z)
      const stem = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(k.mark.x, k.mark.y + 0.03, k.mark.z),
        new THREE.Vector3(k.at.x, k.at.y + 0.03, k.at.z)
      ])
      this.disposables.push(stem)
      this.group.add(knob, new THREE.Line(stem, line))
    }
  }

  /** A left press on a knob starts dragging it. True when the knob took the press. */
  grab(e: PointerEvent): boolean {
    const knob = this.pick(e)
    if (!knob) return false
    e.preventDefault()
    this.drag = {
      knob,
      pointerId: e.pointerId,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -knob.at.y),
      handle: null
    }
    return true
  }

  /** The knob nearest the pointer on screen, within PICK_PX. */
  private pick(e: MouseEvent): Knob | null {
    const rect = this.canvas.getBoundingClientRect()
    const camera = this.hooks.camera()
    let best: Knob | null = null
    let bestPx = PICK_PX
    const v = new THREE.Vector3()
    for (const k of this.knobs) {
      v.set(k.at.x, k.at.y + 0.03, k.at.z).project(camera)
      if (v.z < -1 || v.z > 1) continue
      const px = Math.hypot(
        rect.left + ((v.x + 1) / 2) * rect.width - e.clientX,
        rect.top + ((1 - v.y) / 2) * rect.height - e.clientY
      )
      if (px <= bestPx) {
        best = k
        bestPx = px
      }
    }
    return best
  }

  private onPointerMove = (e: PointerEvent): void => {
    const d = this.drag
    if (!d || e.pointerId !== d.pointerId) return
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.hooks.camera())
    const hit = ray.ray.intersectPlane(d.plane, new THREE.Vector3())
    if (!hit || hit.distanceTo(ray.ray.origin) > MAX_DRAG_M) return
    const p = d.knob.mark
    const k = d.knob.side === 'out' ? 1 : -1
    d.handle = { x: (hit.x - p.x) * k, y: (hit.y - p.y) * k, z: (hit.z - p.z) * k }
    // One store write a frame: each one rebuilds the paths.
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.flush()
      })
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.flush()
    this.drag = null
  }

  private flush(): void {
    const d = this.drag
    if (d?.handle) this.hooks.setHandle(d.knob.markId, d.handle)
  }

  private onDoubleClick = (e: MouseEvent): void => {
    const knob = this.pick(e)
    if (knob?.set) this.hooks.setHandle(knob.markId, null)
  }

  private clear(): void {
    this.group.clear()
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.knobs = []
  }
}
