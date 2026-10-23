/**
 * Fork (export-look T2): a fill from the shot camera's side, so the cast reads
 * on the night preset.
 *
 * Night is a dim blue moon (sun 0.7) over a dim sky (ambient 0.4), so bodies
 * came out near black against the street and a video model lost them. A raised
 * ambient would lift the ground, walls and sky as much as the cast and the
 * frame would stop reading as night. This is a cool, shadowless directional
 * light from the lens, aimed 3° below the view axis: what faces the camera,
 * the cast first, gets lit; the ground takes it at a grazing angle, so the
 * street stays dark (intensity and angle from a sweep, see
 * docs/plans/2026-10-23-export-look.md). It follows the shot camera's pose at
 * t, so it is deterministic and the viewport and exports agree. Presets
 * without a fill keep the light hidden, so their shaders are unchanged.
 */

import * as THREE from 'three'
import type { LightingPresetId } from '@engine/types'

/** Fill intensity per preset; presets not listed have none. */
export const CAST_FILL: Partial<Record<LightingPresetId, number>> = { night: 0.9 }
/** Moonlight blue, a shade lighter than the night sun. */
export const CAST_FILL_COLOR = 0xa9bfe6
/** How far below the camera's view axis the fill aims (rad). */
export const CAST_FILL_DROP = 0.05

export class CastFill {
  readonly light = new THREE.DirectionalLight(CAST_FILL_COLOR, 0)
  private drop = CAST_FILL_DROP
  private readonly dir = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    this.light.name = '__castFill'
    this.light.castShadow = false
    this.light.visible = false
    scene.add(this.light)
    scene.add(this.light.target)
  }

  /** On for the presets that have a fill, hidden (no shader cost) for the rest. */
  apply(lighting: LightingPresetId): void {
    const intensity = CAST_FILL[lighting] ?? 0
    this.light.intensity = intensity
    this.light.visible = intensity > 0
  }

  /** Light from the camera, along its view tipped down by the drop. */
  follow(camera: THREE.Camera): void {
    this.dir.set(0, 0, -1).applyQuaternion(camera.quaternion)
    const flat = Math.hypot(this.dir.x, this.dir.z)
    const pitch = Math.atan2(this.dir.y, flat) - this.drop
    const yaw = flat > 1e-6 ? Math.atan2(this.dir.x, this.dir.z) : 0
    this.dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    this.light.position.copy(camera.position)
    this.light.target.position.copy(camera.position).add(this.dir)
  }
}
