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
