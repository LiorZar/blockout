// Fork addition (2026): a rendered mocap bot fighting on clips — the palm, the toe and a held weapon on the hand and foot bones match the engine (fixture skeleton, synthetic clips); see MODIFICATIONS.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildAsset, type AnimInput } from '@renderer/viewport/builders'
import { heldWeaponMatrix } from '@renderer/viewport/hold'
import { primaryBones } from '@renderer/mocap/extract'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { clearMocapClips, registerMocapClip } from '@engine/mocap/clip'
import { qeuler } from '@engine/mocap/quat'
import { BONE_INDEX } from '@engine/mocap/rig'
import { clearMocapBodies } from '@engine/mocap/registry'
import { personDims, poseEffectors } from '@engine/skeleton'
import { heldPointLocal, weaponSpec } from '@engine/weapons'
import { skinPoints } from '@engine/mocap/surface'
import { toWorld } from '@engine/skeleton'
import type { V3 } from '@engine/types'
import { fixtureCharacter } from './mocap-three-fixture'
import { sweep, syntheticClip } from './mocap-clip-fixture'
import { bent } from './mocap-fight-fixture'

const MALE = 'person.mocapMale'
const FEMALE = 'person.mocapFemale'
const STAND: AnimInput = { gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 }
const far = (a: THREE.Vector3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

beforeAll(() => {
  registerMocapTemplate(MALE, fixtureCharacter())
  registerMocapTemplate(FEMALE, fixtureCharacter(0.93))
  const guard = { shoulderLX: -0.6, elbowL: 1.4, shoulderRX: -0.6, elbowR: 1.4 }
  let src = syntheticClip(MALE, sweep(guard, { ...guard, shoulderRX: -1.4, elbowR: 0.2, kneeR: 0.8, hipRX: -1 }, 13), { inPlace: false })
  src = bent(src, BONE_INDEX.RightHand, qeuler(0.6, 0.2, 0.4))
  src = bent(src, BONE_INDEX.RightFoot, qeuler(-0.7, 0, 0.2))
  registerMocapClip('bentStrike', src)
})

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

describe('a bot fighting on clips, rendered', { timeout: 30_000 }, () => {
  it('its rendered palm and toe are the engine contact points on the bent hand and foot, to 1 mm', () => {
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      const dims = personDims(id)
      for (const t of [0.1, 0.25, 0.4]) {
        const clip = { id: 'bentStrike', t }
        b.animate!({ ...STAND, clip })
        b.group.updateMatrixWorld(true)
        const bones = primaryBones(b.group)
        const w = (name: string): THREE.Vector3 => bones.get(name)!.getWorldPosition(new THREE.Vector3())
        const palm = w('RightHand').lerp(w('RightHandMiddle1'), 0.5)
        const e = poseEffectors(dims, undefined, clip)
        expect(far(palm, e.handR), `${id} palm t=${t}`).toBeLessThan(0.001)
        expect(far(w('RightToeBase'), e.footR), `${id} toe t=${t}`).toBeLessThan(0.001)
      }
    }
  })

  it('the engine skins a bot as three does: every skinned vertex of the head, the torso and a fist, to 0.1 mm', () => {
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      const dims = personDims(id)
      const m = dims.mocap!
      expect(m.rig.skin).toBeDefined()
      const clip = { id: 'bentStrike', t: 0.3 }
      b.animate!({ ...STAND, clip })
      b.group.updateMatrixWorld(true)
      // three's skinned vertices, all of them.
      const rendered: THREE.Vector3[] = []
      b.group.traverse((o) => {
        const mesh = o as THREE.SkinnedMesh
        if (!mesh.isSkinnedMesh) return
        for (let i = 0; i < mesh.geometry.attributes.position!.count; i++) rendered.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld))
      })
      for (const part of ['head', 'body', 'legL']) {
        const pts = skinPoints(m, undefined, clip, part).map((p) => toWorld(p, { x: 0, y: 0, z: 0 }, 0, 1))
        expect(pts.length, part).toBeGreaterThan(5)
        for (const p of pts) expect(Math.min(...rendered.map((r) => far(r, p))), `${id} ${part}`).toBeLessThan(1e-4)
      }
    }
  })

  it('a held weapon sits in the palm and turns with the hand bone, as the engine holds it', () => {
    for (const id of [MALE, FEMALE]) {
      const b = buildAsset(id)
      const dims = personDims(id)
      for (const assetId of ['prop.sword', 'prop.pistol', 'prop.rifle']) {
        const spec = weaponSpec(assetId)!
        const clip = { id: 'bentStrike', t: 0.3 }
        b.animate!({ ...STAND, clip })
        b.group.updateMatrixWorld(true)
        const m = heldWeaponMatrix(b.group, dims, spec, 'R', 1)!
        for (const p of [spec.grip, spec.tip]) {
          const rendered = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m)
          expect(far(rendered, heldPointLocal(dims, undefined, 'R', spec, p, 1, clip)), `${id} ${assetId}`).toBeLessThan(0.001)
        }
      }
    }
  })
})
