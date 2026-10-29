import { describe, expect, it } from 'vitest'
import {
  CAMERA_MOVE_PRESETS,
  PRESET_ALIASES,
  cameraMoveListing,
  findPreset,
  type CameraMoveContext,
  type CameraMarkSpec,
  type SubjectSample
} from '@engine/camera-moves'
import { SHARED_MOVES, SHARED_MOVE_CATEGORIES, sharedMove } from '@engine/camera-move-names'

// Moving-subject fixture: subject walks along −Z at 2 m/s, facing forward.
function makeCtx(): CameraMoveContext {
  return {
    subjectAt(t: number): SubjectSample {
      return { x: 0, y: 0, z: -2 * t, heading: 0 }
    },
    subjectHeight: 1.75,
    camera: { x: 0, y: 1.6, z: 6, pan: 0, tilt: 0, focalLength: 35 },
    duration: 8
  }
}

const DUR = 8

function finite(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n)
}

describe('camera-move presets — universal contract', () => {
  for (const preset of CAMERA_MOVE_PRESETS) {
    describe(preset.id, () => {
      const marks = preset.generate(makeCtx())

      it('returns ≥5 marks', () => {
        expect(marks.length).toBeGreaterThanOrEqual(5)
      })

      it('first mark at time 0, last at duration', () => {
        expect(marks[0]!.time).toBeCloseTo(0, 6)
        expect(marks[marks.length - 1]!.time).toBeCloseTo(DUR, 6)
      })

      it('times strictly increasing', () => {
        for (let i = 1; i < marks.length; i++) {
          expect(marks[i]!.time).toBeGreaterThan(marks[i - 1]!.time)
        }
      })

      it('all position components finite', () => {
        for (const m of marks) {
          expect(finite(m.position.x)).toBe(true)
          expect(finite(m.position.y)).toBe(true)
          expect(finite(m.position.z)).toBe(true)
          expect(finite(m.pan)).toBe(true)
          expect(finite(m.tilt)).toBe(true)
          expect(finite(m.roll)).toBe(true)
        }
      })

      it('focalLength within 8–300', () => {
        for (const m of marks) {
          expect(m.focalLength).toBeGreaterThanOrEqual(8)
          expect(m.focalLength).toBeLessThanOrEqual(300)
        }
      })

      it('edge marks eased, interior not', () => {
        const last = marks.length - 1
        expect(marks[0]!.easeIn).toBeCloseTo(0.25, 6)
        expect(marks[last]!.easeOut).toBeCloseTo(0.25, 6)
        for (let i = 1; i < last; i++) {
          expect(marks[i]!.easeIn).toBe(0)
          expect(marks[i]!.easeOut).toBe(0)
        }
      })

      it('hold is 0 on every mark', () => {
        for (const m of marks) expect(m.hold).toBe(0)
      })
    })
  }
})

function byId(id: string): CameraMarkSpec[] {
  const preset = CAMERA_MOVE_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`missing preset ${id}`)
  return preset.generate(makeCtx())
}

// Azimuth of the camera relative to the subject at a given mark's time.
function azimuthAt(m: CameraMarkSpec, ctx: CameraMoveContext): number {
  const s = ctx.subjectAt(m.time)
  return Math.atan2(-(m.position.x - s.x), -(m.position.z - s.z))
}

