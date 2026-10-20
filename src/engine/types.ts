// Modified in this fork (2026): CameraMark.shot (live shot words), Scene.fights, ActorMark.lockFacing, ActorMark.posedMove, Entity.heldBy (weapons); see MODIFICATIONS.md.
/**
 * Blockout document model.
 *
 * A Project owns Scenes. A Scene owns the stage (entities), master blocking
 * takes, and Shots. A Shot owns a camera (marks + rig) and references a
 * blocking take — this is the coverage model: the action stays put, the
 * camera moves between shots.
 *
 * Everything here is plain serializable data. Time is in seconds, distance
 * in meters, angles in radians unless suffixed Deg.
 */

import type { ShotSpec } from './shot'

export interface V3 {
  x: number
  y: number
  z: number
}

export type EntityCategory =
  | 'people'
  | 'animals'
  | 'vehicles'
  | 'furniture'
  | 'props'
  // Fork: holdable weapons (src/engine/weapons.ts).
  | 'weapons'
  | 'environment'
  | 'primitives'
  | 'custom'

export type GaitId =
  | 'stand'
  | 'walk'
  | 'jog'
  | 'run'
  | 'sit'
  | 'lie'
  | 'crouch'
  | 'gesture'
  | 'fall'

export type LightingPresetId =
  | 'day'
  | 'goldenHour'
  | 'night'
  | 'interiorWarm'
  | 'interiorCool'
  | 'club'
  // Physical-sky presets: a real atmospheric-scattering sky dome lit from the
  // scene's sunAzimuth/sunElevation. Fully deterministic (fixed turbidity /
  // rayleigh per preset) so they render byte-identically in clean exports.
  | 'middaySky'
  | 'goldenHourSky'
  | 'blueHourSky'

export type RigId =
  | 'sticks'
  | 'dolly'
  | 'steadicam'
  | 'handheld'
  | 'crane'
  | 'drone'
  | 'carMount'

export type SensorId = 'super16' | 'super35' | 'fullFrame' | 'imax65'

export type ShotSizeId = 'EWS' | 'WS' | 'FS' | 'MS' | 'MCU' | 'CU' | 'ECU'

export type AspectId = '16:9' | '9:16' | '2.39:1' | '4:3' | '1:1'

export interface Label {
  text: string
  /** Hex color like '#e5484d'; tints the model and colors marks/labels. */
  color: string
}

export interface Transform {
  position: V3
  /** Yaw around +Y. Entities are upright; full rotation lives on marks/camera. */
  rotationY: number
  scale: number
}

export interface Entity {
  id: string
  /** Catalog asset id, e.g. 'person.man', 'vehicle.suv', or 'custom.<uuid>'. */
  assetId: string
  name: string
  label?: Label
  transform: Transform
  /** Per-asset parameters (height/build sliders, color variants). */
  params?: Record<string, number | string>
  /** For custom imports: path relative to project assets/ dir. */
  sourceFile?: string
  /**
   * Marriage: when set, this entity rides the named entity — it follows the
   * parent's motion (blocking marks, gizmo drags) at a fixed local offset.
   * A married entity with its own marks ignores the marriage while tracked.
   */
  attachedTo?: string
  /** Local offset in the parent's frame (position + yaw), captured at marry time. */
  attachedLocal?: { x: number; y: number; z: number; rotY: number }
  /** Hide this entity in every export pass (still visible in the editor). */
  excludeFromExport?: boolean
  /**
   * Fork (weapons): this weapon is in a person's hand and follows it through
   * every motion (src/engine/weapons.ts). Wins over marks and marriages; a
   * dangling link is dropped on load.
   */
  heldBy?: HeldBy
}

/** Fork (weapons): who holds a weapon, and in which hand. */
export interface HeldBy {
  entityId: string
  hand: 'L' | 'R'
}

/** Shared mark fields. A mark = a position an entity/camera hits at a time. */
export interface MarkBase {
  id: string
  /** Arrival time in seconds from shot start. */
  time: number
  /** Seconds to remain at the mark after arrival. */
  hold: number
  /** 0..1 fraction of travel eased at departure / arrival. */
  easeIn: number
  easeOut: number
  position: V3
  /**
   * Optional waypoints shaping the path from the PREVIOUS mark to this one
   * (catmull-rom through prev → via… → this).
   */
  via?: V3[]
}

