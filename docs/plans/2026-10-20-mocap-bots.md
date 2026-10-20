# Mocap bots: Mixamo X Bot / Y Bot with Mixamo motion

## Context

Lior asked for the UE5 mannequins (male and female) and Mixamo motion. Quinn and Manny are Epic content licensed for use with Unreal Engine only, so he picked Mixamo's own mannequins instead: **Y Bot (male) and X Bot (female)**. He wants Mixamo mocap to drive **all of it**: gaits, the motion library and fights. Crd will fetch the files in his signed-in Chrome.

Why: the hand-keyframed motion is the fork's weakest part. Round 4 couldn't make push-ups, crawls, falls or a cartwheel read. Mocap on a recognisable previs mannequin is also what video models see most often as "3D previs" input.

## Rules this plan keeps

- **No Mixamo files in git.** Mixamo's terms forbid redistributing raw character and animation files, and converted data counts. Everything lives in a local library folder, `<config dir>/mixamo/` (`resolveConfigPath`, so `BLOCKOUT_CONFIG_DIR` works). Without the folder, the two bot types are hidden and the existing bodies work as they do today.
- **No Epic assets.** Keep "Unreal", "Manny" and "Quinn" out of ids and UI. The ids are `person.mocapMale` / `person.mocapFemale`, shown as "Mocap man" / "Mocap woman".
- **Upstream data and tests stay untouched.** `MOTION_PRESETS` keeps its 18 channels (`round4.test.ts:70`). Clips live in a separate registry.
- **Engine purity.** `src/engine` never loads FBX. The renderer loads it, samples it into plain data and registers that with the engine.
- **Determinism.** Each frame comes from (document, t) only: bone rotations are set from samples at t, never through an `AnimationMixer` that accumulates. Exports wait until the library has loaded.
- **Code style.** Blockout style. Prefer new files with small hooks into upstream files, and log every change in `MODIFICATIONS.md`.

## Shape of the change

