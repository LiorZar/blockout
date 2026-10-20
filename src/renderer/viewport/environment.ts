/**
 * Fork (fix-env): the stage behind the action.
 *
 * The upstream world was one flat background colour over a transparent
 * shadow-catcher, so the floor and the sky were the same grey with no horizon
 * and a video model read the frame as a void. This builds, per lighting
 * preset:
 *   - a gradient dome (zenith → horizon band → far ground below the horizon),
 *     drawn at the far plane around whichever camera renders, unlit, in exact
 *     output colours, and only in the clean pass;
 *   - a lit ground 1 cm under the floor line that runs past the shot camera's
 *     far plane, with a faint 1 m checker (box-filtered, so it never shimmers)
 *     for scale and perspective, hazing into the dome's far-ground colour so
 *     ground and dome meet at a crisp, low-contrast horizon.
 * Interiors and the club swap the sky for a dim room surround and haze the
 * floor within a hall's depth. Everything is a pure function of the preset:
 * no time, no randomness.
 */

import * as THREE from 'three'
import type { LightingPresetId } from '@engine/types'

export interface EnvLook {
  /** Sky (or ceiling dark) straight up, sRGB. */
  zenith: number
  /** Sky at the horizon (or the room's wall band), sRGB; also the fog colour. */
  horizon: number
  /** The ground where it meets the horizon, sRGB: the dome below the horizon and the fully hazed ground. */
  groundFar: number
  /** Ground albedo (lit by the preset's sun and sky). */
  ground: number
  /** Ground haze from `hazeNear` m (none) to `hazeFar` m (all `groundFar`), horizontal distance. */
  hazeNear: number
  hazeFar: number
  /** Checker strength: each 1 m tile is ±this share of the albedo. */
  checker: number
  /** The physical `Sky` dome is the sky; the gradient dome stays hidden. */
  physicalSky: boolean
}

export const ENV_LOOKS: Record<LightingPresetId, EnvLook> = {
  day: { zenith: 0x7d9cbd, horizon: 0xc8d4de, groundFar: 0x989ea4, ground: 0x6c6a65, hazeNear: 25, hazeFar: 320, checker: 0.06, physicalSky: false },
  goldenHour: { zenith: 0x5a6a8e, horizon: 0xe8b384, groundFar: 0x9a7e66, ground: 0x485870, hazeNear: 25, hazeFar: 320, checker: 0.06, physicalSky: false },
  night: { zenith: 0x0a0e18, horizon: 0x2c3a56, groundFar: 0x161c28, ground: 0x9aa2b6, hazeNear: 15, hazeFar: 200, checker: 0.08, physicalSky: false },
  interiorWarm: { zenith: 0x1a1714, horizon: 0x3e362d, groundFar: 0x241f1a, ground: 0x6e655a, hazeNear: 8, hazeFar: 45, checker: 0.07, physicalSky: false },
  interiorCool: { zenith: 0x14171b, horizon: 0x343c46, groundFar: 0x1e2228, ground: 0x666a70, hazeNear: 8, hazeFar: 45, checker: 0.07, physicalSky: false },
  club: { zenith: 0x060409, horizon: 0x24182f, groundFar: 0x0e0a13, ground: 0x45404c, hazeNear: 6, hazeFar: 35, checker: 0.08, physicalSky: false },
  middaySky: { zenith: 0x6f9cd0, horizon: 0xd2e0ec, groundFar: 0x9ea4a9, ground: 0x6c6a65, hazeNear: 30, hazeFar: 380, checker: 0.06, physicalSky: true },
  goldenHourSky: { zenith: 0x55699a, horizon: 0xeec08e, groundFar: 0x9e8168, ground: 0x485870, hazeNear: 30, hazeFar: 380, checker: 0.06, physicalSky: true },
  blueHourSky: { zenith: 0x1e2846, horizon: 0x5a6a8c, groundFar: 0x2a3142, ground: 0x5c6068, hazeNear: 20, hazeFar: 260, checker: 0.08, physicalSky: true }
}

