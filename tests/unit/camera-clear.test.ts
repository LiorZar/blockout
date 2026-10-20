// Fork test (fix-camera-set, docs/plans/2026-10-20-fix-camera-set.md): clear camera views.
import { describe, expect, it } from 'vitest'
import {
  castWorld,
  checkView,
  chooseView,
  describeView,
  insideOf,
  variantPosition,
  viewVariants,
  type SetBox,
  type ViewCheck,
  type ViewVariant,
  type ViewWorld
} from '@engine/camera-clear'
import { solveShot, type ShotSetup, type ShotSpec, type ShotSubject } from '@engine/shot'

const SETUP: ShotSetup = { sensorId: 'super35', aspect: '16:9', focalLength: 35 }

const person = (id: string, x: number, z: number, heading = 0): ShotSubject => ({
  id,
  assetId: 'person.man',
  scale: 1,
  position: { x, y: 0, z },
  heading
})

/** A 4 m wall across X at z, 0.15 m thick. */
const wall = (z: number, name = 'the back wall'): SetBox => ({ entityId: 'kit', name, x: 0, z, hx: 10, hz: 0.075, heading: 0, y0: 0, y1: 4 })
const world = (boxes: SetBox[], cast: ShotSubject[] = []): ViewWorld => {
  const w = castWorld(cast, new Set())
  return { boxes: [...boxes, ...w.boxes], bodies: w.bodies }
}

describe('view checks', () => {
  const hero = person('hero', 0, 0)

  it('sees a person in open space and loses them behind a wall', () => {
    const open = checkView({ x: 0, y: 1.6, z: 5 }, [hero], world([]), new Set(['hero']))
    expect(open).toEqual({ inside: null, visible: 1, blocker: null })
    const blocked = checkView({ x: 0, y: 1.6, z: 5 }, [hero], world([wall(3)]), new Set(['hero']))
    expect(blocked.visible).toBe(0)
    expect(blocked.blocker).toBe('the back wall')
  })

  it('a wall taller than the body band still hides a person from a raised camera', () => {
    expect(checkView({ x: 0, y: 3.5, z: 5 }, [hero], world([wall(3)]), new Set(['hero'])).visible).toBe(0)
    // Over a low wall (a bar counter) the camera sees head and chest.
    const bar: SetBox = { ...wall(3, 'the bar'), y1: 1.1 }
    expect(checkView({ x: 0, y: 2.2, z: 5 }, [hero], world([bar]), new Set(['hero'])).visible).toBeGreaterThanOrEqual(0.75)
  })

  it('knows when the camera is inside a wall or a body', () => {
    expect(insideOf({ x: 0, y: 1.6, z: 3.1 }, world([wall(3)]))).toBe('the back wall')
    expect(insideOf({ x: 0, y: 1.6, z: 3.5 }, world([wall(3)]))).toBeNull()
    expect(insideOf({ x: 0, y: 1.4, z: 0.1 }, world([], [hero]))).not.toBeNull()
    expect(checkView({ x: 0, y: 1.4, z: 0.1 }, [hero], world([], [hero]), new Set(['hero'])).inside).not.toBeNull()
  })

  it('other cast blocks the subject; framed subjects never block each other', () => {
    const pursuer = person('pursuer', 0, 1.5)
    const cam = { x: 0, y: 1.6, z: 5 }
    const w = world([], [hero, pursuer])
    expect(checkView(cam, [hero], w, new Set(['hero'])).visible).toBeLessThan(0.75)
    expect(checkView(cam, [hero], w, new Set(['hero'])).blocker).toBe('pursuer')
    expect(checkView(cam, [hero, pursuer], w, new Set(['hero', 'pursuer'])).visible).toBe(1)
  })

  it('a fallen body blocks low, not high', () => {
    // A person lying across the line of sight (pitched flat by a root pitch) is simulated by a low box.
    const lying: SetBox = { entityId: 'x', name: 'a body', x: 0, z: 2, hx: 1, hz: 0.25, heading: 0, y0: 0, y1: 0.35 }
    expect(checkView({ x: 0, y: 1.6, z: 5 }, [hero], world([lying]), new Set(['hero'])).visible).toBe(1)
  })
})

