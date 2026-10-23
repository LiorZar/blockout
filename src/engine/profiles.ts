// Modified in this fork (2026): MiniMax H3 Max, LTX 2.3 Render to Real, Kling V3 Omni and Seedance 2.5 profiles, maxFileMB / maxPromptChars / promptStyle / minDuration / maxFrames / resolutionCaps; see MODIFICATIONS.md.
/**
 * Generator profiles — data, not code. Each profile describes how a target
 * AI generator consumes references and constrains exports (duration,
 * resolution), plus prompt guidance. Updating a model is a config edit.
 * Users can add profiles as JSON in the project's profiles/ folder.
 */

import type { AspectId } from './types'

export type RefMode = 'firstFrame' | 'lastFrame' | 'referenceVideo' | 'depthVideo' | 'stills'

export interface GeneratorProfile {
  id: string
  name: string
  vendor: string
  kind: 'video' | 'image'
  /** Hard per-clip duration cap in seconds (video models). */
  maxDuration?: number
  recommendedDuration?: number
  aspects: AspectId[]
  /** Export resolution (longest edge) that suits the model. */
  exportWidth: number
  fps: number
  /** Which reference inputs the model consumes, in priority order. */
  refModes: RefMode[]
  /** Sentence explaining how to attach the reference, shown in Deliver. */
  attachHint: string
  /** Extra prompt clause instructing the model to follow the reference. */
  adherenceClause: string
  /** Fork: the model's input-video size cap (MB); the encoder caps its bitrate to fit (profile-limits.ts). */
  maxFileMB?: number
  /** Fork: the model's prompt length cap (characters); the prompt trims its scene sections to fit. */
  maxPromptChars?: number
  /** Fork: 'previs' ends the prompt with this profile's adherenceClause (the clip IS the input video). */
  promptStyle?: 'previs'
  /** Fork: the model's shortest clip (s); a shorter shot gets a warning. */
  minDuration?: number
  /** Fork: the model's frame cap for the input video; a shot with more frames (duration × its fps) gets a warning. */
  maxFrames?: number
  /** Fork: output tiers whose length cap depends on the resolution, largest first; the last one's cap is maxDuration. */
  resolutionCaps?: { label: string; maxDuration: number }[]
}

