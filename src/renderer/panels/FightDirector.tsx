/**
 * Fight Director (fork addition; see MODIFICATIONS.md): write a fight blow by
 * blow — "A jab cross to head -> block, hit" — and stage it. The solver lands
 * every blow on its frame, times the defenses and shapes the knockback; the
 * report lists each beat's contact error and reaction.
 */

import { useMemo, useState } from 'react'
import { fightNotice, slowFight, solveInScene, stageFightOffThread, updateFightOffThread, useStore } from '../store'
import type { BeatReport } from '@engine/fight/solve'
import { assetSpec } from '@engine/assets'
import { WEAPON_SPECS } from '@engine/weapons'
import { formatFightScript, parseFightScript, randomFightScript } from '@engine/fight/script'
import type { FightDoc, Scene } from '@engine/types'
import { bodySets, useMocapLoaded, type BodySetId } from '../mocap/library'

const STYLES: { id: 'brawl' | 'martial-arts' | 'sparring'; name: string }[] = [
  { id: 'sparring', name: 'Sparring' },
  { id: 'brawl', name: 'Brawl' },
  { id: 'martial-arts', name: 'Martial arts' }
]

const COVERAGE: { id: NonNullable<FightDoc['coverage']> | ''; name: string }[] = [
  { id: '', name: 'No camera' },
  { id: 'master', name: 'Master (wide two-shot)' },
  { id: 'punch-in', name: 'Punch in on big hits' },
  { id: 'over-shoulder', name: 'Over the shoulder' },
  { id: 'follow', name: 'Handheld follow' }
]

const EXAMPLE = `A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to body -> ko power 1`

const randomSeed = (): number => Math.floor(Math.random() * 1_000_000)

function labelsOf(scene: Scene, fight: FightDoc | undefined): [string, string] {
  if (!fight) return ['A', 'B']
  const name = (id: string, fallback: string): string => {
    const e = scene.entities.find((x) => x.id === id)
    return e?.label?.text || fallback
  }
  return [name(fight.fighterIds[0], 'A'), name(fight.fighterIds[1], 'B')]
}

/** One report row: "3 · A hook-punch → head · hit · 1.2 cm · stagger 0.31 m". */
function beatRow(fight: FightDoc, b: BeatReport, labels: [string, string]): string {
  const beat = fight.beats[b.index]!
  const outcomes = beat.outcomes.join(', ')
  const errors = b.contactErrorM.map((e) => `${(e * 100).toFixed(1)} cm`).join(' / ')
  const ph = b.physics.map((p) =>
    p.result === 'stagger' ? `stagger ${p.stepBack.toFixed(2)} m` : p.result === 'knockdown' ? `down, slides ${p.slide.toFixed(2)} m` : p.result
  )
  const lift = Math.max(0, ...b.liftM)
  const hop = lift > 0 ? ` · hops ${lift.toFixed(2)} m` : ''
  return `${b.index + 1} · ${labels[beat.attacker]} ${beat.move} → ${beat.target} · ${outcomes} · ${errors} · ${ph.join(' / ')}${hop}`
}

