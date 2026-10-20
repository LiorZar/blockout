/**
 * Fork: the prompt's scene sections — what each grey shape stands for, the
 * action in time order, and the camera in words — and the per-profile
 * prompt cap (src/engine/prompt-scene.ts).
 */

import { describe, expect, it } from 'vitest'
import { generatePrompt } from '@engine/prompt'
import { describeShot } from '@engine/prompt-scene'
import { getProfile } from '@engine/profiles'
import { createActorMark, createCameraMark, createEntity, createProject } from '@engine/schema'
import { choreographMotion } from '@engine/sequences'
import type { Entity, FightDoc, Scene, Shot } from '@engine/types'

function fixture(duration = 8): { scene: Scene; shot: Shot } {
  const doc = createProject('Prompt scene')
  const scene = doc.scenes[0]!
  const shot = scene.shots[0]!
  shot.duration = duration
  return { scene, shot }
}

function person(scene: Scene, assetId: string, label: string, color: string, x: number, z: number): Entity {
  const e = createEntity(assetId, label, { x, y: 0, z })
  e.label = { text: label, color }
  scene.entities.push(e)
  return e
}

function track(scene: Scene, shot: Shot, e: Entity, marks: ReturnType<typeof createActorMark>[]): void {
  const take = scene.blocking.find((b) => b.id === shot.blockingTakeId)!
  take.tracks.push({ entityId: e.id, marks })
}

function weaponFight(): { scene: Scene; shot: Shot; a: Entity; b: Entity } {
  const { scene, shot } = fixture(10)
  const a = person(scene, 'person.mannequinMale', 'A', '#f97316', -0.55, 0)
  const b = person(scene, 'person.mannequinMale', 'B', '#a855f7', 0.55, 0)
  const katana = createEntity('prop.katana', 'Katana', { x: -0.55, y: 0, z: 0 })
  katana.heldBy = { entityId: a.id, hand: 'R' }
  katana.label = { text: '', color: '#46a758' }
  scene.entities.push(katana)
  const fight: FightDoc = {
    id: 'fight-1',
    name: 'Fight 1',
    fighterIds: [a.id, b.id],
    beats: [
      { attacker: 0, move: 'sword-slash-combo', target: 'head', outcomes: ['block'], power: 0.7 },
      { attacker: 1, move: 'jab-cross', target: 'head', outcomes: ['block', 'slip'], power: 0.7 },
      { attacker: 0, move: 'sword-slash-combo', target: 'body', outcomes: ['ko'], power: 1 }
    ],
    startT: 0.4,
    origin: { x: 0, z: 0, heading: 0 },
    beatGap: 0.35,
    exaggeration: 1.5
  }
  scene.fights = [fight]
  shot.camera.marks.push(
    createCameraMark({ x: 0, y: 1.6, z: 5 }, 0, 0, 0, 35),
    createCameraMark({ x: 0, y: 1.6, z: 5 }, 6, 0, 0, 35)
  )
  shot.camera.marks[0]!.shot = { size: 'WS', subjectIds: [a.id, b.id] }
  shot.camera.marks[1]!.shot = { size: 'MCU', subjectIds: [b.id], over: { entityId: a.id, shoulder: 'right' }, lens: 50 }
  return { scene, shot, a, b }
}

describe('proxy map', () => {
  it('names colour, shape and label → what it stands for, with held weapons', () => {
    const { scene, shot } = weaponFight()
    const car = person(scene, 'vehicle.sedan', 'CAR', '#3b82f6', 10, -10)
    void car
    const bomb = person(scene, 'prim.cube', 'BOMB', '#e5484d', 3, 3)
    void bomb
    scene.entities.push(createEntity('prop.crate', 'Crate', { x: 5, y: 0, z: 5 }))
    const { proxies } = describeShot(scene, shot)
    expect(proxies).toContain("The orange mannequin (A) is a man holding a katana (the green shape) in A's right hand.")
    expect(proxies).toContain('The purple mannequin (B) is a man.')
    expect(proxies).toContain('The blue box on wheels (CAR) is a sedan car.')
    expect(proxies).toContain('The red box stands for "BOMB".')
    // The held katana is part of its holder's line; static set dressing is left to the setting.
    expect(proxies).toHaveLength(4)
  })

  it('skips entities hidden in exports and reads unlabelled people as grey', () => {
    const { scene, shot } = fixture()
    const hidden = person(scene, 'person.woman', 'GHOST', '#e5484d', 0, 0)
    hidden.excludeFromExport = true
    scene.entities.push(createEntity('person.woman', 'Woman', { x: 1, y: 0, z: 0 }))
    expect(describeShot(scene, shot).proxies).toEqual(['The grey figure is a woman.'])
  })
})

