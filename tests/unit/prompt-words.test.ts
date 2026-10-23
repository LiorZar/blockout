// Fork addition (2026, qa-fixes; mocap-qa bug 7): the prompt's action words for stunts, falls and a chase of several pursuers; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { clipMotionName } from '@engine/mocap/library-clips'
import { describeShot } from '@engine/prompt-scene'
import { createActorMark, createCameraMark, createEntity, createProject } from '@engine/schema'
import { choreographMotion } from '@engine/sequences'
import type { ActorMark, Entity, GaitId, Scene, Shot } from '@engine/types'

function fixture(duration = 8): { scene: Scene; shot: Shot } {
  const doc = createProject('Prompt words')
  const scene = doc.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = duration
  // Off to the side, looking −X: travel toward −Z crosses the frame left to right.
  shot.camera.marks.push(createCameraMark({ x: 14, y: 1.6, z: -10 }, 0, Math.PI / 2, 0, 35))
  return { scene, shot }
}

function person(scene: Scene, label: string, color: string, x: number, z: number, assetId = 'person.man'): Entity {
  const e = createEntity(assetId, label, { x, y: 0, z })
  e.label = { text: label, color }
  scene.entities.push(e)
  return e
}

function track(scene: Scene, shot: Shot, e: Entity, marks: ActorMark[]): void {
  scene.blocking.find((b) => b.id === shot.blockingTakeId)!.tracks.push({ entityId: e.id, marks })
}

/** A motion from the library laid down where a performer stands. */
function motion(presetId: string, at: number): ActorMark[] {
  return choreographMotion(presetId, { x: 0, y: 0, z: 0 }, 0, 3, at)!.map((m) => ({ ...createActorMark(m.position, m.time, m.gait), joints: m.joints, posedMove: m.posedMove }))
}

/** A straight run toward −Z from z0 at `speed` m/s, a mark every `step` seconds, its gait per leg. */
function run(z0: number, t0: number, t1: number, speed: number, gait: (t: number) => GaitId = () => 'run', step = 0.25): ActorMark[] {
  const marks = [createActorMark({ x: 0, y: 0, z: z0 }, t0, 'stand')]
  for (let t = t0 + step; t <= t1 + 1e-9; t += step) marks.push(createActorMark({ x: 0, y: 0, z: z0 - speed * (t - t0) }, t, gait(t)))
  return marks
}

describe('the prompt names stunts and falls with their own verbs', () => {
  const said = (presetId: string): string => {
    const { scene, shot } = fixture(4)
    track(scene, shot, person(scene, 'B', '#ec4899', 0, 0), motion(presetId, 0.5))
    return describeShot(scene, shot).action.join(' ')
  }

  it('says what a stunt or a fall does, not "does a …"', () => {
    expect(said('vault-obstacle')).toBe('B vaults an obstacle.')
    expect(said('stumble-trip')).toBe('B stumbles.')
    expect(said('sprint-skid-stop')).toBe('B skids to a stop.')
    expect(said('trip-and-fall-flat')).toBe('B trips and falls flat.')
    expect(said('knocked-down')).toBe('B is knocked down.')
    expect(said('knockdown-fall')).toBe('B is knocked down.')
    expect(said('tackle-lunge')).toBe('B lunges into a tackle.')
    expect(said('hands-on-hips')).toBe('B stands with hands on hips.')
  })

  it('puts the verbs in the plural for several performers at once', () => {
    const { scene, shot } = fixture(4)
    track(scene, shot, person(scene, 'A', '#e5484d', -2, 0), motion('trip-and-fall-flat', 0.5))
    track(scene, shot, person(scene, 'B', '#3b82f6', 2, 0), motion('trip-and-fall-flat', 0.5))
    track(scene, shot, person(scene, 'C', '#46a758', 4, 0), motion('knocked-down', 2))
    track(scene, shot, person(scene, 'D', '#a855f7', 6, 0), motion('knocked-down', 2))
    expect(describeShot(scene, shot).action).toEqual(['A and B trip and fall flat.', 'C and D are knocked down.'])
  })

  it("a bot's trip clip is the trip and fall (its stumble plays keyframes)", () => {
    expect(clipMotionName('trip')?.id).toBe('trip-and-fall-flat')
  })
})

describe('the prompt reads a chase', () => {
  it('names every pursuer of a runner on one line, the one behind the other too', () => {
    const { scene, shot } = fixture(6)
    track(scene, shot, person(scene, 'RUNNER', '#e5484d', 0, 0), run(0, 0, 5, 5))
    track(scene, shot, person(scene, 'COP 1', '#3b82f6', 0, 3), run(3, 0, 5, 5))
    track(scene, shot, person(scene, 'COP 2', '#46a758', 0, 4), run(4, 0, 5, 5))
    expect(describeShot(scene, shot).action).toEqual(['COP 1 and COP 2 chase RUNNER from left to right.'])
  })

  it('reads a run through a change of pace or a short slowdown as one run', () => {
    const { scene, shot } = fixture(6)
    // A jog into a run, slowing to a near stop for a moment at 2 s.
    const marks = run(0, 0, 5, 5, (t) => (t < 1 ? 'jog' : 'run'))
    for (const m of marks) if (m.time > 2 && m.time <= 2.5) m.position.z = marks.find((x) => x.time > 1.99)!.position.z - 0.2 * (m.time - 2)
    let z = 0
    for (const m of marks) {
      if (m.time > 2.5) m.position.z = z - 1.25
      z = m.position.z
    }
    track(scene, shot, person(scene, 'RUNNER', '#e5484d', 0, 0), marks)
    expect(describeShot(scene, shot).action).toEqual(['RUNNER runs from left to right.'])
  })
})
