import { describe, expect, it } from 'vitest'
import { Box3, Group, Vector3 } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { heldWeaponMatrix, steadyArm } from '@renderer/viewport/hold'
import { personDims, toWorld } from '@engine/skeleton'
import { WEAPON_SPECS, heldPointLocal, type Hand } from '@engine/weapons'
import { assetSpec } from '@engine/assets'
import { MOTION_PRESETS } from '@engine/motions'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KEYS = ['shoulderLX', 'shoulderRX', 'shoulderLZ', 'shoulderRZ', 'elbowL', 'elbowR', 'torsoX', 'torsoY', 'torsoZ']

describe('weapon models', () => {
  it('build for every weapon, as tall as the catalog says, with grip and tip on the model', () => {
    for (const w of WEAPON_SPECS) {
      const built = buildAsset(w.assetId)
      expect(built.group.name, w.assetId).toBe(w.assetId)
      const box = new Box3().setFromObject(built.group)
      expect(box.min.y, w.assetId).toBeGreaterThanOrEqual(-0.03)
      expect(Math.abs(box.max.y - assetSpec(w.assetId).height), w.assetId).toBeLessThan(0.06)
      for (const p of [w.grip, w.tip, ...(w.support ? [w.support] : [])]) {
        expect(box.distanceToPoint(new Vector3(p.x, p.y, p.z)), `${w.assetId} point`).toBeLessThan(0.02)
      }
    }
  })
})

describe('rendered weapon = engine weapon', () => {
  it('the three.js weapon tip, grip and support equal the engine points (1e-6), every weapon, both hands', () => {
    const rnd = rng(21)
    const poses: (Record<string, number> | undefined)[] = [
      undefined,
      ...MOTION_PRESETS.filter((m) => m.id.startsWith('sword') || m.id.startsWith('rifle') || m.id.startsWith('pistol'))
        .flatMap((m) => m.keyframes.map((k) => k.joints)),
      ...Array.from({ length: 6 }, () => Object.fromEntries(KEYS.map((k) => [k, (rnd() - 0.5) * 2.6])))
    ]
    for (const [assetId, params] of [
      ['person.man', { height: 1.1 }],
      ['person.mannequinFemale', {}]
    ] as [string, Record<string, number>][]) {
      const dims = personDims(assetId, params)
      const person = buildAsset(assetId, params)
      const root = new Group()
      root.add(person.group)
      root.position.set(1.5, 0.2, -2)
      root.rotation.y = 0.8
      root.scale.setScalar(1.15)
      for (const w of WEAPON_SPECS) {
        const weapon = buildAsset(w.assetId).group
        for (const hand of ['L', 'R'] as Hand[]) {
          for (const joints of poses) {
            person.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides: joints })
            root.updateMatrixWorld(true)
            const m = heldWeaponMatrix(person.group, dims, w, hand, 0.9)!
            for (const p of [w.grip, w.tip, ...(w.support ? [w.support] : [])]) {
              const rendered = new Vector3(p.x, p.y, p.z).applyMatrix4(m)
              const engine = toWorld(heldPointLocal(dims, joints, hand, w, p, 0.9), root.position, 0.8, 1.15)
              const d = Math.hypot(rendered.x - engine.x, rendered.y - engine.y, rendered.z - engine.z)
              expect(d, `${assetId} ${w.assetId} ${hand}`).toBeLessThan(1e-6)
            }
          }
          void weapon
        }
      }
    }
  })
})

describe('steady holding arms', () => {
  it('a walking holder weapon arm keeps exactly its stand-gait pose', () => {
    const rnd = rng(4)
    for (const assetId of ['person.man', 'person.mannequinMale']) {
      const person = buildAsset(assetId)
      for (let i = 0; i < 10; i++) {
        const overrides = Object.fromEntries(KEYS.map((k) => [k, (rnd() - 0.5) * 2]))
        person.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides })
        const want = ['shoulderL', 'shoulderR', 'elbowL', 'elbowR'].map((n) => person.group.getObjectByName(n)!.rotation.toArray())
        person.animate!({ gait: i % 2 ? 'walk' : 'run', phase: rnd(), speed: 2, distance: 3, time: 1, overrides })
        steadyArm(person.group, 'L', overrides)
        steadyArm(person.group, 'R', overrides)
        const got = ['shoulderL', 'shoulderR', 'elbowL', 'elbowR'].map((n) => person.group.getObjectByName(n)!.rotation.toArray())
        expect(got, assetId).toEqual(want)
      }
    }
  })
})
