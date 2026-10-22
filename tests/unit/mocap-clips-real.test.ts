// Fork addition (2026): the library's real clips on Y Bot / X Bot (skipped without the local library; nothing from it is stored); see MODIFICATIONS.md.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { buildAsset, type AnimInput } from '@renderer/viewport/builders'
import { registerClipTake, registerMocapTemplate } from '@renderer/mocap/library'
import { clearMocapClips, mocapClip, mocapClipIds, mocapClipPose, poseLowY } from '@engine/mocap/clip'
import { clipStride, clipWarp, gaitClipId, gaitPose } from '@engine/mocap/gait-clips'
import { BONE_INDEX, MOCAP_BONES } from '@engine/mocap/rig'
import { qrot } from '@engine/mocap/quat'
import type { MocapDims, MocapPose } from '@engine/mocap/fk'
import { clearMocapBodies } from '@engine/mocap/registry'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { ShotEvaluator } from '@engine/evaluate'
import { createEntity, createProject } from '@engine/schema'
import { choreographMotion } from '@engine/sequences'
import { SEAT_TOP, seatSpots, type SeatSpot } from '@engine/mocap/library-clips'
import { seatContactY } from '@engine/mocap/seat'
import type { GaitId } from '@engine/types'
import { mocapLibraryDir, parseMocapManifest } from '../../src/shared/mocap-library'
import { lowestSkinned } from './mocap-ground'

const LIBRARY = mocapLibraryDir()
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))
const BODY = { male: 'person.mocapMale', female: 'person.mocapFemale' } as const
const BOTS = Object.values(BODY)
const STEP = 1 / 12

function parse(file: string): ReturnType<FBXLoader['parse']> {
  const buf = readFileSync(join(LIBRARY, file))
  return new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
}

beforeAll(() => {
  if (!HAS_LIBRARY) return
  const manifest = parseMocapManifest(JSON.parse(readFileSync(join(LIBRARY, 'manifest.json'), 'utf-8')))!
  for (const body of ['male', 'female'] as const) {
    const c = manifest.characters.find((x) => x.body === body)!
    registerMocapTemplate(BODY[body], parse(c.file), c.name)
  }
  for (const c of manifest.clips) registerClipTake(c.key, parse(c.file), BODY.male, { fps: c.fps, loop: c.loop, inPlace: c.inPlace })
}, 300_000)

afterAll(() => {
  clearMocapClips()
  clearMocapBodies()
})

/** The lowest surface point of one bone of a pose (its support points). */
function ballLow(m: MocapDims, pose: MocapPose, bone: number): number {
  let low = Infinity
  for (const pt of m.rig.points) {
    if (pt.bone !== bone) continue
    const o = qrot(pose.G[bone]!, { x: pt.off.x * m.k, y: pt.off.y * m.k, z: pt.off.z * m.k })
    low = Math.min(low, pose.P[bone]!.y + o.y)
  }
  return low
}

/** The lowest surface point of a bone (its support points, a hand's fingers too). */
function surfaceLow(m: MocapDims, pose: MocapPose, bone: number): number {
  let low = Infinity
  for (const pt of m.rig.points) {
    if (pt.bone !== bone) continue
    const sub = !!pose.XG && pt.sub !== undefined
    const o = sub ? pt.subOff! : pt.off
    const q = qrot(sub ? pose.XG![pt.sub!]! : pose.G[bone]!, { x: o.x * m.k, y: o.y * m.k, z: o.z * m.k })
    low = Math.min(low, (sub ? pose.XP![pt.sub!]! : pose.P[bone]!).y + q.y)
  }
  return low
}

/** The gaits and speeds a bot is checked at (the sit on the floor, and on a seat). */
const GAIT_RUNS: [GaitId, number, boolean?][] = [['stand', 0], ['gesture', 0], ['walk', 1.4], ['jog', 3], ['run', 5.5], ['crouch', 0], ['crouch', 0.8], ['sit', 0], ['sit', 0, true], ['lie', 0], ['fall', 0]]

/** A motion applied to a bot (apply_motion's marks), sampled at fractions of its run: world effector heights. */
interface Heights {
  head: number
  pelvis: number
  hand: number
  handMax: number
  knee: number
  foot: number
  footMax: number
}

