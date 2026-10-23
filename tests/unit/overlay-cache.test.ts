// Fork addition (main-thread, 2026): the editor overlay's marks and time labels share their geometry, materials and
// textures (a staged bot fight lays ~800 marks), look as the builders make them, and a rebuild never frees the shared
// ones; see MODIFICATIONS.md.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

beforeAll(() => {
  // The builders draw their numbers on a canvas: a stand-in one (no 2D context) is enough here.
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) })
})

const { labelSprite, markMesh } = await import('@renderer/viewport/builders')
const { isShared, sharedLabelSprite, sharedMarkMesh, warmOverlay } = await import('@renderer/viewport/overlay-cache')

/** An object tree's shape: names, types, transforms and the parts' colours. */
function shape(o: THREE.Object3D): unknown {
  const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined
  return {
    name: o.name,
    type: o.type,
    p: o.position.toArray(),
    q: o.quaternion.toArray(),
    s: o.scale.toArray(),
    color: m?.color?.getHexString(),
    box: (o as THREE.Mesh).geometry && !(o instanceof THREE.Sprite) ? (o as THREE.Mesh).geometry.getAttribute('position').array.length : undefined,
    children: o.children.map(shape)
  }
}

describe('shared overlay resources', () => {
  it('a mark is markMesh as the builders make it', () => {
    expect(shape(sharedMarkMesh('#f5a524', 3))).toEqual(shape(markMesh('#f5a524', 3)))
    expect(shape(sharedMarkMesh('#7dd3fc', 12))).toEqual(shape(markMesh('#7dd3fc', 12)))
  })

  it('marks share the tape per colour and the number per index; every resource is flagged shared', () => {
    const a = sharedMarkMesh('#ff0000', 1)
    const b = sharedMarkMesh('#ff0000', 2)
    const c = sharedMarkMesh('#00ff00', 1)
    const meshes = (g: THREE.Group): THREE.Mesh[] => g.children.filter((x): x is THREE.Mesh => x instanceof THREE.Mesh)
    const sprite = (g: THREE.Group): THREE.Sprite => g.children.find((x): x is THREE.Sprite => x instanceof THREE.Sprite)!
    expect(meshes(a).map((m) => m.geometry)).toEqual(meshes(b).map((m) => m.geometry))
    expect(meshes(a)[0]!.material).toBe(meshes(b)[0]!.material)
    expect(meshes(a)[0]!.material).not.toBe(meshes(c)[0]!.material)
    expect(sprite(a).material).toBe(sprite(c).material)
    expect(sprite(a).material).not.toBe(sprite(b).material)
    expect(a).not.toBe(sharedMarkMesh('#ff0000', 1))
    for (const g of [a, b, c]) {
      for (const m of meshes(g)) expect(isShared(m.geometry) && isShared(m.material as THREE.Material)).toBe(true)
      expect(isShared(sprite(g).material) && isShared(sprite(g).material.map)).toBe(true)
    }
    // What a mark doesn't share isn't flagged.
    expect(isShared(markMesh('#ff0000', 1).children[0] as unknown as THREE.Mesh)).toBe(false)
    expect(isShared((markMesh('#ff0000', 1).children[0] as THREE.Mesh).geometry)).toBe(false)
  })

  it('past 24 new numbers in one task, the rest join their marks once the editor idles; a mark rebuilt away gets none', async () => {
    const parent = new THREE.Group()
    const marks = Array.from({ length: 30 }, (_, i) => sharedMarkMesh('#ff0000', 500 + i))
    parent.add(...marks)
    const numbered = (g: THREE.Group): boolean => g.children.some((c) => c instanceof THREE.Sprite)
    expect(marks.map(numbered)).toEqual([...Array(24).fill(true), ...Array(6).fill(false)])
    // Rebuilt away before the idle slice; and the same index again meanwhile waits too.
    parent.remove(marks[29]!)
    const again = sharedMarkMesh('#00ff00', 528)
    parent.add(again)
    await new Promise((r) => setTimeout(r, 20))
    expect(marks.slice(0, 29).map(numbered)).toEqual(Array(29).fill(true))
    expect(numbered(marks[29]!)).toBe(false)
    expect(numbered(again)).toBe(true)
    expect(shape(marks[27]!)).toEqual(shape(markMesh('#ff0000', 527)))
    // The next task makes new numbers at once again.
    expect(numbered(sharedMarkMesh('#ff0000', 600))).toBe(true)
  })

  it('a time label is labelSprite, shared per text and colour', () => {
    const a = sharedLabelSprite('t=1.5s', '#f5a524')
    expect(shape(a)).toEqual(shape(labelSprite('t=1.5s', '#f5a524')))
    expect(sharedLabelSprite('t=1.5s', '#f5a524').material).toBe(a.material)
    expect(sharedLabelSprite('t=1.6s', '#f5a524').material).not.toBe(a.material)
    expect(sharedLabelSprite('t=1.5s', '#7dd3fc').material).not.toBe(a.material)
    expect(isShared(a.material) && isShared(a.material.map)).toBe(true)
    // A clone's own scale: the overlay shrinks its labels without touching the shared one.
    a.scale.multiplyScalar(0.8)
    expect(sharedLabelSprite('t=1.5s', '#f5a524').scale.toArray()).toEqual(labelSprite('t=1.5s', '#f5a524').scale.toArray())
  })

  it("the warm-up compiles the overlay's objects and the chrome it is given, once per renderer and fog, and takes each program into use", async () => {
    const compiled: THREE.Object3D[][] = []
    const compileAsync = (o: THREE.Object3D): Promise<void> => {
      compiled.at(-1)!.push(o)
      return Promise.resolve()
    }
    // One program per material type, as three shares a program between materials of one key.
    const used: string[] = []
    const programs = new Map<string, { getUniforms(): void }>()
    const program = (type: string): { getUniforms(): void } => {
      if (!programs.has(type)) programs.set(type, { getUniforms: () => void used.push(type) })
      return programs.get(type)!
    }
    const properties = { get: (m: THREE.Material) => ({ currentProgram: program(m.type) }) }
    const renderer = { compileAsync, properties } as unknown as THREE.WebGLRenderer
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const box = new THREE.BoxHelper(new THREE.Object3D())
    const gizmo = new THREE.Group()
    const types = (os: THREE.Object3D[]): string[] => {
      const out = new Set<string>()
      for (const o of os) o.traverse((c) => out.add(c.type))
      return [...out].sort()
    }
    const run = (): THREE.Object3D[] => {
      compiled.push([])
      warmOverlay(renderer, scene, camera, [box, gizmo])
      return compiled.at(-1)!
    }
    const first = run()
    expect(first.slice(1)).toEqual([box, gizmo])
    // A mark (tape and number), a time label, a dashed path, a chevron.
    expect(types(first.slice(0, 1))).toEqual(['Group', 'Line', 'Mesh', 'Sprite'])
    expect(run()).toEqual([])
    scene.fog = new THREE.Fog(0x000000, 1, 50)
    expect(run()).toHaveLength(3)
    expect(run()).toEqual([])
    scene.fog = new THREE.FogExp2(0x000000, 0.02)
    expect(run()).toHaveLength(3)
    // Taken into use one at a time while idle: each program of the mark, label, path, chevron and box once a warm-up.
    await new Promise((r) => setTimeout(r, 50))
    expect(new Set(used)).toEqual(new Set(['MeshBasicMaterial', 'SpriteMaterial', 'LineDashedMaterial', 'LineBasicMaterial']))
    expect(used.filter((t) => t === 'LineBasicMaterial')).toHaveLength(3)
  })
})
