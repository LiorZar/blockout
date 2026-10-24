// Modified for cross-platform Windows support and the fork's MCP tools (incl. shot words, Fight Director, held weapons, mocap bots, their clips and their fights, routines on the set, car chases on an open road, curved mark paths) in 2026; see MODIFICATIONS.md.
/**
 * Renderer side of the agent control server (see src/main/control.ts and
 * mcp/blockout-mcp.mjs). External agents — Claude Code, Codex, Hermes, any
 * MCP client — drive the app through a whitelist of actions executed here
 * against the same store/scene paths the UI uses, so everything an agent
 * does is undoable, autosaved, and visible live.
 */

import { useStore, currentProjectJson, fightNotice, lastRoutineReport, lastSequenceCamera, refightShot, releaseHeldBy, routineFightStaged, slowFight, slowRoutine, solveInScene, stageFightOffThread, updateFightOffThread } from '../store'
import { offThread } from '../fight-offthread'
import { ASSET_CATALOG, assetSpec } from '@engine/assets'
import { isMocapAsset, waitForMocap } from '@engine/mocap/registry'
import { assetListed, mocapStatus } from '../mocap/library'
import { createActorMark, createCameraMark } from '@engine/schema'
import { newId } from '@engine/ids'
import { nextLabelColor, resolveColor, LABEL_COLOR_NAMES } from '@engine/palette'
import { RIGS } from '@engine/rigs'
import { GAITS } from '@engine/gaits'
import {
  renderStillPngForTest,
  exportShot,
  exportStillAtPlayhead,
  exportContactSheet,
  exportAnimatic,
  type ExportResolution
} from '../export/exporter'
import { BUILTIN_PROFILES } from '@engine/profiles'
import { generatePrompt } from '@engine/prompt'
import { profileWarnings } from '@engine/profile-limits'
import { OPEN_ROAD, onRoad, roadLength } from '@engine/road-kit' // fork (street-kit)
import { CHASE_CAMERA_MOVE } from '../camera-move' // fork (street-kit T5)
import { getSceneManager } from '../export/scene-access'
import type { ActorMark, AspectId, CameraMark, Entity, GaitId, LightingPresetId, RigId, Scene, Shot, V3 } from '@engine/types'
import { WEAPON_SPECS, weaponSpec } from '@engine/weapons'
import type { ChoreoKind, FormationId, RoutineSpec } from '@engine/choreography'
import type { FramingKind } from '../bus'
import { SHOT_SIZES } from '@engine/camera'
import { ShotEvaluator } from '@engine/evaluate'
import { parseShotWords } from '@engine/shot-words'
import { viewNote } from '@engine/camera-clear'
import type { ShotAngle, ShotSide, ShotSpec } from '@engine/shot'
import { MOVE_ALIASES, SHOT_MOVES, STRIKE_IDS, listFightMoves, listShotMoves } from '@engine/fight/moves'
import { defaultTarget, formatFightScript, parseFightScript, randomFightScript } from '@engine/fight/script'
import type { FightSolution } from '@engine/fight/solve'
import type { FightBeat, FightDoc, FightOutcome } from '@engine/types'

type Params = Record<string, unknown>
type ControlResult = { ok: boolean; data?: unknown; error?: string }

const str = (p: Params, k: string): string | undefined =>
  typeof p[k] === 'string' ? (p[k] as string) : undefined
const flt = (p: Params, k: string): number | undefined =>
  typeof p[k] === 'number' && isFinite(p[k] as number) ? (p[k] as number) : undefined
const bool = (p: Params, k: string): boolean | undefined =>
  typeof p[k] === 'boolean' ? (p[k] as boolean) : undefined
const strList = (p: Params, k: string): string[] =>
  Array.isArray(p[k]) ? (p[k] as unknown[]).filter((v): v is string => typeof v === 'string') : []

/** Fork (Lior's test): a {x, y?, z} point in meters; y defaults to `y`. */
function pointParam(v: unknown, y: number, what: string): V3 {
  const o = (v ?? {}) as Record<string, unknown>
  const n = (k: string): number | undefined => (typeof o[k] === 'number' && isFinite(o[k] as number) ? (o[k] as number) : undefined)
  const x = n('x')
  const z = n('z')
  if (typeof v !== 'object' || v === null || x === undefined || z === undefined) {
    throw new Error(`${what} must be {x, z} (y optional), in meters.`)
  }
  return { x, y: n('y') ?? y, z }
}

/** Fork (Lior's test): a mark's `handle` param: undefined when absent, null to clear it. */
function handleParam(p: Params): V3 | null | undefined {
  if (p.handle === undefined) return undefined
  if (p.handle === null) return null
  return pointParam(p.handle, 0, 'handle')
}

/** Fork (Lior's test): a mark's `via` param: undefined when absent, [] to clear it. */
function viaParam(p: Params, y: number): V3[] | undefined {
  if (p.via === undefined) return undefined
  if (!Array.isArray(p.via)) throw new Error('via must be a list of {x, z} points (y optional), in meters.')
  return p.via.map((v, i) => pointParam(v, y, `via[${i}]`))
}

/** Fork (Lior's test): write a mark's curve params (handle null / via [] make it straight again). */
function applyCurve(m: CameraMark | ActorMark, handle: V3 | null | undefined, via: V3[] | undefined): void {
  if (handle === null) delete m.handle
  else if (handle) m.handle = handle
  if (via && via.length > 0) m.via = via
  else if (via) delete m.via
}

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => Math.round((rad * 180) / Math.PI)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const LIGHTING_PRESETS: LightingPresetId[] = [
  'day',
  'goldenHour',
  'night',
  'interiorWarm',
  'interiorCool',
  'club',
  'middaySky',
  'goldenHourSky',
  'blueHourSky'
]
/** Fork: a mocap bot asked for without the local Mixamo library (or before it has loaded). */
const MOCAP_MISSING = "is a Mixamo mocap bot: it needs the local Mixamo library (<config dir>/mixamo), which isn't installed or hasn't loaded — call list_assets for the bodies on offer."

const COLOR_HINT = `a name (${Object.keys(LABEL_COLOR_NAMES).join(', ')}) or a hex value like #e5484d`

function requireManager(): NonNullable<ReturnType<typeof getSceneManager>> {
  const m = getSceneManager()
  if (!m) throw new Error('Viewport not ready yet — try again in a moment.')
  return m
}

function requireDoc(): void {
  if (!useStore.getState().doc) {
    throw new Error('No project open — create or open a project in the app first.')
  }
}

type Take = Scene['blocking'][number]

function activeTake(scene: Scene | null | undefined, shot: Shot | null | undefined): Take | undefined {
  return scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
}

function entitySummary(e: Entity, take: Take | undefined, at?: V3): unknown {
  const p = at ?? e.transform.position
  return {
    id: e.id,
    name: e.name,
    assetId: e.assetId,
    x: p.x,
    y: p.y,
    z: p.z,
    rotationDeg: toDeg(e.transform.rotationY),
    label: e.label?.text,
    color: e.label?.color,
    heightScale: typeof e.params?.height === 'number' ? e.params.height : undefined,
    build: typeof e.params?.build === 'number' ? e.params.build : undefined,
    hideInExports: e.excludeFromExport === true || undefined,
    attachedTo: e.attachedTo,
    heldBy: e.heldBy ? { entityId: e.heldBy.entityId, hand: e.heldBy.hand } : undefined,
    markCount: take?.tracks.find((t) => t.entityId === e.id)?.marks.length ?? 0
  }
}

/** Fork: held weapons report where they are — in the hand at the playhead — not their stale placement. */
function heldWeaponPositions(scene: Scene, shot: Shot | null, time: number): Map<string, V3> {
  const out = new Map<string, V3>()
  if (!shot || !scene.entities.some((e) => e.heldBy)) return out
  const held = new Set(scene.entities.filter((e) => e.heldBy).map((e) => e.id))
  for (const st of new ShotEvaluator(scene, shot).evaluate(time).entities) {
    if (held.has(st.entityId)) out.set(st.entityId, st.position)
  }
  return out
}

function environmentSummary(scene: Scene): unknown {
  return {
    lighting: scene.environment.lighting,
    sunAzimuthDeg: toDeg(scene.environment.sunAzimuth),
    sunElevationDeg: toDeg(scene.environment.sunElevation),
    fog: scene.environment.fog
  }
}

/** Run `fn` on the active scene/shot inside one undoable mutation. */
function mutateActive(label: string, fn: (scene: Scene, shot: Shot | undefined) => void): void {
  const st = useStore.getState()
  st.mutate(label, (doc) => {
    const scene = doc.scenes.find((sc) => sc.id === st.sceneId)
    if (scene) fn(scene, scene.shots.find((sh) => sh.id === st.shotId))
  })
}

/** A timeline lane: the shot camera, or one entity's track in the active take. */
type Lane = { kind: 'camera'; marks: CameraMark[] } | { kind: 'actor'; marks: ActorMark[] }

function resolveLane(scene: Scene, shot: Shot | undefined, lane: string): Lane {
  if (lane === 'camera') {
    if (!shot) throw new Error('No active shot.')
    return { kind: 'camera', marks: shot.camera.marks }
  }
  if (!scene.entities.some((e) => e.id === lane)) {
    throw new Error(`No lane "${lane}" — use "camera" or an entity id from get_state.`)
  }
  const track = activeTake(scene, shot)?.tracks.find((t) => t.entityId === lane)
  return { kind: 'actor', marks: track?.marks ?? [] }
}

