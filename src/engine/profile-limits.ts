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

/** Plain-language warnings for a shot that breaks the profile's limits (empty when it fits). */
export function profileWarnings(profile: GeneratorProfile, shot: { duration: number; aspect: AspectId }): string[] {
  const out: string[] = []
  if (profile.maxDuration !== undefined && shot.duration > profile.maxDuration + 1e-9) {
    out.push(
      `Shot is ${shot.duration.toFixed(1)} s but ${profile.name} takes at most ${profile.maxDuration} s — shorten the shot or the model will reject or cut the clip.`
    )
  }
  if (!profile.aspects.includes(shot.aspect)) {
    out.push(`${profile.name} doesn't list ${shot.aspect} — use ${profile.aspects.join(', ')}.`)
  }
  return out
}
