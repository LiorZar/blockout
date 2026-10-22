/**
 * Held weapons in the three.js scene (fork addition; see MODIFICATIONS.md).
 *
 * `heldWeaponMatrix` gives a weapon model's world matrix from the holder's
 * rendered rig: the `elbowL` / `elbowR` group (hand at `(0, −lowerArmLen, 0)`)
 * and, for shouldered long guns, the same side's shoulder group and the
 * torso (a gun's carry at rest is set off it). It uses the
 * engine's grip math (src/engine/weapons.ts), so the rendered weapon and the
 * engine's tip agree exactly. The rig's world matrices must be current. A
 * mocap bot carries the same named frames, set from its FK every frame
 * (renderer/mocap/body.ts), the palm at `(0, −lowerArmLen, 0)`; its hand
 * bone bends at the wrist on a clip, so a bot holds the weapon in its
 * `gripL` / `gripR` frame (the elbow frame's stand-in on the hand bone).
 */

import * as THREE from 'three'
import { heldInElbow, weaponRotation, type Hand, type M3, type WeaponSpec } from '@engine/weapons'
import { holdTurn, poseHoldTurn, turnedRotation } from '@engine/weapon-hold'
import { qtoM3, type Quat } from '@engine/mocap/quat'
import type { PersonDims } from '@engine/skeleton'
import type { V3 } from '@engine/types'
import type { BotHold } from '../mocap/body'

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

/** An object's world rotation, row-major. */
function worldRot(o: THREE.Object3D): M3 {
  const e = tmpRot.extractRotation(o.matrixWorld).elements
  return [e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!]
}

/**
 * held-weapons: a bot's hold turn (`weapon-hold.ts`) for what it shows: on a
 * mark clip or the keyframe rig the engine's own (the evaluator's clip state
 * and joints, so both put the weapon in the same place); on a crouch, sit or
 * lie loop as on a clip, at the loop's clip time; on a travelling gait's
 * loop, measured on the pose as shown, its arms steadied.
 */
function botTurn(person: THREE.Object3D, dims: PersonDims, spec: WeaponSpec, hand: Hand, weaponScale: number): Quat | null {
  const held = person.userData.mocapHold as BotHold | undefined
  if (!dims.mocap || !held) return null
  if (held.kind !== 'gait') return holdTurn(dims, held.overrides, held.clip, spec, hand, weaponScale)
  if (held.loop) return holdTurn(dims, held.overrides, held.loop, spec, hand, weaponScale)
  const q = poseHoldTurn(dims.mocap, held.pose, spec, hand, weaponScale)
  return q[3] > 1 - 1e-12 ? null : q
}

/** World matrix of a weapon model held in `hand` of the rig `person` (null when the rig has no such arm). */
export function heldWeaponMatrix(
  person: THREE.Object3D,
  dims: PersonDims,
  spec: WeaponSpec,
  hand: Hand,
  weaponScale: number,
  out = new THREE.Matrix4()
): THREE.Matrix4 | null {
  const elbow = person.getObjectByName(hand === 'L' ? 'gripL' : 'gripR') ?? person.getObjectByName(hand === 'L' ? 'elbowL' : 'elbowR')
  const shoulder = person.getObjectByName(hand === 'L' ? 'shoulderL' : 'shoulderR')
  const torso = person.getObjectByName('torso')
  if (!elbow || !shoulder) return null
  const turn = botTurn(person, dims, spec, hand, weaponScale)
  if (spec.mount === 'hand') {
    const h = heldInElbow(dims, spec, hand, weaponScale)
    if (turn) {
      // Turned in the grip about the palm (0, −lowerArmLen, 0).
      const c = qtoM3(turn)
      const d = { x: h.t.x, y: h.t.y + dims.lowerArmLen, z: h.t.z }
      const r = [0, 0, 0, 0, 0, 0, 0, 0, 0].map((_, i) => c[3 * Math.floor(i / 3)]! * h.r[i % 3]! + c[3 * Math.floor(i / 3) + 1]! * h.r[3 + (i % 3)]! + c[3 * Math.floor(i / 3) + 2]! * h.r[6 + (i % 3)]!) as M3
      const t = { x: c[0] * d.x + c[1] * d.y + c[2] * d.z, y: c[3] * d.x + c[4] * d.y + c[5] * d.z - dims.lowerArmLen, z: c[6] * d.x + c[7] * d.y + c[8] * d.z }
      return out.multiplyMatrices(elbow.matrixWorld, compose(r, weaponScale, t, tmpLocal))
    }
    return out.multiplyMatrices(elbow.matrixWorld, compose(h.r, weaponScale, h.t, tmpLocal))
  }
  const handW = elbow.localToWorld(new THREE.Vector3(0, -dims.lowerArmLen, 0))
  const shoulderW = shoulder.getWorldPosition(new THREE.Vector3())
  const handRot = worldRot(elbow)
  const r = turnedRotation(weaponRotation(spec, hand, { hand: handW, handRot, shoulder: shoulderW, torso: torso ? worldRot(torso) : undefined }), handRot, turn)
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
  // Fork: a mocap bot steadies its hidden rig and re-poses its bones (renderer/mocap/body.ts).
  const bot = person.userData.mocapSteady as ((side: Hand, overrides: Record<string, number> | undefined) => void) | undefined
  if (bot) return bot(side, overrides)
  const shoulder = person.getObjectByName(side === 'L' ? 'shoulderL' : 'shoulderR')
  const elbow = person.getObjectByName(side === 'L' ? 'elbowL' : 'elbowR')
  if (!shoulder || !elbow) return
  const ov = (k: string): number => overrides?.[k] ?? 0
  if (side === 'L') shoulder.rotation.set(-ov('shoulderLX'), 0, -ov('shoulderLZ'))
  else shoulder.rotation.set(-ov('shoulderRX'), 0, ov('shoulderRZ'))
  elbow.rotation.set(ov(side === 'L' ? 'elbowL' : 'elbowR'), 0, 0)
}
