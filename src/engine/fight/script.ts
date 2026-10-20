/**
 * Fight scripts (fork addition; see MODIFICATIONS.md): the blow-by-blow text
 * Lior edits, one beat per line or per ';':
 *
 *   <who> <move> [to head|body|legs] [-> outcome[, outcome…]] [power p] [at t s]
 *
 * `<who>` is A / B or a fighter label; `<move>` a strike id, name or alias.
 * `randomFightScript` writes a seeded starting script (inline mulberry32 — the
 * only randomness in the fight director, and never on the state(t) path).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { MOTION_PRESETS } from '../motions'
import type { FightBeat, FightOutcome } from '../types'
import { MOVE_ALIASES, SHOT_MOVES, STRIKE_IDS, strikeImpacts } from './moves'

export const DEFAULT_POWER = 0.7

const OUTCOMES: FightOutcome[] = ['hit', 'block', 'parry', 'slip', 'duck', 'miss', 'ko']
const TARGETS = ['head', 'body', 'legs'] as const
const KEYWORDS = new Set(['to', '->', 'power', 'at'])

const norm = (s: string): string => s.toLowerCase().replace(/[-/]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Normalized phrase → strike id, longest phrases first (greedy match). */
const MOVE_LEXICON: [string, string][] = (() => {
  const strikes = new Set([...STRIKE_IDS, ...SHOT_MOVES])
  const out = new Map<string, string>()
  for (const m of MOTION_PRESETS) {
    if (!strikes.has(m.id)) continue
    out.set(norm(m.id), m.id)
    out.set(norm(m.name), m.id)
  }
  for (const [alias, id] of Object.entries(MOVE_ALIASES)) if (strikes.has(id)) out.set(norm(alias), id)
  return [...out.entries()].sort((a, b) => b[0].split(' ').length - a[0].split(' ').length)
})()

/** Kicks and knees go to the body, punches and elbows to the head, the sweep to the legs. */
export function defaultTarget(moveId: string): FightBeat['target'] {
  if (moveId === 'low-sweep') return 'legs'
  if (SHOT_MOVES.has(moveId)) return 'body'
  const first = strikeImpacts(moveId)[0]
  return first && /^(foot|knee)/.test(first.effector) ? 'body' : 'head'
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000)

function whoNames(labels: [string, string]): [string, string] {
  const a = labels[0].trim()
  const b = labels[1].trim()
  if (!a || !b || norm(a) === norm(b)) return ['A', 'B']
  return [a, b]
}

function parseBeat(text: string, labels: [string, string]): FightBeat | string {
  const tokens = text.replace(/->/g, ' -> ').replace(/,/g, ' , ').split(/\s+/).filter(Boolean)
  const low = tokens.map((t) => t.toLowerCase())
  let i = 0

  // Who: a label (possibly several words), then A / B.
  let attacker: 0 | 1 | null = null
  const names = whoNames(labels)
  const candidates: [string, 0 | 1][] = [
    [names[0], 0],
    [names[1], 1],
    ['a', 0],
    ['b', 1]
  ]
  for (const [name, idx] of candidates) {
    const words = norm(name).split(' ')
    if (words.every((w, k) => low[k] === w)) {
      attacker = idx
      i = words.length
      break
    }
  }
  if (attacker === null) return `Unknown fighter "${tokens[0] ?? ''}" — use A, B, ${names[0]} or ${names[1]}`

  // Move: the longest phrase naming a strike.
  let move: string | null = null
  for (let j = Math.min(tokens.length, i + 5); j > i && !move; j--) {
    const phrase = norm(tokens.slice(i, j).join(' '))
    const hit = MOVE_LEXICON.find(([p]) => p === phrase)
    if (hit) {
      move = hit[1]
      i = j
    }
  }
  if (!move) {
    let j = i
    while (j < tokens.length && !KEYWORDS.has(low[j]!)) j++
    const said = tokens.slice(i, j).join(' ') || '(nothing)'
    return `Unknown move "${said}" — list_fight_moves shows the moves`
  }

  let target: FightBeat['target'] | undefined
  let outcomes: FightOutcome[] | undefined
  let power: number | undefined
  let at: number | undefined
  while (i < tokens.length) {
    const w = low[i]!
    if (w === 'to') {
      const t = low[i + 1]
      if (!t || !(TARGETS as readonly string[]).includes(t)) return `Unknown target "${tokens[i + 1] ?? ''}" — use head, body or legs`
      target = t as FightBeat['target']
      i += 2
      continue
    }
    if (w === '->') {
      outcomes = []
      i++
      while (i < tokens.length && !KEYWORDS.has(low[i]!)) {
        if (low[i] !== ',') {
          if (!(OUTCOMES as string[]).includes(low[i]!)) return `Unknown outcome "${tokens[i]}" — use ${OUTCOMES.join(', ')}`
          outcomes.push(low[i] as FightOutcome)
        }
        i++
      }
      if (outcomes.length === 0) return 'Missing outcome after "->"'
      continue
    }
    if (w === 'power') {
      const p = Number(low[i + 1])
      if (!Number.isFinite(p)) return `"power" needs a number, got "${tokens[i + 1] ?? ''}"`
      power = Math.min(1, Math.max(0.2, p))
      i += 2
      continue
    }
    if (w === 'at') {
      const m = /^(\d+(?:\.\d+)?)s?$/.exec(low[i + 1] ?? '')
      if (!m) return `"at" needs a time like 2.5s, got "${tokens[i + 1] ?? ''}"`
      at = Number(m[1])
      i += low[i + 2] === 's' ? 3 : 2
      continue
    }
    return `Didn't understand "${tokens[i]}"`
  }

  const beat: FightBeat = {
    attacker,
    move,
    target: target ?? defaultTarget(move),
    outcomes: outcomes ?? ['hit'],
    power: power ?? DEFAULT_POWER
  }
  if (at !== undefined) beat.at = at
  return beat
}

