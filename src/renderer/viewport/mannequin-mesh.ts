// Fork addition (2026): sculpted studio-mannequin bodies; see MODIFICATIONS.md.
/**
 * Body parts for the male and female studio mannequins (`buildMannequin` in
 * builders.ts): one smooth plastic body in the look of a game-engine
 * mannequin — full muscle volumes (deltoids, pecs, lats, traps flowing into a
 * thick neck, quads, calves), panel seams on the chest and abdomen, recessed
 * dark joints that only show when a limb bends, kneecaps, palm + thumb +
 * grouped fingers, feet with a heel, and a head with a jaw and a nose ridge so
 * the facing reads. No face details. Every part hangs off the rig's named
 * joint groups at `personDims` positions, so FK (engine skeleton.ts) and every
 * motion stay exact.
 *
 * Conventions as builders.ts: facing −Z, origin at the ground, meshes carry
 * `userData.origColor` for setTint. Deterministic: geometry is a pure
 * function of the dims (no randomness).
 */

import * as THREE from 'three'
import type { PersonDims } from '@engine/skeleton'

export interface MannequinBones {
  pelvis: THREE.Object3D
  torso: THREE.Object3D
  head: THREE.Object3D
  shoulderL: THREE.Object3D
  shoulderR: THREE.Object3D
  elbowL: THREE.Object3D
  elbowR: THREE.Object3D
  hipL: THREE.Object3D
  hipR: THREE.Object3D
  kneeL: THREE.Object3D
  kneeR: THREE.Object3D
}

const BODY = 0xc9c9ce
const JOINT = 0x55555d
const SEAM = 0x7a7a82

/**
 * A cross-section: centre (cx, y, cz), half-extents a along x and b along z,
 * `bump`: how far two rounded bulges either side of the front midline (bust,
 * pecs) push forward (−z), and `back`: how far two bulges either side of the
 * spine (shoulder blades, lats, glutes) push backward (+z).
 */
type Section = [y: number, a: number, b: number, cz?: number, cx?: number, bump?: number, back?: number]

/** Ring angles of the two front bulges (front is −z, i.e. 270°) and the two back ones. */
const BUMP_AT = [(246 * Math.PI) / 180, (294 * Math.PI) / 180]
const BACK_AT = [(55 * Math.PI) / 180, (125 * Math.PI) / 180]
const GLUTES_AT = [(70 * Math.PI) / 180, (110 * Math.PI) / 180]

/** A point on a section's ring at angle t (superellipse exponent e = 2 / n). */
function ringPoint(sec: Section, t: number, e: number, bumpSharpness: number, backAt = BACK_AT): [number, number, number] {
  const [y, a, b, cz = 0, cx = 0, bump = 0, back = 0] = sec
  const c = Math.cos(t)
  const sn = Math.sin(t)
  const lobe = (at: number[], k: number): number => at.reduce((acc, p) => acc + Math.max(0, Math.cos(t - p)) ** k, 0)
  const front = bump ? bump * lobe(BUMP_AT, bumpSharpness) : 0
  const rear = back ? back * lobe(backAt, 4) : 0
  return [cx + a * Math.sign(c) * Math.abs(c) ** e, y, cz + b * Math.sign(sn) * Math.abs(sn) ** e - front + rear]
}

/**
 * Superellipse rings lofted along +Y and capped at both ends. The ring wraps
 * without a duplicate seam column, so computed normals are smooth all round.
 */
