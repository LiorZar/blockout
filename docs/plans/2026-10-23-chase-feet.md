# Chase feet: bots' feet stay planted through a foot chase (lane `chase-feet`)

Goal: the "Left" part of `BACKLOG.md:35` on base `dceef2d`: QA's Downtown chase on bots (seeds 7 / 3 / 21, caught and
escape) still drags planted feet in 20 runs over 15 cm. No new Mixamo data; tests build synthetic clips. Probes and
drivers are copies in `.maestro/chase-feet/` (`skate.probe.ts` QA's chase through the store, the bones as SceneManager
poses them, now with every slide run over 5 cm and what the bot showed over it; `fight.probe.ts` QA's run3 fight).

## HEAD (dceef2d), re-measured

`skate-head-{caught,escape}.txt` (HEAD snapshot `.maestro/chase-feet/head/src`; CPU load 33–48 %, the probe 5.6 s a
side): the same 20 runs over 15 cm as bot-slides' T3 left, now with the cause read off the frames:

- **10 run ↔ walk crossfades** (`fade run>walk` 7, `fade walk>run` 3), 18–32 cm, all COP 2: s7 caught R 6.50 32 cm;
  s3 caught R 5.79 19, R 6.54 19; s21 caught L 5.75 29; s7 escape L 5.00 30, R 7.25 23; s3 escape R 5.75 23;
  s21 escape L 6.00 22, R 7.29 18, L 7.46 20. Cause: at a gait change both loops play at the bot's one foot phase,
  so they have the same foot down, but at spots their strides put apart (run 2.74 m a foot cycle, walk 1.24 m on Y
  Bot), and the loop fading out runs at the new loop's rate, so its planted foot also drifts back; the blend drags the
  foot from one spot to the other (s7 caught COP 2 R: planted all through 6.50–6.75, 3–8 cm a frame).
- **9 keyframe legs over the run loop** (`legs run`: the vault, skid and stumble beats ride the run with hip / knee
  channels up to 0.9 rad), 17–37 cm: s7 caught RUNNER L 5.58 20; s3 caught RUNNER L 4.67 18, L 5.58 21, COP 1 L 3.04
  24; s7 escape RUNNER L 5.58 25, COP 1 L 2.58 17, L 5.08 37; s3 escape COP 1 R 4.67 17; s21 escape RUNNER L 5.33 32.
  The overlay pre-multiplies the loop's leg rotations, so a planted foot moves as the channels change.
- **1 stop into a standing pose**: s3 escape COP 1 R 7.54–7.83 38 cm, hips 4 cm (`fade run>walk; legs walk; fade
  walk>rig:stand`): the cop brakes out of the skid into a walk and the walk fades into the closing stand's keyframe
  pose; R is planted 22 cm behind the hips and glides under them while L is still in the air.

Over 5 cm there are 68 runs in all (lists in the same files: 41 with leg channels on, 23 in a crossfade, 3 of them
both, 7 on a plain loop); the largest one-frame toe move on the floor per bot is 5.3–28.8 cm.

## My calls

1. **One foot lock for all three** (`src/engine/mocap/plant-lock.ts`, PURE): a bot's legs aren't one gait loop played
   on distance while a gait crossfade runs or its marks put hip / knee channels over a gait loop; over such a window
   and a tail after it, each foot keeps where it was planted. Per foot, along a fixed 96 Hz grid from the window's
   start (a function of the document, never of the frame drawn before): while the foot is down in the pose the bot
   would show without the lock (its toe within 2.5 cm of the toe's rest height, else its ankle within 4 cm of the
   ankle's), its correction cancels that point's travel over the floor, so it can't jump as a foot lands; once it
   lifts, the correction eases out over the swing (smoothstep, 0.2 s), so the next plant is the loop's own. Applied as
   two-bone leg IK (footwork's `reachLeg`, the knee in its own plane), the foot's turn kept.
2. **Where it runs**: the renderer (`renderer/mocap/scene.ts` finds the window and asks for the earlier states;
   `body.ts` poses them with the same `resolve` it draws with, so the lock reads exactly the pose drawn), a small hook in
   `body.ts` and `SceneManager.botAnimInput` (the earlier states, and the camera-less evaluator as the memo key: each
   grid sample's feet are worked out once per document, not once per frame). The engine never sees gait loops (its FK
   poses bots on the keyframe rig), so nothing on the engine's side changes.
3. **The outgoing loop**: left as it plays (at the bot's foot phase); the lock cancels its drift with the rest.
4. **Into a still pose** (T2): a still pose (an idle loop or the keyframe stand) never lifts a foot, so a held foot
   there steps out instead: once the other foot is down, it lifts and sets down on its spot in the stance over 0.3 s,
   one foot at a time.
5. **Leg overlays** (T3): the same lock over the beat. If a beat's own legs lift a foot, the lock lets it go there. (Changed on the way: the loop's own feet under the beat's pose, see T3 in Results.)
6. **Not on a bot holding a weapon** (its arm rule reads the pose kind drawn, `hold.ts`); not while a mark clip plays.

## Tasks and targets

Measure: `skate.probe.ts` (both endings, seeds 7 / 3 / 21) and `fight.probe.ts` run3, slide runs by skateRuns' rule.

1. **T1 run ↔ walk crossfades** → the 10 runs under 5 cm; no run over 5 cm that isn't on HEAD, in the chase or run3;
   no frame where a locked foot moves more than 5 cm on the floor. A failing unit test first
   (`tests/unit/plant-lock.test.ts`, fixture bots: a run braking to a walk drags a planted foot on HEAD).
2. **T2 stop into a standing pose** → s3 escape COP 1 7.54–7.83 under 5 cm; a failing unit test first.
3. **T3 keyframe legs over the run loop** → the 9 runs under 10 cm, or the best reached with numbers and why the rest
   needs data (the answer to Lior's question on fetching skid / stumble clips); a failing unit test first.
4. **T4 proof** → the chase (seed 7, caught and escape) and run3 re-shot on a frozen app of the tree,
   `.maestro/chase-feet/SHEET.png` before / after around the fixed runs (looked at); a double export of a bot chase
   byte-identical; full gate (`Test Files`), smoke, the fork e2e set with `--workers=1`, all with the lock.

## Results

- **T1** (`skate-{head,t1e}-*.txt`, `cmp.cjs head t1e`; CPU load 62–90 %): the 10 crossfade runs (18–32 cm) → none
  over 5 cm; slide runs over 5 cm 33 / 35 → 23 / 22 (caught / escape), none new or longer; over 15 cm 8 / 12 → 4 / 6
  (the 9 leg-overlay runs and the stop, T2 / T3's). A planted toe's largest one-frame move in a crossfade window: COP 2
  1.3–4.8 cm; COP 1's stop into the stand 5.0–7.1 cm, as on HEAD there (T2). QA's run3 fight: report, contacts, overlap
  and slide runs as HEAD's; the bones moved on 11 frames by up to 5.3 cm, where a mark clip fades in over a gait
  crossfade (KIRA's front-kick wind-up 3.79–3.96 s; impact frames unchanged; `fight-run3-{head,t1c}*`). The unit test fails on HEAD (a planted foot dragged 4.8–10
  cm through the fixture's run → walk) and holds it under 2 cm. Two calls changed on the way: a foot is down by its
  toe's or sole's lowest surface point within 2 cm of the floor (the warp's contacts), not by its joints' heights over
  rest (the fixture's walk rolls its toe 6 cm up while planted); and a held foot steps off in an arc, or the hips sink
  up to 8 cm, where the leg can't reach it (a walk braking into a run left the held foot behind: 36–48 cm slides on the
  first cut). Cost: COP 2 0.2–0.35 → 0.6–1.4 ms a frame on average in the probe (busy machine); a frame that first
  joins a window can take tens of ms (the window's samples worked out at once).
- **T2** (`skate-t2a-*.txt`): escape seed 3 COP 1 7.54–7.83 s 38 cm (27.8 on T1) → 4.8 cm: R held behind from 7.67 s
  while L lands on its stance spot at 7.88 s, then R lifts to step up (the shot ends mid-step); seeds 7 / 21 COP 1's
  stops 14.0 / 14.5 → under 5 cm; slide runs over 5 cm escape 22 → 19, none new or longer than HEAD's; a planted toe's
  largest one-frame move in a window 4.8 cm. run3: report as HEAD's, the bones moved on 20 frames by up to 6.9 cm (as
  T1's, mark clips fading in over a crossfade). Call: the lock runs around every crossfade, not only
  into a travelling loop (a still pose needs the hold first, then the step); in a still pose feet step in turn, each once
  the other stands. The fixture test's last 3.4 cm is a swinging foot touching down at the crossfade's end (3.5 cm
  without the lock); the plant lock catches a foot once it is down, not on its way down.
- **T3** (`skate-t3c-*.txt`, `cmp.cjs head t3c`; CPU load 73–91 %): the 9 leg-overlay runs (17–37 cm) → none over 5
  cm; slide runs over 5 cm caught 33 → 2, escape 35 → 2 (T2: 23 / 19), none over 15 cm (HEAD 8 / 12), none new or
  longer than HEAD's; the 4 left (5.4–7.1 cm) are on a plain run or walk loop, as on HEAD. Lowest foot joint per bot as
  on HEAD (−0.1 / 2.8–2.9 cm). run3: report as HEAD's, bones as T2's. Pose cost 0.32–0.94 ms a frame on average
  (T2 in the same probe 0.32–1.21; busy machine). **My call** (`src/engine/mocap/swing-legs.ts`, hooked in `body.ts`
  `gaitPose` for walk / jog / run): the bot shows the beat's pose as before (its crouch, torso, arms, a swinging leg's
  tuck), but each foot goes where the loop has it (the loop under the beat's other channels) as far as that foot is on
  the floor: all the way below 3 cm, none above 15 cm (smoothstep), reached with two-bone IK (`reachLeg`), the foot
  turned as the loop turns it; the hips sink where the beat holds them higher than that leg reaches (a first cut
  without the sink dragged the planted foot 25–28 cm in a frame where the skid straightens the stance leg). A root
  lifted 15 cm or more over the ground (the vault over its obstacle; `AnimInput.lift`, set by `botInput` from the
  state's height) has both feet off the floor: the beat's whole legs, as before (identical to HEAD's pose there, unit
  test). Stateless, so no hold engaging as a foot lands (bot-slides' reverted overlay hold pulled 25–28 cm that way).
  A first cut that gave each leg the beat's channels by its foot's height (no IK) also cleared the runs but kept the
  run's hips through the skid (the crouch gone, hips 92 cm vs 53) and let the vault's planted leg hang; dropped.
  What it costs: the skid / stumble keys are full strides written for the standing keyframe rig (`hipLX` ±0.7), so over
  the run a leg the loop has planted no longer flies up behind the hips (60–68 cm off where T2 had it on some frames,
  `.maestro/chase-feet-visual/t3-skid-cop1-s7c.png`: T2 top, T3 bottom); the swinging leg and the crouch show. No
  skid / stumble clip is needed to stop the slides; one would give the planted leg its own braking stance (Lior's
  question). The unit test (a stumble's legs over the fixture run at 3 and 4.5 m/s) fails on T2 (5.7 cm) and holds
  the feet under 2 cm; it also checks the swinging legs still move with the beat (33–37 cm from the torso-only beat)
  and the crouch shows (hips 25 cm lower); a lifted bot's pose equals `gaitPose`'s exactly.
- **T4** not done: development closed at T3 by Lior (2026-10-23). Not re-shot on a frozen app, no
  `.maestro/chase-feet/SHEET.png`, no bot-chase double export checked, the fork e2e set not run on T2 / T3 (crd3 gates
  the staged tree). The T3 gate was stopped at typecheck / lint 0; T2's gate was green (`t2-summary.txt`). Harness
  ready: `.maestro/chase-feet/{snap.sh,t4.sh,drive.mjs,lib.mjs}`.
