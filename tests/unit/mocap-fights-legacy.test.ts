// Fork addition (2026): the Fight Director on mocap bots leaves every other body as it was — procedural people, the studio mannequins and unloaded bots solve exactly as before phase 3; see MODIFICATIONS.md.
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { parseFightScript } from '@engine/fight/script'
import { solveFight, type FighterInput } from '@engine/fight/solve'
import type { FightDoc } from '@engine/types'

const SCRIPTS: Record<string, string> = {
  punches: 'A jab cross to head -> hit, hit power 0.7\nB uppercut to head -> hit power 0.8\nA haymaker to head -> hit power 0.8\nB hook to head -> hit power 0.8\nA spinning-backfist to head -> block power 0.8\nB spinning-back-fist to head -> ko power 1',
  kicks: 'A front kick to body -> hit power 1\nB side kick to body -> hit power 1\nA teep-push-kick to body -> hit power 1',
  grapples: 'A shove to body -> hit power 1\nB tackle to body -> hit power 1\nA grapple-shove to body -> hit power 1\nB takedown-lunge to body -> hit power 1',
  weapons: 'A slash to head -> parry, hit power 1\nB swing to body -> block, hit power 1\nA thrust to body -> hit power 1'
}

/** Each solution's tracks and report, hashed, as the solver gave them before phase 3 (commit ea6ad37). */
const BEFORE: Record<string, string> = {
  'punches|person.man': '11ee776108c0d2a6',
  'punches|person.mannequinMale': '36a6d5ef5829667f',
  'punches|person.mocapMale': '36a6d5ef5829667f',
  'kicks|person.man': 'b16ac36452862a1b',
  'kicks|person.mannequinMale': 'f32e34dfba13a33e',
  'kicks|person.mocapMale': 'f32e34dfba13a33e',
  'grapples|person.man': '919d50d39ec63fe1',
  'grapples|person.mannequinMale': '96a8d15ff88c0dd1',
  'grapples|person.mocapMale': '96a8d15ff88c0dd1',
  'weapons|person.man': '87a0c59e8294ec1d',
  'weapons|person.mannequinMale': '047a57a6d4e6ee88',
  'weapons|person.mocapMale': '047a57a6d4e6ee88'
}

const PAIRS: [string, string][] = [
  ['person.man', 'person.woman'],
  ['person.mannequinMale', 'person.mannequinFemale'],
  // No library registered: the bots stand in as the mannequins.
  ['person.mocapMale', 'person.mocapFemale']
]

describe('fights on every body but a loaded bot are unchanged', { timeout: 30_000 }, () => {
  it('procedural people, studio mannequins and unloaded bots solve exactly as before', () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      for (const pair of PAIRS) {
        const parsed = parseFightScript(script, ['A', 'B'])
        if (!('beats' in parsed)) throw new Error(parsed.error)
        const fight = { id: 'f', name: 'f', fighterIds: ['a', 'b'], beats: parsed.beats, startT: 0.4, origin: { x: 0, z: 0, heading: 0 }, beatGap: 0.35, exaggeration: 1.5 } as unknown as FightDoc
        const armed = name === 'weapons'
        const f = (id: string, assetId: string, x: number, weapon: string): FighterInput => ({
          entityId: id,
          assetId,
          scale: 1,
          start: { x, y: 0, z: 0 },
          ...(armed ? { weapons: [{ assetId: weapon, hand: 'R' as const, scale: 1 }] } : {})
        })
        const sol = solveFight(fight, [f('a', pair[0], -0.55, 'prop.sword'), f('b', pair[1], 0.55, 'prop.baseballBat')], { duration: 20, fps: 24 })
        const hash = createHash('sha256').update(JSON.stringify({ tracks: sol.tracks, report: sol.report })).digest('hex').slice(0, 16)
        expect(hash, `${name} ${pair[0]}`).toBe(BEFORE[`${name}|${pair[0]}`])
      }
    }
  })
})