function loft(input: Section[], radial: number, n = 2, bumpSharpness = 12, backAt = BACK_AT): THREE.BufferGeometry {
  const sections = input[0]![0] <= input[input.length - 1]![0] ? input : [...input].reverse()
  const e = 2 / n
  const pos: number[] = []
  const idx: number[] = []
  for (const sec of sections) {
    for (let k = 0; k < radial; k++) pos.push(...ringPoint(sec, (k / radial) * Math.PI * 2, e, bumpSharpness, backAt))
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k1 = (k + 1) % radial
      const v00 = i * radial + k
      const v10 = (i + 1) * radial + k
      idx.push(v00, v10, (i + 1) * radial + k1, v00, (i + 1) * radial + k1, i * radial + k1)
    }
  }
  const first = sections[0]!
  const last = sections[sections.length - 1]!
  const bottom = pos.length / 3
  pos.push(first[4] ?? 0, first[0], first[3] ?? 0, last[4] ?? 0, last[0], last[3] ?? 0)
  const lastRing = (sections.length - 1) * radial
  for (let k = 0; k < radial; k++) {
    const k1 = (k + 1) % radial
    idx.push(bottom, k, k1, bottom + 1, lastRing + k1, lastRing + k)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** The section a lofted table passes through at height y (linear, as the mesh is). */
function sectionAt(table: Section[], y: number): Section {
  const t = table[0]![0] <= table[table.length - 1]![0] ? table : [...table].reverse()
  let i = 0
  while (i < t.length - 2 && t[i + 1]![0] < y) i++
  const p = t[i]!
  const q = t[i + 1]!
  const u = Math.min(1, Math.max(0, (y - p[0]) / (q[0] - p[0])))
  const f = (k: number): number => (p[k] ?? 0) + ((q[k] ?? 0) - (p[k] ?? 0)) * u
  return [y, f(1), f(2), f(3), f(4), f(5), f(6)]
}

/**
 * A panel seam: a thin dark tube that lies on a lofted surface through the
 * given (y, angle°) points, lifted just proud of the skin.
 */
function seam(table: Section[], n: number, bumpSharpness: number, path: [y: number, deg: number][], r: number, closed = false): THREE.BufferGeometry {
  const e = 2 / n
  const pts = path.map(([y, deg]) => {
    const sec = sectionAt(table, y)
    const [x, , z] = ringPoint(sec, (deg * Math.PI) / 180, e, bumpSharpness)
    const ox = x - (sec[4] ?? 0)
    const oz = z - (sec[3] ?? 0)
    const len = Math.hypot(ox, oz) || 1
    return new THREE.Vector3(x + (ox / len) * r * 0.4, y, z + (oz / len) * r * 0.4)
  })
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal')
  return new THREE.TubeGeometry(curve, closed ? 32 : Math.max(6, path.length * 4), r, 3, closed)
}

function ellipsoid(rx: number, ry: number, rz: number, w = 12, h = 8): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz)
}

function part(geo: THREE.BufferGeometry, color: number, name: string): THREE.Mesh {
  // A low plastic sheen; the label tint lerps `color` like on every person.
  const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color, specular: 0x2c2c2c, shininess: 36 }))
  m.name = name
  m.castShadow = true
  m.receiveShadow = true
  m.userData.origColor = color
  return m
}

/** Scale a section table: y by `ly`, widths by `lw`, depths and offsets by `ld`. */
function sized(table: Section[], ly: (y: number) => number, lw: number, ld = lw): Section[] {
  return table.map(([y, a, b, cz = 0, cx = 0, bump = 0, back = 0]) => [ly(y), a * lw, b * ld, cz * ld, cx * lw, bump * ld, back * ld])
}

/* Section tables: y in the unit named per table, widths at s = 1, build 1. */