export const BUILTIN_PROFILES: GeneratorProfile[] = [
  {
    id: 'seedance-2',
    name: 'Seedance 2.0',
    vendor: 'ByteDance',
    kind: 'video',
    maxDuration: 10,
    recommendedDuration: 5,
    aspects: ['16:9', '9:16', '4:3', '1:1'],
    exportWidth: 1920,
    fps: 24,
    refModes: ['referenceVideo', 'firstFrame'],
    attachHint:
      'Attach the reference MP4 as the motion/video reference and the first-frame still as the image reference.',
    adherenceClause:
      'Precisely match the camera movement, framing, and subject blocking of the attached reference video. Keep subject positions, screen direction, and timing identical to the reference.'
  },
  // Fork: the model built for this job — a grey-box previs clip in, the finished shot out (CLAUDE.md).
  {
    id: 'minimax-h3-max',
    name: 'MiniMax H3 Max',
    vendor: 'MiniMax',
    kind: 'video',
    maxDuration: 15,
    recommendedDuration: 10,
    aspects: ['16:9', '9:16', '1:1'],
    exportWidth: 1920,
    fps: 24,
    refModes: ['referenceVideo', 'firstFrame'],
    attachHint:
      'Attach the reference MP4 as the video input of H3 Max (≤ 15 s, ≤ 50 MB; the output is as long as the clip) and paste prompt.txt; look references go in as images.',
    adherenceClause:
      'The attached video is a grey-box 3D previs of this shot. Keep its layout, where every subject stands and how it moves, the camera path, framing and lens, and the timing exactly. Render each placeholder shape as the subject named above, with real materials, lighting and detail, and add nothing that is not in the previs.',
    maxFileMB: 50,
    maxPromptChars: 2000,
    promptStyle: 'previs'
  },
  // Fork: the other video-input models on Scenario (CLAUDE.md), the clip as the render they restyle or follow.
  {
    id: 'ltx-2.3-render-to-real',
    name: 'LTX 2.3 Render to Real',
    vendor: 'Lightricks',
    kind: 'video',
    maxDuration: 15,
    recommendedDuration: 6,
    aspects: ['16:9', '9:16', '4:3', '1:1', '2.39:1'],
    exportWidth: 1280,
    fps: 24,
    refModes: ['referenceVideo'],
    attachHint:
      'Attach the reference MP4 as the video input of LTX 2.3 Render to Real and paste prompt.txt; pick 720p for a clip up to ~6 s, 480p up to ~15 s (≤ 361 frames). The optional first-frame image is a finished look, not the grey still.',
    adherenceClause:
      'The attached video is a grey-box 3D render of this shot. Turn it into real footage: keep every shape where it is and how it moves, the camera path, framing and lens, and the timing exactly, and give each placeholder shape the real look of the subject named above.',
    promptStyle: 'previs',
    maxFrames: 361,
    resolutionCaps: [
      { label: '720p', maxDuration: 6 },
      { label: '480p', maxDuration: 15 }
    ]
  },
  {
    id: 'kling-v3-omni',
    name: 'Kling V3 Omni',
    vendor: 'Kuaishou',
    kind: 'video',
    minDuration: 3,
    maxDuration: 10,
    recommendedDuration: 5,
    aspects: ['16:9', '9:16', '1:1'],
    exportWidth: 1920,
    fps: 24,
    refModes: ['referenceVideo'],
    attachHint:
      'Attach the reference MP4 as the reference video of Kling V3 Omni with the type "base" (3–10 s) and paste prompt.txt; up to 7 look images go in as reference images. Kling follows the camera loosely, so the prompt names the camera move.',
    adherenceClause:
      'The attached base video is a grey-box 3D previs of this shot. Restyle it into the finished shot: keep its layout, where every subject stands and how it moves, and the timing. Keep the camera exactly as in the base video, the same path, framing and lens, with no camera move of your own. Render each placeholder shape as the subject named above.',
    maxPromptChars: 2500,
    promptStyle: 'previs'
  },
  {
    id: 'seedance-2.5',
    name: 'Seedance 2.5',
    vendor: 'ByteDance',
    kind: 'video',
    minDuration: 4,
    maxDuration: 15,
    recommendedDuration: 10,
    aspects: ['16:9', '9:16', '4:3', '1:1'],
    exportWidth: 1280,
    fps: 24,
    refModes: ['referenceVideo'],
    attachHint:
      'Attach the reference MP4 as one of the reference videos of Seedance 2.5 (up to 3) and paste prompt.txt; leave the duration on Auto so it matches the clip. It guides the camera and motion rather than locking them, so the prompt spells out the action and the camera move.',
    adherenceClause:
      'Precisely match the camera movement, framing, and subject blocking of the attached reference video. Keep subject positions, screen direction, and timing identical to the reference.'
  },
  {
    id: 'veo-3.1',
    name: 'Veo 3.1',
    vendor: 'Google',
    kind: 'video',
    maxDuration: 8,
    recommendedDuration: 8,
    aspects: ['16:9', '9:16'],
    exportWidth: 1920,
    fps: 24,
    refModes: ['firstFrame', 'referenceVideo'],
    attachHint: 'Use the first-frame still as the image input; describe the camera move in the prompt.',
    adherenceClause:
      'Follow the exact camera move and subject blocking described below, matching the attached reference frame composition at the start.'
  },
  {
    id: 'kling-2',
    name: 'Kling 2.x',
    vendor: 'Kuaishou',
    kind: 'video',
    maxDuration: 10,
    recommendedDuration: 5,
    aspects: ['16:9', '9:16', '1:1'],
    exportWidth: 1920,
    fps: 24,
    refModes: ['firstFrame', 'lastFrame', 'referenceVideo'],
    attachHint:
      'Use first-frame and last-frame stills as start/end frames; the reference video guides motion where supported.',
    adherenceClause:
      'Animate from the attached start frame to the attached end frame, matching the camera move and subject motion of the reference exactly.'
  },
  {
    id: 'ltx-2.3',
    name: 'LTX 2.3',
    vendor: 'Lightricks',
    kind: 'video',
    maxDuration: 10,
    recommendedDuration: 6,
    aspects: ['16:9', '9:16', '1:1'],
    exportWidth: 1280,
    fps: 24,
    refModes: ['depthVideo', 'referenceVideo', 'firstFrame'],
    attachHint:
      'Use the depth-pass MP4 as a depth/structure conditioning video (ComfyUI workflow included in the export).',
    adherenceClause:
      'Adhere to the depth-video structure: camera trajectory, subject silhouettes, and motion timing must match the conditioning video.'
  },
  {
    id: 'wan-2.2',
    name: 'Wan 2.2',
    vendor: 'Alibaba',
    kind: 'video',
    maxDuration: 8,
    recommendedDuration: 5,
    aspects: ['16:9', '9:16', '1:1'],
    exportWidth: 1280,
    fps: 16,
    refModes: ['depthVideo', 'referenceVideo', 'firstFrame'],
    attachHint:
      'Use the depth or reference video as VACE/control input in ComfyUI (workflow included in the export).',
    adherenceClause:
      'Match the control video: identical camera path, subject blocking, and motion timing.'
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    vendor: 'OpenAI',
    kind: 'image',
    aspects: ['16:9', '9:16', '4:3', '1:1'],
    exportWidth: 1536,
    fps: 24,
    refModes: ['stills'],
    attachHint: 'Attach the mark stills and top-down diagram as image references for composition.',
    adherenceClause:
      'Match the composition, lens feel, and subject placement of the attached reference still exactly.'
  },
  {
    id: 'nano-banana',
    name: 'Nano Banana',
    vendor: 'Google',
    kind: 'image',
    aspects: ['16:9', '9:16', '4:3', '1:1'],
    exportWidth: 1536,
    fps: 24,
    refModes: ['stills'],
    attachHint: 'Attach a mark still as the composition reference.',
    adherenceClause: 'Keep the exact framing and subject placement of the attached reference image.'
  },
  {
    id: 'ideogram',
    name: 'Ideogram',
    vendor: 'Ideogram',
    kind: 'image',
    aspects: ['16:9', '9:16', '4:3', '1:1'],
    exportWidth: 1536,
    fps: 24,
    refModes: ['stills'],
    attachHint: 'Attach a mark still as a style/composition reference.',
    adherenceClause: 'Match the composition of the reference image.'
  },
  {
    id: 'krea-2',
    name: 'Krea 2',
    vendor: 'Krea',
    kind: 'image',
    aspects: ['16:9', '9:16', '4:3', '1:1'],
    exportWidth: 1536,
    fps: 24,
    refModes: ['stills'],
    attachHint: 'Use a mark still as the image reference with high adherence strength.',
    adherenceClause: 'Match the reference composition and subject placement.'
  }
]

export function getProfile(id: string, extra: GeneratorProfile[] = []): GeneratorProfile {
  return (
    extra.find((p) => p.id === id) ??
    BUILTIN_PROFILES.find((p) => p.id === id) ??
    BUILTIN_PROFILES[0]!
  )
}
