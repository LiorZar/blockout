import { describe, expect, it } from 'vitest'
import { STRIKE_IDS } from '@engine/fight/moves'
import { formatFightScript, parseFightScript, randomFightScript } from '@engine/fight/script'
import { createProject, parseProject, serializeProject } from '@engine/schema'
import type { FightBeat } from '@engine/types'

const LABELS: [string, string] = ['A', 'B']

const EXAMPLE = `A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1`

const beatsOf = (text: string, labels: [string, string] = LABELS): FightBeat[] => {
  const r = parseFightScript(text, labels)
  if ('error' in r) throw new Error(`line ${r.line}: ${r.error}`)
  return r.beats
}

describe('parseFightScript', () => {
  it('parses the Design example into 4 beats', () => {
    expect(beatsOf(EXAMPLE)).toEqual([
      { attacker: 0, move: 'jab-cross', target: 'head', outcomes: ['block', 'hit'], power: 0.7 },
      { attacker: 1, move: 'hook-punch', target: 'body', outcomes: ['hit'], power: 0.9 },
      { attacker: 0, move: 'front-kick', target: 'body', outcomes: ['parry'], power: 0.7 },
      { attacker: 1, move: 'roundhouse-kick', target: 'head', outcomes: ['ko'], power: 1 }
    ])
  })

  it('accepts ids, names, labels, ";" separators, defaults and timing', () => {
    const beats = beatsOf('Rocky jab-cross; Drago Front Kick at 2.5s\n\n# a comment\nrocky sweep -> miss power 3 at 4', ['Rocky', 'Drago'])
    expect(beats).toEqual([
      { attacker: 0, move: 'jab-cross', target: 'head', outcomes: ['hit'], power: 0.7 },
      { attacker: 1, move: 'front-kick', target: 'body', outcomes: ['hit'], power: 0.7, at: 2.5 },
      { attacker: 0, move: 'low-sweep', target: 'legs', outcomes: ['miss'], power: 1, at: 4 }
    ])
    expect(beatsOf('b Jab / Cross to body -> slip, duck')[0]).toEqual({
      attacker: 1,
      move: 'jab-cross',
      target: 'body',
      outcomes: ['slip', 'duck'],
      power: 0.7
    })
  })

  it("'A moonwalk to head' gives an error at line 1 that names the move", () => {
    const r = parseFightScript('A moonwalk to head', LABELS)
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.line).toBe(1)
      expect(r.error).toContain('moonwalk')
    }
  })

  it('reports the line of a bad fighter, target or outcome', () => {
    const who = parseFightScript('A jab\nC jab', LABELS)
    expect('error' in who && who.line).toBe(2)
    const tgt = parseFightScript('A jab to toes', LABELS)
    expect('error' in tgt && tgt.error).toContain('toes')
    const out = parseFightScript('A jab\nB hook\nA jab -> explode', LABELS)
    expect('error' in out && out.line).toBe(3)
    expect('error' in out && out.error).toContain('explode')
  })
})

describe('formatFightScript', () => {
  it('format → parse round-trips 3 random scripts', () => {
    for (const [seed, style] of [
      [1, 'brawl'],
      [2, 'martial-arts'],
      [3, 'sparring']
    ] as const) {
      const beats = randomFightScript(seed, style, 12, { ending: 'ko' })
      expect(beats.length).toBeGreaterThan(2)
      expect(beatsOf(formatFightScript(beats, LABELS))).toEqual(beats)
    }
    const timed: FightBeat[] = [{ attacker: 1, move: 'uppercut', target: 'head', outcomes: ['hit'], power: 0.45, at: 1.25 }]
    expect(beatsOf(formatFightScript(timed, ['Rocky', 'Drago']), ['Rocky', 'Drago'])).toEqual(timed)
  })
})

describe('randomFightScript', () => {
  it('is deterministic per seed, differs across seeds, and ends in ko when asked', () => {
    const a = randomFightScript(7, 'martial-arts', 10, { ending: 'ko' })
    expect(randomFightScript(7, 'martial-arts', 10, { ending: 'ko' })).toEqual(a)
    expect(randomFightScript(8, 'martial-arts', 10, { ending: 'ko' })).not.toEqual(a)
    expect(a[a.length - 1]!.outcomes[a[a.length - 1]!.outcomes.length - 1]).toBe('ko')
    const standing = randomFightScript(7, 'brawl', 10, { ending: 'standing' })
    expect(standing.flatMap((b) => b.outcomes)).not.toContain('ko')
  })

  it('draws moves from the style pools and alternates attackers', () => {
    const pools = {
      brawl: ['haymaker', 'hook-punch', 'jab-cross', 'elbow-strike', 'shove-two-hands'],
      'martial-arts': ['front-kick', 'side-kick', 'roundhouse-kick', 'knee-strike', 'low-sweep', 'spinning-back-kick'],
      sparring: ['jab-cross', 'hook-punch', 'front-kick', 'uppercut']
    } as const
    for (const style of Object.keys(pools) as (keyof typeof pools)[]) {
      const beats = randomFightScript(11, style, 20)
      for (const b of beats) {
        expect(pools[style] as readonly string[]).toContain(b.move)
        expect(STRIKE_IDS).toContain(b.move)
        expect(b.power).toBeGreaterThanOrEqual(0.2)
        expect(b.power).toBeLessThanOrEqual(1)
      }
      expect(new Set(beats.map((b) => b.attacker)).size).toBe(2)
    }
  })

  it('defends more early and hits more late', () => {
    let early = 0
    let earlyN = 0
    let late = 0
    let lateN = 0
    for (let seed = 1; seed <= 30; seed++) {
      const beats = randomFightScript(seed, 'sparring', 20)
      beats.forEach((b, i) => {
        const defended = b.outcomes.filter((o) => o !== 'hit').length
        if (i < beats.length / 2) {
          early += defended
          earlyN += b.outcomes.length
        } else {
          late += defended
          lateN += b.outcomes.length
        }
      })
    }
    expect(early / earlyN).toBeGreaterThan(late / lateN)
    expect(early / earlyN).toBeGreaterThan(0.3)
  })
})

describe('scene.fights migration', () => {
  it('parseProject of a v1 doc without fights gives [], and junk gives []', () => {
    const doc = createProject('Fights')
    const raw = JSON.parse(serializeProject(doc))
    delete raw.scenes[0].fights
    expect(parseProject(JSON.stringify(raw)).doc!.scenes[0]!.fights).toEqual([])
    raw.scenes[0].fights = 'junk'
    expect(parseProject(JSON.stringify(raw)).doc!.scenes[0]!.fights).toEqual([])
    delete raw.scenes[0].scans
    raw.scenes[0].fights = 7
    const both = parseProject(JSON.stringify(raw)).doc!.scenes[0]!
    expect(both.fights).toEqual([])
    expect(both.scans).toEqual([])
  })

  it('keeps well-formed fights through a round trip', () => {
    const doc = createProject('Fights')
    doc.scenes[0]!.fights = [
      {
        id: 'fight_1',
        name: 'Fight 1',
        fighterIds: ['ent_a', 'ent_b'],
        beats: [{ attacker: 0, move: 'jab-cross', target: 'head', outcomes: ['hit'], power: 0.7 }],
        startT: 0.4,
        origin: { x: 0, z: 0, heading: 0 },
        beatGap: 0.35,
        exaggeration: 1.5
      }
    ]
    const back = parseProject(serializeProject(doc)).doc!
    expect(back.scenes[0]!.fights).toEqual(doc.scenes[0]!.fights)
  })
})
