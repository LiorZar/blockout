/**
 * Fight coverage with clear views (fork addition, main-thread; see
 * MODIFICATIONS.md): coverage.ts's framings, each given a clear view of the
 * set and cast over the time it drives (camera-clear.ts), as one pure
 * function of its inputs, so the fight worker can work it out
 * (renderer/fight-offthread.ts, coverage-memo.ts). Moved here from
 * renderer/camera-view.ts (fix-camera-set, shot-clear); the set's boxes
 * come in as data (renderer/fight-obstacles.ts `cameraBoxes`).
 *
 * PURE: no DOM / three.js / Electron.
 */

import { clearShotWords, sampleStore, type SetBox } from '../camera-clear'
import type { ShotSpec } from '../shot'
import type { FightDoc, Scene, Shot } from '../types'
import { MOVE_S, fightCoverage, type CoverageMark, type CoverageMode } from './coverage'
import type { FightSolution } from './solve'

export interface CoverageInput {
  /** Each fighter's longest held weapon, grip to business end (m; 0 unarmed). */
  reach: [number, number]
  /** The lens coverage starts from (camera-clear.ts baseLens). */
  focalLength: number
  /** The set, as the camera sees it. */
  boxes: SetBox[]
}

export type CoverageArgs = [scene: Scene, shot: Shot, fight: FightDoc, report: FightSolution['report'], mode: CoverageMode, lineSide: 1 | -1, input: CoverageInput]

/**
 * Fight coverage's `clear` option: each framing clear over its span. Fork (shot-clear): each framing is checked from
 * the start of the move into it (coverage moves over the MOVE_S before a framing's time), when the camera is already
 * on its way to it. An over-the-shoulder beat with no clear view (it can only rise: a bus shelter's roof over the
 * shoulder) becomes the medium two-shot on the same side of the line, which can come closer, rise or swing. Fork
 * (main-thread): the framings sample the same shot, so each frame is evaluated and posed once for all of them.
 */
export function coverageClearer(scene: Scene, shot: Shot, focalLength: number, boxes: SetBox[]): (spec: ShotSpec, span: [number, number]) => ShotSpec {
  const samples = sampleStore(scene, shot, boxes)
  return (spec, span) => {
    const s: [number, number] = [Math.max(0, span[0] - MOVE_S), Math.min(span[1], shot.duration)]
    const asked = clearShotWords(scene, shot, spec, s, focalLength, boxes, samples).spec
    if (!spec.over || !spec.lineIds || !asked.view?.noClearView) return asked
    const two: ShotSpec = { size: 'MS', subjectIds: [...spec.lineIds], side: 'line', lineIds: spec.lineIds, ...(spec.lineSide ? { lineSide: spec.lineSide } : {}) }
    const alt = clearShotWords(scene, shot, two, s, focalLength, boxes, samples).spec
    return alt.view?.noClearView ? asked : alt
  }
}

/** A fight's coverage marks, every framing with a clear view. */
export function clearCoverage(...[scene, shot, fight, report, mode, lineSide, input]: CoverageArgs): CoverageMark[] {
  return fightCoverage(fight, report, mode, lineSide, { reach: input.reach, clear: coverageClearer(scene, shot, input.focalLength, input.boxes) })
}
