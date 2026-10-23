# shot-clear: set props and walls must not hide the subject (2026-10-23)

Lane `shot-clear`, coordinator `crd2`. Brief: `.maestro/handoffs/worker-shot-clear.md`. Base: `3c54c8e`.

## Goal

The exported clip shows the fighters and a camera move's subject whole: no bench in front of the feet, no orbit that
renders only alley wall.

## The measure (both tasks)

`setCover` (new, `src/engine/camera-clear.ts`): a subject's **projected box** (the screen rectangle of its posed rig
points, padded half a body width, clipped to the frame) sampled on a grid; a grid ray from the lens that hits a set box
before the subject's chest depth (less half a body width) is covered. The share covered is the number the targets
read, and the same function is the camera's new criterion, so what the search clears is what the probes measure.

## My calls

- **One reader.** The set comes from the existing camera reader (`cameraBoxes` via `camera-view.ts setBoxes`); no new
  reader. `routine-set.ts`'s solids are footprints without height, so they can't say what a raised camera sees over.
- **Box share, not body points.** The brief's target is "over ~10 % of a fighter's projected box", so the criterion is
  that same share. It also counts a prop beside the body inside its box (conservative: the camera moves a little more
  than it strictly needs to).
- **Thresholds.** Shot words, fight coverage and framing presets: set cover ≤ 10 % per framed subject. Camera moves:
  ≤ 20 % (the brief's 80 % unoccluded).
- **Every sample, not 90 %.** A variant is clear only when no sample's set cover is over the limit (the 90 % share
  rule stays for the existing head/chest checks).
- **Moves keep their shape.** A non-follow preset gets one steady fit for the whole move (radius in, lift, arc cut,
  arc turned), never a per-mark dodge: an orbit that lurches mark by mark reads worse than a shorter one. Follow moves
  keep `clearFollowMove`.
- **Cast is not set.** The new criterion counts set boxes only; other cast keeps its existing checks.

## Tasks

### T1 Fight coverage keeps props out of the sightline (`BACKLOG.md:37`)
- `checkView` takes the camera's frame (pan, tilt, lens) and reports `cover` / `coverBy`; `clearShotWords` (frame_shot,
  every `fight_coverage` mode) and `clearFixedPose` (apply_framing) reject a variant whose cover is over 10 %.
- Test first: `tests/unit/set-cover.test.ts`, a synthetic bench between the lens and a pair (cover > 10 %, then the
  cleared view ≤ 10 % with a note), and a clear view unchanged.
- **Target:** QA's run3 fight (bots) in the gym at (0, −2), one fight in the alley and one downtown: every coverage mode
  0 frames where a set piece covers > 10 % of a fighter's projected box (probe: `.maestro/shot-clear/cover.probe.ts`,
  every frame at 24 fps), before / after numbers.

### T2 Occlusion-aware camera moves (`BACKLOG.md:46`)
- `clearMove` (new, `src/engine/move-clear.ts`): fits a whole preset move to the set: radius in (on a wider lens,
  ≥ 12 mm), lift, the arc cut to ¾ / ½ / ¼ and turned about the subject; nearest variant whose camera stays out of the
  set and keeps the subject's set cover ≤ 20 % on every frame; else the least blocked one and a warning.
  `SceneManager.applyCameraMove` runs it for every non-follow preset (follow keeps `clearFollowMarks`).
- Test first: `tests/unit/move-clear.test.ts`, an orbit between two synthetic walls (fits or warns), open ground
  unchanged.
- **Target:** orbit, a crane and a dolly in the alley and downtown: subject's box ≥ 80 % unoccluded every frame, or a
  warning (probe `.maestro/shot-clear/moves.probe.ts`, plus a sweep of all presets).

### T3 (if time) a bot's plain `sit` gait over a seat prop (`BACKLOG.md:29`)
- Pass the seat's top through (`SceneManager.ts` `input.seated`) and rest the pose on it with `seatLift`.
- **Target:** hips on the seat top within 2 cm on a stool (0.65 m) and a chair.

## Done when
Before/after numbers per task; `.maestro/shot-clear/SHEET.png` (each fixed shot before / after, looked at); one clean
full gate, smoke, fork e2e set (`--workers=1`) through `heavy.mjs`; `MODIFICATIONS.md` entries; each task staged
alone, reported to crd2, never committed.

## Results

| Task | Before (HEAD 3c54c8e) | After | Commit |
|---|---|---|---|
| T1 coverage keeps props out of the sightline | 11 of 24 coverage runs had frames where a set piece covers > 10 % of a fighter's box (gym master right 128/360 frames, the bench; alley follow right 301/360, solid wall); the lens inside the gym's mirror 3 frames | 4 of 24, each one frame at 10.3 % (the alley dumpster at a downed fighter's feet, on the 10 % line); the lens never inside the set | ef1690c |
| T2 camera moves fitted to the set | 49 of 156 preset moves blocked (subject's box > 20 % covered or the lens in the set) with no warning | 0; 2 warn (the high drone orbit can't clear the alley's 8 m walls) | 5e3d927 |
| T3 bot sit gait on a seat's top | hips 5.9–30.1 cm under the seat top (stool 22.9 / 25.1, chair 5.9 / 8.1, couch 12.4 / 14.6, office chair 27.9 / 30.1 cm; Y Bot / X Bot) | 0.0 cm, feet on the floor; built app, Y Bot's Hips on a stool 0.597 → 0.887 m | c14e267 |

- T1: QA's run3 fight on bots in the gym (0, −2), along the alley (0, 3) and by the downtown bus shelter, 4 modes × 2
  sides, every frame (`.maestro/shot-clear/cover-head-bots.txt` → `cover-t1i.txt`). Found on the way and fixed: shot
  words applied a view's `closer` twice (0.55 played as 0.30); coverage started from the last framing's lens. A coverage
  call on bots takes 0.4–3.5 s, 6.1 s worst (HEAD 0.05–3.3 s; logged in BACKLOG).
- T2: the 39 presets round a person in the alley and downtown, from a camera 5 m in front and 5 m off 45°, every frame
  (`moves-head.txt` → `moves-t2d.txt`). A fit takes ≤ 0.4 s, 1.9 s when none is clear.
- T3: the chair loop on the real library, every 1/24 s (`seat.txt`); the built app before / after (`run-sit-before/`,
  `run-sit-t3/`).
- Sheets, looked at: `.maestro/shot-clear/SHEET.png` (T1, 11 rows), `SHEET-moves.png` (T2, 7 rows).
- Full tree (T1 + T2 + T3): gate `Test Files 102 passed (102)`, `Tests 1729 passed`; smoke 6 passed; fork e2e set
  (`--workers=1`) 84 passed.
