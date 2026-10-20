/**
 * Root-channel motions (fork addition; see MODIFICATIONS.md): library moves
 * that need the whole body to tip, turn over or leave the floor, rebuilt
 * with the root channels (`rootX` pitch, + forward / prone; `rootY` yaw,
 * + counter-clockwise from above; `rootZ` roll, + to the right), which turn
 * the body about the pelvis joint (skeleton.ts `poseFrames`). Same ids,
 * names, categories and durations as the upstream presets they stand for.
 *
 * They are not in `MOTION_PRESETS`: upstream's library keeps its 18 rig
 * joints (round4.test.ts) and the Fight Director keeps playing its own
 * falls. Playback resolves an id through `playableMotion` (apply_motion,
 * the Inspector list, routines, crowd sequences), so the ids users pick play
 * these. Joint signs follow the motions.ts header; every channel a motion
 * touches is in every keyframe (`pose` fills them from REST).
 *
 * `fit` (pose-fit.ts) levels contact groups on the performer's own body
 * before the floor rule rests the lowest point on the floor: push-ups on
 * hands and toes, the crawl on hands and knees, the kneel on the rear knee
 * and the front sole, a lying body on its back (or front) and its feet.
 * `move.forward` keeps the planted feet still while the pelvis travels.
 *
 * PURE data: no DOM / three.js / Electron.
 */

import type { MotionKeyframe, MotionPreset } from './motions'
import type { PoseFit } from './pose-fit'

export interface RootKeyframe extends MotionKeyframe {
  fit?: PoseFit[]
}

export interface RootMotion extends MotionPreset {
  keyframes: RootKeyframe[]
}

/* ------------------------------- fits ---------------------------------- */

/** Plank: hands and toes on the floor. */
const PLANK: PoseFit[] = [{ level: ['hands', 'feet'], by: { rootX: 1 } }]
/** Push-up bottom: the chest 7 cm over the hands' floor, then the plank. */
const PLANK_LOW: PoseFit[] = [{ level: ['torso', 'hands'], by: { elbowL: 1, elbowR: 1 }, gap: 0.07 }, ...PLANK]
/** Hands and knees: the toes beside the knees, then the hands level with them. */
const ON_ALL_FOURS: PoseFit[] = [
  { level: ['knees', 'feet'], by: { kneeL: 1, kneeR: 1 } },
  { level: ['hands', 'knees'], by: { rootX: 1 } }
]
/** Kneel on the right knee: rear toes beside it, front shin vertical with its sole down. */
const KNEEL_R: PoseFit[] = [
  { level: ['kneeR', 'footR'], by: { kneeR: 1 } },
  { level: ['kneeR', 'footL'], by: { hipLX: -1, kneeL: 1 } }
]
/** Both knees down: the toes beside them. */
const KNEELING: PoseFit[] = [{ level: ['knees', 'feet'], by: { kneeL: 1, kneeR: 1 } }]
/** On the back: each leg's foot comes down beside it (a raised knee keeps its sole down). */
const LEGS_DOWN: PoseFit[] = [
  { level: ['footL', 'torso'], by: { hipLX: 1 } },
  { level: ['footR', 'torso'], by: { hipRX: 1 } }
]
/** On the back, arms resting on the floor. */
const SUPINE_FIT: PoseFit[] = [{ level: ['hands', 'torso'], by: { shoulderLX: 1, shoulderRX: 1 } }, ...LEGS_DOWN]
/** On the front: arms, thighs and toes down beside the chest. */
const PRONE_FIT: PoseFit[] = [
  { level: ['hands', 'torso'], by: { shoulderLX: 1, shoulderRX: 1 } },
  { level: ['kneeL', 'torso'], by: { hipLX: 1 } },
  { level: ['kneeR', 'torso'], by: { hipRX: 1 } },
  { level: ['footL', 'kneeL'], by: { kneeL: 1 } },
  { level: ['footR', 'kneeR'], by: { kneeR: 1 } }
]

/* ------------------------------- poses --------------------------------- */

type J = Record<string, number>

/** Every channel the root motions touch, at rest. */
const REST: J = {
  rootX: 0, rootY: 0, rootZ: 0,
  shoulderLX: -0.2, shoulderRX: -0.2, shoulderLZ: 0.1, shoulderRZ: 0.1, elbowL: 0.3, elbowR: 0.3,
  hipLX: 0, hipRX: 0, hipLZ: 0, hipRZ: 0, kneeL: 0.1, kneeR: 0.1,
  torsoX: 0, torsoY: 0, torsoZ: 0, headX: 0, headY: 0, headZ: 0
}

