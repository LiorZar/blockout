/**
 * Live shot marks (fork addition; see MODIFICATIONS.md). A camera mark that
 * carries `shot` is re-solved from the subjects' live positions on every
 * frame, so an MCU stays an MCU while the subject moves. Between two marks
 * the two poses — solved or stored — blend with the same smoothstep of the
 * eased progress that plain camera marks use.
 *
 * PURE: the solver is passed in; no DOM / three.js / Electron.
 */

import { easedProgress, lerp, lerpAngle, smoothstep } from './easing'
import type { SolvedShot } from './shot'
import type { CameraMark, V3 } from './types'

export interface ShotTrackPose {
  position: V3
  pan: number
  tilt: number
  roll: number
  focalLength: number
  focusDistance?: number
}

/** The marks around `time`: `to` is null while holding; `active` is the mark that drives the pose. */
export function shotTrackSegment(
  marks: CameraMark[],
  time: number
): { from: CameraMark; to: CameraMark | null; u: number; active: CameraMark } {
  const sorted = [...marks].sort((a, b) => a.time - b.time)
  const first = sorted[0]!
  if (sorted.length === 1 || time <= first.time) return { from: first, to: null, u: 0, active: first }
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!
    const to = sorted[i + 1]!
    // Same hold truncation as the plain evaluator's legs.
    const depart = Math.min(from.time + from.hold, Math.max(from.time, to.time - 0.1))
    const arrive = Math.max(to.time, depart + 0.001)
    if (time < depart) return { from, to: null, u: 0, active: from }
    if (time <= arrive) {
      const u = smoothstep(easedProgress((time - depart) / (arrive - depart), from.easeOut, to.easeIn))
      return { from, to, u, active: to }
    }
  }
  const last = sorted[sorted.length - 1]!
  return { from: last, to: null, u: 0, active: last }
}

function poseOf(m: CameraMark, solve: (m: CameraMark) => SolvedShot | null): ShotTrackPose {
  const solved = m.shot ? solve(m) : null
  if (solved) {
    return {
      position: solved.position,
      pan: solved.pan,
      tilt: solved.tilt,
      roll: solved.roll,
      focalLength: solved.focalLength,
      focusDistance: m.focusDistance
    }
  }
  return {
    position: m.position,
    pan: m.pan,
    tilt: m.tilt,
    roll: m.roll,
    focalLength: m.focalLength,
    focusDistance: m.focusDistance
  }
}

export function evaluateShotTrack(
  marks: CameraMark[],
  time: number,
  solve: (m: CameraMark) => SolvedShot | null
): ShotTrackPose {
  const seg = shotTrackSegment(marks, time)
  const a = poseOf(seg.from, solve)
  if (!seg.to) return a
  const b = poseOf(seg.to, solve)
  const u = seg.u
  const f0 = a.focusDistance
  const f1 = b.focusDistance
  return {
    position: {
      x: lerp(a.position.x, b.position.x, u),
      y: lerp(a.position.y, b.position.y, u),
      z: lerp(a.position.z, b.position.z, u)
    },
    pan: lerpAngle(a.pan, b.pan, u),
    tilt: lerpAngle(a.tilt, b.tilt, u),
    roll: lerpAngle(a.roll, b.roll, u),
    focalLength: lerp(a.focalLength, b.focalLength, u),
    focusDistance: f0 !== undefined && f1 !== undefined ? lerp(f0, f1, u) : (f1 ?? f0)
  }
}
