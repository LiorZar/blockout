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
- Upstream bug fix, same family (worth reporting upstream): `animatePerson`'s
  gaits set rotations with the same mirrored signs. The run lean, the crouch
  lean and the elderly stoop (`personDims.baseLean`, `skeleton.ts`, now
  −0.18) leaned backward, `sit` put the thighs behind the body, the talk /
  gesture arm rose behind the head, and walk / jog / run hyperextended the
  elbows. On a body facing −Z they now lean forward, sit with the thighs
  forward, raise the talking arm in front and flex the elbows
  (`tests/unit/gaits.test.ts`).
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
- A selected set kit is skipped by camera moves, framing presets, the SHOOT
  size buttons and the Inspector's "built around …" hint while the scene has
  cast (people, vehicles, animals); an explicit id still picks it
  (`framing.ts` `explicit`, `SceneManager.autoFrame`, `Inspector.tsx`). An
  armed placement (asset, sequence, routine, fight) disables the transform
  gizmo and owns the next floor click, so a just-placed set's gizmo can't
  swallow it (`SceneManager.onPointerDown`). Tests:
  `tests/unit/framing-subjects.test.ts`, `tests/e2e/placement.spec.ts`.
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
- While Clara is attaching or docked, the controller lowers the window's
  minimum width from 1100 to Clara's 480 DIP host minimum and restores it
  afterwards (`src/main/clara.ts`); otherwise Electron clamped the host and
  Clara covered its right edge, including the Close Clara button.
- Narrow layout beside Clara: below 1000 px (`NARROW_MAX_WIDTH`,
  `src/renderer/layout/narrow.tsx`) the viewport takes the full width, the
  side panels (Scenes & Library, Inspector) become overlays opened from two
  titlebar toggles (the left one closes when a placement starts), the
  titlebar stays on one line (brand hidden, name ellipsized, "?" for Help)
  and Deliver's panel narrows to `clamp(280px, 40vw, 380px)`. Wired in
  `App.tsx`; rules in `src/renderer/narrow.css`, imported from `styles.css`
  and scoped to `.app.narrow`. e2e: `tests/e2e/narrow-layout.spec.ts`.
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
- Held weapons: `src/engine/weapons.ts` (weapon catalog with grip, tip, aim
  and support points; the rig's hand frame, position and orientation, from
  `personDims` + joints; left/right holds; idle hold poses; closed-form arm
  IK), `Entity.heldBy` and the `weapons` category (`types.ts`), and ten new
  weapon assets (`assets.ts`; `prop.sword` and `prop.baseballBat` are
  holdable too). `migrateProject` (`schema.ts`) drops dangling or impossible
  holds; `ShotEvaluator.evaluate` (`evaluate.ts`) calls `applyHolds` after
  marriages: holders blend in idle hold poses, the off hand of a two-handed
  weapon reaches it, and held weapons' states sit in the hand. Scenes without
  held weapons evaluate exactly as before.
- Held weapons in the viewport: grey-box weapon models
  (`src/renderer/viewport/weapon-builders.ts`, dispatched from `buildAsset` in
  `builders.ts`), and `src/renderer/viewport/hold.ts` (a held weapon's world
  matrix from the rig's elbow / shoulder groups; holding arms don't swing in
  walk / jog / run). `SceneManager` follows the hand every frame
  (`applyHeldWeapons`, after marriages), rebuilds a weapon's visual when it is
  picked up or dropped, keeps its label above the grip, and gives a held
  weapon no gizmo.
