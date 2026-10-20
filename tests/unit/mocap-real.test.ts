// Fork addition (2026): the real Y Bot / X Bot from the user's local library (skipped without it; nothing from it is stored); see MODIFICATIONS.md.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { buildAsset } from '@renderer/viewport/builders'
import { primaryBones } from '@renderer/mocap/extract'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { jointLocals, mocapPose } from '@engine/mocap/fk'
import { MOCAP_BONES } from '@engine/mocap/rig'
import { clearMocapBodies } from '@engine/mocap/registry'
import { personDims } from '@engine/skeleton'
import { mocapLibraryDir, parseMocapManifest } from '../../src/shared/mocap-library'
import { groundingFailures } from './mocap-ground'

const LIBRARY = mocapLibraryDir()
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))
const BODY = { male: 'person.mocapMale', female: 'person.mocapFemale' } as const

beforeAll(() => {
  if (!HAS_LIBRARY) return
  const manifest = parseMocapManifest(JSON.parse(readFileSync(join(LIBRARY, 'manifest.json'), 'utf-8')))!
  for (const body of ['male', 'female'] as const) {
    const c = manifest.characters.find((x) => x.body === body)!
    const buf = readFileSync(join(LIBRARY, c.file))
    registerMocapTemplate(BODY[body], new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''), c.name)
  }
}, 120_000)

afterAll(() => clearMocapBodies())

describe.skipIf(!HAS_LIBRARY)('the library bots (skipped without the local library)', () => {
  it('render their bones where the engine FK puts them, to 1 mm', () => {
    for (const id of Object.values(BODY)) {
      const b = buildAsset(id)
      const bones = primaryBones(b.group)
      const dims = personDims(id)
      for (const joints of [{ shoulderLX: -1.2, elbowL: 1.4, torsoY: 0.5, headX: 0.3 }, { hipRX: -1, kneeR: 1.6, torsoX: 0.4, rootZ: 0.3 }] as Record<string, number>[]) {
        b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
        b.group.updateMatrixWorld(true)
        const pose = mocapPose(dims.mocap!, jointLocals(joints))
        MOCAP_BONES.forEach((name, i) => expect(bones.get(name)!.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(pose.P[i]!.x, pose.P[i]!.y, pose.P[i]!.z)), `${id} ${name}`).toBeLessThan(0.001))
      }
    }
  }, 60_000)

  it('every gait and library motion keeps the skin on the floor within ±2 cm, every 1/12 s', () => {
    for (const id of Object.values(BODY)) expect(groundingFailures(id, 0.02, 4).slice(0, 20)).toEqual([])
  }, 600_000)
})
