# Mocap backlog: four small fixes (lane `mocap-backlog`)

Goal: close four BACKLOG lines left over from the mocap phases. Base `b322531`.
The `held-weapons` lane edits `fight/solve.ts`, `weapon-shape.ts`, `weapons.ts`,
`weapon-hold.ts`, `mocap/body.ts`, `mocap/scene.ts`, `SceneManager.ts`, `hold.ts`
and two tests at the same time: none of them is touched here.

## My calls

1. **`spawn_sequence` `bodies`**: the panel's pair, `[men's, women's]` person asset
   ids, checked like `stage_fight`'s `assets` (a person in the catalog; a bot only
   when the library has loaded). A car chase casts cars: `bodies` is ignored there
   and the result says so in a `note`. A fight of two hands it to the Fight Director
   as its `assets` (the store already does). No `"mocap"` shorthand: the ids are
   what `list_assets` returns.
2. **Routine KOs**: the bots' rule, for every keyframe body. After a fall
   (`knockdown-fall`, `ko-collapse`, `trip-and-fall-flat`, `thrown-backward`), the
   plain stand marks the routine lays (the push-back at the fall's end, the
   "stays down" copy at the end of a finish) carry the fall's last pose as a posed
   move, until the performer's next move: the get-up of a sparring ending, the
   next exchange in a one-vs-many; to the end when there is none. A pass over the
   built marks for bodies that don't play clips, so a bot's marks are unchanged
   by construction. (A two-person routine fight goes to the Fight Director in the
   app; the one-vs-many hero is the live case.)
3. **Chair sit height**: fitted in the engine's clip pose, so the floor, weapons,
   shot words and the renderer see one pose. A sit-down over a seat prop records
   the seat's top on its clip marks (`MarkClip.seat`, in the body's own metres);
   `mocapClipPose` lifts the hips until their lowest point (hips and upper
   thighs) rests on it and turns each leg (two-bone, knee in its own plane) so
   the feet keep their spot on the floor. The seat stops the hips as a real one
   does: nothing changes while they are above it, so the stand-to-sit comes
   down onto it. Seat tops come from the builders' geometry (chair 0.48, stool
   0.65, armchair and couch cushion 0.545, office chair 0.70, wheelchair 0.54,
   toilet 0.49, bench 0.48, lounger 0.39 m, × scale). Feet on the floor: the
   stool has no rung. Recorded at lay time rather than looked up live: a live
   look-up needs `evaluate.ts`, which held-weapons is editing, and the chair-sit
   choice itself is made at lay time. A seat lower than the clip's (the
   lounger) isn't sat down onto (≤ 3 cm hover). The `sit` **gait** over a seat
   is posed in `SceneManager.ts` / `body.ts` (held-weapons' files): skipped
   here, a follow-up.
4. **X Bot crawl knee**: measured (`.maestro/mocap-backlog/crawl.txt`): the left
   knee drifts 2.14 cm (1.91 along, 1.36 sideways); Y Bot's knees never plant. The
   warp can't fix it alone (tracking the knee pushes X Bot's hands to 2.5 cm).
   A retargeted bot (not the clip's source) pins a planted knee: over each window
   its knee is on the floor in a travelling in-place loop, the thigh turns so the
   knee joint stays where it planted (the shin rides along), and the correction
   eases back to zero over the swing. Measured once per bot and clip, pure in t.
   The source bot (Y Bot) plays the take as captured, so its crawl is unchanged.

## Tasks

1. T1 `spawn_sequence` `bodies` → verify: `mcp-catalog`; e2e in
   `tests/e2e/mocap-bots.spec.ts` casts Y Bot / X Bot through the tool (a dance
   and a two-person fight); docs rows (AGENTS.md, mcp/README.md).
2. T2 routine KOs → verify: new fork unit test (classic and mannequin bodies:
   held to the end on a finish, to the get-up on sparring, to the next move in a
   one-vs-many); `mocap-fights-routines` unchanged; before/after picture.
3. T3 seat fit → verify: unit test on the fixture bot (hips on a 0.65 m stool,
   feet within 2 cm of the floor, no fit without a seat); real library: both bots
   on chair, stool, couch, office chair (hips on the seat, feet ±2 cm); picture.
4. T4 knee lock → verify: real library: X Bot crawl left knee < 2 cm, Y Bot crawl
   numbers identical; a synthetic retargeted-bot unit test; picture.
5. Full gate, smoke, fork e2e set (mcp-gaps, fight-camera, mannequin, weapons,
   mocap-bots, export-flush), all through heavy.mjs with the lock; MODIFICATIONS,
   BACKLOG; stage own files by path.

## Results

- T1: `tests/e2e/mocap-bots.spec.ts` "spawn_sequence casts the bots…" passes (red before: the crowd
  came out as `person.man` / `person.woman`).
- T2: `tests/unit/routine-falls.test.ts` 4 passed (4 failed with the hold bypassed). Pictures
  `before|after-ko-{classic,mannequin}-t{9.94,11.5}-{0,1}.png`: before, the hero stands back up
  after the KO; after, it stays down to the end.
- T3 (real library, every 1/12 s from the landing): hips vs seat top before −6…−34 cm (stool:
  Y Bot −23…−26, X Bot −25…−29), after 0.0 cm on chair, stool, armchair, couch, office chair,
  wheelchair, toilet and bench; feet ≤ 1.1 cm (Y Bot) / 1.6 cm (X Bot) off the floor. The lounger
  (top under the clip's seat) is left: ≤ 3.2 cm over it. Pictures `before|after-sit-{stool,couch}-{0,1}.png`.
  On a stool the hands keep the clip's rest over where the thighs were (a few cm above them).
- T4 (real library, X Bot crawl): left knee 2.14 → 0.70 cm, right knee 0.83 → 0.12 cm, hands
  1.56 / 1.37 → 1.22 / 1.41 cm; Y Bot's numbers unchanged to the digit. Picture
  `crawl-knee-sheet.png` (start / end frames of the second plant, a line at the knee's edge).