export function FightDirector(): JSX.Element {
  const scene = useStore((s) => s.scene())
  const shot = useStore((s) => s.shot())
  const selection = useStore((s) => s.selection)
  const placing = useStore((s) => s.placingChoreography)
  const armFightPlacement = useStore((s) => s.armFightPlacement)
  const setPlacing = useStore((s) => s.setPlacingChoreography)
  const stageFight = useStore((s) => s.stageFight)
  const updateFight = useStore((s) => s.updateFight)
  const toast = useStore((s) => s.toast)

  const fights = scene?.fights ?? []
  const [fightId, setFightId] = useState<string>('')
  const fight = fights.find((f) => f.id === fightId) ?? fights[fights.length - 1]
  const labels = scene ? labelsOf(scene, fight) : (['A', 'B'] as [string, string])

  const [script, setScript] = useState<string>(() => (fight && scene ? formatFightScript(fight.beats, labelsOf(scene, fight)) : EXAMPLE))
  const [style, setStyle] = useState<(typeof STYLES)[number]['id']>('sparring')
  const [ending, setEnding] = useState<'ko' | 'standing'>('ko')
  const [seed, setSeed] = useState(randomSeed)
  const [exaggeration, setExaggeration] = useState(fight?.exaggeration ?? 1.5)
  // A new fight comes with a master camera (one click, camera included); a staged one keeps its own.
  const [coverage, setCoverage] = useState<NonNullable<FightDoc['coverage']> | ''>(fight ? (fight.coverage ?? '') : 'master')
  // Fork: Mocap bodies by default once the library has loaded (until picked).
  const mocapLoaded = useMocapLoaded()
  const { sets: bodyChoices, preferred } = bodySets(mocapLoaded)
  const [pickedBodies, setBodies] = useState<BodySetId | null>(null)
  const bodies = pickedBodies && bodyChoices.some((b) => b.id === pickedBodies) ? pickedBodies : preferred
  const [arms, setArms] = useState<[string, string]>(['', ''])

  const parsed = parseFightScript(script, labels)
  const selected =
    selection?.kind === 'entities'
      ? selection.entityIds.filter((id) => scene?.entities.find((e) => e.id === id)?.assetId.startsWith('person.'))
      : []

  // Live report for the staged fight (pure; re-solved when the scene changes, set props included).
  const report = useMemo(() => {
    if (!fight || !scene || !shot) return null
    if (fight.fighterIds.some((id) => !scene.entities.some((e) => e.id === id))) return null
    return solveInScene(scene, shot, fight).report
  }, [fight, scene, shot])

  if (!scene || !shot) return <></>

  const settings = (): { exaggeration: number; coverage?: NonNullable<FightDoc['coverage']> } => ({
    exaggeration,
    ...(coverage ? { coverage } : {})
  })
  // Weapons for Stage fight / Apply to 2 selected ('' keeps a fighter as it is).
  const weapons = (): { weapons?: [string | null, string | null] } =>
    arms[0] || arms[1] ? { weapons: [arms[0] || null, arms[1] || null] } : {}

  const onRandom = (): void => {
    const beats = randomFightScript(seed, style, shot.duration, { ending })
    setScript(formatFightScript(beats, labels))
  }

  const onStage = (): void => {
    if ('error' in parsed) return
    if (placing) {
      setPlacing(null)
      return
    }
    const assets = bodyChoices.find((b) => b.id === bodies)?.assets
    armFightPlacement({ beats: parsed.beats, ...settings(), ...weapons(), ...(assets ? { assets } : {}) })
  }

  const onApplySelected = (): void => {
    if ('error' in parsed || selected.length !== 2) return
    const ents = selected.map((id) => scene.entities.find((e) => e.id === id)!)
    const at = {
      x: (ents[0]!.transform.position.x + ents[1]!.transform.position.x) / 2,
      z: (ents[0]!.transform.position.z + ents[1]!.transform.position.z) / 2,
      heading: 0
    }
    const input = { beats: parsed.beats, at, fighters: [selected[0]!, selected[1]!] as [string, string], ...settings(), ...weapons() }
    const staged = (r: { fightId: string; report: { beats: unknown[] } }): void => {
      setFightId(r.fightId)
      toast(`Fight staged on the 2 selected: ${r.report.beats.length} beats.`, 'success')
    }
    const failed = (e: Error): void => toast(e.message, 'error')
    // Mocap fights (fork): a bot fight's solve takes seconds; say so first (fork, fight-speed: and solve it off the main thread).
    if (slowFight(input)) void fightNotice('Staging fight…').then(() => stageFightOffThread(input)).then(staged, failed)
    else {
      try {
        staged(stageFight(input))
      } catch (e) {
        failed(e as Error)
      }
    }
  }

  const onResolve = (): void => {
    if ('error' in parsed || !fight) return
    const patch = { beats: parsed.beats, ...settings(), ...(coverage ? {} : { coverage: undefined }) }
    const failed = (e: Error): void => toast(e.message, 'error')
    // Fork (fight-speed): a bot fight re-solves off the main thread.
    if (slowFight({ fightId: fight.id })) void fightNotice('Re-solving fight…').then(() => updateFightOffThread(fight.id, patch)).then(undefined, failed)
    else {
      try {
        updateFight(fight.id, patch)
      } catch (e) {
        failed(e as Error)
      }
    }
  }

  return (
    <div className="fight-director">
      {fights.length > 1 && (
        <div className="field">
          <label>Fight</label>
          <select
            value={fight?.id ?? ''}
            onChange={(e) => {
              const f = fights.find((x) => x.id === e.target.value)
              setFightId(e.target.value)
              if (f) setScript(formatFightScript(f.beats, labelsOf(scene, f)))
            }}
          >
            {fights.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>Script — one blow per line: who move [to head|body|legs] [-&gt; outcomes] [power p] [at t s]</label>
        <textarea
          value={script}
          rows={6}
          spellCheck={false}
          style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 11, width: '100%', resize: 'vertical' }}
          onChange={(e) => setScript(e.target.value)}
        />
      </div>
      {'error' in parsed && (
        <p style={{ color: 'var(--danger, #e5484d)', fontSize: 11, lineHeight: 1.4, marginBottom: 8 }}>{parsed.error}</p>
      )}
      <div className="field-row">
        <div className="field" style={{ flex: 2 }}>
          <label>Random style</label>
          <select value={style} onChange={(e) => setStyle(e.target.value as typeof style)}>
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Ending</label>
          <select value={ending} onChange={(e) => setEnding(e.target.value as 'ko' | 'standing')}>
            <option value="ko">KO</option>
            <option value="standing">Standing</option>
          </select>
        </div>
      </div>
      <div className="field-row" style={{ gap: 6, marginBottom: 8 }}>
        <input
          type="number"
          style={{ flex: 1 }}
          value={seed}
          title="Seed"
          onChange={(e) => {
            const v = Number(e.target.value)
            if (!Number.isNaN(v)) setSeed(Math.max(0, Math.round(v)))
          }}
        />
        <button className="btn small" title="Reroll the seed" onClick={() => setSeed(randomSeed())}>
          🎲
        </button>
        <button className="btn small" onClick={onRandom} title="Write a random fight into the script box (for the shot's length)">
          Random
        </button>
      </div>
      <div className="field">
        <label>Exaggeration ×{exaggeration.toFixed(1)}</label>
        <input type="range" min={1} max={3} step={0.1} value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))} />
      </div>
      <div className="field">
        <label>Weapons (A / B)</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {([0, 1] as const).map((q) => (
            <select
              key={q}
              value={arms[q]}
              title={`What ${q === 0 ? 'A' : 'B'} fights with: blows land with the blade or point, "shoot" fires a gun. Empty keeps what they hold.`}
              onChange={(e) => setArms(q === 0 ? [e.target.value, arms[1]] : [arms[0], e.target.value])}
            >
              <option value="">{q === 0 ? 'A' : 'B'}: as is</option>
              {WEAPON_SPECS.map((w) => (
                <option key={w.assetId} value={w.assetId}>
                  {assetSpec(w.assetId).name}
                </option>
              ))}
            </select>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Bodies</label>
        <select
          value={bodies}
          title="What Stage fight spawns: the classic capsule people, the sculpted mannequins or the Mixamo mocap bots (male A, female B). Apply to 2 selected keeps their bodies."
          onChange={(e) => setBodies(e.target.value as BodySetId)}
        >
          {bodyChoices.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Camera coverage</label>
        <select value={coverage} onChange={(e) => setCoverage(e.target.value as typeof coverage)}>
          {COVERAGE.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <button
        className={`btn primary${placing ? ' active' : ''}`}
        style={{ width: '100%', marginBottom: 6 }}
        disabled={'error' in parsed}
        onClick={onStage}
        title="Arm placement, then click the floor: two fighters (A and B) are staged there, facing each other. Esc cancels. One undo step."
      >
        {placing ? '⟳ Click the floor to place… (Esc cancels)' : '🥊 Stage fight'}
      </button>
      <button
        className="btn"
        style={{ width: '100%', marginBottom: 6 }}
        disabled={'error' in parsed || selected.length !== 2}
        onClick={onApplySelected}
        title="Fight with the two selected people (keeps their look and spots)"
      >
        Apply to 2 selected
      </button>
      {fight && (
        <button className="btn" style={{ width: '100%', marginBottom: 6 }} disabled={'error' in parsed} onClick={onResolve}>
          Re-solve {fight.name}
        </button>
      )}
      {report && fight && (
        <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
          {report.beats.map((b) => (
            <div key={b.index} style={{ marginBottom: 2 }}>
              {beatRow(fight, b, labels)}
              {b.warnings.map((w) => (
                <div key={w} style={{ color: 'var(--warning, #f5a524)' }}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          ))}
          {report.warnings
            .filter((w) => !report.beats.some((b) => b.warnings.includes(w)))
            .map((w) => (
              <div key={w} style={{ color: 'var(--warning, #f5a524)' }}>
                ⚠ {w}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