export function parseFightScript(
  text: string,
  fighterLabels: [string, string]
): { beats: FightBeat[] } | { error: string; line: number } {
  const beats: FightBeat[] = []
  const lines = text.split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.replace(/#.*$/, '')
    for (const part of line.split(';')) {
      if (!part.trim()) continue
      const r = parseBeat(part.trim(), fighterLabels)
      if (typeof r === 'string') return { error: `Line ${n + 1}: ${r}`, line: n + 1 }
      beats.push(r)
    }
  }
  return { beats }
}

export function formatFightScript(beats: FightBeat[], fighterLabels: [string, string]): string {
  const names = whoNames(fighterLabels)
  return beats
    .map((b) => {
      // A shot plays the held gun's or bow's own aim, whichever shot was named: echo the neutral word.
      const parts = [names[b.attacker], SHOT_MOVES.has(b.move) ? 'shoot' : b.move, 'to', b.target, '->', b.outcomes.join(', ')]
      if (b.power !== DEFAULT_POWER) parts.push('power', fmt(b.power))
      if (b.at !== undefined) parts.push('at', `${fmt(b.at)}s`)
      return parts.join(' ')
    })
    .join('\n')
}

/* ------------------------------ random script ----------------------------- */

/** mulberry32 — tiny, fast, fully deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOLS: Record<'brawl' | 'martial-arts' | 'sparring', string[]> = {
  brawl: ['haymaker', 'hook-punch', 'jab-cross', 'elbow-strike', 'shove-two-hands'],
  'martial-arts': ['front-kick', 'side-kick', 'roundhouse-kick', 'knee-strike', 'low-sweep', 'spinning-back-kick'],
  sparring: ['jab-cross', 'hook-punch', 'front-kick', 'uppercut']
}

const DEFENSE_PICKS: FightOutcome[] = ['block', 'parry', 'slip']
const DURATION = new Map(MOTION_PRESETS.map((m) => [m.id, m.duration]))

export function randomFightScript(
  seed: number,
  style: 'brawl' | 'martial-arts' | 'sparring',
  durationS: number,
  opts?: { ending: 'ko' | 'standing' }
): FightBeat[] {
  const rng = mulberry32(seed)
  const strikes = new Set(STRIKE_IDS)
  const pool = POOLS[style].filter((id) => strikes.has(id))
  if (pool.length === 0) return []
  const beats: FightBeat[] = []
  const end = durationS - 0.6
  let t = 0.4
  let attacker: 0 | 1 = rng() < 0.5 ? 0 : 1
  while (beats.length < 40) {
    const move = pool[Math.floor(rng() * pool.length) % pool.length]!
    const dur = DURATION.get(move) ?? 1
    if (beats.length > 0 && t + dur > end) break
    // Mostly defended early, mostly landing late.
    const f = Math.min(1, t / Math.max(durationS, 1e-6))
    const pDefend = 0.55 - 0.45 * f
    const outcomes = strikeImpacts(move).map((): FightOutcome =>
      rng() < pDefend ? DEFENSE_PICKS[Math.floor(rng() * DEFENSE_PICKS.length) % DEFENSE_PICKS.length]! : 'hit'
    )
    const base = defaultTarget(move)
    const target: FightBeat['target'] = base !== 'legs' && rng() < 0.2 ? (base === 'head' ? 'body' : 'head') : base
    const power = Math.round((0.5 + 0.4 * rng()) * 20) / 20
    beats.push({ attacker, move, target, outcomes: outcomes.length > 0 ? outcomes : ['hit'], power })
    t += 0.35 + dur + 0.35
    if (rng() < 0.75) attacker = attacker === 0 ? 1 : 0
  }
  if (opts?.ending === 'ko' && beats.length > 0) {
    const last = beats[beats.length - 1]!
    last.outcomes = last.outcomes.map((_, k, all): FightOutcome => (k === all.length - 1 ? 'ko' : 'hit'))
    last.power = 1
  }
  return beats
}
