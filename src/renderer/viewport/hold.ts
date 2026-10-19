/**
 * Held weapons in the three.js scene (fork addition; see MODIFICATIONS.md).
 *
 * `heldWeaponMatrix` gives a weapon model's world matrix from the holder's
 * rendered rig: the `elbowL` / `elbowR` group (hand at `(0, −lowerArmLen, 0)`)
 * and, for shouldered long guns, the same side's shoulder group. It uses the
 * engine's grip math (src/engine/weapons.ts), so the rendered weapon and the
 * engine's tip agree exactly. The rig's world matrices must be current.
 */

import * as THREE from 'three'
import { heldInElbow, weaponRotation, type Hand, type M3, type WeaponSpec } from '@engine/weapons'
import type { PersonDims } from '@engine/skeleton'
import type { V3 } from '@engine/types'

function compose(r: M3, k: number, t: V3, out: THREE.Matrix4): THREE.Matrix4 {
  return out.set(
    r[0] * k, r[1] * k, r[2] * k, t.x,
    r[3] * k, r[4] * k, r[5] * k, t.y,
    r[6] * k, r[7] * k, r[8] * k, t.z,
    0, 0, 0, 1
  )
}

const tmpRot = new THREE.Matrix4()
const tmpLocal = new THREE.Matrix4()

/** World matrix of a weapon model held in `hand` of the rig `person` (null when the rig has no such arm). */
export function heldWeaponMatrix(
  person: THREE.Object3D,
  dims: PersonDims,
  spec: WeaponSpec,
  hand: Hand,
  weaponScale: number,
  out = new THREE.Matrix4()
): THREE.Matrix4 | null {
  const elbow = person.getObjectByName(hand === 'L' ? 'elbowL' : 'elbowR')
  const shoulder = person.getObjectByName(hand === 'L' ? 'shoulderL' : 'shoulderR')
  if (!elbow || !shoulder) return null
  if (spec.mount === 'hand') {
    const h = heldInElbow(dims, spec, hand, weaponScale)
    return out.multiplyMatrices(elbow.matrixWorld, compose(h.r, weaponScale, h.t, tmpLocal))
  }
  const handW = elbow.localToWorld(new THREE.Vector3(0, -dims.lowerArmLen, 0))
  const shoulderW = shoulder.getWorldPosition(new THREE.Vector3())
  const e = tmpRot.extractRotation(elbow.matrixWorld).elements
  const handRot: M3 = [e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!]
  const r = weaponRotation(spec, hand, { hand: handW, handRot, shoulder: shoulderW })
  const k = weaponScale * new THREE.Vector3().setFromMatrixScale(elbow.matrixWorld).x
  const g = spec.grip
  const t = {
    x: handW.x - k * (r[0] * g.x + r[1] * g.y + r[2] * g.z),
    y: handW.y - k * (r[3] * g.x + r[4] * g.y + r[5] * g.z),
    z: handW.z - k * (r[6] * g.x + r[7] * g.y + r[8] * g.z)
  }
  return compose(r, k, t, out)
}

/**
 * Travelling gaits swing the arms in `animatePerson`; an arm holding a weapon
 * keeps its posed rotation instead (the stand-gait mapping of its override
 * channels), so a carried rifle doesn't swing out of the support hand.
 */
export function steadyArm(person: THREE.Object3D, side: Hand, overrides: Record<string, number> | undefined): void {
  const shoulder = person.getObjectByName(side === 'L' ? 'shoulderL' : 'shoulderR')
  const elbow = person.getObjectByName(side === 'L' ? 'elbowL' : 'elbowR')
  if (!shoulder || !elbow) return
  const ov = (k: string): number => overrides?.[k] ?? 0
  if (side === 'L') shoulder.rotation.set(-ov('shoulderLX'), 0, -ov('shoulderLZ'))
  else shoulder.rotation.set(-ov('shoulderRX'), 0, ov('shoulderRZ'))
  elbow.rotation.set(ov(side === 'L' ? 'elbowL' : 'elbowR'), 0, 0)
}
