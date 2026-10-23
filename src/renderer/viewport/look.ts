/**
 * Fork (export-look): the picture's look, shared by the viewport and the
 * export renderer, so a clip exports as the editor shows it.
 *
 * The viewport tone-maps with ACES at exposure 1.45; the export renderer used
 * to apply none, so exports came out flatter and darker than the editor (only
 * the physical sky was compensated, by hand). Both renderers now take the look
 * from here, and three applies it once, in each material's own shader. The
 * depth and normal passes are data, not pictures: they render with no tone
 * mapping (their shaders carry none either), so they stay linear.
 */

import * as THREE from 'three'
import type { RenderPass } from './SceneManager'

export const VIEW_TONE_MAPPING: THREE.ToneMapping = THREE.ACESFilmicToneMapping
export const VIEW_EXPOSURE = 1.45

/** Give a renderer the viewport's tone mapping and exposure. */
export function applyViewLook(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = VIEW_TONE_MAPPING
  renderer.toneMappingExposure = VIEW_EXPOSURE
}

/** For one export pass: the clean plate keeps the renderer's look, a data pass gets none. Returns the restore. */
export function lookForPass(renderer: THREE.WebGLRenderer, pass: RenderPass): () => void {
  const was = renderer.toneMapping
  if (pass !== 'clean') renderer.toneMapping = THREE.NoToneMapping
  return (): void => {
    renderer.toneMapping = was
  }
}
