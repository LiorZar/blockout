# Fight speed: stop the bot fight solve from blocking the app (lane `fight-speed`)

Goal: `BACKLOG.md:36`. A Y Bot vs X Bot fight solves in seconds on the renderer's main
thread, so the app freezes behind "Staging fight…". Base: HEAD + bot-slides T3 (the
working tree at the start, snapshot in `.maestro/fight-speed/base/src`). Probes in
`.maestro/fight-speed/` (`speed.probe.ts`: the 14 `mocap-fights-real` scripts both
orders through `solveFight`, QA's run3 through the store in the gym; warm times, CPU
profiles, every solution dumped for the equality check).

## What the profile shows (base, combos Y Bot vs X Bot, 2 solves, `--nolock` at 43–65 % load)

combos mf: 3.9 s warm (4.3–4.5 s cold). Inclusive: the beat planning 64 %, of it the
placement (`decide` / `placeAt`) 27 %, the guard opening 20–27 %, the orbit's body
depth 17 %, the lean solve 17 %, the pitch solves 14 %; `separate()` 16 %. By work:
skin-to-mesh distance (`meshDepth` / `signedAt`) 24 %, posing (`botPose`) 15 %, skin
meshes built (`skinMesh`, `skinOn`) 18 %, GC 10 %. No piece is redundant on its own:
the time is search loops (8 placement passes × up to 8 orbit tries × bisections),
each on fresh inputs, already cached where it repeats.

## My calls

1. **(b) off the main thread, not (a).** A punch fight at ≤ 1 s is a 4× cut and a combo
   at ≤ 2 s 2×, spread over a dozen searches, with marks byte-equal: not realistic
   without changing what the searches find. Moving the solve off the main thread frees
   the UI whatever a solve costs, and changes no number. The solver is untouched.
2. **The worker's clip registry: replayed registrations.** The renderer already turns
   each FBX into plain engine data (`MocapSource`, `MocapClipSource`) and registers it;
   the same data is posted to the worker as it registers, and the worker registers it
   with the same engine calls, in the same order (postMessage keeps it), so its
   registry matches the main thread's at every request. No FBX, three.js or IPC in the
   worker.
3. **The store's API stays synchronous; the async path warms it.** `stageFight`,
   `updateFight` and the rest keep their signatures, results and undo. The new
   `offThread(run)` runs the store action in planning mode, where a solve the memo
   doesn't have throws instead of solving (before the action's `mutate`, or inside it,
   where `mutate` commits nothing); the miss is solved in the worker, the memo primed,
   and the action re-run. The last run hits the memo on every solve and commits exactly
   as before. stageFight's fresh ids (fight, spawned fighters, weapons) are made once
   up front, so every run solves the same inputs.
4. **Fallback**: no `Worker` (Vitest, Node) or a worker error: the solve runs on the
   main thread as now.
5. **The memo moves into the engine** (`fight/solve-memo.ts`, the store's `SOLVES`
   by the same key). The Deliver panel's prompt (`generatePrompt` → `prompt-scene.ts`)
   re-solves every fight on every edit today; through the memo it solves a fight once
   per change to its inputs.

## Tasks and checks

1. **T1 engine memo** → verify: `tests/unit/fight-solve-memo.test.ts` (fails first): a
   second solve of the same inputs returns an equal copy without solving, an input or
   registry change misses, a caller's edits don't reach the memo; the prompt test of
   a staged fight reads the memo; the 29 probe dumps byte-equal to base.
