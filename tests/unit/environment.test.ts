/**
 * Fork (fix-env): the stage behind the action. Every lighting preset gets a
 * ground that runs to a horizon under a graded sky (or a dim room surround),
 * instead of one flat background colour; the gradient dome stays out of the
 * depth / normal passes; everything is a pure function of the preset.
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { LightingPresetId } from '@engine/types'
import { ENV_LOOKS, SKY_EXPOSURE, StageEnvironment, exposeSky } from '@renderer/viewport/environment'

const PRESETS: LightingPresetId[] = [
  'day',
  'goldenHour',
  'night',
  'interiorWarm',
  'interiorCool',
  'club',
  'middaySky',
  'goldenHourSky',
  'blueHourSky'
]
const OLD_DAY_VOID = 0x394048

const rgb = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
const dist = (a: number, b: number): number =>
  rgb(a).reduce((s, v, i) => s + Math.abs(v - rgb(b)[i]!), 0)
const luma = (hex: number): number => {
  const [r, g, b] = rgb(hex)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function staged(lighting: LightingPresetId, fog = 0): { scene: THREE.Scene; stage: StageEnvironment } {
  const scene = new THREE.Scene()
  const stage = new StageEnvironment()
  scene.add(stage.group)
  scene.fog = fog > 0.01 ? new THREE.FogExp2(OLD_DAY_VOID, fog * 0.06) : null
  stage.apply(scene, lighting)
  return { scene, stage }
}

describe('ENV_LOOKS', () => {
  it('has a look for every lighting preset', () => {
    expect(Object.keys(ENV_LOOKS).sort()).toEqual([...PRESETS].sort())
  })

  it('separates the sky from the ground at the horizon, so the eye line reads', () => {
    for (const id of PRESETS) {
      const l = ENV_LOOKS[id]
      expect(dist(l.horizon, l.groundFar), id).toBeGreaterThanOrEqual(24)
      expect(l.hazeFar, id).toBeGreaterThan(l.hazeNear)
      // The far ground is fully hazed before the shot camera's far plane (500 m).
      expect(l.hazeFar, id).toBeLessThan(500)
    }
  })

  it('grades the sky from the horizon to the zenith', () => {
    for (const id of PRESETS) {
      if (ENV_LOOKS[id].physicalSky) continue
      expect(dist(ENV_LOOKS[id].zenith, ENV_LOOKS[id].horizon), id).toBeGreaterThanOrEqual(24)
    }
  })

  it('no longer paints the old flat day void', () => {
    for (const id of ['day', 'goldenHour', 'middaySky', 'goldenHourSky'] as const) {
      const l = ENV_LOOKS[id]
      for (const c of [l.zenith, l.horizon, l.groundFar]) expect(dist(c, OLD_DAY_VOID), id).toBeGreaterThan(30)
    }
  })

  it('keeps a lit day sky brighter than the ground and night darker than day', () => {
    expect(luma(ENV_LOOKS.day.horizon)).toBeGreaterThan(luma(ENV_LOOKS.day.groundFar))
    expect(luma(ENV_LOOKS.night.horizon)).toBeLessThan(luma(ENV_LOOKS.day.horizon))
    expect(luma(ENV_LOOKS.club.zenith)).toBeLessThan(luma(ENV_LOOKS.day.zenith))
  })

  it('closes interiors and the club in within a room-sized haze', () => {
    for (const id of ['interiorWarm', 'interiorCool', 'club'] as const) expect(ENV_LOOKS[id].hazeFar, id).toBeLessThanOrEqual(60)
    for (const id of ['day', 'goldenHour', 'night'] as const) expect(ENV_LOOKS[id].hazeFar, id).toBeGreaterThanOrEqual(150)
  })
})

describe('StageEnvironment', () => {
  it('builds a gradient dome and a ground just under the floor line', () => {
    const { stage } = staged('day')
    expect(stage.ground.position.y).toBeLessThan(0)
    expect(stage.ground.position.y).toBeGreaterThan(-0.05)
    expect(stage.ground.castShadow).toBe(false)
    // Reaches past the shot camera's far plane (500 m) in every direction.
    const box = new THREE.Box3().setFromObject(stage.ground)
    expect(box.min.x).toBeLessThanOrEqual(-1000)
    expect(box.max.z).toBeGreaterThanOrEqual(1000)
    expect(stage.dome.frustumCulled).toBe(false)
    expect((stage.dome.material as THREE.ShaderMaterial).depthWrite).toBe(false)
    expect((stage.dome.material as THREE.ShaderMaterial).fog).toBe(false)
  })

  it('applies each preset: dome colours, ground albedo, haze and background', () => {
    for (const id of PRESETS) {
      const { scene, stage } = staged(id)
      const l = ENV_LOOKS[id]
      expect(stage.dome.visible, id).toBe(!l.physicalSky)
      expect(stage.ground.visible, id).toBe(true)
      const u = (stage.dome.material as THREE.ShaderMaterial).uniforms
      const v = (hex: number): number[] => rgb(hex).map((c) => c / 255)
      expect((u.uZenith!.value as THREE.Vector3).toArray(), id).toEqual(v(l.zenith))
      expect((u.uHorizon!.value as THREE.Vector3).toArray(), id).toEqual(v(l.horizon))
      expect((u.uGround!.value as THREE.Vector3).toArray(), id).toEqual(v(l.groundFar))
      expect((stage.ground.material as THREE.MeshStandardMaterial).color.getHex(), id).toBe(l.ground)
      const g = stage.groundUniforms
      expect(g.uEnvHaze.value.toArray(), id).toEqual(v(l.groundFar))
      expect([g.uEnvHazeNear.value, g.uEnvHazeFar.value], id).toEqual([l.hazeNear, l.hazeFar])
      expect(g.uEnvChecker.value, id).toBe(l.checker)
      expect((scene.background as THREE.Color).getHex(), id).toBe(l.horizon)
    }
  })

  it('fades user fog into the horizon, not the old void', () => {
    const { scene } = staged('day', 0.5)
    expect((scene.fog as THREE.FogExp2).color.getHex()).toBe(ENV_LOOKS.day.horizon)
    expect(staged('day', 0).scene.fog).toBeNull()
  })

  it('keeps the gradient dome in the clean pass only and restores it', () => {
    const { stage } = staged('day')
    for (const pass of ['depth', 'normal'] as const) {
      const restore = stage.hideForPass(pass)
      expect(stage.dome.visible, pass).toBe(false)
      expect(stage.ground.visible, pass).toBe(true)
      restore()
      expect(stage.dome.visible, pass).toBe(true)
    }
    const restore = stage.hideForPass('clean')
    expect(stage.dome.visible).toBe(true)
    restore()
    const sky = staged('middaySky').stage
    sky.hideForPass('clean')()
    expect(sky.dome.visible).toBe(false)
  })

  it('is deterministic: the same preset gives the same state', () => {
    const a = staged('goldenHour').stage
    const b = staged('night').stage
    b.apply(new THREE.Scene(), 'goldenHour')
    const ua = (a.dome.material as THREE.ShaderMaterial).uniforms
    const ub = (b.dome.material as THREE.ShaderMaterial).uniforms
    for (const k of ['uZenith', 'uHorizon', 'uGround']) expect(ub[k]!.value).toEqual(ua[k]!.value)
    expect(b.groundUniforms.uEnvHaze.value).toEqual(a.groundUniforms.uEnvHaze.value)
  })

  it('patches the standard ground shader at anchors this three.js has', () => {
    const { stage } = staged('day')
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.standard!.vertexShader,
      fragmentShader: THREE.ShaderLib.standard!.fragmentShader
    }
    const mat = stage.ground.material as THREE.MeshStandardMaterial
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer)
    expect(shader.vertexShader).toContain('vEnvWorld =')
    expect(shader.fragmentShader).toContain('uEnvChecker')
    expect(shader.fragmentShader).toContain('mix( gl_FragColor.rgb, uEnvHaze')
    // Haze is mixed after fog, in output colour, so it meets the dome exactly.
    expect(shader.fragmentShader.indexOf('uEnvHaze, smoothstep')).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <fog_fragment>')
    )
    expect(shader.uniforms.uEnvHaze).toBe(stage.groundUniforms.uEnvHaze)
  })
})

describe('exposeSky', () => {
  it('scales the physical sky and leaves tone mapping to the renderer (the viewport and exports share it), so it is applied once', () => {
    const mat = new THREE.ShaderMaterial({ fragmentShader: 'void main() {\n#include <tonemapping_fragment>\n}' })
    const u = exposeSky(mat)
    expect(u.value).toBe(SKY_EXPOSURE)
    expect(SKY_EXPOSURE).toBeGreaterThan(0)
    expect(SKY_EXPOSURE).toBeLessThan(1)
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '', fragmentShader: mat.fragmentShader }
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer)
    expect(shader.uniforms.uSkyExposure).toBe(u)
    const f = shader.fragmentShader
    expect(f.indexOf('gl_FragColor.rgb *= uSkyExposure')).toBeGreaterThan(-1)
    expect(f.indexOf('gl_FragColor.rgb *= uSkyExposure')).toBeLessThan(f.indexOf('#include <tonemapping_fragment>'))
    expect(f.split('#include <tonemapping_fragment>')).toHaveLength(2)
    expect(f).not.toMatch(/Aces|TONE_MAPPING/)
  })
})
