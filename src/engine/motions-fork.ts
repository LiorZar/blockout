/**
 * Fork motion presets (fork addition; see MODIFICATIONS.md), joined onto
 * `MOTION_PRESETS` at the end of `motions.ts` so upstream's library stays
 * untouched. Same data rules and joint signs as `motions.ts`: every joint a
 * motion touches is in every keyframe.
 *
 * rifle-aim-fire — a shouldered long gun (rifle, shotgun; src/engine/weapons.ts):
 * low ready, mount (stock in the shoulder pocket, elbow down, head down on
 * the stock, support arm out to the fore-end), a short aim hold, the shot,
 * recoil (muzzle up, shoulder rocked back), back on target, low ready. With a
 * held long gun the support hand is placed by `holdJoints`; the left-arm
 * values here are that hand's pose on the 1.78 m man, for an empty-handed
 * preview. The aim levels the barrel within ±2.5° on both body proportions
 * (classic people and the studio mannequins).
 *
 * PURE data: no DOM / three.js / Electron.
 */

import type { MotionPreset } from './motions'

const STANCE = { hipLX: -0.2, kneeL: 0.2, hipRX: 0.1, kneeR: 0.1 }

const LOW_READY = {
  shoulderLX: -0.59, shoulderLZ: -0.51, elbowL: 1.17,
  shoulderRX: 0.2, shoulderRZ: -0.6, elbowR: 2.4,
  torsoX: 0.1, torsoY: -0.29, torsoZ: 0, headX: 0.05, headY: 0, headZ: 0,
  ...STANCE
}

const AIM = {
  shoulderLX: -1.37, shoulderLZ: -0.3, elbowL: 0.74,
  shoulderRX: -0.5, shoulderRZ: -0.59, elbowR: 2.05,
  torsoX: 0.25, torsoY: -0.29, torsoZ: 0, headX: 0.3, headY: 0, headZ: 0.25,
  ...STANCE
}

const RECOIL = { ...AIM, shoulderLX: -1.59, shoulderLZ: -0.31, elbowL: 0.71, shoulderRX: -0.7, torsoX: 0.17, headX: 0.22 }

export const FORK_MOTIONS: MotionPreset[] = [
  {
    id: 'rifle-aim-fire',
    name: 'Rifle Aim & Fire',
    category: 'fight',
    duration: 1.6,
    loop: false,
    keyframes: [
      // Low ready: muzzle down, both hands on the gun.
      { t: 0.0, joints: { ...LOW_READY } },
      // Mount: stock into the shoulder, cheek down on it, barrel level.
      { t: 0.35, joints: { ...AIM } },
      // Hold the aim — the shot breaks at the end of the hold.
      { t: 0.6, joints: { ...AIM } },
      // Recoil: the muzzle jumps and the shoulder rocks back.
      { t: 0.7, joints: { ...RECOIL } },
      // Back on target.
      { t: 0.95, joints: { ...AIM } },
      { t: 1.25, joints: { ...AIM } },
      // Lower to low ready.
      { t: 1.6, joints: { ...LOW_READY } }
    ]
  }
]
