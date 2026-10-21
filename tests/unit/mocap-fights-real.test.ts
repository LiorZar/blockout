// Fork addition (2026): the Fight Director on the library's real fight clips, Y Bot vs X Bot both ways (skipped without the local library; nothing from it is stored); see MODIFICATIONS.md.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { registerClipTake, registerMocapTemplate } from '@renderer/mocap/library'
import { ShotEvaluator } from '@engine/evaluate'
import { bodyLowY } from '@engine/floor'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput, type FightSolution } from '@engine/fight/solve'
import { clearMocapClips, clipSample, clipScale, mocapClip } from '@engine/mocap/clip'
import { clearMocapBodies } from '@engine/mocap/registry'
import { BONE_INDEX, MOCAP_BONES } from '@engine/mocap/rig'
import { boneSkin, fighterPose, meshDepth, skinMesh } from '@engine/mocap/surface'
import { personDims, toWorld } from '@engine/skeleton'
import type { ClipState, EntityState, FightDoc, Scene, Shot, V3 } from '@engine/types'
import { mocapLibraryDir, parseMocapManifest } from '../../src/shared/mocap-library'

const LIBRARY = mocapLibraryDir()
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))
const BOTS = ['person.mocapMale', 'person.mocapFemale']
const FPS = 24

// The qa-fight scripts (.maestro/qa-fight/fights.mjs) and weapon scripts (drive-weapons.mjs).
const SCRIPTS: { name: string; script: string; weapons?: [string | null, string | null] }[] = [
  { name: 'punches', script: 'A jab cross to head -> hit, hit power 0.7\nB uppercut to head -> hit power 0.8\nA haymaker to head -> hit power 0.8\nB hook to head -> hit power 0.8\nA spinning-backfist to head -> block power 0.8\nB spinning-back-fist to head -> ko power 1' },
  { name: 'combos', script: 'A double-jab-body-shot to body -> hit, hit, hit\nB boxing-combo to head -> slip, hit power 0.8\nA jab-hook-cross to head -> parry, hit power 0.8\nB elbow to head -> hit power 0.8\nA knee to body -> hit power 0.8' },
  { name: 'kicks', script: 'A front kick to body -> hit power 1\nB side kick to body -> hit power 1\nA teep-push-kick to body -> hit power 1' },
  { name: 'kicks3', script: 'B front-kick-combo to body -> hit, hit power 1\nA high-kick to head -> hit power 1\nB roundhouse to head -> hit power 1\nA side kick to head -> hit power 1' },
  { name: 'kicks2', script: 'A sweep to legs -> hit power 1\nB front kick to legs -> hit power 1\nA roundhouse to head -> duck power 1\nB hook to body -> miss power 0.8\nA roundhouse to body -> hit power 1\nB spinning back kick to body -> hit power 1' },
  { name: 'elbows', script: 'A elbow to head -> hit power 1\nB elbow to body -> hit power 1\nA haymaker to body -> hit power 1' },
  { name: 'grapples', script: 'A shove to body -> hit power 1\nB tackle to body -> hit power 1\nA grapple-shove to body -> hit power 1\nB takedown-lunge to body -> hit power 1' },
  { name: 'sword-bat', weapons: ['prop.sword', 'prop.baseballBat'], script: 'A slash to head -> parry, hit power 1\nB swing to body -> block, hit power 1\nA thrust to body -> hit power 1' },
  { name: 'katana-spear', weapons: ['prop.katana', 'prop.spear'], script: 'A slash to body -> hit, hit power 1\nB thrust to body -> parry power 1\nB thrust to head -> hit power 1' },
  { name: 'knife-staff', weapons: ['prop.knife', 'prop.staff'], script: 'A stab to body -> hit power 1\nB swing to head -> block, hit power 1' },
  { name: 'axe-shield', weapons: ['prop.axe', 'prop.shield'], script: 'A swing to body -> block, block power 1\nA swing to head -> hit, hit power 1\nB hook to head -> hit power 1' },
  { name: 'pistol', weapons: ['prop.pistol', null], script: 'A shoot to body -> hit\nA shoot to head -> hit' },
  { name: 'rifle', weapons: ['prop.rifle', null], script: 'A shoot to body -> hit\nA shoot to head -> hit' },
  { name: 'shotgun', weapons: ['prop.shotgun', null], script: 'A shoot to body -> hit' }
]
const HAND: Record<string, 'L' | 'R'> = { 'prop.shield': 'L' }
const CONNECTS = new Set(['hit', 'ko', 'block', 'parry'])

