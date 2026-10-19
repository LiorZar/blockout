import { describe, expect, it } from 'vitest'
import { pickFramingSubjectIds } from '@engine/framing'

const env = { id: 'env1', assetId: 'env.residentialStreet' }
const car = { id: 'car1', assetId: 'vehicle.sedan' }
const car2 = { id: 'car2', assetId: 'vehicle.suv' }
const man = { id: 'man1', assetId: 'person.man' }
const woman = { id: 'woman1', assetId: 'person.woman' }

describe('pickFramingSubjectIds', () => {
  it('single selected vehicle with minSelected 1 → [car]', () => {
    expect(pickFramingSubjectIds([env, man, car, woman], ['car1'], 1)).toEqual(['car1'])
  })

  it('single selected vehicle with minSelected 2 → people when present', () => {
    expect(pickFramingSubjectIds([env, man, car, woman], ['car1'], 2)).toEqual(['man1', 'woman1'])
  })

  it('nothing selected, only env + 2 cars → the 2 cars, never the env kit', () => {
    expect(pickFramingSubjectIds([env, car, car2], [], 2)).toEqual(['car1', 'car2'])
  })

  it('selected id not in scene is ignored', () => {
    expect(pickFramingSubjectIds([env, man, car], ['ghost', 'car1'], 2)).toEqual(['man1'])
    expect(pickFramingSubjectIds([env, man, car], ['ghost'], 1)).toEqual(['man1'])
  })

  it('keeps scene order for a multi-selection', () => {
    expect(pickFramingSubjectIds([env, man, car, woman], ['woman1', 'car1'], 2)).toEqual(['car1', 'woman1'])
  })

  it('only an env kit → []', () => {
    expect(pickFramingSubjectIds([env], [], 2)).toEqual([])
    expect(pickFramingSubjectIds([], [], 1)).toEqual([])
  })
})