- **Body abstraction (engine).** The 11-bone rig is one body kind. The Mixamo skeleton is the second: about 25 bones (Hips, Spine/1/2, Neck, Head, the clavicles, arms, forearms, hands, legs and feet; fingers stay at rest), with quaternion FK built from the registered bind pose. Every FK consumer reaches the body through one call that returns the same frames and effectors it uses today. Pelvis, torso, head, shoulder, elbow, hip and knee map onto mixamorig bones; hand and toe become real bones. The consumers are floor.ts, fight/*, weapons.ts, shot.ts and camera-clear.ts. Floor and contact proxies for the bots are capsules fitted per bone from the skinned mesh at load time.
- **Clips in the document.** A mark gets an optional `clip: { id, at, mirror? }`. Between two marks on the same clip, the clip time runs linearly, so one `apply_motion` writes 2 marks plus any anchors instead of one per keyframe. The existing `joints` on a mark become an additive overlay on the clip. That overlay is how the fight solver aims a strike onto its target. The field is optional, so `parseProject` needs no migration.
- **Retarget layer.** Bots without a clip still play every existing keyframe motion and procedural gait: the 18-channel pose is retargeted onto mixamorig bones (world rotation × bind correction, with the torso spread over Spine/Spine1/Spine2). So everything works on bots from phase 1, and mocap takes over move by move.

## Phase 0: Fetch the library (crd, in Lior's Chrome)

1. Lior signs in at mixamo.com in his Chrome.
2. Crd resolves every clip name with the site's own search. It shows Lior the final list (names, count, about 50 MB) and waits for a yes before downloading.
3. Crd runs the exports in that tab through the site's own export calls. The sign-in token never leaves the page. Crd then fetches the returned download links with curl into `<config dir>/mixamo/`. That route avoids Chrome's Save-As dialog. Fallback: click through the UI while Lior presses Save.

Export settings:
- **Characters:** X Bot and Y Bot, FBX Binary, T-pose, with skin.
- **Clips:** FBX Binary, without skin, 30 fps, no keyframe reduction, all on Y Bot. They are retargeted to X Bot by bind correction, with hips travel scaled by hip height.
- **In Place:** on for the travelling loops (walk, jog, run, crouch-walk, crawl) and off for anything whose root travel matters (falls, knockdowns, cartwheel, get-up).
- **`manifest.json`:** written next to the files. It records each clip's id, exact Mixamo name, in-place flag, loop flag and the Blockout gait, preset id or fight move it serves.

About 77 clips:

| Group | Clips |
|---|---|
| Gaits (~12) | breathing idle, walk, jog, run, crouch idle, crouch walk, stand-to-sit, sitting idle, lying idle, talking, left/right turn, falling |
| Library (~40) | push-ups, crawl, kneel, sit-down, fall flat, fall backwards, stumble fall, get up, cartwheel, jump, cheer, wave, point, clap, think, phone, texting, pick up, throw, kick ball, sneak, drunk walk, backflip, climb, rifle idle / aim / fire, pistol idle / fire, and 6–8 dances (hip-hop, salsa, samba, swing, house, shuffle …) |
| Fights (~25) | fight idle, jab, cross, hook, uppercut, elbow, front kick, roundhouse, knee, body block, head block, head hit, stomach hit, side hit, stagger, knocked down, knocked out, get up from back, sword-and-shield slash / block, great-sword slash, plus 2–3 grapples (headbutt, shove) |

Verify: `manifest.json` lists every file, and each FBX loads in a throwaway three FBXLoader check (bone count and duration printed).

## Phase 1: Lane `mocap-body`, the bots on screen

1. **Library access.** Main IPC `mocap:list` / `mocap:read` is confined to the library folder. The renderer loader (`src/renderer/mocap/`) uses FBXLoader and SkeletonUtils.clone, at 0.01 scale to metres, yawed 180° to face −Z.
   → verify: unit test on a hand-built fixture skeleton; the app logs the bones and clips it loaded.
2. **Engine body kind** (`src/engine/mocap/`: rig, FK, bind data, proxies, registry), with the call sites switched to the body call.
   → verify: unit tests with a fixture skeleton (no Mixamo data in tests); rendered bones match engine FK to within 1 mm. The existing suites stay green.
3. **Catalog and rendering.** Add the two bot types to `assets.ts`, a skinned-mesh builder (placeholder-then-swap like `loadCustomModel`) and the retarget of today's gaits and joint overlays. Hand the hand bone to `hold.ts`. Add tint via `userData.origColor`. Add the skinning chunks to the depth-pass ShaderMaterial (`SceneManager.ts:137`). Exports wait for loading.
   → verify: every existing gait and preset is grounded on bots within ±2 cm (sampled at 1/12 s); a double export is byte-identical; the depth pass shows posed bots, not the bind pose.
4. **Pickers.** Add the bots to the Library, Inspector, Fight Director "Bodies" and Choreographer, and make them the default bodies when the library exists. The prompt noun is "a man" / "a woman", and prompt.txt says what the grey mannequin is.
   → verify: e2e `mocap-bots.spec.ts` (skipped when the library is missing); visual sheet of bots vs procedural mannequins.

## Phase 2: Lane `mocap-clips`, mocap motion

1. **Clip data.** The renderer samples each FBX clip into `{ fps, frames, quats per bone, hips position }`, registers it, and mirrors left/right on request.
   → verify: unit tests on a synthetic clip (sampling, looping, mirror, shortest-arc blending).
2. **Mark `clip` field** in `types.ts` / `schema.ts` / `evaluate.ts` (clip time between marks, overlay on top, posedMove root from the hips track, floor rule through the body proxy).
   → verify: evaluator unit tests; `parseProject` round-trip; old projects unchanged.
3. **Gaits from clips.** Each gait maps to its loop clip, with the phase driven by distance over the clip's measured stride, so feet don't slide.
   → verify: foot-slide metric (planted foot drift < 2 cm per step) and feet on the floor within ±2 cm.
4. **Library.** Map preset id → clip (the manifest table). `apply_motion`, the Inspector, the group panel, the Choreographer and sequences use the clip when the body is a bot, and the keyframe motion otherwise. MCP `list_motion_presets` says which ones have mocap. prompt-scene names clip runs.
   → verify: mcp-catalog test; the BACKLOG floor moves (push-ups, crawl, kneel, sit, falls, get-up, cartwheel) make their pose on both bots. Sheet reviewed by crd, then shown to Lior.

## Phase 3: Lane `mocap-fights`, the Fight Director on bots

1. **Strike data.** For each fight move with a clip, its impact frame is the striking effector's peak extension in clip FK, and it replaces the keyframe impact (`fight/moves.ts:154`).
2. **Solve.** Spacing and timing put the impact frame on the target. The exact reach comes from the additive overlay (shoulder, elbow and torso lean, ≤ 20° as today), blended in and out around the impact. Reactions come from clips by target: head hit, stomach hit or side hit. Knockdown and KO combine the clip with the existing physical knockback root.
3. **Fallback.** Weapon moves without a clip fall back to the retargeted keyframe moves.
   → verify, on all 7 qa-fight scripts on both bots: the fist or foot lands within 1.5 cm of the target surface on the exact frame; the bodies never interpenetrate by more than 3 cm; planted feet stay within ±2 cm; a double export is byte-identical. Before/after sheets.

## Phase 4: Lane `mocap-qa` (test only, no edits)

The full gate, smoke, the fork e2e plus `mocap-bots.spec.ts`, and three H3-style exports (a fight, a foot chase, a dance) using the bots. Results go on a sheet for Lior.

## Running it

- **Order:** phases run one after another. Phase 2 needs the body kind from phase 1, and phase 3 needs clips in marks. Each lane writes its own `docs/plans/2026-10-20-mocap-<name>.md` first.
- **Lane rules:** the round-4 rules (`.maestro/coord/IMPL.md`): stage only, heavy commands through `heavy.mjs`, crd delivers rulings with `send_to_session`.
- **Commits:** only when Lior says "commit", with the verified-tree method.
- **Done means:** typecheck + lint + npm test + smoke green, and the lane's own checks printed.

## Out of scope / known limits

- Fingers stay at rest.
- The Blender `.glb` export keeps bots as root transforms, like today's people.
- Crowds of bots are capped by GPU skinning (fine for tens, not hundreds).
- A clone without the local library has no bots (by design, for licensing).
- Upstream's design note "a walk cycle is math, not mocap" (`DESIGN.md:187`) no longer holds for bots. Nothing binary enters git.
