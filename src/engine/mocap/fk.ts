/**
 * Forward kinematics of the mocap body kind (fork addition; see
 * MODIFICATIONS.md). The 11-bone rig's local rotations (from the motions.ts
 * joint channels, or read off the renderer's rig groups) act on the fitted
 * A-rest (`rig.ts`): each mixamorig bone takes the world rotation G of the
 * rig bone it stands for, the torso's spread over Spine / Spine1 / Spine2 in
 * thirds and the head's half on Neck, the arms turned out by the bot's
 * `armRest` (a constant abduction under every pose), and its joint follows
 * the A-rest offsets down the hierarchy. A bone's skinning rotation is
 * G · restQ.
 *
 * The frames handed to the FK consumers (`skeleton.ts` `poseFrames`) sit at
 * the joints with G as their rotation, so every rig-frame offset the
 * consumers use (the hand 0, −lowerArmLen, 0 below the elbow, the head
 * centre) lands on the bot's own body.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { Effector, Frame, PoseFrames } from '../skeleton'
import type { V3 } from '../types'
import { BONE_INDEX, FRAME_BONE, FRAME_KEYS, MOCAP_BONES, type MocapRig } from './rig'
import { qeuler, qmul, qpow, qrot, qtoM3, vadd, vscale, vsub, type Quat } from './quat'

/** A bot's body at a height multiplier `k`. */
export interface MocapDims {
  rig: MocapRig
  k: number
}

/** The rig's local rotations (`skeleton.ts` `poseFrames` conventions). */
export interface RigLocals {
  pelvis: Quat
  torso: Quat
  head: Quat
  shoulderL: Quat
  shoulderR: Quat
  elbowL: Quat
  elbowR: Quat
  hipL: Quat
  hipR: Quat
  kneeL: Quat
  kneeR: Quat
}

/** Joint channels → the rig's local rotations (the stand gait, as `poseFrames`). */
export function jointLocals(joints: Record<string, number> | undefined, baseLean = 0): RigLocals {
  const j = (k: string): number => joints?.[k] ?? 0
  return {
    pelvis: qeuler(-j('rootX'), j('rootY'), -j('rootZ')),
    torso: qeuler(baseLean - j('torsoX'), j('torsoY'), -j('torsoZ')),
    head: qeuler(-j('headX'), j('headY'), -j('headZ')),
    shoulderL: qeuler(-j('shoulderLX'), 0, -j('shoulderLZ')),
    shoulderR: qeuler(-j('shoulderRX'), 0, j('shoulderRZ')),
    elbowL: qeuler(j('elbowL'), 0, 0),
    elbowR: qeuler(j('elbowR'), 0, 0),
    hipL: qeuler(-j('hipLX'), 0, -j('hipLZ')),
    hipR: qeuler(-j('hipRX'), 0, j('hipRZ')),
    kneeL: qeuler(-j('kneeL'), 0, 0),
    kneeR: qeuler(-j('kneeR'), 0, 0)
  }
}

/** A posed bot: per core bone (MOCAP_BONES order) its joint and rig rotation G, entity-local before the root transform. */
export interface MocapPose {
  P: V3[]
  G: Quat[]
  /** Phase 2: the bones beyond the core (`rig.extra`: fingers), when the pose turns them; else they ride their core bone. */
  XP?: V3[]
  XG?: Quat[]
}

const I = BONE_INDEX

