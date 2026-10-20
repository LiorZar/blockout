// Modified in this fork (2026): shot words, Fight Director, held-weapon actions, clear camera views and routine bodies; see MODIFICATIONS.md.
/**
 * Application state (zustand). One store owns the document, selection,
 * playback, and undo. All document mutations flow through mutate(), which
 * snapshots for undo and marks the project dirty — components never edit
 * the doc directly.
 */

import { create } from 'zustand'
import type { ProjectDoc, Scene, Shot, Entity, V3, GaitId, AspectId } from '@engine/types'
import {
  createProject,
  createScene,
  createShot,
  createEntity,
  createActorMark,
  createCameraMark,
  createScan,
  serializeProject,
  parseProject
} from '@engine/schema'
import { assetSpec } from '@engine/assets'
import { newId } from '@engine/ids'
import { generateSequence, choreographMotion } from '@engine/sequences'
import { buildRoutine, mirrorJoints } from '@engine/choreography'
import { mirrorForHolder } from '@engine/fight/moves'
import { ACTION_PRESETS } from '@engine/action-presets'
import { ShotEvaluator } from '@engine/evaluate'
import type { ShotSpec } from '@engine/shot'
import { GUARD_DISTANCE, solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { nextLabelColor } from '@engine/palette'
import { handFor, holdError, putInHand, setDown, weaponSpec, weaponsInHand } from '@engine/weapons'
import { fightCoverage, type CoverageMode } from '@engine/fight/coverage'
import { randomFightScript } from '@engine/fight/script'
import { clearShift } from '@engine/fight/obstacles'
import { fightObstacles } from './fight-obstacles'
import { clearShotSpec, shotWordsClearer } from './camera-view'
import type { BlockingTake, FightBeat, FightDoc } from '@engine/types'

export type Mode = 'stage' | 'shoot' | 'deliver'

export type Selection =
  | { kind: 'entity'; entityId: string }
  | { kind: 'entities'; entityIds: string[] } // shift-click multi-select
  | { kind: 'camera' }
  | { kind: 'scan'; scanId: string } // an imported 3D-scan environment
  | { kind: 'mark'; entityId: string | 'camera'; markId: string }
  | { kind: 'marks'; entityId: string | 'camera'; markIds: string[] } // shift-click on pills
  | null

/** All entity ids covered by the current selection (single or multi). */
export function selectedEntityIds(sel: Selection): string[] {
  if (sel?.kind === 'entity') return [sel.entityId]
  if (sel?.kind === 'entities') return sel.entityIds
  return []
}

export interface Toast {
  id: string
  text: string
  kind: 'info' | 'error' | 'success'
}

export interface ExportProgress {
  running: boolean
  label: string
  frame: number
  totalFrames: number
  cancelRequested: boolean
  lastPackagePath?: string
  error?: string
}

interface BlockoutState {
  mode: Mode
  projectFolder: string | null
  doc: ProjectDoc | null
  sceneId: string | null
  shotId: string | null
  selection: Selection
  /** Asset id armed for click-to-place from the library. */
  placingAssetId: string | null
  /** Armed sequence: next floor click stages the crowd THERE. */
  placingSequence: { type: import('@engine/sequences').SequenceType; count: number; style: string } | null
  /** Armed choreography routine: next floor click stages the routine THERE. */
  placingChoreography: import('@engine/choreography').RoutineSpec | null
  /** Fight Director (fork): the fight armed for floor placement (staged by the next fight placement click). */
  pendingFight: Omit<StageFightInput, 'at'> | null
  /** When true, clicking the floor drops a mark for the selection. */
  droppingMarks: boolean
  lookThrough: boolean
  /** Picture-in-picture live shot preview size. */
  pipSize: 'off' | 'small' | 'medium' | 'large'
  /** Help & tutorial overlay. */
  helpOpen: boolean
  /** Spike-tape floor marks visible in the editor (HUD "Marks" eye). */
  showMarks: boolean
  /** Path ribbons + chevrons + time labels visible in the editor (HUD "Paths" eye). */
  showPaths: boolean
  /** The "Set your marks" blocking-coach walkthrough overlay. */
  coachOpen: boolean
  /** True while performing a live camera-move recording. */
  recording: boolean
  /** How tightly recording follows the mouse: precise = heavy smoothing. */
  recordControl: 'precise' | 'normal' | 'fast'
  playing: boolean
  time: number
  dirty: boolean
  undoStack: string[]
  redoStack: string[]
  toasts: Toast[]
  exportProgress: ExportProgress

  /* --- lifecycle --- */
  newProject(folder: string, name: string): void
  loadFromJson(folder: string, json: string): boolean
  markSaved(): void

  /* --- navigation --- */
  setMode(mode: Mode): void
  selectScene(sceneId: string): void
  selectShot(shotId: string): void
  setSelection(sel: Selection): void
  setPlacingAsset(assetId: string | null): void
  setPlacingSequence(seq: { type: import('@engine/sequences').SequenceType; count: number; style: string } | null): void
  setPlacingChoreography(spec: import('@engine/choreography').RoutineSpec | null): void
  setDroppingMarks(on: boolean): void
  setLookThrough(on: boolean): void
  setPipSize(size: 'off' | 'small' | 'medium' | 'large'): void
  setRecording(on: boolean): void
  setRecordControl(mode: 'precise' | 'normal' | 'fast'): void
  /** Select every mark in one timeline lane (camera or an entity). */
  selectAllMarksInLane(entityId: string | 'camera'): void
  /** Select every mark on every lane of the current shot. */
  selectAllMarks(): void
  /** Delete the marks in the current mark/marks selection. */
  deleteSelectedMarks(): void
  setHelpOpen(open: boolean): void
  setShowMarks(on: boolean): void
  setShowPaths(on: boolean): void
  setCoachOpen(open: boolean): void

  /* --- playback --- */
  setPlaying(playing: boolean): void
  setTime(time: number): void

  /* --- document mutations (all undoable) --- */
  mutate(label: string, fn: (doc: ProjectDoc) => void): void
  undo(): void
  redo(): void

  /* --- convenience accessors --- */
  scene(): Scene | null
  shot(): Shot | null

  /* --- high-level operations --- */
  addEntity(assetId: string, position: V3): string
  addSceneAfter(): void
  addShotToScene(sceneId: string): void
  dropActorMark(entityId: string, position: V3): void
  dropCameraMark(position: V3, pan: number, tilt: number, focalLength: number): void
  /** Shift-click: add/remove an entity from a multi-selection. */
  toggleEntitySelected(entityId: string): void
  /** Shift-click on a timeline pill: add/remove a mark from a multi-selection. */
  toggleMarkSelected(entityId: string | 'camera', markId: string): void
  /** Marry entities to a parent: they follow its motion at a fixed offset. */
  marryEntities(childIds: string[], parentId: string): void
  /** Detach entities, baking their current world pose into the transform. */
  unmarryEntities(entityIds: string[]): void
  /**
   * Weapons (fork): put a weapon entity in a person's hand (default: its usual
   * hand). Whatever that hand held is set down. Returns an error message, or
   * null on success.
   */
  holdWeapon(weaponId: string, holderId: string, hand?: 'L' | 'R'): string | null
  /** Spawn a weapon from the catalog straight into a person's hand; returns its id. */
  spawnHeldWeapon(assetId: string, holderId: string, hand?: 'L' | 'R'): { weaponId?: string; error?: string }
  /** Let go of a held weapon: it stands where the hand was at the playhead. */
  dropWeapon(weaponId: string): void
  /** Switch the shot's active camera to a bank entry by name ('A','B',…). */
  switchCamera(name: string): void
  /** Bank the active camera and start a fresh one (B, C, …). */
  addCameraToShot(): void
  /** Delete the active camera's move (all its marks) — e.g. to re-record. */
  clearCameraMarks(): void
  /**
   * Shot words (fork): frame the camera mark at `time` (within ±1 frame) — or
   * a new one — with a live ShotSpec, storing the solved pose as fallback.
   * Returns the mark id ('' when the shot can't be solved).
   */
  setShotAtTime(spec: ShotSpec, time: number): string
  /** Drop a camera mark's shot words, keeping the pose they solve to now. */
  releaseShot(markId: string): void
  /**
   * Fight Director (fork): solve a scripted fight into the two fighters'
   * tracks in the active take (one undo step). Without `fighters` it spawns
   * `assets` (default man + woman) labelled A / B in distinct colours.
   */
  stageFight(input: StageFightInput): { fightId: string; report: FightSolution['report'] }
  /** Re-solve a staged fight after a script / setting change. */
  updateFight(
    fightId: string,
    patch: Partial<Pick<FightDoc, 'beats' | 'exaggeration' | 'beatGap' | 'startT' | 'coverage'>>
  ): FightSolution['report']
  /** Forget a fight (its marks stay on the timeline). */
  deleteFight(fightId: string): void
  /** Arm floor placement for a fight (the Choreographer's Stage fight). */
  armFightPlacement(input: Omit<StageFightInput, 'at'>): void
  /**
   * Replace the active camera with beat-aware coverage of a fight (live shot
   * marks on one side of the fight line; `side` defaults to the camera's).
   */
  coverFight(fightId: string, mode: CoverageMode, side?: 'left' | 'right'): { lineSide: 1 | -1; cameraMarks: number }
  /** Snapshot the current shot as a draft version ("1A v2"). */
  saveDraftOfShot(): void
  /**
   * Drop a whole choreographed sequence — N dancers, a brawl, a chase —
   * into the current scene as one undoable step.
   */
  spawnSequence(opts: {
    type: import('@engine/sequences').SequenceType
    count: number
    style: string
    origin?: { x: number; z: number; heading: number }
  }): void
  /**
   * Drop a full choreography routine — a dance number, a paired fight, a
   * chase — into the scene at `at`, spawning fresh performers, as one
   * undoable step.
   */
  spawnChoreography(spec: import('@engine/choreography').RoutineSpec, at: { x: number; z: number; heading: number }): void
  /**
   * Apply a choreography routine to the currently selected PERSON entities:
   * keeps their assets/labels, replaces their track in the active take.
   */
  choreographSelected(spec: import('@engine/choreography').RoutineSpec): void
  /**
   * Apply a choreography routine to specific PERSON entities by id — the
   * selection-independent core of `choreographSelected`, so non-UI callers
   * (agent control) don't have to touch selection. Returns how many
   * performers were choreographed.
   */
  choreographEntities(entityIds: string[], spec: import('@engine/choreography').RoutineSpec): number
  /**
   * Restyle performers in place: replace each selected PERSON's choreography
   * with a motion preset (swap the dance, change the strike) at their spots.
   */
  applyMotionToEntities(entityIds: string[], presetId: string): void
  /** Replace each selected entity's path with an action preset from its pose. */
  applyActionToEntities(entityIds: string[], presetId: string): void
  /**
   * Import a Gaussian-splat / photogrammetry scan file into the project's
   * scans/ folder and attach it to the current scene as an environment.
   * Renderer-only content: hidden from every export pass.
   */
  importScan(sourcePath: string): Promise<void>
  /** Remove a scan from the current scene (leaves the copied file on disk). */
  removeScan(scanId: string): void
  /** Toggle a scan's editor-viewport visibility. */
  setScanVisible(scanId: string, visible: boolean): void
  /** Patch a scan's transform (position / rotationY / scale). */
  updateScanTransform(
    scanId: string,
    patch: Partial<{ position: V3; rotationY: number; scale: number; flipped: boolean }>
  ): void
  /** Save the current scene's staging as a reusable, globally persistent preset. */
  saveStagePreset(name: string): Promise<void>
  /** Stage a preset into a brand-new scene (originals stay untouched). */
  applyStagePreset(id: string): Promise<void>
  /** Copy a draft's content back into its main shot. */
  promoteDraft(draftId: string): void
  deleteDraft(draftId: string): void
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: string): void
  setExportProgress(p: Partial<ExportProgress>): void
}

