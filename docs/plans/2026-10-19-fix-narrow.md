# fix-narrow: Blockout stays usable docked beside Clara (gap 15)

**Goal:** at 650–950 px (Blockout docked beside Clara) the viewport is the
largest area, the titlebar stays on one line, and the Library / Inspector are
one click away. Nothing changes at or above the breakpoint.

## Measurements (current build, stage / shoot / deliver, 600–1400 px)

`.maestro/fix-narrow/measure.json`, screenshots `.maestro/fix-narrow-visual/before-*.png`:

- The docked panels take a fixed 464 px (Library 200 + Inspector 264), so the
  viewport's share is `1 − 464 / W`: 29 % at 650, 42 % at 800, 51 % at 950,
  54 % at 1000, 58 % at 1100 (Blockout's own minimum width).
- Below 1000 px the viewport's overlays stack up: the Stage HUD goes from 2 to
  3 rows (and a single column below 800), and the Shoot tool stack grows from
  242 px tall to 304 (950), 459 (800) and 674 (650, the whole viewport).
- The titlebar's natural width is ~636 px with "Clara" and ~668 px with
  "Close Clara", so it wraps at 650 once Clara is docked.
- Deliver: the 380 px panel leaves the preview 42 % at 650.

## My calls

- **Breakpoint 1000 px** (narrow below 1000): above it the docked viewport is
  ≥ 536 px / 54 % and its HUD and tools sit as designed; below it the
  viewport falls to half the window and its overlays stack. It covers the
  whole docked range (650–950) and never fires at Blockout's own minimum
  width (1100), so without Clara nothing changes.
- **Narrow layout:** the viewport (and the Shoot timeline) take the full
  width. The left panel (Scenes & shots + Library) and the Inspector become
  overlays over the viewport's edges, closed by default, opened by two
  titlebar toggles (◧ left, ◨ right). Both may be open at once. The left
  overlay closes itself when a placement starts (Library item, sequence,
  choreography) so the floor is clickable.
- **Titlebar:** the brand name hides, the project name ellipsizes, the mode
  switch tightens, "? Help" becomes "?", buttons never wrap. Save, Help and
  Clara keep their place.
- **Deliver:** its panel is the mode's purpose (settings + Export), so it
  stays docked and narrows to `clamp(280px, 40vw, 380px)`; the preview stays
  the largest area (57 % at 650). No toggles in Deliver.
- The narrow stylesheet is a new fork file (`src/renderer/narrow.css`)
  imported from `styles.css`; every rule is scoped to `.app.narrow`.

## Tasks

1. e2e `tests/e2e/narrow-layout.spec.ts` (red first): at 650 / 800 / 950 /
   1400 px in Stage, Shoot and Deliver, assert the viewport's share, a
   one-line titlebar (every child one line tall and inside the bar, worst
   case "Close Clara"), Help and Clara reachable, and that the toggles open
   the Library and Inspector (absent at 1400). Screenshots to
   `.maestro/fix-narrow-visual/`.
   → verify: fails on the current build.
2. `src/renderer/layout/narrow.ts` (`NARROW_MAX_WIDTH`, `useNarrowLayout`),
   `App.tsx` layout hook, `narrow.css`.
   → verify: the spec passes; look at every screenshot.
3. Gate, smoke, `MODIFICATIONS.md`, BACKLOG item marked done.
   → verify: `npm run typecheck && npm run lint && npm test` and smoke green.