/** Ground half-size (m): past the 500 m far plane from anywhere a set stands. */
const GROUND_HALF = 2000
/** Ground height: under every kit floor (y = 0), above nothing the action touches. */
const GROUND_Y = -0.01
/** Checker tile (m). */
const TILE = 1

/** sRGB hex → raw 0..1 channels (the dome writes them unconverted). */
function srgb(hex: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255)
}

export interface GroundUniforms {
  uEnvHaze: { value: THREE.Vector3 }
  uEnvHazeNear: { value: number }
  uEnvHazeFar: { value: number }
  uEnvChecker: { value: number }
  uEnvTile: { value: number }
}

export class StageEnvironment {
  readonly group = new THREE.Group()
  readonly dome: THREE.Mesh
  readonly ground: THREE.Mesh
  readonly groundUniforms: GroundUniforms = {
    uEnvHaze: { value: new THREE.Vector3() },
    uEnvHazeNear: { value: 25 },
    uEnvHazeFar: { value: 320 },
    uEnvChecker: { value: 0 },
    uEnvTile: { value: TILE }
  }
  private physicalSky = false

  constructor() {
    this.group.name = '__stage'

    const domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Vector3() },
        uHorizon: { value: new THREE.Vector3() },
        uGround: { value: new THREE.Vector3() }
      },
      // Unit sphere around the camera, pushed to the far plane (z = w), like
      // three's Sky: it sits behind everything at any camera position.
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
          gl_Position = p.xyww;
        }`,
      // Raw sRGB out (no tone mapping / colour-space chunks): the pixels are
      // the preset's colours exactly, in the viewport and in exports.
      fragmentShader: `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGround;
        varying vec3 vDir;
        void main() {
          float e = normalize( vDir ).y;
          vec3 sky = mix( uHorizon, uZenith, pow( clamp( e, 0.0, 1.0 ), 0.55 ) );
          float edge = max( fwidth( e ), 1e-4 );
          gl_FragColor = vec4( mix( uGround, sky, smoothstep( -edge, edge, e ) ), 1.0 );
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMat)
    this.dome.name = '__stageSky'
    this.dome.frustumCulled = false
    this.dome.renderOrder = -1000
    this.group.add(this.dome)

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x6c6a65, roughness: 1, metalness: 0 })
    // Lose any depth tie to a kit floor at y = 0.
    groundMat.polygonOffset = true
    groundMat.polygonOffsetFactor = 1
    groundMat.polygonOffsetUnits = 1
    const u = this.groundUniforms
    groundMat.onBeforeCompile = (shader): void => {
      Object.assign(shader.uniforms, u)
      shader.vertexShader =
        'varying vec3 vEnvWorld;\n' +
        shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vEnvWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'
        )
      shader.fragmentShader =
        'varying vec3 vEnvWorld;\nuniform vec3 uEnvHaze;\nuniform float uEnvHazeNear;\nuniform float uEnvHazeFar;\nuniform float uEnvChecker;\nuniform float uEnvTile;\n' +
        shader.fragmentShader
          .replace(
            '#include <color_fragment>',
            [
              '#include <color_fragment>',
              // Box-filtered checker (Quilez): averages to grey where tiles get
              // smaller than a pixel, so the far floor never aliases.
              '  vec2 envP = vEnvWorld.xz / uEnvTile;',
              '  vec2 envW = fwidth( envP ) + 1e-4;',
              '  vec2 envI = 2.0 * ( abs( fract( ( envP - 0.5 * envW ) * 0.5 ) - 0.5 ) - abs( fract( ( envP + 0.5 * envW ) * 0.5 ) - 0.5 ) ) / envW;',
              '  diffuseColor.rgb *= 1.0 + uEnvChecker * ( envI.x * envI.y );'
            ].join('\n')
          )
          .replace(
            '#include <fog_fragment>',
            [
              '#include <fog_fragment>',
              '  float envD = length( vEnvWorld.xz - cameraPosition.xz );',
              '  gl_FragColor.rgb = mix( gl_FragColor.rgb, uEnvHaze, smoothstep( uEnvHazeNear, uEnvHazeFar, envD ) );'
            ].join('\n')
          )
    }
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2), groundMat)
    this.ground.name = '__stageGround'
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = GROUND_Y
    this.ground.castShadow = false
    // Shadows come from the upstream shadow-catcher above it, so they print once.
    this.ground.receiveShadow = false
    this.group.add(this.ground)
  }

  /** Set the stage for a lighting preset; also points the background and any fog at the horizon. */
  apply(scene: THREE.Scene, lighting: LightingPresetId): void {
    const l = ENV_LOOKS[lighting]
    const du = (this.dome.material as THREE.ShaderMaterial).uniforms
    srgb(l.zenith, du.uZenith!.value as THREE.Vector3)
    srgb(l.horizon, du.uHorizon!.value as THREE.Vector3)
    srgb(l.groundFar, du.uGround!.value as THREE.Vector3)
    ;(this.ground.material as THREE.MeshStandardMaterial).color.setHex(l.ground)
    srgb(l.groundFar, this.groundUniforms.uEnvHaze.value)
    this.groundUniforms.uEnvHazeNear.value = l.hazeNear
    this.groundUniforms.uEnvHazeFar.value = l.hazeFar
    this.groundUniforms.uEnvChecker.value = l.checker
    this.physicalSky = l.physicalSky
    this.dome.visible = !l.physicalSky
    scene.background = new THREE.Color(l.horizon)
    if (scene.fog) scene.fog.color.setHex(l.horizon)
  }

  /** The gradient dome is clean-pass only (like the physical sky); returns the restore. */
  hideForPass(pass: 'clean' | 'depth' | 'normal'): () => void {
    const was = this.dome.visible
    this.dome.visible = pass === 'clean' && !this.physicalSky
    return (): void => {
      this.dome.visible = was
    }
  }
}