export interface ActorMark extends MarkBase {
  /** Gait adopted when travelling TOWARD this mark. */
  gait: GaitId
  /** If set, face this heading (yaw) on arrival; otherwise keep travel heading. */
  arriveHeading?: number
  /**
   * Per-joint pose offsets (radians) held AT this mark and interpolated
   * while travelling between marks — keyframed limb choreography for
   * fight/dance blocking. Keys match the renderer's joint override names
   * (shoulderLX, elbowR, torsoX, headY, …). Missing keys read as 0.
   */
  joints?: Record<string, number>
  /**
   * Boarding: on arriving at this mark, attach to the named entity for the
   * rest of the shot — walk to the bus door, then ride the bus. The offset
   * is captured from this mark's position relative to the vehicle at that
   * moment. Marks after a boarding mark are ignored while attached.
   */
  attachTo?: string
  /**
   * Fork (fight director): while travelling toward this mark, face the blend
   * of the previous mark's and this mark's arriveHeading instead of turning to
   * the travel direction, and keep this mark's own gait (a 'stand' mark
   * slides in pose instead of walking). Lets a fighter back off facing the
   * opponent and keeps the posed rig exact at impact frames.
   */
  lockFacing?: boolean
  /**
   * Fork (motion playback): a motion keyframe. On a leg between two of them
   * the performer keeps its facing and this mark's gait, as with lockFacing,
   * and the body's lowest point travels straight between the keyframes so a
   * body folding onto the floor never dips through it. Travel legs into or
   * out of a motion behave as upstream.
   */
  posedMove?: boolean
}

export interface CameraMark extends MarkBase {
  /** Orientation at this mark. */
  pan: number
  tilt: number
  roll: number
  focalLength: number
  /** Focus distance in meters; undefined = deep focus. */
  focusDistance?: number
  /**
   * Shot words (fork): when set, this mark's pose is re-solved from the
   * subjects' live positions every frame (src/engine/shot-track.ts); the
   * stored position/pan/tilt/roll/focalLength are the fallback.
   */
  shot?: ShotSpec
}

export interface EntityTrack {
  entityId: string
  marks: ActorMark[]
}

/**
 * A blocking take: the choreography of every moving entity. Scene owns takes;
 * shots reference one, so coverage shares blocking. A shot that needs a
 * variant forks the take.
 */
export interface BlockingTake {
  id: string
  name: string
  tracks: EntityTrack[]
}

export interface ShotCamera {
  sensorId: SensorId
  rig: RigId
  /** 0..1, scales rig noise (handheld shake amount, steadicam drift). */
  rigIntensity: number
  /** Seed for rig noise — stored so exports are reproducible. */
  seed: number
  /** Entity to parent the camera to (carMount rig). */
  mountEntityId?: string
  /**
   * Aim lock: keep the camera pointed at this entity no matter how the
   * position moves (marks, recorded flights, presets). Pan/tilt from marks
   * are ignored while set; roll and lens still apply. Focus follows the
   * subject when no mark sets a focusDistance.
   */
  trackEntityId?: string
  marks: CameraMark[]
}

export interface ReferenceVideo {
  /** Path relative to project folder. */
  path: string
  opacity: number
  mode: 'ghost' | 'pip'
  /** Seconds added to shot time when sampling the video. */
  timeOffset: number
}

export interface Shot {
  id: string
  /** Film-style name, e.g. '1A'. */
  name: string
  duration: number
  fps: number
  aspect: AspectId
  blockingTakeId: string
  /** The ACTIVE camera (playback + export always use this one). */
  camera: ShotCamera
  /** Name of the active camera: 'A', 'B', 'C'… (default 'A'). */
  cameraName?: string
  /** Inactive cameras — switch via the camera inspector (Cam A/B/C chips). */
  cameraBank?: { name: string; camera: ShotCamera }[]
  notes?: string
  referenceVideo?: ReferenceVideo
  /** Set on shots living in scene.drafts: the main shot this is a version of. */
  draftOf?: string
}

export interface SceneEnvironment {
  lighting: LightingPresetId
  /** Sun/key direction. */
  sunAzimuth: number
  sunElevation: number
  /** 0..1 atmosphere density. */
  fog: number
}

