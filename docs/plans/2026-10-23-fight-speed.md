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
