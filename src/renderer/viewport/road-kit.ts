/**
 * The open road's meshes (fork addition, street-kit; see MODIFICATIONS.md):
 * draws src/engine/road-kit.ts's layout. Grouped boxes (a building and its
 * bands, a lamp's arm and head) merge into one vertex-coloured mesh, and the
 * dashes into one, so the set readers (routine-set.ts, fight-obstacles.ts)
 * see a building as one box and the kit stays a few hundred draws long.
 * Deterministic: the layout is a pure function of the length.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { roadLayout, type RoadBox } from '@engine/road-kit'

/** Meshes keep their original colour for builders.ts setTint. */
const tinted = (m: THREE.Mesh, color: number): THREE.Mesh => {
  ;(m.userData as { origColor?: number }).origColor = color
  return m
}

function boxGeometry(b: RoadBox): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(b.w, b.h, b.d)
  g.translate(b.x, b.y, b.z)
  return g
}

/** Boxes as one mesh, each box's colour in its vertices. */
function merged(boxes: RoadBox[]): THREE.Mesh {
  const parts = boxes.map((b) => {
    const g = boxGeometry(b)
    const c = new THREE.Color(b.color)
    const n = g.getAttribute('position').count
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return g
  })
  const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }))
  for (const g of parts) g.dispose()
  return tinted(m, 0xffffff)
}

function single(b: RoadBox): THREE.Mesh {
  if (b.part === 'ground') {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.d), new THREE.MeshLambertMaterial({ color: b.color }))
    m.rotation.x = -Math.PI / 2
    m.position.set(b.x, b.y, b.z)
    return tinted(m, b.color)
  }
  if (b.part === 'pole') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(b.w * 0.4, b.w * 0.5, b.h, 10), new THREE.MeshLambertMaterial({ color: b.color }))
    m.position.set(b.x, b.y, b.z)
    return tinted(m, b.color)
  }
  const m = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), new THREE.MeshLambertMaterial({ color: b.color }))
  m.position.set(b.x, b.y, b.z)
  return tinted(m, b.color)
}

/** The open road with `length` m of drivable asphalt, the street along the group's Z. */
export function openRoadGroup(length: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'env.openRoad'
  const boxes = roadLayout(length)
  const groups = new Map<number, RoadBox[]>()
  const dashes: RoadBox[] = []
  for (const b of boxes) {
    if (b.part === 'dash') dashes.push(b)
    else if (b.group !== undefined) groups.set(b.group, [...(groups.get(b.group) ?? []), b])
    else group.add(single(b))
  }
  for (const parts of groups.values()) group.add(merged(parts))
  if (dashes.length > 0) group.add(merged(dashes))
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    // Flat pieces only take shadows; standing ones cast them too.
    m.geometry.computeBoundingBox()
    const bb = m.geometry.boundingBox!
    m.castShadow = m.geometry.type !== 'PlaneGeometry' && bb.max.y - bb.min.y > 0.2
    m.receiveShadow = true
  })
  return group
}