function markSummary(m: CameraMark | ActorMark): unknown {
  const base = {
    id: m.id,
    time: m.time,
    x: m.position.x,
    y: m.position.y,
    z: m.position.z,
    hold: m.hold,
    easeIn: m.easeIn,
    easeOut: m.easeOut,
    ...(m.handle ? { handle: m.handle } : {}), // fork (Lior's test): curved paths
    ...(m.via ? { via: m.via } : {})
  }
  if ('pan' in m) {
    return {
      ...base,
      panDeg: toDeg(m.pan),
      tiltDeg: toDeg(m.tilt),
      rollDeg: toDeg(m.roll ?? 0),
      focalLength: m.focalLength,
      focusDistance: m.focusDistance,
      shot: m.shot
    }
  }
  return { ...base, gait: m.gait, ...(m.clip ? { clip: m.clip } : {}) } // fork: a mocap bot's clip run
}

const SHOT_SIDES: ShotSide[] = ['front', 'frontLeft', 'left', 'backLeft', 'back', 'backRight', 'right', 'frontRight', 'line']
const SHOT_ANGLES: ShotAngle[] = ['eye', 'low', 'high', 'overhead', 'ground']

const FIGHT_OUTCOMES: FightOutcome[] = ['hit', 'block', 'parry', 'slip', 'duck', 'miss', 'ko']
const FIGHT_COVERAGE = ['master', 'punch-in', 'over-shoulder', 'follow'] as const
const FIGHT_STYLES = ['brawl', 'martial-arts', 'sparring'] as const

/** Fighter labels for a script: the entities' label texts, else A / B. */
function fightLabels(scene: Scene, ids: string[]): [string, string] {
  const name = (id: string | undefined, fallback: string): string =>
    scene.entities.find((e) => e.id === id)?.label?.text || fallback
  return [name(ids[0], 'A'), name(ids[1], 'B')]
}

/** stage_fight `weapons`: [A's, B's] weapon assetId or null. */
function fightWeapons(params: Params): [string | null, string | null] | undefined {
  const raw = params.weapons
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error('stage_fight: weapons must be two entries, [A, B]: a weapon assetId from list_weapons, or null.')
  return raw.map((w, q) => {
    if (w === null || w === '') return null
    if (typeof w !== 'string' || !weaponSpec(w)) throw new Error(`stage_fight: weapons[${q}] "${String(w)}" isn't a weapon — call list_weapons.`)
    return w
  }) as [string | null, string | null]
}

/** Gap 3 (fork): the fight a two-person routine staged through the fight solver, if it did. */
/** Fork (street-kit): the open road a car chase's lead car starts on. */
function chaseRoadId(scene: Scene | null, leadId: string | undefined): { roadId?: string } {
  const lead = scene?.entities.find((e) => e.id === leadId)
  if (!scene || !lead) return {}
  const road = scene.entities.find(
    (e) => e.assetId === OPEN_ROAD && onRoad({ x: e.transform.position.x, z: e.transform.position.z, heading: e.transform.rotationY, length: roadLength(e.params) }, lead.transform.position)
  )
  return road ? { roadId: road.id } : {}
}

/** Fork (street-kit T5): the camera move a car chase laid on an unmoved camera: its preset, rig and what the lay said. */
function chaseCamera(type: string): { camera?: { presetId: string; rig: string; note?: string; warning?: string } } {
  const laid = type === 'carChase' ? lastSequenceCamera() : null
  const rig = useStore.getState().shot()?.camera.rig
  if (!laid || !rig) return {}
  return { camera: { presetId: CHASE_CAMERA_MOVE, rig, ...(laid.note ? { note: laid.note } : {}), ...(laid.warning ? { warning: laid.warning } : {}) } }
}

function newFightId(fightsBefore: number): { fightId?: string } {
  const fights = useStore.getState().scene()?.fights ?? []
  return fights.length > fightsBefore ? { fightId: fights[fights.length - 1]!.id } : {}
}

/** stage_fight `assets` / `labels`: [A's, B's] body (a person asset id) and name for the fighters it spawns. */
function fightCast(params: Params): { assets?: [string, string]; labels?: [string, string] } {
  const pair = (key: string, check: (v: unknown, q: number) => string): [string, string] | undefined => {
    const raw = params[key]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`stage_fight: ${key} must be two entries, [A, B].`)
    return [check(raw[0], 0), check(raw[1], 1)]
  }
  const assets = pair('assets', (v, q) => {
    if (typeof v !== 'string' || !v.startsWith('person.') || !ASSET_CATALOG.some((a) => a.id === v)) {
      throw new Error(`stage_fight: assets[${q}] "${String(v)}" isn't a person — call list_assets with category people.`)
    }
    if (!assetListed(v)) throw new Error(`stage_fight: assets[${q}] "${v}" ${MOCAP_MISSING}`)
    return v
  })
  const labels = pair('labels', (v, q) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`stage_fight: labels[${q}] must be a non-empty name.`)
    return v.trim()
  })
  if (labels && labels[0].toLowerCase() === labels[1].toLowerCase()) throw new Error('stage_fight: the two labels must differ.')
  return { ...(assets ? { assets } : {}), ...(labels ? { labels } : {}) }
}

/** Fork (mocap-backlog): spawn_sequence / spawn_choreography `bodies`, the panels' Bodies: [men's, women's] person asset ids. */
function castBodies(params: Params, tool: string): [string, string] | undefined {
  const raw = params.bodies
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${tool}: bodies must be two entries, [the men, the women].`)
  return raw.map((v, q) => {
    if (typeof v !== 'string' || !v.startsWith('person.') || !ASSET_CATALOG.some((a) => a.id === v)) {
      throw new Error(`${tool}: bodies[${q}] "${String(v)}" isn't a person — call list_assets with category people.`)
    }
    if (!assetListed(v)) throw new Error(`${tool}: bodies[${q}] "${v}" ${MOCAP_MISSING}`)
    return v
  }) as [string, string]
}

/** Beats from `script` (text), `beats` (array) or `random` ({seed, style, ending}). */
function fightBeatsFromParams(params: Params, tool: string, labels: [string, string], duration: number): FightBeat[] | undefined {
  const script = str(params, 'script')
  if (script !== undefined) {
    const parsed = parseFightScript(script, labels)
    if ('error' in parsed) throw new Error(`${tool}: ${parsed.error}`)
    return parsed.beats
  }
  if (Array.isArray(params.beats)) {
    return (params.beats as unknown[]).map((raw, k) => {
      const b = (raw ?? {}) as Record<string, unknown>
      const where = `${tool}: beats[${k}]`
      const attacker = b.attacker === 1 || b.attacker === 'B' ? 1 : b.attacker === 0 || b.attacker === 'A' ? 0 : null
      if (attacker === null) throw new Error(`${where}.attacker must be 0 or 1 (A or B).`)
      const move = typeof b.move === 'string' ? (MOVE_ALIASES[b.move.toLowerCase()] ?? b.move) : ''
      if (!STRIKE_IDS.includes(move) && !SHOT_MOVES.has(move)) throw new Error(`${where}.move "${String(b.move)}" is not a strike: list_fight_moves shows the moves.`)
      const target = b.target ?? defaultTarget(move)
      if (target !== 'head' && target !== 'body' && target !== 'legs') throw new Error(`${where}.target must be head, body or legs.`)
      const outcomes = Array.isArray(b.outcomes) ? (b.outcomes as unknown[]) : ['hit']
      for (const o of outcomes) if (!FIGHT_OUTCOMES.includes(o as FightOutcome)) throw new Error(`${where}.outcomes: unknown "${String(o)}" (use ${FIGHT_OUTCOMES.join(', ')}).`)
      const beat: FightBeat = {
        attacker,
        move,
        target,
        outcomes: outcomes.length > 0 ? (outcomes as FightOutcome[]) : ['hit'],
        power: typeof b.power === 'number' ? clamp(b.power, 0.2, 1) : 0.7
      }
      if (typeof b.at === 'number') beat.at = Math.max(0, b.at)
      return beat
    })
  }
  const random = params.random as { seed?: unknown; style?: unknown; ending?: unknown } | undefined
  if (random && typeof random === 'object') {
    const style = typeof random.style === 'string' ? random.style : 'sparring'
    if (!(FIGHT_STYLES as readonly string[]).includes(style)) throw new Error(`${tool}: random.style must be ${FIGHT_STYLES.join(', ')}.`)
    const seed = typeof random.seed === 'number' ? Math.round(random.seed) : Math.floor(Math.random() * 1e9)
    const ending = random.ending === 'standing' ? 'standing' : 'ko'
    return randomFightScript(seed, style as (typeof FIGHT_STYLES)[number], duration, { ending })
  }
  return undefined
}

function fightCoverage(params: Params, tool: string): FightDoc['coverage'] | undefined {
  const c = str(params, 'coverage')
  if (c === undefined) return undefined
  if (!(FIGHT_COVERAGE as readonly string[]).includes(c)) throw new Error(`${tool}: coverage must be one of ${FIGHT_COVERAGE.join(', ')}.`)
  return c as FightDoc['coverage']
}

/** A fight as the fight tools return it: id, editable script text, solver report. */
function fightResult(fightId: string, report?: FightSolution['report']): unknown {
  const st = useStore.getState()
  const scene = st.scene()
  const shot = st.shot()
  const fight = scene?.fights?.find((f) => f.id === fightId)
  if (!scene || !shot || !fight) throw new Error(`No fight "${fightId}": get_state lists the scene's fights.`)
  let rep = report
  if (!rep) {
    if (fight.fighterIds.some((id) => !scene.entities.some((e) => e.id === id))) throw new Error(`A fighter of "${fightId}" was deleted: get_state lists the scene's entities.`)
    // Fork: the same solve as the store's (held weapons and set props included).
    rep = solveInScene(scene, shot, fight).report
  }
  return { fightId, name: fight.name, script: formatFightScript(fight.beats, fightLabels(scene, fight.fighterIds)), report: rep }
}

