// Fork addition (2026, fight-polish): the weapons' capsules as the fight checks see them, pinned to the built models; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Mesh, Vector3 } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { personDims, toWorld } from '@engine/skeleton'
import { heldWeaponSamples, weaponPieces, weaponSamples } from '@engine/weapon-shape'
import { heldPointLocal, weaponSpec, WEAPON_SPECS } from '@engine/weapons'
import type { V3 } from '@engine/types'

/** Every vertex of a built model (model frame, the group at the origin). */
function vertices(assetId: string): V3[] {
  const g = buildAsset(assetId).group
  g.updateMatrixWorld(true)
  const out: V3[] = []
  const v = new Vector3()
  g.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    const pos = m.geometry.attributes.position!
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      out.push({ x: v.x, y: v.y, z: v.z })
    }
  })
  return out
}

/** How far a point is outside a capsule (negative inside). */
function outside(q: V3, a: V3, b: V3, r: number): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const l2 = ab.x ** 2 + ab.y ** 2 + ab.z ** 2
  const u = l2 > 0 ? Math.min(1, Math.max(0, ((q.x - a.x) * ab.x + (q.y - a.y) * ab.y + (q.z - a.z) * ab.z) / l2)) : 0
  return Math.hypot(q.x - a.x - ab.x * u, q.y - a.y - ab.y * u, q.z - a.z - ab.z * u) - r
}

describe('weapon shapes (fight-polish)', () => {
  it('cover every built weapon to within 1 cm and stay inside its bounds', () => {
    const ids = WEAPON_SPECS.map((w) => w.assetId)
    expect(ids.length).toBeGreaterThanOrEqual(12)
    for (const id of ids) {
      const pieces = weaponPieces(id)
      expect(pieces.length, id).toBeGreaterThan(0)
      const vs = vertices(id)
      const worst = Math.max(...vs.map((q) => Math.min(...pieces.map((p) => outside(q, p.a, p.b, p.r)))))
      expect(worst, id).toBeLessThanOrEqual(0.01)
      // Every axis point inside the model's bounds (a little slack for the round ends).
      const lo = { x: Math.min(...vs.map((q) => q.x)), y: Math.min(...vs.map((q) => q.y)), z: Math.min(...vs.map((q) => q.z)) }
      const hi = { x: Math.max(...vs.map((q) => q.x)), y: Math.max(...vs.map((q) => q.y)), z: Math.max(...vs.map((q) => q.z)) }
      for (const s of weaponSamples(id)) for (const q of s.p) {
        expect(q.x >= lo.x - 0.005 && q.y >= lo.y - 0.005 && q.z >= lo.z - 0.005 && q.x <= hi.x + 0.005 && q.y <= hi.y + 0.005 && q.z <= hi.z + 0.005, `${id} ${JSON.stringify(q)}`).toBe(true)
      }
    }
  })

  it('sit in the hand exactly where heldPointLocal puts the model', () => {
    const dims = personDims('person.male')
    const joints = { shoulderRX: -0.7, shoulderRZ: 0.2, elbowR: 1.1, shoulderLX: -0.4, elbowL: 0.8, torsoY: 0.2 }
    for (const id of ['prop.sword', 'prop.shield', 'prop.rifle']) {
      const spec = weaponSpec(id)!
      for (const hand of ['L', 'R'] as const) {
        const held = heldWeaponSamples(dims, joints, hand, spec, 1.2)
        weaponSamples(id).forEach((s, k) =>
          s.p.forEach((q, i) => {
            const want = heldPointLocal(dims, joints, hand, spec, q, 1.2)
            const got = held[k]!.p[i]!
            expect(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z)).toBeLessThan(1e-9)
          })
        )
        expect(held[0]!.r).toBeCloseTo(weaponSamples(id)[0]!.r * 1.2, 12)
      }
    }
  })

  it('placed in the world, are exactly the entity-local ones through toWorld', () => {
    const dims = personDims('person.male')
    const joints = { shoulderRX: -0.7, shoulderRZ: 0.2, elbowR: 1.1, torsoY: 0.2 }
    const world = { position: { x: 1.3, y: 0.02, z: -4.1 }, heading: 2.4, scale: 1.07 }
    for (const id of ['prop.spear', 'prop.shield']) {
      const spec = weaponSpec(id)!
      const local = heldWeaponSamples(dims, joints, 'R', spec, 1.1)
      const placed = heldWeaponSamples(dims, joints, 'R', spec, 1.1, undefined, world)
      local.forEach((s, k) => {
        expect(placed[k]!.r).toBe(s.r * world.scale)
        s.p.forEach((q, i) => expect(placed[k]!.p[i]).toEqual(toWorld(q, world.position, world.heading, world.scale)))
      })
    }
  })
})