const MAX_UNDO = 100

/** Coalesce rapid same-label mutations (slider swipes) into one undo step. */
let lastMutateLabel = ''
let lastMutateAt = 0
const COALESCE_MS = 800

/** After restoring a snapshot, make scene/shot ids point at real objects. */
function reconcileSelection(doc: ProjectDoc, sceneId: string | null, shotId: string | null): {
  sceneId: string | null
  shotId: string | null
} {
  const scene = doc.scenes.find((s) => s.id === sceneId) ?? doc.scenes[0] ?? null
  const shot = scene?.shots.find((s) => s.id === shotId) ?? scene?.shots[0] ?? null
  return { sceneId: scene?.id ?? null, shotId: shot?.id ?? null }
}

/**
 * Weapons (fork): set held weapons down where their grip is at `time` in the
 * shot (standing, facing the holder). Use before deleting a holder.
 */
export function setDownAtHand(scene: Scene, shotId: string | null, time: number, weapons: Entity[]): void {
  const shot = scene.shots.find((s) => s.id === shotId) ?? scene.drafts?.find((s) => s.id === shotId) ?? scene.shots[0]
  const states = shot ? new ShotEvaluator(scene, shot).evaluate(time).entities : []
  for (const weapon of weapons) {
    if (!weapon.heldBy) continue
    const st = states.find((e) => e.entityId === weapon.id)
    setDown(weapon, st?.position ?? weapon.transform.position, st?.heading ?? weapon.transform.rotationY)
  }
}

/** Weapons (fork): before deleting entities, set down every weapon they hold. */
export function releaseHeldBy(scene: Scene, shotId: string | null, time: number, deletedIds: Set<string>): void {
  const held = scene.entities.filter((e) => e.heldBy && deletedIds.has(e.heldBy.entityId) && !deletedIds.has(e.id))
  if (held.length > 0) setDownAtHand(scene, shotId, time, held)
}

/** Fight Director (fork) input for stageFight. */
export interface StageFightInput {
  beats: FightBeat[]
  at: { x: number; z: number; heading: number }
  fighters?: [string, string]
  assets?: [string, string]
  labels?: [string, string]
  exaggeration?: number
  coverage?: FightDoc['coverage']
  /** Weapons (fork): a weapon asset to put in each fighter's usual hand (null: as they are). */
  weapons?: [string | null, string | null]
}

/** RoutineSpec.style that marks a Fight Director placement (see spawnChoreography). */
export const FIGHT_DIRECTOR_STYLE = 'fight-director'

/** A fighter for the solver, with the weapons it holds in `scene` (fork) plus `extra` (about to be put in its hands). */
export function fighterInput(e: Entity, scene: Scene, extra: Entity[] = []): FighterInput {
  const held = [...extra, ...scene.entities].filter((w) => w.heldBy?.entityId === e.id && weaponSpec(w.assetId))
  const weapons = held
    .filter((w, k) => held.findIndex((x) => x.heldBy!.hand === w.heldBy!.hand) === k)
    .map((w) => ({ assetId: w.assetId, hand: w.heldBy!.hand, scale: w.transform.scale }))
  return {
    entityId: e.id,
    assetId: e.assetId,
    params: e.params,
    scale: e.transform.scale,
    start: { ...e.transform.position },
    ...(weapons.length > 0 ? { weapons } : {})
  }
}

/** Replace the two fighters' tracks in a take with a solution. */
function writeFightTracks(take: BlockingTake, fighterIds: [string, string], sol: FightSolution): void {
  fighterIds.forEach((id, q) => {
    let track = take.tracks.find((t) => t.entityId === id)
    if (!track) {
      track = { entityId: id, marks: [] }
      take.tracks.push(track)
    }
    track.marks = sol.tracks[q]!.map((m) => ({
      id: newId('mark'),
      time: m.time,
      hold: m.hold,
      easeIn: m.easeIn,
      easeOut: m.easeOut,
      position: { ...m.position },
      gait: m.gait,
      arriveHeading: m.arriveHeading,
      joints: m.joints ? { ...m.joints } : undefined,
      lockFacing: true
    }))
  })
}

/** Which side of the A→B fight line the camera is on at the fight's start (+1 = A's right). */
function cameraLineSide(scene: Scene, shot: Shot, fight: FightDoc): 1 | -1 {
  const st = new ShotEvaluator(scene, shot).evaluate(fight.startT)
  const a = st.entities.find((e) => e.entityId === fight.fighterIds[0])?.position
  const b = st.entities.find((e) => e.entityId === fight.fighterIds[1])?.position
  if (!a || !b) return 1
  const c = st.camera.position
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x) < 0 ? -1 : 1
}

/** Each fighter's longest held weapon, grip to business end (m; 0 unarmed): coverage opens up to keep it in frame. */
function fightReach(scene: Scene, fight: FightDoc): [number, number] {
  const reach = (id: string): number =>
    Math.max(
      0,
      ...scene.entities
        .filter((w) => w.heldBy?.entityId === id)
        .map((w) => {
          const spec = weaponSpec(w.assetId)
          return spec ? Math.hypot(spec.tip.x - spec.grip.x, spec.tip.y - spec.grip.y, spec.tip.z - spec.grip.z) * w.transform.scale : 0
        })
    )
  return [reach(fight.fighterIds[0]), reach(fight.fighterIds[1])]
}

/** Replace the shot camera's marks with coverage of a fight (solved poses stored as fallback). */
function writeCoverage(scene: Scene, shot: Shot, fight: FightDoc, report: FightSolution['report'], mode: CoverageMode, lineSide: 1 | -1): number {
  const cam = shot.camera
  const focal = [...cam.marks].sort((a, b) => a.time - b.time).at(-1)?.focalLength ?? 35
  const ev = new ShotEvaluator(scene, shot)
  const clear = shotWordsClearer(scene, shot, focal) // fork (fix-camera-set): coverage keeps a clear view
  cam.marks = fightCoverage(fight, report, mode, lineSide, { reach: fightReach(scene, fight), clear }).map((m) => {
    const solved = ev.solveShotAt(m.shot, m.time, focal)
    const mark = createCameraMark(solved ? { ...solved.position } : { x: 0, y: 1.6, z: 5 }, m.time, solved?.pan ?? 0, solved?.tilt ?? 0, solved?.focalLength ?? focal)
    mark.roll = solved?.roll ?? 0
    mark.easeIn = m.easeIn
    mark.easeOut = m.easeOut
    mark.hold = m.hold
    mark.shot = m.shot
    return mark
  })
  delete cam.trackEntityId
  if (mode === 'follow') {
    cam.rig = 'handheld'
    cam.rigIntensity = 0.4
  }
  return cam.marks.length
}

/** The two fighters of a fight, or an error naming what's missing. */
function fightersOf(scene: Scene, ids: [string, string]): [Entity, Entity] {
  const pair = ids.map((id) => {
    const e = scene.entities.find((x) => x.id === id)
    if (!e) throw new Error(`No fighter "${id}" in the scene: use person entity ids from get_state.`)
    if (!e.assetId.startsWith('person.')) throw new Error(`"${e.label?.text || e.name}" isn't a person: fights need two people.`)
    return e
  })
  if (pair[0]!.id === pair[1]!.id) throw new Error('A fight needs two different people.')
  return [pair[0]!, pair[1]!]
}