function parse(file: string): ReturnType<FBXLoader['parse']> {
  const buf = readFileSync(join(LIBRARY, file))
  return new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
}

beforeAll(() => {
  if (!HAS_LIBRARY) return
  const manifest = parseMocapManifest(JSON.parse(readFileSync(join(LIBRARY, 'manifest.json'), 'utf-8')))!
  for (const body of ['male', 'female'] as const) {
    const c = manifest.characters.find((x) => x.body === body)!
    registerMocapTemplate(body === 'male' ? BOTS[0]! : BOTS[1]!, parse(c.file), c.name)
  }
  for (const c of manifest.clips) registerClipTake(c.key, parse(c.file), BOTS[0]!, { fps: c.fps, loop: c.loop, inPlace: c.inPlace })
}, 300_000)

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

/** Every script solved once per pairing (the tests share them). */
const SOLVED = new Map<string, { sol: FightSolution; ev: ShotEvaluator }>()
function solve(s: (typeof SCRIPTS)[number], assets: string[]): { sol: FightSolution; ev: ShotEvaluator } {
  const key = `${s.name}|${assets.join(',')}`
  const known = SOLVED.get(key)
  if (known) return known
  const parsed = parseFightScript(s.script, ['A', 'B'])
  if (!('beats' in parsed)) throw new Error(parsed.error)
  const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
  const held = (q: number): string | null => s.weapons?.[q] ?? null
  const input = (q: number): FighterInput => ({ entityId: q ? 'b' : 'a', assetId: assets[q]!, scale: 1, start: { x: q ? 0.55 : -0.55, y: 0, z: -4 }, ...(held(q) ? { weapons: [{ assetId: held(q)!, hand: HAND[held(q)!] ?? 'R', scale: 1 }] } : {}) })
  const duration = 30
  const sol = solveFight(fight, [input(0), input(1)], { duration, fps: FPS })
  const ids = ['a', 'b']
  const scene = {
    id: 's',
    name: 's',
    number: 1,
    environment: { lighting: 'day', sunAzimuth: 0, sunElevation: 1, fog: 0 },
    entities: [
      ...ids.map((id, q) => ({ id, assetId: assets[q], name: id, transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } })),
      ...ids.flatMap((id, q) => (held(q) ? [{ id: `${id}-w`, assetId: held(q), name: 'w', heldBy: { entityId: id, hand: HAND[held(q)!] ?? 'R' }, transform: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 } }] : []))
    ],
    blocking: [{ id: 'take', name: 't', tracks: ids.map((id, q) => ({ entityId: id, marks: sol.tracks[q]!.map((m, k) => ({ ...m, id: `${id}${k}` })) })) }],
    shots: []
  } as unknown as Scene
  const shot = { id: 'shot', name: 's', duration, fps: FPS, aspect: '16:9', blockingTakeId: 'take', camera: { sensorId: 'super35', rig: 'sticks', rigIntensity: 0, seed: 1, marks: [] } } as unknown as Shot
  const out = { sol, ev: new ShotEvaluator(scene, shot) }
  SOLVED.set(key, out)
  return out
}

/** Each blow's outcome, as the solver reads the script's (the last n; blocks before them when short). */
function outcomesOf(s: (typeof SCRIPTS)[number], beat: number, n: number): string[] {
  const outs = (s.script.split('\n')[beat]!.match(/->\s*([a-z, ]+?)(\s+power|$)/)?.[1] ?? 'hit').split(',').map((x) => x.trim())
  return outs.length >= n ? outs.slice(outs.length - n) : [...Array<string>(n - outs.length).fill('block'), ...outs]
}

