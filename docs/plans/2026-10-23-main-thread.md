# main-thread: bot fights stop stalling the editor (2026-10-23)

Lane `main-thread`, coordinator `crd3`. Brief: `.maestro/handoffs/worker-main-thread.md`. Base: HEAD `c14e267`
(`22e4cd3` docs only). Probes and harnesses in `.maestro/main-thread/` (frozen sources `base/` = HEAD, `pre/` =
`3c54c8e`, before shot-clear T1; `cover.probe.ts` is shot-clear's cover probe with timings, repeats, profiles and every
call's camera marks dumped; `diag.spec.ts` drives a snapshot's built app). Every timing is quoted with the CPU load.

## What the profiles show (before any change)

- **Coverage** (`cover.probe.ts`, `base` vs `pre`, two runs each, load 20–72 %): pre-T1 0.06–0.42 s on a "left" call,
  1.25–3.26 s on a "right" one; HEAD 0.41–1.45 s and 1.80–6.35 s. Every "right" call re-solves the whole fight
  (`solveFight` 1.1 s of gym master right's 3.1 s): `coverFight` sets `fight.coverage`, the solve memo's key holds the
  whole `FightDoc`, and the solver never reads `coverage`. The rest is the per-frame check shot-clear added:
  gym master left 408 ms = `poseEffectors` 244 ms (each sample's bots posed four times: `castWorld`, `subjectTargets`,
  `coverPoints`, `solveShot`'s `bodyOf`), `setCover` 80 ms, the evaluator 32 ms. In the app a `fight_coverage` call
  runs the whole search twice on the main thread (`offThread`'s planning run, then the real one), and the Fight
  Director stages with coverage `master` by default, so Stage pays it too.

## My calls

1. **The solve memo's key leaves out `coverage`.** The solver never reads it (`grep` over `engine/fight/`), so a
   solution doesn't depend on it; the coverage modes then re-solve nothing.
2. **Exact caches, nothing approximated.** The coverage search keeps its every-frame rule. A sample's subjects are
   posed once (one `poseEffectors` per subject object, shared by the cast spheres, the targets, the cover outline and
   the shot solve), a `checkAt(t, variant)` is computed once per search, and one sampler serves all of a coverage's
   framings. Same inputs, same arithmetic: the camera marks byte-equal.
3. **The coverage search runs in the fight worker.** Like the solves (fight-speed): an engine memo of a coverage's
   framings keyed by everything they read (scene, shot, fight, report, mode, side, reach, lens, set boxes); a miss in
   a planning run goes to the worker, which has the engine and the same bots; the real run hits. Main-thread cost of
   a coverage: the keys, the clones and the commit. The set's boxes are read on the main thread (they come off built
   geometry) and travel as data.
4. Commit frame, BoxHelper, Deliver: decided from their own profiles (below), one fix each.
5. **T2: share, don't rebuild, and spend the one-off costs while idle.** Marks share their tape per colour and number
   per index (time labels per text and colour), made by the builders' own functions and cloned, so they look as
   before. Programs: compiled (`compileAsync`) and taken into use (`getUniforms`, which links) in idle slices, once per
   renderer and fog, for the overlay, the selection box and the gizmo: this app has no parallel shader compile, so
   `compileAsync` alone only moved the stall. Loop warps: measured for both bots in idle slices once the library is in
   (a pure cache, the same numbers). Exact speedups only (`contactLow` per-bone points).
6. **Profiles are lined up on a marker.** The diag's `p0` came from a CDP round trip after `Profiler.start` (off by
   120–280 ms under load, which put the commit's work in the wrong task); a named 3 ms busy loop at a known page time
   now lines them up (`prof-align.mjs`).
7. **T3: the box stays three's, to the bit; only its costs go.** The export's depth range and the top-down fit read
   `computeBoundingBox`, so no approximate hull: the same arithmetic in the same order over each distinct vertex
   (FBX repeats each point per face), bind-space positions and nonzero weights packed once per skin, and an affine
   bone's divide by exactly 1 skipped (x·1 is x). Checked against three's own on the real bots and the fixture.
8. **T4: one Viewport, kept mounted, instead of a cheaper SceneManager constructor.** Deliver's task was a whole new
   SceneManager (first render's program links 125 ms, shadow map setup, `syncFromStore` 32 ms, TransformControls 9,
   WebGLRenderer 8). The Viewport renders once into a host element (a portal); each mode's place holds a slot the host
   moves into (`display: contents`, the layout unchanged). Side effect: the free camera keeps its view across Deliver
   (it reset to (9, 7, 9) before).
9. **Coverage: the marks' views are solved with the framings, in the worker.** Skipping the view solve in offThread's
   planning run (the first form of this unit) only moved the cost: the 56 ms was the bots' per-clip hips cache
   (`hipsShare`) filling on the session's first view solve, which the real run then paid. The coverage memo carries
   each mark's solved view (`withViews`), so the main thread solves none in either run.

## Tasks and targets

1. **T1 fight coverage cost** (`BACKLOG.md:38`).
   - Target: every case of `cover-t1i.txt` (24: run3 on bots, gym / alley / downtown × 4 modes × 2 sides) at or under
     its pre-T1 time on the same load: (a) synchronously (Vitest, no worker) for the "right" calls, which pre-T1 paid a
     re-solve; (b) the main-thread part with the search in the worker for every call; camera marks of all 24 equal to
     HEAD's (`cmp.mjs`, ids normalized). In the app: MCP `fight_coverage` on a bot fight, no main-thread task over
     100 ms.
   - Checks: `tests/unit/fight-solve-memo.test.ts` (a coverage-only change hits), a new coverage-memo test (fails
     first), `fight-offthread.test.ts` (a coverage in the stand-in worker equals the one here, nothing searched here),
     the probe before / after, `fight-worker` e2e.
2. **T2 staging commit frame** (`BACKLOG.md:39`). Target: no main-thread task over 100 ms from MCP `stage_fight` to the
   first settled frame (5 frame intervals in a row under 50 ms), with and without coverage (`diag.spec.ts`; the
   fight-worker e2e asserts it).
3. **T3 selected bot BoxHelper** (`BACKLOG.md:40`). Target: Stage with 4 bots playing, the two fighters selected,
   median frame within 2 ms of none selected; the box still the posed skin's (unit test against three's own skinned
   box).
4. **T4 Deliver switch** (`BACKLOG.md:42`). Profile first. Target: no main-thread task over 100 ms from the switch to
   the prompt.
5. **Done**: before / after per task on the same load; one clean full gate (`Test Files`), smoke, the fork e2e set
   (`--workers=1`, the lock); `MODIFICATIONS.md`; BACKLOG items `DONE`. Each task staged alone and reported.

## Results

- **T1** (snapshot of `22e4cd3` + the T1 files, the lock; `.maestro/main-thread/t1-table.txt`, `t1-verify-heavy.log`):
  coverage calls on QA's run3 bot fight, 24 cases, load 18–65 %, ms (pre-T1 / HEAD / now on one thread / now on the
  main thread with the search in the worker): gym master left 52 / 429 / 186 / 44, gym master right 1328 / 3149 / 349
  / 37, alley master right (the worst) 1704 / 6262 / 759 / 37, downtown over-shoulder left 68 / 702 / 214 / 44; all
  24: pre-T1 52–3313, HEAD 429–6262, one thread 145–759, main thread 37–51 (+124–613 in the worker). Every case's
  main-thread share is under its pre-T1 time; on one thread the 12 "right" calls and 3 "left" are under it, the
  other 9 "left" calls (pre-T1 52–132 ms, no every-frame check then) take 145–289 ms. Camera marks of all 24 equal
  to HEAD's in both modes (`cmp.mjs`). The 29 fight solutions byte-equal to HEAD's. Built app (`diag.spec.ts`), MCP
  `fight_coverage` on the combos fight: HEAD one 937–1290 ms task, now no task over 50 ms before the commit (calls
  370–509 ms); the commit itself, 173–223 ms, is the overlay's mark rebuild and the selected bots' boxes (T2, T3).
  An export of a bot fight with punch-in coverage: reference and depth mp4 equal to HEAD's (8d1a3b01…, fa74c7ab…).
  Typecheck, lint, `Test Files 103 passed (103)`; smoke `6 passed`; e2e mocap-bots + fight-camera + fight-worker
  `35 passed`.
