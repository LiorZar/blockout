/**
 * Shot words box (fork addition; see MODIFICATIONS.md): type "MCU on B, over
 * A's right shoulder, 50mm" — or pick the same from dropdowns — and the camera
 * mark at the playhead is framed live from the subjects' positions.
 */

import { useState } from 'react'
import { useStore } from '../store'
import { LENS_SET, SHOT_SIZES } from '@engine/camera'
import { parseShotWords } from '@engine/shot-words'
import type { ShotAngle, ShotSide, ShotSpec } from '@engine/shot'
import type { CameraMark, Scene, Shot, ShotSizeId } from '@engine/types'

const SIDES: { id: ShotSide; label: string }[] = [
  { id: 'front', label: 'Front' },
  { id: 'frontRight', label: '3/4 right' },
  { id: 'right', label: 'Right (profile)' },
  { id: 'backRight', label: 'Back right' },
  { id: 'back', label: 'Behind' },
  { id: 'backLeft', label: 'Back left' },
  { id: 'left', label: 'Left' },
  { id: 'frontLeft', label: '3/4 left' },
  { id: 'line', label: 'Side-on to the line' }
]

const ANGLES: { id: ShotAngle; label: string }[] = [
  { id: 'eye', label: 'Eye level' },
  { id: 'low', label: 'Low angle' },
  { id: 'high', label: 'High angle' },
  { id: 'overhead', label: 'Overhead' },
  { id: 'ground', label: 'Ground level' }
]

const nameOf = (scene: Scene, id: string): string => {
  const e = scene.entities.find((x) => x.id === id)
  return e ? e.label?.text || e.name : '(deleted)'
}

/** Shot words for a spec, e.g. "MCU on B, over A's right shoulder, 50mm". */
export function shotSummary(spec: ShotSpec, scene: Scene): string {
  const parts = [`${spec.size} on ${spec.subjectIds.map((id) => nameOf(scene, id)).join(' and ')}`]
  if (spec.over) parts.push(`over ${nameOf(scene, spec.over.entityId)}'s ${spec.over.shoulder} shoulder`)
  if (spec.side) parts.push(SIDES.find((s) => s.id === spec.side)!.label.toLowerCase())
  if (spec.angle && spec.angle !== 'eye') parts.push(ANGLES.find((a) => a.id === spec.angle)!.label.toLowerCase())
  if (spec.lens) parts.push(`${spec.lens}mm`)
  if (spec.dutchDeg) parts.push(`dutch ${spec.dutchDeg}°`)
  return parts.join(', ')
}

/** Shown instead of the pose fields when a camera mark is framed by shot words. */
export function ShotLockNote({ scene, mark }: { scene: Scene; mark: CameraMark }): JSX.Element {
  const releaseShot = useStore((s) => s.releaseShot)
  if (!mark.shot) return <></>
  const ids = [...mark.shot.subjectIds, ...(mark.shot.over ? [mark.shot.over.entityId] : [])]
  const missing = ids.some((id) => !scene.entities.some((e) => e.id === id))
  return (
    <div style={{ marginBottom: 8 }}>
      {missing && (
        <p style={{ color: 'var(--danger, #e5484d)', fontSize: 11, lineHeight: 1.4, marginBottom: 6 }}>
          A subject of these shot words was deleted — the camera holds this mark&apos;s stored pose. Re-frame or Release.
        </p>
      )}
      <p style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1.4, marginBottom: 6 }}>
        Framed by shot words: {shotSummary(mark.shot, scene)}. Position and aim follow the subjects every frame.
      </p>
      <button
        className="btn"
        style={{ width: '100%' }}
        onClick={() => releaseShot(mark.id)}
        title="Drop the shot words and keep the pose they solve to now, as ordinary editable numbers"
      >
        Release
      </button>
    </div>
  )
}

