/**
 * Fork (fix-topdown): an export render whose pixels don't depend on where the
 * browser flushes GL.
 *
 * With antialiasing on, a draw that blends over an earlier draw's antialiased
 * edge comes out one level different when the GL command stream is flushed
 * between the two draws (ANGLE / D3D11; the canvas and a multisampled render
 * target alike), and Chrome flushes mid-frame at points that depend on timing.
 * So the top-down diagram's shadow catcher over a grid line differed between
 * two exports of one scene. A flush after every draw puts one at every point
 * the browser could pick, so its own flushes change nothing. Evidence:
 * docs/plans/2026-10-21-fix-topdown.md.
 */

import type * as THREE from 'three'

/** `renderer.render(scene, camera)` with a GL flush after every draw. */
export function renderStable(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera): void {
  const draw = renderer.renderBufferDirect
  const gl = renderer.getContext()
  renderer.renderBufferDirect = function (this: THREE.WebGLRenderer, ...args: Parameters<THREE.WebGLRenderer['renderBufferDirect']>): void {
    draw.apply(this, args)
    gl.flush()
  }
  try {
    renderer.render(scene, camera)
  } finally {
    renderer.renderBufferDirect = draw
  }
}