describe('crowds', () => {
  function crowd(): { scene: Scene; shot: Shot } {
    const { scene, shot } = fixture(4)
    for (let i = 0; i < 8; i++) {
      const e = createEntity(i % 2 ? 'person.woman' : 'person.man', 'Dancer', { x: i - 4, y: 0, z: -4 })
      scene.entities.push(e)
      const marks = choreographMotion('robot', { x: i - 4, y: 0, z: -4 }, 0, 4)!.map((m) => ({
        ...createActorMark(m.position, m.time, m.gait),
        joints: m.joints
      }))
      track(scene, shot, e, marks)
    }
    return { scene, shot }
  }

  it('counts unlabelled look-alikes in one line instead of collapsing them', () => {
    const { scene, shot } = crowd()
    expect(describeShot(scene, shot).proxies).toEqual(['The 8 grey figures are 4 men and 4 women.'])
  })

  it('tells one action for the whole group', () => {
    const { scene, shot } = crowd()
    expect(describeShot(scene, shot).action).toEqual(['4 men and 4 women dance the robot.'])
  })

  it('reads an unlabelled mannequin as light grey, its rendered plastic', () => {
    const { scene, shot } = fixture()
    scene.entities.push(createEntity('person.mannequinFemale', 'Mannequin', { x: 0, y: 0, z: 0 }))
    expect(describeShot(scene, shot).proxies).toEqual(['The light grey mannequin is a woman.'])
  })
})