export function ShotPanel({ scene, shot }: { scene: Scene; shot: Shot }): JSX.Element {
  const time = useStore((s) => s.time)
  const setShotAtTime = useStore((s) => s.setShotAtTime)
  const people = scene.entities
  const [words, setWords] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState<ShotSizeId>('MCU')
  const [subjectA, setSubjectA] = useState('')
  const [subjectB, setSubjectB] = useState('')
  const [over, setOver] = useState('')
  const [side, setSide] = useState<ShotSide | ''>('')
  const [angle, setAngle] = useState<ShotAngle | ''>('')
  const [lens, setLens] = useState<number | ''>('')
  const [dutch, setDutch] = useState(0)

  const apply = (spec: ShotSpec, at: number): void => {
    const id = setShotAtTime(spec, at)
    setError(id ? null : 'That shot could not be solved — a subject is missing.')
  }

  const applyWords = (): void => {
    const r = parseShotWords(
      words,
      scene.entities.map((e) => ({ id: e.id, name: e.name, label: e.label?.text }))
    )
    if ('error' in r) {
      setError(r.error)
      return
    }
    apply(r.spec, r.time ?? time)
  }

  const applyFields = (): void => {
    const a = subjectA || people[0]?.id
    if (!a) {
      setError('Add someone to the scene to frame.')
      return
    }
    const spec: ShotSpec = { size, subjectIds: subjectB && subjectB !== a ? [a, subjectB] : [a] }
    if (over) {
      const [entityId, shoulder] = over.split(':') as [string, 'left' | 'right']
      if (spec.subjectIds.includes(entityId)) {
        setError("The over-the-shoulder person can't also be the subject.")
        return
      }
      spec.over = { entityId, shoulder }
    }
    if (side) spec.side = side
    if (angle) spec.angle = angle
    if (lens !== '') spec.lens = lens
    if (dutch) spec.dutchDeg = dutch
    apply(spec, time)
  }

  const label = (id: string): string => nameOf(scene, id)
  return (
    <div className="panel-section">
      <div className="panel-title">Shot</div>
      <div className="field">
        <input
          type="text"
          value={words}
          placeholder="MCU on B, over A's right shoulder, 50mm"
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyWords()
          }}
        />
      </div>
      <button className="btn primary" style={{ width: '100%', marginBottom: 8 }} onClick={applyWords} disabled={!words.trim()}>
        Apply at playhead
      </button>
      {error && <p style={{ color: 'var(--danger, #e5484d)', fontSize: 11, lineHeight: 1.4, marginBottom: 8 }}>{error}</p>}
      <div className="field-row">
        <div className="field" style={{ flex: 1 }}>
          <label>Size</label>
          <select value={size} onChange={(e) => setSize(e.target.value as ShotSizeId)}>
            {Object.values(SHOT_SIZES).map((s) => (
              <option key={s.id} value={s.id} title={s.name}>
                {s.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Lens</label>
          <select value={lens} onChange={(e) => setLens(e.target.value ? Number(e.target.value) : '')}>
            <option value="">camera lens</option>
            {LENS_SET.map((fl) => (
              <option key={fl} value={fl}>
                {fl}mm
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field" style={{ flex: 1 }}>
          <label>Subject</label>
          <select value={subjectA} onChange={(e) => setSubjectA(e.target.value)}>
            {people.map((e) => (
              <option key={e.id} value={e.id}>
                {label(e.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>and</label>
          <select value={subjectB} onChange={(e) => setSubjectB(e.target.value)}>
            <option value="">— single —</option>
            {people.map((e) => (
              <option key={e.id} value={e.id}>
                {label(e.id)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Over shoulder</label>
        <select value={over} onChange={(e) => setOver(e.target.value)}>
          <option value="">none</option>
          {people.flatMap((e) => [
            <option key={`${e.id}:left`} value={`${e.id}:left`}>
              {label(e.id)} L
            </option>,
            <option key={`${e.id}:right`} value={`${e.id}:right`}>
              {label(e.id)} R
            </option>
          ])}
        </select>
      </div>
      <div className="field-row">
        <div className="field" style={{ flex: 1 }}>
          <label>Side</label>
          <select value={side} onChange={(e) => setSide(e.target.value as ShotSide | '')}>
            <option value="">auto</option>
            {SIDES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Angle</label>
          <select value={angle} onChange={(e) => setAngle(e.target.value as ShotAngle | '')}>
            <option value="">eye level</option>
            {ANGLES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Dutch (°)</label>
          <input type="number" step={1} value={dutch} onChange={(e) => setDutch(Number(e.target.value) || 0)} />
        </div>
      </div>
      <button className="btn" style={{ width: '100%' }} onClick={applyFields} disabled={people.length === 0}>
        Apply fields at playhead
      </button>
      <p style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1.4, marginTop: 8 }}>
        Frames the camera mark at the playhead on {shot.name}, or adds one. The framing holds while the subjects move.
      </p>
    </div>
  )
}