describe('camera-move presets — targeted behavior', () => {
  it('has at least 22 presets', () => {
    expect(CAMERA_MOVE_PRESETS.length).toBeGreaterThanOrEqual(22)
  })

  it('has 39 presets', () => {
    expect(CAMERA_MOVE_PRESETS.length).toBe(39)
  })

  it('all preset ids are unique', () => {
    const ids = CAMERA_MOVE_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('orbit-360 returns near its start azimuth relative to the subject', () => {
    const ctx = makeCtx()
    const marks = byId('orbit-360')
    const startAz = azimuthAt(marks[0]!, ctx)
    const endAz = azimuthAt(marks[marks.length - 1]!, ctx)
    // Wrap the difference into (−π, π]; full circle should return ~0.
    let diff = endAz - startAz
    while (diff > Math.PI) diff -= 2 * Math.PI
    while (diff < -Math.PI) diff += 2 * Math.PI
    expect(Math.abs(diff)).toBeLessThan(0.15)
  })

  it('follow stays ~4m from the subject and moves with it', () => {
    const ctx = makeCtx()
    const marks = byId('follow')
    for (const m of marks) {
      const s = ctx.subjectAt(m.time)
      const planar = Math.hypot(m.position.x - s.x, m.position.z - s.z)
      // ~4m with 25% slack.
      expect(planar).toBeGreaterThan(4 * 0.75)
      expect(planar).toBeLessThan(4 * 1.25)
    }
    // Rides the subject downstream: last mark further along −Z than first.
    expect(marks[marks.length - 1]!.position.z).toBeLessThan(marks[0]!.position.z)
  })

  it('dolly-zoom focalLength strictly decreases and ends < 0.75× initial', () => {
    const marks = byId('dolly-zoom')
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!.focalLength).toBeLessThan(marks[i - 1]!.focalLength)
    }
    expect(marks[marks.length - 1]!.focalLength).toBeLessThan(marks[0]!.focalLength * 0.75)
  })

  it('drone-flyover crosses the subject (sign of camZ − subjZ flips)', () => {
    const ctx = makeCtx()
    const marks = byId('drone-flyover')
    const signs = marks.map((m) => {
      const s = ctx.subjectAt(m.time)
      return Math.sign(m.position.z - s.z)
    })
    const hasPos = signs.some((s) => s > 0)
    const hasNeg = signs.some((s) => s < 0)
    expect(hasPos && hasNeg).toBe(true)
  })

  it('whip-pan has a ≥1.2 rad pan change within ≤1s of shot time', () => {
    const marks = byId('whip-pan')
    let found = false
    for (let i = 1; i < marks.length; i++) {
      const dt = marks[i]!.time - marks[i - 1]!.time
      const dpan = Math.abs(marks[i]!.pan - marks[i - 1]!.pan)
      if (dpan >= 1.2 && dt <= 1) found = true
    }
    expect(found).toBe(true)
  })

  it('snap-zoom-out focalLength ends wider than it starts', () => {
    const marks = byId('snap-zoom-out')
    expect(marks[marks.length - 1]!.focalLength).toBeLessThan(marks[0]!.focalLength)
    // Never increases across the shot.
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!.focalLength).toBeLessThanOrEqual(marks[i - 1]!.focalLength)
    }
  })

  it('spiral-in-descend tightens and drops toward the subject', () => {
    const ctx = makeCtx()
    const marks = byId('spiral-in-descend')
    const first = marks[0]!
    const last = marks[marks.length - 1]!
    const sFirst = ctx.subjectAt(first.time)
    const sLast = ctx.subjectAt(last.time)
    const planarFirst = Math.hypot(first.position.x - sFirst.x, first.position.z - sFirst.z)
    const planarLast = Math.hypot(last.position.x - sLast.x, last.position.z - sLast.z)
    expect(planarLast).toBeLessThan(planarFirst)
    expect(last.position.y).toBeLessThan(first.position.y)
  })

  it('top-down tilt ≈ −π/2', () => {
    const marks = byId('top-down')
    for (const m of marks) {
      expect(m.tilt).toBeCloseTo(-Math.PI / 2, 2)
    }
  })

  it("every preset's category is one of the shared table's", () => {
    const cats = new Set(SHARED_MOVE_CATEGORIES.map((c) => c.id))
    for (const p of CAMERA_MOVE_PRESETS) expect(cats.has(p.category), p.id).toBe(true)
  })
})

