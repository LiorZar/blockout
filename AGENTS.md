<!-- Modified for cross-platform Windows support and the fork's additions in 2026; see MODIFICATIONS.md. -->

# AGENTS.md — running & modifying Blockout with an AI agent

This file is the single source of truth for AI coding agents (Claude Code, Codex, Hermes, OpenClaw, …) working on this repo. `CLAUDE.md` points here.

## What this app is

Electron + TypeScript + React + Three.js desktop previs tool. Filmmakers stage grey-box scenes, choreograph camera/actor **marks** on a timeline, and export deterministic motion-reference packages (MP4 + depth pass + stills + prompt) for AI video generators. Full product spec: `docs/DESIGN.md`.

## Commands

```bash
npm install            # once; Node 22+; ffmpeg needed for exports (brew install ffmpeg)
npm run dev            # run the app with hot reload
npm run build          # production build into out/
npm start              # run the production build
npm run typecheck      # strict TS, two projects (renderer+engine, main+e2e)
npm run lint           # ESLint (zero warnings allowed on main)
npm test               # Vitest engine unit tests (fast, no GPU)
npm run smoke          # build + Playwright end-to-end: real export, ffprobe-verified
npm run package:mac    # download+audit pinned FFmpeg pair, then current-architecture macOS DMG
                       # (add: npm run prepare:ffmpeg:mac -- --build-from-source to rebuild from source)
npm run package:win    # Windows x64 NSIS installer (run after npm ci on Windows)
```

**Definition of done for any change: `npm run typecheck && npm run lint && npm test` green, and `npm run smoke` green if you touched engine/, export/, main/, or SceneManager.**

## Repo map

```
src/engine/     PURE TypeScript. No DOM, no three.js, no Electron imports — ever.
                The deterministic core: state(t) evaluator, camera math, paths,
                easing, rig noise, gaits, schema, prompts, generator profiles.
                All logic changes here need unit tests in tests/unit/.
src/main/       Electron main process: window, IPC, ffmpeg spawning, file I/O.
src/preload/    Typed IPC bridge (window.blockout). Keep in sync with main.
src/renderer/   React UI. store.ts (zustand; ALL doc mutations go through
                store.mutate for undo), panels/, viewport/ (SceneManager owns
                three.js), export/ (frame loop → ffmpeg, glTF, ComfyUI).
tests/unit/     Vitest (engine only). tests/e2e/ Playwright (smoke + screenshots).
assets/         (profiles as code in engine/profiles.ts; 3D assets are procedural)
```

## Key subsystems (recent rounds)