// Pelvis group (hip-joint height); y in s. Briefs-shaped, glutes behind.
const PELVIS_M: Section[] = [
  [-0.086, 0.03, 0.03, 0.006],
  [-0.08, 0.075, 0.062, 0.006],
  [-0.068, 0.118, 0.084, 0.006],
  [-0.05, 0.14, 0.094, 0.008, 0, 0, 0.01],
  [-0.03, 0.152, 0.1, 0.01, 0, 0, 0.016],
  [0.02, 0.16, 0.104, 0.008, 0, 0, 0.012],
  [0.07, 0.148, 0.098, 0.004],
  [0.116, 0.134, 0.09, 0.003]
]
const PELVIS_F: Section[] = [
  [-0.086, 0.03, 0.03, 0.012],
  [-0.08, 0.085, 0.066, 0.014],
  [-0.068, 0.135, 0.09, 0.016],
  [-0.05, 0.163, 0.102, 0.018, 0, 0, 0.016],
  [-0.03, 0.18, 0.11, 0.018, 0, 0, 0.024],
  [0.02, 0.182, 0.106, 0.012, 0, 0, 0.016],
  [0.07, 0.152, 0.094, 0.006],
  [0.116, 0.123, 0.084, 0.004]
]
// Torso group; y as a fraction of torsoLen. Male: V-taper, pecs, lats,
// traps sloping into a thick neck base.
const TORSO_M: Section[] = [
  [0.06, 0.134, 0.09, 0.004],
  [0.12, 0.13, 0.092, 0.002],
  [0.22, 0.128, 0.094, -0.002],
  [0.34, 0.136, 0.098, -0.006],
  [0.46, 0.152, 0.104, -0.01, 0, 0, 0.008],
  [0.56, 0.166, 0.11, -0.012, 0, 0.004, 0.014],
  [0.63, 0.173, 0.112, -0.012, 0, 0.016, 0.018],
  [0.71, 0.178, 0.112, -0.01, 0, 0.021, 0.018],
  [0.79, 0.18, 0.108, -0.006, 0, 0.016, 0.016],
  [0.86, 0.178, 0.1, -0.002, 0, 0.006, 0.012],
  [0.92, 0.175, 0.092, 0.003, 0, 0, 0.008],
  [0.95, 0.168, 0.087, 0.006],
  [0.98, 0.15, 0.081, 0.008],
  [1.02, 0.124, 0.074, 0.011],
  [1.06, 0.098, 0.066, 0.014],
  [1.1, 0.074, 0.058, 0.016]
]
// Female: narrow waist, bust, slimmer shoulders and neck.
const TORSO_F: Section[] = [
  [0.06, 0.12, 0.081, 0.004],
  [0.12, 0.114, 0.08, 0.002],
  [0.24, 0.106, 0.078],
  [0.36, 0.113, 0.082, -0.002],
  [0.45, 0.125, 0.087, -0.004, 0, 0.004],
  [0.5, 0.131, 0.089, -0.005, 0, 0.022],
  [0.56, 0.136, 0.091, -0.006, 0, 0.05],
  [0.62, 0.141, 0.092, -0.006, 0, 0.056],
  [0.68, 0.145, 0.091, -0.005, 0, 0.038],
  [0.74, 0.149, 0.089, -0.004, 0, 0.012, 0.004],
  [0.8, 0.152, 0.086, -0.002, 0, 0.003, 0.006],
  [0.87, 0.151, 0.082, 0, 0, 0, 0.006],
  [0.93, 0.146, 0.076, 0.004],
  [0.96, 0.136, 0.072, 0.006],
  [0.99, 0.12, 0.067, 0.008],
  [1.03, 0.098, 0.06, 0.01],
  [1.07, 0.074, 0.052, 0.012],
  [1.1, 0.058, 0.047, 0.012]
]
// Head group; y relative to the head centre, everything in head radii.
const HEAD_M: Section[] = [
  [-0.99, 0.16, 0.12, -0.5],
  [-0.92, 0.34, 0.3, -0.4],
  [-0.75, 0.5, 0.55, -0.2],
  [-0.52, 0.6, 0.72, -0.07],
  [-0.22, 0.65, 0.81],
  [0.12, 0.68, 0.85, 0.02],
  [0.44, 0.65, 0.83, 0.04],
  [0.72, 0.52, 0.67, 0.05],
  [0.91, 0.31, 0.41, 0.05],
  [1, 0.08, 0.1, 0.05]
]
const HEAD_F: Section[] = [
  [-0.99, 0.13, 0.11, -0.48],
  [-0.92, 0.28, 0.27, -0.38],
  [-0.75, 0.44, 0.52, -0.19],
  [-0.52, 0.56, 0.7, -0.06],
  ...HEAD_M.slice(4)
]
const NOSE: Section[] = [
  [-0.4, 0.05, 0.04, -0.82],
  [-0.34, 0.085, 0.09, -0.86],
  [-0.15, 0.065, 0.09, -0.86],
  [0.08, 0.04, 0.04, -0.8]
]
// Upper arm (shoulder group), under the deltoid; y in upperArmLen. The
// biceps push the centre forward.
const UPPER_ARM: Section[] = [
  [0.0, 0.056, 0.058],
  [-0.18, 0.06, 0.064, -0.004],
  [-0.42, 0.058, 0.066, -0.01],
  [-0.68, 0.05, 0.054, -0.006],
  [-0.88, 0.042, 0.045],
  [-0.985, 0.037, 0.039]
]
// Deltoid cap (shoulder group), y in s, cx outward: broad at the top, blending
// down into the upper arm.
const DELTOID: Section[] = [
  [0.04, 0.016, 0.018],
  [0.036, 0.04, 0.044, 0, 0.004],
  [0.024, 0.06, 0.064, 0, 0.008],
  [0.004, 0.074, 0.078, 0, 0.012],
  [-0.03, 0.076, 0.08, -0.002, 0.014],
  [-0.07, 0.068, 0.072, -0.003, 0.01],
  [-0.11, 0.054, 0.06, -0.004, 0.004],
  [-0.14, 0.042, 0.048, -0.004]
]
// Forearm (elbow group); y in lowerArmLen. Flares below the elbow.
const FOREARM: Section[] = [
  [-0.005, 0.038, 0.04],
  [-0.08, 0.048, 0.05],
  [-0.22, 0.05, 0.047],
  [-0.45, 0.039, 0.036],
  [-0.66, 0.028, 0.031],
  [-0.745, 0.024, 0.029]
]
const WRIST = 0.75 // wrist as a fraction of lowerArmLen
// Hand (elbow group), below the wrist; y in s. a = thickness, b = breadth.
const PALM: Section[] = [
  [-0.005, 0.016, 0.022],
  [-0.02, 0.02, 0.036],
  [-0.055, 0.021, 0.043, -0.002],
  [-0.088, 0.019, 0.043],
  [-0.1, 0.014, 0.036]
]
const FINGERS_1: Section[] = [
  [0.008, 0.012, 0.034],
  [0, 0.0145, 0.039],
  [-0.046, 0.013, 0.037]
]
const FINGERS_2: Section[] = [
  [0.004, 0.012, 0.035],
  [-0.03, 0.011, 0.033],
  [-0.042, 0.008, 0.026],
  [-0.048, 0.004, 0.015]
]
const THUMB_1: Section[] = [
  [0.006, 0.011, 0.012],
  [0, 0.0125, 0.0135],
  [-0.04, 0.011, 0.012]
]
const THUMB_2: Section[] = [
  [0.004, 0.0105, 0.0115],
  [-0.028, 0.009, 0.01],
  [-0.034, 0.005, 0.006]
]
// Thigh (hip group); y in upperLegLen. cx is outward; the quads push forward.
const THIGH_M: Section[] = [
  [-0.1, 0.098, 0.104, -0.01, 0.006],
  [-0.35, 0.09, 0.096, -0.014],
  [-0.62, 0.074, 0.078, -0.008],
  [-0.85, 0.06, 0.062],
  [-0.99, 0.052, 0.054]
]
const THIGH_F: Section[] = [
  [-0.1, 0.1, 0.1, -0.006, 0.01],
  [-0.35, 0.086, 0.09, -0.008],
  [-0.62, 0.068, 0.072, -0.005],
  [-0.85, 0.054, 0.056],
  [-0.99, 0.048, 0.05]
]
// Shin (knee group); y in lowerLegLen. cz is backward (the calf).
const SHIN: Section[] = [
  [-0.1, 0.051, 0.058, 0.01],
  [-0.25, 0.058, 0.072, 0.024],
  [-0.45, 0.048, 0.058, 0.016],
  [-0.68, 0.036, 0.04, 0.006],
  [-0.8, 0.031, 0.034, 0.003]
]
// Foot, lofted heel → toe then laid along −Z: y = distance forward of the
// ankle axis (s), a = half-width, b = half-height (s), cz = centre height (s).
const FOOT: Section[] = [
  [-0.07, 0.02, 0.022, 0.032],
  [-0.058, 0.032, 0.036, 0.038],
  [-0.025, 0.036, 0.05, 0.05],
  [0.03, 0.041, 0.042, 0.042],
  [0.085, 0.047, 0.028, 0.028],
  [0.125, 0.046, 0.02, 0.02],
  [0.16, 0.038, 0.016, 0.016],
  [0.178, 0.02, 0.009, 0.01]
]