/** Solve a fight of `scene` for `shot`'s timing (`extra`: weapons about to be put in the fighters' hands). */
export function solveInScene(
  scene: Scene,
  shot: Shot,
  fight: FightDoc,
  extra: Entity[] = [],
  fighters: [Entity, Entity] = fightersOf(scene, fight.fighterIds),
  free = false
): FightSolution {
  // Set props (fork, gap 8): the scene's static props, unless solving `free` (paths only, to place the fight).
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId)
  return solveFight(
    fight,
    [fighterInput(fighters[0], scene, extra), fighterInput(fighters[1], scene, extra)],
    { duration: shot.duration, fps: shot.fps },
    free ? { paths: true } : { obstacles: fightObstacles(scene, take) }
  )
}

/** Set props (gap 8): the solver had to stop a push-back at a prop, or a path still runs into one. */
const PROP_TROUBLE = /stopped at|runs into/

/**
 * Set props (gap 8): a fight that spawns its own fighters moves (≤ 3 m) to
 * the nearest spot where its paths stay clear of the set's props, saying so
 * in the report. Shifts the not-yet-added `movable` entities and the origin.
 */
function placeClearOfProps(scene: Scene, shot: Shot, fight: FightDoc, sol: FightSolution, extra: Entity[], fighters: [Entity, Entity], movable: Entity[]): FightSolution {
  if (!sol.report.warnings.some((w) => PROP_TROUBLE.test(w))) return sol
  const free = solveInScene(scene, shot, fight, extra, fighters, true)
  const shift = clearShift(free.paths, fightObstacles(scene, scene.blocking.find((b) => b.id === shot.blockingTakeId)))
  if (!shift || (shift.x === 0 && shift.z === 0)) return sol
  for (const e of movable) {
    e.transform.position.x += shift.x
    e.transform.position.z += shift.z
  }
  fight.origin = { ...fight.origin, x: fight.origin.x + shift.x, z: fight.origin.z + shift.z }
  const moved = solveInScene(scene, shot, fight, extra, fighters)
  const d = Math.hypot(shift.x, shift.z)
  moved.report.warnings.unshift(`Moved the fight ${d.toFixed(2)} m to (${fight.origin.x.toFixed(2)}, ${fight.origin.z.toFixed(2)}) so it keeps clear of the set's props`)
  return moved
}

/** A fight's solved marks are in this take: both fighters have fight (lockFacing) marks there. */
function fightInTake(take: BlockingTake, fight: FightDoc): boolean {
  return fight.fighterIds.every((id) => take.tracks.find((t) => t.entityId === id)?.marks.some((m) => m.lockFacing))
}

/** The camera is still a fight's coverage: every mark is a shot-words mark on its fighters. */
function cameraIsCoverage(shot: Shot, fight: FightDoc): boolean {
  const marks = shot.camera.marks
  return marks.length > 0 && marks.every((m) => !!m.shot && m.shot.subjectIds.every((id) => fight.fighterIds.includes(id)))
}

/**
 * Re-solve every fight of a shot for its current fps and duration (gap 2):
 * impacts move onto the new frame grid and beats past a shorter end drop
 * out with a warning (they stay in the FightDoc and come back when the shot
 * is long enough). Call inside the same mutate as the timing edit. The
 * camera is re-covered only while it is still the fight's coverage.
 */
export function refightShot(scene: Scene, shot: Shot, except?: string): { fightId: string; report: FightSolution['report'] }[] {
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId)
  if (!take) return []
  const out: { fightId: string; report: FightSolution['report'] }[] = []
  for (const fight of scene.fights ?? []) {
    if (fight.id === except || !fightInTake(take, fight)) continue
    let sol: FightSolution
    try {
      sol = solveInScene(scene, shot, fight)
    } catch {
      continue
    }
    writeFightTracks(take, fight.fighterIds, sol)
    if (fight.coverage && cameraIsCoverage(shot, fight)) {
      writeCoverage(scene, shot, fight, sol.report, fight.coverage, cameraLineSide(scene, shot, fight))
    }
    out.push({ fightId: fight.id, report: sol.report })
  }
  return out
}

/**
 * Gap 3 (fork): a two-person routine fight is the Fight Director's, where
 * blows land: a seeded random script in the routine's style (brawl,
 * martial-arts, sparring), ending on a KO unless the ending is 'sparring'.
 */
function routineFightBeats(seed: number, style: string | undefined, ending: string | undefined, duration: number): FightBeat[] {
  const pool = style === 'martial-arts' || style === 'sparring' ? style : 'brawl'
  return randomFightScript(seed, pool, duration, { ending: ending === 'sparring' ? 'standing' : 'ko' })
}

/** Fork (fix-routines): a routine lasts the Choreographer's Duration (the shot's length when it has none). */
function routineDuration(spec: import('@engine/choreography').RoutineSpec): number {
  return spec.durationS > 0 ? spec.durationS : (useStore.getState().shot()?.duration ?? 8)
}

/** Fork (fix-routines): inside a routine's mutate, a shorter shot grows to the routine (never shrinks) and its fights re-solve. */
function fitShotToRoutine(scene: Scene, shot: Shot, duration: number): void {
  if (duration <= shot.duration + 1e-9) return
  shot.duration = duration
  refightShot(scene, shot)
}

/** Stage a routine's two-person fight through stageFight (toasts the outcome); false if it couldn't. */
function stageRoutineFight(input: StageFightInput): boolean {
  const st = useStore.getState()
  try {
    const { report } = st.stageFight(input)
    const warn = report.warnings.length ? `, ${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''} (see the Fight Director)` : ''
    st.toast(`Fight staged by the Fight Director: ${report.beats.length} beats${warn}. ▶ to watch.`, 'success')
    return true
  } catch (e) {
    st.toast((e as Error).message, 'error')
    return false
  }
}

/** The longest shot a fight lengthens it to (the Timeline's cap). */
const MAX_FIT_DURATION = 60

/**
 * qa-fight bug 6: the shot a fight needs. When the shot is too short for a
 * beat (the solver drops it), the shot grows to the whole fight's end + 0.5 s
 * (rounded up to 0.5 s, at most 60 s); a fight whose beats all play leaves
 * it alone. Returns the shot to solve with, and the solution when that is
 * the shot as it was.
 */
function shotToFit(scene: Scene, shot: Shot, fight: FightDoc, extra: Entity[] = [], fighters?: [Entity, Entity]): { shot: Shot; sol?: FightSolution } {
  const sol = solveInScene(scene, shot, fight, extra, fighters)
  if (!sol.report.warnings.some((w) => /past the end of the shot/.test(w))) return { shot, sol }
  const roomy = solveInScene(scene, { ...shot, duration: MAX_FIT_DURATION }, fight, extra, fighters)
  const need = Math.min(MAX_FIT_DURATION, Math.ceil((roomy.report.endT + 0.5) * 2) / 2)
  return need > shot.duration + 1e-9 ? { shot: { ...shot, duration: need } } : { shot, sol }
}

/** Grow a shot (inside a mutate) to a fitted length and re-solve the shot's other fights for it; the report notes it. */
function growShot(sc: Scene, sh: Shot, sized: Shot, fightId: string, report: FightSolution['report']): void {
  if (sized.duration <= sh.duration + 1e-9) return
  report.warnings.unshift(`Lengthened the shot from ${sh.duration.toFixed(1)} s to ${sized.duration.toFixed(1)} s so every beat plays`)
  sh.duration = sized.duration
  refightShot(sc, sh, fightId)
}

/** Tell the user which beats a shorter shot left out (after refightShot). */
export function toastRefight(results: ReturnType<typeof refightShot>): void {
  const scene = useStore.getState().scene()
  const lines = results
    .map((r) => {
      const n = r.report.warnings.filter((w) => /past the end of the shot/.test(w)).length
      const name = scene?.fights?.find((f) => f.id === r.fightId)?.name ?? 'A fight'
      return n > 0 ? `${name}: ${n} beat${n > 1 ? 's' : ''} past the end of the shot left out (lengthen the shot to bring ${n > 1 ? 'them' : 'it'} back)` : ''
    })
    .filter(Boolean)
  if (lines.length > 0) useStore.getState().toast(lines.join('. '), 'info')
}

