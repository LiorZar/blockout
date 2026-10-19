# Shot Words + Fight Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things.
- **Shot words:** Lior types "MCU on B, over A's right shoulder, 50mm" and gets exactly that framing. It stays exact while the actors move.
- **Fights:** he writes a fight blow by blow. Hits land on the target on the exact frame, defenses are up in time, knockback follows physics, and the camera covers the beats.

**Architecture:** Everything is pure engine code.
- A forward-kinematics model of the mannequin rig, shared with the renderer so the two can't drift, gives exact hand, foot and head positions.
- A shot solver turns a `ShotSpec` into a camera pose. Camera marks may carry a `shot`, and the evaluator re-solves those marks every frame from the live subject positions.
- A fight solver turns a beat script into marks. It places the attacker so that the effector meets the target at the impact frame. A closed-form physics model (impulse → capture point → stagger, knockdown, head snap) shapes each reaction.
- The result is baked into ordinary actor marks with `joints`, so `state(t)` stays deterministic.

**Tech Stack:** TypeScript (engine, no DOM/three/Electron), React panels, Vitest, Playwright, three.js (renderer only; used in one cross-check test).

**Spec:** the Design section below. Lior answered on 2026-10-19:
- fights: all four aspects, "including physics"
- camera: "shot words"
- code style: Blockout's
- upstream: keep mergeable

The other design calls are mine and tagged.

**Depends on:** `docs/plans/2026-10-19-clara-mcp.md` Task 1, the `mcp/tools.json` catalog, which these tasks add tools to. Run that task first.

## Design

**Why.** Fights are the staple scene Lior wants to look amazing and accurate. Today's fights don't deliver that:
- They pick random combos from a pool.
- A reaction plays a fixed 0.35 beat after the attack starts, whether or not the fist reaches anything (`src/engine/choreography.ts:516-565`).
- Distance is a constant `FIGHT_RANGE = 1.2`.
- Nothing can be scripted blow by blow.

The camera takes exact numbers per mark but no shot language, and its moves are sized by subject height alone.

**Shot words** *(Lior: "Ask for 'MCU on B, over A's right shoulder, 50mm' and get exactly that framing")*
- `ShotSpec` holds: size (the existing `ShotSizeId`: EWS WS FS MS MCU CU ECU), one or more subjects, an optional over-the-shoulder entity and shoulder, side, angle, lens and dutch.
- *My call: live framing.* A camera mark with `shot` is re-solved from the subjects' positions **every frame**, so an MCU stays an MCU while the fighter moves. Between two marks the camera blends the two solved poses with the marks' easing. Marks without `shot` behave exactly as upstream.
- *My call: what "exact" means.*
  - At eye level, a single's head-top sits at NDC y = `fillFraction` of its size ±0.01, horizontally centred ±0.01.
  - A group shot keeps every subject's head and both shoulders inside the frame.
  - OTS puts the camera behind the named shoulder and aims at the subject's eyes.
  - When size and lens are both given on an OTS, the lens wins and the solver reports the achieved size.
- *My call: input.* The camera Inspector gets a "Shot" box that accepts the words and offers dropdowns. Clara and agents use the `frame_shot` MCP tool with structured fields or the same words.
- Vehicles are framed by their extent, `max(height, 2 × footprint)`, not person height.

**Fight director** *(Lior: hits connect, I script every blow, weight and spacing, fight-aware camera, "including physics")*
- **Script.** A fight is a list of beats: `<who> <move> [to head|body|legs] [-> outcome[, outcome…]] [power p] [at t s]`, one per line.
  - Outcomes: `hit` (default), `block`, `parry`, `slip`, `duck`, `miss`, `ko`.
  - A **Random** button and `randomFightScript` write a script for him to edit.
  - *My call:* two fighters per fight in v1.
- **Contact.**
  - Each strike motion has impacts: an effector (hand, elbow, foot or knee) and an impact time, detected from the motion data by FK.
  - The solver places and turns the attacker, and fine-tunes the strike pitch, so the effector meets the target surface at the impact frame within **3 cm**.
  - Impact times are snapped to the shot's frame grid.
  - Defenses are up by impact. Slips, ducks and misses clear the head by **≥ 25 cm**.
- **Physics.** *My call: closed-form and deterministic, baked into marks; no rigid-body simulation.* The constants are fixed in Task 8.
  1. Strike impulse = effective mass × effector speed × power.
  2. Defender velocity = impulse × exaggeration ÷ body mass.
  3. The capture point decides the result: absorb, stagger step(s), or knockdown.
  4. The fall time comes from inverted-pendulum tip-over.
  5. Head and torso snap is a damped spring.
  - Ragdoll limb physics is a non-goal for now. It is the next step if this reads too stiff.
- **Spacing.**
  - Guard distance between rounds is 1.1 m, pelvis to pelvis.
  - Step-ins are capped at 2.5 m/s. A beat is pushed later rather than letting the attacker teleport.
  - Pelvises never come closer than 0.35 m, except clinch moves (`knee-strike`, `elbow-strike`, `shove-two-hands`, `tackle-lunge`, `grapple-shove`).
- **Coverage.** Four camera modes are built from live shot marks: `master`, `punch-in`, `over-shoulder` and `follow`. All of them respect the 180° line.
- **Mergeability.**
  - The new engine code lives in `src/engine/shot*.ts` and `src/engine/fight/`.
  - Upstream's `fightRoutine` and its tests stay untouched; `spawn_choreography kind:'fight'` keeps upstream behaviour.
  - The Choreographer panel's Fight routine switches to the new Fight Director through a small hook.

**Non-goals:**
- more than two fighters per fight
- weapon contact (weapon moves may be scripted, but contact is measured at the hand)
- ragdoll simulation
- cuts inside one shot (multi-shot coverage is the existing scene animatic)
- new motion authoring

**Anti-goals:**
- any `Math.random`, time source or frame-to-frame state on the `state(t)` path
- a "hit" that visibly misses
- a camera that crosses the 180° line on its own

