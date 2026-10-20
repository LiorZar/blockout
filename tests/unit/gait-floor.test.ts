// Fork addition (2026): every gait keeps the body on the floor; see MODIFICATIONS.md.
import { describe, expect, it } from 'vitest'
import { Mesh, Vector3, type Object3D } from 'three'
import { buildAsset } from '@renderer/viewport/builders'
import { personDims } from '@engine/skeleton'
import { GAITS } from '@engine/gaits'
import type { GaitId } from '@engine/types'

const PEOPLE = ['person.man', 'person.woman', 'person.child', 'person.elderly', 'person.mannequinMale', 'person.mannequinFemale']
const PHASES = Array.from({ length: 20 }, (_, i) => i / 20)

/** Lowest rendered vertex, world y. */
function meshLow(root: Object3D): number {
  let low = Infinity
  const v = new Vector3()
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const pos = o.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) low = Math.min(low, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).y)
  })
  return low
}

function posed(id: string, gait: GaitId, phase: number, speed: number): Object3D {
  const b = buildAsset(id)
  b.animate!({ gait, phase, speed, distance: 0, time: 0 })
  return b.group
}

describe('gaits keep the body on the floor (six bodies)', () => {
  const cases: [GaitId, number][] = [
    ['stand', 0],
    ['gesture', 0],
    ['walk', 1.4],
    ['crouch', 0],
    ['crouch', 0.6],
    ['sit', 0],
    ['lie', 0],
    ['fall', 0]
  ]
  for (const [gait, speed] of cases) {
    it(`${gait}${speed > 0 ? ' moving' : ''}: lowest point within 1 cm of the floor at every phase`, () => {
      for (const id of PEOPLE) {
        for (const phase of gait === 'walk' || gait === 'jog' || gait === 'run' || speed > 0 ? PHASES : [0]) {
          const low = meshLow(posed(id, gait, phase, speed))
          expect(Math.abs(low), `${id} ${gait} @${phase}`).toBeLessThan(0.01)
        }
      }
    })
  }

  it('walk always has a sole on the floor', () => {
    for (const id of PEOPLE) {
      const d = personDims(id)
      for (const gait of ['walk'] as const) {
        for (const phase of PHASES) {
          const g = posed(id, gait, phase, 2)
          let sole = Infinity
          for (const side of ['L', 'R']) {
            const knee = g.getObjectByName(`knee${side}`)!
            for (const z of [-0.175, -0.16, 0.06]) sole = Math.min(sole, knee.localToWorld(new Vector3(0, -d.lowerLegLen, z * d.s)).y)
          }
          expect(Math.abs(sole), `${id} ${gait} @${phase}`).toBeLessThan(0.01)
        }
      }
    }
  })

  it('sit rests both soles flat on the floor', () => {
    for (const id of PEOPLE) {
      const d = personDims(id)
      const g = posed(id, 'sit', 0, 0)
      for (const side of ['L', 'R']) {
        const knee = g.getObjectByName(`knee${side}`)!
        const toe = knee.localToWorld(new Vector3(0, -d.lowerLegLen, -0.15 * d.s))
        const heel = knee.localToWorld(new Vector3(0, -d.lowerLegLen, 0.05 * d.s))
        expect(Math.abs(toe.y), `${id} ${side} toe`).toBeLessThan(0.01)
        expect(Math.abs(heel.y), `${id} ${side} heel`).toBeLessThan(0.01)
      }
    }
  })

  it('lie lays the elderly flat too (no stoop into the floor)', () => {
    const g = posed('person.elderly', 'lie', 0, 0)
    const pelvis = g.getObjectByName('pelvis')!.getWorldPosition(new Vector3())
    const head = g.getObjectByName('head')!.getWorldPosition(new Vector3())
    expect(Math.abs(head.y - pelvis.y)).toBeLessThan(0.02)
  })
})

describe('jog and run: planted stance, a short flight', () => {
  const STEPS = Array.from({ length: 96 }, (_, i) => i / 96)
  const FLIGHT: Record<'jog' | 'run', number> = { jog: 0.045, run: 0.075 }

  for (const gait of ['jog', 'run'] as const) {
    it(`${gait}: never below the floor, both feet off it only briefly and by at most ${FLIGHT[gait] * 100} cm`, () => {
      for (const id of PEOPLE) {
        let flying = 0
        for (const phase of STEPS) {
          const low = meshLow(posed(id, gait, phase, 4))
          expect(low, `${id} @${phase}`).toBeGreaterThan(-0.01)
          expect(low, `${id} @${phase}`).toBeLessThan(FLIGHT[gait])
          if (low > (gait === 'run' ? 0.01 : 0.005)) flying++
        }
        expect(flying, id).toBeGreaterThan(4)
        expect(flying, id).toBeLessThan(STEPS.length * 0.75)
      }
    })

    it(`${gait}: the stance foot stays planted (no slide) while the body travels`, () => {
      for (const id of PEOPLE) {
        const d = personDims(id)
        const b = buildAsset(id)
        const stride = GAITS[gait].strideLength
        let planted: { side: string; z: number } | null = null
        let checked = 0
        for (const phase of STEPS) {
          b.animate!({ gait, phase, speed: 4, distance: phase * stride, time: 0 })
          b.group.updateMatrixWorld(true)
          const low = meshLow(b.group)
          // World = body travelling −Z by phase × stride.
          const ankles = ['L', 'R'].map((side) => {
            const p = b.group.getObjectByName(`knee${side}`)!.localToWorld(new Vector3(0, -d.lowerLegLen, 0))
            return { side, y: p.y, z: p.z - phase * stride }
          })
          const down = ankles.reduce((a, c) => (c.y < a.y ? c : a))
          if (Math.abs(low) > 0.002 || down.y > 0.06) {
            planted = null
            continue
          }
          if (planted && planted.side === down.side) {
            expect(Math.abs(down.z - planted.z), `${id} ${down.side} @${phase}`).toBeLessThan(0.015)
            checked++
          }
          else planted = { side: down.side, z: down.z }
        }
        expect(checked, id).toBeGreaterThan(6)
      }
    })
  }

  it('run leans 8–12° forward (elderly add their stoop)', () => {
    for (const id of PEOPLE) {
      const g = posed(id, 'run', 0.3, 6)
      const lean = g.getObjectByName('head')!.getWorldPosition(new Vector3()).sub(g.getObjectByName('torso')!.getWorldPosition(new Vector3()))
      const deg = (Math.atan2(-lean.z, lean.y) * 180) / Math.PI
      expect(deg, id).toBeGreaterThan(8)
      expect(deg, id).toBeLessThan(id === 'person.elderly' ? 22 : 12)
    }
  })

  it('a held run mark (no speed) stands on the floor', () => {
    for (const id of PEOPLE) for (const phase of STEPS.filter((_, i) => i % 8 === 0)) expect(Math.abs(meshLow(posed(id, 'run', phase, 0))), `${id} @${phase}`).toBeLessThan(0.01)
  })
})