export const useStore = create<BlockoutState>((set, get) => ({
  mode: 'stage',
  projectFolder: null,
  doc: null,
  sceneId: null,
  shotId: null,
  selection: null,
  placingAssetId: null,
  placingSequence: null,
  placingChoreography: null,
  pendingFight: null,
  droppingMarks: false,
  lookThrough: false,
  pipSize: 'medium',
  recording: false,
  recordControl: 'normal',
  helpOpen: false,
  showMarks: true,
  showPaths: true,
  coachOpen: false,
  playing: false,
  time: 0,
  dirty: false,
  undoStack: [],
  redoStack: [],
  toasts: [],
  exportProgress: { running: false, label: '', frame: 0, totalFrames: 0, cancelRequested: false },

  newProject(folder, name) {
    const doc = createProject(name)
    const scene = doc.scenes[0]!
    set({
      doc,
      projectFolder: folder,
      sceneId: scene.id,
      shotId: scene.shots[0]!.id,
      mode: 'stage',
      selection: null,
      undoStack: [],
      redoStack: [],
      dirty: true,
      time: 0,
      playing: false
    })
  },

  loadFromJson(folder, json) {
    const { doc, issues } = parseProject(json)
    if (!doc) {
      get().toast(`Could not open project: ${issues[0]?.message ?? 'unknown error'}`, 'error')
      return false
    }
    const scene = doc.scenes[0] ?? null
    set({
      doc,
      projectFolder: folder,
      sceneId: scene?.id ?? null,
      shotId: scene?.shots[0]?.id ?? null,
      mode: 'stage',
      selection: null,
      undoStack: [],
      redoStack: [],
      dirty: false,
      time: 0,
      playing: false
    })
    return true
  },

  markSaved: () => set({ dirty: false }),

  setMode(mode) {
    // Mode switches remount the viewport and scene/shot switches rebuild the
    // evaluator — both would corrupt an in-flight export.
    if (get().exportProgress.running) return
    // Leaving for another mode must never trap the user in the camera view
    // (look-through has no exit button outside Shoot) or keep a recording
    // rolling against a viewport that no longer shows it.
    set({
      mode,
      placingAssetId: null,
      placingSequence: null,
      placingChoreography: null,
      droppingMarks: false,
      lookThrough: false,
      recording: false,
      playing: mode === 'deliver' ? get().playing : false
    })
  },
  selectScene(sceneId) {
    if (get().exportProgress.running) return
    const doc = get().doc
    const scene = doc?.scenes.find((s) => s.id === sceneId)
    set({ sceneId, shotId: scene?.shots[0]?.id ?? null, selection: null, time: 0, playing: false })
  },
  selectShot(shotId) {
    // exportAnimatic/contact-sheet iterate shots internally; they bypass this
    // guard by toggling exportProgress around each hop. User clicks land here.
    if (get().exportProgress.running) return
    set({ shotId, time: 0, playing: false })
  },
  setSelection: (selection) => set({ selection, droppingMarks: false }),
  setPlacingAsset: (placingAssetId) => set({ placingAssetId, placingSequence: null, placingChoreography: null }),
  setPlacingSequence: (placingSequence) => set({ placingSequence, placingAssetId: null, placingChoreography: null }),
  setPlacingChoreography: (placingChoreography) =>
    set({ placingChoreography, placingAssetId: null, placingSequence: null }),
  setDroppingMarks: (droppingMarks) => set({ droppingMarks }),
  setLookThrough: (lookThrough) => set({ lookThrough }),
  setPipSize: (pipSize) => set({ pipSize }),
  setRecording: (recording) => set({ recording }),
  setRecordControl: (recordControl) => set({ recordControl }),

  selectAllMarksInLane(entityId) {
    const scene = get().scene()
    const shot = get().shot()
    if (!scene || !shot) return
    const markIds =
      entityId === 'camera'
        ? shot.camera.marks.map((m) => m.id)
        : (scene.blocking
            .find((b) => b.id === shot.blockingTakeId)
            ?.tracks.find((t) => t.entityId === entityId)
            ?.marks.map((m) => m.id) ?? [])
    if (markIds.length === 0) return
    set({ selection: { kind: 'marks', entityId, markIds } })
  },

  selectAllMarks() {
    // Cross-lane selection reuses the per-lane shape with entityId '*'.
    const scene = get().scene()
    const shot = get().shot()
    if (!scene || !shot) return
    const take = scene.blocking.find((b) => b.id === shot.blockingTakeId)
    const all = [
      ...shot.camera.marks.map((m) => m.id),
      ...(take?.tracks.flatMap((t) => t.marks.map((m) => m.id)) ?? [])
    ]
    if (all.length === 0) return
    set({ selection: { kind: 'marks', entityId: '*', markIds: all } })
  },

  deleteSelectedMarks() {
    const sel = get().selection
    if (!sel || (sel.kind !== 'mark' && sel.kind !== 'marks')) return
    const ids = new Set(sel.kind === 'mark' ? [sel.markId] : sel.markIds)
    const n = ids.size
    get().mutate(n > 1 ? `delete ${n} marks` : 'delete mark', (doc) => {
      for (const scene of doc.scenes) {
        for (const shot of [...scene.shots, ...(scene.drafts ?? [])]) {
          shot.camera.marks = shot.camera.marks.filter((m) => !ids.has(m.id))
        }
        for (const take of scene.blocking) {
          for (const track of take.tracks) {
            track.marks = track.marks.filter((m) => !ids.has(m.id))
          }
          take.tracks = take.tracks.filter((t) => t.marks.length > 0)
        }
      }
    })
    set({ selection: null })
    get().toast(n > 1 ? `Deleted ${n} marks.` : 'Mark deleted.', 'info')
  },
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setShowMarks: (showMarks) => set({ showMarks }),
  setShowPaths: (showPaths) => set({ showPaths }),
  setCoachOpen: (coachOpen) => set({ coachOpen }),

  setPlaying(playing) {
    const { shot, time } = get()
    const s = shot()
    // Restart from 0 when hitting play at the end.
    if (playing && s && time >= s.duration - 0.01) set({ time: 0 })
    set({ playing })
  },
  setTime: (time) => set({ time }),

  mutate(label, fn) {
    const { doc, undoStack, exportProgress } = get()
    if (!doc) return
    if (exportProgress.running) {
      // The export loop is reading this document frame by frame; editing it
      // mid-export would change the video partway through.
      get().toast('Editing is locked while an export is running.', 'info')
      return
    }
    const next = structuredClone(doc)
    fn(next)
    const now = Date.now()
    const coalesce = label === lastMutateLabel && now - lastMutateAt < COALESCE_MS
    lastMutateLabel = label
    lastMutateAt = now
    if (coalesce) {
      // Keep the snapshot taken at the start of the swipe; just move the doc.
      set({ doc: next, dirty: true })
    } else {
      const snapshot = serializeProject(doc)
      set({
        doc: next,
        dirty: true,
        undoStack: [...undoStack.slice(-MAX_UNDO + 1), snapshot],
        redoStack: []
      })
    }
  },

  undo() {
    const { doc, undoStack, redoStack, sceneId, shotId, exportProgress } = get()
    if (!doc || undoStack.length === 0 || exportProgress.running) return
    lastMutateLabel = '' // an undo ends any coalescing run
    const prev = undoStack[undoStack.length - 1]!
    const { doc: restored } = parseProject(prev)
    if (!restored) return
    set({
      doc: restored,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, serializeProject(doc)],
      dirty: true,
      selection: null,
      // The restored doc may not contain the current scene/shot (e.g. undo
      // of "add shot") — point at real objects so the UI never goes blank.
      ...reconcileSelection(restored, sceneId, shotId)
    })
  },

  redo() {
    const { doc, undoStack, redoStack, sceneId, shotId, exportProgress } = get()
    if (!doc || redoStack.length === 0 || exportProgress.running) return
    lastMutateLabel = ''
    const next = redoStack[redoStack.length - 1]!
    const { doc: restored } = parseProject(next)
    if (!restored) return
    set({
      doc: restored,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, serializeProject(doc)],
      dirty: true,
      selection: null,
      ...reconcileSelection(restored, sceneId, shotId)
    })
  },

  scene() {
    const { doc, sceneId } = get()
    return doc?.scenes.find((s) => s.id === sceneId) ?? null
  },

  shot() {
    const { shotId } = get()
    const scene = get().scene()
    if (!scene) return null
    return (
      scene.shots.find((s) => s.id === shotId) ??
      scene.drafts?.find((s) => s.id === shotId) ??
      null
    )
  },

  addEntity(assetId, position) {
    const spec = assetSpec(assetId)
    const sceneId = get().sceneId
    const entity = createEntity(assetId, spec.name, position)
    get().mutate('add entity', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      // Number duplicates: "Man 2", "Man 3"…
      const count = scene.entities.filter((e) => e.assetId === assetId).length
      if (count > 0) entity.name = `${spec.name} ${count + 1}`
      scene.entities.push(entity)
    })
    set({ selection: { kind: 'entity', entityId: entity.id } })
    return entity.id
  },

  addSceneAfter() {
    get().mutate('add scene', (doc) => {
      const number = doc.scenes.length + 1
      doc.scenes.push(createScene(number))
    })
    const doc = get().doc!
    const added = doc.scenes[doc.scenes.length - 1]!
    get().selectScene(added.id)
  },

  addShotToScene(sceneId) {
    let newShotId: string | null = null
    get().mutate('add shot', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const letter = String.fromCharCode(65 + (scene.shots.length % 26))
      const shot = createShot(scene, `${scene.number}${letter}`)
      scene.shots.push(shot)
      newShotId = shot.id
    })
    if (newShotId) set({ shotId: newShotId, time: 0 })
  },

  dropActorMark(entityId, position) {
    const { sceneId, shotId, time } = get()
    get().mutate('drop mark', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot = scene?.shots.find((s) => s.id === shotId)
      if (!scene || !shot) return
      const take = scene.blocking.find((b) => b.id === shot.blockingTakeId)
      if (!take) return
      let track = take.tracks.find((t) => t.entityId === entityId)
      if (!track) {
        track = { entityId, marks: [] }
        take.tracks.push(track)
      }
      const gait: GaitId = 'walk'
      // First mark lands at t=0 (starting position); later marks at playhead
      // or spaced 2s after the last mark, whichever is later.
      const lastTime = track.marks.reduce((m, k) => Math.max(m, k.time + k.hold), -1)
      const t = track.marks.length === 0 ? 0 : Math.max(time, lastTime + 2)
      track.marks.push(createActorMark(position, Math.min(t, shot.duration), gait))
    })
  },

  dropCameraMark(position, pan, tilt, focalLength) {
    const { sceneId, shotId, time } = get()
    get().mutate('drop camera mark', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot = scene?.shots.find((s) => s.id === shotId)
      if (!shot) return
      const marks = shot.camera.marks
      const lastTime = marks.reduce((m, k) => Math.max(m, k.time + k.hold), -1)
      const t = marks.length === 0 ? 0 : Math.max(time, lastTime + 2)
      marks.push(createCameraMark(position, Math.min(t, shot.duration), pan, tilt, focalLength))
    })
  },

  toggleEntitySelected(entityId) {
    const sel = get().selection
    let ids = selectedEntityIds(sel)
    if (sel && sel.kind !== 'entity' && sel.kind !== 'entities') ids = []
    ids = ids.includes(entityId) ? ids.filter((i) => i !== entityId) : [...ids, entityId]
    set({
      selection:
        ids.length === 0
          ? null
          : ids.length === 1
            ? { kind: 'entity', entityId: ids[0]! }
            : { kind: 'entities', entityIds: ids },
      droppingMarks: false
    })
  },

  toggleMarkSelected(entityId, markId) {
    const sel = get().selection
    let ids: string[] = []
    if (sel?.kind === 'mark' && sel.entityId === entityId) ids = [sel.markId]
    else if (sel?.kind === 'marks' && sel.entityId === entityId) ids = [...sel.markIds]
    ids = ids.includes(markId) ? ids.filter((i) => i !== markId) : [...ids, markId]
    set({
      selection:
        ids.length === 0
          ? null
          : ids.length === 1
            ? { kind: 'mark', entityId, markId: ids[0]! }
            : { kind: 'marks', entityId, markIds: ids }
    })
  },

  marryEntities(childIds, parentId) {
    const sceneId = get().sceneId
    let married = 0
    let cycles = 0
    get().mutate('marry entities', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      // World pose through the marriage chain (parents may be married too).
      const worldOf = (id: string, depth = 0): { x: number; y: number; z: number; rotY: number } => {
        const e = scene.entities.find((x) => x.id === id)
        if (!e) return { x: 0, y: 0, z: 0, rotY: 0 }
        if (e.attachedTo && e.attachedLocal && depth < 4) {
          const p = worldOf(e.attachedTo, depth + 1)
          const cos = Math.cos(p.rotY)
          const sin = Math.sin(p.rotY)
          const l = e.attachedLocal
          return {
            x: p.x + l.x * cos + l.z * sin,
            y: p.y + l.y,
            z: p.z - l.x * sin + l.z * cos,
            rotY: p.rotY + l.rotY
          }
        }
        return { ...e.transform.position, rotY: e.transform.rotationY }
      }
      const wouldCycle = (childId: string): boolean => {
        let cursor: string | undefined = parentId
        for (let i = 0; i < 8 && cursor; i++) {
          if (cursor === childId) return true
          cursor = scene.entities.find((x) => x.id === cursor)?.attachedTo
        }
        return false
      }
      const pw = worldOf(parentId)
      for (const childId of childIds) {
        if (childId === parentId) continue
        if (wouldCycle(childId)) {
          cycles++
          continue
        }
        const child = scene.entities.find((x) => x.id === childId)
        if (!child) continue
        const cw = worldOf(childId)
        const dx = cw.x - pw.x
        const dz = cw.z - pw.z
        const cos = Math.cos(pw.rotY)
        const sin = Math.sin(pw.rotY)
        child.attachedTo = parentId
        child.attachedLocal = {
          x: dx * cos - dz * sin,
          y: cw.y - pw.y,
          z: dx * sin + dz * cos,
          rotY: cw.rotY - pw.rotY
        }
        married++
      }
    })
    if (married > 0) get().toast(`Married ${married} to the anchor — they now move together.`, 'success')
    if (cycles > 0) get().toast('Skipped a marriage that would loop back on itself.', 'error')
  },

  unmarryEntities(entityIds) {
    const sceneId = get().sceneId
    get().mutate('unmarry entities', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const worldOf = (id: string, depth = 0): { x: number; y: number; z: number; rotY: number } => {
        const e = scene.entities.find((x) => x.id === id)
        if (!e) return { x: 0, y: 0, z: 0, rotY: 0 }
        if (e.attachedTo && e.attachedLocal && depth < 4) {
          const p = worldOf(e.attachedTo, depth + 1)
          const cos = Math.cos(p.rotY)
          const sin = Math.sin(p.rotY)
          const l = e.attachedLocal
          return {
            x: p.x + l.x * cos + l.z * sin,
            y: p.y + l.y,
            z: p.z - l.x * sin + l.z * cos,
            rotY: p.rotY + l.rotY
          }
        }
        return { ...e.transform.position, rotY: e.transform.rotationY }
      }
      for (const id of entityIds) {
        const entity = scene.entities.find((x) => x.id === id)
        if (!entity?.attachedTo) continue
        const w = worldOf(id)
        entity.transform.position = { x: w.x, y: w.y, z: w.z }
        entity.transform.rotationY = w.rotY
        delete entity.attachedTo
        delete entity.attachedLocal
      }
    })
    get().toast('Unmarried — they move independently again.', 'info')
  },

  holdWeapon(weaponId, holderId, hand) {
    const { sceneId, shotId, time } = get()
    let error: string | null = 'No scene.'
    get().mutate('hold weapon', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const weapon = scene.entities.find((e) => e.id === weaponId)
      const holder = scene.entities.find((e) => e.id === holderId)
      error = holdError(weapon, holder)
      if (error) return
      const side = handFor(weapon!, hand)
      setDownAtHand(scene, shotId, time, weaponsInHand(scene.entities, holderId, side, weaponId))
      putInHand(weapon!, holder!, side)
    })
    if (error) get().toast(error, 'error')
    return error
  },

  spawnHeldWeapon(assetId, holderId, hand) {
    const { sceneId, shotId, time } = get()
    const spec = assetSpec(assetId)
    const weapon = createEntity(assetId, spec.name, { x: 0, y: 0, z: 0 })
    let error: string | null = 'No scene.'
    get().mutate('arm with weapon', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const holder = scene.entities.find((e) => e.id === holderId)
      error = holdError(weapon, holder)
      if (error) return
      const count = scene.entities.filter((e) => e.assetId === assetId).length
      if (count > 0) weapon.name = `${spec.name} ${count + 1}`
      weapon.transform.position = { ...holder!.transform.position }
      // Its own colour, no text: the video model reads it as its own proxy.
      const used = scene.entities.filter((e) => e.label).map((e) => e.label!.color)
      weapon.label = { text: '', color: nextLabelColor(used) }
      const side = handFor(weapon, hand)
      setDownAtHand(scene, shotId, time, weaponsInHand(scene.entities, holderId, side))
      scene.entities.push(weapon)
      putInHand(weapon, holder!, side)
    })
    if (error) {
      get().toast(error, 'error')
      return { error }
    }
    return { weaponId: weapon.id }
  },

  dropWeapon(weaponId) {
    const { sceneId, shotId, time } = get()
    get().mutate('drop weapon', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const weapon = scene?.entities.find((e) => e.id === weaponId)
      if (scene && weapon?.heldBy) setDownAtHand(scene, shotId, time, [weapon])
    })
  },

  switchCamera(name) {
    const { sceneId, shotId } = get()
    get().mutate('switch camera', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot =
        scene?.shots.find((s) => s.id === shotId) ?? scene?.drafts?.find((s) => s.id === shotId)
      if (!shot?.cameraBank) return
      const idx = shot.cameraBank.findIndex((b) => b.name === name)
      if (idx < 0) return
      const incoming = shot.cameraBank[idx]!
      shot.cameraBank[idx] = { name: shot.cameraName ?? 'A', camera: shot.camera }
      shot.camera = incoming.camera
      shot.cameraName = incoming.name
    })
    set({ selection: { kind: 'camera' } })
  },

  addCameraToShot() {
    const { sceneId, shotId } = get()
    let added = ''
    get().mutate('add camera', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot =
        scene?.shots.find((s) => s.id === shotId) ?? scene?.drafts?.find((s) => s.id === shotId)
      if (!shot) return
      const used = new Set([shot.cameraName ?? 'A', ...(shot.cameraBank ?? []).map((b) => b.name)])
      let letter = 'B'
      for (let i = 1; i < 26; i++) {
        const candidate = String.fromCharCode(65 + i)
        if (!used.has(candidate)) {
          letter = candidate
          break
        }
      }
      shot.cameraBank = shot.cameraBank ?? []
      shot.cameraBank.push({ name: shot.cameraName ?? 'A', camera: shot.camera })
      shot.camera = {
        sensorId: shot.camera.sensorId,
        rig: 'sticks',
        rigIntensity: 0.5,
        seed: Math.floor(Math.random() * 1e9),
        marks: []
      }
      shot.cameraName = letter
      added = letter
    })
    if (added) {
      set({ selection: { kind: 'camera' } })
      get().toast(`Camera ${added} added — frame it and drop marks. Switch cameras with the A/B chips.`, 'success')
    }
  },

  clearCameraMarks() {
    const { sceneId, shotId } = get()
    get().mutate('clear camera move', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot =
        scene?.shots.find((s) => s.id === shotId) ?? scene?.drafts?.find((s) => s.id === shotId)
      if (shot) shot.camera.marks = []
    })
    get().toast('Camera move cleared — record or drop new marks.', 'info')
  },

  setShotAtTime(spec, time) {
    const { sceneId, shotId } = get()
    const scene = get().scene()
    const shot = get().shot()
    if (!scene || !shot) return ''
    const t = Math.min(Math.max(0, time), shot.duration)
    const tol = 1 / Math.max(1, shot.fps) + 1e-9
    const existing = shot.camera.marks.find((m) => Math.abs(m.time - t) <= tol)
    const ordered = [...shot.camera.marks].sort((a, b) => a.time - b.time)
    const focal = spec.lens ?? existing?.focalLength ?? ordered[ordered.length - 1]?.focalLength ?? 35
    // Fork (fix-camera-set): a blocked view takes the nearest clear one (engine/camera-clear.ts).
    if (spec.subjectIds.every((id) => scene.entities.some((e) => e.id === id))) spec = clearShotSpec(scene, shot, spec, t, focal).spec
    const solved = new ShotEvaluator(scene, shot).solveShotAt(spec, t, focal)
    if (!solved) {
      get().toast('Could not frame that shot — a subject is missing.', 'error')
      return ''
    }
    let markId = existing?.id ?? ''
    get().mutate('frame shot', (doc) => {
      const sc = doc.scenes.find((s) => s.id === sceneId)
      const sh = sc?.shots.find((s) => s.id === shotId) ?? sc?.drafts?.find((s) => s.id === shotId)
      if (!sh) return
      let m = sh.camera.marks.find((x) => x.id === existing?.id)
      if (!m) {
        m = createCameraMark({ ...solved.position }, t, solved.pan, solved.tilt, solved.focalLength)
        sh.camera.marks.push(m)
      }
      markId = m.id
      m.position = { ...solved.position }
      m.pan = solved.pan
      m.tilt = solved.tilt
      m.roll = solved.roll
      m.focalLength = solved.focalLength
      m.shot = structuredClone(spec)
    })
    return markId
  },

  stageFight(input) {
    const { sceneId, shotId } = get()
    const scene = get().scene()
    const shot = get().shot()
    if (!scene || !shot) throw new Error('No active shot.')
    const spawned: Entity[] = []
    let fighters: [Entity, Entity]
    if (input.fighters) fighters = fightersOf(scene, input.fighters)
    else {
      const assets = input.assets ?? ['person.man', 'person.woman']
      const labels = input.labels ?? ['A', 'B']
      const used = scene.entities.map((e) => e.label?.color).filter((c): c is string => !!c)
      const { x, z, heading } = input.at
      const right = { x: Math.cos(heading), z: -Math.sin(heading) }
      for (let q = 0; q < 2; q++) {
        const side = q === 0 ? -1 : 1
        const pos = { x: x + right.x * side * (GUARD_DISTANCE / 2), y: 0, z: z + right.z * side * (GUARD_DISTANCE / 2) }
        const e = createEntity(assets[q]!, `Fighter ${labels[q]}`, pos)
        const color = nextLabelColor(used)
        used.push(color)
        e.label = { text: labels[q]!, color }
        // Face the other fighter (heading 0 faces -Z).
        e.transform.rotationY = Math.atan2(right.x * side, right.z * side)
        spawned.push(e)
      }
      fighters = [spawned[0]!, spawned[1]!]
    }
    // Weapons (fork): each fighter's new weapon, in its usual hand, with its own colour.
    const arming: Entity[] = []
    const colors = [...scene.entities, ...spawned].map((e) => e.label?.color).filter((c): c is string => !!c)
    fighters.forEach((holder, q) => {
      const assetId = input.weapons?.[q]
      if (!assetId || !weaponSpec(assetId)) return
      const w = createEntity(assetId, assetSpec(assetId).name, { ...holder.transform.position })
      w.heldBy = { entityId: holder.id, hand: handFor(w) }
      const color = nextLabelColor(colors)
      colors.push(color)
      w.label = { text: '', color }
      arming.push(w)
    })
    const fight: FightDoc = {
      id: newId('fight'),
      name: `Fight ${(scene.fights?.length ?? 0) + 1}`,
      fighterIds: [fighters[0].id, fighters[1].id],
      beats: structuredClone(input.beats),
      startT: 0.4,
      origin: { ...input.at },
      beatGap: 0.35,
      exaggeration: Math.min(3, Math.max(1, input.exaggeration ?? 1.5)),
      ...(input.coverage ? { coverage: input.coverage } : {})
    }
    // qa-fight bug 6: the shot grows to fit the whole fight.
    const fit = shotToFit(scene, shot, fight, arming, fighters)
    const sized = fit.shot
    let sol = fit.sol ?? solveInScene(scene, sized, fight, arming, fighters)
    if (spawned.length > 0) sol = placeClearOfProps(scene, sized, fight, sol, arming, fighters, [...spawned, ...arming])
    get().mutate('stage fight', (doc) => {
      const sc = doc.scenes.find((x) => x.id === sceneId)
      const sh = sc?.shots.find((x) => x.id === shotId) ?? sc?.drafts?.find((x) => x.id === shotId)
      const take = sc?.blocking.find((b) => b.id === sh?.blockingTakeId)
      if (!sc || !take) return
      sc.entities.push(...spawned)
      for (const w of arming) {
        setDownAtHand(sc, shotId, get().time, weaponsInHand(sc.entities, w.heldBy!.entityId, w.heldBy!.hand))
        sc.entities.push(w)
      }
      sc.fights = [...(sc.fights ?? []), fight]
      writeFightTracks(take, fight.fighterIds, sol)
      if (sh) growShot(sc, sh, sized, fight.id, sol.report)
      if (fight.coverage && sh) writeCoverage(sc, sh, fight, sol.report, fight.coverage, cameraLineSide(sc, sh, fight))
    })
    if (spawned.length > 0) set({ selection: { kind: 'entities', entityIds: spawned.map((e) => e.id) } })
    return { fightId: fight.id, report: sol.report }
  },

  updateFight(fightId, patch) {
    const { sceneId, shotId } = get()
    const scene = get().scene()
    const shot = get().shot()
    const current = scene?.fights?.find((f) => f.id === fightId)
    if (!scene || !shot || !current) throw new Error(`No fight "${fightId}": get_state lists the scene's fights.`)
    const fight: FightDoc = { ...structuredClone(current), ...structuredClone(patch) }
    fight.exaggeration = Math.min(3, Math.max(1, fight.exaggeration))
    const fit = shotToFit(scene, shot, fight)
    const sized = fit.shot
    const sol = fit.sol ?? solveInScene(scene, sized, fight)
    get().mutate('update fight', (doc) => {
      const sc = doc.scenes.find((x) => x.id === sceneId)
      const sh = sc?.shots.find((x) => x.id === shotId) ?? sc?.drafts?.find((x) => x.id === shotId)
      const take = sc?.blocking.find((b) => b.id === sh?.blockingTakeId)
      if (!sc || !take) return
      sc.fights = (sc.fights ?? []).map((f) => (f.id === fightId ? fight : f))
      writeFightTracks(take, fight.fighterIds, sol)
      if (sh) growShot(sc, sh, sized, fightId, sol.report)
      if (patch.coverage && sh) writeCoverage(sc, sh, fight, sol.report, patch.coverage, cameraLineSide(sc, sh, fight))
    })
    return sol.report
  },

  deleteFight(fightId) {
    const { sceneId } = get()
    if (!get().scene()?.fights?.some((f) => f.id === fightId)) throw new Error(`No fight "${fightId}": get_state lists the scene's fights.`)
    get().mutate('remove fight', (doc) => {
      const sc = doc.scenes.find((x) => x.id === sceneId)
      if (sc) sc.fights = (sc.fights ?? []).filter((f) => f.id !== fightId)
    })
  },

  coverFight(fightId, mode, side) {
    const { sceneId, shotId } = get()
    const scene = get().scene()
    const shot = get().shot()
    const fight = scene?.fights?.find((f) => f.id === fightId)
    if (!scene || !shot || !fight) throw new Error(`No fight "${fightId}": get_state lists the scene's fights.`)
    const sol = solveInScene(scene, shot, fight)
    const lineSide: 1 | -1 = side === 'right' ? 1 : side === 'left' ? -1 : cameraLineSide(scene, shot, fight)
    let cameraMarks = 0
    get().mutate('fight coverage', (doc) => {
      const sc = doc.scenes.find((x) => x.id === sceneId)
      const sh = sc?.shots.find((x) => x.id === shotId) ?? sc?.drafts?.find((x) => x.id === shotId)
      const f = sc?.fights?.find((x) => x.id === fightId)
      if (!sc || !sh || !f) return
      f.coverage = mode
      cameraMarks = writeCoverage(sc, sh, f, sol.report, mode, lineSide)
    })
    return { lineSide, cameraMarks }
  },

  armFightPlacement(input) {
    set({ pendingFight: structuredClone(input) })
    get().setPlacingChoreography({ kind: 'fight', performers: 2, durationS: get().shot()?.duration ?? 8, seed: 0, style: FIGHT_DIRECTOR_STYLE })
  },

  releaseShot(markId) {
    const { sceneId, shotId } = get()
    const scene = get().scene()
    const shot = get().shot()
    const mark = shot?.camera.marks.find((m) => m.id === markId)
    if (!scene || !shot || !mark?.shot) return
    const solved = new ShotEvaluator(scene, shot).solveShotAt(mark.shot, mark.time, mark.focalLength)
    get().mutate('release shot words', (doc) => {
      const sc = doc.scenes.find((s) => s.id === sceneId)
      const sh = sc?.shots.find((s) => s.id === shotId) ?? sc?.drafts?.find((s) => s.id === shotId)
      const m = sh?.camera.marks.find((x) => x.id === markId)
      if (!m) return
      if (solved) {
        m.position = { ...solved.position }
        m.pan = solved.pan
        m.tilt = solved.tilt
        m.roll = solved.roll
        m.focalLength = solved.focalLength
      }
      delete m.shot
    })
  },

  saveDraftOfShot() {
    const { sceneId, shotId } = get()
    let draftName = ''
    get().mutate('save draft', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const current =
        scene.shots.find((s) => s.id === shotId) ?? scene.drafts?.find((s) => s.id === shotId)
      if (!current) return
      const mainId = current.draftOf ?? current.id
      const main = scene.shots.find((s) => s.id === mainId) ?? current
      const clone = structuredClone(current)
      clone.id = newId('shot')
      clone.draftOf = mainId
      clone.camera.marks = clone.camera.marks.map((m) => ({ ...m, id: newId('cmark') }))
      clone.cameraBank = clone.cameraBank?.map((b) => ({
        ...b,
        camera: { ...b.camera, marks: b.camera.marks.map((m) => ({ ...m, id: newId('cmark') })) }
      }))
      scene.drafts = scene.drafts ?? []
      const version = scene.drafts.filter((d) => d.draftOf === mainId).length + 1
      clone.name = `${main.name} v${version}`
      draftName = clone.name
      scene.drafts.push(clone)
    })
    if (draftName) get().toast(`Saved as draft "${draftName}" — keep experimenting safely.`, 'success')
  },

  promoteDraft(draftId) {
    const { sceneId } = get()
    let promotedInto: string | null = null
    get().mutate('promote draft', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const draft = scene?.drafts?.find((d) => d.id === draftId)
      if (!scene || !draft?.draftOf) return
      const main = scene.shots.find((s) => s.id === draft.draftOf)
      if (!main) return
      main.duration = draft.duration
      main.fps = draft.fps
      main.aspect = draft.aspect
      main.blockingTakeId = draft.blockingTakeId
      main.camera = structuredClone(draft.camera)
      main.cameraName = draft.cameraName
      main.cameraBank = draft.cameraBank ? structuredClone(draft.cameraBank) : undefined
      main.notes = draft.notes
      main.referenceVideo = draft.referenceVideo ? { ...draft.referenceVideo } : undefined
      promotedInto = main.id
    })
    if (promotedInto) {
      set({ shotId: promotedInto, time: 0, playing: false })
      get().toast('Draft promoted — it is now the shot.', 'success')
    }
  },

  deleteDraft(draftId) {
    const { sceneId, shotId } = get()
    let fallback: string | null = null
    get().mutate('delete draft', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene?.drafts) return
      const draft = scene.drafts.find((d) => d.id === draftId)
      scene.drafts = scene.drafts.filter((d) => d.id !== draftId)
      if (shotId === draftId) fallback = draft?.draftOf ?? scene.shots[0]?.id ?? null
    })
    if (fallback) set({ shotId: fallback, time: 0, playing: false })
  },

  spawnSequence(opts) {
    const { sceneId, shotId } = get()
    const duration = get().shot()?.duration ?? 8
    const origin = opts.origin ?? { x: 0, z: 0, heading: 0 }
    // Fork (gap 3): a two-performer fight goes through the fight solver.
    if (opts.type === 'fight' && opts.count === 2) {
      stageRoutineFight({ beats: routineFightBeats(Math.floor(Math.random() * 1_000_000_000), 'brawl', 'finish', duration), at: origin })
      return
    }
    const specs = generateSequence({
      type: opts.type,
      count: opts.count,
      style: opts.style,
      origin,
      duration
    })
    const newIds: string[] = []
    get().mutate(`stage ${opts.type} sequence`, (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot = scene?.shots.find((s) => s.id === shotId)
      const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
      if (!scene || !take) return
      for (const spec of specs) {
        const entity = createEntity(spec.assetId, spec.name, { ...spec.position })
        entity.transform.rotationY = spec.rotationY
        if (spec.label) entity.label = { ...spec.label }
        scene.entities.push(entity)
        newIds.push(entity.id)
        if (spec.marks.length > 0) {
          take.tracks.push({
            entityId: entity.id,
            marks: spec.marks.map((m) => ({
              id: newId('mark'),
              time: m.time,
              hold: m.hold,
              easeIn: m.easeIn,
              easeOut: m.easeOut,
              position: { ...m.position },
              gait: m.gait,
              joints: m.joints ? { ...m.joints } : undefined
            }))
          })
        }
      }
    })
    if (newIds.length > 0) {
      set({ selection: { kind: 'entities', entityIds: newIds } })
      get().toast(
        `${newIds.length} performers staged and choreographed — ▶ to watch. Drag the group to reposition; every performer stays individually editable.`,
        'success'
      )
    }
  },

  spawnChoreography(spec, at) {
    // Fork: a Fight Director placement click stages the armed scripted fight.
    const pending = get().pendingFight
    if (spec.kind === 'fight' && spec.style === FIGHT_DIRECTOR_STYLE && pending) {
      set({ pendingFight: null })
      try {
        const { report } = get().stageFight({ ...pending, at })
        const warn = report.warnings.length ? `, ${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''}` : ''
        get().toast(`Fight staged: ${report.beats.length} beats${warn}. Press play to watch.`, 'success')
      } catch (e) {
        get().toast((e as Error).message, 'error')
      }
      return
    }
    const { sceneId, shotId } = get()
    const duration = routineDuration(spec) // fork (fix-routines): the Choreographer's Duration
    // Fork (gap 3): a two-person fight goes through the fight solver.
    if (spec.kind === 'fight' && spec.performers === 2) {
      stageRoutineFight({ beats: routineFightBeats(spec.seed, spec.style, spec.ending, duration), at, ...(spec.bodies ? { assets: spec.bodies } : {}) })
      return
    }
    const specs = buildRoutine({ ...spec, durationS: duration }, { origin: at })
    const newIds: string[] = []
    get().mutate(`choreograph ${spec.kind}`, (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot = scene?.shots.find((s) => s.id === shotId)
      const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
      if (!scene || !take) return
      fitShotToRoutine(scene, shot!, duration)
      for (const espec of specs) {
        const entity = createEntity(espec.assetId, espec.name, { ...espec.position })
        entity.transform.rotationY = espec.rotationY
        if (espec.label) entity.label = { ...espec.label }
        scene.entities.push(entity)
        newIds.push(entity.id)
        if (espec.marks.length > 0) {
          take.tracks.push({
            entityId: entity.id,
            marks: espec.marks.map((m) => ({
              id: newId('mark'),
              time: m.time,
              hold: m.hold,
              easeIn: m.easeIn,
              easeOut: m.easeOut,
              position: { ...m.position },
              gait: m.gait,
              arriveHeading: m.arriveHeading,
              posedMove: m.posedMove,
              joints: m.joints ? { ...m.joints } : undefined
            }))
          })
        }
      }
    })
    if (newIds.length > 0) {
      set({ selection: { kind: 'entities', entityIds: newIds } })
      get().toast(
        `Choreographed ${spec.kind} with ${newIds.length} performer${newIds.length > 1 ? 's' : ''} — ▶ to watch. Every performer stays individually editable.`,
        'success'
      )
    }
  },

  choreographSelected(spec) {
    get().choreographEntities(selectedEntityIds(get().selection), spec)
  },

  choreographEntities(entityIds, spec) {
    const { sceneId, shotId } = get()
    const scene = get().scene()
    const people = entityIds
      .map((id) => scene?.entities.find((e) => e.id === id))
      .filter((e): e is Entity => !!e && e.assetId.startsWith('person.'))
    if (people.length === 0) {
      get().toast('Choreography applies to people — select characters first.', 'info')
      return 0
    }
    // Stage the routine around the group's centroid, facing the first pick.
    const cx = people.reduce((s, e) => s + e.transform.position.x, 0) / people.length
    const cz = people.reduce((s, e) => s + e.transform.position.z, 0) / people.length
    const heading = people[0]!.transform.rotationY
    const duration = routineDuration(spec) // fork (fix-routines): the Choreographer's Duration
    // Fork (gap 3): two people fight through the fight solver (their bodies and spots stay).
    if (spec.kind === 'fight' && people.length === 2) {
      const beats = routineFightBeats(spec.seed, spec.style, spec.ending, duration)
      return stageRoutineFight({ beats, fighters: [people[0]!.id, people[1]!.id], at: { x: cx, z: cz, heading } }) ? 2 : 0
    }
    const specs = buildRoutine(
      { ...spec, performers: people.length, durationS: duration },
      { origin: { x: cx, z: cz, heading }, bodies: people.map((e) => ({ assetId: e.assetId, params: e.params, scale: e.transform.scale })) }
    )
    let applied = 0
    get().mutate(`apply choreography: ${spec.kind}`, (doc) => {
      const dScene = doc.scenes.find((s) => s.id === sceneId)
      const shot = dScene?.shots.find((s) => s.id === shotId)
      const take = dScene?.blocking.find((b) => b.id === shot?.blockingTakeId)
      if (!dScene || !take) return
      fitShotToRoutine(dScene, shot!, duration)
      for (let i = 0; i < people.length && i < specs.length; i++) {
        const entity = dScene.entities.find((e) => e.id === people[i]!.id)
        const espec = specs[i]!
        if (!entity) continue
        entity.transform.rotationY = espec.rotationY
        let track = take.tracks.find((t) => t.entityId === entity.id)
        if (!track) {
          track = { entityId: entity.id, marks: [] }
          take.tracks.push(track)
        }
        track.marks = espec.marks.map((m) => ({
          id: newId('mark'),
          time: m.time,
          hold: m.hold,
          easeIn: m.easeIn,
          easeOut: m.easeOut,
          position: { ...m.position },
          gait: m.gait,
          arriveHeading: m.arriveHeading,
          posedMove: m.posedMove,
          joints: m.joints ? { ...m.joints } : undefined
        }))
        applied++
      }
    })
    if (applied > 0)
      get().toast(`Choreographed ${applied} performer${applied > 1 ? 's' : ''} — ▶ to watch.`, 'success')
    return applied
  },

  applyMotionToEntities(entityIds, presetId) {
    const { sceneId, shotId } = get()
    const duration = get().shot()?.duration ?? 8
    let applied = 0
    get().mutate('restyle: motion', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot = scene?.shots.find((s) => s.id === shotId)
      const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
      if (!scene || !take) return
      for (const id of entityIds) {
        const entity = scene.entities.find((e) => e.id === id)
        if (!entity || !entity.assetId.startsWith('person.')) continue
        const specs = choreographMotion(
          presetId,
          { ...entity.transform.position },
          entity.transform.rotationY,
          duration,
          0,
          { assetId: entity.assetId, params: entity.params, scale: entity.transform.scale } // fork: its own body on the floor
        )
        if (!specs || specs.length === 0) continue
        // Fork: a weapon motion plays mirrored when the performer's weapon for it is in the other hand.
        const mirror = mirrorForHolder(presetId, id, scene.entities)
        let track = take.tracks.find((t) => t.entityId === id)
        if (!track) {
          track = { entityId: id, marks: [] }
          take.tracks.push(track)
        }
        track.marks = specs.map((m) => ({
          id: newId('mark'),
          time: m.time,
          hold: m.hold,
          easeIn: m.easeIn,
          easeOut: m.easeOut,
          position: { ...m.position },
          gait: m.gait,
          arriveHeading: m.arriveHeading,
          posedMove: m.posedMove,
          joints: m.joints ? (mirror ? mirrorJoints(m.joints) : { ...m.joints }) : undefined
        }))
        applied++
      }
    })
    if (applied > 0) get().toast(`Restyled ${applied} performer${applied > 1 ? 's' : ''} — ▶ to watch.`, 'success')
    else get().toast('That style applies to people — select characters.', 'info')
  },

  applyActionToEntities(entityIds, presetId) {
    const { sceneId, shotId } = get()
    const duration = get().shot()?.duration ?? 8
    const preset = ACTION_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    let applied = 0
    get().mutate('restyle: action', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const shot = scene?.shots.find((s) => s.id === shotId)
      const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
      if (!scene || !take) return
      for (const id of entityIds) {
        const entity = scene.entities.find((e) => e.id === id)
        if (!entity) continue
        const specs = preset.generate({
          start: {
            x: entity.transform.position.x,
            y: entity.transform.position.y,
            z: entity.transform.position.z,
            heading: entity.transform.rotationY
          },
          duration
        })
        let track = take.tracks.find((t) => t.entityId === id)
        if (!track) {
          track = { entityId: id, marks: [] }
          take.tracks.push(track)
        }
        track.marks = specs.map((m) => ({
          id: newId('mark'),
          time: m.time,
          hold: m.hold,
          easeIn: m.easeIn,
          easeOut: m.easeOut,
          position: { ...m.position },
          gait: m.gait
        }))
        applied++
      }
    })
    if (applied > 0) get().toast(`Applied ${preset.name} to ${applied} performer${applied > 1 ? 's' : ''}.`, 'success')
  },

  async importScan(sourcePath) {
    const { sceneId, projectFolder } = get()
    if (!projectFolder) {
      get().toast('Open or save a project before importing a scan.', 'error')
      return
    }
    let result: { relativePath: string; name: string }
    try {
      result = await window.blockout.importScan(projectFolder, sourcePath)
    } catch (e) {
      get().toast(`Scan import failed: ${(e as Error).message}`, 'error')
      return
    }
    const scan = createScan(result.name, result.relativePath, { x: 0, y: 0, z: 0 })
    get().mutate('import 3D scan', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene) return
      scene.scans = scene.scans ?? []
      // Number duplicates: "living-room 2", "living-room 3"…
      const count = scene.scans.filter((s) => s.name === scan.name).length
      if (count > 0) scan.name = `${scan.name} ${count + 1}`
      scene.scans.push(scan)
    })
    set({ selection: { kind: 'scan', scanId: scan.id } })
    get().toast(
      `Scan "${scan.name}" imported — block your action inside it. Scans stay in the editor and never appear in exports.`,
      'success'
    )
  },

  removeScan(scanId) {
    const { sceneId, selection } = get()
    get().mutate('remove scan', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (!scene?.scans) return
      scene.scans = scene.scans.filter((s) => s.id !== scanId)
    })
    if (selection?.kind === 'scan' && selection.scanId === scanId) set({ selection: null })
  },

  setScanVisible(scanId, visible) {
    const { sceneId } = get()
    get().mutate('scan visibility', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const scan = scene?.scans?.find((s) => s.id === scanId)
      if (scan) scan.visible = visible
    })
  },

  updateScanTransform(scanId, patch) {
    const { sceneId } = get()
    get().mutate('scan transform', (doc) => {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      const scan = scene?.scans?.find((s) => s.id === scanId)
      if (!scan) return
      if (patch.position) scan.position = { ...scan.position, ...patch.position }
      if (patch.rotationY !== undefined) scan.rotationY = patch.rotationY
      if (patch.scale !== undefined) scan.scale = Math.max(0.01, patch.scale)
      if (patch.flipped !== undefined) {
        if (patch.flipped) scan.flipped = true
        else delete scan.flipped
      }
    })
  },

  async saveStagePreset(name) {
    const scene = get().scene()
    if (!scene) return
    // A preset is the STAGING: entities + environment + blocking choreography.
    // Shots/cameras stay with the project — presets are starting points.
    const payload = {
      presetVersion: 1,
      name,
      environment: structuredClone(scene.environment),
      entities: structuredClone(scene.entities),
      blocking: structuredClone(scene.blocking)
    }
    const res = await window.blockout.presetSave(name, JSON.stringify(payload))
    if (res.ok) get().toast(`Preset "${name}" saved — reuse it from the Library in any project.`, 'success')
    else get().toast(`Could not save preset: ${res.error ?? 'unknown error'}`, 'error')
  },

  async applyStagePreset(id) {
    const json = await window.blockout.presetLoad(id)
    if (!json) {
      get().toast('Preset not found — it may have been deleted.', 'error')
      return
    }
    let payload: {
      name?: string
      environment?: Scene['environment']
      entities?: Scene['entities']
      blocking?: Scene['blocking']
    }
    try {
      payload = JSON.parse(json)
    } catch {
      get().toast('Preset file is corrupted.', 'error')
      return
    }
    // Stage into a brand-new scene with fresh ids so the preset (and any
    // scene it was saved from) is never mutated by later edits.
    let newSceneId: string | null = null
    get().mutate('apply stage preset', (doc) => {
      const scene = createScene(doc.scenes.length + 1)
      if (payload.name) scene.name = payload.name
      if (payload.environment) scene.environment = structuredClone(payload.environment)
      const idMap = new Map<string, string>()
      for (const src of payload.entities ?? []) {
        const e = structuredClone(src)
        const fresh = newId('ent')
        idMap.set(e.id, fresh)
        e.id = fresh
        scene.entities.push(e)
      }
      // Remap marriages and choreography onto the fresh entity ids.
      for (const e of scene.entities) {
        if (e.attachedTo) e.attachedTo = idMap.get(e.attachedTo) ?? undefined
        // Fork: held weapons stay in their (remapped) holder's hand.
        if (e.heldBy) {
          const holder = idMap.get(e.heldBy.entityId)
          if (holder) e.heldBy = { entityId: holder, hand: e.heldBy.hand }
          else delete e.heldBy
        }
      }
      const master = scene.blocking[0]!
      for (const take of payload.blocking ?? []) {
        for (const track of take.tracks) {
          const entityId = idMap.get(track.entityId)
          if (!entityId) continue
          master.tracks.push({
            entityId,
            marks: track.marks.map((m) => ({
              ...structuredClone(m),
              id: newId('mark'),
              attachTo: m.attachTo ? idMap.get(m.attachTo) : undefined
            }))
          })
        }
      }
      doc.scenes.push(scene)
      newSceneId = scene.id
    })
    if (newSceneId) {
      get().selectScene(newSceneId)
      get().toast(`Staged "${payload.name ?? 'preset'}" as a new scene — the original preset is untouched.`, 'success')
    }
  },

  toast(text, kind = 'info') {
    const id = newId('toast')
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setExportProgress: (p) =>
    set((s) => ({ exportProgress: { ...s.exportProgress, ...p } }))
}))

/** Serialize current doc for saving. */
export function currentProjectJson(): string | null {
  const doc = useStore.getState().doc
  return doc ? serializeProject(doc) : null
}

export type { AspectId, Entity }