- **T2** (snapshots of `387a8b3` / `c945991` + the T2 files, the built app, `diag.spec.ts`; MCP `stage_fight` of the
  combos fight, the commit task + the first frame's, ms):
  - Before (HEAD with T1, `t1e`, load 26–57 %): 207 + 298; with coverage master 190 + 198. Aligned profiles of the
    same work: the commit = `rebuildOverlay` (`markMesh` ×~800: canvases, materials), `applyTime`'s first evaluate
    measuring the bots' loop warps (`measureWarp` 44–49 ms), the selected bots' boxes (three's skinning of every
    vertex); the first frame = programs linked on first use (`getProgramInfoLog` 55–99 ms).
  - T2 alone (`t2d`, load 42–66 %): 180 + 97 (+ 50); with coverage 154 + 124. What is left over 100 ms is the selection
    box's per-vertex skinning in the commit (three's `computeBoundingBox`, 20 + 28 ms in one commit): T3.
  - T2 + T3 (`t3d`, two runs, load 56–87 %): 89 + 59 and 86 + 63; with coverage 77 + 72 and 72 + 75. No program
    linked at the staging (`new programs: none`, `getProgramInfoLog` gone from the frame), `applyTime` 49 → 5 ms.
    Then 86–112 ms over four more runs (`t3e`, `t4a`, load 32–77 %): a session's first ~400 mark numbers are
    canvases (`markMesh` 19–29 ms) in the commit. **My call:** past 24 new numbers in one task, the rest are made 48
    an idle slice and join their marks (still shown) a moment later; an edit's few new numbers stay at once.
  - T2 + T3 with that (`t3f`, two runs, load 36–93 %): 74 + 59 and 70 + 54. Fight-worker e2e (T3's assertion):
    70 + 89. Still in the commit: the time labels of the selected lanes (`labelSprite`, 13–18 ms), the clones.
  - `measureWarp`, the 18 clips on both bots (`warps.probe.ts`): 554 → 244 ms (load 33–42 % → 63–68 %), every warp
    byte-equal.
  - Checks: `tests/unit/overlay-cache.test.ts` (new: shared resources, numbers past 24 a task made idle, the warm-up
    once per renderer and fog, each program taken into use); on `c945991` + T2 (`t2f-heavy.log`): the 30 solve dumps
    byte-equal to base, smoke `6 passed`, the fork e2e set `89 passed`, an export of a covered bot fight equal to
    T1's (8d1a3b01…, fa74c7ab…); the gate on `dceef2d` + T2 (`t2g-heavy.log`; t2f's hit a load timeout in
    `fight-coverage.test.ts`, 22 passed alone). The fight-worker e2e assertion on the commit frames comes with T3
    (T2 alone doesn't meet it: 144 + 89 ms in t2f's run).
