/**
 * Fork (Lior's test, 2026-10-24): the viewport's one navigation scheme, so the
 * left button is free to pick.
 *
 * The middle button moves the editor view: a drag orbits, Alt (or Ctrl) +
 * drag pans across the floor, Shift + drag moves the view up and down (the
 * scene follows the cursor, like the pan), and the wheel zooms (OrbitControls'
 * own). The modifiers are read on every move, so pressing or releasing one
 * mid-drag switches what the drag does without letting go of the button. W A S D
 * fly across the floor and Q / E down and up while the pointer is over the
 * viewport, faster with Shift. The right button does nothing.
 *
 * A camera recording keeps upstream's left-drag orbit and right-drag pan as
 * well: there the free camera is the shot, and clicks don't pick. Navigation
 * never moves the shot camera; it moves with its gizmo.
 */

import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** Fly direction per key (physical keys, so any keyboard layout): x right, y up, z forward. */
const FLY_KEYS: Record<string, readonly [number, number, number]> = {
  KeyW: [0, 0, 1],
  KeyS: [0, 0, -1],
  KeyD: [1, 0, 0],
  KeyA: [-1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0]
}
/** Fly speed per metre from the camera to its orbit point (m/s), and its bounds. */
const FLY_SPEED_PER_M = 0.8
const FLY_SPEED_MIN = 1.5
const FLY_SPEED_MAX = 25
const FLY_FAST = 3
/** The free camera stays this far above the floor (m); its orbit point stays on or above it. */
const MIN_CAMERA_Y = 0.1

const UP = new THREE.Vector3(0, 1, 0)

/** OrbitControls' own orbit and pan steps (not in its typings), so a middle-drag moves like its drags, damping included. */
interface OrbitSteps {
  _rotateLeft(angle: number): void
  _rotateUp(angle: number): void
  _pan(deltaX: number, deltaY: number): void
}

export type DragMode = 'orbit' | 'pan' | 'lift'

/** What a middle-drag does with the modifiers held right now. */
export function dragMode(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): DragMode {
  if (e.altKey || e.ctrlKey || e.metaKey) return 'pan'
  return e.shiftKey ? 'lift' : 'orbit'
}

export interface NavigationHooks {
  /** The free camera is being recorded as the shot. */
  recordingCamera(): boolean
  /** The free view is on screen (not look-through or Deliver). */
  freeView(): boolean
}

function typingInField(): boolean {
  const el = document.activeElement
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  )
}

export class ViewNavigation {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly hooks: NavigationHooks
  private readonly keys = new Set<string>()
  private fast = false
  private hovered = false
  private middle: { pointerId: number; x: number; y: number } | null = null

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    hooks: NavigationHooks
  ) {
    this.canvas = canvas
    this.camera = camera
    this.controls = controls
    this.hooks = hooks
    controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null }
    // Capture on the window: this runs before OrbitControls' own pointerdown
    // on the canvas, so each press sets the mapping that press uses.
    window.addEventListener('pointerdown', this.onPointerDown, true)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    canvas.addEventListener('pointerenter', this.onEnter)
    canvas.addEventListener('pointerleave', this.onLeave)
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onPointerDown, true)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.canvas.removeEventListener('pointerenter', this.onEnter)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
  }

  /** Fly one frame with the held keys. Call before `controls.update()`. */
  step(dt: number): void {
    if (this.keys.size === 0 || !this.hovered || !this.hooks.freeView()) return
    let x = 0
    let y = 0
    let z = 0
    for (const code of this.keys) {
      const [ax, ay, az] = FLY_KEYS[code]!
      x += ax
      y += ay
      z += az
    }
    const forward = this.camera.getWorldDirection(new THREE.Vector3()).setY(0)
    // Looking straight down, forward is the top of the screen.
    if (forward.lengthSq() < 1e-6) forward.copy(UP).applyQuaternion(this.camera.quaternion).setY(0)
    if (forward.lengthSq() < 1e-6) return
    forward.normalize()
    const right = new THREE.Vector3().crossVectors(forward, UP)
    const move = forward.multiplyScalar(z).addScaledVector(right, x).addScaledVector(UP, y)
    if (move.lengthSq() < 1e-9) return
    const dist = this.camera.position.distanceTo(this.controls.target)
    const speed = THREE.MathUtils.clamp(dist * FLY_SPEED_PER_M, FLY_SPEED_MIN, FLY_SPEED_MAX)
    move.normalize().multiplyScalar(speed * (this.fast ? FLY_FAST : 1) * dt)
    this.raise(move.y)
    move.y = 0
    this.camera.position.add(move)
    this.controls.target.add(move)
  }

  /** Move the camera and its orbit point up by `dy` metres, never under the floor. */
  private raise(dy: number): void {
    const target = this.controls.target
    const room = Math.max(0, Math.min(this.camera.position.y - MIN_CAMERA_Y, target.y))
    const d = Math.max(dy, -room)
    this.camera.position.y += d
    target.y += d
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.target !== this.canvas) return
    const recording = this.hooks.recordingCamera()
    // The middle button is never OrbitControls': onPointerMove drives it.
    this.controls.mouseButtons = {
      LEFT: recording ? THREE.MOUSE.ROTATE : null,
      MIDDLE: null,
      RIGHT: recording ? THREE.MOUSE.PAN : null
    }
    if (e.button !== 1) return
    e.preventDefault() // no middle-click autoscroll
    this.middle = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
  }

  private onPointerMove = (e: PointerEvent): void => {
    const m = this.middle
    if (!m || e.pointerId !== m.pointerId || !this.controls.enabled) return
    const dx = e.clientX - m.x
    const dy = e.clientY - m.y
    m.x = e.clientX
    m.y = e.clientY
    const height = Math.max(1, this.canvas.clientHeight)
    const steps = this.controls as unknown as OrbitSteps
    switch (dragMode(e)) {
      case 'orbit': {
        const perPixel = (2 * Math.PI * this.controls.rotateSpeed) / height // OrbitControls': height for both
        steps._rotateLeft(dx * perPixel)
        steps._rotateUp(dy * perPixel)
        break
      }
      case 'pan': {
        // Across the floor; a recording's right-drag pans the screen, as upstream.
        const screen = this.controls.screenSpacePanning
        this.controls.screenSpacePanning = false
        steps._pan(dx * this.controls.panSpeed, dy * this.controls.panSpeed)
        this.controls.screenSpacePanning = screen
        break
      }
      case 'lift': {
        const dist = this.camera.position.distanceTo(this.controls.target)
        this.raise((dy * 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / height)
        break
      }
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.middle && e.pointerId === this.middle.pointerId) this.middle = null
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.fast = e.shiftKey
    if (!(e.code in FLY_KEYS) || e.ctrlKey || e.metaKey || e.altKey || typingInField()) return
    this.keys.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.fast = e.shiftKey
    this.keys.delete(e.code)
  }

  private onBlur = (): void => {
    this.keys.clear()
    this.fast = false
    this.middle = null
  }

  private onEnter = (): void => {
    this.hovered = true
  }

  private onLeave = (): void => {
    this.hovered = false
  }
}
