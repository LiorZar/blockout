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

      // Fork (shared-camera-moves): Static is one mark, held for the whole shot.
      const held = preset.id === 'static'

      it(held ? 'returns one mark' : 'returns ≥5 marks', () => {
        if (held) expect(marks.length).toBe(1)
        else expect(marks.length).toBeGreaterThanOrEqual(5)
      })

      it(held ? 'its mark at time 0' : 'first mark at time 0, last at duration', () => {
        expect(marks[0]!.time).toBeCloseTo(0, 6)
        if (!held) expect(marks[marks.length - 1]!.time).toBeCloseTo(DUR, 6)
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

  it('has 51 presets', () => {
    expect(CAMERA_MOVE_PRESETS.length).toBe(51)
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

  it('every shared move Blockout stages as a path resolves to its own preset', () => {
    for (const m of SHARED_MOVES.filter((x) => x.blockout === 'preset')) expect(findPreset(m.id)?.id, m.id).toBe(m.id)
  })

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

// Fork (shared-camera-moves T3): presets for the shared moves upstream had none for, each to the plan's table.
describe('camera-move presets — the shared moves added', () => {
  const H = 1.75
  /** A subject standing at the origin facing −Z, the camera 6 m in front and 2 m to the side. */
  function stillCtx(camY = 1.6): CameraMoveContext {
    return {
      subjectAt: (): SubjectSample => ({ x: 0, y: 0, z: 0, heading: 0 }),
      subjectHeight: H,
      camera: { x: 2, y: camY, z: 6, pan: 0, tilt: 0, focalLength: 35 },
      duration: DUR
    }
  }
  const ADDED = ['static', 'pan-left', 'pan-right', 'tilt-down', 'dolly-out', 'truck-left', 'truck-right', 'pedestal-down', 'zoom-in', 'zoom-out', 'fpv-dive', 'pov-walk']
  const gen = (id: string, ctx: CameraMoveContext = stillCtx()): CameraMarkSpec[] => findPreset(id)!.generate(ctx)
  const first = (m: CameraMarkSpec[]): CameraMarkSpec => m[0]!
  const last = (m: CameraMarkSpec[]): CameraMarkSpec => m[m.length - 1]!
  const eyes = { x: 0, y: H * 0.8, z: 0 }
  const panTo = (c: { x: number; z: number }, t: { x: number; z: number }): number => Math.atan2(-(t.x - c.x), -(t.z - c.z))
  const tiltTo = (c: { x: number; y: number; z: number }, t: { x: number; y: number; z: number }): number => Math.atan2(t.y - c.y, Math.hypot(t.x - c.x, t.z - c.z))
  const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6)
  const at = (m: CameraMarkSpec, p: { x: number; y: number; z: number }): void => {
    close(m.position.x, p.x)
    close(m.position.y, p.y)
    close(m.position.z, p.z)
  }

  it('are registered under their shared ids, in the table order of their category', () => {
    for (const id of ADDED) expect(CAMERA_MOVE_PRESETS.filter((p) => p.id === id).map((p) => p.move), id).toEqual([id])
    const order = SHARED_MOVES.map((m) => m.id)
    const own = CAMERA_MOVE_PRESETS.filter((p) => p.id === p.move).map((p) => order.indexOf(p.id))
    expect(own).toEqual([...own].sort((a, b) => a - b))
  })

  it('static: one mark where the camera stands, on the subject', () => {
    const m = gen('static')
    expect(m).toHaveLength(1)
    at(first(m), { x: 2, y: 1.6, z: 6 })
    close(first(m).pan, panTo({ x: 2, z: 6 }, eyes))
    close(first(m).tilt, tiltTo({ x: 2, y: 1.6, z: 6 }, eyes))
  })

  it('pan-left / pan-right: the camera stays, starts on the subject and turns 40°', () => {
    for (const [id, sign] of [['pan-left', 1], ['pan-right', -1]] as const) {
      const m = gen(id)
      for (const k of m) at(k, { x: 2, y: 1.6, z: 6 })
      close(first(m).pan, panTo({ x: 2, z: 6 }, eyes))
      close(last(m).pan - first(m).pan, (sign * 40 * Math.PI) / 180)
      close(last(m).tilt, first(m).tilt)
    }
  })

  it("tilt-down: the camera stays and tilts from the subject's eyes to its feet", () => {
    const m = gen('tilt-down')
    for (const k of m) at(k, { x: 2, y: 1.6, z: 6 })
    close(first(m).tilt, tiltTo({ x: 2, y: 1.6, z: 6 }, eyes))
    close(last(m).tilt, tiltTo({ x: 2, y: 1.6, z: 6 }, { x: 0, y: 0, z: 0 }))
  })

  it('dolly-out: straight back along its line from the current distance to 2.5×, at the same height', () => {
    const m = gen('dolly-out')
    const d0 = Math.hypot(2, 6)
    at(first(m), { x: 2, y: 1.6, z: 6 })
    at(last(m), { x: 2 * 2.5, y: 1.6, z: 6 * 2.5 })
    for (const k of m) close(Math.atan2(k.position.x, k.position.z), Math.atan2(2, 6))
    expect(Math.hypot(last(m).position.x, last(m).position.z) / d0).toBeCloseTo(2.5, 6)
    expect(findPreset('dolly-out')!.track).toBe(true)
  })

  it('truck-left / truck-right: 4 m square to the start view, without turning', () => {
    for (const [id, sign] of [['truck-left', -1], ['truck-right', 1]] as const) {
      const m = gen(id)
      const pan = first(m).pan
      close(pan, panTo({ x: 2, z: 6 }, eyes))
      at(first(m), { x: 2, y: 1.6, z: 6 })
      // The camera's right is (cos pan, 0, −sin pan).
      at(last(m), { x: 2 + sign * 4 * Math.cos(pan), y: 1.6, z: 6 - sign * 4 * Math.sin(pan) })
      for (const k of m) {
        close(k.pan, pan)
        close(k.tilt, first(m).tilt)
      }
    }
  })

  it("truck-left on a moving vehicle slides its 4 m from where it starts and doesn't follow", () => {
    const car = (speed: number): CameraMoveContext => ({
      subjectAt: (t: number): SubjectSample => ({ x: 0, y: 0, z: -speed * t, heading: 0 }),
      subjectHeight: 1.5,
      camera: { x: 8, y: 1.6, z: 4, pan: 0, tilt: 0, focalLength: 35 },
      duration: DUR,
      subjectBox: { length: 4.6, width: 1.9, height: 1.5 }
    })
    const fast = gen('truck-left', car(15))
    expect(fast).toEqual(gen('truck-left', car(0)))
    const slide = Math.hypot(last(fast).position.x - first(fast).position.x, last(fast).position.z - first(fast).position.z)
    close(slide, 4)
    expect(findPreset('truck-left')!.track).toBe(false)
  })

  it('pedestal-down: 1.2 m straight down, the tilt held, never under 0.2 m', () => {
    const m = gen('pedestal-down')
    at(first(m), { x: 2, y: 1.6, z: 6 })
    at(last(m), { x: 2, y: 0.4, z: 6 })
    for (const k of m) close(k.tilt, first(m).tilt)
    close(first(m).tilt, tiltTo({ x: 2, y: 1.6, z: 6 }, eyes))
    const low = gen('pedestal-down', stillCtx(0.9))
    close(last(low).position.y, 0.2)
  })

  it('zoom-in / zoom-out: the camera stays while the lens goes 35 ↔ 85 mm', () => {
    for (const [id, a, b] of [['zoom-in', 35, 85], ['zoom-out', 85, 35]] as const) {
      const m = gen(id)
      for (const k of m) at(k, { x: 2, y: 1.6, z: 6 })
      close(first(m).focalLength, a)
      close(last(m).focalLength, b)
    }
  })

  it('fpv-dive: 15 m up and out to 1 m up, 2 m in front, banking ±0.25 rad, on 16 mm', () => {
    const m = gen('fpv-dive')
    // In front of a subject facing −Z is −Z.
    at(first(m), { x: 0, y: 15, z: -15 })
    at(last(m), { x: 0, y: 1, z: -2 })
    for (const k of m) expect(k.focalLength).toBe(16)
    close(Math.max(...m.map((k) => k.roll)), 0.25)
    close(Math.min(...m.map((k) => k.roll)), -0.25)
    // Steep early: more than half the drop is done by the middle of the shot.
    expect(m[4]!.position.y).toBeLessThan(8)
  })

  it('pov-walk: eye height, 6 m to 1.5 m in front, a 2 Hz bob of 3 cm and a slight sway, on 24 mm', () => {
    const m = gen('pov-walk')
    at(first(m), { x: 0, y: 1.6, z: -6 })
    at(last(m), { x: 0, y: 1.6, z: -1.5 })
    close(first(m).roll, 0)
    close(last(m).roll, 0)
    for (const k of m) expect(k.focalLength).toBe(24)
    const inner = m.slice(1, -1)
    close(Math.max(...inner.map((k) => k.position.y)), 1.63)
    close(Math.min(...inner.map((k) => k.position.y)), 1.57)
    expect(Math.max(...inner.map((k) => Math.abs(k.roll)))).toBeLessThanOrEqual(0.01 + 1e-9)
    // A mark on every peak and trough: 0.25 s apart.
    for (let i = 2; i < m.length - 1; i++) close(m[i]!.time - m[i - 1]!.time, 0.25)
  })

  it('keep every mark 0.2 m or more above the ground, and give the same marks every run', () => {
    for (const id of ADDED)
      for (const ctx of [stillCtx(), stillCtx(0.3), makeCtx()]) {
        const m = gen(id, ctx)
        for (const k of m) expect(k.position.y, id).toBeGreaterThanOrEqual(0.2 - 1e-9)
        expect(gen(id, ctx), id).toEqual(m)
      }
  })
})
