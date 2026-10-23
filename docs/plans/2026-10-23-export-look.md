# export-look: the exported clip looks like the editor, the night cast reads, three more model profiles

Lane `export-look`, coordinator `crd2`, base `edf6dc0`. Brief: `.maestro/handoffs/worker-export-look.md`.
Probes, frames and the sheet: `.maestro/export-look/`.

## Goal

1. An export's clean pass is the viewport's picture: same tone mapping (ACES) and exposure (1.45), applied once. Data passes (depth, normal) stay linear.
2. On the night preset the cast reads against the set and the frame still reads as night.
3. Export profiles for LTX 2.3 Render to Real, Kling V3 Omni and Seedance 2.5, built like the H3 Max profile.

## My calls

- **T1, one look for both renderers.** A fork file `src/renderer/viewport/look.ts` holds the viewport's tone mapping and exposure; the viewport and the export renderer both take it. `renderFrameAt` gives the export renderer the look for the clean pass and `NoToneMapping` for depth / normal (both passes' shaders skip tone mapping anyway; this keeps them linear if a material ever changes), and restores it afterwards. The top-down diagram and stills render with the look, like the viewport.
- **T1, the sky.** `toneMapSky` added a hand-written ACES only when the renderer had none (exports). With the export renderer tone-mapping, that branch is dead and is removed; the sky keeps its exposure scale (`SKY_EXPOSURE`) and gets ACES once, from three's own chunk. The gradient dome writes raw sRGB with no tone-mapping chunk, so it stays exact in both.
- **T1, how "matches the viewport" is measured.** The viewport is put in Deliver mode (letterboxed shot camera, no overlay), nothing selected. A hook on the viewport renderer reads back the frame the live loop just drew for the shot camera (`readPixels`, exact viewport rect), and the export frame is rendered at the same pixel size. Metrics: mean luminance (Rec. 709, 0–255), mean absolute RGB difference, and 7×7-patch probes at fixed spots. **Tolerance: mean luminance within 2 levels, every probe within 6 levels per channel** (AA, shadow-map and 0.1 % aspect rounding between two renderers).
- **T2, the fix.** Decided after T1's numbers: preferred a cool, shadowless fill from the shot camera's side (a directional light at the camera, aimed along its view), on the night preset only, because a raised ambient lifts the ground and the walls as much as the cast and the frame stops reading as night. Measured on the cast's silhouette (depth pass with and without the cast) against the rest of the frame.
- **T3, limits.** CLAUDE.md's table, plus the model pages where it is silent (sources in the T3 notes). New optional fields `minDuration`, `maxFrames` and `resolutionCaps` (per output tier); `profileWarnings` uses them. The clip itself exports at 720p for all three (the models set their own output size; LTX keeps the source aspect).

## Tasks

### T1 — exports get the viewport's tone mapping (`BACKLOG.md:21`)
- Test first: `tests/e2e/export-look.spec.ts`: day street, export frame vs viewport frame within the tolerance; a physical-sky scene the same (the sky isn't tone-mapped twice); the depth pass equals a depth render with tone mapping forced off.
- Targets: on day street, gym fight, nightclub (and midday physical sky), export vs viewport mean luminance within 2 levels and probes within 6; depth frames byte-identical before/after; double export byte-identical (smoke); `export-flush` and `export-editor-only` pass.

### T2 — the night cast reads (`BACKLOG.md:22`)
- Measure after T1 on a night street export: cast mean luminance, background mean luminance, their ratio, before and after.
- Target (set from the T1 baseline, stated in the report): cast/background ratio ≥ 2, the background's mean within +15 % of before so it stays night. Look at the frames.

### T3 — LTX 2.3 Render to Real, Kling V3 Omni, Seedance 2.5 profiles (`BACKLOG.md:42`)
- Unit test first: `tests/unit/profiles-models.test.ts` (limits, warnings for min / max duration, frame cap, 720p tier, prompt clause).
- Profile data, warnings, `list_export_profiles` fields, `mcp/tools.json` profileId text, `docs/generator-profiles.md`, `mcp/README.md`, AGENTS.md row; prompt notes where they differ. Never start a Scenario generation.

## Done when
Before/after numbers per task; `.maestro/export-look/SHEET.png` looked at; one full gate (`Test Files`), smoke, the fork e2e set (`mcp-gaps`, `fight-camera`, `mannequin`, `weapons`, `mocap-bots`, `export-flush`, `mocap-race`, `export-editor-only`, plus `export-look`) with `--workers=1`, all through the lock; MODIFICATIONS entry; each task staged alone and reported.

## Calls made on the way

- **T2, the fill.** Swept intensity 0–3.2 × drop 0–0.6 rad on a night street (classic man, mannequin woman, both bots; `.maestro/export-look/tune-a`, `tune-b`). Every drop lifts the cast far more than the street; a bigger drop lights more ground. Chosen: drop 0.05 rad (3°), intensity 0.9: cast / rest of frame 0.81 → 2.78, rest +11 %, darkest body (classic man) 1.95× the rest. Targets kept: ratio ≥ 2, every body ≥ 1.5×, rest ≤ +15 %.
- **T3, Seedance 2.5's cap.** Scenario makes 4–30 s and "Auto" matches the longest reference clip; the reference-clip cap isn't published. 15 s is kept (Seedance 2.0's reference cap) until a longer reference is confirmed; `minDuration` 4.
- **T3, Kling's prompt cap.** 2500 characters (Kling's API limit; Scenario doesn't publish one).
- **T3, look images.** LTX's optional first-frame image and Kling's reference images are finished looks, so `refModes` is the video only; the grey first-frame still would pull the render back to grey.

## Finding: exports are not bit-stable on this GPU stack (pre-existing; T1 makes it show more)

On this machine (ANGLE D3D11, RTX 3070 Ti), a render's float results move by 1 ulp while the page composites anything (the viewport, a CSS animation, a visible canvas), for ~2.2 s after it stops; idle, repeated renders are bit-stable. 8-bit output flips ±1 on a handful of pixels: about 2 values per 1080p frame with no tone mapping, about 9 with ACES. The edf6dc0 build's exports already differ between runs at the raw level (2 of 2 runs, the first ~1 s of some exports); with ACES the difference sometimes survives x264 (day street: 1 frame of 48, ≤ 3 levels, ~170 pixels). `.maestro/export-look/det*.mjs`.

## T4: the export-flush flake (crd2's ruling: keep T1, log the finding, make the spec exact)

- `export-flush.spec.ts:109` compares a plain and a flushed render of one frame taken a moment apart while the live viewport draws, so the finding above flips a value now and then (about 1 run in 3 on HEAD per crd2; my probe, 40 repeats: edf6dc0 0/40, HEAD 0/40 as the test does it, 2/40 with both renders in one task, 0/40 on a settled page). ACES raises the rate; the mechanism predates it.
- Option (b), a quiet export (stop the viewport, wait 2.5 s, no progress repaint while rendering), made double exports worse: raw frames 0–25 differed between exports every time (stage and Deliver mode) and the mp4s in every frame. The first ~1 s of heavy rendering after an idle gap varies as well. Dropped.
- A settled page (viewport stopped, 2.5 s wait) didn't fix the spec either: the real spec failed 5 of 6 runs with it, 4 of 6 at HEAD (the wait adds the warm-up transition).
- Fix: the spec brackets each comparison with a plain frame on either side of the flushed one (viewport stopped). If the two plain frames differ, the GPU moved during the comparison and it is taken again (up to 8 times); if they match, the flushed frame must match exactly. 8 of 8 runs pass.
