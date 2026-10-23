# Bot slides: the foot slides and hips snaps left after qa-fixes and set-routines (lane `bot-slides`)

Goal: the residuals of `BACKLOG.md:35` on base `d916477`: the fight's one-frame hips
snaps, the keyframe spinning back kick's sliding feet, and the chase bots' leftover
slides. Every change in `MODIFICATIONS.md`; upstream files get a fork helper and a small
hook; upstream tests stay as they are. Probes and drivers are copies in
`.maestro/bot-slides/` (`fight.probe.ts`: QA's run3 through the store, the rendered
bones, the overlap measure of `mocap-fights-real`; `skate.probe.ts`: QA's Downtown chase
on bots, seeds 7 / 3 / 21, both endings).

## What the probes show on HEAD (d916477)

- **Fight run3** (`fight-run3-head.txt`): contact max 0.21 cm; solve 1252 ms warm min of
  5; overlap worst 2.02 cm (t 0.875), ≤ 3 cm within ±2 frames of every impact.
  Hips snaps (a frame's hips step minus the mean of its neighbours' steps) over 5 cm:
  KIRA 0.833 (step 9.1 / snap 8.7 cm), BRUNO 4.500 (11.0 / 9.1), 4.542 (4.1 / 5.9),
  8.250 (4.3 up / 6.3), KIRA 4.167 (5.4), 4.208 (5.0), 6.208 (10.7 / 5.7), 6.250 (5.6);
  BRUNO 4.458 (5.6) is the impact frame of a hit.
  Both KIRA 0.833 and BRUNO 4.500 are `separate()`'s push: after a blow the push ramps
  from 0 at the impact to all of it on the first overlapping frame, which is the frame
  after the impact (a blocked jab's follow-through, the front kick's foot), so 8–9 cm
  of push land in one frame and the one-frame footwork window slides both feet (KIRA
  0.79–0.83, 8 cm). BRUNO's reaction clip (`hitStomach`) starts at 1.2 m/s, not the jump.
- **Spinning back kick** (KIRA 6.21–7.83): 5 slide runs 17–53 cm with the hips still. The
  move has no clip: the bot crossfades from its idle stance (staggered feet) into the
  keyframe rig's first pose (feet together under the hips) over 0.15 s, the standing leg
  follows the keyframes' small hip / knee changes, and the move crossfades back into the
  idle stance at its end.
- **Chase** (`skate-head-*.txt`), slide runs over 15 cm per seed (caught / escape):
  7: 3 / 6, 3: 6 / 3, 21: 2 / 5; worst 32 / 38 cm.

## My calls

1. **Snap measure**: a hips snap is a frame whose hips move more than 5 cm (3D) and more than 5 cm
   past the mean of the frames before and after it (the "snap"), so steady travel (a walk-in at
   1.2 m/s is 5 cm a frame), a stagger's smooth 11 cm frames and a lying body's 4 cm jitter don't
   count; the impact frame of a landed hit is exempt (the step ending on it), nothing else.
2. **T1, the push eases in**: `separate()`'s push ramps in at most `SEP_RATE` (1 m/s, 4.2 cm a
   frame) from the impact, not all on the first overlapping frame. A frame on the way in may sit
   `SEP_NEAR` (1.5 cm) in the other body after a block, no more than `SEP_TOL` (1 cm, as before)
   after a landed hit; the attacker gives way too (the existing `both`) where the defender alone
   can't. Where easing can't keep every frame within its bar, the push lands at once as before
   (kicks3's power-1 front-kick combo: eased, it sat 3.77 cm in on the frame after the impact by
   QA's measure, whose footwork lowers the defender's hips; the solver's own checks run without
   footwork). The footwork window over the push then spans the ramp.
3. **T2, keyframe moves over the idle**: on a bot, a strike with no library clip plays
   over the fighter's idle on shot time: its keys carry the idle clip and the move's
   joints as an overlay relative to its first key (the guard), so there is no crossfade
   into or out of the move's own stance. The legs keep the idle's planted stance, but the
   striking leg on the keys where the overlay lifts its foot clear of the floor (the
   chamber and the kick). The pivot foot stays where the idle plants it through the
   spin, the kicking foot leaves from its spot and comes back to it. (Instead of the
   brief's "step the other foot in": with the idle's stance kept there is no stance
   change to step.) Only a move whose standing legs hold (within 0.25 rad of its first key)
   plays over the idle: the spinning back kick and backfist, the teep. The sweep, the shoves
   and the tackles crouch or lunge on their legs; over the idle the sweep stood up and the
   tackle drove 8 cm into the defender (`mocap-fights-real`), so they keep the crossfade.
4. **T3**: decided per case after the slide probe on each (below, in Results).

## Tasks and targets

1. **T1 hips snaps** → verify: `fight.probe.ts` run3: no hips snap > 5 cm but on a hit's
   impact frame; contact ≤ 0.5 cm; overlap ≤ 3 cm within ±2 frames of every impact and no
   frame over 3 cm; solve time warm min of 5 not over HEAD's (1252 ms, same machine
   load quoted); `mocap-fights-real` (overlap and contact on 7 scripts × 2 orders) green;
   a failing unit test first (`tests/unit/fight-separate-ease.test.ts`, fixture bots).
