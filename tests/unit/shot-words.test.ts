import { describe, expect, it } from 'vitest'
import { parseShotWords } from '@engine/shot-words'

const ENTITIES = [
  { id: 'ent_a', name: 'Man', label: 'A' },
  { id: 'ent_b', name: 'Woman', label: 'B' },
  { id: 'ent_h', name: 'Hero' },
  { id: 'ent_c', name: 'Sedan', label: 'Getaway Car' }
]

const ok = (text: string): Exclude<ReturnType<typeof parseShotWords>, { error: string }> => {
  const r = parseShotWords(text, ENTITIES)
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`)
  return r
}

const err = (text: string): string => {
  const r = parseShotWords(text, ENTITIES)
  if (!('error' in r)) throw new Error(`expected an error for: ${text}`)
  return r.error
}

describe('parseShotWords', () => {
  it("'MCU on B, over A's right shoulder, 50mm'", () => {
    const r = ok("MCU on B, over A's right shoulder, 50mm")
    expect(r.spec).toEqual({ size: 'MCU', subjectIds: ['ent_b'], over: { entityId: 'ent_a', shoulder: 'right' }, lens: 50 })
    expect(r.time).toBeUndefined()
  })

  it("'two-shot of A and B, low angle, from the left at 2.5s'", () => {
    const r = ok('two-shot of A and B, low angle, from the left at 2.5s')
    expect(r.spec).toEqual({ size: 'MS', subjectIds: ['ent_a', 'ent_b'], angle: 'low', side: 'left' })
    expect(r.time).toBe(2.5)
  })

  it("'cu on hero dutch 15°'", () => {
    expect(ok('cu on hero dutch 15°').spec).toEqual({ size: 'CU', subjectIds: ['ent_h'], dutchDeg: 15 })
    expect(ok('cu on hero dutch 15').spec.dutchDeg).toBe(15)
  })

  it('understands the rest of the vocabulary', () => {
    expect(ok('extreme wide on getaway car').spec).toEqual({ size: 'EWS', subjectIds: ['ent_c'] })
    expect(ok('Wide shot on A, overhead').spec).toEqual({ size: 'WS', subjectIds: ['ent_a'], angle: 'overhead' })
    expect(ok('full on b from behind').spec).toEqual({ size: 'FS', subjectIds: ['ent_b'], side: 'back' })
    expect(ok('medium close-up on a, 3/4 left').spec).toEqual({ size: 'MCU', subjectIds: ['ent_a'], side: 'frontLeft' })
    expect(ok('close up on a 3/4 right high angle').spec).toEqual({ size: 'CU', subjectIds: ['ent_a'], side: 'frontRight', angle: 'high' })
    expect(ok('extreme close-up on a, profile, eye level').spec).toEqual({ size: 'ECU', subjectIds: ['ent_a'], side: 'right', angle: 'eye' })
    expect(ok('ms on a and b ground level from the front').spec).toEqual({ size: 'MS', subjectIds: ['ent_a', 'ent_b'], angle: 'ground', side: 'front' })
    expect(ok('2s of a & b').spec.subjectIds).toEqual(['ent_a', 'ent_b'])
    expect(ok('WS 2-shot of A and B at 1s').spec).toEqual({ size: 'WS', subjectIds: ['ent_a', 'ent_b'] })
    expect(ok('mcu on b ots a').spec.over).toEqual({ entityId: 'ent_a', shoulder: 'right' })
    expect(ok("mcu on b over a's left shoulder 35 mm").spec).toEqual({
      size: 'MCU',
      subjectIds: ['ent_b'],
      over: { entityId: 'ent_a', shoulder: 'left' },
      lens: 35
    })
    expect(ok('MCU on Man').spec.subjectIds).toEqual(['ent_a'])
  })

  it("'MCU on Z' → an error naming the known labels", () => {
    const e = err('MCU on Z')
    expect(e).toContain('Z')
    for (const known of ['A', 'B', 'Hero', 'Getaway Car']) expect(e).toContain(known)
  })

  it("'mcu on a with sparkles' → an error containing sparkles", () => {
    expect(err('mcu on a with sparkles')).toContain('sparkles')
  })

  it("'mcu on a over a's left shoulder' → an error", () => {
    expect(err("mcu on a over a's left shoulder")).toMatch(/shoulder/i)
  })

  it('rejects ambiguous names, a missing size and a missing subject', () => {
    const twins = [
      { id: 'x1', name: 'Guard' },
      { id: 'x2', name: 'Guard' }
    ]
    const r = parseShotWords('ms on guard', twins)
    expect('error' in r && r.error).toMatch(/guard/i)
    expect(err('on a')).toMatch(/size/i)
    expect(err('mcu 50mm')).toMatch(/subject|on/i)
  })
})