- **T3** (Stage, 4 bots playing, the two fighters selected vs none; `diag.spec.ts` `select`, medians, ms):
  - Before (HEAD with T1, `t1e`, load 26–57 %): 30.3 vs 11.8 (pre-T1 32.3 vs 16.3). The selected bot's box: three's
    `computeBoundingBox` skinning 166k (Y Bot) vertices a frame, and 20 + 28 ms of a staging's commit (`t2d`).
  - Per bot and frame (`box.probe.ts`, a walking Y Bot / X Bot, frames 10–299, both skins): three's 17.3–23.0; the
    distinct vertices alone 1.23–1.74; packed with the affine divide skipped 0.71–0.99. Every sampled box equal to
    three's to the bit (`out/box-three-b1.json` vs `box-tree-b1.json`).
  - After (`t3e`, `t3f`, four runs, load 32–93 %): 13.0 / 13.1 / 13.5 / 10.5 vs none 11.25 / 11.25 / 11.9 / 8.45:
    +1.75 / +1.85 / +1.6 / +2.05 (target 2: three runs under, one 0.05 over); a prop selected (gizmo, box, tint, no
    skin) 10.7 / 11.1 / 12.2 / 8.4.
  - Checks: `tests/unit/bot-bounds.test.ts` (the box to the bit against three's over four poses and two bots; a skin
    whose points repeat, and a point on other bones not taken for a repeat: a position-only dedupe fails it). On
    `dceef2d` + T2 + T3 (= `7fbc7c5` + T3, `t3g-heavy.log`, load 52–99 %): gate `Test Files 108 passed (108)`, smoke
    `6 passed`, an export of a covered bot fight equal to T1's (8d1a3b01…, fa74c7ab…); the fork e2e set 85 passed,
    1 failed: `mocap-bots.spec.ts:315`'s double export (a clip run). The known ANGLE flake (BACKLOG, export-look T4;
    street-kit saw `:379` fail once): in the failed pair frame 1 differs in 1 pixel by 1 level, and the H.264
    encoder's later frames drift from it (frame 30: 19.5k pixels ≤ 44 levels); the metadata are equal, and a box
    is three's to the bit on every call, so it can't tell two exports apart. The whole `mocap-bots.spec.ts` after:
    T3 2/2 passed (13 passed each), HEAD without T3 3/3; with the first two runs, T3 3/5.