describe('view variants', () => {
  it('lists the asked-for view first, then closer, higher, swung — nearest first', () => {
    const v = viewVariants({ lens: 35 })
    expect(v[0]).toEqual({ turnDeg: 0, raise: 0, closer: 1 })
    expect(v.slice(1, 5)).toEqual([
      { turnDeg: 0, raise: 0, closer: 0.85 },
      { turnDeg: 0, raise: 0.5, closer: 1 },
      { turnDeg: 20, raise: 0, closer: 1 },
      { turnDeg: -20, raise: 0, closer: 1 }
    ])
  })

  it('keeps a fight-line shot on its side, an OTS on its shoulder, and lenses ≥ 12 mm', () => {
    expect(viewVariants({ lens: 35, maxTurnDeg: 60 }).every((v) => Math.abs(v.turnDeg) <= 60)).toBe(true)
    const ots = viewVariants({ lens: 50, turns: false, closer: false })
    expect(ots.every((v) => v.turnDeg === 0 && v.closer === 1)).toBe(true)
    expect(ots.map((v) => v.raise)).toEqual([0, 0.5, 1, 1.5, 2.5])
    expect(viewVariants({ lens: 18 }).every((v) => 18 * v.closer >= 12 - 1e-9)).toBe(true)
  })

  it('moves a fixed camera round, in and up about the look point', () => {
    const cam = { x: 0, y: 1.6, z: 5 }
    const look = { x: 0, y: 1.6, z: 0 }
    const right = variantPosition(cam, look, { turnDeg: 90, raise: 0, closer: 1 })
    // Positive turns move the camera to its own right (+X when it looks along −Z).
    expect(right.x).toBeCloseTo(5, 9)
    expect(right.z).toBeCloseTo(0, 9)
    const near = variantPosition(cam, look, { turnDeg: 0, raise: 0.5, closer: 0.5 })
    expect(near).toEqual({ x: 0, y: 2.1, z: 2.5 })
  })

  it('takes the cheapest clear variant, else the best and says it is not clear', () => {
    const ok: ViewCheck = { inside: null, visible: 1, blocker: null }
    const bad: ViewCheck = { inside: null, visible: 0, blocker: 'a wall' }
    const vs = viewVariants({ lens: 35 })
    const clearAt = (target: ViewVariant) => (v: ViewVariant): ViewCheck[] =>
      [v.raise >= target.raise && v.closer <= target.closer && v.turnDeg === target.turnDeg ? ok : bad]
    const pick = chooseView(clearAt({ turnDeg: 0, raise: 1, closer: 0.85 }), vs)
    expect(pick.clear).toBe(true)
    expect(pick.variant).toEqual({ turnDeg: 0, raise: 1, closer: 0.85 })
    expect(pick.blocker).toBe('a wall')
    const none = chooseView(() => [bad], vs)
    expect(none.clear).toBe(false)
    expect(none.variant).toEqual({ turnDeg: 0, raise: 0, closer: 1 })
  })

  it('stays near the previous choice, easing back toward the asked-for view', () => {
    const ok: ViewCheck = { inside: null, visible: 1, blocker: null }
    const bad: ViewCheck = { inside: null, visible: 0, blocker: 'x' }
    const vs = viewVariants({ lens: 35 })
    const check = (v: ViewVariant): ViewCheck[] => [v.turnDeg === 0 && v.raise === 0 && v.closer === 1 ? bad : ok]
    expect(chooseView(check, vs).variant).toEqual({ turnDeg: 0, raise: 0, closer: 0.85 })
    expect(chooseView(check, vs, { turnDeg: -40, raise: 0, closer: 1 }).variant).toEqual({ turnDeg: -20, raise: 0, closer: 1 })
    expect(chooseView(() => [ok], vs, { turnDeg: -20, raise: 0, closer: 1 }).variant).toEqual({ turnDeg: 0, raise: 0, closer: 1 })
  })

  it('describes what it changed', () => {
    expect(describeView({ turnDeg: 0, raise: 0.5, closer: 0.7 }, 35)).toBe('30% closer on a 25 mm lens, 0.5 m higher')
    expect(describeView({ turnDeg: -40, raise: 0, closer: 1 }, 35)).toBe("swung 40° to the camera's left")
  })
})

describe('shot words with a view', () => {
  const b = person('b', 0, 0, 0)
  const single: ShotSpec = { size: 'MS', subjectIds: ['b'], side: 'front' }

  it('no view, or a zero view, leaves the solve exactly as asked', () => {
    const plain = solveShot(single, [b], SETUP)
    expect(solveShot({ ...single, view: { turnDeg: 0, raise: 0, closer: 1 } }, [b], SETUP)).toEqual(plain)
  })

  it('swings, raises and moves in on a wider lens', () => {
    const plain = solveShot(single, [b], SETUP)
    const d0 = Math.hypot(plain.position.x, plain.position.z)
    const turned = solveShot({ ...single, view: { turnDeg: 90 } }, [b], SETUP)
    expect(Math.hypot(turned.position.x, turned.position.z)).toBeCloseTo(d0, 6)
    // Front of a subject facing −Z is −Z; swung 90° to the camera's right is −X.
    expect(turned.position.x).toBeCloseTo(-d0, 6)
    const raised = solveShot({ ...single, view: { raise: 1 } }, [b], SETUP)
    expect(raised.position.y).toBeCloseTo(plain.position.y + 1, 6)
    expect(raised.tilt).toBeLessThan(0)
    const closer = solveShot({ ...single, view: { closer: 0.5 } }, [b], SETUP)
    expect(closer.focalLength).toBeCloseTo(17.5, 6)
    expect(Math.hypot(closer.position.x, closer.position.z)).toBeCloseTo(d0 * 0.5, 6)
  })

  it('an over-the-shoulder view only rises', () => {
    const a = person('a', 0, 1.2, Math.PI)
    const spec: ShotSpec = { size: 'MCU', subjectIds: ['b'], over: { entityId: 'a', shoulder: 'right' } }
    const plain = solveShot(spec, [a, b], SETUP)
    const raised = solveShot({ ...spec, view: { raise: 0.5, turnDeg: 90, closer: 0.5 } }, [a, b], SETUP)
    // As high as the shoulder composition allows (like a high angle).
    expect(raised.position.y).toBeGreaterThan(plain.position.y + 0.2)
    expect(raised.focalLength).toBeGreaterThan(plain.focalLength * 0.8)
  })
})
