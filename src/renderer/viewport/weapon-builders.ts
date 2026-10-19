/**
 * Grey-box weapon builders (fork addition; see MODIFICATIONS.md).
 *
 * Each model is built in the frame its `WeaponSpec` (src/engine/weapons.ts)
 * describes — grip, tip and support points are model coordinates — so the
 * engine's hand math and the rendered prop agree. Unheld, every weapon is an
 * ordinary static prop: blades, shafts and the bow stand on their butt (+Y to
 * the tip), guns stand level on their grip (muzzle toward −Z), the shield
 * stands on its rim facing −Z. Deterministic, origin on the ground.
 */

import * as THREE from 'three'
import type { BuiltAsset } from './builders'

const STEEL = 0xc0c4cc
const DARK = 0x3a2a1a
const WOOD = 0x8a6a42
const GUNMETAL = 0x3c3c44
const POLYMER = 0x2c2c32
const BRASS = 0x8a7a3a

interface TintUserData {
  origColor?: number
}

function tagged(m: THREE.Mesh, color: number): THREE.Mesh {
  m.castShadow = true
  m.receiveShadow = true
  ;(m.userData as TintUserData).origColor = color
  return m
}

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return tagged(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color })), color)
}

/** Cylinder along +Y. */
function cyl(r: number, h: number, color: number, rb = r, seg = 10): THREE.Mesh {
  return tagged(new THREE.Mesh(new THREE.CylinderGeometry(r, rb, h, seg), new THREE.MeshLambertMaterial({ color })), color)
}

/** Cylinder along Z (barrels), centred at (y, z). */
function tube(r: number, len: number, y: number, z: number, color: number): THREE.Mesh {
  const m = cyl(r, len, color)
  m.rotation.x = Math.PI / 2
  m.position.set(0, y, z)
  return m
}

function sphere(r: number, color: number): THREE.Mesh {
  return tagged(new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshLambertMaterial({ color })), color)
}

function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, rx = 0, rz = 0): T {
  o.position.set(x, y, z)
  o.rotation.set(rx, 0, rz)
  return o
}

/** Same contract as builders.ts: tint every mesh toward the label colour, or restore. */
function makeSetTint(root: THREE.Object3D): (color: string | null) => void {
  const tint = new THREE.Color()
  return (color) => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      const orig = (mesh.userData as TintUserData).origColor
      if (!mesh.isMesh || orig === undefined) return
      const mat = mesh.material as THREE.MeshLambertMaterial
      if (color === null) mat.color.setHex(orig)
      else mat.color.setHex(orig).lerp(tint.set(color), 0.65)
    })
  }
}

function katana(g: THREE.Group): void {
  g.add(at(cyl(0.017, 0.27, DARK), 0, 0.135, 0))
  g.add(at(cyl(0.045, 0.012, BRASS, 0.045, 14), 0, 0.282, 0))
  // A slight curve: the upper blade tips back toward the spine (−X).
  g.add(at(box(0.03, 0.38, 0.007, STEEL), 0, 0.48, 0))
  g.add(at(box(0.027, 0.34, 0.007, STEEL), -0.008, 0.82, 0, 0, 0.05))
}

function knife(g: THREE.Group): void {
  g.add(at(box(0.022, 0.11, 0.018, DARK), 0, 0.055, 0))
  g.add(at(box(0.05, 0.01, 0.022, GUNMETAL), 0, 0.115, 0))
  g.add(at(box(0.026, 0.13, 0.004, STEEL), 0.002, 0.185, 0))
  g.add(at(box(0.016, 0.04, 0.004, STEEL), -0.003, 0.268, 0, 0, 0.25))
}

function axe(g: THREE.Group): void {
  g.add(at(cyl(0.016, 0.72, WOOD, 0.018), 0, 0.36, 0))
  g.add(at(box(0.11, 0.07, 0.03, GUNMETAL), 0.05, 0.64, 0))
  g.add(at(box(0.035, 0.17, 0.012, STEEL), 0.125, 0.645, 0))
  g.add(at(box(0.04, 0.05, 0.034, GUNMETAL), -0.03, 0.64, 0))
}

function spear(g: THREE.Group): void {
  g.add(at(cyl(0.016, 1.82, WOOD), 0, 0.91, 0))
  g.add(at(cyl(0.022, 0.05, GUNMETAL), 0, 1.83, 0))
  const head = at(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 4), new THREE.MeshLambertMaterial({ color: STEEL })), 0, 1.95, 0)
  head.scale.z = 0.3
  g.add(tagged(head, STEEL))
}

function staff(g: THREE.Group): void {
  g.add(at(cyl(0.018, 1.7, WOOD), 0, 0.85, 0))
  for (const y of [0.03, 0.2, 0.65, 1.67]) g.add(at(cyl(0.021, 0.06, DARK), 0, y, 0))
}