function motionHeights(id: string, move: string, fractions: number[], seats: SeatSpot[] = []): Heights[] {
  const doc = createProject('Floor moves')
  const scene = doc.scenes[0]!
  const e = createEntity(id, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(e)
  const marks = choreographMotion(move, { x: 0, y: 0, z: 0 }, 0, 10, 0, { assetId: id }, false, seats)!
  expect(marks.every((m) => m.clip), `${id} ${move} plays a clip`).toBe(true)
  scene.blocking[0]!.tracks.push({ entityId: e.id, marks: marks.map((m, i) => ({ id: `m${i}`, ...m, position: { ...m.position } })) })
  const end = marks[marks.length - 1]!.time
  const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: end })
  const d = personDims(id)
  return fractions.map((f): Heights => {
    const st = ev.evaluate(end * f).entities[0]!
    const fx = poseEffectors(d, st.joints, st.clip)
    const y = (k: keyof typeof fx): number => toWorld(fx[k], st.position, st.heading, 1).y
    // A hand or foot is on the floor when its surface is (the palm and the ball of the foot ride their bones:
    // a hand on its edge holds the palm up, a flat foot the ToeBase joint).
    const m = d.mocap!
    const pose = mocapClipPose(m, st.clip!, st.joints)!
    const low = (bones: (typeof MOCAP_BONES)[number][]): number => st.position.y + Math.min(...bones.map((b) => surfaceLow(m, pose, BONE_INDEX[b])))
    const hands = [low(['LeftHand']), low(['RightHand'])]
    const feet = [low(['LeftFoot', 'LeftToeBase']), low(['RightFoot', 'RightToeBase'])]
    return { head: y('head'), pelvis: y('pelvis'), hand: Math.min(...hands), handMax: Math.max(...hands), knee: Math.min(y('kneeL'), y('kneeR')), foot: Math.min(...feet), footMax: Math.max(...feet) }
  })
}

const ALL = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