- Held weapons in the editor: store actions `holdWeapon`, `spawnHeldWeapon`
  and `dropWeapon` (`store.ts`; a weapon set down stands where the hand was),
  and every entity delete (`handler.ts`, `Inspector.tsx`, `SceneManager.ts`)
  sets the deleted people's weapons down first (`releaseHeldBy`). The
  Inspector shows "Held by / Hold in / Drop" on a weapon and "Weapons / Arm
  with…" on a person; the Library has a Weapons group. `generatePrompt`
  (`prompt.ts`) names a held weapon with its colour, holder and hand ("a
  sword (the green shape) in A's right hand") and no longer prints `("")` for
  a label without text. Idle blades and shafts hold at low ready, tip forward
  and down.
- Held-weapon MCP tools `list_weapons`, `hold_weapon` and `drop_weapon`
  (`mcp/tools.json`, `handler.ts`); `get_state` shows each weapon's `heldBy`
  and reports a held weapon at its grip at the playhead. `delete_entity` reads
  "Remove a person or object" on approval cards, and `export_frame` defaults
  to no labels, like the exported clip.
- Held-weapon e2e (`tests/e2e/weapons.spec.ts`): the rendered sword tip
  matches the engine tip through `sword-slash-combo`, a mid-swing frame
  renders byte-identically, and an export names the sword in the prompt. The
  spear and staff rest as a one-handed carry (`restOneHanded` in
  `weapons.ts`); the off hand takes the shaft as the arm leaves rest.
- Weapon fights: `FighterInput.weapons` (`fight/solve.ts`, additive; unarmed
  fighters solve exactly as before). Blows from an armed hand land with the
  weapon, blocks meet the defender's blade or shield, one-hand weapon moves
  mirror onto the weapon hand, and gun beats (`SHOT_MOVES`, `shotImpacts`,
  `listShotMoves` in `fight/moves.ts`) aim the barrel line through the target
  with the reaction on the shot frame. Script words `sword slash`, `slash`,
  `swing`, `thrust`, `stab`, `lunge`, `shoot`, `fire` (`moves.ts`,
  `script.ts`). `weapons.ts` gains `holdJoints` (shared by `applyHolds` and the
  solver) and `weaponContact`. The store feeds held weapons to the solver
  (`fighterInput`), `stageFight` / `stage_fight` take `weapons`, and the Fight
  Director has a Weapons (A / B) choice (`FightDirector.tsx`).
- Studio mannequins `person.mannequinMale` / `person.mannequinFemale`
  (`assets.ts`): procedural sculpted bodies in the look of a game-engine
  mannequin (`src/renderer/viewport/mannequin-mesh.ts`: lofted muscle volumes,
  panel seams on the chest, abdomen and spine, darker recessed joints, a
  plastic Phong sheen; ≤ 8k triangles each), built by `buildMannequin` in
  `builders.ts` on the same named joint groups and `animatePerson` as
  `buildPerson`; Library thumbs (`Library.tsx`). `personDims`
  (`skeleton.ts`) gains `shoulderX` / `hipX` (classic values unchanged) and
  anatomical mannequin proportions whose head top lands at the catalog
  height. The Fight Director gains a Bodies select (Classic / Mannequin) that
  stages a fight with a male A and a female B (`FightDirector.tsx`). Tests:
  `tests/unit/mannequin.test.ts`, `tests/e2e/mannequin.spec.ts`.
- Hit power (`fight/physics.ts`, `fight/moves.ts`, `fight/solve.ts`,
  `weapons.ts`): each strike's impacts carry a nominal peak speed
  (`STRIKE_SPEED`: jab 5.5 m/s, cross 9, hook 10, roundhouse 12, …) instead
  of the keyframe average; the limb's effective mass scales with the
  attacker's body mass; a held weapon adds its mass (`WeaponSpec.mass`), half
  a hand for a two-hander's off hand, and a swing's leverage
  `(arm + reach) / arm` (`weaponHeft`); a guard takes half the blow (was
  0.35×); `grapple-shove` and `takedown-lunge` are whole-body moves; a stagger
  stumbles `0.25 + 2·(capture − foot)` m, and a guarded stagger rocks the
  defender back behind its guard. Jabs absorb, power punches and front kicks
  stagger, roundhouses and bat / axe / staff hits knock down, so punch-in
  coverage pushes in on the hits that matter. Tests:
  `tests/unit/fight-tune.test.ts`.
- Shouldered rifle aim: `src/engine/motions-fork.ts` holds fork motion
  presets, joined onto `MOTION_PRESETS` by one spread at the end of
  `motions.ts`; its `rifle-aim-fire` is low ready → mount (stock in the
  shoulder, elbow down, head down on the stock, support hand on the
  fore-end) → aim hold → shot → recoil → back on target → low ready. Long
  guns gain a `stock` point (`weapons.ts`) and the shoulder mount turns the
  gun so the stock, not the grip line, points at the shoulder, keeping it
  upright (world up leads, the thumb breaks ties); the rifle's and shotgun's
  support points moved back along the fore-end / pump (−0.24 → −0.17 /
  −0.18) so the support arm reaches without twisting the body. Gun beats
  play the gun's own aim (`gunAimMove` in `fight/moves.ts`): rifle and
  shotgun shoulder it, the pistol keeps `pistol-aim-fire`, a left-hand gun
  plays it mirrored; `list_fight_moves` lists each shot's `guns`
  (`handler.ts`, `mcp/tools.json`). Tests: `tests/unit/rifle-aim.test.ts`.
- MiniMax H3 Max export profile: `minimax-h3-max` in `BUILTIN_PROFILES`
  (`src/engine/profiles.ts`; 1080p, 24 fps, ≤ 15 s) with three optional
  profile fields no upstream profile sets: `maxFileMB` (H3: 50),
  `maxPromptChars` (H3: 2000) and `promptStyle: 'previs'` (the prompt ends
  with the profile's own `adherenceClause`). `src/engine/profile-limits.ts`:
  `encoderMaxKbps` turns the file cap into a libx264 ceiling (`-maxrate` /
  `-bufsize`, capped CRF; worst case `maxrate × (duration + 2 s)` stays under
  90 % of the cap), passed through `exportBegin` (`exporter.ts`,
  `preload/index.ts`, `main/index.ts`; other profiles' encodes unchanged);
  `profileWarnings` (duration over `maxDuration`, an aspect the model doesn't
  list) replaces Deliver's single over-cap chip (`DeliverPanel.tsx`) and is
  returned as `warnings` by `export_shot`; `list_export_profiles` adds the
  caps and `attachHint` (`handler.ts`, `mcp/tools.json`). Tests:
  `tests/unit/profiles-h3.test.ts`, `tests/e2e/export-h3.spec.ts`.
- Prompt scene sections: `src/engine/prompt-scene.ts` (`describeShot`,
  `composePrompt`) hooked into `generatePrompt` (`prompt.ts`). Every profile's
  prompt opens with a proxy map (one line per visible subject: rendered
  colour, shape and label → what it is, with held weapons; unlabelled
  look-alikes share a counted line, "The 8 grey figures are 4 men and 4
  women."), then the action in time order (the same move by several
  subjects at once is one sentence)
  (Fight Director beats re-solved for each blow's outcome, motion-library
  moves recognised from the marks' joints, travel between marks with gait and
  screen direction, two runners on one line as a chase), then the camera
  (live shot words, else the overall move once: rig, travel and lens change,
  never per-leg pans, per upstream's v5 prompt rule),
  then upstream's look / setting lines and directive; image profiles get the
  proxy map only. The proxy map replaces upstream's `Subjects:` line when it
  has something to say, and then the directive calls the shapes placeholders
  for the subjects named above instead of "grey figures" (labelled shapes
  are tinted). Each section is trimmed to the profile's `maxPromptChars`
  (default 1500). Tests: `tests/unit/prompt-scene.test.ts`.
- Over-the-shoulder solve (`src/engine/shot.ts`, `placeOts`): the named
  shoulder joint is pinned at NDC x = ±0.7 on A's side of the frame and the
  subject's eyes on the far third line (head-top on the size's fill line),
  solved exactly from the two rays; the shoulder's height in frame keeps the
  camera on A's eye line (−0.8…0.5). With a lens the size sets the distance,
  without one the camera sits 0.6 m from the shoulder and the lens is solved;
  when both can't hold (camera would pass A, or a wide size on a long lens
  would swing it more than 40° off the A–B axis) the composition wins and
  `achievedSize` reports the size. Long lenses no longer lose A's shoulder.
  Tests: `tests/unit/shot.test.ts`.
- Over-the-shoulder angle and eye line (qa-clara bugs 4, 5; `shot.ts`): the
  eyes sit as near the upper third as the size allows (head-top no higher
  than the fill line, the size's visible region inside the frame); `angle`
  sets the camera height the shoulder bisection aims for (high above A's
  head, low at A's chest, ground near the floor, overhead = high) and backs
  the camera off up to 4× when it can't get there — with a lens the frame
  loosens, without one the lens lengthens and the size holds. `frame_shot`'s
  text says what an OTS honours. Tests: `tests/unit/shot.test.ts`.
- Rotation wording (qa-clara bug 1; `mcp/tools.json`, `handler.ts`
  conventions, `AGENTS.md`, `mcp/README.md`): `panDeg` / `rotationDeg` /
  `headingDeg` turn counter-clockwise seen from above (90 faces −X), as the
  code always did; upstream's text said clockwise. Test:
  `tests/e2e/mcp-gaps.spec.ts` (a +90 camera and person face −X).
- Delete card (qa-clara bug 7; `src/main/clara.ts`, `mcp/tools.json`):
  `delete_entity` takes an optional display `name` and the Clara attach
  options pass `tools: { delete_entity: { label: 'Remove {name}' } }`, so the
  approval card reads "Remove the spear?". Test:
  `tests/unit/clara-controller.test.ts`.
- Shot panel subjects and export names (qa-export B7, B11): the Shot box's
  Subject / Over lists come from `framingCandidates` (`shot.ts`: no set kits;
  people first, then vehicles, animals and the rest), so a set placed first is
  never the default subject (`ShotPanel.tsx`); `exporter.ts` `freshPath` gives
  a repeat export name within one second a -2, -3… suffix (frames, contact
  sheets, animatics, packages) instead of overwriting. Tests:
  `tests/unit/shot.test.ts`, `tests/e2e/mcp-gaps.spec.ts`.
- Shot marks over MCP (`handler.ts`, `mcp/tools.json`): `get_state` camera
  marks carry `shot`; `update_mark` refuses pose edits on a shot-words mark
  with an error that names `release: true` and `frame_shot`, and
  `release: true` freezes the solved framing, drops the words and applies the
  edits in one undo step. Tests: `tests/e2e/fight-camera.spec.ts`.
- MCP polish (`handler.ts`, `mcp/tools.json`, `exporter.ts`): stale-id errors
  of `delete_entity`, `snap_to_ground`, `set_track_subject`,
  `apply_action_preset` and `add_actor_mark` name `get_state`;
  `set_entity_style` clamps `heightScale` / `build` to the rig's 0.8–1.2 /
  0.8–1.3 for people and doesn't store them for other assets (the result's
  `notes` say so); the contact sheet and the scene animatic are timestamped
  (`contact-sheet-<stamp>.png`, `animatic-<stamp>.mp4`) like `export_shot`, so
  re-exports never overwrite. Tests: `tests/e2e/mcp-gaps.spec.ts` (also a
  tool call before a project is open → `isError` "No project open").
- Fights follow the shot's timing (`store.ts` `refightShot`, hooked into
  `set_shot` in `handler.ts`, the Timeline's fps / duration and the
  Inspector's duration): an fps or duration change re-solves every fight
  whose marks are in the shot's take inside the same mutate (one undo step),
  so impacts sit on the new frame grid and beats past a shorter end drop out
  with a warning (they stay in the fight and come back when the shot is long
  enough); a camera that is still the fight's coverage is re-covered.
  `set_shot` returns the re-solved fights' warnings. Tests:
  `tests/unit/fight-resolve.test.ts`, `tests/e2e/fight-camera.spec.ts`.
- One fight system for two people (`store.ts`): a two-person `kind: 'fight'`
  routine (`spawnChoreography` / `choreographEntities`, so MCP
  `spawn_choreography` / `choreograph_entities`) and a 2-performer Sequences
  fight (`spawnSequence`, MCP `spawn_sequence`) go through `stageFight` with a
  seeded `randomFightScript` (style → move pool, ending `finish` → KO) and
  return `fightId`; bigger crowds keep the upstream brawl. The three tool
  descriptions point to `stage_fight`, and the Library's Sequences panel
  says which fights land (`Library.tsx`). Tests:
  `tests/unit/fight-routing.test.ts`.
- Fights keep clear of set props: `src/engine/fight/obstacles.ts` (oriented
  floor boxes, `clearRun`, `pathCrossings`, `clearShift`) and
  `src/renderer/fight-obstacles.ts` (footprints of every static non-person
  entity read off its built geometry in the 0.2–1.7 m band, kits piece by
  piece, cached per asset). `solveFight` takes `{ obstacles, paths }`
  (`solve.ts`): a stagger, guarded push-back or knockdown slide (with the
  fallen body's length) stops at the first prop, every evaluated path that
  still runs into one is warned about, and the solution carries the sampled
  paths. The store solves every fight with the scene's props
  (`solveInScene`, also used by the Fight Director's live report and
  `get_fight`, which now counts held weapons too); a fight that spawns its
  fighters moves up to 3 m to the nearest clear spot and says so. Tests:
  `tests/unit/fight-obstacles.test.ts`, `tests/unit/fight-props-store.test.ts`.
- `stage_fight` takes `assets: [A, B]` (person asset ids, e.g. the
  mannequins) and `labels: [A, B]` for the fighters it spawns (not with
  `fighterIds`; the script may use the labels) (`handler.ts`,
  `mcp/tools.json`). Tests: `tests/e2e/mannequin.spec.ts`.
- Fight coverage keeps weapons and falls in frame (`src/engine/fight/coverage.ts`,
  `fightCoverage(…, { reach })`; the store passes each fighter's longest held
  weapon, grip to tip): an over-shoulder beat with a weapon or a knockdown /
  KO becomes a two-shot on the camera's side of the line (FS; WS for a
  sword, katana, spear or long gun, and for a fall), since a shoulder a metre
  from the defender can't frame more than an MCU over it (punch-in and
  follow: see "Fight coverage shows the blow" below).
  `get_fight` re-solves with the store's `solveInScene`, so its report
  matches `stage_fight`'s (held guns and blades were ignored). Tests:
  `tests/unit/fight-coverage.test.ts`, `tests/unit/fight-tune.test.ts`,
  `tests/unit/fight-props-store.test.ts`, `tests/e2e/fight-camera.spec.ts`.
- Fight moves play fork replacements under their upstream ids
  (`FORK_REPLACEMENTS` / `fightMotion` in `src/engine/fight/moves.ts`, one
  lookup in `solve.ts`; upstream motion data untouched): `haymaker-swing` and
  `elbow-strike-across` twist the torso as the `motions.ts` header says, so
  the wind-up turns the striking shoulder back and the blow lands after it;
  `sword-slash-two-hand` keeps both hands on the grip (≤ 0.1 m apart on every
  body) and turns into each slash (`src/engine/motions-fork.ts`). Tests:
  `tests/unit/fight-moves.test.ts`.
- Shields face the threat: `shield-block-face` / `shield-brace-face` replace
  `shield-block` / `shield-brace` in the library, and a shield holder blocks
  and parries with `shield-block-face` / `shield-block-high` (`SHIELD_BLOCK`),
  mirrored for a right-hand shield, takes the blow on the shield and doesn't
  reach for it (that turned the face away) (`motions-fork.ts`, `moves.ts`,
  `solve.ts`). A stooped body raises its shield arm by its stoop
  (`holdJoints`). Tests: `tests/unit/fight-weapons.test.ts`.
- Shouldered long guns on every body: `holdJoints` retargets the gun arm of
  any body but the reference man to his barrel pitch, yaw and length of pull
  for the same joints (the elderly aimed 12.6° low); the off hand slides back
  along the gun to the farthest point it can reach (`supportReach`, at most
  halfway to the grip), and a child also pulls the gun back until it reaches;
  a gun beat's report says when the hand slid more than 3 cm
  (`src/engine/weapons.ts`, `solve.ts`). Tests: `tests/unit/rifle-aim.test.ts`
  (man, woman, both mannequins, child, elderly).
- The bow fires in fights: `shoot` / `fire` with a held bow plays
  `bow-draw-loose`, shot on its loose keyframe from the bow hand (mirrored for
  a right-hand bow), aimed along the arrow (`SHOT_MOVES`, `gunAimMove`,
  `shotHand`, `shotImpacts` in `moves.ts`; `solve.ts`). Tests:
  `tests/unit/fight-weapons.test.ts`.
- Fight script echoes: a shot beat is written back as `shoot` (it plays the
  held gun's or bow's own aim whichever shot was named; `formatFightScript`
  in `src/engine/fight/script.ts`, the beat labels in `solve.ts`), and each
  beat report names the motion it played (`plays`). The catalog lists the
  spinning backfist once: `spinning-back-fist` is an alias of
  `spinning-backfist` (`DUPLICATE_MOVES` in `moves.ts`; saved fights with the
  old id play the kept move). Tests: `tests/unit/fight-weapons.test.ts`,
  `tests/unit/fight-moves.test.ts`.
- `apply_motion` mirrors a weapon motion onto a left-hand weapon (and a bow
  or shield motion onto a right-hand one) when the performer's weapon for it
  is only in the other hand, as fights already did (`mirrorForHeld` /
  `mirrorForHolder` in `src/engine/fight/moves.ts`; a hook in the store's
  `applyMotionToEntities`). Unheld weapons rest on the floor: one table
  (`weaponRestLift` in `src/engine/weapons.ts`) lifts each model's spec
  points and its built geometry (`onFloor` in `weapon-builders.ts`, applied
  to `prop.sword` too in `builders.ts`); the bow, rifle and shotgun catalog
  heights match the lifted models (`assets.ts`). Tests:
  `tests/unit/weapon-motions.test.ts`.
- A two-hand-grip fight move (`sword-slash-combo`, `TWO_HAND_GRIP` /
  `gripPitch` in `moves.ts`, one call in `solve.ts`) pitches both arms alike
  when the solver aims a blow, so the off hand stays on the grip; the shield
  motions stand in a short lunge (`motions-fork.ts`). Tests:
  `tests/unit/fight-weapons.test.ts`.
- The Fight Director's camera coverage defaults to Master for a new fight
  (`FightDirector.tsx`), so one click stages a fight with a camera; a staged
  fight keeps its own setting. Test: `tests/e2e/fight-camera.spec.ts`.
- A staged fight fits its shot (`store.ts` `stageFight` / `updateFight`): when
  the shot is too short for a beat (the solver would drop it), the shot grows
  to the fight's end + 0.5 s (≤ 60 s) in the same undo step, re-solves the
  shot's other fights for it, and says so in the report, so the example
  script's four beats all play in the default 5 s shot; a fight whose beats
  all play leaves the shot alone. The Choreographer keeps its routine (Fight) when the
  Library remounts (`Library.tsx`). Tests: `tests/unit/fight-resolve.test.ts`,
  `tests/e2e/fight-camera.spec.ts`.
- Fight coverage shows the blow (`coverage.ts`): punch-in pushes in sized to
  the target (head MCU, body MS, legs FS; with weapons to an MS two-shot,
  which holds the weapon and the target, so weapons don't cancel the
  push-in), a fall is a WS two-shot held to the next beat so both fighters
  stay whole, and its two-shot holds a blow to the legs; over-the-shoulder sizes to the target and sits high
  (`angle: 'high'`) so the attacker's guard stays under the defender's face,
  with legs blows as two-shots; follow is a handheld two-shot led by the
  attacker (WS on a fall), so the defender stays in frame. Tests:
  `tests/unit/fight-coverage.test.ts`, `tests/unit/fight-tune.test.ts`.
- Floor contact for people (new `src/engine/floor.ts`): a surface proxy on
  the FK bones (`poseFrames`, now exported from `skeleton.ts`; capsules and
  boxes for the classic people, rings from the section tables for the
  mannequins, within 5 mm of the rendered meshes on every library keyframe)
  gives the lowest point of a posed body. Tests: `tests/unit/floor.test.ts`.
- Gaits stand on the floor (`animatePerson` in `builders.ts`): crouch on the
  balls of the feet (it sank the toes 11–14 cm), sit with the hips at shin
  height so the soles rest on the floor on every body (the fixed 0.45 m seat
  floated or sank them), lie flat with no stoop (the elderly torso sank 9 cm),
  fall grounded; walk is a stance + swing cycle that keeps the lowest foot
  on the floor at every phase. Jog and run plant each foot for a contact
  length solved by leg IK so the planted ankle moves back exactly as fast as
  the body travels (no slide), then kick the heel up, drive the knee high and
  fly briefly (feet at most 4 cm / 6.5 cm off the floor), with a 10° lean
  (run) and bent arms; a held run mark stands (the run used to float its feet
  0.5 m in a split leap). Tests: `tests/unit/gait-floor.test.ts`.
- Library motions reach the floor and never sink below it: upstream
  `playMotion` / `playLooped` (`choreography.ts`) and `appendMotion`
  (`sequences.ts`, the `apply_motion` path) clamped the root at y ≥ 0, so 24
  presets floated (sit-down 0.3–0.7 m, kneel, crawl, falls), and 48 more fold
  the legs with no drop at all. Now a keyframe that doesn't lift the body
  rests its lowest point on the performer's floor and a lifted one keeps its
  height unless a part would sink (`motionRootY`), with the performer's own
  body (`choreographMotion` / `buildRoutine` take it; the store passes it).
  Motion-playback marks carry `ActorMark.posedMove` (`types.ts`): on a leg
  between two of them the evaluator keeps the facing and the stand gait (it
  played a walk cycle under the motion and turned toward vertical or backward
  moves) and moves the body's lowest point in a straight line between
  keyframes (`posedMoveY` in `evaluate.ts`), so nothing dips through the
  floor mid-motion. Travel legs (chase paths, formation walks, legs into or
  out of a motion) and Fight Director marks behave as upstream. Tests:
  `tests/unit/motion-floor.test.ts`.
- Fighters stay on the floor (qa-fight bugs 2, 3; `src/engine/fight/ground.ts`,
  hooks in `fight/solve.ts`): every Fight Director mark rests the posed body's
  lowest point (`floor.ts`) on the fighter's floor, plus the reported kick
  lift, in place of the motions' authored root drops. Crouching and lunging
  moves (low sweep 34 cm, tackle 32, takedown 43, a duck 34) no longer float,
  a get-up after a knockdown no longer pushes the legs 35–47 cm through the
  floor, and the guard's 3 cm sink is gone; where the pose between two marks
  would float or sink more than 1.5 cm, a grounded mark is inserted (within
  the 400-mark cap). Tests: `tests/unit/fight-ground.test.ts`.
- Body blows land on the body surface (qa-fight bugs 9, 4;
  `src/engine/fight/contact.ts`, `fightTarget` in `fight/solve.ts`): a fist,
  elbow, knee, foot or weapon aimed at the body ends where the line from the
  torso axis toward the attacker leaves the torso — the classic capsule (an
  8-sided lathe) or the mannequins' sculpted torso (the section tables of
  `mannequin-mesh.ts`, copied; checked against the built meshes within
  1.5 mm). They used to end 6–7 cm inside. Body kicks aim at the midsection
  (0.3 of the torso, between the belt and the lower ribs) instead of the
  chest. Tests: `tests/unit/fight-contact.test.ts`; the fork tests
  `fight-solve` / `fight-weapons` aim at the same surface.
- Body and legs misses miss (qa-fight bug 5; `bodyClearance` in
  `fight/contact.ts`, the avoid step in `fight/solve.ts`): a miss, slip or
  duck on a body or legs target used to land (a body hook "miss" ended 7 cm
  inside the torso; only the head was cleared). The defender now steps back
  from the blow, or aside, until it clears the whole body (torso surface,
  head, pelvis, arms, legs, feet) by ≥ 10 cm, and the report's clearance is
  that distance. Head slips and ducks are unchanged.
- Reach (qa-fight bugs 8, 4): a blow that still misses after the solve, or a
  body or legs kick that would lift the kicker, is solved again with the
  limbs' pitch ranges 1.8× wider, which brings the attacker in closer (spacing
  rules still hold); the better solve wins. The man's side kick to the
  woman's head lands (it was 24.8 cm off), the woman's body side kick on the
  man stays on the floor (it lifted her 45 cm), and the elbow-strike up to a
  taller head comes within 7 cm (classic, was 21) / 3.3 cm (mannequins, was
  17) and keeps its warning. Head kicks keep their lift. Tests:
  `tests/unit/fight-contact.test.ts`.