- **Coverage commit** (MCP `fight_coverage` on the staged combos fight, `diag.spec.ts`, the commit task, ms):
  - Before (`t3e` ×2, `t3f`, load 32–93 %): master left 112 / 114 / 125, the other modes 62–72. Aligned profile:
    offThread's planning run solving the marks' views (56 ms, `solveShotAt` → footwork `stepLegs` → `hipsShare`),
    then the real run's commit.
  - First form, a planning run solves no view (`cova` ×2, load 68–76 %): master left 106 / 192, the others 53–112.
    Profiles: `hipsShare` 35–72 ms now in the real run (0 samples in any staging: nothing fills it before the first
    view solve). Gate `Test Files 108 passed (108)`, smoke `6 passed`, the fork e2e set `89 passed`, the export equal
    to T1's (8d1a3b01…, fa74c7ab…). Not kept (call 9).
  - Kept form, views solved with the framings in the worker: `tests/unit/fight-offthread.test.ts` (failed first: 3 views
    solved on the main thread; now 0, the marks equal the main thread's own) and `coverage-memo.test.ts`: `Test Files
    2 passed (2)`. In the built app: not measured (the run was stopped; crd3's closing gate covers the gate, smoke and
    e2e set).
- **T4** (a staged bot fight, then Deliver; `diag.spec.ts` deliver; tasks over 50 ms from the switch to the prompt):
  - Before (`base`, `t1e`, `t2a`/`c`/`d`, `t3a`–`d`): one task, 241–473 ms; the fight-worker e2e 257–450 ms.
  - After (`t4a`, `t4b` ×2, load 48–88 %): none, and none after the prompt; the fight-worker e2e (`t4a`): none, `5
    passed`, and it now asserts it (same SceneManager across the switch, longest task ≤ its long-task bound).
  - On `fcfb08d` + the coverage unit's first form + T4 (`t4b-heavy.log`): gate `Test Files 108 passed (108)`, smoke
    `6 passed`; the fork e2e set: not measured (stopped at its 62nd test, none failed to there).
