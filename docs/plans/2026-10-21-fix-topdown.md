# fix-topdown: byte-identical top-down diagrams (and every export render)

**Goal.** `tests/e2e/mcp-gaps.spec.ts` "a selection never reaches the top-down blocking diagram" fails at line 515: two `export_shot` top-downs of the same unselected scene differ. Find the cause, fix it in the renderer export path, keep the test's assertions.

## Root cause (probe evidence in `.maestro/fix-topdown/`)

- The failing PNGs differ in one pixel, (664, 410), red 63 vs 64. Every failed run since 2026-10-20 shows the same two images, alternating at random.
- At render time, every matrix, material, uniform and the camera hash the same, and the shadow map reads back byte-identical, yet the output still flips (`probe.mjs`, `probe3.mjs`).
- The flip needs three things together: the export canvas's MSAA (`antialias: false`: 40/40 stable), the overlay grid line at y = 0 (`noGrid`: 40/40), and the transparent shadow catcher drawn after the grid over that line's antialiased edge (`catcherFirst`: 40/40). Hiding the stage, turning off people's shadow receiving or the grid's depth write does not help (`probe4.mjs`, `probe5.mjs`).
- Forcing a `gl.flush()`, `gl.finish()` or 1-pixel `readPixels` between the grid draw and the catcher draw gives the "alternate" image 40/40 (`probe6.mjs`). So with MSAA, a draw that blends over an earlier draw's antialiased edge gives a result that depends on whether a GL flush falls between the two draws (Chrome, ANGLE D3D11, RTX 3070 Ti). Chrome flushes the command buffer mid-frame on its own, at points that depend on timing and on how full the buffer is.
- An explicit 4x MSAA `WebGLRenderTarget` does not help. Encoded like the canvas (sRGB, RGBA8), it gives the canvas's two images byte for byte and flips the same way: a forced flush after the grid gives the alternate 30/30 (`probe7.mjs`). A first probe that looked stable rendered linear output, where the one-level difference rounded away. Without MSAA the output stays stable even with a forced `finish` after the grid.
- A flush after every draw gives one image, 60/60, unchanged by an extra forced `finish` after the grid or after every draw, at about +20% render time in the probe (`probe8.mjs`).
- The Mixamo library is not involved: the spec already runs on an empty `BLOCKOUT_CONFIG_DIR`, and the first 1-pixel failure (2026-10-20 10:37) predates `60d776e`.

## My calls

- Fix all export renders (`renderFrameAt`, the clip, stills and passes, plus `renderTopDown`), not only the top-down. The clip has the same exposure wherever a blended draw lands on an antialiased edge.
- New file `src/renderer/viewport/stable-render.ts`: `renderStable` wraps `renderBufferDirect` for one render so GL flushes after every draw. I chose this over supersampling without MSAA, which would change the antialiasing of every exported frame and cost about 4x the fill. Pixels move by at most one level, and only where a later draw blends over an antialiased edge.
- Keep `renderFrameAt`'s double render (AGENTS.md).

## Tasks

1. A failing e2e test: `tests/e2e/export-flush.spec.ts` flushes GL after every draw and asserts the top-down and a clean frame are unchanged. → verify: red on the current build.
2. `stable-render.ts`, hooked into `renderFrameAt` and `renderTopDown`. → verify: export-flush green.
3. `mcp-gaps.spec.ts` alone 3x without the library and 3x with it. → verify: 30 passed each run.
4. Gate, smoke, fork e2e set (mcp-gaps, fight-camera, mannequin, weapons, mocap-bots, export-flush). → verify: `Test Files` line, pass counts.
5. `MODIFICATIONS.md` entry, BACKLOG item `DONE`. Stage only.
