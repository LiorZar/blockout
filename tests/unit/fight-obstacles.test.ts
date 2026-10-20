// Fork test (gap 8, docs/plans/2026-10-19-fix-fight.md): fights keep clear of set props.
import { describe, expect, it } from 'vitest'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import { BODY_RADIUS, clearRun, clearShift, pathCrossings, type FightObstacle } from '@engine/fight/obstacles'
import { parseFightScript } from '@engine/fight/script'
import type { FightDoc } from '@engine/types'

const SHOT = { duration: 10, fps: 24 }

function fight(script: string): FightDoc {
  const parsed = parseFightScript(script, ['A', 'B'])
  if ('error' in parsed) throw new Error(parsed.error)
  return { id: 'f', name: 'F', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 }
}

const fighters = (ax: number, bx: number): [FighterInput, FighterInput] => [
  { entityId: 'a', assetId: 'person.man', scale: 1, start: { x: ax, y: 0, z: 0 } },
  { entityId: 'b', assetId: 'person.woman', scale: 1, start: { x: bx, y: 0, z: 0 } }
]

const box = (x: number, z: number, hx: number, hz: number, name = 'Bench'): FightObstacle => ({ entityId: 'prop', name, x, z, hx, hz, heading: 0 })

describe('obstacle geometry', () => {
  it('clearRun stops a body at a box and lets it step away from one it touches', () => {
    const b = box(1, 0, 0.2, 0.6)
    const ahead = clearRun({ x: 0, z: 0 }, { x: 1, z: 0 }, 2, BODY_RADIUS, [b])
    expect(ahead.hit).toBe(b)
    expect(ahead.run).toBeCloseTo(1 - 0.2 - BODY_RADIUS, 6)
    expect(clearRun({ x: 0.7, z: 0 }, { x: -1, z: 0 }, 1, BODY_RADIUS, [b]).hit).toBeNull()
    expect(clearRun({ x: 0, z: 0 }, { x: 0, z: 1 }, 2, BODY_RADIUS, [b]).hit).toBeNull()
  })

  it('a rotated box blocks along its own axes', () => {
    const b: FightObstacle = { ...box(0, 2, 0.2, 1), heading: Math.PI / 2 }
    // Rotated a quarter turn its long side runs along X, so a walk along x at z = 2 meets it at once.
    expect(clearRun({ x: -3, z: 2 }, { x: 1, z: 0 }, 4, BODY_RADIUS, [b]).run).toBeCloseTo(3 - 1 - BODY_RADIUS, 6)
  })
})

describe('solveFight with set props (gap 8)', () => {
  const KO = 'A roundhouse to head -> ko power 1'

  it('a knockdown slide stops at a bench behind the defender, with a warning', () => {
    const free = solveFight(fight(KO), fighters(-0.55, 0.55), SHOT, { paths: true })
    const lastB = free.tracks[1].at(-1)!.position.x
    expect(lastB).toBeGreaterThan(0.9)
    // A bench across the fall line, just short of where the slide ends.
    const bench = box(lastB + 0.1, 0, 0.2, 0.6)
    expect(pathCrossings(free.paths, [bench]).some((c) => c.fighter === 1)).toBe(true)
    const solved = solveFight(fight(KO), fighters(-0.55, 0.55), SHOT, { obstacles: [bench] })
    expect(solved.report.warnings.some((w) => w.includes('stopped at Bench'))).toBe(true)
    expect(pathCrossings(solved.paths, [bench]).filter((c) => c.fighter === 1)).toEqual([])
    // The blow still lands.
    expect(solved.report.beats[0]!.contactErrorM[0]).toBeLessThanOrEqual(0.03)
  })

  it('warns when a solved path still runs into a prop', () => {
    // A post on A's way in.
    const post = box(-1.2, 0, 0.05, 0.05, 'Post')
    const solved = solveFight(fight('A jab cross to head -> block, hit'), fighters(-2.5, 0.55), SHOT, { obstacles: [post] })
    expect(solved.report.warnings.some((w) => /A runs into Post at \d/.test(w))).toBe(true)
  })

  it('is deterministic and leaves a clear fight unchanged', () => {
    const far = box(20, 20, 1, 1)
    const a = solveFight(fight(KO), fighters(-0.55, 0.55), SHOT, { obstacles: [far] })
    const b = solveFight(fight(KO), fighters(-0.55, 0.55), SHOT, { obstacles: [far] })
    const none = solveFight(fight(KO), fighters(-0.55, 0.55), SHOT)
    expect(a.tracks).toEqual(b.tracks)
    expect(a.tracks).toEqual(none.tracks)
    expect(a.report.warnings).toEqual(none.report.warnings)
  })

  it('clearShift finds the nearest spot where a fight on top of a bench stays clear', () => {
    const bench = box(0, 0, 0.2, 0.6)
    const free = solveFight(fight(`A jab cross to head -> block, hit\n${KO}`), fighters(-0.55, 0.55), SHOT, { paths: true })
    expect(pathCrossings(free.paths, [bench]).length).toBeGreaterThan(0)
    const shift = clearShift(free.paths, [bench])!
    expect(shift).not.toBeNull()
    expect(Math.hypot(shift.x, shift.z)).toBeLessThanOrEqual(3)
    expect(pathCrossings(free.paths, [bench], shift)).toEqual([])
  })
})