/**
 * A Gaussian-splat / photogrammetry scan of a real location, imported as a
 * blocking environment. Scan a place with a phone (Polycam/Luma/Scaniverse)
 * or any video-to-3D tool and block the action inside it. Editor-only: scans
 * are a staging aid and are hidden in every export pass so the deterministic
 * motion-reference package stays grey-box and byte-reproducible (they are
 * listed in metadata.json for the downstream generator's context).
 */
export interface ScanRef {
  id: string
  name: string
  /** Project-relative path, always 'scans/<file>' (.ply/.splat/.spz/.ksplat). */
  file: string
  /** World position of the scan's origin. */
  position: V3
  /** Yaw around +Y (radians). */
  rotationY: number
  /** Uniform scale. */
  scale: number
  /** Hidden in the editor viewport when false (still never exported). */
  visible: boolean
  /**
   * Pitch the scan 180° — many .splat exports (antimatter15-format tools)
   * are Y-down and load upside-down; this rights them without re-processing.
   */
  flipped?: boolean
  /**
   * Reserved for a future holdout/matte pass — when true the scan would be
   * treated as an occluder rather than visible geometry. Parsed and preserved
   * but not yet acted on.
   */
  holdout?: boolean
}

/** Fight director (fork; src/engine/fight/): how one blow of a beat ends. */
export type FightOutcome = 'hit' | 'block' | 'parry' | 'slip' | 'duck' | 'miss' | 'ko'

/** One scripted blow: `<who> <move> [to head|body|legs] [-> outcome, …] [power p] [at t s]`. */
export interface FightBeat {
  /** Index into FightDoc.fighterIds. */
  attacker: 0 | 1
  /** Motion id of the strike. */
  move: string
  target: 'head' | 'body' | 'legs'
  /** One per impact; shorter lists pad with 'block' for earlier impacts. */
  outcomes: FightOutcome[]
  /** 0.2..1, default 0.7. */
  power: number
  /** Explicit start time (s). */
  at?: number
}

/** A scripted two-fighter fight, solved into ordinary actor marks. */
export interface FightDoc {
  id: string
  name: string
  fighterIds: [string, string]
  beats: FightBeat[]
  /** Default 0.4. */
  startT: number
  origin: { x: number; z: number; heading: number }
  /** Default 0.35 s between a beat's recovery and the next step-in. */
  beatGap: number
  /** Default 1.5, range 1..3. */
  exaggeration: number
  coverage?: 'master' | 'punch-in' | 'over-shoulder' | 'follow'
}

export interface Scene {
  id: string
  name: string
  number: number
  environment: SceneEnvironment
  entities: Entity[]
  /** Imported Gaussian-splat / photogrammetry environments (editor-only). */
  scans?: ScanRef[]
  /** Scripted fights (fork; the Fight Director). Their solved marks live in the blocking takes. */
  fights?: FightDoc[]
  blocking: BlockingTake[]
  shots: Shot[]
  /**
   * Draft versions of shots (experiments — "1A v1", "1A v2"). Full Shot
   * objects with draftOf pointing at the main shot; playable and exportable
   * like any shot, listed separately in the rail, promotable back.
   */
  drafts?: Shot[]
}

export interface ProjectDoc {
  /** Schema version for forward migration. */
  version: 1
  id: string
  name: string
  settings: {
    defaultProfileId: string
  }
  scenes: Scene[]
}

/** Result of evaluating one entity at time t. */
export interface EntityState {
  entityId: string
  position: V3
  /** Travel heading (yaw). */
  heading: number
  gait: GaitId
  /** Meters travelled since shot start — drives gait cycle phase. */
  distanceTravelled: number
  /** Current speed m/s (0 when holding). */
  speed: number
  /** Interpolated per-joint pose offsets from the marks (radians). */
  joints?: Record<string, number>
}

/** Result of evaluating the camera at time t (rig noise already applied). */
export interface CameraState {
  position: V3
  pan: number
  tilt: number
  roll: number
  focalLength: number
  focusDistance?: number
  /** Vertical FOV in radians for the shot's sensor + aspect. */
  vfov: number
}

export interface ShotState {
  time: number
  camera: CameraState
  entities: EntityState[]
}
