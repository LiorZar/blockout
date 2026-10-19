# Modifications

This distribution is derived from Blockout by Sam Wasserman and retains the
original `LICENSE`, `NOTICE`, credits, and citation metadata.

Frozen upstream base: `6a85105101a0504e38c330b0caae010c957b2321`.

Portable desktop work added in 2026, contributed by
**Gumbii Digital** ([github.com/GumbiiDigital](https://github.com/GumbiiDigital)):

- Windows 11 x64 packaging with a per-user NSIS installer and native window chrome.
- Portable project-relative paths, Windows-safe filenames, and cross-platform UI labels.
- Shared platform configuration and FFmpeg discovery with deterministic asset checks.
- Versioned local-control discovery compatible with existing unversioned descriptors.
- Process-tree-aware export cancellation and cross-platform FFmpeg concat files.
- Windows/macOS/Linux CI, packaging provenance, third-party notices, and SBOM generation.

Downstream distributors should append their own branding and behavioral changes
to this file rather than replacing the original attribution.

Every upstream file changed by this port and capable of carrying comments has
a prominent first-lines notice pointing back to this manifest. The following
changed structured/generated files cannot accept comments without invalidating
their format, so this manifest is their file-level change notice:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.node.json`

New binary and structured release artifacts are likewise identified here:
`build/icon.ico` and `ASSET_MANIFEST.json`. Patch inputs retain their exact
patch syntax and are documented by path under `third_party/ffmpeg/`.

Changes in this fork (2026):

- `CLAUDE.md` now describes the fork's purpose (blockout clips for
  video-to-video AI models), its target models, and its product priorities.
- MCP tool catalog moved from `mcp/blockout-mcp.mjs` into `mcp/tools.json`
  (one catalog for every transport), with customer-facing titles and
  read-only / destructive annotations; packaged via `electron-builder.yml`.
- Person rig forward kinematics in `src/engine/skeleton.ts` (`personDims`,
  `poseEffectors`, `toWorld`); `buildPerson` in `builders.ts` now takes its
  lengths from `personDims` and names its joint groups (no visual change).
- Shot solver `src/engine/shot.ts` (`solveShot`): shot words (size, subjects,
  over-the-shoulder, side, angle, lens, dutch) → an exact camera pose.
- Live shot marks: `CameraMark.shot` (`types.ts`) is re-solved every frame by
  `src/engine/shot-track.ts`, hooked into `evaluateCamera` (`evaluate.ts`);
  marks without `shot` evaluate exactly as upstream.
- Shot words parser `src/engine/shot-words.ts` (`parseShotWords`):
  "MCU on B, over A's right shoulder, 50mm" → a `ShotSpec`.
- Upstream bug fix (worth reporting upstream): `animatePerson` (`builders.ts`)
  applied the motion library's joint values with mirrored signs on
  shoulderLX/RX, shoulderLZ/RZ, elbowL/R, hipLX/RX, hipLZ/RZ and torsoX, so
  blows, guards and front kicks went toward the character's back, "out" went
  inward and elbows hyperextended. They now follow the `motions.ts` header,
  which is the spec (one direction test per channel in
  `tests/unit/skeleton.test.ts`). kneeL/R, torsoY, torsoZ and headZ were
  already right. headX has no direction in the header: positive now nods the
  chin down. The Inspector's "Pose limbs" sliders are relabelled with their
  direction and arm/leg forward sliders flipped so dragging right means
  forward. Limb poses set with those sliders in older projects flip.
- Fight move tables `src/engine/fight/moves.ts`: strike impacts (effector,
  time, speed) detected from the motion data by FK, plus defense, reaction
  and alias tables.
- Fight scripts: `FightBeat` / `FightDoc` and `Scene.fights` (`types.ts`;
  `createScene` seeds `[]`, `migrateProject` in `schema.ts` turns a missing or
  malformed value into `[]`), and `src/engine/fight/script.ts` (parse, format
  and a seeded random script).
- Closed-form impact physics `src/engine/fight/physics.ts`: impulse, capture
  point → absorb / stagger / knockdown, pendulum fall time, damped head snap.
- Fight contact solver `src/engine/fight/solve.ts` (`solveFight`): a beat
  script → actor marks where blows meet their target on the impact frame
  (a kick that can't reach lifts the kicker up to 0.5 m; a blocking arm
  reaches the blow); report measured through `ShotEvaluator`. Supporting opt-in mark flag
  `ActorMark.lockFacing` (`types.ts`, `evaluate.ts`): travel keeps the marks'
  facing and the mark's own gait; marks without it evaluate as upstream.
- Shot box: `src/renderer/panels/ShotPanel.tsx` in the camera Inspector
  (`Inspector.tsx`: mounted above Track subject; a shot-framed mark shows a
  note and Release instead of its pose fields), store actions
  `setShotAtTime` / `releaseShot` (`store.ts`), `ShotEvaluator.solveShotAt`
  (`evaluate.ts`), and the `frame_shot` MCP tool (`handler.ts`,
  `mcp/tools.json`; `list_marks` now includes a camera mark's `shot`).
- Fight Director: `src/renderer/panels/FightDirector.tsx` (script box, random
  script, exaggeration, coverage, Stage fight / Apply to 2 selected / Re-solve,
  per-beat report), shown by the Library Choreographer for the Fight routine
  (`Library.tsx`); store actions `stageFight` / `updateFight` /
  `deleteFight` / `armFightPlacement` (`store.ts`; floor placement reuses the
  choreography placement click); MCP tools `list_fight_moves`, `stage_fight`,
  `update_fight`, `get_fight`, `delete_fight`, and `get_state` lists the
  scene's fights (`handler.ts`, `mcp/tools.json`). `spawn_choreography
  kind:'fight'` keeps upstream behaviour.
- Fight coverage `src/engine/fight/coverage.ts` (`fightCoverage`: master,
  punch-in, over-shoulder, follow — live shot marks on one side of the fight
  line; an over-the-shoulder shot with a line side never crosses it,
  `shot.ts`), applied by `stageFight` / `updateFight` / `coverFight`
  (`store.ts`) and the `fight_coverage` MCP tool (`handler.ts`,
  `mcp/tools.json`); documented in `AGENTS.md` and `mcp/README.md`.
- Camera moves and framing honour an explicit subject (`src/engine/framing.ts`,
  `SceneManager.applyCameraMove/applyFraming`, the `apply_camera_move` /
  `apply_framing` tools) and never fall back to a set kit (`env.*`).
- MCP tools `new_scene`, `select_scene`, `select_shot`, `set_lighting`,
  `set_entity_style`, `set_camera_rig`; labelled entities get distinct colours
  from the shared palette `src/engine/palette.ts` (the Inspector swatches now
  read it); `get_state` reports colours, environment, rig and all scenes.
- MCP tools `list_marks`, `update_mark`, `delete_marks`, `apply_motion`,
  `undo`, `redo`, `save_project` (`src/renderer/control/handler.ts`).
- MCP export tools `list_export_profiles`, `export_shot`, `export_frame`,
  `export_contact_sheet`, `export_scene_animatic`; every `export_*` control
  action gets the 600 s timeout (`src/main/control.ts`).
- In-process MCP server over Streamable HTTP (`src/main/mcp-http.ts`) on
  `127.0.0.1:17480` (`BLOCKOUT_MCP_PORT`), started from `src/main/index.ts`
  after the control server, whose `startControlServer` now returns `{ invoke }`.
  New dependencies `@modelcontextprotocol/sdk` and `zod` (`package.json`).
- Packaged builds register that HTTP server with the installed `claude`,
  `codex` and `copilot` CLIs (`src/main/cli-registration.ts`, wired in
  `src/main/index.ts`).
- A titlebar **Clara** button (`src/renderer/panels/ClaraButton.tsx`, mounted
  in `App.tsx`, `.clara-pulse` in `styles.css`) docks the separately installed
  Clara assistant via `@2dl/clara-client` 0.1.0 (vendored as
  `vendor/2dl-clara-client-0.1.0.tgz`); controller `src/main/clara.ts`, IPC in
  `src/main/index.ts`, `window.blockout.clara` in `src/preload/index.ts`,
  shared types `src/shared/clara-types.ts`.
- `playwright.config.ts` defaults `BLOCKOUT_MCP_PORT` to `0`, so e2e runs put
  the HTTP MCP server on a free port instead of `17480`.
- While an export runs, the control handler refuses every action except
  `get_*`, `list_*`, `screenshot` and `export_*` with "An export is already
  running." (`src/renderer/control/handler.ts`), instead of reporting success
  for an edit the store refused.
- Upstream fix: the extra outlines of a multi-selection no longer leak into
  exports. `SceneManager` hides every selection box (`hideSelectionBoxes`) in
  `renderFrameAt`, the live shot preview and the top-down diagram.
- Upstream fix: the top-down blocking diagram (`stills/*_topdown.png`) no
  longer shows the transform gizmo or the selection tint
  (`SceneManager.renderTopDown`).

A stable or commercial distribution remains gated on upstream/trademark
permission, platform code signing/notarization, a final FFmpeg/H.264
distribution review, and the ordinary complete third-party compliance review.
