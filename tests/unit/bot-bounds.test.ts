// Fork addition (fight-speed, 2026): a posed bot's bounding sphere comes from its bones (no vertex skinned on the CPU) and holds every skinned vertex; its box stays the skin's own (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildAsset, type AnimInput } from '@renderer/viewport/builders'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { clearMocapBodies } from '@engine/mocap/registry'
import { fixtureCharacter } from './mocap-three-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const STAND: AnimInput = { gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 }

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapTemplate(FEMALE, fixtureCharacter(0.93))
  registerMocapClip('raise', syntheticClip(MALE, sweep({ shoulderLX: 0 }, { shoulderLX: -1.5, elbowL: 0.6 }, 31)))
  registerMocapClip('boxIdle', syntheticClip(MALE, sweep({}, {}, 2), { curl: { LeftHandIndex1: 1.4, RightHandIndex1: 1.4 } }))
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

function skins(group: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = []
  group.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh)
  })
  return out
}

describe("a bot's bounds", () => {
  it('its sphere, from the bones, holds every skinned vertex of every pose; never more than twice the skin’s own', () => {
    const poses: [string, AnimInput][] = [
      ['stand', STAND],
      ['a clip', { ...STAND, clip: { id: 'raise', t: 0.9 } }],
      ['a kick', { ...STAND, overrides: { hipRX: -1.6, kneeR: 0.2, shoulderLX: -1.2, torsoX: 0.4 } }],
      ['mirrored clip and a lean', { ...STAND, clip: { id: 'raise', t: 0.5, mirror: true }, overrides: { torsoZ: 0.5, headY: 0.6 } }]
    ]
    const v = new THREE.Vector3()
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      // Placed, turned and scaled as an entity is.
      b.group.position.set(2, 0, -3)
      b.group.rotation.y = 0.7
      b.group.scale.setScalar(1.1)
      for (const [name, input] of poses) {
        b.animate!(input)
        b.group.updateMatrixWorld(true)
        for (const mesh of skins(b.group)) {
          expect(mesh.boundingSphere, `${id} ${name}: cleared each frame`).toBe(null)
          mesh.computeBoundingSphere()
          const s = mesh.boundingSphere!.clone()
          let out = 0
          for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) out = Math.max(out, mesh.getVertexPosition(i, v).distanceTo(s.center) - s.radius)
          expect(out, `${id} ${name}: the furthest vertex past the sphere`).toBeLessThanOrEqual(1e-9)
          THREE.SkinnedMesh.prototype.computeBoundingSphere.call(mesh)
          expect(s.radius, `${id} ${name}: against the skin's own sphere`).toBeLessThanOrEqual(2 * mesh.boundingSphere!.radius)
        }
      }
    }
  })

  it('its box is still the skin’s own (the export measures it)', () => {
    const b = buildAsset(MALE)
    b.animate!({ ...STAND, clip: { id: 'raise', t: 0.9 } })
    b.group.updateMatrixWorld(true)
    for (const mesh of skins(b.group)) {
      expect(mesh.computeBoundingBox).toBe(THREE.SkinnedMesh.prototype.computeBoundingBox)
      expect(mesh.computeBoundingSphere).not.toBe(THREE.SkinnedMesh.prototype.computeBoundingSphere)
    }
  })
})