describe.skipIf(!HAS_LIBRARY)('the library clips on the bots (skipped without the local library)', () => {
  it('the BACKLOG floor moves make their pose on both bots: push-ups, crawl, kneel, sit, falls, get-up, cartwheel', () => {
    for (const id of BOTS) {
      for (const h of motionHeights(id, 'push-ups', ALL)) expect(h.hand <= 0.05 && h.foot <= 0.1 && h.head <= 0.8, `${id} push-ups ${JSON.stringify(h)}`).toBe(true)
      for (const h of motionHeights(id, 'crawl', ALL)) expect(h.hand <= 0.06 && h.knee <= 0.16 && h.head <= 0.8, `${id} crawl ${JSON.stringify(h)}`).toBe(true)
      const [kneel] = motionHeights(id, 'kneel-tie-shoe', [1])
      expect(kneel!.knee <= 0.12 && kneel!.pelvis <= 0.5 && kneel!.head >= 0.8, `${id} kneel ${JSON.stringify(kneel)}`).toBe(true)
      const [floorSit] = motionHeights(id, 'sit-down', [1])
      expect(floorSit!.pelvis <= 0.25 && floorSit!.head >= 0.6 && floorSit!.foot <= 0.1, `${id} sit on the floor ${JSON.stringify(floorSit)}`).toBe(true)
      const [sit] = motionHeights(id, 'sit-down', [1], seatSpots([createEntity('furniture.chair', 'C', { x: 0, y: 0, z: 0 })]))
      expect(sit!.pelvis >= 0.4 && sit!.pelvis <= 0.7 && sit!.head >= 1 && sit!.foot <= 0.06, `${id} sit in a chair ${JSON.stringify(sit)}`).toBe(true)
      for (const fall of ['fall-backwards', 'trip-and-fall-flat', 'knockdown-fall', 'ko-collapse']) {
        const [down] = motionHeights(id, fall, [1])
        expect(down!.head <= 0.3 && down!.pelvis <= 0.3, `${id} ${fall} ${JSON.stringify(down)}`).toBe(true)
      }
      const [slip] = motionHeights(id, 'stumble-back-fall', [1])
      expect(slip!.pelvis <= 0.3 && slip!.hand <= 0.05, `${id} stumble-back-fall ${JSON.stringify(slip)}`).toBe(true)
      const [lying, up] = motionHeights(id, 'get-up-from-ground', [0, 1])
      expect(lying!.head <= 0.3 && up!.head >= 1.35 && up!.foot <= 0.03, `${id} get-up ${JSON.stringify([lying, up])}`).toBe(true)
      const wheel = motionHeights(id, 'cartwheel', ALL)
      expect(wheel.some((h) => h.hand <= 0.1 && h.footMax >= 1.2), `${id} cartwheel goes over its hands`).toBe(true)
      expect(wheel[wheel.length - 1]!.head >= 1.4, `${id} cartwheel lands standing`).toBe(true)
    }
  }, 300_000)

  it('a chair sit rests the hips on the seat prop’s top and keeps the feet on the floor (±2 cm), every 1/12 s, on both bots', () => {
    // mocap-backlog: chair, stool, couch and office chair; the hips on the seat from the moment the stand-to-sit lands.
    const fails: string[] = []
    for (const id of BOTS) {
      const m = personDims(id).mocap!
      for (const assetId of ['furniture.chair', 'furniture.stool', 'furniture.couch', 'furniture.officeChair']) {
        const doc = createProject('Seats')
        const scene = doc.scenes[0]!
        const e = createEntity(id, 'P', { x: 0, y: 0, z: 0 })
        const seat = createEntity(assetId, 'Seat', { x: 0, y: 0, z: 0 })
        scene.entities.push(e, seat)
        const marks = choreographMotion('sit-down', { x: 0, y: 0, z: 0 }, 0, 8, 0, { assetId: id }, false, seatSpots([seat]))!
        expect(marks.map((mk) => mk.clip?.id), `${id} ${assetId}`).toEqual(['standToSit', 'standToSit', 'sitChair', 'sitChair'])
        scene.blocking[0]!.tracks.push({ entityId: e.id, marks: marks.map((mk, i) => ({ id: `m${i}`, ...mk, position: { ...mk.position } })) })
        const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: 8 })
        const top = SEAT_TOP[assetId]!
        let worstSeat = 0
        let worstFoot = 0
        for (let t = 0; t <= 8 + 1e-9; t += STEP) {
          const st = ev.evaluate(t).entities[0]!
          const pose = mocapClipPose(m, st.clip!, st.joints)!
          const feet = [BONE_INDEX.LeftFoot, BONE_INDEX.RightFoot].map((b, k) => st.position.y + Math.min(surfaceLow(m, pose, b), surfaceLow(m, pose, k === 0 ? BONE_INDEX.LeftToeBase : BONE_INDEX.RightToeBase)))
          worstFoot = Math.max(worstFoot, ...feet.map(Math.abs))
          if (t >= marks[1]!.time) worstSeat = Math.max(worstSeat, Math.abs(st.position.y + seatContactY(m, pose) - top))
        }
        if (worstSeat > 0.01) fails.push(`${id} ${assetId}: hips ${(worstSeat * 100).toFixed(1)} cm off the seat top`)
        if (worstFoot > 0.02) fails.push(`${id} ${assetId}: a foot ${(worstFoot * 100).toFixed(1)} cm off the floor`)
      }
    }
    expect(fails).toEqual([])
  }, 300_000)

  it('a bare crouch keeps both hands below the chest, every 1/12 s, on both bots', () => {
    const fails: string[] = []
    for (const id of BOTS) {
      const m = personDims(id).mocap!
      const c = mocapClip(gaitClipId(id, 'crouch', 0)!)!
      for (let t = 0; t < 2 * c.duration; t += STEP) {
        const pose = gaitPose(m, c, null, 0, t).pose
        const chest = pose.P[BONE_INDEX.Spine2]!.y
        for (const hand of ['LeftHand', 'RightHand'] as const) if (pose.P[BONE_INDEX[hand]]!.y > chest) fails.push(`${id} ${c.id} t=${t.toFixed(2)}: ${hand} ${(pose.P[BONE_INDEX[hand]]!.y * 100).toFixed(0)} cm over the chest ${(chest * 100).toFixed(0)} cm`)
      }
    }
    expect(fails.slice(0, 10)).toEqual([])
  })

  it('every gait keeps the rendered skin on its floor within ±2 cm, every 1/12 s, on both bots', () => {
    const fails: string[] = []
    for (const id of BOTS) {
      const b = buildAsset(id)
      const m = personDims(id).mocap!
      for (const [gait, speed, seated] of GAIT_RUNS) {
        const clip = gaitClipId(id, gait, speed, seated)
        expect(clip, `${id} ${gait}`).toBeDefined()
        for (let t = 0; t < 4; t += STEP) {
          const input: AnimInput = { gait, phase: 0, speed, distance: speed * t, time: t, scale: 1, seated }
          b.animate!(input)
          const c = mocapClip(clip!)!
          const want = poseLowY(m, gaitPose(m, c, clipWarp(m, c, id), speed * t, t).pose)
          const low = lowestSkinned(b.group, 3)
          if (Math.abs(low - want) > 0.02 || low < -0.02) fails.push(`${id} ${gait}@${speed} t=${t.toFixed(2)}: skin ${(low * 100).toFixed(1)} cm, want ${(want * 100).toFixed(1)} cm`)
        }
      }
    }
    expect(fails.slice(0, 20)).toEqual([])
  }, 600_000)

  it('every clip keeps the rendered skin on its floor within ±2 cm, every 1/12 s, on both bots', () => {
    const fails: string[] = []
    for (const id of BOTS) {
      const b = buildAsset(id)
      const m = personDims(id).mocap!
      for (const key of mocapClipIds()) {
        const c = mocapClip(key)!
        for (let t = 0; t <= c.duration + 1e-9; t += STEP) {
          b.animate!({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: t, clip: { id: key, t } })
          const want = poseLowY(m, mocapClipPose(m, { id: key, t })!)
          const low = lowestSkinned(b.group, 3)
          if (Math.abs(low - want) > 0.02 || low < -0.02) fails.push(`${id} ${key} t=${t.toFixed(2)}: skin ${(low * 100).toFixed(1)} cm, want ${(want * 100).toFixed(1)} cm`)
        }
      }
    }
    expect(fails.slice(0, 30)).toEqual([])
  }, 900_000)

  it('a planted contact slides less than 2 cm per step on the travelling mark runs (crawl, sneak, drunk walk, sprint), on both bots', () => {
    const fails: string[] = []
    // The gait test's rule, for every contact of a run: a foot (heel and ball), a hand, a knee is planted while
    // each of its bones is within 3 mm of the floor and it moves slower than half the run; its slide is how far
    // its joints drift from where it planted, every 1/120 s. mocap-backlog: a knee counts its whole drift (the
    // X Bot's crawl knee, retargeted, is pinned: mocap/contact-lock.ts).
    const GROUPS: [string, number[]][] = [
      ['left foot', [BONE_INDEX.LeftFoot, BONE_INDEX.LeftToeBase]],
      ['right foot', [BONE_INDEX.RightFoot, BONE_INDEX.RightToeBase]],
      ['left hand', [BONE_INDEX.LeftHand]],
      ['right hand', [BONE_INDEX.RightHand]],
      ['left knee', [BONE_INDEX.LeftLeg]],
      ['right knee', [BONE_INDEX.RightLeg]]
    ]
    for (const id of BOTS) {
      const m = personDims(id).mocap!
      for (const move of ['crawl', 'mocap-sneak', 'mocap-drunkWalk', 'mocap-sprint']) {
        const doc = createProject('Runs')
        const scene = doc.scenes[0]!
        const e = createEntity(id, 'P', { x: 0, y: 0, z: 0 })
        scene.entities.push(e)
        const marks = choreographMotion(move, { x: 0, y: 0, z: 0 }, 0.6, 6, 0, { assetId: id })!
        expect(marks.every((mk) => mk.clip), `${id} ${move} plays a clip`).toBe(true)
        scene.blocking[0]!.tracks.push({ entityId: e.id, marks: marks.map((mk, i) => ({ id: `m${i}`, ...mk, position: { ...mk.position } })) })
        const end = marks[marks.length - 1]!.time
        const speed = Math.hypot(marks[1]!.position.x - marks[0]!.position.x, marks[1]!.position.z - marks[0]!.position.z) / end
        expect(speed, `${id} ${move} travels`).toBeGreaterThan(0.3)
        const ev = new ShotEvaluator(scene, { ...scene.shots[0]!, duration: end })
        const dt = 1 / 120
        const at = (t: number): { pose: MocapPose; y: number; joint: (bones: number[]) => { x: number; z: number } } => {
          const st = ev.evaluate(t).entities[0]!
          const pose = mocapClipPose(m, st.clip!, st.joints)!
          const joint = (bones: number[]): { x: number; z: number } => {
            const ps = bones.map((b) => toWorld(pose.P[b]!, st.position, st.heading, 1))
            return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, z: ps.reduce((a, p) => a + p.z, 0) / ps.length }
          }
          return { pose, y: st.position.y, joint }
        }
        const starts: ({ x: number; z: number } | null)[] = GROUPS.map(() => null)
        const worst = GROUPS.map(() => 0)
        let s0 = at(0)
        for (let t = 0; t + dt <= end; t += dt) {
          const s1 = at(t + dt)
          GROUPS.forEach(([, bones], g) => {
            const p = s0.joint(bones)
            const q = s1.joint(bones)
            const slow = Math.hypot(q.x - p.x, q.z - p.z) / dt < 0.5 * speed
            if (slow && bones.every((b) => s0.y + ballLow(m, s0.pose, b) < 0.003)) {
              const o = (starts[g] ??= p)
              worst[g] = Math.max(worst[g]!, Math.hypot(p.x - o.x, p.z - o.z))
            } else starts[g] = null
          })
          s0 = s1
        }
        GROUPS.forEach(([name], g) => {
          if (worst[g]! > 0.02) fails.push(`${id} ${move} ${name} slides ${(worst[g]! * 100).toFixed(1)} cm`)
        })
      }
    }
    expect(fails).toEqual([])
  }, 600_000)

  it('a planted foot slides less than 2 cm per step on walk, jog, run and crouch-walk, on both bots', () => {
    const fails: string[] = []
    for (const id of BOTS) {
      const m = personDims(id).mocap!
      for (const [gait, speed] of [['walk', 1.4], ['jog', 3], ['run', 5.5], ['crouch', 0.8]] as [GaitId, number][]) {
        const key = gaitClipId(id, gait, speed)!
        const c = mocapClip(key)!
        const warp = clipWarp(m, c, id)
        const stride = clipStride(m, c, id)
        // Each foot (its ankle and ball joints) in the world (the entity walks −Z) while it is planted flat:
        // heel and ball within 3 mm of the floor, and slower than half the body (a swing brushing the floor
        // before it lands isn't planted; a heel rising onto the toes pivots, it doesn't slide), every
        // 1/120 s over 4 cycles.
        const dt = 1 / 120
        const span = (4 * stride) / speed
        const poseAt = (t: number): MocapPose => gaitPose(m, c, warp, speed * t, t).pose
        const footAt = (t: number, ball: number, heel: number): { x: number; z: number } => {
          const pose = poseAt(t)
          return { x: (pose.P[ball]!.x + pose.P[heel]!.x) / 2, z: (pose.P[ball]!.z + pose.P[heel]!.z) / 2 - speed * t }
        }
        for (const s of ['Left', 'Right'] as const) {
          const ball = BONE_INDEX[`${s}ToeBase`]
          const heel = BONE_INDEX[`${s}Foot`]
          let start: { x: number; z: number } | null = null
          let worst = 0
          for (let t = 0; t <= span; t += dt) {
            const pose = poseAt(t)
            const p = footAt(t, ball, heel)
            const q = footAt(t + dt, ball, heel)
            const slow = Math.hypot(q.x - p.x, q.z - p.z) / dt < 0.5 * speed
            // Heights off the floor (the gait pose is grounded: the floor is y = 0).
            const planted = ballLow(m, pose, ball) < 0.003 && ballLow(m, pose, heel) < 0.003 && slow
            if (planted) {
              start ??= p
              worst = Math.max(worst, Math.hypot(p.x - start.x, p.z - start.z))
            } else start = null
          }
          if (worst > 0.02) fails.push(`${id} ${gait} ${s.toLowerCase()} foot slides ${(worst * 100).toFixed(1)} cm`)
        }
      }
    }
    expect(fails).toEqual([])
  }, 300_000)
})