describe('action', () => {
  it('describes a staged weapon fight beat by beat, from its script', () => {
    const { scene, shot } = weaponFight()
    const text = describeShot(scene, shot).action.join(' ')
    // A guarded katana blow still staggers (fight physics), and the script's single 'ko' pads the combo's first impact with a block.
    expect(text).toContain("A slashes at B's head with the katana, B blocks but staggers back.")
    expect(text).toMatch(/B throws a jab and cross at A's head, A blocks, then A slips it\./)
    expect(text).toMatch(/A slashes at B's body with the katana, B blocks[^.]*, then it knocks B out\./)
    expect(text.indexOf('B blocks')).toBeLessThan(text.indexOf('knocks B out'))
  })

  it('reads two runners on one line as a chase, in screen direction', () => {
    const { scene, shot } = fixture(6)
    const runner = person(scene, 'person.man', 'RUNNER', '#e5484d', 0, 0)
    const cop = person(scene, 'person.man', 'COP', '#3b82f6', 0, 4)
    track(scene, shot, runner, [createActorMark({ x: 0, y: 0, z: 0 }, 0, 'stand'), createActorMark({ x: 0, y: 0, z: -24 }, 5, 'run')])
    track(scene, shot, cop, [createActorMark({ x: 0, y: 0, z: 4 }, 0, 'stand'), createActorMark({ x: 0, y: 0, z: -20 }, 5, 'run')])
    // Camera off to the side, looking −X: travel toward −Z crosses the frame left to right.
    shot.camera.marks.push(createCameraMark({ x: 12, y: 1.6, z: -10 }, 0, Math.PI / 2, 0, 35))
    const action = describeShot(scene, shot).action
    expect(action).toEqual(['COP chases RUNNER from left to right.'])
  })

  it('says a vehicle drives and a walker comes toward the camera', () => {
    const { scene, shot } = fixture(6)
    const car = person(scene, 'vehicle.sedan', 'CAR', '#3b82f6', -20, -10)
    track(scene, shot, car, [createActorMark({ x: -20, y: 0, z: -10 }, 0, 'stand'), createActorMark({ x: 20, y: 0, z: -10 }, 4, 'run')])
    const man = person(scene, 'person.man', 'JO', '#46a758', 0, -8)
    track(scene, shot, man, [createActorMark({ x: 0, y: 0, z: -8 }, 1, 'stand'), createActorMark({ x: 0, y: 0, z: -3 }, 5, 'walk')])
    shot.camera.marks.push(createCameraMark({ x: 0, y: 1.6, z: 2 }, 0, 0, 0, 35))
    expect(describeShot(scene, shot).action).toEqual(['CAR drives from left to right.', 'JO walks toward the camera.'])
  })

  it('names applied motions from the motion library', () => {
    const { scene, shot } = fixture(4)
    const b = person(scene, 'person.woman', 'B', '#ec4899', 0, -4)
    const marks = choreographMotion('robot', { x: 0, y: 0, z: -4 }, 0, 4)!.map((m) => ({
      ...createActorMark(m.position, m.time, m.gait),
      joints: m.joints
    }))
    track(scene, shot, b, marks)
    expect(describeShot(scene, shot).action).toEqual(['B dances the robot.'])
  })
})

describe('camera words', () => {
  it('reads live shot marks as shot words, in order', () => {
    const { scene, shot } = weaponFight()
    expect(describeShot(scene, shot).camera).toEqual([
      "Camera: wide shot of A and B; then medium close-up on B, over A's right shoulder, 50mm."
    ])
  })

  it('names each framing once when the coverage goes back and forth', () => {
    const { scene, shot, a, b } = weaponFight()
    const two = { size: 'WS' as const, subjectIds: [a.id, b.id] }
    shot.camera.marks = [0, 2, 4, 6].map((t) => createCameraMark({ x: 0, y: 1.6, z: 5 }, t, 0, 0, 35))
    shot.camera.marks.forEach((m, k) => (m.shot = k % 2 ? { size: 'MCU', subjectIds: [b.id] } : two))
    expect(describeShot(scene, shot).camera).toEqual(['Camera: moves between a wide shot of A and B and a medium close-up on B.'])
  })

  it('reads the overall camera move once, with the rig and the lens change, never pans or "zoom"', () => {
    const { scene, shot } = fixture(5)
    shot.camera.rig = 'handheld'
    shot.camera.marks.push(
      createCameraMark({ x: 0, y: 1.6, z: 6 }, 0, 0, 0, 35),
      createCameraMark({ x: 0, y: 1.6, z: 1 }, 5, 0.6, 0, 85)
    )
    const camera = describeShot(scene, shot).camera.join(' ')
    expect(camera).toContain('handheld')
    expect(camera).toContain('moves forward')
    expect(camera).not.toContain('pans')
    expect(camera).toContain('35mm to 85mm')
    expect(camera.toLowerCase()).not.toContain('zoom')
  })

  it('says a still camera is locked off', () => {
    const { scene, shot } = fixture(5)
    shot.camera.marks.push(createCameraMark({ x: 0, y: 1.6, z: 6 }, 0, 0, 0, 35))
    expect(describeShot(scene, shot).camera).toEqual(['Camera: locked off.'])
  })
})

describe('generatePrompt with scene sections', () => {
  it('H3 Max: proxy map, then action, then camera, then its own adherence clause', () => {
    const { scene, shot } = weaponFight()
    const h3 = getProfile('minimax-h3-max')
    const prompt = generatePrompt(scene, shot, h3)
    const iProxy = prompt.indexOf('The orange mannequin (A)')
    const iAction = prompt.indexOf('A slashes at')
    const iCamera = prompt.indexOf('Camera:')
    expect(iProxy).toBe(0)
    expect(iAction).toBeGreaterThan(iProxy)
    expect(iCamera).toBeGreaterThan(iAction)
    expect(prompt.endsWith(h3.adherenceClause)).toBe(true)
    expect(prompt).not.toContain('Subjects:')
    expect(prompt.length).toBeLessThanOrEqual(2000)
  })

  it('calls the shapes placeholders for the named subjects, not "grey figures", once they have colours', () => {
    const { scene, shot } = weaponFight()
    const prompt = generatePrompt(scene, shot, getProfile('seedance-2'))
    expect(prompt).not.toContain('grey figures')
    expect(prompt).toContain('The shapes are placeholders for the subjects named above')
  })

  it('names the amber label amber (the tint keeps its hue)', () => {
    const { scene, shot } = fixture()
    person(scene, 'person.man', 'AL', '#f5a524', 0, 0)
    expect(describeShot(scene, shot).proxies).toEqual(['The amber figure (AL) is a man.'])
  })

  it('every video profile gets the proxy map and the action', () => {
    const { scene, shot } = weaponFight()
    for (const id of ['seedance-2', 'kling-2', 'veo-3.1']) {
      const prompt = generatePrompt(scene, shot, getProfile(id))
      expect(prompt).toContain('The orange mannequin (A)')
      expect(prompt).toContain('knocks B out')
      expect(prompt).toContain('strictly as a motion reference')
    }
  })

  it('trims to 2000 characters for H3, keeping the proxy map whole and saying the action goes on', () => {
    const { scene, shot } = fixture(15)
    const colors = ['#e5484d', '#f5a524', '#46a758', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316']
    // Twelve extras, each zig-zagging on its own heading: far more action than 2000 characters hold.
    const gaits = ['walk', 'run', 'jog'] as const
    for (let i = 0; i < 12; i++) {
      const x0 = i * 5 - 30
      const e = person(scene, i % 2 ? 'person.woman' : 'person.man', `EXTRA ${i + 1}`, colors[i % colors.length]!, x0, -6)
      const marks = [createActorMark({ x: x0, y: 0, z: -6 }, 0, 'stand')]
      for (let k = 1; k <= 6; k++) {
        const a = (i * 30 + k * 90) * (Math.PI / 180)
        const prev = marks[marks.length - 1]!.position
        marks.push(createActorMark({ x: prev.x + 4 * Math.sin(a), y: 0, z: prev.z - 4 * Math.cos(a) }, k * 2.2, gaits[k % 3]!))
      }
      track(scene, shot, e, marks)
    }
    shot.camera.marks.push(createCameraMark({ x: 0, y: 1.6, z: 6 }, 0, 0, 0, 35))
    const h3 = getProfile('minimax-h3-max')
    const prompt = generatePrompt(scene, shot, h3)
    expect(prompt.length).toBeLessThanOrEqual(2000)
    for (let i = 0; i < 12; i++) expect(prompt).toContain(`(EXTRA ${i + 1})`)
    expect(prompt).toContain('The rest of the action follows the reference video.')
    expect(prompt).toContain('Camera: locked off.')
    expect(prompt.endsWith(h3.adherenceClause)).toBe(true)
  })
})