- A knockdown on a fight's last beat stays down, like a KO (`fight/solve.ts`):
  the fighter used to walk from the floor straight back to guard with no
  get-up, sinking the walking legs 21–36 cm through the floor. Tests:
  `tests/unit/fight-ground.test.ts`.
- Tool docs (`mcp/README.md`, `AGENTS.md`, `README.md`): both tool tables
  list all 62 tools of `mcp/tools.json` with their current params (the 18
  scene / lighting / rig / marks / history / export tools in
  `mcp/README.md`; the 7 upstream `list_action_presets`,
  `apply_action_preset`, `list_sequence_styles`, `spawn_sequence`,
  `list_camera_moves`, `apply_camera_move`, `set_track_subject` in
  `AGENTS.md`); `AGENTS.md` Key subsystems gains held weapons + hit power;
  `README.md` loses a stray `>>>>>>> Stashed changes` marker and says 62 tools.
- `tests/e2e/control-tools.spec.ts` (upstream test; Lior's one sanctioned
  edit): the app gets a private `BLOCKOUT_CONFIG_DIR` and the spec reads the
  discovery file with `resolveConfigPath('control.json', { env })`, where the
  app writes it, instead of `~/.config/blockout` (wrong on Windows).
- Long guns at rest are carried low (Lior, 2026-10-20): a held rifle or
  shotgun at rest hangs muzzle down across the body, 40° below level and
  turned 70° toward the off side, upright, the grip hand at the waist and the
  support hand on the fore-end, so a walk reads as carrying (it rested at the
  chest, 19° down, nearly an aim). `WeaponSpec.carry` (`weapons.ts`);
  `weaponRotation` turns from the stock rule to the carry as the
  shoulder→grip line drops from 45° to 60° below level, set off the torso's
  level forward (`HandFrame.torso`; `hold.ts` reads the rendered `torso`
  group), so the shouldered aim, the recoil and every `rifle-aim-fire`
  keyframe play exactly as before. A shouldered gun's body retarget fades out
  with the carry. A child still can't reach an adult gun's fore-end at rest
  (the support hand slides back 4.3 cm on the rifle, 7.3 cm on the shotgun).
  Tests: `tests/unit/weapons-carry.test.ts`; the stock-on-the-shoulder-line
  check in `tests/unit/rifle-aim.test.ts` covers shouldered poses (the line
  under 45° below level).