## Global Constraints

- **Code style:** Blockout's upstream style in every file. 2-space indent, single quotes, no semicolons. *(Lior, 2026-10-19)*
- **Mergeability:** prefer new files. Upstream files get small, additive hooks. Every task adds a line to `MODIFICATIONS.md`, and every modified upstream file keeps or gains the `// Modified … see MODIFICATIONS.md.` header. Upstream tests are never edited.
- **No commits:** stage only. Lior reviews and commits. Never use worktrees.
- **Engine purity:** `src/engine/**` never imports DOM, three or Electron. All logic changes get Vitest tests in `tests/unit/`.
- **Determinism:** nothing on the `state(t)` path uses unseeded randomness or time. The only randomness is the seeded `randomFightScript`. The smoke byte-determinism test must stay green.
- **Mutations:** all document changes go through `store.mutate` or a store action.
- **Units and conventions:** meters, seconds, radians. Heading 0 faces −Z, and models face −Z with their origin at the ground. Euler order is three.js's default `XYZ`.
- **Schema:** fields are additive only, and `parseProject` never breaks on old files. `scene.fights` is migrated to `[]`, the same way `scans` is (`src/engine/schema.ts:245-258`).
- **Done means:** `npm run typecheck && npm run lint && npm test` all green (check Vitest's `Test Files` line), plus `npm run smoke` when a task touches `evaluate.ts`, `SceneManager.ts`, `builders.ts` or export.
- **Launching Electron:** unset `ELECTRON_RUN_AS_NODE` first.

## Review Focus

1. **The shot's subject is deleted, or the over-shoulder entity is the subject itself.** The mark falls back to its stored position, pan and tilt, and the Shot box shows an error; nothing throws. *(Task 3: missing-subject test; Task 4: `over` = subject is rejected.)*
2. **A script beat can't make contact.** For example, a low sweep "to head", or a target 4 m away with no time to step in. The beat still plays, and the report gives the contact error with a warning; it never silently claims a hit. *(Task 9: unreachable-target test.)*
3. **A fight longer than the shot, or a beat `at` past the shot's end.** Beats past the end are dropped, with a warning listing them. *(Task 9.)*
4. **Mark-count growth.** Head-snap samples on a 20-beat fight stay under the per-entity cap (400), and the timeline stays usable. *(Task 9: cap test.)*
5. **Fighters of different sizes** (child vs elderly, height 0.8–1.2, build 0.8–1.3). Contact stays within 3 cm, because FK uses each fighter's own dims. *(Task 9: mixed-dims test.)*

---

### Task 1: Rig forward kinematics shared with the renderer

**Files:**
- Create: `src/engine/skeleton.ts`
- Modify: `src/renderer/viewport/builders.ts:176-305` (`buildPerson`): take every length from `personDims`, and name the joint groups `pelvis torso head shoulderL shoulderR elbowL elbowR hipL hipR kneeL kneeR`
- Test: `tests/unit/skeleton.test.ts`

**Interfaces:**
- Produces:
  - `interface PersonDims { H: number; s: number; legLen: number; headR: number; torsoLen: number; bodyW: number; shoulderY: number; upperArmLen: number; lowerArmLen: number; upperLegLen: number; lowerLegLen: number; baseLean: number }`
  - `personDims(assetId: string, params?: Record<string, number | string>): PersonDims`. It contains exactly the formulas now at `builders.ts:177-268`, including the clamps: height ×0.8..1.2, build ×0.8..1.3, and `baseLean` 0.18 for `person.elderly`.
  - `type Effector = 'handL' | 'handR' | 'elbowL' | 'elbowR' | 'footL' | 'footR' | 'kneeL' | 'kneeR' | 'head' | 'chest' | 'pelvis' | 'shoulderL' | 'shoulderR'`
  - `poseEffectors(dims: PersonDims, joints: Record<string, number> | undefined): Record<Effector, V3>`. The result is in the entity-local frame, with origin at the ground and facing −Z.
    - It covers the `stand` gait only, plus the override mapping at `builders.ts:396-422`; the breathing bob is ignored.
    - `head` is the head centre. `chest` is the torso at `0.55 × torsoLen`.
    - Hands are elbow + `(0, −lowerArmLen, 0)`. Feet are the toe, knee + `(0, −lowerLegLen + 0.03s, −0.16s)`.
  - `toWorld(local: V3, position: V3, heading: number, scale: number): V3`

- [ ] **Step 1: Write the failing tests.**
  - `personDims matches the rig formulas for man/woman/child/elderly at params height 0.8/1/1.2`, with the values computed inline from the formulas.
  - `FK matches three.js for random poses`. This is a cross-check:
    1. Build `buildAsset('person.man', { height: 1.1, build: 1.2 })`.
    2. Call `animate({ gait: 'stand', phase: 0, speed: 0, distance: 0, time: 0, overrides })`, with `overrides` taken from the joints of the first 20 keyframes of `fight`-category motions in `MOTION_PRESETS`.
    3. Call `updateMatrixWorld(true)`.
    4. Compare `getObjectByName('elbowR').localToWorld(new Vector3(0, -dims.lowerArmLen, 0))` and the same for the other effectors with `poseEffectors`, within 1e-6.
  - `toWorld rotates by heading` (heading π/2: local −Z maps to world −X).

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/skeleton.test.ts` should FAIL: the module is missing.

- [ ] **Step 3: Implement `skeleton.ts` and refactor `buildPerson` to call `personDims`.** Use a 3×3 rotation helper composed in `XYZ` order. Match each sign of the override mapping exactly: right-side Z overrides are subtracted, and elbow and knee overrides are subtracted.

- [ ] **Step 4: Run everything.** `npx vitest run tests/unit/skeleton.test.ts` should PASS. `npm run smoke` should PASS; the byte-determinism test proves the rig didn't change.

- [ ] **Step 5: Log and stage.** Add a `MODIFICATIONS.md` line. Run `git add src/engine/skeleton.ts src/renderer/viewport/builders.ts tests/unit/skeleton.test.ts MODIFICATIONS.md`. Do not commit.

### Task 2: Shot solver

**Files:**
- Create: `src/engine/shot.ts`
- Test: `tests/unit/shot.test.ts`

**Interfaces:**
- Consumes: `frameSubject`, `verticalFov`, `ASPECT_RATIOS`, `SHOT_SIZES` (`src/engine/camera.ts`); `personDims`, `poseEffectors`, `toWorld` (Task 1); `assetSpec` (`src/engine/assets.ts`).
- Produces:
```ts
export type ShotSide = 'front' | 'frontLeft' | 'left' | 'backLeft' | 'back' | 'backRight' | 'right' | 'frontRight' | 'line'
export type ShotAngle = 'eye' | 'low' | 'high' | 'overhead' | 'ground'
export interface ShotSpec {
  size: ShotSizeId
  subjectIds: string[]
  over?: { entityId: string; shoulder: 'left' | 'right' }
  side?: ShotSide
  angle?: ShotAngle
  lens?: number
  dutchDeg?: number
}
export interface ShotSubject { id: string; assetId: string; params?: Record<string, number | string>; scale: number; position: V3; heading: number; joints?: Record<string, number> }
export interface ShotSetup { sensorId: SensorId; aspect: AspectId; focalLength: number }
export interface SolvedShot { position: V3; pan: number; tilt: number; roll: number; focalLength: number; achievedSize?: ShotSizeId }
export function solveShot(spec: ShotSpec, subjects: ShotSubject[], setup: ShotSetup, lineSide: 1 | -1 = 1): SolvedShot
```
Rules, all mine:
- **Side azimuth.** The angle from the first subject's facing to the camera: front 0°, frontRight 45°, right 90°, backRight 135°, back 180°, backLeft 225°, left 270°, frontLeft 315°. A subject's "right" is its own right. `line` puts the camera perpendicular to the subject-0 → subject-1 line, on `lineSide`.
- **Defaults.** A single defaults to `frontRight`; a group defaults to `line`. The angle defaults to `eye`, and the lens to `setup.focalLength`.
- **Distance.**
  - Singles: `frameSubject(size, topY, …).distance`, where `topY` is the FK head-top (`head.y + headR`) for people and `max(height, 2 × footprint) × scale` for other things.
  - Groups: the larger of the tallest subject's vertical requirement and `(spread + 0.8) / (2·tan(hfov/2)) / 0.85`. `spread` is the subjects' extent across the view direction, and `hfov = 2·atan(tan(vfov/2)·aspectRatio)`.
- **Camera height.**
  - eye: the aim point's y
  - low: 0.5 m
  - high: eye + 1.5 m
  - ground: 0.15 m
  - overhead: straight above the aim point at the required distance, tilt −π/2
- **Over the shoulder.**
  - The camera sits at the `over` entity's shoulder (FK, world) + 0.55 m away from the subject along their line, + 0.25 m outward on the named side, + 0.12 m up. It aims at the subject's head centre.
  - Given a lens, use it and report `achievedSize` (the nearest `SHOT_SIZES` entry by visible fraction). Otherwise solve the focal length for the size, clamped to 12–135 mm.
- **Dutch.** `roll = dutchDeg` in radians.

- [ ] **Step 1: Write the failing tests.** Use a test helper `project(p, cam, setup)` that returns NDC from a pinhole with `vfov` and aspect.
  - `MS single at eye level: head-top NDC y = 0.92 ± 0.01, head x = 0 ± 0.01`. Repeat for CU (0.90) and WS (0.65).
  - `side right puts the camera on the subject's own right`: subject heading 0 (facing −Z) gives camera.x > subject.x.
  - `two-shot keeps both heads and both outer shoulders inside |NDC| ≤ 0.95`, for subjects 1.2 m and 3 m apart.
  - `OTS over A's right shoulder`: the camera is within 0.7 m of A's right shoulder, on A's right side; B's head is at NDC x = 0 ± 0.02; with a lens of 50, `focalLength === 50` and `achievedSize` is defined.
  - `vehicle WS frames the car by footprint`: a sedan's front and back bumper points are inside the frame, and both are visible.
  - `overhead looks straight down`: tilt = −π/2 ± 1e-6.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/shot.test.ts` should FAIL.

- [ ] **Step 3: Implement `solveShot`.**

- [ ] **Step 4: Run them.** They should PASS.

- [ ] **Step 5: Log and stage.**

### Task 3: Live shot marks in the evaluator

**Files:**
- Create: `src/engine/shot-track.ts`
- Modify:
  - `src/engine/types.ts:144-152` (`CameraMark`: add `shot?: ShotSpec`; import the type)
  - `src/engine/evaluate.ts:385-430` (`evaluateCamera`: when any mark has `shot`, take the shot-track branch before the car-mount, aim-lock and rig-noise stages)
- Test: `tests/unit/shot-track.test.ts`

**Interfaces:**
- Consumes: `solveShot` (Task 2).
- Produces: `evaluateShotTrack(marks: CameraMark[], time: number, solve: (m: CameraMark) => SolvedShot | null): { position: V3; pan: number; tilt: number; roll: number; focalLength: number; focusDistance?: number }`.
  - It picks the bracketing marks by `time` / `hold`.
  - Each mark's pose is `solve(m)` when `m.shot` is set and solvable; otherwise it is the stored position, pan, tilt, roll and focal length.
  - The two poses are blended with the same `smoothstep(easedProgress(…))` the plain path uses: position by lerp, angles by `lerpAngle`.
- Aim lock (`trackEntityId`) is skipped when the active mark has `shot`. Rig noise still applies.

- [ ] **Step 1: Write the failing tests.**
  - `a single MCU shot mark keeps the walker framed at t = 0, 2.5, 5`: reuse the `evaluate.test.ts` fixture's walking man; the head-top NDC is within ±0.01 of 0.92 at every time.
  - `blend from a plain mark to a shot mark reaches the solved pose at the shot mark time`.
  - `missing subject falls back to the stored pose`.
  - No new test is needed to prove that marks without `shot` are unchanged. The untouched upstream `tests/unit/evaluate.test.ts` and the smoke byte-determinism test cover it, and both must stay green.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/shot-track.test.ts` should FAIL.

- [ ] **Step 3: Implement it.** Adding an optional field on `CameraMark` needs no schema change. Add one `schema.test.ts`-style round-trip assertion in the new test file: `parseProject(JSON.stringify(doc))` keeps `marks[0].shot`.

- [ ] **Step 4: Run everything.** `npm test` should PASS. `npm run smoke` should PASS, because `evaluate.ts` changed.

- [ ] **Step 5: Log and stage.**

### Task 4: Shot words parser

**Files:**
- Create: `src/engine/shot-words.ts`
- Test: `tests/unit/shot-words.test.ts`

**Interfaces:**
- Produces: `parseShotWords(text: string, entities: { id: string; name: string; label?: string }[]): { spec: ShotSpec; time?: number } | { error: string }`
- Vocabulary (case-insensitive; every token must be understood, or the error lists the words it didn't understand):

| Concept | Words |
|---|---|
| Size | `ews`, `extreme wide`; `ws`, `wide`; `fs`, `full`; `ms`, `medium`; `mcu`, `medium close-up`; `cu`, `close-up`, `close up`; `ecu`, `extreme close-up` |
| Group | `two-shot` / `2s` / `2-shot` of `X and Y`, or `on X and Y` |
| Subject | `on X` |
| Over the shoulder | `over X's (left\|right) shoulder`, or `ots X` (defaults to the right shoulder) |
| Lens | `<n>mm` |
| Angle | `eye level`, `low angle`, `high angle`, `overhead`, `ground level` |
| Side | `from (the) front\|behind\|left\|right`, `3/4 left`, `3/4 right`, `profile` (= right) |
| Dutch | `dutch <n>` (degrees; `°` optional) |
| Time | `at <t>s` |

Names match an entity's label text first, then its name, ignoring case. An unknown or ambiguous name gives an error that lists the labels. `over X` where X is a subject gives an error.

- [ ] **Step 1: Write the failing tests.**
  - `'MCU on B, over A's right shoulder, 50mm'` → `{ size: 'MCU', subjectIds: [b], over: { entityId: a, shoulder: 'right' }, lens: 50 }`
  - `'two-shot of A and B, low angle, from the left at 2.5s'`
  - `'cu on hero dutch 15°'`
  - `'MCU on Z'` → an error naming the known labels
  - `'mcu on a with sparkles'` → an error containing `sparkles`
  - `'mcu on a over a's left shoulder'` → an error

- [ ] **Step 2: Run them.** They should FAIL.

- [ ] **Step 3: Implement it** as a small tokenizer and a greedy matcher.

- [ ] **Step 4: Run them.** They should PASS.

- [ ] **Step 5: Log and stage.**

### Task 5: Shot box in the camera Inspector, and the `frame_shot` MCP tool

**Files:**
- Create: `src/renderer/panels/ShotPanel.tsx`
- Modify:
  - `src/renderer/panels/Inspector.tsx`: mount `<ShotPanel />` in the camera section, above "Track subject" (~line 1400)
  - `src/renderer/store.ts`: add an action
  - `src/renderer/control/handler.ts`, `mcp/tools.json`
- Test: `tests/e2e/fight-camera.spec.ts` (new; uses the same launch and rpc pattern as `tests/e2e/mcp-gaps.spec.ts` from the Clara plan)

**Interfaces:**
- Consumes: `parseShotWords` (Task 4), `ShotSpec`.
- Produces:
  - Store action `setShotAtTime(spec: ShotSpec, time: number): string`. It updates the camera mark whose time is within ±1/fps of `time`, or drops a new one; returns the mark id. It runs in one `mutate('frame shot', …)`, and stores the solved pose in `position`/`pan`/`tilt`/`roll`/`focalLength` as the fallback.
  - MCP tool `frame_shot`, titled "Frame the shot".
    - Params: `words` (string), **or** the structured fields `size`✱, `subjectIds`✱, `over`, `side`, `angle`, `lens`, `dutchDeg`; plus `time` (default: the playhead).
    - Returns `{ markId, time, achievedSize? }`.
    - A parse error returns `isError` with the parser's message.
- `ShotPanel` UI:
  - a text input with the placeholder `MCU on B, over A's right shoulder, 50mm`, and **Apply at playhead**
  - beneath it, dropdowns: Size, Subject(s), Over shoulder (none, or `<label> L/R`), Side, Angle, Lens (`LENS_SET`), plus a Dutch number field
  - when the selected mark has `shot`, the Inspector's position, pan and tilt fields render read-only, with the note `Framed by shot words: <summary>`, and a **Release** button that deletes `shot` and keeps the last solved pose

- [ ] **Step 1: Write the failing e2e tests.**
  - Spawn two people labelled A and B.
  - `frame_shot words 'MCU on B, over A's right shoulder, 50mm'` → `ok`; `list_marks camera` shows one mark with `shot.size === 'MCU'`.
  - `frame_shot words 'MCU on nobody'` → `isError`.
  - `screenshot` after framing returns an image. That smoke-checks the live path end to end.

- [ ] **Step 2: Run them.** `npm run build && npx playwright test tests/e2e/fight-camera.spec.ts` should FAIL.

- [ ] **Step 3: Implement the store action, the handler case, the catalog entry and `ShotPanel`.**

- [ ] **Step 4: Run everything.** The e2e tests should PASS, and `npm test` should PASS (the catalog test covers the new case).

- [ ] **Step 5: Visual check.**
  1. Run `env -u ELECTRON_RUN_AS_NODE npm run dev`.
  2. Stage A and B and type the example words.
  3. Scrub while B walks: the MCU holds.
  4. Save a frame with `export_frame` and look at it.

- [ ] **Step 6: Log and stage.**

### Task 6: Fight move tables (impacts detected from motion data)

**Files:**
- Create: `src/engine/fight/moves.ts`
- Test: `tests/unit/fight-moves.test.ts`

**Interfaces:**
- Consumes: `MOTION_PRESETS`, `poseEffectors`, `personDims('person.man')` as the reference rig.
- Produces:
  - `interface StrikeImpact { effector: Effector; t: number; speed: number }`. `t` is in seconds from the motion start. `speed` is the effector's speed in m/s between the previous keyframe and the impact keyframe, clamped to [2, 15].
  - `strikeImpacts(motionId: string): StrikeImpact[]`, memoised. An impact is a keyframe where an effector's forward reach (−Z local, relative to its shoulder or hip) is a local maximum ≥ 0.7 × that effector's maximum reach in the motion, with impacts ≥ 0.15 s apart, sorted by `t`.
  - `STRIKE_IDS`: the `fight`-category motions with ≥ 1 impact, minus the ids in `DEFENSES` and `REACTIONS`.
  - `DEFENSES: Record<'block' | 'parry' | 'slip' | 'duck', { high: string; low: string; readyFraction: number }>`:
    - block: high `block-high`, low `block-low`, 0.4
    - parry: high and low `parry-deflect`, 0.35
    - slip: `dodge-left`, 0.5. The slip side is mirrored per attack side, using `mirrorJoints`.
    - duck: `duck-under` (high) and `weave-bob` (low), 0.45
  - `REACTIONS = { head: 'hit-reaction-head', body: 'hit-reaction-body', stagger: 'stagger-back', knockdown: 'knockdown-fall', ko: 'ko-collapse', getUp: 'get-up-from-ground', guard: 'boxing-guard-bounce' }`
  - `MOVE_ALIASES: Record<string, string>`: `jab`, `cross`, `jab cross` → `jab-cross`; `hook` → `hook-punch`; `haymaker`; `uppercut`; `front kick` → `front-kick`; `roundhouse` → `roundhouse-kick`; `knee` → `knee-strike`; `elbow` → `elbow-strike`; `side kick` → `side-kick`; `spinning back kick` → `spinning-back-kick`; `sweep` → `low-sweep`; `shove` → `shove-two-hands`; `tackle` → `tackle-lunge`. Each alias's target must exist in `MOTION_PRESETS`; the test enforces it.
  - `listFightMoves(): { id: string; name: string; impacts: StrikeImpact[] }[]`

- [ ] **Step 1: Write the failing tests.**
  - `jab-cross has two hand impacts, lead hand first`: effectors `handL` then `handR`.
  - `front-kick has one foot impact`.
  - `hook-punch, haymaker and uppercut each have exactly one hand impact`.
  - `every STRIKE_ID has ≥ 1 impact and every impact speed is in [2, 15]`.
  - `every alias and every DEFENSES/REACTIONS id exists in MOTION_PRESETS`.

  If a motion's data contradicts an expected count, fix the detector, not the expectation, unless the motion visibly contains a different number of strikes; then note it in the test.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/fight-moves.test.ts` should FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run them.** They should PASS.

- [ ] **Step 5: Log and stage.**

### Task 7: Fight script model, text parser and random script

**Files:**
- Create: `src/engine/fight/script.ts`
- Modify: `src/engine/types.ts` (add `FightBeat`, `FightDoc`, and `Scene.fights?: FightDoc[]`)
- Modify: `src/engine/schema.ts:245-258` (`migrateProject`: a missing or non-array `fights` becomes `[]`; never throw)
- Test: `tests/unit/fight-script.test.ts`

**Interfaces:**
- Produces in `types.ts`:
```ts
export type FightOutcome = 'hit' | 'block' | 'parry' | 'slip' | 'duck' | 'miss' | 'ko'
export interface FightBeat {
  attacker: 0 | 1                 // index into FightDoc.fighterIds
  move: string                    // motion id
  target: 'head' | 'body' | 'legs'
  outcomes: FightOutcome[]        // one per impact; shorter lists pad with 'block' for earlier impacts
  power: number                   // 0.2..1, default 0.7
  at?: number                     // explicit start time (s)
}
export interface FightDoc {
  id: string
  name: string
  fighterIds: [string, string]
  beats: FightBeat[]
  startT: number                  // default 0.4
  origin: { x: number; z: number; heading: number }
  beatGap: number                 // default 0.35 s between a beat's recovery and the next step-in
  exaggeration: number            // default 1.5, range 1..3
  coverage?: 'master' | 'punch-in' | 'over-shoulder' | 'follow'
}
```
- Produces in `script.ts`:
  - `parseFightScript(text: string, fighterLabels: [string, string]): { beats: FightBeat[] } | { error: string; line: number }`. One beat per line or per `;`. `<who>` is `A`/`B` or a label. `<move>` is an id, a name or an alias. Then `to head|body|legs` (default by move: kicks → body, punches → head, sweep → legs), `-> o1[, o2]`, `power p`, `at ts`.
  - `formatFightScript(beats, fighterLabels): string`. It round-trips.
  - `randomFightScript(seed: number, style: 'brawl' | 'martial-arts' | 'sparring', durationS: number, opts?: { ending: 'ko' | 'standing' }): FightBeat[]`. It uses an inline mulberry32. Moves come from these per-style pools, keeping only ids that are in `STRIKE_IDS`:
    - brawl: `haymaker hook-punch jab-cross elbow-strike shove-two-hands`
    - martial-arts: `front-kick side-kick roundhouse-kick knee-strike low-sweep spinning-back-kick`
    - sparring: `jab-cross hook-punch front-kick uppercut`

    Then: outcomes are ~50 % `block`/`parry`/`slip` early and more `hit` late; the last beat is `ko` when `ending` is `'ko'`.

- [ ] **Step 1: Write the failing tests.**
  - The parse example in Design: 4 lines give 4 beats, with the expected fields.
  - `format → parse` round-trips 3 random scripts.
  - `'A moonwalk to head'` gives an error at line 1 that names the move.
  - `randomFightScript(7, …)` is deterministic; seeds 7 and 8 differ; the last outcome is `ko` when asked.
  - `parseProject` of a v1 doc without `fights` gives `scene.fights` equal to `[]`, and `fights: 'junk'` gives `[]`.

- [ ] **Step 2: Run them.** They should FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run everything.** `npm test` should PASS, including the untouched upstream `schema.test.ts`.

- [ ] **Step 5: Log and stage.**

### Task 8: Impact physics (closed form)

**Files:**
- Create: `src/engine/fight/physics.ts`
- Test: `tests/unit/fight-physics.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ImpactInput { moveId: string; effector: Effector; speed: number; power: number; outcome: FightOutcome; defender: PersonDims; defenderBuild: number; exaggeration: number }
export interface ImpactResult { impulse: number; v0: number; capture: number; result: 'none' | 'absorb' | 'stagger' | 'knockdown'; stepBack: number; stepDuration: number; slide: number; fallDuration: number }
export function impact(input: ImpactInput): ImpactResult
export function snapCurve(amplitude: number, durationS: number, sampleHz: number): { t: number; value: number }[]
export function snapAmplitude(impulse: number, exaggeration: number): number
```
Constants (exact):
- `g = 9.81`
- `EFFECTIVE_MASS = { hand: 2.9, elbow: 4.0, foot: 6.0, knee: 6.0 }`, keyed by the effector's limb; `shove-two-hands` and `tackle-lunge` use 20.
- Restitution `e = 0.3`: impulse `J = m_e · speed · power · (1 + e)`. A `block` or `parry` scales J by 0.35. A `slip`, `duck` or `miss` gives J = 0 and the result `none`.
- Defender mass `m_d = 72 · (H/1.78)² · build`. Then `v0 = exaggeration · J / m_d`.
- COM height `h = 0.55 · H`, `ω = √(g/h)`, capture `x_cp = v0 / ω`. Foot half-length `f = 0.12 · s`.
- Results:
  - `x_cp ≤ f` → `absorb`
  - `x_cp ≤ 0.6 · legLen` → `stagger`, with `stepBack = x_cp − f + 0.1` and `stepDuration = 0.25 + 0.4 · x_cp / (0.6 · legLen)`
  - otherwise → `knockdown`, with `slide = min(2.5, 1.2 · x_cp)` and `fallDuration = acosh((π/2)/θ0)/ω`, where `θ0 = clamp(v0/(h·ω), 0.05, 0.5)`
  - outcome `ko` forces `knockdown`
- Snap spring: `ωn = 14`, `ζ = 0.35`, `ωd = ωn·√(1−ζ²)`, `θ(t) = A·e^(−ζ·ωn·t)·sin(ωd·t)`, sampled at 15 Hz over 0.6 s. `snapAmplitude = clamp(0.012 · exaggeration · J, 0.05, 0.9)`.

- [ ] **Step 1: Write the failing tests.** Compute the expected values from the formulas in the test.
  - A jab (hand, 8 m/s, power 0.7) on a 1.78 m man is `absorb`.
  - A haymaker (hand, 10 m/s, power 1, exaggeration 1.5) is `stagger`, with `stepBack` > 0.
  - A spinning back kick (foot, 12 m/s, power 1, exaggeration 2) is `knockdown`, with `fallDuration` in [0.3, 1.5].
  - A `block` gives an impulse of exactly 0.35× the `hit` impulse.
  - `ko` forces `knockdown`.
  - `snapCurve` starts at 0, its first peak is ≤ A, and it decays below 0.1·A by 0.6 s.
  - Results are deterministic: identical calls give identical objects.

- [ ] **Step 2: Run them.** They should FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run them.** They should PASS.

- [ ] **Step 5: Log and stage.**

### Task 9: Contact solver

**Files:**
- Create: `src/engine/fight/solve.ts`
- Test: `tests/unit/fight-solve.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 6, 7 and 8; `ChoreoEntitySpec` and `ChoreoMarkSpec` (`src/engine/choreography.ts:65-86`); `mirrorJoints`.
- Produces:
```ts
export interface FighterInput { entityId: string; assetId: string; params?: Record<string, number | string>; scale: number; start: V3 }
export interface BeatReport { index: number; startT: number; impactTimes: number[]; contactErrorM: number[]; clearanceM: number[]; physics: ImpactResult[]; warnings: string[] }
export interface FightSolution { tracks: [ChoreoMarkSpec[], ChoreoMarkSpec[]]; report: { beats: BeatReport[]; warnings: string[]; endT: number } }
export function solveFight(fight: FightDoc, fighters: [FighterInput, FighterInput], shot: { duration: number; fps: number }): FightSolution
export const MAX_FIGHT_MARKS = 400
```
Algorithm, per beat in order:
1. **Start time.** `startT = max(at ?? prevRecoveryEnd + beatGap, fight.startT)`. Snap each impact time `startT + impact.t` to the frame grid `round(x·fps)/fps`, then re-derive `startT` from the final impact. Drop beats whose final impact is past `shot.duration − 0.3`, with the warning `Beat N dropped: past the end of the shot`.
2. **Target point.** Run the defender's FK at the final impact, in the guard pose (`REACTIONS.guard` keyframe 0), at its current spot, facing the attacker.
   - head: head centre + `headR` toward the attacker
   - body: chest + `0.3·bodyW` toward the attacker
   - legs: the lead knee + `0.08 m` toward the attacker
3. **Attacker placement.** The attacker faces the target.
   1. Solve the yaw correction δ (bisection over ±0.35 rad) so the effector's lateral offset is 0.
   2. Solve the pitch correction Δ, applied to `shoulder?X` for hands and elbows or `hip?X` for feet and knees at the impact keyframe and the keyframe before it (bisection over ±0.35 rad), so the effector height matches.
   3. Solve the root distance so the forward reach matches.

   Contact error is the 3D distance between the effector and the target. Outcomes `slip`, `duck` and `miss` aim at the target as if it were a hit, and the defense moves the head away.
4. **Step-in.** Add a `walk` mark at the solved spot, arriving at `startT`. If the distance ÷ available time exceeds 2.5 m/s, delay `startT` by the shortfall and warn.
5. **Defender.**
   - Defenses start at `impact − readyFraction × motion.duration`. For `slip`, `duck` and `miss`, if the head's clearance from the effector at impact is under 0.25 m after the defense motion, add a root sidestep perpendicular to the attack line for the shortfall, arriving at the impact frame.
   - Hits start their reaction **at the impact frame**: head → `REACTIONS.head`, body or legs → `REACTIONS.body`.
   - `impact(...)` then adds:
     - stagger: `stagger-back`, time-scaled so its root travel equals `stepBack` over `stepDuration`
     - knockdown: `knockdown-fall` (or `ko-collapse` for `ko`), time-scaled to `fallDuration`, sliding `slide` along the impulse direction; then `get-up-from-ground`, unless `ko` or it is the last beat
     - head and body targets: the `snapCurve` values added to `headX` (straight strikes; head snaps back, so negative) or `headY` (hooks, signed by attack side); body targets add `torsoX` at +0.6× amplitude
6. **Separation.** Pelvis-to-pelvis distance never drops below 0.35 m, except for the clinch moves listed in Design. If it would, push the defender back along the line and warn.
7. **Rest.** Between beats both fighters return to a 1.1 m guard distance with `REACTIONS.guard`.

Cap each track at `MAX_FIGHT_MARKS`, keeping the beats in order and dropping trailing ones with a warning.

- [ ] **Step 1: Write the failing tests.** These are the core accuracy proof, so they go **through the real evaluator**.
  1. Build a scene with the two fighters' tracks from the solution (as `spawnChoreography` does at `store.ts:889-910`).
  2. Run `new ShotEvaluator(scene, shot).evaluate(impactTime)`.
  3. Compute the effector and target with `poseEffectors` + `toWorld`, using each fighter's evaluated `position`, `heading` and `joints`.

  Tests:
  - `every hit lands within 3 cm on the impact frame`. Use a 6-beat script mixing jab-cross, hook, front-kick, roundhouse and knee, at 24 fps.
  - `defender's reaction starts on the impact frame`: the defender's first reaction mark time equals the impact time ± 1e-9.
  - `blocks are up by impact`: the defender's joints at the impact time equal the block motion's guard keyframe ± 0.05 rad on the shoulders.
  - `slips and ducks clear by ≥ 25 cm`.
  - `knockdown slides the defender along the impulse direction by ImpactResult.slide ± 5 cm`.
  - `pelvises never closer than 0.35 m` (outside clinch beats), sampled every 1/24 s.
  - `unreachable beat reports its error and a warning`: `low-sweep to head`, where contactErrorM > 0.03 and the warning names the beat.
  - `beats past the shot end are dropped with a warning`.
  - `20-beat fight stays ≤ 400 marks per track`.
  - `mixed sizes`: child (height 0.8) vs man (height 1.2, build 1.3); every hit is ≤ 3 cm.
  - `deterministic`: two solves give equal JSON.

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/fight-solve.test.ts` should FAIL.

- [ ] **Step 3: Implement `solveFight`.**

- [ ] **Step 4: Run everything.** It should PASS, and `npm test` should PASS overall.

- [ ] **Step 5: Log and stage.**

### Task 10: Fight Director (store, UI and MCP tools)

**Files:**
- Create: `src/renderer/panels/FightDirector.tsx`
- Modify:
  - `src/renderer/panels/Library.tsx:212-420` (`Choreographer`): when the routine kind is `fight`, render `<FightDirector />` instead of the fight options. This is the only change there.
  - `src/renderer/store.ts` (actions)
  - `src/renderer/control/handler.ts`, `mcp/tools.json`
- Test: `tests/e2e/fight-camera.spec.ts`

**Interfaces:**
- Consumes: `solveFight`, `parseFightScript`, `formatFightScript`, `randomFightScript`, `listFightMoves`, and `nextLabelColor` (Clara plan, Task 3).
- Produces store actions. Each runs in one `mutate`, and replaces only those two fighters' tracks in the active take.
  - `stageFight(input: { beats: FightBeat[]; at: { x: number; z: number; heading: number }; fighters?: [string, string]; assets?: [string, string]; labels?: [string, string]; exaggeration?: number; coverage?: FightDoc['coverage'] }): { fightId: string; report: FightSolution['report'] }`. With no `fighters` given, it spawns `assets` (default `person.man`, `person.woman`), labelled `A`/`B` with distinct palette colours.
  - `updateFight(fightId: string, patch: Partial<Pick<FightDoc, 'beats' | 'exaggeration' | 'beatGap' | 'startT' | 'coverage'>>): FightSolution['report']`
  - `deleteFight(fightId: string): void`. It removes the doc; the tracks stay.
- Produces MCP tools:

| Tool | Title | Params | Annotations |
|---|---|---|---|
| `list_fight_moves` | List fight moves | — | readOnly |
| `stage_fight` | Stage a fight | `script` (text) **or** `beats` (array), `x`, `z`, `headingDeg`, `fighterIds` (2), `exaggeration`, `coverage`, `random` (`{seed, style, ending}`) | — |
| `update_fight` | Change a fight | `fightId`✱, `script` or `beats`, `exaggeration`, `coverage` | — |
| `get_fight` | Read a fight | `fightId`✱ | readOnly |
| `delete_fight` | Remove a fight | `fightId`✱ | destructive |

  All but `delete_fight` return `{ fightId, script, report }`, where `script` is the `formatFightScript` text.
- `FightDirector` UI:
  - a monospace script textarea, showing parse errors inline
  - **Random** (style dropdown, ending dropdown, seed field) fills the textarea
  - an Exaggeration slider (1–3), and a Coverage dropdown (none / master / punch-in / over-shoulder / follow)
  - **Stage fight** arms floor placement, the same as Spawn routine. **Apply to 2 selected** works when exactly 2 people are selected.
  - a report list, one row per beat: `3 · A hook → head · hit · 1.2 cm · stagger 0.31 m`, with a ⚠ and the warning text where present
  - editing a staged fight's script and pressing **Re-solve** calls `updateFight`

- [ ] **Step 1: Write the failing e2e tests.**
  - `stage_fight` with the 4-line Design script → `ok`; the report has 4 beats, every hit is ≤ 0.03, and `get_state` shows 2 new entities with different colours.
  - `update_fight` with one line changed re-solves, and `list_marks` for the defender changes.
  - `stage_fight` with `random: { seed: 7, style: 'martial-arts', ending: 'ko' }` gives a final beat with outcome `ko`.
  - `get_fight` with a bad id gives an error mentioning `get_state`.

- [ ] **Step 2: Run them.** `npm run build && npx playwright test tests/e2e/fight-camera.spec.ts` should FAIL.

- [ ] **Step 3: Implement the store actions, the handler cases, the catalog entries and `FightDirector`.** `get_state` lists `scene.fights` as `{id, name, fighterIds, beats: n}`.

- [ ] **Step 4: Run everything.** The e2e tests should PASS, `npm test` should PASS, and `npm run smoke` should PASS.

- [ ] **Step 5: Visual check.**
  1. Stage the Design script in the gym kit.
  2. Export at 720p with `export_shot`.
  3. Build a contact sheet at the impact times with `ffmpeg -ss <t> -frames:v 1` for each, then `tile`.
  4. Look at every impact frame: the fist or foot touches the head or body. Save the sheet under `.maestro/` for Lior.

- [ ] **Step 6: Log and stage.**

### Task 11: Fight coverage (beat-aware camera)

**Files:**
- Create: `src/engine/fight/coverage.ts`
- Modify:
  - `src/renderer/store.ts` (`updateFight` / `stageFight` apply coverage when set)
  - `src/renderer/control/handler.ts`, `mcp/tools.json`
- Test: `tests/unit/fight-coverage.test.ts`, `tests/e2e/fight-camera.spec.ts`

**Interfaces:**
- Consumes: `FightSolution['report']`, `ShotSpec`, and `solveShot` (for the side choice).
- Produces:
  - `fightCoverage(fight: FightDoc, report: FightSolution['report'], mode: NonNullable<FightDoc['coverage']>, lineSide: 1 | -1): { time: number; shot: ShotSpec; easeIn: number; easeOut: number; hold: number }[]`
  - Applying it replaces the active camera's marks with these, and clears `trackEntityId`.
  - MCP tool `fight_coverage`, titled "Cover the fight with the camera". Params: `fightId`✱, `mode`✱, `side` (`left` | `right` of the fight line; default: the current camera's side).
- Modes, all on one side of the A–B line (`lineSide`):
  - `master`: one mark at `startT − 0.3`, `{ size: 'WS', subjectIds: [A, B], side: 'line' }`.
  - `punch-in`:
    - a base `MS` two-shot at the start
    - for each impact with physics `stagger` or `knockdown`, or outcome `ko`: a mark at `impact − 0.2` with `{ size: 'MCU', subjectIds: [defender], side: 'line' }`, eased in
    - a mark at `impact + 0.7` back to the `MS` two-shot, skipped if the next punch-in comes before then
  - `over-shoulder`: for each beat, a mark at `startT − 0.3` with `{ size: 'MCU', subjectIds: [defender], over: { entityId: attacker, shoulder: <the shoulder on lineSide> } }`.
  - `follow`: sets rig `handheld` (intensity 0.4), with a mark per beat at `startT − 0.2`: `{ size: 'MS', subjectIds: [attacker] }`.

- [ ] **Step 1: Write the failing tests.** Evaluate through `ShotEvaluator` with the coverage marks applied.
  - `master keeps both fighters' heads inside |NDC| ≤ 0.95 at every 1/24 s`.
  - `punch-in arrives at MCU on the defender at each big impact`: at the impact time, the defender's head-top NDC y is 0.92 ± 0.03.
  - `camera never crosses the fight line`: the sign of the cross product (B−A) × (cam−A) is constant across all samples.
  - `over-shoulder puts the camera behind the attacker's lineSide shoulder for each beat`.
  - `follow puts one MS mark on each beat's attacker`. The handheld rig is set by the store and checked in the e2e test in Step 4.

- [ ] **Step 2: Run them.** They should FAIL.

- [ ] **Step 3: Implement it, plus the store wiring, the handler case, the catalog entry and the FightDirector coverage dropdown** (already present from Task 10; it now takes effect).

- [ ] **Step 4: Run everything.** `npm test` should PASS. `npm run build && npx playwright test tests/e2e/fight-camera.spec.ts` should PASS, including two new tests: `fight_coverage punch-in` → `list_marks camera` count ≥ 2 and every mark has `shot`; `fight_coverage follow` → `get_state` shows `shot.rig === 'handheld'`. `npm run smoke` should PASS.

- [ ] **Step 5: Visual check.** Export the Design fight with `punch-in` and look at the contact sheet: the camera pushes in on each big hit, stays on one side of the line, and both fighters stay readable. Save the sheet under `.maestro/`.

- [ ] **Step 6: Log, document and stage.** Add the new tools and Fight Director to `AGENTS.md` (Key subsystems and the tool table) and `mcp/README.md`, add a `MODIFICATIONS.md` line, then stage.

## Example script (used by Tasks 9–11)

```
A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1
```
