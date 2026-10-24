/**
 * Fork (Lior's test, 2026-10-24): the viewport's one navigation scheme, so the
 * left button is free to pick.
 *
 * The middle button moves the editor view: a drag orbits, Alt + drag pans
 * across the floor, Shift + drag moves the view up and down (the scene follows
 * the cursor, like the pan), and the wheel zooms (OrbitControls' own). W A S D
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
  private lift: { pointerId: number; y: number } | null = null

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
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null }
    controls.screenSpacePanning = false
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
    const middle = e.button === 1
    const lift = middle && e.shiftKey && !e.altKey
    this.controls.mouseButtons = {
      LEFT: recording ? THREE.MOUSE.ROTATE : null,
      MIDDLE: lift ? null : e.altKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
      RIGHT: recording ? THREE.MOUSE.PAN : null
    }
    // A middle-button pan stays on the floor; a recording's right-drag pans the screen, as upstream.
    this.controls.screenSpacePanning = !middle
    if (middle) e.preventDefault() // no middle-click autoscroll
    if (lift) this.lift = { pointerId: e.pointerId, y: e.clientY }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.lift || e.pointerId !== this.lift.pointerId) return
    const dy = e.clientY - this.lift.y
    this.lift.y = e.clientY
    const dist = this.camera.position.distanceTo(this.controls.target)
    const perPixel =
      (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, this.canvas.clientHeight)
    this.raise(dy * perPixel)
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.lift && e.pointerId === this.lift.pointerId) this.lift = null
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
    this.lift = null
  }

  private onEnter = (): void => {
    this.hovered = true
  }

  private onLeave = (): void => {
    this.hovered = false
  }
}
