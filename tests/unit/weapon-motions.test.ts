import { describe, expect, it } from 'vitest'
import { Box3 } from 'three'
import { useStore } from '@renderer/store'
import { buildAsset } from '@renderer/viewport/builders'
import { ShotEvaluator } from '@engine/evaluate'
import { mirrorForHeld } from '@engine/fight/moves'
import { MOTION_PRESETS } from '@engine/motions'
import { createEntity, createProject } from '@engine/schema'
import { personDims, poseEffectors } from '@engine/skeleton'
import type { Entity, EntityState, ProjectDoc, V3 } from '@engine/types'
import { WEAPON_SPECS, aimDirectionLocal, handFrame, heldPointLocal, supportReach, weaponSpec, type Hand } from '@engine/weapons'

const BODIES = ['person.man', 'person.woman', 'person.mannequinMale', 'person.mannequinFemale', 'person.child', 'person.elderly']
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z)
const deg = (rad: number): number => (rad * 180) / Math.PI

/** A fresh document with one performer; returns its id. */
function load(assetId: string): Entity {
  const doc: ProjectDoc = createProject('Weapon motions')
  const scene = doc.scenes[0]!
  scene.shots[0]!.duration = 4
  const person = createEntity(assetId, 'P', { x: 0, y: 0, z: 0 })
  scene.entities.push(person)
  useStore.setState({ doc, sceneId: scene.id, shotId: scene.shots[0]!.id, time: 0, undoStack: [], redoStack: [], selection: null })
  return person
}

function stateAt(id: string, t: number): EntityState {
  const s = useStore.getState()
  return new ShotEvaluator(s.scene()!, s.shot()!).evaluate(t).entities.find((e) => e.entityId === id)!
}

describe('apply_motion mirrors a weapon motion onto a left-hand weapon', () => {
  it('mirrorForHeld: only when the motion’s weapon hand is empty and the other hand holds a weapon it is for', () => {
    const rifle = (hand: Hand): { hand: Hand; kind: 'gun' } => ({ hand, kind: 'gun' })
    expect(mirrorForHeld('rifle-aim-fire', [rifle('L')])).toBe(true)
    expect(mirrorForHeld('rifle-aim-fire', [rifle('R')])).toBe(false)
    expect(mirrorForHeld('rifle-aim-fire', [])).toBe(false)
    expect(mirrorForHeld('rifle-aim-fire', [{ hand: 'L', kind: 'shield' }])).toBe(false)
    expect(mirrorForHeld('sword-slash-combo', [{ hand: 'L', kind: 'blade' }])).toBe(true)
    expect(mirrorForHeld('sword-slash-combo', [{ hand: 'L', kind: 'blade' }, { hand: 'R', kind: 'blade' }])).toBe(false)
    // The bow and the shield are authored in the left hand.
    expect(mirrorForHeld('bow-draw-loose', [{ hand: 'R', kind: 'bow' }])).toBe(true)
    expect(mirrorForHeld('bow-draw-loose', [{ hand: 'L', kind: 'bow' }])).toBe(false)
    expect(mirrorForHeld('shield-block-face', [{ hand: 'R', kind: 'shield' }])).toBe(true)
    expect(mirrorForHeld('moonwalk', [{ hand: 'L', kind: 'blade' }])).toBe(false)
  })

  for (const gun of ['prop.rifle', 'prop.shotgun']) {
    for (const hand of ['L', 'R'] as Hand[]) {
      it(`rifle-aim-fire with a ${gun} in the ${hand} hand: level barrel, stock in the shoulder, support hand on the gun (six bodies)`, () => {
        for (const body of BODIES) {
          const person = load(body)
          const { weaponId } = useStore.getState().spawnHeldWeapon(gun, person.id, hand)
          expect(weaponId, body).toBeDefined()
          useStore.getState().applyMotionToEntities([person.id], 'rifle-aim-fire')
          const st = stateAt(person.id, 0.6)
          const dims = personDims(body)
          const spec = weaponSpec(gun)!
          const dir = aimDirectionLocal(dims, st.joints, hand, spec)
          expect(deg(Math.acos(Math.min(1, -dir.z))), `${body} barrel off forward`).toBeLessThanOrEqual(3)
          const butt = heldPointLocal(dims, st.joints, hand, spec, spec.stock!, 1)
          expect(len(sub(butt, poseEffectors(dims, st.joints)[hand === 'R' ? 'shoulderR' : 'shoulderL'])), `${body} stock`).toBeLessThanOrEqual(0.06)
          const reach = supportReach(dims, st.joints, hand, spec, 1)
          expect(len(sub(handFrame(dims, st.joints, hand === 'R' ? 'L' : 'R').p, reach.point)), `${body} support hand`).toBeLessThanOrEqual(0.01)
        }
      })
    }
  }

  it('sword-slash-combo with a sword in the left hand swings the left arm; in the right, the right', () => {
    const slash = MOTION_PRESETS.find((m) => m.id === 'sword-slash-combo')!.keyframes.find((kf) => kf.t === 0.4)!.joints
    for (const hand of ['L', 'R'] as Hand[]) {
      const person = load('person.man')
      useStore.getState().spawnHeldWeapon('prop.sword', person.id, hand)
      useStore.getState().applyMotionToEntities([person.id], 'sword-slash-combo')
      const track = useStore.getState().scene()!.blocking[0]!.tracks.find((t) => t.entityId === person.id)!
      const mark = track.marks.find((m) => Math.abs(m.time - 0.4) < 1e-9)!
      expect(mark.joints![`shoulder${hand}X`], hand).toBeCloseTo(slash.shoulderRX!, 9)
      expect(mark.joints![`elbow${hand}`], hand).toBeCloseTo(slash.elbowR!, 9)
    }
  })
})

describe('unheld weapons rest on the floor', () => {
  it('every weapon model’s lowest point is at y = 0 ± 2 mm, and grip / tip stay on the model', () => {
    expect(WEAPON_SPECS).toHaveLength(12)
    for (const w of WEAPON_SPECS) {
      const box = new Box3().setFromObject(buildAsset(w.assetId).group)
      expect(Math.abs(box.min.y), `${w.assetId} lowest point ${box.min.y.toFixed(4)}`).toBeLessThanOrEqual(0.002)
      for (const p of [w.grip, w.tip, ...(w.support ? [w.support] : []), ...(w.stock ? [w.stock] : [])]) {
        expect(p.y, `${w.assetId} point inside the model`).toBeGreaterThanOrEqual(box.min.y - 0.01)
        expect(p.y, `${w.assetId} point inside the model`).toBeLessThanOrEqual(box.max.y + 0.01)
      }
    }
  })
})