/** The floor clearance a clip state holds a bot at (its capture's height off the floor, crossfaded as the pose is). */
function clearance(assetId: string, clip: ClipState | undefined): number {
  const m = personDims(assetId).mocap
  const c = clip && mocapClip(clip.id)
  if (!m || !c || !clip) return 0
  const at = (id: string, t: number, mirror?: boolean): number => {
    const s = clipSample(mocapClip(id)!, t, mirror)
    return s.clear * clipScale(m, s.hipH)
  }
  const clear = at(clip.id, clip.t, clip.mirror)
  const w = Math.min(1, Math.max(0, clip.w ?? 1))
  if (w >= 1) return clear
  const ca = clip.from && mocapClip(clip.from.id) ? at(clip.from.id, clip.from.t, clip.from.mirror) : 0
  return ca + (clear - ca) * w
}

const ALL_BONES = new Set(MOCAP_BONES.map((b) => BONE_INDEX[b]))
/** How deep two evaluated bots' skins (fisted, as rendered) sit in each other (m). */
function overlap(sa: EntityState, aId: string, sb: EntityState, bId: string): number {
  const skin = (s: EntityState, id: string): { p: V3[]; mesh: ReturnType<typeof skinMesh> } => {
    const m = personDims(id).mocap!
    const own = boneSkin(m, fighterPose(m, s.joints, s.clip), ALL_BONES)!
    const p = own.p.map((q) => toWorld(q, s.position, s.heading, 1))
    return { p, mesh: skinMesh(p, own.tri) }
  }
  const A = skin(sa, aId)
  const B = skin(sb, bId)
  return Math.max(0, meshDepth(A.p, B.mesh), meshDepth(B.p, A.mesh))
}

const PAIRINGS = [BOTS, [...BOTS].reverse()]