export function mocapPose(m: MocapDims, L: RigLocals): MocapPose {
  const gp = L.pelvis
  const gt = qmul(gp, L.torso)
  const gh = qmul(gt, L.head)
  // The rest abduction: outward is −Z on the left arm, +Z on the right (the rig's shoulder Z channels).
  const half = m.rig.armRest / 2
  const gsl = qmul(gt, qmul(L.shoulderL, [0, 0, -Math.sin(half), Math.cos(half)]))
  const gsr = qmul(gt, qmul(L.shoulderR, [0, 0, Math.sin(half), Math.cos(half)]))
  const gel = qmul(gsl, L.elbowL)
  const ger = qmul(gsr, L.elbowR)
  const ghl = qmul(gp, L.hipL)
  const ghr = qmul(gp, L.hipR)
  const gkl = qmul(ghl, L.kneeL)
  const gkr = qmul(ghr, L.kneeR)
  const G: Quat[] = new Array(MOCAP_BONES.length)
  G[I.Hips] = gp
  G[I.Spine] = qmul(gp, qpow(L.torso, 1 / 3))
  G[I.Spine1] = qmul(gp, qpow(L.torso, 2 / 3))
  G[I.Spine2] = gt
  G[I.Neck] = qmul(gt, qpow(L.head, 0.5))
  G[I.Head] = gh
  G[I.LeftShoulder] = gt
  G[I.RightShoulder] = gt
  G[I.LeftArm] = gsl
  G[I.RightArm] = gsr
  G[I.LeftForeArm] = gel
  G[I.LeftHand] = gel
  G[I.RightForeArm] = ger
  G[I.RightHand] = ger
  G[I.LeftUpLeg] = ghl
  G[I.RightUpLeg] = ghr
  G[I.LeftLeg] = gkl
  G[I.LeftFoot] = gkl
  G[I.LeftToeBase] = gkl
  G[I.RightLeg] = gkr
  G[I.RightFoot] = gkr
  G[I.RightToeBase] = gkr
  const { rig, k } = m
  const P: V3[] = new Array(MOCAP_BONES.length)
  for (let i = 0; i < MOCAP_BONES.length; i++) {
    const par = rig.parent[i]!
    P[i] = par < 0 ? vscale(rig.rest[i]!, k) : vadd(P[par]!, qrot(G[par]!, vscale(rig.offset[i]!, k)))
  }
  return { P, G }
}

/** Skinning world rotations (G · restQ) per core bone. */
export function boneWorld(m: MocapDims, pose: MocapPose): Quat[] {
  return pose.G.map((g, i) => qmul(g, m.rig.restQ[i]!))
}

/** The consumers' frames for a pose (see the module header). */
export function poseFramesOf(m: MocapDims, pose: MocapPose): PoseFrames {
  const out = {} as Record<string, Frame>
  for (const f of FRAME_KEYS) {
    const b = I[FRAME_BONE[f]]
    const off = vscale(vsub(m.rig.origin[f], m.rig.rest[b]!), m.k)
    out[f] = { p: vadd(pose.P[b]!, qrot(pose.G[b]!, off)), r: qtoM3(pose.G[b]!) }
  }
  return out as PoseFrames
}

export function mocapFrames(m: MocapDims, joints: Record<string, number> | undefined): PoseFrames {
  return poseFramesOf(m, mocapPose(m, jointLocals(joints)))
}

function point(f: Frame, x: number, y: number, z: number): V3 {
  const r = f.r
  return { x: f.p.x + r[0] * x + r[1] * y + r[2] * z, y: f.p.y + r[3] * x + r[4] * y + r[5] * z, z: f.p.z + r[6] * x + r[7] * y + r[8] * z }
}

/** Effectors of a posed bot: the rig's formulas on the bot's frames, the toe at the ball of the foot. */
export function mocapEffectors(m: MocapDims, joints: Record<string, number> | undefined): Record<Effector, V3> {
  return effectorsOf(m, mocapFrames(m, joints))
}

/**
 * Effectors from a bot's frames (any pose: rig or clip). Phase 3: the palm
 * and the toe ride the hand and foot bones (`wrist*` / `ankle*` frames), as
 * the rendered body does; on a keyframe pose those are rigid with the
 * forearm and shin, so the points are the rig's.
 */
export function effectorsOf(m: MocapDims, fr: PoseFrames): Record<Effector, V3> {
  const d = m.rig.dims
  const k = m.k
  const { toe, palm } = m.rig
  return {
    handL: point(fr.wristL!, palm.L.x * k, palm.L.y * k, palm.L.z * k),
    handR: point(fr.wristR!, palm.R.x * k, palm.R.y * k, palm.R.z * k),
    elbowL: fr.elbowL.p,
    elbowR: fr.elbowR.p,
    footL: point(fr.ankleL!, toe.L.x * k, toe.L.y * k, toe.L.z * k),
    footR: point(fr.ankleR!, toe.R.x * k, toe.R.y * k, toe.R.z * k),
    kneeL: fr.kneeL.p,
    kneeR: fr.kneeR.p,
    head: point(fr.head, 0, (d.headR + 0.06 * d.s) * k, 0),
    chest: point(fr.torso, 0, 0.55 * d.torsoLen * k, 0),
    pelvis: fr.pelvis.p,
    shoulderL: fr.shoulderL.p,
    shoulderR: fr.shoulderR.p
  }
}
