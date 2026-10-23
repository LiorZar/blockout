/**
 * Export limits of a generator profile (fork addition; see MODIFICATIONS.md):
 * the warnings Deliver and export_shot show when a shot breaks a model's
 * limits, and the encoder bitrate ceiling that keeps a clip under the
 * model's file-size cap.
 *
 * PURE: no DOM / three.js / Electron.
 */

import type { GeneratorProfile } from './profiles'
import type { AspectId } from './types'

/** VBV buffer in seconds of maxrate: worst case ≈ maxrate × (duration + BUFFER_S). */
const BUFFER_S = 2
/** Share of the cap left to the encoder; the rest is container and rounding headroom. */
const HEADROOM = 0.9

/**
 * libx264 `-maxrate` (kbit/s) that keeps a clip of `durationS` under the
 * profile's `maxFileMB` (10^6 bytes) even for content CRF can't compress;
 * undefined when the profile has no file cap. Use with `-bufsize` = 2 × it.
 */
export function encoderMaxKbps(profile: GeneratorProfile, durationS: number): number | undefined {
  if (!profile.maxFileMB) return undefined
  const bits = profile.maxFileMB * 8e6 * HEADROOM
  return Math.floor(bits / (Math.max(0, durationS) + BUFFER_S) / 1000)
}

/** Plain-language warnings for a shot that breaks the profile's limits (empty when it fits); fps defaults to the profile's. */
export function profileWarnings(profile: GeneratorProfile, shot: { duration: number; aspect: AspectId; fps?: number }): string[] {
  const out: string[] = []
  const tooLong = profile.maxDuration !== undefined && shot.duration > profile.maxDuration + 1e-9
  if (tooLong) {
    out.push(
      `Shot is ${shot.duration.toFixed(1)} s but ${profile.name} takes at most ${profile.maxDuration} s — shorten the shot or the model will reject or cut the clip.`
    )
  }
  if (profile.minDuration !== undefined && shot.duration < profile.minDuration - 1e-9) {
    out.push(
      `Shot is ${shot.duration.toFixed(1)} s but ${profile.name} needs at least ${profile.minDuration} s — lengthen the shot or the model will reject the clip.`
    )
  }
  // A long shot that a lower tier still takes: name the tier to pick.
  const caps = profile.resolutionCaps ?? []
  if (!tooLong && caps.length > 1 && shot.duration > caps[0]!.maxDuration + 1e-9) {
    const fits = caps.find((c) => shot.duration <= c.maxDuration + 1e-9)
    if (fits) {
      out.push(
        `${profile.name} takes about ${caps[0]!.maxDuration} s at ${caps[0]!.label} — pick ${fits.label} for this ${shot.duration.toFixed(1)} s shot (up to ~${fits.maxDuration} s).`
      )
    }
  }
  const frames = Math.max(1, Math.round(shot.duration * (shot.fps ?? profile.fps)))
  if (!tooLong && profile.maxFrames !== undefined && frames > profile.maxFrames) {
    out.push(
      `Shot is ${frames} frames (${shot.duration.toFixed(1)} s at ${shot.fps ?? profile.fps} fps) but ${profile.name} takes at most ${profile.maxFrames} frames — shorten the shot or lower its frame rate.`
    )
  }
  if (!profile.aspects.includes(shot.aspect)) {
    out.push(`${profile.name} doesn't list ${shot.aspect} — use ${profile.aspects.join(', ')}.`)
  }
  return out
}