function shield(g: THREE.Group): void {
  const face = cyl(0.35, 0.03, WOOD, 0.35, 24)
  face.rotation.x = Math.PI / 2
  face.position.set(0, 0.35, 0)
  g.add(face)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.014, 6, 32), new THREE.MeshLambertMaterial({ color: GUNMETAL }))
  rim.position.set(0, 0.35, 0)
  g.add(tagged(rim, GUNMETAL))
  const boss = sphere(0.075, GUNMETAL)
  boss.scale.z = 0.5
  boss.position.set(0, 0.35, -0.02)
  g.add(boss)
  // The handle the fist closes on, and the forearm strap behind the boss.
  g.add(at(box(0.11, 0.025, 0.025, DARK), 0, 0.23, 0.045))
  g.add(at(box(0.13, 0.03, 0.012, DARK), 0, 0.45, 0.03))
}

function pistol(g: THREE.Group): void {
  g.add(at(box(0.03, 0.035, 0.19, GUNMETAL), 0, 0.145, -0.025))
  g.add(at(box(0.026, 0.022, 0.08, POLYMER), 0, 0.117, -0.035))
  g.add(at(box(0.03, 0.12, 0.045, POLYMER), 0, 0.07, 0.035, -0.3))
}

function rifle(g: THREE.Group): void {
  g.add(at(box(0.05, 0.075, 0.32, GUNMETAL), 0, 0.165, 0))
  g.add(tube(0.012, 0.42, 0.165, -0.37, GUNMETAL))
  g.add(at(box(0.056, 0.06, 0.26, POLYMER), 0, 0.15, -0.27))
  g.add(at(box(0.04, 0.085, 0.28, POLYMER), 0, 0.15, 0.3))
  g.add(at(box(0.044, 0.12, 0.03, POLYMER), 0, 0.14, 0.445))
  g.add(at(box(0.03, 0.11, 0.055, GUNMETAL), 0, 0.085, -0.05, 0.25))
  g.add(at(box(0.032, 0.09, 0.04, POLYMER), 0, 0.075, 0.13, -0.3))
  g.add(at(box(0.02, 0.035, 0.04, GUNMETAL), 0, 0.22, 0.03))
}

function shotgun(g: THREE.Group): void {
  g.add(at(box(0.05, 0.07, 0.22, GUNMETAL), 0, 0.165, 0.02))
  g.add(tube(0.017, 0.51, 0.165, -0.345, GUNMETAL))
  g.add(tube(0.013, 0.41, 0.135, -0.295, GUNMETAL))
  g.add(at(box(0.052, 0.05, 0.16, WOOD), 0, 0.135, -0.24))
  g.add(at(box(0.042, 0.1, 0.33, WOOD), 0, 0.14, 0.29, 0.08))
  g.add(at(box(0.032, 0.09, 0.04, WOOD), 0, 0.085, 0.14, -0.3))
}

function bow(g: THREE.Group): void {
  g.add(at(box(0.03, 0.22, 0.04, DARK), 0, 0.75, 0))
  // Limbs bend back toward the archer (+Z); the string sits at brace height behind the grip.
  const lean = 0.3
  const limb = 0.6
  g.add(at(box(0.026, limb, 0.016, WOOD), 0, 0.86 + (limb / 2) * Math.cos(lean), (limb / 2) * Math.sin(lean), lean))
  g.add(at(box(0.026, limb, 0.016, WOOD), 0, 0.64 - (limb / 2) * Math.cos(lean), (limb / 2) * Math.sin(lean), -lean))
  const top = 0.86 + limb * Math.cos(lean)
  const bottom = 0.64 - limb * Math.cos(lean)
  g.add(at(box(0.004, top - bottom, 0.004, 0xd8d8d0), 0, (top + bottom) / 2, limb * Math.sin(lean)))
}

const BUILDERS: Record<string, { height: number; build: (g: THREE.Group) => void }> = {
  'prop.katana': { height: 1.0, build: katana },
  'prop.knife': { height: 0.29, build: knife },
  'prop.axe': { height: 0.72, build: axe },
  'prop.spear': { height: 2.05, build: spear },
  'prop.staff': { height: 1.7, build: staff },
  'prop.shield': { height: 0.7, build: shield },
  'prop.pistol': { height: 0.17, build: pistol },
  'prop.rifle': { height: 0.25, build: rifle },
  'prop.shotgun': { height: 0.25, build: shotgun },
  'prop.bow': { height: 1.44, build: bow }
}

/** True for the weapons this file builds (prop.sword and prop.baseballBat stay in builders.ts). */
export function isWeaponModel(assetId: string): boolean {
  return assetId in BUILDERS
}

export function buildWeapon(assetId: string): BuiltAsset {
  const def = BUILDERS[assetId]!
  const group = new THREE.Group()
  group.name = assetId
  def.build(group)
  return { group, height: def.height, setTint: makeSetTint(group) }
}