const pose = (j: J): J => ({ ...REST, ...j })

/** Plank on straight arms, hands under the shoulders. */
const PUSH_TOP = pose({ rootX: 1.23, shoulderLX: -1.25, shoulderRX: -1.25, shoulderLZ: 0.15, shoulderRZ: 0.15, elbowL: 0, elbowR: 0, headX: -0.15, kneeL: 0, kneeR: 0 })
/** Chest near the floor, elbows tucked back at 45°. */
const PUSH_LOW = pose({ rootX: 1.47, shoulderLX: 0, shoulderRX: 0, shoulderLZ: 0.6, shoulderRZ: 0.6, elbowL: 2.2, elbowR: 2.2, headX: -0.2, kneeL: 0, kneeR: 0 })

/** Hands and knees: arms and thighs vertical, shins angled up to the toes. */
const CRAWL = pose({ rootX: 1.3, shoulderLX: -1.3, shoulderRX: -1.3, shoulderLZ: 0.1, shoulderRZ: 0.1, elbowL: 0, elbowR: 0, hipLX: -1.3, hipRX: -1.3, kneeL: 1.9, kneeR: 1.9, headX: -0.3 })
/** A crawl step: the left hand and the right knee forward (and the mirror). */
const CRAWL_L = { ...CRAWL, shoulderLX: -1.55, shoulderRX: -1.05, hipLX: -1.05, hipRX: -1.55 }
const CRAWL_R = { ...CRAWL, shoulderLX: -1.05, shoulderRX: -1.55, hipLX: -1.55, hipRX: -1.05 }

/** Down on the right knee, left foot forward. */
const KNEEL = pose({ hipLX: -1.4, kneeL: 1.4, hipRX: 0.05, kneeR: 1.9, torsoX: 0.6, shoulderLX: -0.5, shoulderRX: -0.5, elbowL: 0.6, elbowR: 0.6 })
/** Bent over the front foot, hands at the laces. */
const KNEEL_TIE = { ...KNEEL, torsoX: 0.8, headX: 0.3, shoulderLX: -0.9, shoulderRX: -0.9, elbowL: 1.6, elbowR: 1.6 }

/** Seated (the `sit` gait's pose): thighs level, shins vertical, soles down. */
const SEATED = pose({ hipLX: -1.5, hipRX: -1.5, kneeL: 1.5, kneeR: 1.5, torsoX: 0.05, shoulderLX: -0.2, shoulderRX: -0.2, elbowL: 0.4, elbowR: 0.4 })

/** On the back, arms out, knees soft, chin a little in. */
const SUPINE = pose({ rootX: -1.52, shoulderLX: -0.4, shoulderRX: -0.4, shoulderLZ: 0.7, shoulderRZ: 0.7, elbowL: 0.3, elbowR: 0.3, kneeL: 0.3, kneeR: 0.3, headX: 0.25 })
/** On the front, arms out ahead, head turned. */
const PRONE = pose({ rootX: 1.52, shoulderLX: -2.9, shoulderRX: -2.9, shoulderLZ: 0.3, shoulderRZ: 0.3, elbowL: 0.3, elbowR: 0.3, kneeL: 0.4, kneeR: 0.4, headX: -0.3, headY: 0.8 })
/** On the front, arms limp at the sides, head turned. */
const PRONE_LIMP = pose({ rootX: 1.52, shoulderLX: 0.1, shoulderRX: 0.1, shoulderLZ: 0.2, shoulderRZ: 0.2, elbowL: 0.2, elbowR: 0.2, kneeL: 0.4, kneeR: 0.4, headX: -0.2, headY: -0.9 })

/** Knocked off balance backward: head back, a step back, arms thrown up. */
const REEL_BACK = pose({ rootX: -0.15, shoulderLX: -1.6, shoulderRX: -1.6, shoulderLZ: 0.6, shoulderRZ: 0.6, elbowL: 0.4, elbowR: 0.4, torsoX: -0.4, headX: -0.3, hipLX: -0.4, hipRX: 0.2, kneeL: 0.4, kneeR: 0.2 })
/** The knees give: sitting down backward toward the floor. */
const SIT_FALL = pose({ rootX: -0.5, shoulderLX: -1.0, shoulderRX: -1.0, shoulderLZ: 0.7, shoulderRZ: 0.7, elbowL: 0.6, elbowR: 0.6, torsoX: -0.2, headX: 0.2, hipLX: -1.1, hipRX: -1.1, kneeL: 1.5, kneeR: 1.5 })
/** The back reaches the floor, knees up. */
const BACK_DOWN = { ...SUPINE, rootX: -1.3, hipLX: -0.6, hipRX: -0.6, kneeL: 0.9, kneeR: 0.9, headX: 0.35 }

