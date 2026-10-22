# Mocap follow-up: the loose ends of held-weapons and mocap-backlog

Lane `mocap-followup`. Base HEAD `7d9e5c1` (held-weapons on top of `366c7cd`
mocap-backlog). Four tasks: finish `spawn_choreography` `bodies`, unit-test
held-weapons' four newest rules on synthetic clips, sweep every clip on the
committed code, and rebuild the before / after sheets.

## My calls

1. **`spawn_choreography` `bodies`** takes the same `[men's, women's]` person
   asset ids as `spawn_sequence`, checked by the same function (`castBodies`:
   a person in the catalog; a bot only when the library has loaded). Every
   routine kind (dance, fight, chase) casts people, so there is no car-chase
   style note; a fight of two hands the bodies to the Fight Director as its
   `assets` (the store already does that through `RoutineSpec.bodies`).
   `choreograph_entities` restages existing people and keeps their bodies, so
   it takes none.
2. **The rule tests live in a new fork file**, `tests/unit/weapon-hold-rules.test.ts`,
   on the fixture bot and synthetic clips only, calling the rule through its
   public functions (`holdArm`, `holdTurn`, `holdDepth`). No engine change is
   made for them.
3. **"Fails with the rule disabled" is checked on a mutated copy**, never by
   editing `src/engine/weapon-hold.ts` (the clip sweep imports that file while
   it runs). `.maestro/mocap-followup/mutate.sh <rule>` copies the file into
   `.maestro/mocap-followup/mut/`, applies one `sed` that disables the rule,
   and runs the new test file with a config that maps `@engine/weapon-hold` to
   the copy. Each mutation must turn its test red; the unmutated copy must stay
   green.
4. **The full sweep runs in four locked chunks** (every 4th sorted clip id),
   each its own `heavy.mjs` command, so the test lane `mocap-qa` can take the
   lock between them (`heavy.mjs` gives up a wait after 2 h; one 3.7 h run
   would starve it). Same probe and measure as held-weapons
   (`clips.probe.ts`, `HW_FIX=1`), output in `.maestro/mocap-followup/full-<i>.txt`.
   A run over 3 cm is a regression unless it is one of the 12 residuals in
   BACKLOG.

## Tasks

1. `spawn_choreography` `bodies`: the handler hunk, `mcp/tools.json`, `AGENTS.md`,
   `mcp/README.md`, BACKLOG DONE. → verify: `mcp-catalog` unit; e2e in
   `tests/e2e/mocap-bots.spec.ts` casts Y Bot / X Bot in a dance routine and a
   routine fight of two through the tool, and rejects a non-person body.
2. Rule tests: the lift cut, the refine keeping the clearest turn, the elbow
   way (only when it clears more, never for a shield), the shield-only hand
   pad. → verify: the file passes; each mutation fails it (output quoted below).
3. Full sweep. → verify: every run > 3 cm listed and compared against the 12
   residuals.
4. Sheets: worst frames per weapon kind, front and 3/4, before (`b322531`) /
   after (HEAD), in `.maestro/held-weapons-visual/`, looked at.
5. Close: full gate, smoke, fork e2e set (mcp-gaps, fight-camera, mannequin,
   weapons, mocap-bots, export-flush), all with the lock; MODIFICATIONS; stage
   by path.

## Results

- T2: `tests/unit/weapon-hold-rules.test.ts` 7 passed (`npx vitest run tests/unit/weapon-hold-rules.test.ts`,
  ~15 s). Each mutation (`bash .maestro/mocap-followup/mutate.sh <rule>`, logs `mut-<rule>.log`) fails
  its own test on the intended assertion, and only there (the unmutated copy: 7 passed):
  - `cut` (no frame's eased lift scaled back): `f6: expected 0.46 to be less than 0.23` (the lift
    at the first frame behind the back);
  - `keep` (the refine returns its last step): `prop.spear: expected 0.1199 to be ≤ 0.0503`
    (12.0 cm after the refine, 5.0 cm on the curve's turn);
  - `elbow` (no elbow way): `prop.sword: expected null not to be null` (nothing frees the fist under
    the chin);
  - `elbowfirst` (the elbow way taken first): `expected -0.53 to be +0` (the elbow opens where a
    forward lift clears; the lift-cut test fails too, its run no longer lifting forward);
  - `elbowshield` (the elbow way for a shield): `pose 0: expected -1.17 to be +0`;
  - `padoff` (no pad for a shield): `shieldByHand0: expected 0.0336 to be less than -0.02` (3.4 cm
    in the other hand);
  - `padall` (the pad for every weapon): `pistolByHand0: expected [ -0.11, … ] to be null` (the
    pistol turned out of the two-handed grip).
  The cases were found by seeded searches on the fixture bot with the rule and its mutants side by
  side (`*.explore.ts`, `explore-*.txt` in `.maestro/mocap-followup/`).
- T1: `tests/e2e/mocap-bots.spec.ts` 12 passed (the new spawn_choreography test included); `mcp-catalog`
  4 passed. (A 4 s hip-hop routine on seed 3 plays only `spin-freeze`, which has no clip: the test
  uses 8 s, which adds `top-rock`.)
- T3: the full sweep on `7d9e5c1` (`.maestro/mocap-followup/full.txt`; 97 clips × 12 weapons × both
  bots × mirror, every frame, four locked chunks, 485 + 2502 + 991 + 1016 s): **12 runs > 3 cm, exactly
  the 12 residuals listed in BACKLOG, no new run.** Worst per weapon outside those: knife 2.76 cm (Y Bot
  `danceUprock`), axe 2.72 (Y Bot `danceHouse`~m), bow 2.27 (Y Bot `trip`), shield 1.96 (Y Bot
  `koStomach`~m), bat 1.63, katana 1.24, shotgun 1.20, rifle 1.18, staff 1.14, spear 0.55; sword 2.97 and
  pistol 2.75 off their residual clips. (The full sweep before the last held-weapons fixes had 125 runs:
  `clips-after2.txt`; e.g. katana / shotgun `think` 6.45 / 7.05 cm are now 1.24 / 1.20 at most.)
- T4: `.maestro/held-weapons-visual/followup-1…14.png` (before = the b322531 build, after = this tree,
  front and 3/4; `followup-bow-1.png` the bow case again with the lying camera): held-weapons' 21
  cases (the worst clip frame per weapon at b322531, the brief's cases, the keyframe bow, the floor
  sits, the crouched walk, lying) and the committed code's worst frame per weapon kind (7). Looked
  at, every one: at b322531 blades, bat and staff pass through the head on `danceHipHop`, the spear
  through the head on `backflip`, the axe head and the pistol in the leg, the long guns through the
  thighs, the shield through the torso / across the face; after, each weapon is out beside or in
  front of the body, still in the hand (the bat on the shoulder on the jog, the rifle stood beside
  the floor sit, the shield turned off the face lying). The worst left reads as listed in BACKLOG:
  the shield on X Bot `danceHouse` t=1.333 is edge-on across the chest (6.05 cm torso), the pistol
  and sword at the other forearm on `clap` / `danceHouse` (3.0–3.6 cm).
- Close (all through `heavy.mjs` with the lock): full gate `close-gate.sh g2` → typecheck and lint OK,
  `Test Files 84 passed (84)`, `Tests 1594 passed (1594)` (load 79 %; g1 had failed typecheck on two
  lines of the new test file, fixed); smoke `6 passed`; fork e2e set (mcp-gaps, fight-camera,
  mannequin, weapons, mocap-bots, export-flush) `75 passed (4.0m)` (load 80 %).