/** A ShotSpec from frame_shot's structured fields, validated against the scene. */
function shotSpecFromParams(params: Params, scene: Scene): ShotSpec {
  const size = str(params, 'size')
  if (!size || !(size in SHOT_SIZES)) {
    throw new Error(`frame_shot: give words, or size (${Object.keys(SHOT_SIZES).join(', ')}) and subjectIds.`)
  }
  const known = (id: string): void => {
    if (!scene.entities.some((e) => e.id === id)) throw new Error(`frame_shot: no entity "${id}" — use an entity id from get_state.`)
  }
  const subjectIds = strList(params, 'subjectIds')
  if (subjectIds.length === 0) throw new Error('frame_shot: subjectIds must list at least one entity id from get_state.')
  subjectIds.forEach(known)
  const spec: ShotSpec = { size: size as ShotSpec['size'], subjectIds }
  const over = params.over as { entityId?: unknown; shoulder?: unknown } | undefined
  if (over && typeof over === 'object') {
    if (typeof over.entityId !== 'string') throw new Error('frame_shot: over.entityId must be an entity id from get_state.')
    known(over.entityId)
    if (subjectIds.includes(over.entityId)) throw new Error("frame_shot: the over-the-shoulder entity can't also be the subject.")
    spec.over = { entityId: over.entityId, shoulder: over.shoulder === 'left' ? 'left' : 'right' }
  }
  const side = str(params, 'side')
  if (side !== undefined) {
    if (!SHOT_SIDES.includes(side as ShotSide)) throw new Error(`frame_shot: side must be one of ${SHOT_SIDES.join(', ')}.`)
    spec.side = side as ShotSide
  }
  const angle = str(params, 'angle')
  if (angle !== undefined) {
    if (!SHOT_ANGLES.includes(angle as ShotAngle)) throw new Error(`frame_shot: angle must be one of ${SHOT_ANGLES.join(', ')}.`)
    spec.angle = angle as ShotAngle
  }
  const lens = flt(params, 'lens')
  if (lens !== undefined) spec.lens = clamp(lens, 8, 300)
  const dutchDeg = flt(params, 'dutchDeg')
  if (dutchDeg !== undefined) spec.dutchDeg = clamp(dutchDeg, -45, 45)
  return spec
}

const CAMERA_ONLY = ['panDeg', 'tiltDeg', 'rollDeg', 'focalLength', 'focusDistance']

function exportProfileId(params: Params, tool: string): string {
  const id = str(params, 'profileId') ?? 'seedance-2'
  if (!BUILTIN_PROFILES.some((p) => p.id === id)) {
    throw new Error(`${tool}: unknown profileId "${id}" — call list_export_profiles for ids.`)
  }
  return id
}

function exportResolution(params: Params, tool: string): ExportResolution {
  const r = str(params, 'resolution') ?? 'auto'
  if (r !== 'auto' && r !== '720p' && r !== '1080p') {
    throw new Error(`${tool}: resolution must be auto, 720p or 1080p (got "${r}").`)
  }
  return r
}