/**
 * Scale for three's physical `Sky` radiance. Unscaled, a midday sky drives
 * ACES (viewport, exposure 1.45) to near white, and the export renderer has no
 * tone mapping at all, so it clipped to a white void there.
 */
export const SKY_EXPOSURE = 0.22

/**
 * Scale the physical sky by `uSkyExposure`, and give it the viewport's ACES
 * curve when the renderer applies none (exports), so both show the same sky.
 * Returns the exposure uniform.
 */
export function toneMapSky(material: THREE.ShaderMaterial, sceneExposure: number): { value: number } {
  const exposure = { value: SKY_EXPOSURE }
  material.uniforms.uSkyExposure = exposure
  const k = sceneExposure.toFixed(2)
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.uSkyExposure = exposure
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        [
          'uniform float uSkyExposure;',
          '#ifndef TONE_MAPPING',
          'vec3 blockoutRrt( vec3 v ) {',
          '  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;',
          '  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;',
          '  return a / b;',
          '}',
          'vec3 blockoutAces( vec3 color ) {',
          '  const mat3 inM = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );',
          '  const mat3 outM = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );',
          '  color = outM * blockoutRrt( inM * ( color / 0.6 ) );',
          '  return clamp( color, 0.0, 1.0 );',
          '}',
          '#endif',
          'void main() {'
        ].join('\n')
      )
      .replace(
        '#include <tonemapping_fragment>',
        `gl_FragColor.rgb *= uSkyExposure;\n#ifdef TONE_MAPPING\n#include <tonemapping_fragment>\n#else\ngl_FragColor.rgb = blockoutAces( gl_FragColor.rgb * ${k} );\n#endif`
      )
  }
  material.needsUpdate = true
  return exposure
}