- Talk / gesture at chest height (Lior, 2026-10-20): `animatePerson`'s
  `gesture` gait holds the right forearm forward, the hand in front of the
  chest below the shoulder, beating gently on the shot time; a stoop raises
  the arm as much (the hand used to rise 0.53 m above the shoulder, a hail).
  Tests: `tests/unit/gaits.test.ts` (six bodies, 4 s).
- Clear camera views (fix-camera-set; qa-export B3 c, d;
  `src/engine/camera-clear.ts`, `src/renderer/camera-view.ts`): shot words
  (`frame_shot` and the Shot panel, through `setShotAtTime`), fight coverage,
  `apply_framing` and the people-follow camera moves keep the camera out of
  walls, props and bodies with the framed subject in view. The set comes in
  as data: `cameraBoxes` (`renderer/fight-obstacles.ts`) reads each static
  prop's and kit's meshes as boxes with their full height, shop glass
  included (anything under 0.35 m, and whatever the kit's own animation
  moves, like the club's turning light cones, doesn't count); cast is read
  off the evaluator (people as spheres on the posed rig, moving vehicles and
  animals as boxes). A blocked view takes the nearest clear one over the time
  the mark drives: closer on a wider lens at the same frame size, higher,
  then swung round the subject (fight-line shots at most 60°, over the
  shoulder only higher). Shot words keep the choice in `ShotSpec.view`
  (`turnDeg`, `raise`, `closer`, `blockedBy`, `noClearView`), which
  `solveShot` applies every frame, so a clear view is solved exactly as
  before and nothing geometric runs on the `state(t)` path. A follow move's
  marks each take the nearest clear view of the whole subject (staying near
  the previous mark's), and a cleared mark is added, swung round the subject
  between its neighbours, wherever the evaluated path passes through a wall
  or body, comes within 1.5 m of the subject or half a metre of anyone else,
  or loses the subject. qa-export's scenes (`.maestro/fix-camera-set-visual`):
  the nightclub 2S on six dancers went from 24/24 black frames to 0, every
  dancer seen in 24/24 samples; the downtown chase follow-behind sees the
  runner in 22/24 (was 16/24, the camera 0.46 m from its back) and
  lead-the-subject in 23/24 (was 21/24, 2 flat frames). Results carry a `note` (what blocked
  the view, what changed) or a `warning` (no clear view): `frame_shot`,
  `apply_framing`, `apply_camera_move`, and `fight_coverage`'s `views`. The
  2S math moved unchanged to `engine/framing.ts` (`groupShotPose`). Tests:
  `tests/unit/camera-clear.test.ts`, `camera-clear-store.test.ts`,
  `camera-clear-moves.test.ts`.
- A place behind the action (fix-env; qa-export "void %";
  `src/renderer/viewport/environment.ts`, small hooks in `SceneManager`):
  every lighting preset renders a ground that runs out to a horizon under a
  graded sky, instead of one flat background colour over a transparent
  shadow-catcher (day was RGB 57,64,72 above and below, with no horizon). A
  gradient dome (zenith → horizon → far ground below the horizon, unlit,
  exact sRGB, drawn at the far plane around any camera) and a lit ground
  1 cm under the floor line, 4 km across, with a faint 1 m checker
  (box-filtered, so it never shimmers) that hazes into the far-ground colour
  a little darker than the sky's horizon, so the eye line stays crisp.
  Interiors and the club swap the sky for a dim room surround and haze the
  floor within a hall's depth. The dome is clean-pass only; the ground stays
  in depth / normal as the shadow plane did, so the depth passes are
  unchanged; shadows still come from the upstream catcher. User fog fades to
  the horizon colour. The physical `*Sky` presets keep their sky, scaled by
  `SKY_EXPOSURE` and given the viewport's ACES curve when the renderer has
  none (exports), so midday is a blue sky instead of a white void. All
  values are per-preset constants (`ENV_LOOKS`): deterministic. Tests:
  `tests/unit/environment.test.ts`.
- Export stamps are local time (fix-env): export folders, frames, animatics
  and contact sheets are stamped `YYYY-MM-DD-HH-mm-ss` from the local clock
  (`src/renderer/export/stamp.ts`); `toISOString()` stamped UTC. Tests:
  `tests/unit/export-stamp.test.ts`.
- Fight rest steps and step-ins keep their feet down (fix-fight-legs;
  `animatePerson` in `builders.ts`, `fight/solve.ts`): with joint overrides,
  a gait's root is set after them so the gait pose rests where the stand pose
  with the same joints rests (the evaluator's `floor.ts` rule for fight and
  motion marks); the walk under a fighter's guard floated 5–6 cm (elderly up
  to 9.8 cm). Without overrides, and for stand, nothing changes. Fight
  step-ins walk instead of jogging (a jog's flight lifted both feet up to
  3 cm). Tests: `tests/unit/fight-legs.test.ts` (every walk frame of seven
  fights on six bodies: the lowest foot within ±2 cm).
