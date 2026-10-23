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
