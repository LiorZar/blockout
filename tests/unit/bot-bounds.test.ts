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

  // Fork (main-thread): worked out without three's per-vertex matrix products, to the same numbers.
  it('its box is still the skin’s own, to the bit (the export measures it)', () => {
    const poses: AnimInput[] = [
      STAND,
      { ...STAND, clip: { id: 'raise', t: 0.9 } },
      { ...STAND, overrides: { hipRX: -1.6, kneeR: 0.2, shoulderLX: -1.2, torsoX: 0.4 } },
      { ...STAND, clip: { id: 'raise', t: 0.5, mirror: true }, overrides: { torsoZ: 0.5, headY: 0.6 } }
    ]
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      b.group.position.set(2, 0, -3)
      b.group.rotation.y = 0.7
      b.group.scale.setScalar(1.1)
      for (const input of poses) {
        b.animate!(input)
        b.group.updateMatrixWorld(true)
        for (const mesh of skins(b.group)) {
          expect(mesh.computeBoundingBox).not.toBe(THREE.SkinnedMesh.prototype.computeBoundingBox)
          expect(mesh.boundingBox, 'cleared each frame').toBe(null)
          mesh.computeBoundingBox()
          const fast = mesh.boundingBox!.clone()
          THREE.SkinnedMesh.prototype.computeBoundingBox.call(mesh)
          expect([...fast.min.toArray(), ...fast.max.toArray()]).toEqual([...mesh.boundingBox!.min.toArray(), ...mesh.boundingBox!.max.toArray()])
          expect(fast.isEmpty()).toBe(false)
        }
      }
      // And as the export reads it: the world box of the whole bot.
      const world = new THREE.Box3().setFromObject(b.group)
      expect(world.isEmpty()).toBe(false)
    }
  })

  // Fork (main-thread): FBX skins repeat each point per face; each distinct point is skinned once.
  it('a skin whose points repeat has the same box; a point on other bones is not a repeat', () => {
    const b = buildAsset(MALE)
    b.group.position.set(2, 0, -3)
    b.group.rotation.y = 0.7
    for (const mesh of skins(b.group)) {
      const g = mesh.geometry
      const P = g.getAttribute('position').array
      const I = g.getAttribute('skinIndex').array
      const W = g.getAttribute('skinWeight').array
      const n = P.length / 3
      const bones = mesh.skeleton.bones.length
      const pos: number[] = []
      const idx: number[] = []
      const wgt: number[] = []
      // Each point's twin on the next bone first, then every point three times over.
      for (let i = 0; i < n; i++) {
        pos.push(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!)
        idx.push((I[i * 4]! + 1) % bones, 0, 0, 0)
        wgt.push(1, 0, 0, 0)
      }
      for (const i of [...Array(n).keys(), ...Array(n).keys(), ...[...Array(n).keys()].reverse()]) {
        pos.push(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!)
        idx.push(I[i * 4]!, I[i * 4 + 1]!, I[i * 4 + 2]!, I[i * 4 + 3]!)
        wgt.push(W[i * 4]!, W[i * 4 + 1]!, W[i * 4 + 2]!, W[i * 4 + 3]!)
      }
      const rep = new THREE.BufferGeometry()
      rep.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      rep.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
      rep.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
      mesh.geometry = rep
    }
    for (const input of [STAND, { ...STAND, clip: { id: 'raise', t: 0.9 } }, { ...STAND, overrides: { hipRX: -1.6, kneeR: 0.2, shoulderLX: -1.2 } }]) {
      b.animate!(input)
      b.group.updateMatrixWorld(true)
      for (const mesh of skins(b.group)) {
        mesh.computeBoundingBox()
        const fast = mesh.boundingBox!.clone()
        THREE.SkinnedMesh.prototype.computeBoundingBox.call(mesh)
        expect([...fast.min.toArray(), ...fast.max.toArray()]).toEqual([...mesh.boundingBox!.min.toArray(), ...mesh.boundingBox!.max.toArray()])
      }
    }
  })
})
