/**
 * Fork (export-look T2): the night preset's fill from the shot camera's side.
 * On for night only (hidden otherwise, so other presets compile the same
 * shaders), and aimed from the lens a little below the view axis.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { LightingPresetId } from '@engine/types'
import { CAST_FILL, CAST_FILL_DROP, CastFill } from '@renderer/viewport/cast-fill'

const PRESETS: LightingPresetId[] = ['day', 'goldenHour', 'night', 'interiorWarm', 'interiorCool', 'club', 'middaySky', 'goldenHourSky', 'blueHourSky']

function lightDir(fill: CastFill): THREE.Vector3 {
  return fill.light.target.position.clone().sub(fill.light.position).normalize()
}

describe('CastFill', () => {
  it('lights the night preset only and stays hidden for the rest', () => {
    const fill = new CastFill(new THREE.Scene())
    for (const p of PRESETS) {
      fill.apply(p)
      expect(fill.light.visible, p).toBe(p === 'night')
      expect(fill.light.intensity, p).toBe(p === 'night' ? CAST_FILL.night : 0)
    }
    expect(CAST_FILL.night).toBeGreaterThan(0)
    expect(fill.light.castShadow).toBe(false)
  })

  it('adds the light and its target to the scene', () => {
    const scene = new THREE.Scene()
    const fill = new CastFill(scene)
    expect(fill.light.parent).toBe(scene)
    expect(fill.light.target.parent).toBe(scene)
  })

  it('shines from the camera along its view, tipped down by the drop', () => {
    const fill = new CastFill(new THREE.Scene())
    const cam = new THREE.PerspectiveCamera()
    cam.rotation.order = 'YXZ'
    for (const [pan, tilt] of [
      [0, 0],
      [0.7, -0.1],
      [-2.4, 0.2],
      [Math.PI, -0.5]
    ] as const) {
      cam.position.set(3, 1.6, -2)
      cam.rotation.set(tilt, pan, 0, 'YXZ')
      fill.follow(cam)
      expect(fill.light.position.distanceTo(cam.position)).toBeLessThan(1e-9)
      const d = lightDir(fill)
      const view = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
      // Same heading as the view, pitched down by the drop.
      expect(Math.atan2(d.x, d.z)).toBeCloseTo(Math.atan2(view.x, view.z), 9)
      expect(Math.asin(d.y)).toBeCloseTo(tilt - CAST_FILL_DROP, 9)
    }
  })

  it('is a pure function of the camera pose', () => {
    const a = new CastFill(new THREE.Scene())
    const b = new CastFill(new THREE.Scene())
    const cam = new THREE.PerspectiveCamera()
    cam.position.set(1, 2, 3)
    cam.rotation.set(-0.2, 1.1, 0.05, 'YXZ')
    a.follow(cam)
    b.follow(new THREE.PerspectiveCamera())
    b.follow(cam)
    expect(lightDir(a).toArray()).toEqual(lightDir(b).toArray())
  })
})
