import { describe, expect, it } from 'vitest'
import { LABEL_COLOR_NAMES, LABEL_SWATCHES, nextLabelColor, resolveColor } from '@engine/palette'

describe('label palette', () => {
  it('has the eight Inspector swatches, named', () => {
    expect(LABEL_SWATCHES).toEqual(['#e5484d', '#f5a524', '#46a758', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316'])
    expect(Object.values(LABEL_COLOR_NAMES)).toEqual(LABEL_SWATCHES)
  })

  it('nextLabelColor: empty list → the first swatch', () => {
    expect(nextLabelColor([])).toBe('#e5484d')
  })

  it('nextLabelColor: partly used → the first unused swatch, case-insensitive', () => {
    expect(nextLabelColor(['#E5484D', '#46a758'])).toBe('#f5a524')
  })

  it('nextLabelColor: all used → cycles by count', () => {
    expect(nextLabelColor([...LABEL_SWATCHES])).toBe(LABEL_SWATCHES[0])
    expect(nextLabelColor([...LABEL_SWATCHES, '#123456'])).toBe(LABEL_SWATCHES[1])
  })

  it('resolveColor: names, hex and junk', () => {
    expect(resolveColor('red')).toBe('#e5484d')
    expect(resolveColor(' Teal ')).toBe('#14b8a6')
    expect(resolveColor('#AbCdEf')).toBe('#abcdef')
    expect(resolveColor('banana')).toBeNull()
    expect(resolveColor('#abc')).toBeNull()
  })
})