2. **T2 worker** (`renderer/fight-worker.ts`, `renderer/fight-offthread.ts`, hooks in
   `mocap/library.ts`, `store.ts`; callers: MCP `stage_fight` / `update_fight`, the
   Fight Director's Stage / Re-solve / Apply, the routine and sequence fight staging)
   → verify: `tests/unit/fight-offthread.test.ts` (fails first): with a stand-in remote,
   the async stage's tracks and report equal the sync one's and the main thread solves
   nothing; new e2e `tests/e2e/fight-worker.spec.ts` on the built app with the real
   library: MCP `stage_fight` of a combos fight, no main-thread task over 100 ms
   (PerformanceObserver `longtask`, frames recorded) while it stages, and its tracks
   and report equal a main-thread solve of the same document; `mocap-bots.spec.ts`
   (double export byte-identical, the notice paints first).
3. **T3 (if time) the other solves on the main thread**: the shot's fights re-solved on
   an fps / duration edit (Timeline, Inspector, `set_shot`), the Fight Director's live
   report after a project opens, the Deliver prompt's first solve → each through
   `offThread`, checked like T2.
4. **Done**: before / after (long tasks while staging; solve times unchanged and
   quoted), output equality (run3, kicks3, the Female / Male punches and grapples, a
   combo: the probe dumps, and the e2e's worker vs main-thread solve);
   `mocap-fights-real`, `mocap-fights-solve`, `mocap-footwork`; full gate, smoke, fork
   e2e set (`--workers=1`, the lock); `MODIFICATIONS.md`; `BACKLOG.md:36` DONE or left
   open with its numbers. Each task staged alone and reported.

## Results

- **Baseline** (base, warm min of 5 after one cold, the lock, CPU load 22–71 %;
  `.maestro/fight-speed/base-summary.txt`): run3 through the store 1.22 s; punches Y Bot vs
  X Bot 1.44 s, X Bot vs Y Bot 1.95 s; combos 3.09 / 2.48 s; kicks3 0.86 s; grapples 1.94 /
  2.32 s. Faster than the backlog's numbers (bot-slides and earlier lanes), still 1.4–3× the
  (a) targets.
- **T1** (`.maestro/fight-speed/t1-summary.txt`, on a snapshot of the T1 tree): the 29
  solutions (14 scripts × 2 orders, run3 through the store) byte-equal to base; typecheck,
  lint clean; `fight-solve-memo`, `mocap-fights-store`, `prompt-scene`, `fight-props-store`:
  `Test Files 4 passed (4)`.
- **T2** (`.maestro/fight-speed/t2b-summary.txt`, snapshot of the T2 tree, the lock):
  typecheck, lint clean; `fight-offthread` (8 tests: the stage and the re-solve equal the
  main thread's with no solve there, one undo step; a miss inside a mutate commits nothing
  while it solves; a worker that fails falls back; a shot the fight grows re-solves its other
  fight in the worker; a routine bot fight; input errors), `fight-solve-memo`,
  `mocap-fights-store`, `fight-props-store`: `Test Files 4 passed (4)`; build; e2e
  `fight-worker` + `mocap-bots`: `14 passed`. Built app, MCP `stage_fight` of the combos
  script on bots (`.maestro/fight-speed/diag-both-summary.txt`, `t2b-e2e.txt`): base, one
  10,186 ms task, worst frame gap 10.5 s; T2, committed after 12.3 s with 210 frames drawn,
  worst gap 89 ms, longest task 89 ms (the render's frames: 50–90 ms each with four bots in
  this setup). Left after the commit (not the solve): the new fight's scene (its marks
  overlay, `markMesh` 55 ms), a shader's first use (136 ms) and the bots' bounds (below):
  tasks of 210 / 313 ms on the first two frames.
- **T3** (`.maestro/fight-speed/t3b-summary.txt`, snapshot of HEAD 9078996 + the T3 files
  only, the lock): typecheck, lint clean; `fight-offthread` (12 tests: + a prompt read null
  then the prompt with nothing solved here, a solve read twice asked once, a refused solve
  solved here next, MCP `set_shot` → `get_fight` through the control handler with no solve
  here), `fight-solve-memo`, `mocap-fights-store`, `fight-props-store`: `Test Files 4 passed
  (4)`; build; e2e `fight-worker` + `mocap-bots`: `16 passed`. MCP `set_shot` re-solving the
  combos fight: committed after 3.6 s, 56 frames, worst gap 82 ms, longest task 81 ms; the
  Deliver prompt of a fight staged among props shows "Solving the fight…" first, then the
  prompt. My call: the Timeline's and Inspector's duration / fps fields still re-solve on the
  main thread (a controlled number field typed into can't wait for the worker; a two-step
  edit is Lior's call).
- **Found on the way**: every frame, each bot mesh's bounds are recomputed by skinning every
  vertex on the CPU (`mocap/body.ts` clears them each frame so measures are of the pose;
  three's depth sort then recomputes the sphere; a selected bot's box helper the box):
  ~70 ms a frame with four bots here. Reported to crd2.
- **T4 a bot's sphere from its bones** (`.maestro/fight-speed/t4-summary.txt`,
  `depth-summary.txt`, `stale-summary.txt`; snapshots of a2aee2b before and + `body.ts` and
  the test after, the lock): typecheck, lint clean; `bot-bounds` (new), `mocap-clip-render`,
  `mocap-fights-render`: `Test Files 3 passed (3)`; build; e2e `mocap-bots` (double exports
  byte-identical) + `fight-worker`: `16 passed`. Frame medians before → after (two runs
  each): Deliver, 2 bots 40.4 / 39.9 → 4.2 / 4.2 ms; Stage, 4 bots 84.8 / 82.6 → 10.2 / 10.4
  ms, the fighters selected 101.7 / 101.0 → 28.7 / 28.9 ms; Deliver, 4 bots 78.4 / 75.2 → 4.2
  / 4.2 ms. MCP `stage_fight` now draws 619 frames while it solves (worst gap 57 ms), set_shot
  132 (worst gap 45 ms). Real library: every vertex inside the sphere on 34 clips × 4 times,
  radius ≤ 1.17 / 1.33 × the skin's, 0.02–0.04 ms against 7.9–9.1 ms a call. Export frames
  equal before and after: clean and depth at t = 0.5 / 2 / 4 / 6 / 8, the depth with each
  frame's own range and with a pinned one, 4 runs (2 a build) byte-equal. The first check's
  depth mismatch was the run, not T4: the build before differed from itself (pre1 vs pre2)
  because `measureDepthRange` measures a moving bot against the last render's
  `bindMatrixInverse` (`Box3.setFromObject` updates world matrices, a skinned mesh's bind
  inverse only on `updateMatrixWorld`). Both builds: t = 0.5's range is 11.08..13.09 after a
  frame at 8, 11.49..13.48 after one at 0.5, and an export's shot-wide depth range follows
  the playhead (11.09..14.43 at 2, 10.94..14.10 at 8). Not fixed (it changes export output):
  reported to crd2.
- **T5 the depth range from the frame's own pose** (crd2's task; `.maestro/fight-speed/t5-summary.txt`,
  `t5b-summary.txt`; snapshots of a2aee2b + T4 + the test without the fix (`t5r`) and with it
  (`t5a`), the lock): `measureDepthRange` updates the scene's world matrices first. The new
  e2e (the combos fight on bots, 10 s: depth-only exports from playhead 2 and 8, then the depth
  after the clean pass) fails without the fix (`depth only, playhead 8 vs 2`: 0108d418…,
  4f267335…, 32baa6bb…, three files) and passes with it (all three b2307075…, the same in two
  launches). A clean + depth export first left the playhead out (the clean pass renders before
  the range is measured), which is why the first version of the test passed without the fix.
  Clean pass unchanged: the reference mp4 907b0f37… before and after. With the fix:
  typecheck, lint clean; build; all of `mocap-bots` with the test's first version: `13 passed`
  (the walking, clip run and fight double exports byte-identical); the final test alone: `1
  passed`.
- **Done** (`.maestro/fight-speed/final-summary.txt`, snapshot of HEAD 66d2025 + T5 as staged,
  the lock): typecheck, lint clean; `Test Files 99 passed (99)`, `Tests 1697 passed (1697)`;
  `mocap-fights-real`, `mocap-fights-solve`, `mocap-footwork`: `Test Files 3 passed (3)`, 27
  tests; smoke `6 passed`; fork e2e set + `fight-worker` (`--workers=1`): `88 passed`. MCP
  `stage_fight` of the combos fight on bots: base one 10,186 ms task and a 10.5 s frame gap,
  now committed after 11.2 s with 603 frames drawn, worst gap 58 ms, no task over 50 ms;
  `set_shot` re-solving it: 128 frames, worst gap 43 ms. Solve times unchanged (T1's 29 dumps
  byte-equal to base; 1.2–3.1 s warm, now in the worker). `BACKLOG.md` item DONE; left there:
  the staged fight's commit frame (mark meshes, a shader's first use, ~210 ms), a selected bot's
  box helper, the Timeline / Inspector duration and fps edits on the main thread, a ~0.5 s task
  on the switch to Deliver.
