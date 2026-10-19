import { describe, expect, it } from 'vitest'
import { ASPECT_RATIOS, verticalFov } from '@engine/camera'
import { personDims, poseEffectors, toWorld } from '@engine/skeleton'
import { solveShot, type ShotSetup, type ShotSubject, type SolvedShot } from '@engine/shot'
import type { V3 } from '@engine/types'

const SETUP: ShotSetup = { sensorId: 'super35', aspect: '16:9', focalLength: 35 }

/** Pinhole projection matching the renderer: rotation (tilt, pan, roll) in 'YXZ', looking down −Z. */
function project(p: V3, cam: SolvedShot, setup: ShotSetup): { x: number; y: number; depth: number } {
  const vfov = verticalFov(setup.sensorId, cam.focalLength, setup.aspect)
  const tanV = Math.tan(vfov / 2)
  const tanH = tanV * ASPECT_RATIOS[setup.aspect]
  const cp = Math.cos(cam.pan)
  const sp = Math.sin(cam.pan)
  const ct = Math.cos(cam.tilt)
  const st = Math.sin(cam.tilt)
  const cr = Math.cos(cam.roll)
  const sr = Math.sin(cam.roll)
  // R = Ry(pan) · Rx(tilt) · Rz(roll); columns give the camera axes.
  const rot = (v: V3): V3 => {
    const z1 = { x: v.x * cr - v.y * sr, y: v.x * sr + v.y * cr, z: v.z }
    const x1 = { x: z1.x, y: z1.y * ct - z1.z * st, z: z1.y * st + z1.z * ct }
    return { x: x1.x * cp + x1.z * sp, y: x1.y, z: -x1.x * sp + x1.z * cp }
  }
  const right = rot({ x: 1, y: 0, z: 0 })
  const up = rot({ x: 0, y: 1, z: 0 })
  const fwd = rot({ x: 0, y: 0, z: -1 })
  const d = { x: p.x - cam.position.x, y: p.y - cam.position.y, z: p.z - cam.position.z }
  const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
  const depth = dot(d, fwd)
  return { x: dot(d, right) / depth / tanH, y: dot(d, up) / depth / tanV, depth }
}

function person(id: string, position: V3, heading: number, joints?: Record<string, number>): ShotSubject {
  return { id, assetId: 'person.man', scale: 1, position, heading, joints }
}

function landmarks(s: ShotSubject): { headTop: V3; head: V3; shoulderL: V3; shoulderR: V3 } {
  const dims = personDims(s.assetId, s.params)
  const fx = poseEffectors(dims, s.joints)
  const w = (p: V3): V3 => toWorld(p, s.position, s.heading, s.scale)
  const head = w(fx.head)
  return {
    head,
    headTop: { x: head.x, y: head.y + dims.headR * s.scale, z: head.z },
    shoulderL: w(fx.shoulderL),
    shoulderR: w(fx.shoulderR)
  }
}

const GUARD = { shoulderLX: -0.9, shoulderRX: -0.9, elbowL: 1.8, elbowR: 1.8, torsoX: 0.15 }