describe.skipIf(!HAS_LIBRARY)('the Fight Director on the real library (skipped without it)', () => {
  it('every connecting blow lands within 1.5 cm on its impact frame, on all scripts, Y Bot vs X Bot both ways', () => {
    const fails: string[] = []
    for (const assets of PAIRINGS) {
      for (const s of SCRIPTS) {
        const { sol } = solve(s, assets)
        for (const b of sol.report.beats) {
          const outs = outcomesOf(s, b.index, b.contactErrorM.length)
          b.contactErrorM.forEach((e, i) => {
            if (CONNECTS.has(outs[i]!) && !(e <= 0.015)) fails.push(`${assets[0]} ${s.name} b${b.index + 1}.${i + 1} ${b.plays}: ${(e * 100).toFixed(2)} cm`)
          })
        }
        if (!s.weapons && s.name !== 'grapples') expect(sol.report.beats.some((b) => b.plays.startsWith('mocap:')), s.name).toBe(true)
      }
    }
    expect(fails).toEqual([])
  }, 900_000)

  it('the bodies sit no more than 3 cm in each other within 0.1 s of each impact', () => {
    const fails: string[] = []
    for (const assets of PAIRINGS) {
      for (const s of SCRIPTS) {
        const { sol, ev } = solve(s, assets)
        for (const T of sol.report.beats.flatMap((b) => b.impactTimes)) {
          for (let k = -2; k <= 2; k++) {
            const t = Math.round(T * FPS + k) / FPS
            const [sa, sb] = ['a', 'b'].map((id) => ev.evaluate(t).entities.find((e) => e.entityId === id)!)
            const d = overlap(sa!, assets[0]!, sb!, assets[1]!)
            if (d > 0.03) fails.push(`${assets[0]} ${s.name} t=${t.toFixed(3)}: ${(d * 100).toFixed(2)} cm`)
          }
        }
      }
    }
    expect(fails).toEqual([])
  }, 900_000)

  it('planted feet stay within 2 cm of the floor the clip holds them at, every frame (but a kick lift)', () => {
    const fails: string[] = []
    for (const assets of PAIRINGS) {
      for (const s of SCRIPTS) {
        const { sol, ev } = solve(s, assets)
        const lifts = sol.report.beats.flatMap((b) => b.impactTimes.filter((_, i) => (b.liftM[i] ?? 0) > 0))
        for (let k = 0; k <= Math.ceil(sol.report.endT * FPS); k++) {
          const t = k / FPS
          for (const e of ev.evaluate(t).entities) {
            const q = ['a', 'b'].indexOf(e.entityId)
            if (q < 0) continue
            const low = e.position.y + bodyLowY({ assetId: assets[q]! }, e.joints, e.clip) - clearance(assets[q]!, e.clip)
            const lifted = lifts.some((T) => Math.abs(t - T) < 1)
            if (low < -0.02 || (!lifted && low > 0.02)) fails.push(`${assets[0]} ${s.name} ${e.entityId} t=${t.toFixed(3)}: ${(low * 100).toFixed(1)} cm`)
          }
        }
      }
    }
    expect(fails.slice(0, 20)).toEqual([])
  }, 900_000)

  it('a bare-hand block or parry meets the guard, the striking limb at least 5 cm off the head and the torso (fight-polish)', () => {
    const bones = (names: string[]): Set<number> => new Set(names.map((b) => BONE_INDEX[b as keyof typeof BONE_INDEX]))
    const skin = (s: EntityState, id: string, set: Set<number>): { p: V3[]; mesh: ReturnType<typeof skinMesh> } => {
      const m = personDims(id).mocap!
      const own = boneSkin(m, fighterPose(m, s.joints, s.clip), set)!
      const p = own.p.map((q) => toWorld(q, s.position, s.heading, 1))
      return { p, mesh: skinMesh(p, own.tri) }
    }
    const fails: string[] = []
    let blocks = 0
    for (const assets of PAIRINGS) {
      for (const s of SCRIPTS.filter((x) => !x.weapons)) {
        const { sol, ev } = solve(s, assets)
        for (const b of sol.report.beats) {
          const who = s.script.split('\n')[b.index]!.trim().startsWith('B') ? 1 : 0
          const outs = outcomesOf(s, b.index, b.impactTimes.length)
          b.impactTimes.forEach((T, i) => {
            if (outs[i] !== 'block' && outs[i] !== 'parry') return
            blocks++
            const st = ev.evaluate(T).entities
            const a = st.find((e) => e.entityId === (who ? 'b' : 'a'))!
            const d = st.find((e) => e.entityId === (who ? 'a' : 'b'))!
            const e = b.effectors![i]!
            const side = e.endsWith('L') ? 'Left' : 'Right'
            const limb = skin(a, assets[who]!, bones(e.startsWith('hand') || e.startsWith('elbow') ? [`${side}Arm`, `${side}ForeArm`, `${side}Hand`] : [`${side}UpLeg`, `${side}Leg`, `${side}Foot`, `${side}ToeBase`]))
            const clear = Math.min(...[['Head', 'Neck'], ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder']].map((x) => -meshDepth(limb.p, skin(d, assets[1 - who]!, bones(x)).mesh)))
            if (!(b.contactErrorM[i]! <= 0.015) || !(clear >= 0.05)) fails.push(`${assets[0]} ${s.name} b${b.index + 1}.${i + 1}: guard ${(b.contactErrorM[i]! * 100).toFixed(2)} cm, head / torso clear ${(clear * 100).toFixed(1)} cm`)
          })
        }
      }
    }
    expect(blocks).toBeGreaterThanOrEqual(4)
    expect(fails).toEqual([])
  }, 900_000)

  it('solves the same bot fight to the same marks twice', () => {
    const s = SCRIPTS[1]!
    const parsed = parseFightScript(s.script, ['A', 'B'])
    if (!('beats' in parsed)) throw new Error(parsed.error)
    const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
    const input = (q: number): FighterInput => ({ entityId: q ? 'b' : 'a', assetId: BOTS[q]!, scale: 1, start: { x: q ? 0.55 : -0.55, y: 0, z: -4 } })
    const a = solveFight(fight, [input(0), input(1)], { duration: 30, fps: FPS })
    const b = solveFight(fight, [input(0), input(1)], { duration: 30, fps: FPS })
    expect(JSON.stringify(b.tracks)).toBe(JSON.stringify(a.tracks))
    expect(JSON.stringify(b.report)).toBe(JSON.stringify(a.report))
  }, 300_000)
})