/** Panel seams on the front of the torso, as (y fraction, angle°) paths; front centre is 270°. */
const SEAMS_M: [number, number][][] = [
  // Sternum down the centre of the abdomen.
  [[0.88, 270], [0.74, 270], [0.6, 270], [0.42, 270], [0.24, 270], [0.15, 270]],
  // Under the pecs.
  [[0.7, 212], [0.62, 232], [0.585, 252], [0.6, 270], [0.585, 288], [0.62, 308], [0.7, 328]],
  // The two flanks of the abdominal panel.
  [[0.6, 243], [0.44, 245], [0.28, 248], [0.15, 252]],
  [[0.6, 297], [0.44, 295], [0.28, 292], [0.15, 288]],
  // One transverse line across the abs.
  [[0.4, 246], [0.39, 258], [0.385, 270], [0.39, 282], [0.4, 294]],
  // The spine.
  [[1.02, 90], [0.8, 90], [0.55, 90], [0.3, 90], [0.12, 90]]
]
const SEAMS_F: [number, number][][] = [
  [[0.88, 270], [0.76, 270], [0.66, 270], [0.48, 270], [0.32, 270], [0.16, 270]],
  [[0.47, 246], [0.3, 248], [0.16, 252]],
  [[0.47, 294], [0.3, 292], [0.16, 288]],
  [[1.02, 90], [0.8, 90], [0.55, 90], [0.3, 90], [0.12, 90]]
]

