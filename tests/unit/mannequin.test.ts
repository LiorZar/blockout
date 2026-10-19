import { describe, expect, it } from 'vitest'
import { Box3, Vector3, type BufferGeometry, type Mesh, type MeshLambertMaterial, type Object3D } from 'three'
import { buildAsset, type BuiltAsset } from '@renderer/viewport/builders'
import { personDims } from '@engine/skeleton'

const IDS = ['person.mannequinMale', 'person.mannequinFemale'] as const

function rest(assetId: string): BuiltAsset {
  const b = buildAsset(assetId)
  b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0 })
  b.group.updateMatrixWorld(true)
  return b
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = []
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh)
  })
  return out
}

const tris = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3

function boxOf(root: Object3D, name: string): Box3 {
  const o = root.getObjectByName(name)
  if (!o) throw new Error(`no ${name}`)
  return new Box3().setFromObject(o)
}

/** Front-most world z of a mesh's vertices in the bottom `frac` of its height. */
function frontBelow(root: Object3D, name: string, frac: number): number {
  const m = root.getObjectByName(name) as Mesh
  const box = new Box3().setFromObject(m)
  const yMax = box.min.y + (box.max.y - box.min.y) * frac
  const pos = m.geometry.getAttribute('position')
  const v = new Vector3()
  let front = Infinity
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
    if (v.y <= yMax) front = Math.min(front, v.z)
  }
  return front
}

describe('mannequin builder', () => {
  it('is sculpted from many parts and stays within 8k triangles', () => {
    for (const id of IDS) {
      const ms = meshes(rest(id).group)
      const n = ms.reduce((acc, m) => acc + tris(m.geometry), 0)
      expect(ms.length, id).toBeGreaterThan(25)
      expect(n, id).toBeGreaterThan(3000)
      expect(n, id).toBeLessThanOrEqual(8000)
    }
  })

  it('every mesh is tint-aware and casts a shadow (the deltoid caps only receive one)', () => {
    for (const id of IDS) {
      for (const m of meshes(rest(id).group)) {
        expect(typeof m.userData.origColor, `${id} ${m.name}`).toBe('number')
        expect(m.castShadow, `${id} ${m.name}`).toBe(!m.name.startsWith('deltoid'))
        expect(m.receiveShadow).toBe(true)
      }
    }
  })

  it('the label colour tints it and null restores the grey', () => {
    const b = rest('person.mannequinMale')
    const torso = b.group.getObjectByName('chestMesh') as Mesh
    const mat = torso.material as MeshLambertMaterial
    const grey = mat.color.getHex()
    b.setTint('#ff0000')
    expect(mat.color.r).toBeGreaterThan(mat.color.g + 0.3)
    b.setTint(null)
    expect(mat.color.getHex()).toBe(grey)
  })

  it('builds byte-identical geometry every time', () => {
    for (const id of IDS) {
      const a = meshes(rest(id).group)
      const b = meshes(rest(id).group)
      expect(a.length).toBe(b.length)
      a.forEach((m, i) => {
        expect(Array.from(m.geometry.getAttribute('position').array)).toEqual(Array.from(b[i]!.geometry.getAttribute('position').array))
      })
    }
  })

  it('stands on the ground at its catalog height, facing −Z', () => {
    for (const id of IDS) {
      const b = rest(id)
      const box = new Box3().setFromObject(b.group)
      expect(Math.abs(box.min.y), id).toBeLessThan(0.01)
      expect(Math.abs(box.max.y - b.height), id).toBeLessThan(0.03)
      const nose = boxOf(b.group, 'nose')
      const skull = boxOf(b.group, 'headMesh')
      expect(nose.min.z, id).toBeLessThan(skull.getCenter(new Vector3()).z - 0.08)
      // Toes in front of the heels.
      const foot = boxOf(b.group, 'footR')
      expect(foot.min.z).toBeLessThan(-0.15)
      expect(foot.max.z).toBeGreaterThan(0.04)
    }
  })

  it('each hand surrounds the rig hand point (0, −lowerArmLen, 0) in its elbow group', () => {
    for (const id of IDS) {
      const b = rest(id)
      const dims = personDims(id)
      for (const side of ['L', 'R']) {
        const p = b.group.getObjectByName(`elbow${side}`)!.localToWorld(new Vector3(0, -dims.lowerArmLen, 0))
        const hand = boxOf(b.group, `hand${side}`).expandByScalar(0.01)
        expect(hand.containsPoint(p), `${id} hand${side}`).toBe(true)
      }
    }
  })

  it('male and female read differently: shoulders to hips, waist, bust', () => {
    const measure = (id: string): { shoulders: number; hips: number; waist: number; bust: number } => {
      const g = rest(id).group
      const arms = boxOf(g, 'deltoidL').union(boxOf(g, 'deltoidR'))
      return {
        shoulders: arms.max.x - arms.min.x,
        hips: boxOf(g, 'pelvisMesh').max.x - boxOf(g, 'pelvisMesh').min.x,
        waist: boxOf(g, 'waistMesh').max.x - boxOf(g, 'waistMesh').min.x,
        // How far the chest juts forward of the lower torso.
        bust: frontBelow(g, 'chestMesh', 0.35) - boxOf(g, 'chestMesh').min.z
      }
    }
    const m = measure('person.mannequinMale')
    const f = measure('person.mannequinFemale')
    expect(m.shoulders / m.hips).toBeGreaterThan(f.shoulders / f.hips + 0.2)
    expect(f.hips / f.waist).toBeGreaterThan(m.hips / m.waist + 0.15)
    expect(m.shoulders).toBeGreaterThan(f.shoulders + 0.05)
    expect(f.bust).toBeGreaterThan(m.bust + 0.02)
  })
})