- **Motion library** (`src/engine/motions.ts`): 194 motion presets (plus fork motions joined from `src/engine/motions-fork.ts`, e.g. `rifle-aim-fire`) across `fight`/`dance`/`gesture`/`everyday`/`sport`/`stunt`. The rig joint set added `hipLZ`/`hipRZ` (leg abduction — positive swings the leg outward from the midline), `torsoZ` (lateral torso lean, positive = right), and `headZ` (head tilt, positive = right). All default to 0, so existing content renders unchanged; the joint→bone mapping lives in `animatePerson` in `src/renderer/viewport/builders.ts`, sign conventions in the `motions.ts` header. Any test enumerating legal joint names must include the four.
- **Choreography engine** (`src/engine/choreography.ts`, PURE): `buildRoutine(spec, ctx)` turns a `RoutineSpec` (`dance`/`fight`/`chase`, performers, durationS, seed, style/options) into per-performer marks compatible with `sequences.ts`. Seeded (inline mulberry32 — the caller in the renderer randomizes the default seed, never the engine). Dances use 8-count phrases with formations/canon/mirror; fights are paired attack→reaction exchanges (reactions offset so they land mid-attack, distance re-closes after knockbacks); chases run a serpentine path with scripted near-misses. `mirrorJoints` swaps L/R pairs and flips Y/Z-symmetric channels. Store wiring: `spawnChoreography(spec, at)` (fresh cast) and `choreographSelected(spec)` (retarget selected people). UI: the Library **Choreographer** panel. Fork (set-routines): `RoutineCtx.set` (`src/engine/routine-set.ts`, read off the scene's kits and props by `renderer/routine-set.ts`) keeps a routine on the set: a chase runs along the street or laps the open floor (cut short, with a warning, where the set can't hold it at a run), a dance or fight moves to clear floor; `ctx.notes` / `ctx.warnings` say so (toast, MCP `notes` / `warnings`). No floor and no solid: exactly as before.
- **3D scans** (`Scene.scans: ScanRef[]`): Gaussian-splat / photogrammetry environments imported via the `scan:import` IPC (`.ply/.splat/.spz/.ksplat` copied into the project `scans/`). Rendered by `@mkkellogg/gaussian-splats-3d` in `SceneManager` (`scansGroup`/`scanVisuals`), transformable from the Inspector Scans section. **Editor-only**: `scansGroup.visible=false` in `renderFrameAt` and `renderTopDown` — worker-based splat sorting can't guarantee byte-deterministic exports, so scans never enter any pass (they are listed in the package `metadata.json`). Schema migration defaults `scans` to `[]` and never throws.
- **Sky & editor chrome** (`SceneManager`): the `middaySky`/`goldenHourSky`/`blueHourSky` lighting presets drive a `three/examples` `Sky` dome — a deterministic function of `sunAzimuth`/`sunElevation` with fixed turbidity/rayleigh per preset, so it renders byte-identically in the **clean** export and is hidden in the depth/normal passes. Spike-tape marks and path ribbons live in `overlay` sub-groups (`marksGroup`/`pathsGroup`, HUD eye toggles `showMarks`/`showPaths`); selection adds direction chevrons + `t=…s` labels for the picked lane only. The bottom-right `ViewHelper` gizmo and the selected-entity **emissive tint** are editor-only — the gizmo renders in its own corner viewport (never in `this.scene`), and `renderFrameAt` neutralizes the tint for the duration of every pass so selection can't affect exported pixels. The Shoot **Take bar** (Viewport) and **Set your marks** coach (Help/App) are pure compositions of existing store actions.
- **Shot words + Fight Director** (fork; `src/engine/skeleton.ts`, `shot*.ts`, `fight/`, PURE): `skeleton.ts` is the person rig's FK (`buildPerson` takes its lengths from `personDims`; FK and renderer agree to 1e-6, and the `motions.ts` header is the joint-sign spec). A camera mark with `shot` (`ShotSpec`, from `parseShotWords`) is re-solved every frame by `solveShot` (`shot-track.ts` hooked into `evaluateCamera`). `solveFight` turns a beat script (`fight/script.ts`) into ordinary actor marks with `lockFacing` (the evaluator keeps their facing and posed gait): impacts on the frame grid, blows placed by FK within 3 cm (kicks may lift the kicker, blocks reach the blow), closed-form knockback (`fight/physics.ts`) that stops at set props (`fight/obstacles.ts`; the store reads prop footprints off the built geometry in `renderer/fight-obstacles.ts`), and `fight/coverage.ts` camera modes on one side of the line. Store: `setShotAtTime`, `stageFight` / `updateFight` / `coverFight`, `solveInScene` (every fight solve, props included), `refightShot` (re-solves a shot's fights after an fps / duration change, inside the same mutate); a two-person routine fight goes through `stageFight`. UI: the camera Inspector's Shot box and the Choreographer's Fight Director. Fork (fight-speed): solves are remembered by their inputs (`fight/solve-memo.ts`, shared with the prompt), and a bot fight (seconds to solve) stages and re-solves in a worker: `offThread(run)` (`renderer/fight-offthread.ts`, `fight-worker.ts`) runs the store action in planning mode (a solve the memo lacks stops it; `mutate` commits nothing), solves the misses in the worker (its registry replays the renderer's bot and clip registrations) and runs the action for real once all hit; `stageFightOffThread` / `updateFightOffThread`; no worker (Vitest) solves here as before.
- **Studio mannequins** (fork; `person.mannequinMale` / `person.mannequinFemale`): procedural sculpted bodies (`src/renderer/viewport/mannequin-mesh.ts`, ≤ 8k triangles each, Phong plastic, panel seams, darker recessed joints) built by `buildMannequin` on the same named joint groups, `personDims` lengths and `animatePerson` as `buildPerson`, so FK, every motion and the fight solver work unchanged (`tests/unit/skeleton.test.ts` cross-checks both at 1e-6). Weapons find the hand at `(0, −lowerArmLen, 0)` in `elbowL` / `elbowR`; keep those names and that point. The Fight Director's **Bodies** select stages fights with them (`stageFight({ assets })`).
- **Held weapons + hit power** (fork; `src/engine/weapons.ts`, `fight/physics.ts`, `fight/moves.ts`, PURE): `Entity.heldBy` puts a weapon in a hand. `ShotEvaluator.evaluate` calls `applyHolds` after marriages: holders blend in idle hold poses (long guns at low ready), a two-hander's off hand reaches the grip by closed-form IK, and a held weapon's state sits in the hand frame computed from `personDims` + joints; `SceneManager.applyHeldWeapons` draws the grey-box models from `weapon-builders.ts`. Scenes without holds evaluate exactly as before. In fights (`FighterInput.weapons`) blades land with the weapon, and `shoot` beats play the weapon's own aim (`gunAimMove`: `pistol-aim-fire`, the shouldered `rifle-aim-fire`, `bow-draw-loose`) along a line through the target. Hit power: each impact carries a nominal peak speed (`STRIKE_SPEED`), the limb's mass scales with the attacker's, a held weapon adds its mass and leverage (`weaponHeft`), and a guard takes half the blow, so jabs absorb, power punches stagger, and roundhouses and heavy weapons knock down (`tests/unit/fight-tune.test.ts`). Store: `holdWeapon` / `spawnHeldWeapon` / `dropWeapon`; MCP: `list_weapons` / `hold_weapon` / `drop_weapon`.
- **Floor contact** (fork; `src/engine/floor.ts`, PURE): `bodyLowY(body, joints)` is the lowest surface point of a posed person (a proxy on the `poseFrames` bones, within 5 mm of the rendered meshes; if you change a body's meshes, `tests/unit/floor.test.ts` tells you to update its proxy). Gaits ground themselves with it (`animatePerson`), motion keyframes use `motionRootY` (a keyframe that doesn't lift the body rests on the floor), and on a leg between two motion-playback (`posedMove`) marks the evaluator keeps the facing and stand gait and the body's lowest point on the line between keyframes (`evaluate.ts`); travel legs stay upstream.
- **Clear camera views** (fork; `src/engine/camera-clear.ts`, PURE; `src/renderer/camera-view.ts`): shot words (`setShotAtTime`), fight coverage (`writeCoverage`), `apply_framing` and the people-follow camera moves keep the camera out of walls, props and bodies with the subject in view. The set comes in as data (`cameraBoxes` in `renderer/fight-obstacles.ts`: meshes as boxes at full height, glass included; anything under 0.35 m and whatever the kit's own animation moves excluded); cast is read off the evaluator. A blocked view takes the nearest clear one (closer on a wider lens, higher, swung round) when the mark is made; shot words store it in `ShotSpec.view`, applied by `solveShot` every frame, so a clear view is unchanged and nothing geometric runs on `state(t)`. Tool results carry `note` / `warning`. Fork (shot-clear): a view also keeps the set from covering more than 10 % of a framed subject's projected box, feet included (`setCover`, checked on every frame of the span); every other camera-move preset is fitted to the set as a whole (`src/engine/move-clear.ts`: closer on a wider lens, higher, its sweep cut and turned; ≤ 20 %), or warns.
- **Mocap bots** (fork; `person.mocapMale` / `person.mocapFemale`, "Mocap man" / "Mocap woman"; `src/engine/mocap/`, `src/renderer/mocap/`, `src/main/mocap.ts`): Mixamo's Y Bot and X Bot, read at startup from the user's local library `<config dir>/mixamo/` (`manifest.json`, `characters/*.fbx`, `clips/*.fbx`; IPC `mocap:list` / `mocap:read`, confined to that folder; `BLOCKOUT_CONFIG_DIR` moves it). **No Mixamo file, and nothing sampled from one, may enter git or `tests/`**: test fixtures are hand-built mixamorig skeletons (`tests/unit/mocap-fixture.ts`, `mocap-three-fixture.ts`), and the tests that read the real files skip without them. The renderer registers each bot's bind pose and skinned vertices (`registerMocapTemplate`); the engine fits an A-rest (arms down and turned out just clear of the hips, legs vertical, catalog height), dims, support-point floor proxies, limb capsules and a torso loft. `personDims` / `poseFrames` / `poseEffectors` branch on `dims.mocap` first, so every FK consumer poses bots and the procedural bodies are bit-identical. The visual (`renderer/mocap/body.ts`) clones the template and sets its bones every frame from a hidden 11-bone rig that `animatePerson` poses (no AnimationMixer); named markers (`elbowL` …) carry the engine frames for `hold.ts`. Without the library (or before it loads) a bot is its studio mannequin and the bots are hidden from the pickers and `list_assets`; exports wait for the library. The Fight Director's and Choreographer's Bodies (`RoutineSpec.bodies`) and the Inspector's Body default to / offer the bots when present; MCP defaults stay man and woman. **Clips** (phase 2; `src/engine/mocap/clip.ts`, `clip-marks.ts`, `gait-clips.ts`, `library-clips.ts`, `src/renderer/mocap/clips.ts`, `scene.ts`): the renderer samples every library take once at load into plain data the engine registers (rig rotations against the source bot's A-rest, fingers included, hips, a clearance curve), so any bot plays a clip through the bind correction and every consumer (floor, weapons, shot words, the renderer) sees the same grounded pose. An optional `ActorMark.clip` `{ id, at, mirror? }` plays a clip: between two marks of one run the clip time runs linearly, `joints` add on top as an overlay, a root-motion clip moves the performer by its hips track, a clip mark's y is its floor; `EntityState.clip` carries it, and `poseFrames` / `poseEffectors` / `bodyLowY` take it as a third argument. On a loaded bot each gait plays its loop clip (travelling loops on distance through a time warp off the planted contact; the crouch still is `crouchStill`, the crouch idle with the crouched walk's arms at rest; the sit is the chair idle over a seat prop, `SEAT_ASSETS`, and the floor sit elsewhere; a sit-down's clip marks carry the seat's top, `MarkClip.seat`, and the pose rests the hips on it, `mocap/seat.ts`), a bare stand plays the idle clip (a stand under joint offsets keeps the keyframe rig), and gait changes crossfade (fork set-routines: every loop plays at the bot's one foot phase, `EntityState.loopPhase`, `mocap/loop-phase.ts`, so the loops crossfaded have the same foot down). The motion library maps presets onto clips in `PRESET_CLIPS` (`MOTION_PRESETS` is untouched) and offers clip-only motions as `mocap-<clip>` ids; `apply_motion`, the Inspector, the group panel, the Choreographer and Sequences lay a bot's motion as a clip run (two marks; an in-place travelling loop runs on the warp; a sit-down over a seat prop stands, sits back onto it and holds the chair idle, elsewhere it sits on the floor), everything else keeps the keyframes; `list_motion_presets` adds `mocap` / `mocapOnly`. A bot that isn't a clip's source keeps a planted knee put on a travelling loop (`mocap/contact-lock.ts`). Where a bot's posed clip marks carry its root further, or turn it more, than the clips do (a fight's step-in, walk back to guard, stagger), the evaluator hands the pose that window (`ClipState.step`) and its grounded feet step instead of gliding (`mocap/footwork.ts`; `new ShotEvaluator(scene, shot, { footwork: false })` leaves them to the clips, as the fight solve's own checks do). Joint channels `handL` / `handR` (0 relaxed … 1 fist) shape a bot's hands only (no bone moves; `mirrorJoints` swaps them); any fork test enumerating joint channels includes them, upstream `MOTION_PRESETS` never use them.
- **Car chases on an open road** (fork, street-kit; `src/engine/road-kit.ts`, `vehicles.ts`, `vehicle-speed.ts`, `src/renderer/viewport/road-kit.ts`, `src/renderer/camera-move.ts`): `env.openRoad` is a city street whose drivable length is `params.length` (layout as engine data, `roadLayout`); the Library / `spawn_sequence` car chase lays one under itself (`carChaseRoad`, kept out of `generateSequence`'s output) or runs along the open road it is placed on and lengthens it (`spawn_sequence` returns `roadId`); each car drives two marks with its line in `via` points, at speed from frame 0. `vehicles.ts` holds each vehicle's drawn box (`vehicleBox`, `vehicleCorners`, `boxReach`). Camera moves on a vehicle: `CameraMoveContext.subjectBox` scales a preset's near distances, and `clearMove` keeps the car's box in frame or warns; `layCameraMove` is `applyCameraMove`'s pipeline without WebGL. `ShotEvaluator.warnings()` checks a road / rail / water vehicle on its path (top speed, launch, braking, cornering) and a follow camera against its rig's top speed, with a `message`; people keep the gait check. A staged car chase on a camera with no marks lays Lead the Subject on LEAD in the same undo step (`putCameraMove`; `spawn_sequence` returns `camera`), and a follow or aerial move on a moving vehicle names the rig that keeps up (`LaidMove.rig`: Car mount, or Drone in the air) while the rig is the default Sticks; `applyCameraMove` sets it (`apply_camera_move` returns `rig`).

## Hard rules

1. **Engine purity**: `src/engine/` must never import DOM/three/Electron. It runs in Vitest under Node.
2. **Determinism**: nothing on the `state(t)` path may use `Math.random()` (unseeded), `Date.now()`, or accumulate state frame-to-frame. Rig shake uses the seed stored on the shot. The smoke suite has a byte-determinism test that will catch violations.
3. **All document mutations go through `store.mutate(label, fn)`** or an existing store action — never assign into `store.doc` directly (breaks undo and dirty tracking).
4. **Conventions**: meters, seconds, radians. Heading 0 faces −Z and `object.rotation.y = heading` (see `headingOf` in `src/engine/path.ts`). Models are built facing −Z with origin at ground.
5. Exports must contain zero editor chrome (grid, gizmos, selection boxes, marks). `SceneManager.renderFrameAt` handles this — preserve that behavior.

## Automation surface (driving the running app)

The renderer exposes `window.__blockout` (not a public API — for tests/agents):

- `__blockout.store` — the zustand store. `getState()` gives you every action: `addEntity(assetId, pos)`, `dropActorMark(entityId, pos)`, `dropCameraMark(pos, pan, tilt, focal)`, `setTime(t)`, `setMode(...)`, `mutate(label, fn)`, `scene()`, `shot()`; round-3 additions: `marryEntities(childIds, parentId)` / `unmarryEntities(ids)`, `switchCamera(name)` / `addCameraToShot()` / `clearCameraMarks()`, `saveDraftOfShot()` / `promoteDraft(id)` / `deleteDraft(id)`, `toggleEntitySelected(id)` / `toggleMarkSelected(entityId, markId)`, `setRecording(bool)` (records the selected performer, or the camera — playback-synced when other motion exists).
- `__blockout.exportShot({profileId, passes, labels})` — run a real export; resolves `{ok, packagePath}`.
- `__blockout.renderStillPngForTest(t, w, h)` / `renderRawForTest(t, w, h)` — deterministic frame renders.
- `window.__blockout_scene` — the live SceneManager (transform gizmo, freeCam, shotCam) for interaction tests; see `tests/e2e/interaction.spec.ts` for real-mouse gizmo-drag and camera-recording patterns.

Headless/dialog-free driving: launch with env `BLOCKOUT_SMOKE_DIR=/some/dir` — the New/Open Project dialogs are bypassed and use `$BLOCKOUT_SMOKE_DIR/Smoke.blockout`. See `tests/e2e/smoke.spec.ts` for a complete scripted session (Playwright `_electron`).

## Common tasks

- **Add a generator profile**: edit `BUILTIN_PROFILES` in `src/engine/profiles.ts` (see `docs/generator-profiles.md`). Add a prompt test in `tests/unit/schema.test.ts`. Fork: `maxFileMB` caps the encoder's bitrate, `maxPromptChars` trims the prompt, `promptStyle: 'previs'` ends it with the profile's own clause, `minDuration` / `maxFrames` / `resolutionCaps` add warnings (`profileWarnings`); the prompt's proxy map / action / camera sections live in `src/engine/prompt-scene.ts` (tests: `tests/unit/profiles-h3.test.ts`, `tests/unit/profiles-models.test.ts`, `tests/unit/prompt-scene.test.ts`).
- **Add a library asset**: add a catalog entry in `src/engine/assets.ts` (id, height, speedScale, motion), a builder case in `src/renderer/viewport/builders.ts` (grey-box, deterministic, forward −Z), and an emoji thumb in `src/renderer/panels/Library.tsx`.
- **Add an export pass**: extend `RenderPass` in `SceneManager.renderFrameAt`, wire a toggle in `DeliverPanel.tsx` and the pass loop in `export/exporter.ts`.
- **Change the document schema**: bump nothing lightly — update types in `engine/types.ts`, factories/validation in `engine/schema.ts`, and the round-trip test. Never break `parseProject` on existing files; migrate instead.

## Agent control (MCP)

Blockout ships an MCP server so you can drive a **running** app from Claude Code, Codex, Hermes, or any MCP client — stage entities, drop marks, reframe, scrub, and grab a viewport screenshot without touching the UI.

**How it works.** On launch the main process starts a localhost-only HTTP control server (`src/main/control.ts`) on a random port with a bearer token, and writes a protocol-v1 discovery descriptor (`{ protocolVersion, app, appVersion, port, token, pid, startedAt, capabilities }`) under `~/.config/blockout` on macOS/Linux or `%APPDATA%\blockout` on Windows (mode 0600 where supported, deleted on quit). The MCP bridge `mcp/blockout-mcp.mjs` (zero-dependency Node ≥18 stdio server) reads both v1 and legacy descriptors and forwards each tool call to the control server, which relays it to the renderer over the `control:invoke` / `control:result` IPC pair. Discovery and auth are automatic — nothing to configure, and if the app isn't running the tools return "Blockout isn't running — launch the app first."

**Register with Claude Code** (one line — use this repo's absolute path):

```bash
claude mcp add blockout -- node /ABSOLUTE/PATH/TO/blockout/mcp/blockout-mcp.mjs
```

**Generic stdio config** (Codex, Hermes, or any MCP client that takes a JSON server list):

```json
{
  "mcpServers": {
    "blockout": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/blockout/mcp/blockout-mcp.mjs"]
    }
  }
}
```

**Tools** (each maps to a control action of the same name; coordinates in meters, +X right, −Z forward/away, heading 0 faces −Z, `rotationDeg` / `panDeg` counter-clockwise seen from above, so 90 faces −X):

| Tool | Params | Does |
|---|---|---|
| `get_state` | — | Project/scene/shot summary incl. entity + mark listings (call first) |
| `list_assets` | `category?` | The placeable asset catalog |
| `add_entity` | `assetId, x, z, label?, rotationDeg?, color?` | Place something |
| `move_entity` | `entityId, x, z, y?, rotationDeg?` | Reposition an entity |
| `delete_entity` | `entityId, name?` | Remove an entity (`name` is shown on Clara's approval card) |
| `add_actor_mark` | `entityId, x, z, time, gait?` | Drop an actor timeline mark |
| `add_camera_mark` | `x, y, z, panDeg, tiltDeg, time, focalLength?` | Drop a camera mark |
| `clear_camera_marks` | — | Clear the active shot's camera marks |
| `set_shot` | `name?, duration?, aspect?, fps?` | Update shot settings |
| `new_shot` | `name?` | New shot, same blocking |
| `apply_framing` | `kind: 2S\|OTS\|REV\|TOP\|LOW\|DUTCH, entityIds?` | Auto-frame the camera |
| `list_action_presets` / `apply_action_preset` | — / `entityId, presetId` | Motion-path presets for non-character performers (plane, heli, bird, car chase, debris); lay one on an entity, replacing its marks |
| `list_sequence_styles` | — | Styles per `spawn_sequence` type |
| `spawn_sequence` | `type, count, style?, x?, z?, headingDeg?` | Stage a crowd sequence — `dance` / `fight` / `footChase` / `carChase` — performers + choreography |
| `list_camera_moves` / `apply_camera_move` | — / `presetId, entityId?` | Camera moves (fork: the 42 ids and names shared with Ebook Studio, `src/engine/camera-moves.json`, plus variants; old ids are aliases); generate one's camera marks around a subject (replaces camera marks) |
| `set_track_subject` | `entityId?` | Aim-lock the camera on an entity (none = off) |
| `list_choreography_options` | — | Choreography vocabulary: kinds, styles, formations, endings |
| `spawn_choreography` | `kind, performers, durationS?, style?, formation?, canon?, mirror?, formationChange?, ending?, bpm?, seed?, x?, z?, headingDeg?` | Stage a dance/fight/chase — fresh performers + their per-beat blocking |
| `choreograph_entities` | `entityIds, kind, style?, …` (same routine options) | Retarget existing people into a routine (keeps assets/labels) |
| `list_motion_presets` | `category?` | The single-performer motion library (`{id,name,category,duration}`) |
| `import_scan` | `sourcePath` | Import a `.ply/.splat/.spz/.ksplat` scan (editor-only); returns the scan |
| `set_scan_transform` | `scanId, position?, rotationDeg?, scale?, visible?, flipped?` | Move/rotate/scale/show-hide an imported scan (`flipped` rights an upside-down .splat) |
| `remove_scan` | `scanId` | Remove an imported scan from the scene |
| `snap_to_ground` | `entityId` | Rest an entity on the ground |
| `set_time` / `play` / `stop` | `t` / — / — | Scrub, play, stop |
| `screenshot` | — | Current viewport as a PNG (image result) |
| `list_presets` / `save_preset` / `apply_preset` | — / `name` / `id` | Global stage presets |
| `set_reference` | `videoPath, handoffVersion?, mode?, opacity?` | Attach a reference clip (copied into `refs/`) as a ghost/PIP underlay. Motion sends handoff v1; missing stays legacy-compatible. |

Fork additions (2026; the catalog is `mcp/tools.json`, shared by both transports and kept in step with `handler.ts` by `tests/unit/mcp-catalog.test.ts`). Fork params on the upstream tools above: `add_entity` `color?` (labelled entities get distinct colours automatically), `delete_entity` `name?` (Clara's delete card says "Remove {name}"), `apply_framing` `entityIds?`, `spawn_sequence` `bodies?` (`[men's, women's]` person asset ids, e.g. the mocap bots; ignored by a car chase), `spawn_choreography` `bodies?` (the same, for every routine kind), `add_actor_mark` / `add_camera_mark` / `update_mark` `handle?` (a mark's curve handle in meters, `null` clears it) and `via?` (points the path passes through from the previous mark, `[]` clears them), reported by `list_marks`; `apply_camera_move` builds the move around `entityId` (never a set kit); `spawn_sequence` / `spawn_choreography` / `choreograph_entities` route a two-person fight to the Fight Director. `get_state` also reports colours, held weapons, `scene.environment` in degrees, camera-mark ids and their `shot`, rig, the camera's shared `move`, `allScenes`, and `mocap` (`ready` once the Mixamo library has loaded the bots and every clip; a tool that casts or moves a bot waits for it, up to 120 s, and fails clearly after that). Export file names carry a date-time stamp (a repeat within one second gets `-2`), so nothing is overwritten.

| Tool | Params | Does |
|---|---|---|
| `new_scene` / `select_scene` / `select_shot` | `name?` / `sceneId` / `shotId` | Add a scene, switch scene or shot |
| `set_lighting` | `preset, sunAzimuthDeg?, sunElevationDeg?, fog?` | One of the 9 lighting presets |
| `set_entity_style` | `entityId, label?, color?, name?, heightScale?, build?, hideInExports?` | An entity's look; height 0.8–1.2 and build 0.8–1.3 for people only (`notes` say when clamped or ignored) |
| `set_camera_rig` | `rig, intensity?` | sticks / dolly / steadicam / handheld / crane / drone / carMount |
| `list_marks` / `update_mark` / `delete_marks` | `lane` / `lane, markId, …, release?` / `lane, markIds` | Timeline marks; `lane` is `camera` or an entity id. A shot-words camera mark is re-solved every frame: its pose takes edits only with `release: true` |
| `apply_motion` | `entityIds, presetId` | A motion-library move on people |
| `undo` / `redo` / `save_project` | — | History and save |
| `list_export_profiles` | — | Export targets |
| `export_shot` | `profileId?, passes?, labels?, resolution?` | Export the package (default `seedance-2`, clean + depth; `minimax-h3-max` for MiniMax H3 Max, `ltx-2.3-render-to-real`, `kling-v3-omni`, `seedance-2.5` for those models); returns `packagePath`, `relativePath`, `prompt`, `warnings` (limits the shot breaks) |
| `export_frame` / `export_contact_sheet` / `export_scene_animatic` | `profileId?, resolution?, labels?` / — / `profileId?, resolution?` | Still, contact sheet, scene animatic |
| `frame_shot` | `words` or `size, subjectIds, over?, side?, angle?, lens?, dutchDeg?`; `time?` | Shot words ("MCU on B, over A's right shoulder, 50mm") → a live camera mark re-solved every frame. Over a shoulder, the shoulder stays in frame and the eyes sit on the far third; a high / low angle may back the camera off (`achievedSize` says what the frame is) |
| `list_fight_moves` | — | Strikes, aliases, default targets and impacts |
| `stage_fight` | `script` / `beats` / `random`, `x?, z?, headingDeg?, fighterIds?, assets?, labels?, exaggeration?, coverage?, weapons?` | Scripted two-person fight; returns `{ fightId, script, report }` (per-beat contact error, physics, lift, warnings). `weapons: [A's, B's]` arms the fighters: blows land with the blade or point, `A shoot to body -> hit` fires a held gun |
| `update_fight` / `get_fight` / `delete_fight` | `fightId, script?/beats?, exaggeration?, coverage?` / `fightId` / `fightId` | Re-solve, read, forget a fight |
| `fight_coverage` | `fightId, mode, side?` | Camera coverage of a fight: `master` / `punch-in` / `over-shoulder` / `follow`, on one side of the fight line |
| `list_weapons` / `hold_weapon` / `drop_weapon` | — / `entityId, assetId` or `weaponId, hand?` / `weaponId` | Held weapons: the catalog and current holds; put one in a hand (spawned or picked up); set it down |

**HTTP transport.** The main process also serves these tools over MCP Streamable HTTP (`src/main/mcp-http.ts`) at `http://127.0.0.1:17480/mcp` (`BLOCKOUT_MCP_PORT` overrides; `0` = any free port), relaying through the same `invoke` as the control server. It is localhost-only and refuses foreign `Host` and any `Origin`. `claude mcp add --transport http --scope user blockout http://127.0.0.1:17480/mcp`. e2e specs must set `BLOCKOUT_MCP_PORT` to a free port.

**Example (Claude Code):**

1. Launch the app (`npm run dev`) so the control server comes up.
2. `get_state` — see the current scene, entities, and marks.
3. `add_entity` with `{ "assetId": "person.man", "x": 0, "z": -3, "label": "HERO" }`.
4. `screenshot` — confirm the placement in the viewport.

## Gotchas

- `ffmpeg` resolution order: `BLOCKOUT_FFMPEG` env → packaged BtbN executable on Windows → platform candidates → `ffmpeg`/`ffmpeg.exe` on PATH. The rejected nonfree static package is not a dependency.
- Frames are piped to ffmpeg as **raw RGBA** (`-f rawvideo`, vflipped because WebGL reads bottom-up). Width/height must stay even (h264 yuv420p).
- `renderFrameAt` intentionally renders twice (GL warm-up determinism) — don't "optimize" that away; the smoke test will fail.
- The live viewport loop suspends during exports (`SceneManager.suspendLive`).
- Playwright e2e runs against the **built** app (`out/`) — run `npm run build` first (the `smoke` script does).