/** Add the sculpted body to the rig's joint groups. `build` is the clamped build multiplier. */
export function dressMannequin(bones: MannequinBones, dims: PersonDims, female: boolean, build: number): void {
  const { s, torsoLen, headR, upperArmLen, lowerArmLen, upperLegLen, lowerLegLen } = dims
  const W = s * build
  const limb = female ? 0.86 : 1
  const add = (parent: THREE.Object3D, mesh: THREE.Mesh, x = 0, y = 0, z = 0): THREE.Mesh => {
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  // Pelvis; the torso; a dark core under the waist seam that shows only when
  // the torso bends; the panel seams.
  add(bones.pelvis, part(loft(sized(female ? PELVIS_F : PELVIS_M, (y) => y * s, W), 24, 2.4, 12, GLUTES_AT), BODY, 'pelvisMesh'))
  const waist = (female ? 0.112 : 0.13) * 0.97
  add(
    bones.torso,
    part(loft(sized([[-0.03, waist, waist * 0.66], [0.04, waist * 0.97, waist * 0.66], [0.1, waist, waist * 0.68]], (y) => y * s, W), 16, 2.4), JOINT, 'waistMesh')
  )
  const torsoN = 2.3
  const torsoSharp = female ? 14 : 8
  const torsoTable = sized(female ? TORSO_F : TORSO_M, (y) => y * torsoLen, W)
  add(bones.torso, part(loft(torsoTable, 32, torsoN, torsoSharp), BODY, 'chestMesh'))
  const seamR = 0.0032 * s
  const ringY = 0.064 * torsoLen
  add(bones.torso, part(seam(torsoTable, torsoN, torsoSharp, [0, 90, 180, 270].map((d): [number, number] => [ringY, d]), seamR, true), SEAM, 'seamWaist'))
  ;(female ? SEAMS_F : SEAMS_M).forEach((path, i) => {
    const p = path.map(([y, d]): [number, number] => [y * torsoLen, d])
    add(bones.torso, part(seam(torsoTable, torsoN, torsoSharp, p, seamR), SEAM, `seam${i}`))
  })

  // Neck and head; the head centre is the rig's head point. The neck flares
  // into the traps at its base.
  const hc = headR + 0.06 * s
  const neckW = female ? 0.8 : 1
  add(
    bones.head,
    part(
      loft(sized([[-0.04, 0.074, 0.066, 0.01], [0.01, 0.068, 0.062, 0.008], [0.06, 0.063, 0.058, 0.006], [0.11, 0.056, 0.052, 0.004]], (y) => y * s, W * neckW), 16),
      BODY,
      'neck'
    )
  )
  add(bones.head, part(loft(sized(female ? HEAD_F : HEAD_M, (y) => hc + y * headR, headR), 22, 2.15), BODY, 'headMesh'))
  add(bones.head, part(loft(sized(NOSE, (y) => hc + y * headR, headR), 8), BODY, 'nose'))

  // Arms: a full deltoid cap over a recessed shoulder joint, biceps, elbow
  // and wrist breaks, forearm, hand.
  for (const side of [-1, 1] as const) {
    const L = side < 0 ? 'L' : 'R'
    const shoulder = side < 0 ? bones.shoulderL : bones.shoulderR
    const elbow = side < 0 ? bones.elbowL : bones.elbowR
    const lw = W * limb
    add(shoulder, part(ellipsoid(0.042 * lw, 0.042 * lw, 0.042 * lw, 10, 6), JOINT, `shoulderJoint${L}`), 0, -0.02 * s, 0)
    const delt = sized(DELTOID, (y) => y * s, lw * (female ? 0.94 : 1)).map(([y, a, b, cz, cx]): Section => [y, a, b, cz, (cx ?? 0) * side])
    // No cast shadow: its rim would print a stair-stepped shadow-map edge on the arm.
    add(shoulder, part(loft(delt, 16), BODY, `deltoid${L}`)).castShadow = false
    add(shoulder, part(loft(sized(UPPER_ARM, (y) => y * upperArmLen, lw), 16), BODY, `upperArm${L}`))
    add(elbow, part(ellipsoid(0.034 * lw, 0.034 * lw, 0.034 * lw, 10, 6), JOINT, `elbowJoint${L}`))
    add(elbow, part(loft(sized(FOREARM, (y) => y * lowerArmLen, lw), 16), BODY, `forearm${L}`))
    const yw = -WRIST * lowerArmLen
    add(elbow, part(ellipsoid(0.019 * lw, 0.016 * s, 0.024 * lw, 10, 6), JOINT, `wrist${L}`), 0, yw - 0.004 * s, 0)
    const hw = W * (female ? 0.9 : 1)
    const hl = s * (female ? 0.93 : 1)
    add(elbow, part(loft(sized(PALM, (y) => yw + y * hl, hw), 12, 2.6), BODY, `hand${L}`))
    // Fingers curl toward the palm, which faces the body's midline at rest.
    const medial = -side
    const f1 = new THREE.Group()
    f1.position.set(0, yw - 0.092 * hl, 0)
    f1.rotation.z = medial * 0.75
    elbow.add(f1)
    add(f1, part(loft(sized(FINGERS_1, (y) => y * hl, hw), 12, 2.4), BODY, `fingers${L}`))
    const f2 = new THREE.Group()
    f2.position.set(0, -0.046 * hl, 0)
    f2.rotation.z = medial * 0.9
    f1.add(f2)
    add(f2, part(loft(sized(FINGERS_2, (y) => y * hl, hw), 12, 2.4), BODY, `fingertips${L}`))
    // Thumb along the front edge of the hand, pointing down and forward.
    const t1 = new THREE.Group()
    t1.position.set(medial * 0.006 * hw, yw - 0.022 * hl, -0.03 * hw)
    t1.rotation.set(0.55, 0, medial * 0.35)
    elbow.add(t1)
    add(t1, part(loft(sized(THUMB_1, (y) => y * hl, hw), 8), BODY, `thumb${L}`))
    const t2 = new THREE.Group()
    t2.position.set(0, -0.04 * hl, 0)
    t2.rotation.z = medial * 0.4
    t1.add(t2)
    add(t2, part(loft(sized(THUMB_2, (y) => y * hl, hw), 8), BODY, `thumbTip${L}`))
  }

  // Legs: recessed hip joint, quads flowing out of the pelvis, knee break +
  // kneecap, shin with calf, foot.
  for (const side of [-1, 1] as const) {
    const L = side < 0 ? 'L' : 'R'
    const hip = side < 0 ? bones.hipL : bones.hipR
    const knee = side < 0 ? bones.kneeL : bones.kneeR
    add(hip, part(ellipsoid(0.056 * W, 0.056 * W, 0.056 * W, 10, 6), JOINT, `hipJoint${L}`))
    const top: Section[] = [
      [0.06 * s, (female ? 0.06 : 0.056) * W, (female ? 0.06 : 0.056) * W],
      [0.02 * s, (female ? 0.096 : 0.094) * W, (female ? 0.096 : 0.098) * W]
    ]
    const thigh = sized(female ? THIGH_F : THIGH_M, (y) => y * upperLegLen, W).map(
      ([y, a, b, cz, cx]): Section => [y, a, b, cz, (cx ?? 0) * side]
    )
    add(hip, part(loft([...top, ...thigh], 16), BODY, `thigh${L}`))
    const kw = W * (female ? 0.9 : 1)
    add(knee, part(ellipsoid(0.042 * kw, 0.042 * kw, 0.042 * kw, 10, 6), JOINT, `kneeJoint${L}`))
    add(knee, part(ellipsoid(0.04 * kw, 0.05 * kw, 0.024 * kw, 10, 8), BODY, `kneecap${L}`), 0, 0.008 * s, -0.04 * kw)
    const shin: Section[] = [
      [-0.008 * s, 0.05 * kw, 0.05 * kw],
      ...sized(SHIN, (y) => y * lowerLegLen, kw),
      [-lowerLegLen + 0.085 * s, 0.03 * kw, 0.032 * kw],
      [-lowerLegLen + 0.07 * s, 0.028 * kw, 0.03 * kw]
    ]
    add(knee, part(loft(shin, 16), BODY, `shin${L}`))
    const footGeo = loft(
      FOOT.map(([y, a, b, cz = 0]): Section => [y * s, a * kw, b * s, cz * s]),
      14,
      2.6
    )
      .rotateX(-Math.PI / 2)
      .translate(0, -lowerLegLen, 0)
    add(knee, part(footGeo, BODY, `foot${L}`))
  }
}
