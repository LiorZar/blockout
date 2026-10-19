/**
 * Shot words parser (fork addition; see MODIFICATIONS.md):
 * "MCU on B, over A's right shoulder, 50mm" → a ShotSpec.
 *
 * Case-insensitive, a small tokenizer plus a greedy phrase matcher. Every
 * word must be understood; otherwise the error lists the words it didn't
 * understand. Names match an entity's label first, then its name.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { ShotAngle, ShotSide, ShotSpec } from './shot'
import type { ShotSizeId } from './types'

export interface ShotWordsEntity {
  id: string
  name: string
  label?: string
}

type Phrase<T> = [string[], T]

const SIZES: Phrase<ShotSizeId>[] = [
  [['extreme', 'close-up'], 'ECU'],
  [['extreme', 'close', 'up'], 'ECU'],
  [['extreme', 'closeup'], 'ECU'],
  [['extreme', 'wide'], 'EWS'],
  [['medium', 'close-up'], 'MCU'],
  [['medium', 'close', 'up'], 'MCU'],
  [['medium', 'closeup'], 'MCU'],
  [['close-up'], 'CU'],
  [['close', 'up'], 'CU'],
  [['closeup'], 'CU'],
  [['ews'], 'EWS'],
  [['ws'], 'WS'],
  [['wide'], 'WS'],
  [['fs'], 'FS'],
  [['full'], 'FS'],
  [['ms'], 'MS'],
  [['medium'], 'MS'],
  [['mcu'], 'MCU'],
  [['cu'], 'CU'],
  [['ecu'], 'ECU']
]

const GROUPS: string[][] = [['two-shot'], ['2-shot'], ['2s'], ['two', 'shot']]

const ANGLES: Phrase<ShotAngle>[] = [
  [['eye', 'level'], 'eye'],
  [['eye-level'], 'eye'],
  [['low', 'angle'], 'low'],
  [['low-angle'], 'low'],
  [['high', 'angle'], 'high'],
  [['high-angle'], 'high'],
  [['ground', 'level'], 'ground'],
  [['ground-level'], 'ground'],
  [['overhead'], 'overhead']
]

const SIDES: Phrase<ShotSide>[] = [
  [['from', 'the', 'front'], 'front'],
  [['from', 'the', 'back'], 'back'],
  [['from', 'the', 'left'], 'left'],
  [['from', 'the', 'right'], 'right'],
  [['from', 'front'], 'front'],
  [['from', 'behind'], 'back'],
  [['from', 'back'], 'back'],
  [['from', 'left'], 'left'],
  [['from', 'right'], 'right'],
  [['3/4', 'left'], 'frontLeft'],
  [['3/4', 'right'], 'frontRight'],
  [['profile'], 'right']
]

const FILLERS = new Set([',', 'shot', 'the'])
const NUM = /^\d+(?:\.\d+)?$/

const normalizeName = (s: string): string => s.toLowerCase().split(/\s+/).filter(Boolean).join(' ')

export function parseShotWords(
  text: string,
  entities: ShotWordsEntity[]
): { spec: ShotSpec; time?: number } | { error: string } {
  const raw = text
    .replace(/[’‘]/g, "'")
    .replace(/°/g, ' ')
    .replace(/,/g, ' , ')
    .replace(/&/g, ' and ')
    .split(/\s+/)
    .filter(Boolean)
  const low = raw.map((w) => w.toLowerCase())
  const known = entities.map((e) => e.label || e.name).join(', ')

  const phraseAt = <T>(i: number, phrases: Phrase<T>[]): [T, number] | null => {
    for (const [words, value] of phrases) {
      if (words.every((w, k) => low[i + k] === w)) return [value, words.length]
    }
    return null
  }

  /** Longest run of words at i naming one entity (label first, then name); "'s" allowed on the last word. */
  const nameAt = (i: number): { id: string; len: number } | { error: string } | null => {
    for (let len = Math.min(4, low.length - i); len >= 1; len--) {
      const words = low.slice(i, i + len)
      words[len - 1] = words[len - 1]!.replace(/'s?$/, '')
      const key = words.join(' ')
      for (const field of ['label', 'name'] as const) {
        const hits = entities.filter((e) => e[field] !== undefined && normalizeName(e[field]!) === key)
        if (hits.length === 1) return { id: hits[0]!.id, len }
        if (hits.length > 1) return { error: `"${raw.slice(i, i + len).join(' ')}" matches more than one entity — known: ${known}` }
      }
    }
    return null
  }

  const expectName = (i: number): { id: string; len: number } | { error: string } => {
    if (i >= low.length) return { error: `Missing a name at the end — known: ${known}` }
    const hit = nameAt(i)
    return hit ?? { error: `Unknown name "${raw[i]!.replace(/'s?$/, '')}" — known: ${known}` }
  }

  /** "X", "X and Y", "X, Y and Z". */
  const nameList = (i: number): { ids: string[]; next: number } | { error: string } => {
    const first = expectName(i)
    if ('error' in first) return first
    const ids = [first.id]
    let j = i + first.len
    while (j < low.length && (low[j] === 'and' || low[j] === ',')) {
      const more = nameAt(j + 1)
      if (!more || 'error' in more) break
      ids.push(more.id)
      j += 1 + more.len
    }
    return { ids, next: j }
  }

  let size: ShotSizeId | undefined
  let group = false
  let subjectIds: string[] = []
  let over: ShotSpec['over']
  let side: ShotSide | undefined
  let angle: ShotAngle | undefined
  let lens: number | undefined
  let dutchDeg: number | undefined
  let time: number | undefined
  const unknown: string[] = []

  let i = 0
  while (i < low.length) {
    const w = low[i]!
    const sz = phraseAt(i, SIZES)
    if (sz) {
      size = sz[0]
      i += sz[1]
      continue
    }
    const grp = GROUPS.find((words) => words.every((x, k) => low[i + k] === x))
    if (grp) {
      group = true
      i += grp.length
      if (low[i] === 'of') {
        const list = nameList(i + 1)
        if ('error' in list) return list
        subjectIds = list.ids
        i = list.next
      }
      continue
    }
    if (FILLERS.has(w)) {
      i++
      continue
    }
    if (w === 'on') {
      const list = nameList(i + 1)
      if ('error' in list) return list
      subjectIds = list.ids
      i = list.next
      continue
    }
    if (w === 'over' || w === 'ots') {
      const who = expectName(i + 1)
      if ('error' in who) return who
      i += 1 + who.len
      let shoulder: 'left' | 'right' = 'right'
      if (low[i] === 'left' || low[i] === 'right') {
        shoulder = low[i] as 'left' | 'right'
        i++
      }
      if (low[i] === 'shoulder') i++
      over = { entityId: who.id, shoulder }
      continue
    }
    const ang = phraseAt(i, ANGLES)
    if (ang) {
      angle = ang[0]
      i += ang[1]
      continue
    }
    const sd = phraseAt(i, SIDES)
    if (sd) {
      side = sd[0]
      i += sd[1]
      continue
    }
    const mm = /^(\d+(?:\.\d+)?)mm$/.exec(w)
    if (mm) {
      lens = Number(mm[1])
      i++
      continue
    }
    if (NUM.test(w) && low[i + 1] === 'mm') {
      lens = Number(w)
      i += 2
      continue
    }
    if (w === 'dutch' && i + 1 < low.length && /^-?\d+(?:\.\d+)?$/.test(low[i + 1]!)) {
      dutchDeg = Number(low[i + 1])
      i += 2
      continue
    }
    if (w === 'at') {
      const ts = /^(\d+(?:\.\d+)?)s$/.exec(low[i + 1] ?? '')
      if (ts) {
        time = Number(ts[1])
        i += 2
        continue
      }
      if (NUM.test(low[i + 1] ?? '') && low[i + 2] === 's') {
        time = Number(low[i + 1])
        i += 3
        continue
      }
    }
    unknown.push(raw[i]!)
    i++
  }

  if (unknown.length > 0) return { error: `Didn't understand: ${unknown.join(', ')}` }
  if (!size && group) size = 'MS'
  if (!size) return { error: 'No shot size — use EWS, WS, FS, MS, MCU, CU or ECU' }
  if (subjectIds.length === 0) return { error: `No subject — say "on <name>" (known: ${known})` }
  if (over && subjectIds.includes(over.entityId)) {
    const e = entities.find((x) => x.id === over!.entityId)
    const n = e?.label || e?.name || over.entityId
    return { error: `Can't shoot over ${n}'s shoulder when ${n} is the subject` }
  }

  const spec: ShotSpec = { size, subjectIds }
  if (over) spec.over = over
  if (side) spec.side = side
  if (angle) spec.angle = angle
  if (lens !== undefined) spec.lens = lens
  if (dutchDeg !== undefined) spec.dutchDeg = dutchDeg
  return time !== undefined ? { spec, time } : { spec }
}
