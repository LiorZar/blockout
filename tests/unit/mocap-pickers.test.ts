// Fork addition (2026): which bodies the pickers offer, and routines cast on the chosen bodies; see MODIFICATIONS.md.
import { afterAll, describe, expect, it } from 'vitest'
import { buildRoutine } from '@engine/choreography'
import { bodyLowY, motionRootY } from '@engine/floor'
import { clearMocapBodies } from '@engine/mocap/registry'
import { assetListed, bodySets, registerMocapTemplate } from '@renderer/mocap/library'
import { fixtureCharacter } from './mocap-three-fixture'

afterAll(() => clearMocapBodies())

describe('mocap bots in the pickers', () => {
  it('are hidden until the library has loaded, then offered and preferred', () => {
    expect(assetListed('person.mocapMale')).toBe(false)
    expect(assetListed('person.man')).toBe(true)
    expect(bodySets(false).sets.map((b) => b.id)).toEqual(['classic', 'mannequin'])
    expect(bodySets(false).preferred).toBe('classic')
    registerMocapTemplate('person.mocapMale', fixtureCharacter())
    registerMocapTemplate('person.mocapFemale', fixtureCharacter(0.93))
    expect(assetListed('person.mocapMale')).toBe(true)
    expect(assetListed('person.mocapFemale')).toBe(true)
    expect(bodySets(true).sets.map((b) => b.id)).toEqual(['classic', 'mannequin', 'mocap'])
    expect(bodySets(true).preferred).toBe('mocap')
  })

  it('a routine with bodies casts them for its men and women and grounds their posed marks on them', () => {
    const bodies: [string, string] = ['person.mocapMale', 'person.mocapFemale']
    const specs = buildRoutine({ kind: 'dance', performers: 4, durationS: 8, seed: 11, style: 'hiphop', bodies }, { origin: { x: 0, z: 0, heading: 0 } })
    expect(specs.map((e) => e.assetId)).toEqual(['person.mocapMale', 'person.mocapFemale', 'person.mocapMale', 'person.mocapFemale'])
    const plain = buildRoutine({ kind: 'dance', performers: 4, durationS: 8, seed: 11, style: 'hiphop' }, { origin: { x: 0, z: 0, heading: 0 } })
    expect(plain.map((e) => e.assetId)).toEqual(['person.man', 'person.woman', 'person.man', 'person.woman'])
    let posed = 0
    for (const e of specs)
      for (const m of e.marks) {
        if (!m.joints) continue
        posed++
        expect(m.position.y).toBeGreaterThanOrEqual(motionRootY(0, 0, bodyLowY({ assetId: e.assetId }, m.joints)) - 1e-6)
      }
    expect(posed).toBeGreaterThan(0)
  })
})