2. **T2 spinning back kick** → verify: run3 KIRA 6.0–8.0: no slide run > 5 cm while the
   hips move < 2 cm; contact ≤ 0.5 cm; `mocap-fights-real` green (its punches script
   plays the keyframe spinning backfist on bots); a failing unit test first.
3. **T3 chase** → verify: `skate.probe.ts` seeds 7 / 3 / 21, caught and escape: no slide
   run > 15 cm, or each left one listed with its cause; set-routines' T1 / T2 targets
   still hold (`routes` / `framing` probes, hips in no solid, ≤ 0.45 m a frame).
4. **T4 (if time)**: the fight's "both feet slide, hips still" runs qa-fixes didn't
   explain.
5. **Done**: QA's fight and chase re-shot on a frozen app of the tree
   (`.maestro/bot-slides/SHEET.png`, with a wide shot of the fight, looked at); full gate,
   smoke, fork e2e set (`--workers=1`, the lock); each task staged alone and reported.

## Results

- **T1** (run3 on HEAD + T1 alone, `.maestro/bot-slides/fight-run3-{head,t1}.txt`), hips step / snap,
  d916477 → T1: KIRA 0.833 9.1 / 8.7 → 4.9 / 2.4 cm, BRUNO 4.500 11.0 / 9.1 → 6.3 / 4.1 cm; no frame
  left with a step and a snap over 5 cm but KIRA 6.208 (the keyframe kick's step-in, T2's). Contact
  0.21 → 0.21 cm; overlap within ±2 frames of every impact max 2.02 → 2.03 cm, no frame over 3 cm.
  `mocap-fights-real` (7 scripts × 2 orders, `real.probe.ts`): kicks3 near its first impact 0.18 /
  1.97 cm as HEAD (the at-once fallback). `fight-separate-ease.test.ts` fails on d916477 (8.9 cm on
  the frame after the blow).
- **T2** (run3 on f99e96a + T2, `.maestro/bot-slides/fight-run3-t2f.txt`; `real-{t1,t2c}-all.txt`):
  KIRA 6.0–8.0 s, slide runs over 5 cm with the hips still, d916477 → T2: 5 (17–53 cm) → 0; the
  pivot toe travels 2.5 cm over the 1.5 s move; contact 0 cm on the beat, 0.21 cm max; overlap
  within ±2 frames of every impact ≤ 2.03 cm, as T1. The first cut played every clipless move over
  the idle: `mocap-fights-real` failed on grapples (tackle 8.08 cm into the defender at 5.3 s, HEAD
  1.15) and the sweep stood up, so call 3 got its stance rule; then `mocap-fights-real` +
  footwork + fights-solve on the snapshot: `Test Files 3 passed (3)`, 27 tests. Real-library
  probe, T1 → T2: the teep near its impact 2.46 / 2.56 → 0.17 / 0.41 cm; hips snaps gone at Male
  kicks2 B 17.125 and Female kicks A 5.333; new: Female (A) punches 13.833 A 9.0 / B 9.4 cm, Y
  Bot's spinning-backfist KO stands 8 cm closer over the idle (0.98 m apart, 1.06 on T1), and the
  frame after it the bodies overlap past a landed hit's 1 cm bar, so `separate()` pushes both
  9.3 cm at once (T1's fallback, as kicks3 on HEAD); Male grapples 2 more frames at 3.0–3.1 cm
  off the impacts (15.04–15.08). Left as a residual.
- **T3** (QA's Downtown chase on bots, seeds 7 / 3 / 21, caught / escape;
  `.maestro/bot-slides/skate-{head,t3f}-*.txt`), slide runs over 15 cm, d916477 → T3: caught
  3 / 6 / 2 → 2 / 5 / 1, escape 6 / 3 / 5 → 5 / 3 / 4: the first frame's 15–17 cm runs are gone
  everywhere (a bot on its first mark reads its first leg's speed, `evaluate.ts`;
  `bot-first-frame.test.ts` fails on d916477). Left, 20 runs, by cause (marks around each run):
  9 keyframe legs over the run loop (the skid and stumble beats, 17–37 cm), 10 run ↔ walk gait
  crossfades (7 braking, 3 speeding back up, 18–32 cm: the two loops plant the same foot at spots
  that differ by their strides; it needs a history-aware foot lock across the blend), 1 stop into a
  standing pose (escape seed 3 COP 1 7.54–7.83 s, 38 cm, the crossfade gliding the feet into the
  stance). Tried and reverted (both worse): stepping the planted foot over the gait crossfade (in a
  run the other foot is up, so the step can't lift, 32 cm); holding planted feet under leg overlays
  on gait loops (the hold engaging as a foot lands pulled it 25–28 cm in one frame).
  set-routines' T1 and T2 targets hold: its routes (people, bots) and framing (bots) probes on the
  T3 tree print exactly what they printed on its T3 (`routes-t3-*`, `framing-t3-bots`: no hip in a
  solid or off the tile, root steps ≤ 0.223 m, other cast < 2.5 m from the lens 0 / 192).
- **T4** (qa-fixes' "both feet slide, hips still" runs, KIRA 0.13–0.38, 1.29–1.46, 12.75–13.00,
  13.92–14.08 s, the fight idle crossfading to and from the mirrored body block): none left on
  d916477; run3's slide runs over 5 cm there: 0 (`fight-run3-head.txt`), and 0 on T2
  (`fight-run3-t2f.txt`). Nothing to change.
