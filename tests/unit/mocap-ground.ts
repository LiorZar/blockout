// Fork addition (2026): grounding checks for mocap bots (rendered skin against the engine's floor proxy); see MODIFICATIONS.md.
import * as THREE from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { ShotEvaluator } from '@engine/evaluate'
import { bodyLowY } from '@engine/floor'
import { GAITS } from '@engine/gaits'
import { MOTION_PRESETS } from '@engine/motions'
import { createEntity, createProject } from '@engine/schema'
import { choreographMotion } from '@engine/sequences'
import type { ActorMark, GaitId } from '@engine/types'

/** Lowest world y of every skinned mesh under `root` (every `stride`-th vertex), skinned on the CPU. */
export function lowestSkinned(root: THREE.Object3D, stride = 1): number {
  root.updateMatrixWorld(true)
  let low = Infinity
  const m = new THREE.Matrix4()
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const pos = mesh.geometry.getAttribute('position').array
    const idx = mesh.geometry.getAttribute('skinIndex').array
    const wgt = mesh.geometry.getAttribute('skinWeight').array
    // Row y of boneWorld · boneInverse · bindMatrix, per bone.
    const rows = mesh.skeleton.bones.map((b, i) => {
      const e = m.multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i]!).multiply(mesh.bindMatrix).elements
      return [e[1]!, e[5]!, e[9]!, e[13]!]
    })
    const n = pos.length / 3
    for (let v = 0; v < n; v += stride) {
      const x = pos[3 * v]!
      const y0 = pos[3 * v + 1]!
      const z = pos[3 * v + 2]!
      let y = 0
      for (let k = 0; k < 4; k++) {
        const w = wgt[4 * v + k]!
        if (w === 0) continue
        const r = rows[idx[4 * v + k]!]!
        y += w * (r[0]! * x + r[1]! * y0 + r[2]! * z + r[3]!)
      }
      if (y < low) low = y
    }
  })
  return low
}

const MOVING: GaitId[] = ['walk', 'jog', 'run']

/**
 * Every gait and every library motion on a bot, sampled every 1/12 s: the
 * rendered skin's lowest point against the floor (gaits) and against the
 * engine's floor proxy (motions, at the evaluator's root height), within
 * `tol`. Returns the failures.
 */
export function groundingFailures(assetId: string, tol = 0.02, stride = 1): string[] {
  const out: string[] = []
  const b = buildAsset(assetId)
  const fail = (what: string, v: number): void => {
    out.push(`${assetId} ${what}: ${(v * 100).toFixed(2)} cm`)
  }
  const gaits: [GaitId, number][] = [['stand', 0], ['gesture', 0], ['walk', 1.4], ['jog', 3], ['run', 5.5], ['crouch', 0], ['crouch', 0.8], ['sit', 0], ['lie', 0], ['fall', 0]]
  for (const [gait, speed] of gaits) {
    const stride0 = GAITS[gait].strideLength
    for (let t = 0; t < 2; t += 1 / 12) {
      const distance = speed * t
      b.animate!({ gait, phase: stride0 > 0 ? (distance / stride0) % 1 : 0, speed, distance, time: t })
      const low = lowestSkinned(b.group, stride)
      const lift = MOVING.includes(gait) && gait !== 'walk' ? 0.065 : 0
      if (low < -tol || low > lift + tol) fail(`${gait}${speed > 0 ? ' moving' : ''} @${t.toFixed(2)}`, low)
    }
  }
  for (const p of MOTION_PRESETS) {
    const doc = createProject('Ground')
    const scene = doc.scenes[0]!
    const e = createEntity(assetId, 'P', { x: 0, y: 0, z: 0 })
    scene.entities.push(e)
    const specs = choreographMotion(p.id, { x: 0, y: 0, z: 0 }, 0, p.duration, 0, { assetId })!
    const marks: ActorMark[] = specs.map((m, i) => ({ id: `m${i}`, ...m, position: { ...m.position } }))
    scene.blocking[0]!.tracks.push({ entityId: e.id, marks })
    const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: p.duration })
    for (let t = 0; t <= p.duration + 1e-9; t += 1 / 12) {
      const st = ev.evaluate(t).entities[0]!
      const stride0 = GAITS[st.gait].strideLength
      b.animate!({ gait: st.gait, phase: stride0 > 0 ? (st.distanceTravelled / stride0) % 1 : 0, speed: st.speed, distance: st.distanceTravelled, time: t, overrides: st.joints })
      const low = st.position.y + lowestSkinned(b.group, stride)
      const bob = st.gait === 'stand' || st.gait === 'gesture' ? Math.sin(t * 1.5) * 0.005 : 0
      const want = st.position.y + bodyLowY({ assetId }, st.joints) + bob
      if (Math.abs(low - want) > tol) fail(`${p.id} @${t.toFixed(2)} vs proxy`, low - want)
      if (low < -tol) fail(`${p.id} @${t.toFixed(2)} below the floor`, low)
    }
  }
  return out
}