// Fork (shared-camera-moves T2, docs/plans/2026-10-29-shared-camera-moves.md): presets take the move ids and names
// shared with Ebook Studio; old ids stay as aliases that lay the same marks.
describe('camera-move presets — shared move ids', () => {
  // A walking, turned subject and an off-axis camera, so every preset's marks depend on all of the context.
  function fpCtx(): CameraMoveContext {
    return {
      subjectAt: (t: number): SubjectSample => ({ x: 0.5 * t, y: 0, z: -2 * t, heading: 0.3 }),
      subjectHeight: 1.75,
      camera: { x: 1, y: 1.6, z: 6, pan: 0, tilt: 0, focalLength: 35 },
      duration: 8
    }
  }

  /** FNV-1a of the marks, rounded to 1e-9: a fingerprint of what a preset laid. */
  function fingerprint(marks: CameraMarkSpec[]): string {
    const s = JSON.stringify(marks, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v))
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h.toString(16).padStart(8, '0')
  }

  // Each preset's marks on fpCtx() under its pre-rename id, recorded before the rename.
  const BEFORE: Record<string, string> = {
    'slow-push-in': '35c4073d',
    'crash-in': '06d9c353',
    'pull-back-reveal': 'aa48f977',
    'creep-in-low': '5196d8dd',
    'orbit-90-left': 'dd95e56a',
    'orbit-90-right': 'f4482419',
    'orbit-180': '0fb6ccf9',
    'orbit-360': 'ad1379b1',
    'arc-and-push': 'f7943e6b',
    'orbit-45-low': 'a470e415',
    'orbit-45-high': '4467830d',
    'crane-up-reveal': '33ad06da',
    'crane-down-intro': 'b8621eac',
    'pedestal-up': 'd1dac694',
    'boom-over': '8dc03f53',
    'spiral-in-descend': '16202078',
    'spiral-out-ascend': 'b3e2a49e',
    'pedestal-up-slow': '67d712b1',
    'drone-rise-pullback': '9be9b361',
    flyover: 'c779a2d5',
    'drone-orbit-high': '2098be9f',
    'top-down-descend': 'fae4bcfe',
    'overhead-track-follow': 'e4c07b81',
    'drone-strafe-reveal': '92e6bdf1',
    'follow-behind': '39bace67',
    'lead-the-subject': '703c9bd8',
    'side-track-left': 'c9d70cfc',
    'side-track-right': '676384fc',
    'lead-follow-front': 'dbb24e90',
    'low-lead-tilt-up': '1317b290',
    'side-dolly-past': '896a7397',
    'static-pan-across': '02a19c7d',
    'whip-pan': '05da59e1',
    'slow-tilt-reveal': '4300afb1',
    'vertigo-dolly-zoom': '65b32dd8',
    'dutch-orbit': 'b8cc6026',
    'snap-zoom-punch': '5ec3b129',
    'crash-zoom-out': '7ba2d16b',
    'push-in-dutch-roll': '326a63c5'
  }

  // The shared moves Task 3 adds presets for.
  const TASK3 = new Set(['static', 'pan-left', 'pan-right', 'tilt-down', 'dolly-out', 'truck-left', 'truck-right', 'pedestal-down', 'zoom-in', 'zoom-out', 'fpv-dive', 'pov-walk'])

  /** The camera's sideways step over its first leg, in the first mark's frame (+ = to its right, as prompt-scene words it). */
  function lateral(marks: CameraMarkSpec[]): number {
    const a = marks[0]!
    const b = marks[1]!
    return (b.position.x - a.position.x) * Math.cos(a.pan) - (b.position.z - a.position.z) * Math.sin(a.pan)
  }

  it("every preset's move is a shared move, with its category; a preset that is the move has its name", () => {
    for (const p of CAMERA_MOVE_PRESETS) {
      const m = sharedMove(p.move)
      expect(m, p.id).toBeDefined()
      expect(p.category, p.id).toBe(m!.category)
      if (p.id === p.move) expect(p.name, p.id).toBe(m!.name)
      else expect(sharedMove(p.id), p.id).toBeUndefined()
    }
  })

  for (const m of SHARED_MOVES.filter((x) => x.blockout === 'preset')) {
    if (TASK3.has(m.id)) it.todo(`${m.id} resolves to its own preset`)
    else
      it(`${m.id} resolves to its own preset`, () => {
        expect(findPreset(m.id)?.id).toBe(m.id)
      })
  }

  it('old ids resolve through PRESET_ALIASES to the shared move they became', () => {
    expect(findPreset('slow-push-in')?.id).toBe('dolly-in')
    for (const [old, id] of Object.entries(PRESET_ALIASES)) {
      expect(findPreset(old)?.id, old).toBe(id)
      expect(sharedMove(id), old).toBeDefined()
      expect(CAMERA_MOVE_PRESETS.some((p) => p.id === old), old).toBe(false)
    }
    expect(findPreset('constructor')).toBeUndefined()
    expect(findPreset('no-such-move')).toBeUndefined()
  })

  it('an old id lays the marks it laid before the rename', () => {
    const now = (id: string): string => fingerprint(findPreset(id)!.generate(fpCtx()))
    for (const [old, fp] of Object.entries(BEFORE)) if (!old.startsWith('side-track-')) expect(now(old), old).toBe(fp)
    expect(findPreset('slow-push-in')!.generate(fpCtx())).toEqual(findPreset('dolly-in')!.generate(fpCtx()))
    // The side tracks were on the wrong flanks (side-track-left moved the camera right): they swapped.
    expect(now('side-track-left')).toBe(BEFORE['side-track-right'])
    expect(now('side-track-right')).toBe(BEFORE['side-track-left'])
  })

  it('a left or right move goes the way its shared sentence says', () => {
    for (const p of CAMERA_MOVE_PRESETS) {
      const marks = p.generate(makeCtx())
      if (p.move === 'arc-left' || p.move === 'side-track-left') expect(lateral(marks), p.id).toBeLessThan(-0.1)
      if (p.move === 'arc-right' || p.move === 'side-track-right') expect(lateral(marks), p.id).toBeGreaterThan(0.1)
      // Pan grows counter-clockwise seen from above: a pan to the left.
      if (p.move === 'pan-left') expect(marks[marks.length - 1]!.pan - marks[0]!.pan, p.id).toBeGreaterThan(0.1)
      if (p.move === 'pan-right') expect(marks[marks.length - 1]!.pan - marks[0]!.pan, p.id).toBeLessThan(-0.1)
    }
  })

  it('lists every shared move once, in table order, each followed by its variants', () => {
    const list = cameraMoveListing()
    expect(list.filter((r) => r.id === r.move).map((r) => r.id)).toEqual(SHARED_MOVES.map((m) => m.id))
    expect(new Set(list.map((r) => r.id)).size).toBe(list.length)
    for (const p of CAMERA_MOVE_PRESETS) expect(list.some((r) => r.id === p.id), p.id).toBe(true)
    for (const r of list) {
      expect(r.name, r.id).toBe(r.id === r.move ? sharedMove(r.id)!.name : findPreset(r.id)!.name)
      if (r.id !== r.move) expect(list.findIndex((x) => x.id === r.move), r.id).toBeLessThan(list.indexOf(r))
    }
  })
})