- Elbows reach a taller head (fix-fight-legs; `fightTarget`, `solveLean` in
  `fight/solve.ts`): an elbow to the head lands on the jaw, the head's
  surface 35° below its middle (it aimed at the middle); an arm blow still
  more than 1.5 cm off after the wider pitch is solved again with a torso
  lean (pitch and side bend, at most 20° on top of the move's own) under the
  re-solved limb pitch, the smallest lean that reaches, and never one that
  takes the attacker's torso or head into the defender's body (or deeper
  than upright); one that still can't reach keeps its warning. The elbow up
  to a taller head lands: woman → man 0.5 cm (was 7.1), mannequinFemale →
  mannequinMale 0.0 cm (was 3.3), elderly → man 0.0 cm with a 14° lean (was
  3.6); mannequinFemale → man 7.3 cm (was 15.4) and the child's arm blows
  on adults stay warned. Kicks don't lean and keep their lift. Tests:
  `tests/unit/fight-legs.test.ts`.
- Root orientation channel for motion playback (fix-root-pitch;
  `skeleton.ts`, `builders.ts`, `floor.ts`, `evaluate.ts`, `choreography.ts`):
  mark joints may carry `rootX` (pitch, + tips forward / prone), `rootY`
  (yaw, + counter-clockwise from above) and `rootZ` (roll, + to the right),
  which turn the whole body about the pelvis joint: the pelvis frame in
  `poseFrames`, the pelvis group in `animatePerson`, so FK, the rendered rig,
  held weapons, shot framing and the floor proxy all see them. The evaluator
  blends them on the shortest arc (a full roll never spins back), and
  `mirrorJoints` negates yaw and roll. On a posed move the body's lowest
  point now follows the straight line between keyframe lows exactly (it used
  to keep the root's own line when that was higher), so a body turning over
  on the floor never hovers. The mannequin floor proxy takes the sculpt's
  full pelvis and torso tables with their glute, lat, chest and bust bulges
  and the deltoid cap (a supine female mannequin sank 1.9 cm), and
  `lowestY` runs allocation-free. Tests: `tests/unit/root-pose.test.ts`
  (rendered rig = FK at 1e-6 with root channels on six bodies, proxy vs mesh,
  conventions, mirror, shortest arc, grounded posed legs).

A stable or commercial distribution remains gated on upstream/trademark
permission, platform code signing/notarization, a final FFmpeg/H.264
distribution review, and the ordinary complete third-party compliance review.