/** An export's path relative to the project folder, with forward slashes. */
function projectRelative(path: string): string {
  const folder = (useStore.getState().projectFolder ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const p = path.replace(/\\/g, '/')
  return folder && p.startsWith(folder + '/') ? p.slice(folder.length + 1) : p
}

function requireIdle(): void {
  if (useStore.getState().exportProgress.running) {
    throw new Error('An export is already running. Try again when it finishes.')
  }
}

function summary(): unknown {
  const s = useStore.getState()
  const scene = s.scene()
  const shot = s.shot()
  const take = activeTake(scene, shot)
  const heldAt = scene ? heldWeaponPositions(scene, shot, s.time) : new Map<string, V3>()
  return {
    project: s.doc?.name ?? null,
    mode: s.mode,
    time: s.time,
    mocap: mocapStatus(), // fork (qa-fixes): whether the Mixamo library has loaded the bots and all their clips
    scene: scene
      ? {
          id: scene.id,
          name: scene.name,
          lighting: scene.environment.lighting,
          environment: environmentSummary(scene),
          entities: scene.entities.map((e) => entitySummary(e, take, heldAt.get(e.id))),
          fights: (scene.fights ?? []).map((f) => ({ id: f.id, name: f.name, fighterIds: f.fighterIds, beats: f.beats.length })),
          scans: (scene.scans ?? []).map((sc) => ({
            id: sc.id,
            name: sc.name,
            visible: sc.visible,
            x: sc.position.x,
            y: sc.position.y,
            z: sc.position.z,
            rotationDeg: toDeg(sc.rotationY),
            scale: sc.scale
          }))
        }
      : null,
    shot: shot
      ? {
          id: shot.id,
          name: shot.name,
          duration: shot.duration,
          fps: shot.fps,
          aspect: shot.aspect,
          camera: shot.cameraName ?? 'A',
          rig: shot.camera.rig,
          rigIntensity: shot.camera.rigIntensity,
          trackEntityId: shot.camera.trackEntityId ?? null,
          cameraMarks: shot.camera.marks.map((m, i) => ({
            index: i + 1,
            id: m.id,
            time: m.time,
            x: m.position.x,
            y: m.position.y,
            z: m.position.z,
            panDeg: toDeg(m.pan),
            tiltDeg: toDeg(m.tilt),
            rollDeg: toDeg(m.roll ?? 0),
            focalLength: m.focalLength,
            hold: m.hold,
            easeIn: m.easeIn,
            easeOut: m.easeOut,
            shot: m.shot
          }))
        }
      : null,
    allShots: scene?.shots.map((sh) => ({ id: sh.id, name: sh.name })) ?? [],
    allScenes:
      s.doc?.scenes.map((sc) => ({
        id: sc.id,
        name: sc.name,
        shots: sc.shots.map((sh) => ({ id: sh.id, name: sh.name }))
      })) ?? [],
    conventions:
      'meters; +X right, -Z forward; heading/pan 0 faces -Z; rotationDeg/panDeg counter-clockwise seen from above (90 faces -X)'
  }
}

/**
 * Build a validated `RoutineSpec` from control params (shared by
 * spawn_choreography and choreograph_entities). The engine stays pure — this
 * renderer side picks the default seed when none is supplied.
 */
/** Fork (set-routines): the last routine's notes (what moved to fit the set) and warnings (what doesn't fit), when it had any. */
function routineNotes(): { notes?: string[]; warnings?: string[] } {
  const r = lastRoutineReport()
  return { ...(r.notes.length ? { notes: [...r.notes] } : {}), ...(r.warnings.length ? { warnings: [...r.warnings] } : {}) }
}

function routineSpecFromParams(params: Params): RoutineSpec {
  const kind = str(params, 'kind') as ChoreoKind | undefined
  if (!kind || !['dance', 'fight', 'chase'].includes(kind)) {
    throw new Error("kind must be 'dance', 'fight', or 'chase'.")
  }
  const spec: RoutineSpec = {
    kind,
    performers: Math.round(flt(params, 'performers') ?? (kind === 'dance' ? 6 : 2)),
    durationS: flt(params, 'durationS') ?? useStore.getState().shot()?.duration ?? 8,
    seed: flt(params, 'seed') ?? Math.floor(Math.random() * 1e9)
  }
  const style = str(params, 'style')
  if (style) spec.style = style
  const bpm = flt(params, 'bpm')
  if (bpm !== undefined) spec.bpm = bpm
  const formation = str(params, 'formation')
  if (formation) spec.formation = formation as FormationId
  const ending = str(params, 'ending')
  if (ending) spec.ending = ending
  const canon = bool(params, 'canon')
  if (canon !== undefined) spec.canon = canon
  const mirror = bool(params, 'mirror')
  if (mirror !== undefined) spec.mirror = mirror
  const formationChange = bool(params, 'formationChange')
  if (formationChange !== undefined) spec.formationChange = formationChange
  return spec
}

/**
 * While an export renders, store.mutate refuses edits (toast only), so an edit
 * tool would report success for a change that never happened. Refuse every
 * action except reads and exports (which answer for themselves).
 */
const ALLOWED_DURING_EXPORT = /^(get_|list_|export_)|^screenshot$/

/** Fork (qa-fixes, mocap-qa bug 3): the longest a tool waits for the Mixamo library's clips (ms). */
const MOCAP_WAIT = 120_000

/**
 * Fork (qa-fixes, mocap-qa bug 3): whether a call casts or moves a mocap bot.
 * The bots' bodies load before their clips; a fight, routine or motion laid
 * in between plays keyframe moves and keeps them, so such a call waits.
 */
function involvesBots(action: string, params: Params): boolean {
  const scene = useStore.getState().scene()
  const assetOf = (id: string): string => scene?.entities.find((e) => e.id === id)?.assetId ?? ''
  const list = (key: string): string[] => (Array.isArray(params[key]) ? (params[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [])
  let ids: string[] = []
  if (action === 'stage_fight') ids = [...list('assets'), ...list('fighterIds').map(assetOf)]
  else if (action === 'update_fight') ids = (scene?.fights?.find((f) => f.id === params.fightId)?.fighterIds ?? []).map(assetOf)
  else if (action === 'spawn_sequence' || action === 'spawn_choreography') ids = list('bodies')
  else if (action === 'choreograph_entities' || action === 'apply_motion') ids = list('entityIds').map(assetOf)
  return ids.some(isMocapAsset)
}

async function execute(action: string, params: Params): Promise<unknown> {
  const s = useStore.getState()
  if (s.exportProgress.running && !ALLOWED_DURING_EXPORT.test(action)) {
    throw new Error('An export is already running.')
  }
  // Fork (qa-fixes): a call that casts or moves a bot waits for the library's clips, and says so if they never come.
  if (involvesBots(action, params) && !(await waitForMocap(MOCAP_WAIT))) {
    throw new Error(`${action}: the Mixamo library is still loading after ${MOCAP_WAIT / 1000} s, so the bots can't play their clips yet; nothing was staged. Try again once get_state says mocap.ready.`)
  }
  switch (action) {
    case 'get_state':
      requireDoc()
      return summary()

    case 'list_assets': {
      const cat = str(params, 'category')
      return ASSET_CATALOG.filter((a) => (!cat || a.category === cat) && assetListed(a.id)).map((a) => ({
        id: a.id,
        name: a.name,
        category: a.category
      }))
    }

    case 'add_entity': {
      requireDoc()
      const assetId = str(params, 'assetId') ?? ''
      if (!ASSET_CATALOG.some((a) => a.id === assetId)) {
        throw new Error(`Unknown assetId "${assetId}" — call list_assets for valid ids.`)
      }
      if (isMocapAsset(assetId) && !assetListed(assetId)) throw new Error(`add_entity: "${assetId}" ${MOCAP_MISSING}`)
      const rawColor = str(params, 'color')
      const color = rawColor === undefined ? undefined : resolveColor(rawColor)
      if (color === null) throw new Error(`add_entity: unknown color "${rawColor}". Use ${COLOR_HINT}.`)
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      // Distinct colours for labelled entities, so the video model can tell them apart.
      const used = (s.scene()?.entities ?? []).filter((e) => e.label?.text).map((e) => e.label!.color)
      const entityId = s.addEntity(assetId, { x, y: 0, z })
      const rotationDeg = flt(params, 'rotationDeg')
      const label = str(params, 'label')
      if (rotationDeg !== undefined || label || color) {
        s.mutate('agent: place entity', (doc) => {
          for (const scene of doc.scenes) {
            const e = scene.entities.find((en) => en.id === entityId)
            if (!e) continue
            if (rotationDeg !== undefined) e.transform.rotationY = toRad(rotationDeg)
            if (label || color) e.label = { text: label ?? '', color: color ?? nextLabelColor(used) }
          }
        })
      }
      const placed = useStore.getState().scene()?.entities.find((e) => e.id === entityId)
      return { entityId, name: assetSpec(assetId)?.name, color: placed?.label?.color }
    }

    case 'move_entity': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      let found = false
      s.mutate('agent: move entity', (doc) => {
        for (const scene of doc.scenes) {
          const e = scene.entities.find((en) => en.id === entityId)
          if (!e) continue
          found = true
          const x = flt(params, 'x')
          const y = flt(params, 'y')
          const z = flt(params, 'z')
          const rotationDeg = flt(params, 'rotationDeg')
          if (x !== undefined) e.transform.position.x = x
          if (y !== undefined) e.transform.position.y = y
          if (z !== undefined) e.transform.position.z = z
          if (rotationDeg !== undefined) e.transform.rotationY = toRad(rotationDeg)
        }
      })
      if (!found) throw new Error(`No entity "${entityId}" — call get_state for ids.`)
      return { moved: entityId }
    }

    case 'delete_entity': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      let found = false
      s.mutate('agent: delete entity', (doc) => {
        for (const scene of doc.scenes) {
          if (!scene.entities.some((e) => e.id === entityId)) continue
          found = true
          releaseHeldBy(scene, s.shotId, s.time, new Set([entityId]))
          scene.entities = scene.entities.filter((e) => e.id !== entityId)
          for (const take of scene.blocking) {
            take.tracks = take.tracks.filter((t) => t.entityId !== entityId)
          }
          for (const sh of scene.shots) {
            if (sh.camera.mountEntityId === entityId) delete sh.camera.mountEntityId
          }
        }
      })
      if (!found) throw new Error(`No entity "${entityId}" — call get_state for ids.`)
      if (useStore.getState().selection?.kind === 'entity') s.setSelection(null)
      return { deleted: entityId }
    }

    case 'list_weapons': {
      return {
        weapons: WEAPON_SPECS.map((w) => ({
          assetId: w.assetId,
          name: assetSpec(w.assetId).name,
          kind: w.kind,
          strike: w.strike,
          twoHanded: w.twoHanded,
          usualHand: w.defaultHand
        })),
        held: (s.scene()?.entities ?? [])
          .filter((e) => e.heldBy)
          .map((e) => ({ weaponId: e.id, assetId: e.assetId, holderId: e.heldBy!.entityId, hand: e.heldBy!.hand }))
      }
    }

    case 'hold_weapon': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const assetId = str(params, 'assetId')
      const weaponId = str(params, 'weaponId')
      const hand = str(params, 'hand')
      if (hand !== undefined && hand !== 'L' && hand !== 'R') {
        throw new Error(`hold_weapon: hand must be L or R (got "${hand}").`)
      }
      if (!assetId === !weaponId) {
        throw new Error('hold_weapon: give assetId (a new weapon) or weaponId (one already in the scene), not both.')
      }
      if (!s.scene()?.entities.some((e) => e.id === entityId)) {
        throw new Error(`hold_weapon: no entity "${entityId}" in this scene — call get_state for ids.`)
      }
      if (assetId && !weaponSpec(assetId)) throw new Error(`hold_weapon: "${assetId}" isn't a weapon — call list_weapons.`)
      let id = weaponId
      if (assetId) {
        const res = s.spawnHeldWeapon(assetId, entityId, hand)
        if (res.error) throw new Error(`hold_weapon: ${res.error}`)
        id = res.weaponId
      } else {
        const error = s.holdWeapon(weaponId!, entityId, hand)
        if (error) throw new Error(`hold_weapon: ${error}`)
      }
      const w = useStore.getState().scene()?.entities.find((e) => e.id === id)
      return { weaponId: id, holderId: entityId, hand: w?.heldBy?.hand, color: w?.label?.color }
    }

    case 'drop_weapon': {
      requireDoc()
      const weaponId = str(params, 'weaponId') ?? ''
      const w = s.scene()?.entities.find((e) => e.id === weaponId)
      if (!w) throw new Error(`No entity "${weaponId}" — call get_state for ids.`)
      if (!w.heldBy) throw new Error(`drop_weapon: ${w.name} isn't held by anyone.`)
      s.dropWeapon(weaponId)
      const p = useStore.getState().scene()?.entities.find((e) => e.id === weaponId)?.transform.position
      return { dropped: weaponId, x: p?.x, z: p?.z }
    }

    case 'add_actor_mark': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const time = flt(params, 'time') ?? 0
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      const y = flt(params, 'y') ?? 0
      const gait = (str(params, 'gait') ?? 'walk') as GaitId
      const handle = handleParam(params)
      const via = viaParam(params, y)
      let ok = false
      s.mutate('agent: actor mark', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
        if (!scene || !take || !scene.entities.some((e) => e.id === entityId)) return
        let track = take.tracks.find((t) => t.entityId === entityId)
        if (!track) {
          track = { entityId, marks: [] }
          take.tracks.push(track)
        }
        const mark = createActorMark({ x, y, z }, time, gait)
        applyCurve(mark, handle, via)
        track.marks.push(mark)
        ok = true
      })
      if (!ok) throw new Error(`No entity "${entityId}" in the current scene — call get_state for ids.`)
      return { added: true }
    }

    case 'add_camera_mark': {
      requireDoc()
      const mark = createCameraMark(
        { x: flt(params, 'x') ?? 0, y: flt(params, 'y') ?? 1.6, z: flt(params, 'z') ?? 4 },
        flt(params, 'time') ?? 0,
        toRad(flt(params, 'panDeg') ?? 0),
        toRad(flt(params, 'tiltDeg') ?? 0),
        flt(params, 'focalLength') ?? 35
      )
      applyCurve(mark, handleParam(params), viaParam(params, mark.position.y))
      s.mutate('agent: camera mark', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        shot?.camera.marks.push(mark)
      })
      return { added: true }
    }

    case 'clear_camera_marks':
      requireDoc()
      s.clearCameraMarks()
      return { cleared: true }

    case 'list_fight_moves': {
      const aliases = Object.entries(MOVE_ALIASES)
      return [...listFightMoves(), ...listShotMoves()].map((m) => ({
        id: m.id,
        name: m.name,
        aliases: aliases.filter(([, id]) => id === m.id).map(([a]) => a),
        defaultTarget: defaultTarget(m.id),
        impacts: m.impacts.map((i) => ({ effector: i.effector, t: i.t, speed: Math.round(i.speed * 100) / 100 })),
        ...('guns' in m ? { guns: m.guns } : {})
      }))
    }

    case 'stage_fight': {
      requireDoc()
      const scene = s.scene()
      const shot = s.shot()
      if (!scene || !shot) throw new Error('No active shot.')
      const fighterIds = strList(params, 'fighterIds')
      if (fighterIds.length !== 0 && fighterIds.length !== 2) throw new Error('stage_fight: fighterIds must name exactly 2 people from get_state (or leave it out to spawn A and B).')
      const cast = fightCast(params)
      if (fighterIds.length === 2 && (cast.assets || cast.labels)) {
        throw new Error('stage_fight: assets and labels are for the fighters it spawns; with fighterIds the two people keep their own (set_entity_style renames them).')
      }
      const beats = fightBeatsFromParams(params, 'stage_fight', cast.labels ?? fightLabels(scene, fighterIds), shot.duration)
      if (!beats || beats.length === 0) throw new Error('stage_fight: give a script, beats, or random.')
      const exaggeration = flt(params, 'exaggeration')
      const coverage = fightCoverage(params, 'stage_fight')
      const weapons = fightWeapons(params)
      const input = {
        beats,
        at: { x: flt(params, 'x') ?? 0, z: flt(params, 'z') ?? 0, heading: toRad(flt(params, 'headingDeg') ?? 0) },
        ...(fighterIds.length === 2 ? { fighters: [fighterIds[0]!, fighterIds[1]!] as [string, string] } : {}),
        ...cast,
        ...(weapons ? { weapons } : {}),
        ...(exaggeration !== undefined ? { exaggeration } : {}),
        ...(coverage ? { coverage } : {})
      }
      // Mocap fights (fork): a bot fight's solve takes seconds; the app says so first (fork, fight-speed: and solves it off the main thread).
      if (!slowFight(input)) {
        const { fightId, report } = s.stageFight(input)
        return fightResult(fightId, report)
      }
      await fightNotice('Staging fight…')
      const { fightId, report } = await stageFightOffThread(input)
      return fightResult(fightId, report)
    }

    case 'update_fight': {
      requireDoc()
      const scene = s.scene()
      const shot = s.shot()
      const fightId = str(params, 'fightId') ?? ''
      const fight = scene?.fights?.find((f) => f.id === fightId)
      if (!scene || !shot || !fight) throw new Error(`update_fight: no fight "${fightId}": get_state lists the scene's fights.`)
      const beats = fightBeatsFromParams(params, 'update_fight', fightLabels(scene, fight.fighterIds), shot.duration)
      const exaggeration = flt(params, 'exaggeration')
      const coverage = fightCoverage(params, 'update_fight')
      const patch = {
        ...(beats ? { beats } : {}),
        ...(exaggeration !== undefined ? { exaggeration } : {}),
        ...(coverage ? { coverage } : {})
      }
      // Fork (fight-speed): a bot fight re-solves off the main thread.
      if (!slowFight({ fightId })) return fightResult(fightId, s.updateFight(fightId, patch))
      await fightNotice('Re-solving fight…')
      return fightResult(fightId, await updateFightOffThread(fightId, patch))
    }

    case 'fight_coverage': {
      requireDoc()
      const fightId = str(params, 'fightId') ?? ''
      const mode = str(params, 'mode')
      if (!mode || !(FIGHT_COVERAGE as readonly string[]).includes(mode)) {
        throw new Error(`fight_coverage: mode must be one of ${FIGHT_COVERAGE.join(', ')}.`)
      }
      const side = str(params, 'side')
      if (side !== undefined && side !== 'left' && side !== 'right') throw new Error('fight_coverage: side must be left or right.')
      // Fork (fight-speed): a solve the memo doesn't have runs in the fight worker.
      const r = await offThread(() => s.coverFight(fightId, mode as NonNullable<FightDoc['coverage']>, side))
      // Fork (fix-camera-set): framings moved off a blocked view, and those with no clear view.
      const st = useStore.getState()
      const views = st.shot()!.camera.marks.filter((m) => m.shot?.view).map((m) => ({ time: m.time, ...viewNote(st.scene()!, m.shot!, m.focalLength / (m.shot!.view!.closer ?? 1)) }))
      return { fightId, mode, lineSide: r.lineSide, cameraMarks: r.cameraMarks, ...(views.length > 0 ? { views } : {}) }
    }

    case 'get_fight': {
      requireDoc()
      // Fork (fight-speed): a solve the memo doesn't have (a project just opened) runs in the fight worker.
      return await offThread(() => fightResult(str(params, 'fightId') ?? ''))
    }

    case 'delete_fight': {
      requireDoc()
      s.deleteFight(str(params, 'fightId') ?? '')
      return { deleted: true }
    }

    case 'frame_shot': {
      requireDoc()
      const scene = s.scene()
      if (!scene || !s.shot()) throw new Error('No active shot.')
      let spec: ShotSpec
      let time = flt(params, 'time')
      const words = str(params, 'words')
      if (words !== undefined) {
        const parsed = parseShotWords(
          words,
          scene.entities.map((e) => ({ id: e.id, name: e.name, label: e.label?.text }))
        )
        if ('error' in parsed) throw new Error(`frame_shot: ${parsed.error}`)
        spec = parsed.spec
        if (parsed.time !== undefined) time = parsed.time
      }
      else spec = shotSpecFromParams(params, scene)
      const markId = s.setShotAtTime(spec, time ?? useStore.getState().time)
      if (!markId) throw new Error('frame_shot: the shot could not be solved — check the subject ids with get_state.')
      const st = useStore.getState()
      const shot = st.shot()!
      const mark = shot.camera.marks.find((m) => m.id === markId)!
      const solved = new ShotEvaluator(st.scene()!, shot).solveShotAt(mark.shot ?? spec, mark.time, mark.focalLength)
      // Fork (fix-camera-set): a blocked view was moved to the nearest clear one; say how (or that none is clear).
      const view = mark.shot ? viewNote(st.scene()!, mark.shot, mark.focalLength / (mark.shot.view?.closer ?? 1)) : {}
      return { markId, time: mark.time, ...(solved?.achievedSize ? { achievedSize: solved.achievedSize } : {}), ...view }
    }

    case 'set_shot': {
      requireDoc()
      let fights: ReturnType<typeof refightShot> = []
      // Fork (fight-speed): the shot's fights re-solve in the fight worker (offThread re-runs this edit once they have).
      await offThread(() => s.mutate('agent: set shot', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        if (!shot) return
        const name = str(params, 'name')
        const duration = flt(params, 'duration')
        const fps = flt(params, 'fps')
        const aspect = str(params, 'aspect') as AspectId | undefined
        if (name) shot.name = name
        // Never clamp marks on duration change — blocking is shared.
        if (duration !== undefined) shot.duration = Math.min(600, Math.max(0.5, duration))
        if (fps === 24 || fps === 25 || fps === 30) shot.fps = fps
        if (aspect && ['16:9', '9:16', '2.39:1', '4:3', '1:1'].includes(aspect)) {
          shot.aspect = aspect
        }
        // Fork (gap 2): the shot's fights follow its new fps / duration.
        if (scene && (duration !== undefined || fps !== undefined)) fights = refightShot(scene, shot)
      }))
      return {
        ok: true,
        ...(fights.length > 0
          ? { fights: fights.map((f) => ({ fightId: f.fightId, beats: f.report.beats.length, warnings: f.report.warnings })) }
          : {})
      }
    }

    case 'new_shot': {
      requireDoc()
      const sceneId = useStore.getState().sceneId
      if (!sceneId) throw new Error('No scene selected.')
      s.addShotToScene(sceneId)
      const st = useStore.getState()
      const name = str(params, 'name')
      if (name) {
        st.mutate('agent: name shot', (doc) => {
          const scene = doc.scenes.find((sc) => sc.id === sceneId)
          const shot = scene?.shots.find((sh) => sh.id === st.shotId)
          if (shot) shot.name = name
        })
      }
      return { shotId: useStore.getState().shotId }
    }

    case 'apply_framing': {
      requireDoc()
      const kind = str(params, 'kind') as FramingKind | undefined
      if (!kind || !['2S', 'OTS', 'REV', 'TOP', 'LOW', 'DUTCH'].includes(kind)) {
        throw new Error('kind must be one of 2S, OTS, REV, TOP, LOW, DUTCH.')
      }
      const entityIds = Array.isArray(params.entityIds) ? strList(params, 'entityIds') : undefined
      if (entityIds) {
        const sceneIds = new Set((s.scene()?.entities ?? []).map((e) => e.id))
        const missing = entityIds.filter((id) => !sceneIds.has(id))
        if (entityIds.length === 0) throw new Error('entityIds must list at least one entity id from get_state.')
        if (missing.length > 0) {
          throw new Error(`No entity "${missing[0]}" in the current scene — call get_state for ids.`)
        }
      }
      const view = requireManager().applyFraming(kind, entityIds) // fork (fix-camera-set): note / warning
      return { applied: kind, ...view }
    }

    case 'apply_camera_move': {
      requireDoc()
      const presetId = str(params, 'presetId') ?? ''
      const subjectId = str(params, 'entityId')
      if (subjectId && !s.scene()?.entities.some((e) => e.id === subjectId)) {
        throw new Error(`No entity "${subjectId}" in the current scene — call get_state for ids.`)
      }
      const { CAMERA_MOVE_PRESETS } = await import('@engine/camera-moves')
      if (!CAMERA_MOVE_PRESETS.some((p) => p.id === presetId)) {
        throw new Error(
          `Unknown presetId "${presetId}". Valid: ${CAMERA_MOVE_PRESETS.map((p) => p.id).join(', ')}`
        )
      }
      const rigBefore = s.shot()?.camera.rig // fork (street-kit T5)
      const view = requireManager().applyCameraMove(presetId, subjectId) // fork (fix-camera-set): note / warning
      const rig = useStore.getState().shot()?.camera.rig
      return { applied: presetId, ...view, ...(rig && rig !== rigBefore ? { rig } : {}) }
    }

    case 'list_camera_moves': {
      const { CAMERA_MOVE_PRESETS } = await import('@engine/camera-moves')
      return CAMERA_MOVE_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        track: p.track
      }))
    }

    case 'set_track_subject': {
      requireDoc()
      const entityId = str(params, 'entityId') // empty/undefined = off
      if (entityId && !s.scene()?.entities.some((e) => e.id === entityId)) {
        throw new Error(`No entity "${entityId}" — call get_state for ids.`)
      }
      s.mutate('agent: track subject', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        if (!shot) return
        if (entityId) shot.camera.trackEntityId = entityId
        else delete shot.camera.trackEntityId
      })
      return { tracking: entityId ?? null }
    }

    case 'list_action_presets': {
      const { ACTION_PRESETS } = await import('@engine/action-presets')
      return ACTION_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        suggestedAssets: p.suggestedAssets
      }))
    }

    case 'apply_action_preset': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const presetId = str(params, 'presetId') ?? ''
      const { ACTION_PRESETS } = await import('@engine/action-presets')
      const preset = ACTION_PRESETS.find((p) => p.id === presetId)
      if (!preset) {
        throw new Error(
          `Unknown presetId "${presetId}". Valid: ${ACTION_PRESETS.map((p) => p.id).join(', ')}`
        )
      }
      const scene = s.scene()
      const shot = s.shot()
      const entity = scene?.entities.find((e) => e.id === entityId)
      if (!scene || !shot || !entity) throw new Error(`No entity "${entityId}" — call get_state for ids.`)
      const specs = preset.generate({
        start: {
          x: entity.transform.position.x,
          y: entity.transform.position.y,
          z: entity.transform.position.z,
          heading: entity.transform.rotationY
        },
        duration: shot.duration
      })
      s.mutate('agent: action preset', (doc) => {
        const sc = doc.scenes.find((x) => x.id === scene.id)
        const sh = sc?.shots.find((x) => x.id === shot.id)
        const take = sc?.blocking.find((b) => b.id === sh?.blockingTakeId)
        if (!take) return
        let track = take.tracks.find((t) => t.entityId === entityId)
        if (!track) {
          track = { entityId, marks: [] }
          take.tracks.push(track)
        }
        track.marks = specs.map((spec) => ({
          id: newId('mark'),
          time: spec.time,
          hold: spec.hold,
          easeIn: spec.easeIn,
          easeOut: spec.easeOut,
          position: { ...spec.position },
          gait: spec.gait
        }))
      })
      return { applied: presetId, marks: specs.length }
    }

    case 'list_sequence_styles': {
      const { sequenceStyles } = await import('@engine/sequences')
      return {
        dance: sequenceStyles('dance'),
        fight: sequenceStyles('fight'),
        footChase: sequenceStyles('footChase'),
        carChase: sequenceStyles('carChase')
      }
    }

    case 'spawn_sequence': {
      requireDoc()
      const type = str(params, 'type') as
        | import('@engine/sequences').SequenceType
        | undefined
      if (!type || !['dance', 'fight', 'footChase', 'carChase'].includes(type)) {
        throw new Error('type must be dance | fight | footChase | carChase.')
      }
      const count = flt(params, 'count') ?? 10
      const style = str(params, 'style') ?? (type === 'dance' ? 'mixed' : type === 'fight' ? 'paired' : 'straight')
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      const headingDeg = flt(params, 'headingDeg') ?? 0
      const fightsBefore = s.scene()?.fights?.length ?? 0
      // Fork (mocap-backlog): the bodies the crowd is cast as (a car chase casts cars); a bot fight of two says it is staging, then solves before answering.
      const bodies = castBodies(params, 'spawn_sequence')
      const cast = bodies && type !== 'carChase' ? { bodies } : {}
      const now = type === 'fight' && count === 2 && slowFight({ beats: [], ...(bodies ? { assets: bodies } : {}) })
      if (now) await fightNotice('Staging fight…')
      s.spawnSequence({ type, count, style, origin: { x, z, heading: toRad(headingDeg) }, ...cast, ...(now ? { now } : {}) })
      // Fork (fight-speed): a bot fight stages off the main thread; answer once it has.
      const failed = now ? await routineFightStaged() : null
      if (failed) throw new Error(failed)
      const after = useStore.getState()
      const sel = after.selection
      return {
        staged: sel?.kind === 'entities' ? sel.entityIds.length : 0,
        entityIds: sel?.kind === 'entities' ? sel.entityIds : [],
        ...newFightId(fightsBefore),
        ...(type === 'carChase' ? chaseRoadId(after.scene(), sel?.kind === 'entities' ? sel.entityIds[0] : undefined) : {}), // fork (street-kit)
        ...chaseCamera(type), // fork (street-kit T5)
        ...(bodies && type === 'carChase' ? { note: 'bodies ignored: a car chase casts cars.' } : {})
      }
    }

    case 'list_choreography_options': {
      const { choreoStyles, choreoFormations, choreoEndings } = await import('@engine/choreography')
      const kinds: ChoreoKind[] = ['dance', 'fight', 'chase']
      return {
        kinds,
        styles: Object.fromEntries(kinds.map((k) => [k, choreoStyles(k)])),
        formations: choreoFormations(),
        endings: Object.fromEntries(kinds.map((k) => [k, choreoEndings(k)]))
      }
    }

    case 'spawn_choreography': {
      requireDoc()
      const spec = routineSpecFromParams(params)
      // Fork (mocap-backlog): the bodies the routine casts (the Choreographer's Bodies).
      const bodies = castBodies(params, 'spawn_choreography')
      if (bodies) spec.bodies = bodies
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      const headingDeg = flt(params, 'headingDeg') ?? 0
      const fightsBefore = s.scene()?.fights?.length ?? 0
      // Mocap fights (fork): a bot fight's solve takes seconds; the app says so first.
      const slow = slowRoutine(spec)
      if (slow) await fightNotice('Staging fight…')
      s.spawnChoreography(spec, { x, z, heading: toRad(headingDeg) }, true)
      // Fork (fight-speed): a bot fight stages off the main thread; answer once it has.
      const failed = slow ? await routineFightStaged() : null
      if (failed) throw new Error(failed)
      const sel = useStore.getState().selection
      return {
        kind: spec.kind,
        staged: sel?.kind === 'entities' ? sel.entityIds.length : 0,
        entityIds: sel?.kind === 'entities' ? sel.entityIds : [],
        ...newFightId(fightsBefore),
        ...routineNotes() // fork (set-routines): how the routine fits the set
      }
    }

    case 'choreograph_entities': {
      requireDoc()
      const entityIds = strList(params, 'entityIds')
      if (entityIds.length === 0) {
        throw new Error('entityIds must be a non-empty array of person entity ids.')
      }
      const spec = routineSpecFromParams(params)
      const fightsBefore = s.scene()?.fights?.length ?? 0
      const slow = slowRoutine(spec, entityIds)
      if (slow) await fightNotice('Staging fight…')
      const applied = s.choreographEntities(entityIds, spec)
      // Fork (fight-speed): a bot fight stages off the main thread; answer once it has.
      const failed = slow ? await routineFightStaged() : null
      if (failed) throw new Error(failed)
      if (applied === 0) {
        throw new Error('No matching performers — choreography applies to people (person.* entities).')
      }
      return { kind: spec.kind, choreographed: applied, ...newFightId(fightsBefore), ...routineNotes() } // fork (set-routines)
    }

    case 'list_motion_presets': {
      const { MOTION_PRESETS } = await import('@engine/motions')
      // Fork: which motions a Mocap bot plays as a library clip, and the clips' own motions (mocap/library-clips.ts).
      const { clipMotionPresets, motionHasClip } = await import('@engine/mocap/library-clips')
      const category = str(params, 'category')
      return [...MOTION_PRESETS, ...clipMotionPresets()]
        .filter((m) => !category || m.category === category)
        .map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          duration: m.duration,
          ...(motionHasClip(m.id) ? { mocap: true } : {}),
          ...(m.keyframes.length === 0 ? { mocapOnly: true } : {})
        }))
    }

    case 'import_scan': {
      requireDoc()
      const sourcePath = str(params, 'sourcePath') ?? str(params, 'path') ?? ''
      if (!sourcePath) {
        throw new Error('sourcePath is required — an absolute path to a .ply/.splat/.spz/.ksplat file.')
      }
      const before = new Set((s.scene()?.scans ?? []).map((sc) => sc.id))
      await s.importScan(sourcePath)
      const scan = (useStore.getState().scene()?.scans ?? []).find((sc) => !before.has(sc.id))
      if (!scan) {
        throw new Error('Scan import failed — check the file path and that the project has been saved.')
      }
      return { scan }
    }

    case 'set_scan_transform': {
      requireDoc()
      const scanId = str(params, 'scanId') ?? ''
      const scan = s.scene()?.scans?.find((sc) => sc.id === scanId)
      if (!scan) throw new Error(`No scan "${scanId}" — call get_state or import_scan.`)
      const patch: { position?: { x: number; y: number; z: number }; rotationY?: number; scale?: number } = {}
      const pos = params.position
      if (pos && typeof pos === 'object') {
        const pp = pos as Params
        patch.position = {
          x: flt(pp, 'x') ?? scan.position.x,
          y: flt(pp, 'y') ?? scan.position.y,
          z: flt(pp, 'z') ?? scan.position.z
        }
      }
      const rotationDeg = flt(params, 'rotationDeg')
      if (rotationDeg !== undefined) patch.rotationY = toRad(rotationDeg)
      const scale = flt(params, 'scale')
      if (scale !== undefined) patch.scale = scale
      const flipped = bool(params, 'flipped')
      if (flipped !== undefined) (patch as { flipped?: boolean }).flipped = flipped
      if (patch.position || patch.rotationY !== undefined || patch.scale !== undefined || flipped !== undefined) {
        s.updateScanTransform(scanId, patch)
      }
      const visible = bool(params, 'visible')
      if (visible !== undefined) s.setScanVisible(scanId, visible)
      const updated = useStore.getState().scene()?.scans?.find((sc) => sc.id === scanId)
      return { scan: updated }
    }

    case 'remove_scan': {
      requireDoc()
      const scanId = str(params, 'scanId') ?? ''
      if (!s.scene()?.scans?.some((sc) => sc.id === scanId)) {
        throw new Error(`No scan "${scanId}" — call get_state for scan ids.`)
      }
      s.removeScan(scanId)
      return { removed: scanId }
    }

    case 'snap_to_ground': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const scene = s.scene()
      if (!scene?.entities.some((e) => e.id === entityId)) {
        throw new Error(`No entity "${entityId}" — call get_state for ids.`)
      }
      s.setSelection({ kind: 'entity', entityId })
      requireManager().snapSelectionToGround()
      return { snapped: entityId }
    }

    case 'set_time':
      requireDoc()
      s.setTime(Math.max(0, flt(params, 't') ?? 0))
      return { time: useStore.getState().time }

    case 'play':
      requireDoc()
      s.setTime(0)
      s.setPlaying(true)
      return { playing: true }

    case 'stop':
      s.setPlaying(false)
      return { playing: false }

    case 'screenshot': {
      requireDoc()
      // Rendered through the SHOT camera at the playhead — what will export.
      const png = await renderStillPngForTest(useStore.getState().time, 960, 540)
      let binary = ''
      const bytes = new Uint8Array(png)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
      return { imageBase64: btoa(binary) }
    }

    case 'set_reference': {
      requireDoc()
      const handoffVersion = flt(params, 'handoffVersion')
      if (handoffVersion !== undefined && handoffVersion !== 1) {
        throw new Error(`Unsupported Motion Previs handoffVersion ${handoffVersion}; Blockout supports version 1.`)
      }
      const videoPath = str(params, 'videoPath') ?? str(params, 'path') ?? ''
      if (!videoPath) throw new Error('videoPath is required.')
      const folder = useStore.getState().projectFolder
      if (!folder) throw new Error('No project folder — save the project first.')
      const mode = str(params, 'mode') === 'pip' ? 'pip' : 'ghost'
      const rawOpacity = flt(params, 'opacity')
      const opacity = rawOpacity === undefined ? 0.5 : Math.min(1, Math.max(0, rawOpacity))
      // Copy the external clip into the project's refs/ folder so it travels
      // with the project and can be served by relative path.
      const imported = await window.blockout.importReference(folder, videoPath)
      let attached = false
      s.mutate('agent: set reference', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        if (!shot) return
        shot.referenceVideo = { path: imported.relativePath, opacity, mode, timeOffset: 0 }
        attached = true
      })
      if (!attached) throw new Error('No active shot to attach the reference to.')
      return { attached: true, handoffVersion: 1, path: imported.relativePath, mode, opacity }
    }

    case 'new_scene': {
      requireDoc()
      requireIdle()
      s.addSceneAfter()
      const name = str(params, 'name')?.trim()
      const st = useStore.getState()
      if (name) {
        st.mutate('agent: name scene', (doc) => {
          const scene = doc.scenes.find((sc) => sc.id === st.sceneId)
          if (scene) scene.name = name
        })
      }
      return { sceneId: st.sceneId, shotId: st.shotId }
    }

    case 'select_scene': {
      requireDoc()
      requireIdle()
      const sceneId = str(params, 'sceneId') ?? ''
      if (!s.doc?.scenes.some((sc) => sc.id === sceneId)) {
        throw new Error(`No scene "${sceneId}" — call get_state for scene ids (allScenes).`)
      }
      s.selectScene(sceneId)
      const st = useStore.getState()
      return { sceneId: st.sceneId, shotId: st.shotId }
    }

    case 'select_shot': {
      requireDoc()
      requireIdle()
      const shotId = str(params, 'shotId') ?? ''
      const owner = s.doc?.scenes.find((sc) => sc.shots.some((sh) => sh.id === shotId))
      if (!owner) throw new Error(`No shot "${shotId}" — call get_state for shot ids (allScenes).`)
      if (owner.id !== s.sceneId) s.selectScene(owner.id)
      useStore.getState().selectShot(shotId)
      return { shotId: useStore.getState().shotId }
    }

    case 'set_lighting': {
      requireDoc()
      const preset = str(params, 'preset') as LightingPresetId | undefined
      if (!preset || !LIGHTING_PRESETS.includes(preset)) {
        throw new Error(`set_lighting: unknown preset "${preset ?? ''}". Valid: ${LIGHTING_PRESETS.join(', ')}.`)
      }
      const az = flt(params, 'sunAzimuthDeg')
      const el = flt(params, 'sunElevationDeg')
      const fog = flt(params, 'fog')
      mutateActive('agent: lighting', (scene) => {
        scene.environment.lighting = preset
        if (az !== undefined) scene.environment.sunAzimuth = toRad(((az % 360) + 360) % 360)
        if (el !== undefined) scene.environment.sunElevation = clamp(toRad(el), 0.1, 1.5)
        if (fog !== undefined) scene.environment.fog = clamp(fog, 0, 1)
      })
      const scene = useStore.getState().scene()
      return scene ? environmentSummary(scene) : null
    }

    case 'set_entity_style': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      if (!s.scene()?.entities.some((e) => e.id === entityId)) {
        throw new Error(`No entity "${entityId}" in the current scene — call get_state for ids.`)
      }
      const rawColor = str(params, 'color')
      const color = rawColor === undefined ? undefined : resolveColor(rawColor)
      if (color === null) throw new Error(`set_entity_style: unknown color "${rawColor}". Use ${COLOR_HINT}.`)
      const label = str(params, 'label')
      const name = str(params, 'name')?.trim()
      // Fork: only people take height / build, inside the ranges personDims renders (skeleton.ts).
      const notes: string[] = []
      const isPerson = s.scene()!.entities.find((e) => e.id === entityId)!.assetId.startsWith('person.')
      const sized = (key: 'heightScale' | 'build', lo: number, hi: number): number | undefined => {
        const v = flt(params, key)
        if (v === undefined) return undefined
        if (!isPerson) {
          notes.push(`${key} not stored: only people have a height and build.`)
          return undefined
        }
        const c = clamp(v, lo, hi)
        if (c !== v) notes.push(`${key} ${v} clamped to ${c} (people take ${lo}–${hi}).`)
        return c
      }
      const heightScale = sized('heightScale', 0.8, 1.2)
      const build = sized('build', 0.8, 1.3)
      const hide = bool(params, 'hideInExports')
      const used = (s.scene()?.entities ?? [])
        .filter((e) => e.id !== entityId && e.label?.text)
        .map((e) => e.label!.color)
      mutateActive('agent: entity style', (scene) => {
        const e = scene.entities.find((en) => en.id === entityId)
        if (!e) return
        if (label !== undefined || color) {
          const text = (label ?? e.label?.text ?? '').trim()
          if (!text && !color) delete e.label
          else e.label = { text, color: color ?? e.label?.color ?? nextLabelColor(used) }
        }
        if (name) e.name = name
        if (heightScale !== undefined || build !== undefined) {
          e.params = { ...(e.params ?? {}) }
          if (heightScale !== undefined) e.params.height = heightScale
          if (build !== undefined) e.params.build = build
        }
        if (hide === true) e.excludeFromExport = true
        else if (hide === false) delete e.excludeFromExport
      })
      const st = useStore.getState()
      const e = st.scene()?.entities.find((en) => en.id === entityId)
      if (!e) return null
      const out = entitySummary(e, activeTake(st.scene(), st.shot())) as Record<string, unknown>
      return notes.length > 0 ? { ...out, notes } : out
    }

    case 'set_camera_rig': {
      requireDoc()
      const rig = str(params, 'rig') as RigId | undefined
      const rigIds = Object.keys(RIGS) as RigId[]
      if (!rig || !rigIds.includes(rig)) {
        throw new Error(`set_camera_rig: unknown rig "${rig ?? ''}". Valid: ${rigIds.join(', ')}.`)
      }
      const intensity = flt(params, 'intensity')
      mutateActive('agent: camera rig', (_scene, shot) => {
        if (!shot) return
        shot.camera.rig = rig
        if (intensity !== undefined) shot.camera.rigIntensity = clamp(intensity, 0, 1)
      })
      const cam = useStore.getState().shot()?.camera
      return { rig: cam?.rig, intensity: cam?.rigIntensity }
    }

    case 'list_marks': {
      requireDoc()
      const scene = s.scene()
      if (!scene) throw new Error('No scene selected.')
      const lane = resolveLane(scene, s.shot() ?? undefined, str(params, 'lane') ?? '')
      return [...lane.marks].sort((a, b) => a.time - b.time).map(markSummary)
    }

    case 'update_mark': {
      requireDoc()
      requireIdle()
      const laneId = str(params, 'lane') ?? ''
      const markId = str(params, 'markId') ?? ''
      const gait = str(params, 'gait') as GaitId | undefined
      if (gait !== undefined && !(gait in GAITS)) {
        throw new Error(`update_mark: unknown gait "${gait}". Valid: ${Object.keys(GAITS).join(', ')}.`)
      }
      const scene0 = s.scene()
      if (!scene0) throw new Error('No scene selected.')
      const lane0 = resolveLane(scene0, s.shot() ?? undefined, laneId)
      if (!lane0.marks.some((x) => x.id === markId)) {
        throw new Error(`No mark "${markId}" on lane "${laneId}" — call list_marks for mark ids.`)
      }
      if (lane0.kind === 'camera' && gait !== undefined) throw new Error('update_mark: gait only applies to actor lanes.')
      const cameraOnly = CAMERA_ONLY.find((k) => params[k] !== undefined)
      if (lane0.kind === 'actor' && cameraOnly) {
        throw new Error(`update_mark: ${cameraOnly} only applies to the camera lane.`)
      }
      // Fork: a shot-words mark is re-solved every frame, so its pose only takes an edit after release: true.
      const release = bool(params, 'release') === true
      if (release && lane0.kind !== 'camera') throw new Error('update_mark: release only applies to camera marks.')
      const framed = lane0.kind === 'camera' ? lane0.marks.find((x) => x.id === markId) : undefined
      const words = framed?.shot
      if (words && !release) {
        const posed = ['x', 'y', 'z', 'panDeg', 'tiltDeg', 'rollDeg', ...(words.lens !== undefined || words.over ? ['focalLength'] : [])]
          .filter((k) => params[k] !== undefined)
        if (posed.length > 0) {
          throw new Error(
            `update_mark: mark "${markId}" is framed by shot words (${words.size} on ${words.subjectIds.join(', ')}) and re-solved every frame, so ${posed.join(', ')} would not show. ` +
              'Pass release: true to freeze its framing into a plain mark and edit that, or call frame_shot to change the words.'
          )
        }
      }
      const frozen = words && release ? new ShotEvaluator(scene0, s.shot()!).solveShotAt(words, framed!.time, framed!.focalLength) : null
      const handle = handleParam(params)
      const mark0 = lane0.marks.find((x) => x.id === markId)!
      const via = viaParam(params, flt(params, 'y') ?? mark0.position.y)
      let result: unknown
      mutateActive(words && release ? 'agent: release shot words' : 'agent: update mark', (scene, shot) => {
        const lane = resolveLane(scene, shot, laneId)
        const m = lane.marks.find((x) => x.id === markId)
        if (!m) return
        if (words && release) {
          const cm = m as CameraMark
          if (frozen) {
            cm.position = { ...frozen.position }
            cm.pan = frozen.pan
            cm.tilt = frozen.tilt
            cm.roll = frozen.roll
            cm.focalLength = frozen.focalLength
          }
          delete cm.shot
        }
        const time = flt(params, 'time')
        if (time !== undefined) m.time = clamp(time, 0, shot?.duration ?? time)
        for (const axis of ['x', 'y', 'z'] as const) {
          const v = flt(params, axis)
          if (v !== undefined) m.position = { ...m.position, [axis]: v }
        }
        const hold = flt(params, 'hold')
        if (hold !== undefined) m.hold = Math.max(0, hold)
        const easeIn = flt(params, 'easeIn')
        if (easeIn !== undefined) m.easeIn = clamp(easeIn, 0, 1)
        const easeOut = flt(params, 'easeOut')
        if (easeOut !== undefined) m.easeOut = clamp(easeOut, 0, 1)
        applyCurve(m, handle, via)
        if (lane.kind === 'actor' && gait !== undefined) (m as ActorMark).gait = gait
        if (lane.kind === 'camera') {
          const cm = m as CameraMark
          const pan = flt(params, 'panDeg')
          if (pan !== undefined) cm.pan = toRad(pan)
          const tilt = flt(params, 'tiltDeg')
          if (tilt !== undefined) cm.tilt = toRad(clamp(tilt, -89.9, 89.9))
          const roll = flt(params, 'rollDeg')
          if (roll !== undefined) cm.roll = toRad(roll)
          const focal = flt(params, 'focalLength')
          if (focal !== undefined) cm.focalLength = clamp(focal, 8, 400)
          const focus = flt(params, 'focusDistance')
          if (focus !== undefined) cm.focusDistance = Math.max(0.1, focus)
        }
        lane.marks.sort((a, b) => a.time - b.time)
        result = markSummary(m)
      })
      if (result === undefined) throw new Error('update_mark: the edit did not apply — try again.')
      return result
    }

    case 'delete_marks': {
      requireDoc()
      requireIdle()
      const laneId = str(params, 'lane') ?? ''
      const markIds = strList(params, 'markIds')
      if (markIds.length === 0) throw new Error('markIds must list at least one mark id from list_marks.')
      const scene = s.scene()
      if (!scene) throw new Error('No scene selected.')
      const lane = resolveLane(scene, s.shot() ?? undefined, laneId)
      const missing = markIds.find((id) => !lane.marks.some((m) => m.id === id))
      if (missing) throw new Error(`No mark "${missing}" on lane "${laneId}" — call list_marks for mark ids.`)
      mutateActive('agent: delete marks', (sc, shot) => {
        const live = resolveLane(sc, shot, laneId)
        for (let i = live.marks.length - 1; i >= 0; i--) {
          if (markIds.includes(live.marks[i]!.id)) live.marks.splice(i, 1)
        }
      })
      return { deleted: markIds.length }
    }

    case 'apply_motion': {
      requireDoc()
      requireIdle()
      const entityIds = strList(params, 'entityIds')
      const presetId = str(params, 'presetId') ?? ''
      const { MOTION_PRESETS } = await import('@engine/motions')
      const { clipMotionPreset, motionClip } = await import('@engine/mocap/library-clips')
      const clipOnly = !!clipMotionPreset(presetId)
      if (!MOTION_PRESETS.some((m) => m.id === presetId) && !clipOnly) {
        throw new Error(`apply_motion: unknown presetId "${presetId}" — call list_motion_presets for ids.`)
      }
      const people = (s.scene()?.entities ?? []).filter(
        (e) => entityIds.includes(e.id) && e.assetId.startsWith('person.') && (!clipOnly || !!motionClip(presetId, { assetId: e.assetId, params: e.params }))
      )
      if (clipOnly && people.length === 0) {
        throw new Error(`apply_motion: "${presetId}" is a mocap clip — it plays on Mocap man / Mocap woman bodies only (none of these entities is one).`)
      }
      if (people.length === 0) {
        throw new Error('apply_motion: applied 0 — motions apply to people (person.* entity ids from get_state).')
      }
      s.applyMotionToEntities(people.map((e) => e.id), presetId)
      return { applied: people.length }
    }

    case 'undo':
    case 'redo': {
      requireDoc()
      requireIdle()
      const before = useStore.getState()
      if ((action === 'undo' ? before.undoStack : before.redoStack).length === 0) {
        throw new Error(`Nothing to ${action}.`)
      }
      if (action === 'undo') before.undo()
      else before.redo()
      const after = useStore.getState()
      return {
        [action === 'undo' ? 'undone' : 'redone']: true,
        canUndo: after.undoStack.length > 0,
        canRedo: after.redoStack.length > 0
      }
    }

    case 'save_project': {
      requireDoc()
      const folder = useStore.getState().projectFolder
      if (!folder) throw new Error('save_project: this project has no folder yet — save it once from the app first.')
      const json = currentProjectJson()
      if (!json) throw new Error('No project open — create or open a project in the app first.')
      await window.blockout.saveProject(folder, json)
      useStore.getState().markSaved()
      return { saved: true }
    }

    case 'list_export_profiles':
      return BUILTIN_PROFILES.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        maxDuration: p.maxDuration,
        recommendedDuration: p.recommendedDuration,
        aspects: p.aspects,
        fps: p.fps,
        // Fork: the model's input-file and prompt caps, and what to attach where.
        ...(p.maxFileMB ? { maxFileMB: p.maxFileMB } : {}),
        ...(p.maxPromptChars ? { maxPromptChars: p.maxPromptChars } : {}),
        // Fork (export-look): the shortest clip, the frame cap and the length per output resolution.
        ...(p.minDuration ? { minDuration: p.minDuration } : {}),
        ...(p.maxFrames ? { maxFrames: p.maxFrames } : {}),
        ...(p.resolutionCaps ? { resolutionCaps: p.resolutionCaps } : {}),
        attachHint: p.attachHint
      }))

    case 'export_shot': {
      requireDoc()
      const profileId = exportProfileId(params, 'export_shot')
      const resolution = exportResolution(params, 'export_shot')
      const labels = str(params, 'labels') ?? 'stillsOnly'
      if (labels !== 'on' && labels !== 'stillsOnly' && labels !== 'off') {
        throw new Error(`export_shot: labels must be on, stillsOnly or off (got "${labels}").`)
      }
      const p = params.passes && typeof params.passes === 'object' ? (params.passes as Params) : {}
      const passes = {
        clean: bool(p, 'clean') ?? true,
        depth: bool(p, 'depth') ?? true,
        normal: bool(p, 'normal') ?? false
      }
      if (!passes.clean && !passes.depth && !passes.normal) {
        throw new Error('export_shot: passes must turn on at least one of clean, depth, normal.')
      }
      const scene = s.scene()
      const shot = s.shot()
      const res = await exportShot({ profileId, passes, labels, resolution })
      if (!res.ok || !res.packagePath) throw new Error(res.error ?? 'export_shot failed.')
      const profile = BUILTIN_PROFILES.find((pr) => pr.id === profileId)!
      return {
        packagePath: res.packagePath,
        relativePath: projectRelative(res.packagePath),
        prompt: scene && shot ? await offThread(() => generatePrompt(scene, shot, profile)) : '', // fork (fight-speed): its fights' solves off the main thread
        // Fork: limits the shot breaks for this model (empty when it fits).
        warnings: shot ? profileWarnings(profile, shot) : []
      }
    }

    case 'export_frame': {
      requireDoc()
      requireIdle()
      const profileId = exportProfileId(params, 'export_frame')
      const resolution = exportResolution(params, 'export_frame')
      const res = await exportStillAtPlayhead(profileId, resolution, bool(params, 'labels') ?? false)
      if (!res.ok || !res.packagePath) throw new Error(res.error ?? 'export_frame failed.')
      return { path: res.packagePath }
    }

    case 'export_contact_sheet': {
      requireDoc()
      requireIdle()
      const res = await exportContactSheet()
      if (!res.ok || !res.packagePath) throw new Error(res.error ?? 'export_contact_sheet failed.')
      return { path: res.packagePath }
    }

    case 'export_scene_animatic': {
      requireDoc()
      requireIdle()
      const profileId = exportProfileId(params, 'export_scene_animatic')
      const resolution = exportResolution(params, 'export_scene_animatic')
      const res = await exportAnimatic(profileId, resolution)
      if (!res.ok || !res.packagePath) throw new Error(res.error ?? 'export_scene_animatic failed.')
      return { path: res.packagePath }
    }

    case 'list_presets':
      return await window.blockout.presetsList()

    case 'save_preset': {
      requireDoc()
      const name = str(params, 'name')
      if (!name) throw new Error('name is required.')
      await s.saveStagePreset(name)
      return { saved: name }
    }

    case 'apply_preset': {
      requireDoc()
      const id = str(params, 'id')
      if (!id) throw new Error('id is required — call list_presets.')
      await s.applyStagePreset(id)
      return { applied: id }
    }

    default:
      throw new Error(`Unknown action "${action}".`)
  }
}

/** Wire up control-invoke handling. Returns an unsubscribe for teardown. */
export function registerControlHandler(): () => void {
  return window.blockout.onControlInvoke((id, action, params) => {
    void (async () => {
      let result: ControlResult
      try {
        const data = await execute(action, (params ?? {}) as Params)
        result = { ok: true, data }
      } catch (e) {
        result = { ok: false, error: (e as Error).message }
      }
      window.blockout.controlResult(id, result)
    })()
  })
}
