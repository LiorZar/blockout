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
 * Fight replacements (`FORK_REPLACEMENTS` in fight/moves.ts): a fight plays
 * these under the upstream move id; the upstream data stays as it is.
 * haymaker-swing / elbow-strike-across — `haymaker` / `elbow-strike` with
 * the torso twist of the header: the wind-up turns the striking (right)
 * shoulder back (torsoY < 0), the blow turns it forward.
 * sword-slash-two-hand — `sword-slash-combo` with both hands on the grip:
 * the left fist sits on the pommel side of the right (left arm by IK on the
 * 1.78 m man, ≤ 0.1 m apart on every body), and the torso turns into each
 * slash.
 *
 * Shields (prop.shield in the left hand; mirror for the right): a strapped
 * shield faces its pinky side, so its face points at the threat only while
 * the forearm stands vertical in the frontal plane. These poses keep the
 * forearm's pitch (−torsoX − shoulderLX + elbowL ≈ 3.05–3.15 rad) as the
 * torso digs in or drives forward; the weapon arm stays in guard.
 * shield-block-face replaces `shield-block` (guard → shield up, centre at the
 * upper chest → absorb → guard; a fight's low shield block), shield-block-high
 * the same at head height (a fight's high shield block), shield-brace-face
 * replaces `shield-brace` (set behind a head-high shield, dig in, bash, reset).
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

/** Boxing guard (the fight director's rest pose) with every channel the strikes below touch. */
const GUARD = { shoulderLX: -0.9, shoulderRX: -0.9, shoulderLZ: 0, shoulderRZ: 0, elbowL: 1.8, elbowR: 1.8, torsoX: 0.15, torsoY: 0 }

/** Shield poses: guard plus every leg / head channel they touch, and the shield arm (left) up, face forward. */
const SHIELD_GUARD = { ...GUARD, shoulderLZ: 0, headX: 0, hipLX: 0, hipRX: 0, kneeL: 0, kneeR: 0 }
/** A short lunge, the shield side forward (knees barely bent: the rig doesn't lower the pelvis). */
const SHIELD_STANCE = { hipLX: -0.25, kneeL: 0.2, hipRX: 0.15, kneeR: 0.1 }
const SHIELD_LOW = { ...SHIELD_GUARD, ...SHIELD_STANCE, shoulderLX: -0.8, shoulderLZ: 0.2, elbowL: 2.4, torsoY: -0.15, headX: 0.1 }
const SHIELD_HIGH = { ...SHIELD_GUARD, ...SHIELD_STANCE, shoulderLX: -1.5, shoulderLZ: -0.3, elbowL: 1.8, torsoY: 0.3, headX: 0.1 }
/** Dig in behind it: the torso leans 0.1 further and the shoulder raises 0.1 to keep the face forward. */
const DIG_IN = { torsoX: 0.25, headX: 0.15, hipLX: -0.3, hipRX: 0.25, kneeL: 0.3, kneeR: 0.15 }

/** Two-handed sword ready: blade over the right shoulder, the left fist under the right on the grip. */
const SLASH_READY = { shoulderLX: -1.79, shoulderLZ: -0.84, elbowL: 0.44, shoulderRX: -1.5, shoulderRZ: 0.3, elbowR: 1.5, torsoX: 0.15, torsoY: -0.5 }

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
  },
  {
    id: 'haymaker-swing',
    name: 'Haymaker (Swing)',
    category: 'fight',
    duration: 1.2,
    loop: false,
    keyframes: [
      { t: 0.0, joints: { ...GUARD } },
      // Wind up: the fist cocks back by the ear, the right shoulder turns back.
      { t: 0.3, joints: { ...GUARD, shoulderRX: -0.3, shoulderRZ: 1.1, elbowR: 1.6, torsoX: 0.1, torsoY: -0.8 } },
      // The blow: the arm sweeps round as the torso unwinds, right shoulder forward.
      { t: 0.6, joints: { ...GUARD, shoulderRX: -1.45, shoulderRZ: 0.9, elbowR: 0.25, torsoX: 0.2, torsoY: 0.7 } },
      // Follow-through past centre.
      { t: 0.9, joints: { ...GUARD, shoulderRX: -1.0, shoulderRZ: 0.2, elbowR: 0.6, torsoX: 0.25, torsoY: 0.9 } },
      { t: 1.2, joints: { ...GUARD } }
    ]
  },
  {
    id: 'elbow-strike-across',
    name: 'Elbow Strike (Across)',
    category: 'fight',
    duration: 0.9,
    loop: false,
    keyframes: [
      { t: 0.0, joints: { ...GUARD } },
      // Load: the right elbow cocks up and back, the right shoulder turns back.
      { t: 0.25, joints: { ...GUARD, shoulderRX: -1.1, shoulderRZ: 0.6, elbowR: 2.3, torsoY: -0.5 } },
      // The blow: the elbow snaps across the centreline as the torso turns.
      { t: 0.4, joints: { ...GUARD, shoulderRX: -1.35, shoulderRZ: 0.9, elbowR: 2.2, torsoX: 0.2, torsoY: 0.8 } },
      // Follow-through.
      { t: 0.6, joints: { ...GUARD, shoulderRX: -1.25, shoulderRZ: 0.65, elbowR: 2.2, torsoX: 0.2, torsoY: 1.0 } },
      { t: 0.9, joints: { ...GUARD } }
    ]
  },
  {
    id: 'sword-slash-two-hand',
    name: 'Two-Hand Sword Slash',
    category: 'fight',
    duration: 1.6,
    loop: false,
    keyframes: [
      // Ready: blade cocked over the right shoulder, the right shoulder turned back.
      { t: 0.0, joints: { ...SLASH_READY } },
      // First slash: diagonally down to the left as the torso turns.
      { t: 0.4, joints: { shoulderLX: -0.79, shoulderLZ: -0.5, elbowL: 0.49, shoulderRX: -0.8, shoulderRZ: -0.1, elbowR: 0.7, torsoX: 0.35, torsoY: 0.5 } },
      // Recover: blade up over the left shoulder.
      { t: 0.7, joints: { shoulderLX: -1.68, shoulderLZ: -0.88, elbowL: 0.65, shoulderRX: -1.5, shoulderRZ: 0.3, elbowR: 1.6, torsoX: 0.15, torsoY: 0.5 } },
      // Second slash: diagonally down to the right as the torso turns back.
      { t: 1.1, joints: { shoulderLX: -0.65, shoulderLZ: -0.39, elbowL: 1.01, shoulderRX: -0.9, shoulderRZ: -0.3, elbowR: 0.7, torsoX: 0.35, torsoY: -0.5 } },
      { t: 1.6, joints: { ...SLASH_READY } }
    ]
  },
  {
    id: 'shield-block-face',
    name: 'Shield Block (Face Out)',
    category: 'fight',
    duration: 0.9,
    loop: false,
    keyframes: [
      { t: 0.0, joints: { ...SHIELD_GUARD } },
      // Shield up in front of the chest, face toward the threat, weight set.
      { t: 0.2, joints: { ...SHIELD_LOW } },
      // Absorb the blow: dig in behind it.
      { t: 0.5, joints: { ...SHIELD_LOW, ...DIG_IN, shoulderLX: -0.9 } },
      { t: 0.9, joints: { ...SHIELD_GUARD } }
    ]
  },
  {
    id: 'shield-block-high',
    name: 'Shield Block High',
    category: 'fight',
    duration: 0.9,
    loop: false,
    keyframes: [
      { t: 0.0, joints: { ...SHIELD_GUARD } },
      // Shield up at head height, face toward the threat.
      { t: 0.2, joints: { ...SHIELD_HIGH } },
      { t: 0.5, joints: { ...SHIELD_HIGH, ...DIG_IN, shoulderLX: -1.6 } },
      { t: 0.9, joints: { ...SHIELD_GUARD } }
    ]
  },
  {
    id: 'shield-brace-face',
    name: 'Shield Brace & Bash (Face Out)',
    category: 'fight',
    duration: 1.4,
    loop: false,
    keyframes: [
      // Set behind a head-high shield, weight low.
      { t: 0.0, joints: { ...SHIELD_HIGH, torsoX: 0.3, shoulderLX: -1.65 } },
      // Dig in hard against an impact.
      { t: 0.5, joints: { ...SHIELD_HIGH, torsoX: 0.45, shoulderLX: -1.8, headX: 0.2, hipLX: -0.3, hipRX: 0.3, kneeL: 0.3, kneeR: 0.2 } },
      // Bash: drive the shield out and up, the forearm still upright.
      { t: 0.9, joints: { ...SHIELD_HIGH, torsoX: 0.05, shoulderLX: -1.7, elbowL: 1.5, headX: 0, hipLX: -0.4, hipRX: 0.2, kneeL: 0.15, kneeR: 0.05 } },
      { t: 1.4, joints: { ...SHIELD_HIGH, torsoX: 0.3, shoulderLX: -1.65 } }
    ]
  }
]