describe('solveShot singles', () => {
  for (const [size, fill] of [['MS', 0.92], ['CU', 0.9], ['WS', 0.65]] as const) {
    it(`${size} single at eye level: head-top NDC y = ${fill} ± 0.01, head x = 0 ± 0.01`, () => {
      for (const subject of [person('a', { x: 0, y: 0, z: 0 }, 0), person('a', { x: 2, y: 0, z: -4 }, 1, GUARD)]) {
        const cam = solveShot({ size, subjectIds: ['a'] }, [subject], SETUP)
        const lm = landmarks(subject)
        const top = project(lm.headTop, cam, SETUP)
        const head = project(lm.head, cam, SETUP)
        expect(top.depth).toBeGreaterThan(0)
        expect(Math.abs(top.y - fill)).toBeLessThan(0.01)
        expect(Math.abs(head.x)).toBeLessThan(0.01)
        expect(cam.focalLength).toBe(35)
      }
    })
  }

  it('side right puts the camera on the subject\'s own right', () => {
    const cam = solveShot({ size: 'MS', subjectIds: ['a'], side: 'right' }, [person('a', { x: 0, y: 0, z: 0 }, 0)], SETUP)
    expect(cam.position.x).toBeGreaterThan(0)
    expect(Math.abs(cam.position.z)).toBeLessThan(1e-6)
    const left = solveShot({ size: 'MS', subjectIds: ['a'], side: 'left' }, [person('a', { x: 0, y: 0, z: 0 }, 0)], SETUP)
    expect(left.position.x).toBeLessThan(0)
    const front = solveShot({ size: 'MS', subjectIds: ['a'], side: 'front' }, [person('a', { x: 0, y: 0, z: 0 }, 0)], SETUP)
    expect(front.position.z).toBeLessThan(0) // in front of a subject facing −Z
  })

  it('honours lens, angle and dutch', () => {
    const subject = person('a', { x: 0, y: 0, z: 0 }, 0)
    const lens = solveShot({ size: 'MCU', subjectIds: ['a'], lens: 85 }, [subject], SETUP)
    expect(lens.focalLength).toBe(85)
    const low = solveShot({ size: 'MS', subjectIds: ['a'], angle: 'low' }, [subject], SETUP)
    expect(low.position.y).toBeCloseTo(0.5, 9)
    expect(low.tilt).toBeGreaterThan(0)
    const eye = solveShot({ size: 'MS', subjectIds: ['a'] }, [subject], SETUP)
    const high = solveShot({ size: 'MS', subjectIds: ['a'], angle: 'high' }, [subject], SETUP)
    expect(high.position.y).toBeCloseTo(eye.position.y + 1.5, 9)
    expect(high.tilt).toBeLessThan(0)
    const ground = solveShot({ size: 'MS', subjectIds: ['a'], angle: 'ground' }, [subject], SETUP)
    expect(ground.position.y).toBeCloseTo(0.15, 9)
    const dutch = solveShot({ size: 'MS', subjectIds: ['a'], dutchDeg: 15 }, [subject], SETUP)
    expect(dutch.roll).toBeCloseTo((15 * Math.PI) / 180, 12)
  })

  it('overhead looks straight down', () => {
    const cam = solveShot({ size: 'WS', subjectIds: ['a'], angle: 'overhead' }, [person('a', { x: 1, y: 0, z: 2 }, 0.4)], SETUP)
    expect(Math.abs(cam.tilt + Math.PI / 2)).toBeLessThan(1e-6)
    const head = landmarks(person('a', { x: 1, y: 0, z: 2 }, 0.4)).head
    expect(cam.position.y).toBeGreaterThan(head.y)
    expect(Math.abs(cam.position.x - head.x)).toBeLessThan(1e-6)
    expect(Math.abs(cam.position.z - head.z)).toBeLessThan(1e-6)
  })

  it('vehicle WS frames the car by footprint', () => {
    for (const heading of [0, 0.3, 2]) {
      const car: ShotSubject = { id: 'car', assetId: 'vehicle.sedan', scale: 1, position: { x: 3, y: 0, z: -2 }, heading }
      const cam = solveShot({ size: 'WS', subjectIds: ['car'] }, [car], SETUP)
      const fwd = { x: -Math.sin(heading), z: -Math.cos(heading) }
      for (const sign of [1, -1]) {
        const bumper = { x: car.position.x + fwd.x * 2.4 * sign, y: 0.5, z: car.position.z + fwd.z * 2.4 * sign }
        const p = project(bumper, cam, SETUP)
        expect(p.depth).toBeGreaterThan(0)
        expect(Math.abs(p.x)).toBeLessThan(1)
        expect(Math.abs(p.y)).toBeLessThan(1)
      }
    }
  })
})