/* ------------------------------ motions -------------------------------- */

export const ROOT_MOTIONS: RootMotion[] = [
  {
    id: 'push-ups',
    name: 'Push-Ups',
    category: 'sport',
    duration: 1.6,
    loop: true,
    keyframes: [
      { t: 0, joints: { ...PUSH_TOP }, fit: PLANK },
      { t: 0.4, joints: { ...PUSH_LOW }, move: { forward: 0.08 }, fit: PLANK_LOW },
      { t: 0.8, joints: { ...PUSH_TOP }, fit: PLANK },
      { t: 1.2, joints: { ...PUSH_LOW }, move: { forward: 0.08 }, fit: PLANK_LOW },
      { t: 1.6, joints: { ...PUSH_TOP }, fit: PLANK }
    ]
  },
  {
    id: 'crawl',
    name: 'Crawl',
    category: 'stunt',
    duration: 4,
    loop: false,
    keyframes: [
      { t: 0, joints: { ...CRAWL_L }, move: { forward: 0 }, fit: ON_ALL_FOURS },
      { t: 1, joints: { ...CRAWL_R }, move: { forward: 0.55 }, fit: ON_ALL_FOURS },
      { t: 2, joints: { ...CRAWL_L }, move: { forward: 1.1 }, fit: ON_ALL_FOURS },
      { t: 3, joints: { ...CRAWL_R }, move: { forward: 1.65 }, fit: ON_ALL_FOURS },
      { t: 4, joints: { ...CRAWL_L }, move: { forward: 2.2 }, fit: ON_ALL_FOURS }
    ]
  },
  {
    id: 'kneel-tie-shoe',
    name: 'Kneel & Tie Shoe',
    category: 'everyday',
    duration: 2.4,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({}) },
      { t: 0.6, joints: { ...KNEEL }, fit: KNEEL_R },
      { t: 1.2, joints: { ...KNEEL_TIE }, fit: KNEEL_R },
      { t: 1.6, joints: { ...KNEEL_TIE, elbowL: 1.4, elbowR: 1.8 }, fit: KNEEL_R },
      { t: 2.4, joints: pose({}) }
    ]
  },
  {
    id: 'sit-down',
    name: 'Sit Down',
    category: 'gesture',
    duration: 1.6,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({}) },
      // Hips back, knees forward, leaning over the feet.
      { t: 0.6, joints: pose({ hipLX: -0.8, hipRX: -0.8, kneeL: 0.9, kneeR: 0.9, torsoX: 0.35, shoulderLX: -0.4, shoulderRX: -0.4, elbowL: 0.4, elbowR: 0.4 }) },
      { t: 1.1, joints: { ...SEATED } },
      { t: 1.6, joints: { ...SEATED } }
    ]
  },
  {
    id: 'knockdown-fall',
    name: 'Knockdown Fall',
    category: 'fight',
    duration: 1.6,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({ shoulderLX: -0.3, shoulderRX: -0.3, elbowL: 0.4, elbowR: 0.4 }) },
      { t: 0.3, joints: { ...REEL_BACK }, move: { forward: -0.2 } },
      { t: 0.7, joints: { ...SIT_FALL }, move: { forward: -0.35 } },
      { t: 1.1, joints: { ...BACK_DOWN }, move: { forward: -0.5 }, fit: SUPINE_FIT },
      { t: 1.6, joints: { ...SUPINE }, move: { forward: -0.55 }, fit: SUPINE_FIT }
    ]
  },
  {
    id: 'fall-backwards',
    name: 'Fall Backwards',
    category: 'stunt',
    duration: 1.8,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({ shoulderLX: -0.3, shoulderRX: -0.3, elbowL: 0.4, elbowR: 0.4 }) },
      // Off balance: arms wheel up, the torso tips back over the heels.
      { t: 0.4, joints: { ...REEL_BACK, rootX: -0.25, shoulderLX: -2.2, shoulderRX: -2.0, torsoX: -0.3, hipLX: -0.3, hipRX: -0.1 } },
      { t: 0.9, joints: { ...SIT_FALL, rootX: -0.6, shoulderLX: -1.6, shoulderRX: -1.6, shoulderLZ: 0.9, shoulderRZ: 0.9 }, move: { forward: -0.15 } },
      { t: 1.3, joints: { ...BACK_DOWN, rootX: -1.4, shoulderLZ: 0.9, shoulderRZ: 0.9, kneeL: 0.5, kneeR: 0.5, hipLX: -0.4, hipRX: -0.4 }, move: { forward: -0.35 }, fit: SUPINE_FIT },
      { t: 1.8, joints: { ...SUPINE, shoulderLZ: 1.2, shoulderRZ: 1.2 }, move: { forward: -0.4 }, fit: SUPINE_FIT }
    ]
  },
  {
    id: 'stumble-back-fall',
    name: 'Stumble Back & Fall',
    category: 'stunt',
    duration: 1.8,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({ shoulderLX: -0.4, shoulderRX: -0.4, elbowL: 0.4, elbowR: 0.4 }) },
      // Stumbling back a step, arms out for balance.
      { t: 0.3, joints: { ...REEL_BACK, shoulderLX: -1.8, shoulderRX: -1.8, shoulderLZ: 0.7, shoulderRZ: 0.7, hipLX: -0.6, hipRX: 0.3, kneeL: 0.5, kneeR: 0.1 }, move: { forward: -0.25 } },
      // A second step: the knees give.
      { t: 0.7, joints: { ...SIT_FALL, rootX: -0.3, hipLX: -0.8, hipRX: -0.5, kneeL: 1.2, kneeR: 1.3 }, move: { forward: -0.45 } },
      { t: 1.2, joints: { ...BACK_DOWN, rootX: -1.2, shoulderLZ: 0.6, shoulderRZ: 0.6, elbowL: 0.6, elbowR: 0.6 }, move: { forward: -0.65 }, fit: SUPINE_FIT },
      // Flat on the back, one knee up.
      { t: 1.8, joints: { ...SUPINE, shoulderLZ: 0.9, shoulderRZ: 0.9, hipLX: -0.5, kneeL: 1.0, headX: 0.4 }, move: { forward: -0.7 }, fit: SUPINE_FIT }
    ]
  },
  {
    id: 'lie-down-sleep',
    name: 'Lie Down & Sleep',
    category: 'gesture',
    duration: 3,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({}) },
      // Squat down, a hand reaching for the floor.
      { t: 0.9, joints: pose({ hipLX: -1.5, hipRX: -1.5, kneeL: 2.1, kneeR: 2.1, torsoX: 0.5, shoulderLX: -0.6, shoulderRX: -0.3, elbowL: 0.3, elbowR: 0.5, headX: 0.2 }) },
      // Sit back on the floor, legs out, leaning on the hands.
      { t: 1.7, joints: pose({ rootX: -0.8, hipLX: -0.75, hipRX: -0.75, kneeL: 0.5, kneeR: 0.5, torsoX: 0.6, shoulderLX: 0.5, shoulderRX: 0.5, shoulderLZ: 0.2, shoulderRZ: 0.2, elbowL: 0.1, elbowR: 0.1, headX: 0.1 }), move: { forward: -0.3 } },
      // Lie back, hands on the belly.
      { t: 2.4, joints: { ...SUPINE, shoulderLX: -0.5, shoulderRX: -0.5, shoulderLZ: 0.25, shoulderRZ: 0.25, elbowL: 1.6, elbowR: 1.6, kneeL: 0.15, kneeR: 0.15, headX: 0.3 }, move: { forward: -0.3 }, fit: SUPINE_FIT },
      { t: 3, joints: { ...SUPINE, shoulderLX: -0.5, shoulderRX: -0.5, shoulderLZ: 0.25, shoulderRZ: 0.25, elbowL: 1.6, elbowR: 1.6, kneeL: 0.15, kneeR: 0.15, headX: 0.3, headY: 0.3 }, move: { forward: -0.3 }, fit: SUPINE_FIT }
    ]
  },
  {
    id: 'trip-and-fall-flat',
    name: 'Trip and Fall Flat',
    category: 'stunt',
    duration: 1.6,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({ shoulderLX: -0.3, shoulderRX: -0.3, elbowL: 0.4, elbowR: 0.4, torsoX: 0.1, hipLX: 0.2, hipRX: -0.2, kneeL: 0.2, kneeR: 0.3 }) },
      // The foot catches: lurching forward, arms out ahead.
      { t: 0.3, joints: pose({ rootX: 0.35, shoulderLX: -1.8, shoulderRX: -1.8, elbowL: 0.3, elbowR: 0.3, torsoX: 0.3, headX: -0.2, hipLX: -0.6, hipRX: 0.4, kneeL: 0.5, kneeR: 0.7 }), move: { forward: 0.35 } },
      // Falling: hands reach for the floor.
      { t: 0.7, joints: pose({ rootX: 0.95, shoulderLX: -2.3, shoulderRX: -2.3, shoulderLZ: 0.2, shoulderRZ: 0.2, elbowL: 0.3, elbowR: 0.3, torsoX: 0.2, headX: -0.4, hipLX: -0.2, hipRX: 0.3, kneeL: 0.4, kneeR: 0.5 }), move: { forward: 0.75 } },
      { t: 1.1, joints: { ...PRONE }, move: { forward: 1.0 }, fit: PRONE_FIT },
      { t: 1.6, joints: { ...PRONE }, move: { forward: 1.0 }, fit: PRONE_FIT }
    ]
  },
  {
    id: 'ko-collapse',
    name: 'KO Collapse',
    category: 'fight',
    duration: 1.5,
    loop: false,
    keyframes: [
      { t: 0, joints: pose({ shoulderLX: -0.3, shoulderRX: -0.3, elbowL: 0.4, elbowR: 0.4 }) },
      // Out on the feet: head snaps back, knees soften.
      { t: 0.25, joints: pose({ shoulderLX: 0.1, shoulderRX: 0.1, elbowL: 0.3, elbowR: 0.3, torsoX: -0.2, headX: -0.4, kneeL: 0.2, kneeR: 0.2 }) },
      // The knees buckle: down onto both knees, arms limp.
      { t: 0.55, joints: pose({ shoulderLX: 0.3, shoulderRX: 0.3, elbowL: 0.4, elbowR: 0.4, torsoX: 0.3, headX: 0.5, hipLX: -0.2, hipRX: -0.2, kneeL: 1.9, kneeR: 1.9 }), fit: KNEELING },
      // Toppling forward from the knees.
      { t: 0.9, joints: pose({ rootX: 0.8, shoulderLX: 0.3, shoulderRX: 0.3, shoulderLZ: 0.2, shoulderRZ: 0.2, elbowL: 0.4, elbowR: 0.4, torsoX: 0.2, headX: 0.3, hipLX: -0.6, hipRX: -0.6, kneeL: 1.7, kneeR: 1.7 }), move: { forward: 0.2 }, fit: KNEELING },
      { t: 1.5, joints: { ...PRONE_LIMP }, move: { forward: 0.55 }, fit: PRONE_FIT }
    ]
  },
  {
    id: 'get-up-from-ground',
    name: 'Get Up From Ground',
    category: 'fight',
    duration: 2,
    loop: false,
    keyframes: [
      // From the knockdown's end: on the back.
      { t: 0, joints: { ...SUPINE }, fit: SUPINE_FIT },
      // Sit up, feet drawn in, leaning on the hands.
      { t: 0.5, joints: pose({ rootX: -0.9, hipLX: -0.6, hipRX: -0.6, kneeL: 1.4, kneeR: 1.4, torsoX: 0.95, shoulderLX: 0.6, shoulderRX: 0.6, shoulderLZ: 0.25, shoulderRZ: 0.25, elbowL: 0.1, elbowR: 0.1, headX: 0.1 }) },
      // Rock forward onto the feet: a deep squat, hands down.
      { t: 1, joints: pose({ hipLX: -1.6, hipRX: -1.6, kneeL: 2.2, kneeR: 2.2, torsoX: 0.6, shoulderLX: -0.7, shoulderRX: -0.7, elbowL: 0.3, elbowR: 0.3, headX: -0.1 }), move: { forward: 0.5 } },
      { t: 1.5, joints: pose({ hipLX: -0.6, hipRX: -0.6, kneeL: 0.8, kneeR: 0.8, torsoX: 0.35, shoulderLX: -0.5, shoulderRX: -0.5, elbowL: 0.9, elbowR: 0.9 }), move: { forward: 0.55 } },
      { t: 2, joints: pose({}), move: { forward: 0.55 } }
    ]
  }
]

const BY_ID = new Map<string, MotionPreset>(ROOT_MOTIONS.map((m) => [m.id, m]))

/** The preset playback uses for a library entry: its root-channel version when there is one. */
export function playableMotion(p: MotionPreset): MotionPreset {
  return BY_ID.get(p.id) ?? p
}

/** A keyframe's per-body fits (root-channel motions only). */
export function keyframeFit(kf: MotionKeyframe): PoseFit[] | undefined {
  return (kf as RootKeyframe).fit
}