describe('solveShot groups', () => {
  for (const gap of [1.2, 3]) {
    it(`two-shot keeps both heads and both outer shoulders inside |NDC| ≤ 0.95 (${gap} m apart)`, () => {
      const a = person('a', { x: -gap / 2, y: 0, z: 0 }, -Math.PI / 2, GUARD)
      const b = person('b', { x: gap / 2, y: 0, z: 0 }, Math.PI / 2)
      for (const size of ['MS', 'FS', 'WS'] as const) {
        const cam = solveShot({ size, subjectIds: ['a', 'b'] }, [a, b], SETUP)
        for (const s of [a, b]) {
          const lm = landmarks(s)
          for (const p of [lm.headTop, lm.head, lm.shoulderL, lm.shoulderR]) {
            const q = project(p, cam, SETUP)
            expect(q.depth).toBeGreaterThan(0)
            expect(Math.abs(q.x)).toBeLessThanOrEqual(0.95)
            expect(Math.abs(q.y)).toBeLessThanOrEqual(0.95)
          }
        }
      }
    })
  }

  it('line side flips the camera across the subject line', () => {
    const a = person('a', { x: -0.6, y: 0, z: 0 }, -Math.PI / 2)
    const b = person('b', { x: 0.6, y: 0, z: 0 }, Math.PI / 2)
    const plus = solveShot({ size: 'MS', subjectIds: ['a', 'b'] }, [a, b], SETUP, 1)
    const minus = solveShot({ size: 'MS', subjectIds: ['a', 'b'] }, [a, b], SETUP, -1)
    // cross((B − A), (cam − A)) sign = lineSide
    const side = (cam: SolvedShot): number => Math.sign(1.2 * (cam.position.z - 0) - 0 * (cam.position.x + 0.6))
    expect(side(plus)).toBe(1)
    expect(side(minus)).toBe(-1)
  })
})

describe('solveShot over the shoulder', () => {
  const a = person('a', { x: 0, y: 0, z: 0.6 }, 0, GUARD)
  const b = person('b', { x: 0.1, y: 0, z: -0.6 }, Math.PI, GUARD)

  it('OTS over A\'s right shoulder', () => {
    const cam = solveShot({ size: 'MCU', subjectIds: ['b'], over: { entityId: 'a', shoulder: 'right' }, lens: 50 }, [a, b], SETUP)
    const shoulder = landmarks(a).shoulderR
    const d = Math.hypot(cam.position.x - shoulder.x, cam.position.y - shoulder.y, cam.position.z - shoulder.z)
    expect(d).toBeLessThan(0.7)
    // A faces −Z, so A's right is +X.
    expect(cam.position.x - a.position.x).toBeGreaterThan(0)
    // Behind A, away from B.
    expect(cam.position.z).toBeGreaterThan(a.position.z)
    const head = project(landmarks(b).head, cam, SETUP)
    expect(head.depth).toBeGreaterThan(0)
    expect(Math.abs(head.x)).toBeLessThan(0.02)
    expect(cam.focalLength).toBe(50)
    expect(cam.achievedSize).toBeDefined()
  })

  it('OTS without a lens solves the focal length for the size', () => {
    const mcu = solveShot({ size: 'MCU', subjectIds: ['b'], over: { entityId: 'a', shoulder: 'left' } }, [a, b], SETUP)
    expect(mcu.focalLength).toBeGreaterThanOrEqual(12)
    expect(mcu.focalLength).toBeLessThanOrEqual(135)
    expect(mcu.position.x - a.position.x).toBeLessThan(0)
    const cu = solveShot({ size: 'CU', subjectIds: ['b'], over: { entityId: 'a', shoulder: 'left' } }, [a, b], SETUP)
    expect(cu.focalLength).toBeGreaterThan(mcu.focalLength)
  })

  it('throws on a missing subject or an over entity that is the subject', () => {
    expect(() => solveShot({ size: 'MS', subjectIds: ['zzz'] }, [a, b], SETUP)).toThrow()
    expect(() => solveShot({ size: 'MS', subjectIds: ['b'], over: { entityId: 'b', shoulder: 'left' } }, [a, b], SETUP)).toThrow()
  })
})
