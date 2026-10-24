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
- Mocap body kind (mocap-body; `src/engine/mocap/`, `skeleton.ts`,
  `floor.ts`, `pose-fit.ts`, `fight/contact.ts`, `weapons.ts`, `assets.ts`):
  `person.mocapMale` / `person.mocapFemale` ("Mocap man" / "Mocap woman")
  are Mixamo's Y Bot and X Bot, read at runtime from the user's local
  library (never from the repo). The renderer registers each bot's bind
  pose and skinned vertices; the engine fits an A-rest (arms down, legs
  vertical, soles on the floor, catalog height), rig dims, frame origins,
  support-point floor proxies, limb capsules and a torso loft. `personDims`
  returns a bot's fitted dims and `poseFrames` / `poseEffectors` branch on
  `dims.mocap` first, so every FK consumer (floor, fights, weapons, shot
  words, clear views, pose fits) poses bots and the procedural bodies stay
  bit-identical. The torso turns over Spine / Spine1 / Spine2 in thirds, the
  head half on Neck. A bot that isn't loaded stands in as its studio
  mannequin. Tests: `tests/unit/mocap-body.test.ts` (a hand-built mixamorig
  fixture: fit, FK, proxies, fight / shot / weapon consumers, and the old
  body call against a frozen copy, compared bit for bit).
- Mocap library access (mocap-body; `src/main/mocap.ts`,
  `src/shared/mocap-library.ts`, `src/main/index.ts`, `src/preload/index.ts`,
  `src/renderer/mocap/`): IPC `mocap:list` returns the manifest of
  `<config dir>/mixamo/` (null without one) and `mocap:read` a file inside it
  (absolute paths and `..` refused, as `file:readAbsolute` in a project). The
  renderer parses the first male and female character with three's
  FBXLoader, reads the bind pose and skinned vertices (FBXLoader's duplicate
  bones skipped) into entity space and registers them; the parsed scene is
  the template each bot visual clones. Without a library nothing loads.
  Tests: `tests/unit/mocap-library.test.ts` (confinement, manifest, a
  three-built FBX-like fixture; the real files only when present, never
  copied).
- Mocap bots on screen (mocap-body; `src/renderer/mocap/body.ts`,
  `builders.ts`, `hold.ts`, `SceneManager.ts`, `export/exporter.ts`):
  `buildAsset` builds a bot from the library template (SkeletonUtils.clone,
  centimetres facing +Z turned into the bot's metres facing −Z), its bones
  set every frame from a hidden 11-bone rig that `animatePerson` poses, so
  every gait, joint override and grounding rule plays on bots; nothing
  accumulates (no AnimationMixer). Until the library loads a bot is its
  studio mannequin, and SceneManager swaps the visuals in when it does.
  Named frame markers (`elbowL` … `torso`) carry the engine's frames, so
  held weapons sit in the palm; `steadyArm` re-poses a bot through a hook.
  Grey Phong plastic tinted through `userData.origColor`. The depth pass
  shader includes three's skinning chunks (a skinned bot rendered in its
  bind pose there). The arms rest turned out by a fitted angle (the least
  that keeps the hanging hands off the hips and thighs), carried in FK and
  arm IK. Exports and `renderStillPngForTest` wait for the library;
  `renderRawForTest` takes a pass. Tests: `tests/unit/mocap-render.test.ts`
  (bones, frames and skin vs engine FK to 1 mm, held pistol, tint, every
  gait and library motion grounded within ±2 cm every 1/12 s on the
  fixture), `tests/unit/mocap-real.test.ts` (the same on Y Bot / X Bot,
  skipped without the library), `tests/e2e/mocap-bots.spec.ts`.
- Mocap bots in the pickers (mocap-body; `Library.tsx`, `Inspector.tsx`,
  `FightDirector.tsx`, `choreography.ts`, `store.ts`, `prompt-scene.ts`,
  `control/handler.ts`, `mcp/tools.json`, `AGENTS.md`): the Library shows
  the bots (🤖) once the library has loaded and hides them otherwise, as do
  `list_assets`, `add_entity` and `stage_fight assets` (a clear error names
  the missing library). The Inspector gets a Body select for people; the
  Fight Director's Bodies and a new Choreographer Bodies select offer
  Mocap and default to it when it is there. `RoutineSpec.bodies` recasts a
  routine's men and women before its posed marks are grounded, so they rest
  on the chosen bodies; a routine two-person fight passes them on as fight
  assets. The prompt calls a bot a light grey mannequin, as it does the
  studio mannequins. MCP defaults stay man and woman. Tests:
  `tests/unit/mocap-pickers.test.ts`, `prompt-scene.test.ts`, the
  mannequin and mocap-bots e2e specs.
- Mocap clip data (mocap-clips; `src/engine/mocap/clip.ts`, `quat.ts`,
  `rig.ts`, `fk.ts`, `src/renderer/mocap/clips.ts`, `library.ts`,
  `src/shared/mocap-library.ts`): the renderer samples every library take
  (FBXLoader, the tracks' interpolants, once at load) into each frame's core
  bone and finger world rotations and hips joint, and registers it; the
  engine keeps rig rotations against the source bot's A-rest, so any bot
  plays a clip through the bind correction, its hips scaled by hip height.
  Sampling loops or clamps, mirrors left / right, blends on the shortest arc;
  joint channels add on top as an overlay; a root-motion clip's hips travel
  comes out as root travel. A clip pose is grounded at its clearance (the
  source's height off its floor past a 2 cm contact band: Mixamo sinks
  hands and arms into the floor when on the ground), on support points per
  bone, fingers included. Nothing sampled is stored. Tests:
  `tests/unit/mocap-clips.test.ts`, `mocap-clip-take.test.ts` (synthetic
  clips on the fixture skeleton).
- Mocap clips on marks (mocap-clips; `types.ts`, `schema.ts`, `evaluate.ts`,
  `src/engine/mocap/clip-marks.ts`, `skeleton.ts`, `floor.ts`, `shot.ts`,
  `camera-clear.ts`, `weapons.ts`): optional `ActorMark.clip` `{ id, at,
  mirror? }` (malformed ones dropped on load, no migration). Between two
  marks on the same clip the clip time runs linearly; a posed leg between
  different clips crossfades; a travel leg blends a clip in or out over
  0.25 s. A root-motion clip moves the performer by its hips track; a clip
  mark's y is its floor. `EntityState.clip` carries the clip to the body
  call (`poseFrames` / `poseEffectors` / `bodyLowY` take it; other bodies
  ignore it), shot words, clear views and held weapons (a bot holds a weapon
  in the clip's own hands). Old projects evaluate as before. Tests:
  `tests/unit/mocap-clip-marks.test.ts`.
- Mocap clips on screen and gaits from clips (mocap-clips;
  `src/renderer/mocap/body.ts`, `scene.ts`, `src/engine/mocap/gait-clips.ts`,
  `builders.ts` `AnimInput`, `SceneManager.ts`): a loaded bot renders the
  engine's clip pose. Each gait plays its library loop (stand idle, walk /
  the woman's walk, jog, run, crouch still / walking, sit, lie and fall on
  the lying idle, talk); a stand under joint offsets keeps the keyframe rig
  (the pose fights, weapons and shot words use). Travelling loops run on
  distance through a time warp measured off the clip's planted contacts, so
  a flat foot stays put at any speed. A change of pose source crossfades over
  0.25 s, found by bisection on a camera-less evaluator (pure in t). Fingers
  play the clip's; otherwise relaxed, a fist for a fighter's hands, a held
  weapon's hand and the `handL` / `handR` channels. The skinned meshes'
  cached bounds are dropped on every pose (three caches them from the pose
  it first measures), so an export's depth range and top-down fit never
  depend on what was rendered before. Tests:
  `tests/unit/mocap-clip-render.test.ts`, `mocap-clips-real.test.ts` (the
  real library: feet on the floor ±2 cm every 1/12 s for every gait and
  clip on both bots, flat-foot slide < 2 cm per step; skipped without it).
- The motion library on mocap bots (mocap-clips;
  `src/engine/mocap/library-clips.ts`, `sequences.ts`, `choreography.ts`,
  `prompt-scene.ts`, `store.ts`, `Inspector.tsx`, `Library.tsx`,
  `control/handler.ts`, `mcp/tools.json`, `AGENTS.md`): a fork table maps
  motion presets onto library clips (`MOTION_PRESETS` untouched) and the
  clips with no preset become motions of their own (`mocap-<clip>`). On a
  loaded bot, `apply_motion` / the Inspector / the group panel lay a motion
  as one clip run (two marks, a root-motion clip's along its travel), and
  the Choreographer and Sequences (new Bodies select) replace a bot's
  keyframe plays with clip runs, strikes and blocks excepted (the Fight
  Director's moves are phase 3); back-to-back runs crossfade. Everything
  else keeps the keyframes. `list_motion_presets` adds `mocap` /
  `mocapOnly`; the prompt names a clip run by its motion. `handL` / `handR`
  mirror as a pair. Tests: `tests/unit/mocap-library-clips.test.ts`, the
  floor moves on the real bots in `mocap-clips-real.test.ts`, the
  mocap-bots e2e spec.
- A crouch at rest on the bots (mocap-clips; `src/engine/mocap/clip.ts`,
  `gait-clips.ts`): the library's crouch idle holds a hand up for its whole
  loop, so the crouch still plays `crouchStill`, built as soon as both
  clips register: the crouch idle with each arm bone and finger at the
  crouched walk's mean rotation under its parent. Tests:
  `tests/unit/mocap-clips.test.ts`, `mocap-clips-real.test.ts` (both hands
  below the chest every 1/12 s on both bots).
- Bots sit on seat props (mocap-clips; `src/engine/mocap/library-clips.ts`,
  `gait-clips.ts`, `sequences.ts`, `store.ts`, `Inspector.tsx`,
  `src/renderer/mocap/body.ts`, `scene.ts`, `builders.ts` `AnimInput`,
  `SceneManager.ts`): a catalog seat (chair, stool, armchair, couch, office
  chair, wheelchair, toilet, bench, lounger) whose footprint takes a bot's
  hips makes its sit a chair sit; anywhere else it sits on the floor. The
  sit-down motion checks at apply time (`apply_motion`, the Inspector): over
  a seat it stands, sits back onto it (laid so the hips land on the seat)
  and the chair idle fills the rest; routines and sequences have no seats
  and sit on the floor. The sit gait checks each frame against where the
  seats are at that time. Tests: `tests/unit/mocap-seats.test.ts`, the
  real-library sits in `mocap-clips-real.test.ts`, the mocap-bots e2e spec.
- Travelling clip runs on the warp (mocap-clips; `clip-marks.ts`,
  `evaluate.ts`, `gait-clips.ts`, `library-clips.ts`, `clip.ts`): an
  in-place travelling loop laid as a run (crawl, sneak, drunk walk, sprint)
  plays its clip time on the distance covered through the gaits' warp, and
  its marks lie the warp's distance apart, so its planted contacts stay put.
  A take flagged in place whose hips walk forward anyway (the library's
  sprint) has that straight-line travel taken out at registration. Tests:
  `tests/unit/mocap-library-clips.test.ts`, `mocap-clips.test.ts`, the
  real-library run slide check in `mocap-clips-real.test.ts`.
- Mirrored clip runs travel mirrored (mocap-clips; `sequences.ts`
  `choreographMotion`, `store.ts`): when `apply_motion` mirrors a weapon
  motion onto the other hand, a bot's clip run is laid mirrored, its root
  travel too. Tests: `tests/unit/mocap-library-clips.test.ts`.
- A bot's contact points on its own bones (mocap-fights;
  `src/engine/mocap/rig.ts`, `fk.ts`, `weapons.ts`,
  `src/renderer/mocap/body.ts`, `viewport/hold.ts`): a clip bends the wrist
  and ankle, which left the forearm-rigid palm and shin-rigid toe 1–12 cm off
  the rendered ones on the real kicks. Bot poses get wrist and ankle frames:
  the palm and the toe (the ToeBase joint) ride them, a held weapon sits in
  the palm turned as the hand (the bot's `gripL` / `gripR` markers in the
  renderer), and the hand and foot capsules ride them. On keyframe poses
  those bones are rigid with the forearm and shin, so nothing moves there.
  `mocap-clips-real.test.ts` now checks the floor moves' hands and feet by
  their surfaces (a hand on its edge holds the palm 7 cm up, a flat foot
  the ToeBase joint 3 cm). Tests: `tests/unit/mocap-fights.test.ts`,
  `mocap-fights-render.test.ts`.
- Fight moves on bots (mocap-fights; `src/engine/fight/clip-moves.ts`): a
  fork table maps each Fight Director move to one library clip per impact
  (a combo chains clips), by target and by the weapon in hand; a move with
  no clip keeps its keyframes. Each impact is the striking effector's (or
  the held weapon's strike point's) peak extension toward the front in the
  clip's FK; reactions are picked by target and striking side, defenses by
  height and what's in hand, each with the frame that meets the blow, and a
  fall's landing frame. Tests: `tests/unit/mocap-fights.test.ts`.
- The Fight Director on mocap bots (mocap-fights; `src/engine/fight/solve.ts`,
  `ground.ts`, `contact.ts`, `src/engine/mocap/surface.ts`, `clip.ts`
  `botPose`, `src/renderer/store.ts` `writeFightTracks`): a loaded bot fights
  on clips. A strike is a clip run per impact (combos chained, crossfaded),
  each impact frame on the beat's frame; the reach solve runs on the clip
  pose and sits on the impact mark as an overlay ramped in over 0.2 s and
  out over 0.25 s. Blocks and dodges play their clips with the guard frame
  on the impact; landed blows the hit clips by target and the side they land
  on; staggers, knockdowns and KOs the hit and fall clips on the physics'
  knockback root, timing and prop stops; a knocked-down bot gets up with
  the get-up clip; between beats a bot holds the fight idle on shot time. A
  bot strikes skin to skin (`mocap/surface.ts`): the renderer now registers
  each bot vertex's four skin influences, normal and triangles (`extract.ts`,
  never stored), so the engine skins the striking part (a fighter's hand as the
  fist the renderer shows) and the target's skin near the blow exactly as
  three does, and the aim point moves along the strike until the striking
  skin just touches the target's (the closest point on its triangles,
  signed by the face; the support hull without them). A hand or forearm the blow would
  meet on the way swings just clear and back; a striking knee tucks its
  heel (extra knee bend) just enough that its shin and foot stay out of the
  defender's legs. Bot fight marks carry `clip` and `posedMove` (the
  evaluator keeps a clip's root travel and floor line) and the report each
  impact's effector; a bot's contact error is its skin gap. The target skin
  is measured on a cached mesh (each point's nearest vertices on a grid,
  then their triangles; a coarse pass, then the skin around its closest
  points), a bot's pitch solve refines its root by regula falsi, and
  `poseLowY` (mocap/clip.ts) skips the bones that can't reach below the
  lowest point found (the same minimum). Every other body solves exactly as
  before (pinned by hash). Tests:
  `tests/unit/mocap-fights-solve.test.ts`, `mocap-fights-render.test.ts`
  (engine skin = three's to 0.1 mm), `mocap-fights-legacy.test.ts`.
- Bot fights with weapons and moves without clips (mocap-fights): a blade
  or blunt weapon plays the great sword / sword and shield / heavy swing
  clips, a knife the stab, a gun its aim, and a move with no clip its
  keyframes crossfaded from the idle; the weapon rides the hand bone.
  Tests: `tests/unit/mocap-fights-weapons.test.ts`.
- A bot fight's solve takes seconds (mocap-fights; `src/renderer/store.ts`,
  `control/handler.ts`, `panels/FightDirector.tsx`): `solveInScene` keeps
  the last solutions by everything a solve reads (fight, fighters, shot
  timing, props, loaded bots and clips) and hands out copies, so
  `get_fight` and the Fight Director's live report don't solve again; a
  stage or re-solve with a bot toasts "Staging fight…" / "Re-solving
  fight…" and waits a frame for it to paint first. The fight-ground
  mannequin sweep and the floor-proxy keyframe test get 15 s timeouts (they
  ran past 5 s under a loaded gate). Tests:
  `tests/unit/mocap-fights-store.test.ts`, `tests/e2e/mocap-bots.spec.ts`.
- Routines and sequences on bots play the Fight Director's strike and
  defense clips (mocap-fights; `src/engine/mocap/library-clips.ts`
  `clipPlays`): a strike one clip run per impact, each impact frame on the
  keyframe move's impact time, a block, parry, dodge or duck its guard
  frame on the keyframe defense's ready time, so a routine's exchanges keep
  their timing; a knockdown or KO the fall clip for the way the keyframe
  fall goes (knocked down, KO back, KO onto the front), its floor-contact
  frame on the keyframe fall's landing; a get-up the one for that fall,
  standing at the keyframe get-up's end; the guard bounce the fight idle on
  shot time; any other fight move with a clip, its clip. Only moves with no
  clip keep their keyframes. A routine's push-back mark at a reaction's end
  moves the clip run's end there, and a fallen bot held by a plain mark
  stays on the fall's last frame. A two-performer fight sequence casts the
  chosen bodies (it ignored them).
  A Choreographer fight that stages a loaded bot through the Fight Director
  (the placement click, Apply to selected, MCP `spawn_choreography` /
  `choreograph_entities`) toasts and waits a frame first (`store.ts`
  `slowRoutine`; `spawnChoreography`'s `now` for a caller that already
  did); procedural routines stay synchronous. Tests:
  `tests/unit/mocap-fights-routines.test.ts`, `mocap-fights-store.test.ts`.
- Bot fighters stay out of each other (mocap-fights; `src/engine/fight/solve.ts`,
  `src/engine/mocap/surface.ts`): on the real library the bodies sank up to
  7–8 cm into each other around the blows. A blow's guard check runs on
  every frame of its last 0.25 s (clip and keyframe strikes) against the
  defender's whole arm, the arm opens from 0.25 s before (also on a
  defense still playing from the blow before), and a leg the striking limb
  comes through swings out (hip abduction ≤ 10°, not on a blow to the
  legs); the attacker's other leg splays out of the defender's legs (≤ 10°,
  on each strike key; at the impact the strike is placed with it). After
  every blow the defender is pushed back by the least that clears the
  frames that overlap (≤ 15 cm, the attacker's own travel held back too
  when the defender alone can't get clear); between two blows the push eases
  out 0.1 s before the next, which lands where it was placed. A blow whose
  approach still sinks one body into the other comes in swung about the
  target (15° / 30° either way, finer when needed), kept only if it lands
  as well as straight on; the report names each beat that needed it. A
  blocked or parried blow stops where its arm first meets the guard (not
  only its fist), and the angle search counts the blocking arm's reach; a
  bare guard a blocked blow still sinks past (a spinning backfist sweeping
  across it into the head beside the guard) first reaches across toward it
  (shoulder adduction 0.45 rad), kept only if that helps, and the report
  says so. The finer angles are tried only beside the best coarse one, and
  only while the coarse ones leave it over the bar (a coarse try that
  couldn't land skipped that check). The
  depth of two bodies in each other is measured as rendered (fists), bone
  box by bone box. Floor contact: a bot done well before the other (the
  attacker while the defender gets up) holds its idle where it stands and
  the other comes to guard distance of it (it used to drift and sink up to
  10 cm over the wait); a keyframe move crossfades from the idle into its
  first pose before its step-in; an idle reached by a walk is posed half a
  frame on so the move after it crossfades on the floor line. Speed: the
  pitch and lean solves start from the last pass's answer (a block's aim
  and guard arm, a lean's upright pitch too), a bot's contact points are
  cached by pose, the push-back search drops a push at its first frame
  still too deep (the deepest first) and the guard check at its first
  failing frame, the skin's sign test visits only each shell of its grid
  and a bone set's triangles are cached. A bot fight's "Staging fight…" notice waits two frames before the
  solve (the first can come before the toast is drawn), and its 50 ms
  fallback is only for a window that draws no frames: under a full CPU a
  frame took longer and the solve ran before the toast painted. Tests: `tests/unit/mocap-fights-real.test.ts` (the real library:
  contact, bodies at the impacts, feet, determinism; skipped without it),
  `mocap-fights-store.test.ts` (a library loaded after a solve solves
  again), `tests/e2e/mocap-bots.spec.ts` (a bot fight exports byte-identically twice).
- Flush-proof export renders (fix-topdown; `src/renderer/viewport/stable-render.ts`,
  `SceneManager.renderFrameAt` / `renderTopDown`): with antialiasing, a draw
  that blends over an earlier draw's antialiased edge came out one level
  different when GL was flushed between the two draws (ANGLE / D3D11), and
  Chrome flushes mid-frame at points that depend on timing. Two `export_shot`
  top-downs of one scene could differ in the pixel where the shadow catcher
  lies over a grid line. Every export render now flushes after each draw
  (`renderStable` wraps `renderBufferDirect` for that render), so the
  browser's own flushes change nothing. Pixels move by at most one level,
  only where a later draw blends over an antialiased edge. Evidence:
  `docs/plans/2026-10-21-fix-topdown.md`. Tests:
  `tests/e2e/export-flush.spec.ts`.
- Bot blocks read as blocks (fight-polish; `src/engine/fight/clip-moves.ts`
  `defenseClip`, `src/engine/fight/solve.ts`; plan
  `docs/plans/2026-10-21-fight-polish.md`): the library's head block meets
  the blow ducked half a metre aside with both hands above and behind the
  head, so a blocked fist landed beside the face. Bare hands now take a head
  blow on the shell, `blockBody`'s guard frame (both forearms up in front of
  the face), its outer hand on the side the blow comes in (mirrored), and
  the blow meets the forearms where the clip holds them (no reach that pulled
  the guard hand back to the face); a blocked blow's contact is read on
  whichever forearm it meets. A blade, club or shaft in hand keeps
  `blockHead`. Tests: `tests/unit/mocap-fights-real.test.ts` (a bare-hand
  block's striking limb ≥ 5 cm off the head and torso; it failed at 1.3–3.6
  cm before), the shell picks in `mocap-fights.test.ts`,
  `mocap-fights-solve.test.ts`, `mocap-fights-routines.test.ts`.
- Bot weapons kept out of bodies (fight-polish; `src/engine/weapon-shape.ts`
  new, `src/engine/fight/solve.ts`; plan `docs/plans/2026-10-21-fight-polish.md`):
  the bot fight checks (guard opening, orbit, post-blow push) compared skins
  only, so a parried sword lay across a face and a falling defender's spear
  went through its attacker. Each held weapon is now a few capsules
  (`weapon-shape.ts`, pinned to the built models) and the checks count them:
  each fighter's weapons in the other's skin, a weapon strike opening the
  guard arm or leg it passes through, a defender's own weapon swinging out
  with its arm (no deeper into its holder). A bot with a blade, club, shaft
  or shield blocks and parries on its idle, the guard arm raised by a small
  solve (`armedGuard`): the weapon meets the blow 30 cm in front of the
  struck zone at its height, a blade across the line of attack, a shield
  facing it, kept out of its own body (no deeper than its idle holds it) at
  the guard and on the way in; its free arm swings out of the attacking
  weapon's way. After a blow, a weapon riding a fall or follow-through into
  the other body swings its arm clear (`swingWeapons`); armed bots rest far
  enough apart that a weapon held out, or swept up into the idle as they
  arrive, stays out of the other (`restGap`, `restDepth`). A bot's fist move
  comes off its shield arm when the other hand can take it. To keep the solve
  fast, a blow's placement reuses an armed guard solved for a guard point
  within 5 mm, and a weapon whose axis points stay clear of a body's bone boxes
  skips the skin test (a skin is built only from the bones it comes near).
  Procedural people
  and mannequins are untouched (`mocap-fights-legacy` hash-identical). Tests:
  `tests/unit/weapon-shape.test.ts` (new), `tests/unit/mocap-fights-real.test.ts`
  (weapon blocks ≥ 5 cm clear of the defender, no weapon over 3 cm in the
  other body within 0.1 s of an impact, an armed fight solves the same twice).
- Bot routines keep their distance (fight-polish; `src/engine/mocap/library-clips.ts`,
  `src/engine/choreography.ts`): a one-vs-many routine stands each attacker
  at fighting range (1.2 m) for its strike, but a bot's strike clip carries
  it on toward the hero, and a keyframe-only lunge (the tackle, no clip)
  ran straight through it; sparring and brawl sank 4–8 cm into the hero for
  up to a second. A strike's first clip run now starts back by the clip's own
  travel to its impact (the plain step-in before it with it), and a routine
  strike's play carries its target distance (`reach`, a tag the procedural
  marks don't use), which holds a bot's keyframe lunge 0.75 m short of it.
  Procedural people play exactly as before. Test:
  `tests/unit/mocap-fights-routines.test.ts` (a travelling strike lands from
  where the keyframe move strikes, its step-in moved back with it).
- `spawn_sequence` casts bodies (mocap-backlog; `src/renderer/control/handler.ts`,
  `src/renderer/store.ts`, `mcp/tools.json`, `AGENTS.md`, `mcp/README.md`): the
  tool takes the Sequences panel's `bodies`, `[men's, women's]` person asset
  ids (checked like `stage_fight`'s `assets`; a bot only with the library), so
  an agent can cast the mocap bots in a crowd; a car chase ignores it and says
  so in a `note`. A bot fight of two says it is staging, then solves before
  the tool answers (`spawnSequence` takes `now`, as `spawnChoreography` does).
  Test: `tests/e2e/mocap-bots.spec.ts` (a crowd and a fight of two cast as
  Y Bot and X Bot through the tool).
- Routine falls hold on keyframe bodies (mocap-backlog; `src/engine/choreography.ts`,
  `src/engine/mocap/library-clips.ts` `playOf`): a routine lays a plain stand
  mark at a fall's end (the push-back) and copies it to the end of a finish,
  so a knocked-down procedural person or mannequin lerped back toward
  standing. Those marks now carry the fall's last pose as a posed move until
  the performer's next move (the get-up, the next exchange), or to the end:
  the rule a bot already follows on its fall clip. Bots' marks are unchanged
  (the pass skips bodies that play clips). Test:
  `tests/unit/routine-falls.test.ts` (new).
- Mocap chair sits fit the seat (mocap-backlog; `src/engine/mocap/seat.ts` (new),
  `clip.ts`, `clip-marks.ts`, `library-clips.ts`, `src/engine/types.ts`): the
  chair idle and the stand-to-sit rest the hips at the height the take was
  captured on (0.40–0.42 m), so a bot on a stool (0.65 m), a couch cushion or
  an office chair sat 6–34 cm inside the seat. A sit-down over a seat prop
  records the seat's top (`SEAT_TOP`, from the builders, × scale) on its clip
  marks (`MarkClip.seat`, optional, sanitized on load; `ClipState.seat`), and
  `mocapClipPose` lifts the hips until their lowest point rests on it, each
  leg turned (thigh and shin, the knee in its own plane) so the feet keep
  their spot on the floor; nothing changes while the hips are above the seat,
  so the stand-to-sit comes down onto it. A seat lower than the clip's isn't
  sat down onto. The plain `sit` gait over a seat (posed in the renderer) is
  not fitted yet. Tests: `tests/unit/mocap-seats.test.ts` (its synthetic sits
  now stand on the floor), `tests/unit/mocap-clips-real.test.ts` (both bots on
  a chair, stool, couch and office chair: hips on the top within 1 cm, feet
  ±2 cm, every 1/12 s).
- A retargeted bot's planted knee stays put (mocap-backlog; `src/engine/mocap/contact-lock.ts`
  (new), `clip.ts`): the X Bot plays the library's Y Bot takes on other
  proportions, so on the crawl its left knee slid 2.1 cm a step against the
  contact the warp follows. On a travelling in-place loop, a bot that isn't
  the clip's source turns each thigh so a knee on the floor keeps its joint
  where it planted (the shin rides along), easing the correction out over the
  swing; measured once per bot and clip, pure in t. The clip's own bot plays
  it as captured (Y Bot's crawl unchanged). X Bot crawl knees 2.1 / 0.8 cm →
  0.7 / 0.1 cm. Tests: `tests/unit/mocap-contact-lock.test.ts` (new),
  `tests/unit/mocap-clips-real.test.ts` (a knee counts its whole drift, not
  only along the travel).
- Bots hold weapons clear of their own bodies (held-weapons; `src/engine/weapon-hold.ts`
  (new), `src/engine/weapons.ts`, `src/engine/weapon-shape.ts`, `src/engine/evaluate.ts`,
  `src/engine/fight/solve.ts`, `src/renderer/mocap/body.ts`, `src/renderer/mocap/scene.ts`,
  `src/renderer/viewport/hold.ts`, `src/renderer/viewport/SceneManager.ts`): the library's
  Mixamo clips were recorded empty-handed, so a weapon held rigidly in a bot's fist went
  through its holder (a shield through the head in the fight idle, a rifle's stock in the
  chest on the aim, a bat in the legs in a fall). A bot's weapon now turns in the grip
  about the palm by the least that keeps it out of the holder's hulls (each bone's skin as
  a convex hull of its support points, the other hand's fingers too, and for a shield a hand
  and forearm 3.5 cm wider where the skin bends round a grip; the holding forearm and hand
  left out); on
  a clip the turn is a curve over its frames, followed frame to frame so it never flips
  round the body, and a joint overlay or crossfade nudges it on the pose only past 1.5 cm
  (never deeper than the curve's turn); a shield faces out from the spine. Where the fist
  itself is in the body (a hand on the knee on a get-up, a bow bringing the fist to the
  thigh, a hand at the chin) the holding arm moves one way per run of frames (forward and a
  little out, back and in, straight out to the side, or the elbow opened, never past
  straight and never for a shield) by the least move past which the weapon stays out,
  eased over 5 frames on a clip and scaled back on a frame the easing would put in the
  body; `applyHolds` adds it, so the engine and the renderer agree. On a keyframe motion
  the evaluator eases the arm in before the fist reaches the body and out after (it looks
  at the holder's own marks 0.25 s either side; state(t) stays pure). On a crouch, crouched
  walk, sit or lie loop the loop's own arms hold the weapon as on a clip; walking, jogging
  or running a long weapon rides on the shoulder (`TRAVEL_CARRY`, by speed), and the
  renderer's walk steadies both arms of a two-handed weapon. Procedural people and studio
  mannequins hold weapons exactly as before (`mocap-fights-legacy` hash-identical). Probes
  (`.maestro/held-weapons/`), runs of frames deeper than 3 cm: every clip × 12 weapons × both
  bots × mirror 9786 at b322531 → 125 (full sweep, before the last fixes) → 12 on the 33
  clips that held those, re-swept with the final rule (1–3 frames each, worst 6.05 cm: a
  shield on fast dance spins, a pistol or sword at the other forearm; in BACKLOG.md);
  keyframe motions 1335 → 0; gaits as rendered 328 → 0; weapon
  fights keep every fight-polish bar. Tests: `tests/unit/weapon-hold.test.ts` (new, fixture
  skeleton and synthetic clips), `tests/unit/mocap-fights-real.test.ts` (the clips that put
  a weapon in its holder, and walking, jogging, running, crouching, sitting and lying as
  rendered).
- `spawn_choreography` casts bodies (mocap-followup; `src/renderer/control/handler.ts`,
  `mcp/tools.json`, `AGENTS.md`, `mcp/README.md`): the tool takes the Choreographer's
  `bodies`, `[men's, women's]` person asset ids, checked as `spawn_sequence`'s are (one
  `castBodies` for both; a bot only with the library), so an agent can cast the mocap
  bots in a dance, fight or chase routine; a routine fight of two hands them to the
  Fight Director as its fighters (`RoutineSpec.bodies`, as the panel does). Test:
  `tests/e2e/mocap-bots.spec.ts` (a hip-hop routine and a routine fight of two cast as
  Y Bot and X Bot through the tool; a non-person body refused).
- The newest hold rules under test (mocap-followup; `tests/unit/weapon-hold-rules.test.ts`
  (new), no engine change): on the fixture bot and synthetic clips, the lift cut (a
  forward-lift run snapping to a hand behind the back: the eased lift is scaled back,
  every frame clear), the on-pose refine keeping its clearest turn (overlays no turn
  clears: never deeper than the clip's curve), the elbow way (a fist under the chin opens
  the elbow; a fist a forward lift frees keeps it; a shield never opens it) and the
  shield-only hand pad (a shield ≥ 2 cm off the other hand; a pistol beside the other hand
  not turned). Each test fails with its rule disabled (mutated copies of `weapon-hold.ts`,
  `.maestro/mocap-followup/mutate.sh`).
- The Choreographer's foot chase runs on tracks (qa-fixes, mocap-qa bugs 1, 2 and 5;
  `src/engine/chase-tracks.ts` (new), `src/engine/choreography.ts`, `src/engine/evaluate.ts`):
  upstream laid each scripted beat (vault, skid-stop, stumble, the ending's fall and tackle)
  at one fixed spot while the travel samples inside its window stayed on the path, so a
  performer ran ahead and snapped back (3.4–5.3 m in one frame); the pursuers' start
  clamped to the path's start, so the whole cast began on one spot; the pursuer's skid was
  laid 1.5 m past its own spot, on the runner. `chaseRoutine` now calls `chaseOnTracks`
  (`alongPath` and `overlayAt` go): every performer has an arc distance along the same
  seeded serpentine as a pure function of time and every mark comes off it. The path runs
  on straight past its start, so the pursuers start 3.5 m and 5.1 m behind the runner. A
  beat rides the track: its keyframe pose plays over the run while the root keeps going
  (a bot keeps the pose over its run loop; the library's trip clip is a fall), marked
  `ride` so the floor rule leaves its height (the run grounds it; on a bot the rule had
  sunk the run loop's toes 12–31 cm). The runner's skid brakes to a quarter of its speed
  and back; the pursuers, laid against the runner's track, brake with it; each stays
  0.9 m along the path behind the one ahead. Caught: from 1.6 s before the end the
  runner falls forward with its momentum (`trip-and-fall-flat`; a bot plays its clip)
  and the tackler closes from its gap to 0.45 m behind it on contact; escape: the
  pursuer brakes to a stop, hands on its hips. The evaluator's speed on the instant a
  leg arrives at a mark now looks back (it read 0, and a bot stood for that frame).
  QA's chase (seeds 7, 3, 21, people and bots): frames over 0.45 m 44–68 → 0, worst
  0.25 m; hips under 35 cm only after the tackle's contact; lowest rendered toe −31 cm
  → −0.1 cm. Test: `tests/unit/chase-tracks.test.ts` (new; fails on 7d9e5c1).
- Tools wait for the Mixamo clips (qa-fixes, mocap-qa bug 3; `src/engine/mocap/registry.ts`,
  `src/renderer/mocap/library.ts`, `src/renderer/control/handler.ts`, `src/renderer/store.ts`, `src/main/control.ts`,
  `mcp/tools.json`, `AGENTS.md`, `mcp/README.md`): the bots' bodies load seconds before their
  96 clips, so a bot fight staged in between solved on keyframe moves and kept them on the
  timeline (the prompt, which re-solves at export, then described another fight and lost a
  beat). The library's load is tracked in the engine registry (`trackMocapLoad`,
  `mocapLoadDone`, `waitForMocap`); `stage_fight`, `update_fight`, `spawn_sequence` /
  `spawn_choreography` with bot bodies, and `choreograph_entities` / `apply_motion` on bots
  wait for it (at most 120 s; after that the call fails and stages nothing), and so does the
  Fight Director's and the Choreographer's staging notice (`fightNotice`). `get_state`
  reports `mocap: { ready, bots, clips }`. The control server gives those six tools 180 s
  instead of 30 s. Test: `tests/e2e/mocap-race.spec.ts` (new; the clip reads held back in
  the main process).
- Bot feet step instead of gliding (qa-fixes, mocap-qa bug 4; `src/engine/mocap/footwork.ts`
  (new), `src/engine/mocap/clip-marks.ts`, `clip.ts`, `src/engine/fight/solve.ts`,
  `src/engine/evaluate.ts`, `src/engine/types.ts`): where a bot's marks carried its root
  further, or turned it more, than its clips do (a fight's step-in, walk back to guard,
  stagger, push), the clips' planted feet rode along. The evaluator now finds those windows
  on a bot's track (runs of posed clip legs travelling past the clip's own root travel;
  each crossfade between two clips on its own) and hands the pose the travel and turn,
  done and in all (`ClipState.step`, optional); the pose holds each grounded foot and steps
  it in turn, front foot first, at most 0.4 m a step, lifted while the other stands on
  the floor, by two-bone leg IK (the hips sink at most 8 cm for a step's reach). Feet off
  the floor, falls, and in-place travelling loops keep the clip's feet. The solver lays a
  bot's step-in and walk back to guard between two clips as a posed crossfade (no walk
  loop under a clip blend, which had snapped the hips 12 cm in a frame); a keyframe move
  steps in on the idle, then crossfades into its first pose. The solve's own checks read
  the bots without footwork (`ShotEvaluator`'s new `footwork` option), so its separation
  is unchanged. QA's run3 fight (rendered bones, QA's `skate-runs`): slide runs over 15 cm
  BRUNO 16 → 0, KIRA 20 → 5 (all in the keyframe spinning back kick, hips still); the
  worst toe slide while the hips travel 111 → 13 cm (the jab clip's own retreat); contact
  0.21 cm before and after. Test: `tests/unit/mocap-footwork.test.ts` (new; 7 of 8 fail
  on 7d9e5c1's sources).
- The nightclub's light cones stay out of exports (qa-fixes, mocap-qa bug 6;
  `src/renderer/viewport/builders.ts`, `src/renderer/viewport/SceneManager.ts`): the four
  translucent coloured cones turning through the room washed a frame green whenever one
  passed the lens, drew as solid cones in the depth pass, and went unnamed in the prompt, so
  a video model could read them as pyramids. They are blocking dressing now: tagged
  `userData.editorOnly`, which `renderFrameAt` hides in every pass (and puts back), so the
  viewport keeps them. Test: `tests/e2e/export-editor-only.spec.ts` (new; a camera inside a
  cone, clean and depth: 172,794 pixel values differed from the frame without the cones
  before, none after).
- The prompt's action words for stunts, falls and chases (qa-fixes, mocap-qa bug 7;
  `src/engine/prompt-scene.ts`, `src/engine/mocap/library-clips.ts`): stunts and falls read
  "does a knocked down", "does a vault obstacle"; they now say what the body does ("is knocked
  down", "vaults an obstacle", "trips and falls flat", "skids to a stop", "lunges into a
  tackle"; a table with the plural for several subjects). A bot's trip clip is named as the
  trip and fall it is. A move runs on through a change of pace (jog, run), a pause of up to
  0.75 s and the motions played on the way, as long as it keeps its direction, named by the
  gait that covers most of it; a motion's own posed travel is the motion's phrase, not a
  move. Pursuers in a line all chase the runner in front ("COP 1 and COP 2 chase RUNNER";
  the second used to chase the first), each named once, and the same subject doing the same
  again says it once. QA's chase (seed 7, caught, bots) went from 16 sentences with "RUNNER
  does a knocked down" and runs back and forth to 8, every cast member in the action. Test:
  `tests/unit/prompt-words.test.ts` (new; all 5 fail on 7d9e5c1's sources).
- A fight that runs past its shot says so (qa-fixes, mocap-qa bug 8; `src/renderer/store.ts`):
  `stage_fight` and `update_fight` share the fit rule (the shot grows only when a beat would
  drop, so a last reaction may run past the end, as H3's 15 s cap needs); nothing said so:
  QA's `update_fight` moved the fight's end to 20.85 s in an 18.5 s shot without a word. Both now
  warn "The fight ends at 20.9 s, after the shot's 18.5 s: set the shot to 21.5 s to see it
  all". Test: `tests/unit/fight-resolve.test.ts` (extended).
- Exports take the viewport's look (export-look T1; `src/renderer/viewport/look.ts` new,
  `src/renderer/viewport/SceneManager.ts`, `src/renderer/export/exporter.ts`,
  `src/renderer/viewport/environment.ts`): the viewport tone-maps with ACES at exposure 1.45
  and the export renderer applied none, so a clip came out flatter and darker than the editor
  (a night scene lighter); only the physical sky was compensated, by a hand-written ACES in
  its shader. Both renderers now take the look from `look.ts`, three applies it once per
  material, the sky only scales its radiance (`exposeSky`, was `toneMapSky`), and
  `renderFrameAt` renders the depth and normal passes with no tone mapping. Export frame
  against the viewport's own frame of the same camera, time and size (Deliver mode, mean
  luminance 0–255), before → after: day street 120.3 / 127.9 → 127.9 / 127.9, gym fight
  57.6 / 62.5 → equal, nightclub 21.9 / 18.2 → equal, midday sky 165.9 / 174.9 → equal, night
  street 28.3 / 23.6 → equal; worst 7×7 probe 39.2 → 0.1 levels; depth frames byte-identical
  before and after (`.maestro/export-look/`). Test: `tests/e2e/export-look.spec.ts` (new; 3 of
  3 fail on edf6dc0), `tests/unit/environment.test.ts` (extended).
- The night cast reads (export-look T2; `src/renderer/viewport/cast-fill.ts` new,
  `src/renderer/viewport/SceneManager.ts`): the night preset (moon 0.7, sky 0.4) left the bodies
  darker than the street behind them. A cool, shadowless directional fill now shines from the
  shot camera, 3° below its view axis, on the night preset only (hidden for the rest, so their
  shaders are unchanged); it follows the shot camera's pose at t, so it is deterministic and the
  viewport and exports agree. A raised ambient was the other option and lifts the street and
  walls as much as the cast. Intensity 0.9 and the angle come from a sweep
  (`.maestro/export-look/tune-a`, `tune-b`). Night street with a classic man, a mannequin woman
  and both mocap bots, cast silhouette from the normal pass, clean-frame mean luminance (0–255),
  after T1 → after T2: cast 19.6 → 74.9, the rest of the frame 24.1 → 26.9 (+11 %), cast / rest
  0.81 → 2.78; darkest body (the classic man) 12.7 → 52.5. Test: `tests/unit/cast-fill.test.ts`
  (new), `tests/e2e/export-look.spec.ts` (extended; the night test fails without the fill).
- Export profiles for LTX 2.3 Render to Real, Kling V3 Omni and Seedance 2.5 (export-look T3;
  `src/engine/profiles.ts`, `src/engine/profile-limits.ts`, `src/renderer/control/handler.ts`,
  `src/renderer/export/exporter.ts`, `mcp/tools.json`, `docs/generator-profiles.md`,
  `mcp/README.md`, `AGENTS.md`): `ltx-2.3-render-to-real` (720p up to ~6 s, 480p up to ~15 s,
  ≤ 361 frames; exports at 720p), `kling-v3-omni` (3–10 s base video, prompt ≤ 2500 characters,
  a clause that asks for the base video's camera outright, since Kling follows it loosely) and
  `seedance-2.5` (4–15 s, a guiding reference video at 720p, the generic motion-reference
  prompt), with CLAUDE.md's limits and the model pages where it is silent. New optional fields
  `minDuration`, `maxFrames` and `resolutionCaps` add warnings in Deliver and `export_shot` (too
  short; too many frames for the shot's fps; a 6–15 s LTX shot is told to pick 480p) and come
  back from `list_export_profiles`; previs profiles (hosted models) no longer get a ComfyUI
  workflow. No generation was started. Test: `tests/unit/profiles-models.test.ts` (new; 9 of 10
  fail on e39ae56), `tests/e2e/export-look.spec.ts` (extended).
- `export-flush.spec.ts` compares a frame only while the GPU holds still (export-look T4;
  `tests/e2e/export-flush.spec.ts`, fork test): on ANGLE / D3D11 (RTX 3070 Ti) a render's floats
  move by one ulp while the page composites and as the GPU warms up after an idle gap, so the
  plain-vs-flushed comparison of one frame flipped a value now and then (the edf6dc0 build too,
  more often with the ACES look). Each comparison now renders a plain frame on both sides of the
  flushed one with the viewport stopped; when the two plain frames differ the GPU moved and the
  comparison is retaken, and when they match the flushed frame must match exactly. Real spec
  runs: 4 of 6 failed at HEAD, 5 of 6 with a 2.5 s settle instead, 0 of 8 bracketed. A quiet
  export (settle, no progress repaint) made double exports differ more and was dropped; the
  finding is a `BACKLOG.md` Issue.
- Choreographer routines stay on the set (set-routines T1; `src/engine/routine-set.ts` and
  `src/renderer/routine-set.ts` new, `src/engine/chase-tracks.ts`, `src/engine/choreography.ts`,
  `src/renderer/store.ts`, `src/renderer/control/handler.ts`, `mcp/tools.json`): the chase ran its serpentine along
  the routine's heading whatever stood there and the dances stood where they were clicked, so
  QA's chase (mocap-qa run2) left Downtown's 36 m tile after 2 s, and in the Alley and the
  Nightclub it started in the walls and off the tile; six dancers changing formation in the
  Alley walked into its walls. The set now comes in as data read off the built kits: floors
  (pieces under 0.35 m: ground, street, kerbs), streets (flat strips ≥ 12 m × 3 m, 2.5 : 1) and
  solids (pieces between 0.35 m and 1.9 m, shop glass included; editor-only and animated dressing
  left out); static props are solids. A chase runs along the street nearest the click (the
  longest clear lane of it), else along the longest clear line through the most open spot near
  the click, its root 0.6 m from every solid and the floor's edge; the runner starts at the
  click while the room ahead holds the run, else the route slides back along the street; a
  straight run too short for a running pace (3 m/s while running) turns into a lap (corners ≤
  100°, 3 m from its own earlier stretches); the weave stays on the street and clear; the fall
  (a bot's clip travel included) lands clear. A set that holds less than the Duration at a run
  gets the longest shorter chase that runs, then everyone holds or slows to a stop, and a
  warning says so. Dances and fights shift (≤ 8 m), then turn (15° steps), to the nearest spot
  where every formation spot and walk is clear, else they stay and warn. What moved (notes) and
  what doesn't fit (warnings) go to the toast and to `spawn_choreography` /
  `choreograph_entities` (`notes`, `warnings`). A scene with no floor and no solid stages
  exactly as before. QA's chase (seeds 7, 3, 21) and two dances (QA's 4-dancer line, 6 dancers
  changing formation) on Downtown, Alley and Nightclub, people and bots, frames (of 193) with a
  hip in a solid / off the tile, edf6dc0 → now: Downtown chases 0–2 / 144–148 → 0 / 0; Alley
  chases 0–3 / all → 0 / 0 (cut to 4.25–6 s at a run); Nightclub chases 3–4 / all → 0 / 0
  (a lap); the Alley's 6 dancers 10–11 / 0–116 → 0 / 0 (turned 90°); every other dance 0 / 0
  before and after. Root steps ≤ 0.25 m a frame (qa-fixes' bar 0.45 m).
  Tests: `tests/unit/routine-set.test.ts` (new, synthetic sets: 12 of 13 fail on edf6dc0's
  routines), `tests/unit/routine-set-store.test.ts` (new, the real kits through the store).
- A chase's follow cameras keep the other cast out of the lens, and a tracking camera keeps a
  fallen person in frame (set-routines T2; `src/engine/track-aim.ts` new,
  `src/engine/camera-clear.ts`, `src/engine/evaluate.ts`): people-follow moves let other cast
  come 0.5 m from the lens, so on QA's chase a follow-behind camera sat among the pursuers, their
  heads filling up to the whole frame over the runner; and the aim lock looked 0.8 of a subject's
  height over its root, so the caught runner fell out of the bottom of the lead-the-subject frame.
  A follow move now keeps other cast 2.5 m from the lens and anyone between the lens and the
  subject under 10 % of the frame (cast beside or beyond the subject is the scene); its path is
  checked every frame; a move blocked most of the time takes one steady offset for every mark
  when one stays clear (QA's follow-behind becomes a side track, swung 90°) instead of dodging
  mark by mark. The aim lock eases onto the middle of a person's posed body once its head drops
  below the standing aim point; standing people and everything else are aimed as before. QA's
  chase (Downtown, seed 7, bots), frames of 192, edf6dc0 → now: follow-behind, cast < 2.5 m from
  the lens 179 → 0, cast in front of the runner over 10 % of the frame 174 → 0 (largest 97.6 % →
  0), over the runner's head or chest 133 → 0, camera ≤ 0.18 m and 1.9° a frame;
  lead-the-subject, runner's hips and head in frame 0.94 → 1.00, in the last 0.5 s 0/12 → 12/12.
  Test: `tests/unit/follow-cast.test.ts` (new; 3 of 3 fail on edf6dc0).
- The chase's bots stop sliding where the motion changes at a run (set-routines T3;
  `src/engine/mocap/loop-phase.ts` new, `src/engine/mocap/gait-clips.ts`,
  `src/renderer/mocap/scene.ts`, `src/engine/evaluate.ts`, `src/engine/types.ts`,
  `src/engine/chase-tracks.ts`, `src/engine/choreography.ts`, `src/engine/mocap/library-clips.ts`,
  `src/engine/mocap/clip-marks.ts`, `src/engine/prompt-scene.ts`): on QA's chase a bot's foot slid
  up to 1.1 m. A leg into a posed move walked (upstream walks into any mark that doesn't travel),
  so the runner walked into its fall and the tackler into its tackle at 4.6–5 m/s; the travel
  marks took their gait from the speed at the mark, so a pursuer braking behind the tackle walked
  at 3.8 m/s; a gait crossfade froze the loop fading out, its planted foot riding the body, and
  the two loops had no foot phase in common; the trip clip walks for 0.9 s before it trips, so the
  runner braked to 1.5 m/s with the clip's first pose dragged along the street; the keyframe
  tackle's push-off swept a foot along the floor. Now a leg into a posed move keeps the travelling
  gait it departs with unless its pace is too slow for it; each travel mark of the chase takes the
  gait of the leg arriving at it, a bot runner runs from the start (the library's jog is a 1.5 m/s
  jog) and the chase is under way on its first frame; a pursuer following another brakes at most
  6 m/s². Every gait loop of a bot plays at the bot's one foot phase (`EntityState.loopPhase`,
  from each loop's left-foot touchdown, `ClipWarp.origin`, per foot cycle, `ClipWarp.cycles`), and
  the loop fading out of a crossfade goes on at it, so both loops have the same foot down. The
  caught runner's fall on a bot plays the trip clip from its dive (`RUN_FROM`: 1.06 s, both feet
  off the floor at 3.7–4 m/s), and a bot tackler dives on the same clip with the runner from where
  it runs; its marks name the tackle (`MarkClip.as`), so the prompt still says "lunges into a
  tackle". Keyframe bodies keep the lunge. QA's Downtown chase on bots, seeds 7 / 3 / 21, foot
  slides over 15 cm, edf6dc0 → now: runs 13 / 13 / 16 → 3 / 6 / 2, worst 104 / 89 / 111 cm →
  32 / 24 / 29 cm; at the run into the trip 104 / 76 / 27 cm and in the tackle 71 cm → none; the
  pursuer braking behind 79 / 89 / 111 → 32 / 19 / 29 cm. The escape ending: runs 28 → 14, worst
  88 → 38 cm. T1's and T2's numbers hold on the same probes. Tests:
  `tests/unit/chase-blends.test.ts` and `tests/unit/loop-phase.test.ts` (new; 8 of 9 and 3 of 3
  fail on edf6dc0), `tests/unit/motion-floor.test.ts` (extended: a leg into a motion may run where
  upstream walks).
- A bot fight's push after a blow eases in (bot-slides T1; `src/engine/fight/solve.ts`): after a
  blow the solver keeps the two bots' skins apart (`separate`), and its push ramped from nothing at
  the impact to all of it on the first frame that overlapped, which is the frame after the impact
  when the blow follows through (a blocked jab, a front kick's foot): 8–9 cm of push in one frame,
  so the hips snapped and both feet slid. Now the push eases in at most 1 m/s (`SEP_RATE`, 4.2 cm
  a frame); a frame on its way in may sit 1.5 cm in the other body after a block (`SEP_NEAR`),
  no more than 1 cm after a landed hit, and the attacker gives way too where the defender alone
  can't keep that. Where easing can't keep every frame within its bar (a power-1 kick combo), the
  push lands at once as before. QA's run3 fight (`.maestro/bot-slides/fight-run3-*.txt`), d916477
  → now, hips step / snap (the step less the mean of its neighbours'): KIRA 0.83 s 9.1 / 8.7 →
  4.9 / 2.4 cm, BRUNO 4.50 s 11.0 / 9.1 → 6.3 / 4.1 cm; contact 0.21 cm and the overlap within two
  frames of every impact (≤ 2.03 cm, QA's bar 3 cm) unchanged. Test:
  `tests/unit/fight-separate-ease.test.ts` (new, skinned fixture bots; fails on d916477).
- A bot's keyframe move plays over its fight idle (bot-slides T2; `src/engine/fight/solve.ts`,
  `src/engine/mocap/clip-marks.ts`): a strike the library has no clip for (the spinning back kick,
  the spinning backfist) crossfaded a bot from its idle's staggered stance into the keyframe rig's
  feet-together first pose and back, and the standing leg followed the keyframes' small hip and
  knee turns, so both feet slid 17–53 cm with the hips still. Now a bare-handed bot plays such a
  move over its idle on shot time (`overIdle`) when the legs it stands on hold within 0.25 rad of
  its first key (`playsOverIdle`: the spinning kick and backfist, the teep; the sweep, the shoves
  and the tackles crouch or lunge on theirs and keep their crossfaded keyframes): the keys carry
  the idle and the move's change from its first key as an overlay, on the idle's own root travel,
  so the stance stays; the legs keep the idle's planted feet but a kicking leg on the keys that
  lift its foot 10 cm off the floor, lifted off and set down straight (a key with the thigh
  forward and the knee bent twice that, a third into the way off and from the end of the way
  back). A footwork window no longer runs on over marks that hold the body still (an idle's sway
  under them is no step). QA's run3 fight, KIRA 6.0–8.0 s (`.maestro/bot-slides/fight-run3-*.txt`),
  d916477 → now: foot-slide runs over 5 cm 5 (17–53 cm, hips still) → 0; the pivot toe travels
  2.5 cm over the 1.5 s move; contact 0 cm. On the real library (`mocap-fights-real`'s scripts)
  the teep's overlap at its impact drops from 2.5 to 0.2–0.4 cm. One push left: Y Bot's spinning
  backfist KO on X Bot lands from 8 cm closer, so on the frame after it both bodies are pushed 9 cm
  apart at once (the push's fallback, `separate()`). Tests: `tests/unit/mocap-footwork.test.ts`
  and `tests/unit/mocap-fights-solve.test.ts` (their keyframe-move cases now ask for the move over
  the idle, the pivot foot still and the kicking foot back on its spot, and a sweep and a tackle
  still crossfaded; the first two fail on d916477).
- A bot on its first mark reads its first leg's speed (bot-slides T3; `src/engine/evaluate.ts`): at
  the first mark the evaluator reported speed 0 even where the first leg sets off at once, so a
  bot running from frame 0 (QA's chase runner) stood on frame 0 and crossfaded into its run, its
  feet sliding 15–17 cm. Now a bot there reads the leg's speed as it sets off (a hold or an ease
  out still reads 0; every other body as upstream). QA's Downtown chase on bots, seeds 7 / 3 / 21,
  caught / escape, foot-slide runs over 15 cm, d916477 → now: 3 / 6 / 2 → 2 / 5 / 1 and 6 / 3 / 5
  → 5 / 3 / 4 (the first frame's gone everywhere). Left: keyframe legs over the run loop (the
  skid and stumble beats, 17–37 cm), run ↔ walk gait crossfades (18–32 cm) and one stop into a
  standing pose (38 cm). Test: `tests/unit/bot-first-frame.test.ts` (new; fails on d916477).
- Fight solves remembered in the engine (fight-speed T1; `src/engine/fight/solve-memo.ts` new,
  `src/renderer/store.ts`, `src/engine/prompt-scene.ts`; plan
  `docs/plans/2026-10-23-fight-speed.md`): the store's memo of the last 16 fight solutions (by
  the fight, the fighters' inputs, the shot's timing, the props, the loaded bots and clips) moves
  into the engine as `solveFightMemo`, and the prompt's action section reads it too: the Deliver
  panel's prompt solved every fight of the scene again on every edit (a bot fight: seconds a
  time); now a fight solves once per change to its inputs, and in a scene without props the
  prompt reads the staged fight's own solve (no props and an empty prop list are one key). The
  solver is untouched: the 14 `mocap-fights-real` scripts both ways and QA's run3 solve to
  byte-equal marks and reports. Test: `tests/unit/fight-solve-memo.test.ts` (new).
- Bot fights stage off the main thread (fight-speed T2; `src/renderer/fight-offthread.ts` and
  `src/renderer/fight-worker.ts` new; `src/engine/fight/solve-memo.ts`, `src/renderer/store.ts`,
  `src/renderer/mocap/library.ts`, `src/renderer/control/handler.ts`,
  `src/renderer/panels/FightDirector.tsx`, `AGENTS.md`): staging or re-solving a Y Bot vs X Bot
  fight ran its solves (seconds each) on the renderer's main thread behind "Staging fight…".
  Now `offThread` runs the store action in planning mode (a solve the memo doesn't have stops
  it, `store.mutate` edits a throwaway copy), solves what it stopped at in a worker, remembers
  it, and runs the action for real once every solve hits: the same marks, report, undo step and
  ids as before. The worker's engine has the same bots and clips: the renderer relays each
  registration to it, in order. `stageFight` takes the ids an earlier run made
  (`StageFightInput.ids`). MCP `stage_fight` / `update_fight` (and a routine or sequence fight
  of two bots, which answers once it has staged), the Fight Director's Stage, Apply and
  Re-solve, and the Choreographer's routine fights stage this way; without a worker (Vitest)
  or when it fails, the solve runs on the main thread as before. Built app, MCP stage of a
  bot combos fight: before, one 10.2 s main-thread task and a 10.5 s frame gap; now the app
  draws 210 frames while it solves (worst gap 89 ms, longest task 89 ms), and the fight equals
  the same staging solved on the main thread. Tests: `tests/unit/fight-offthread.test.ts`,
  `tests/e2e/fight-worker.spec.ts` (new).
- Fight reads solve off the main thread too (fight-speed T3; `src/renderer/fight-offthread.ts`,
  `src/engine/fight/solve-memo.ts`, `src/renderer/panels/FightDirector.tsx`,
  `src/renderer/panels/DeliverPanel.tsx`, `src/renderer/export/exporter.ts`,
  `src/renderer/control/handler.ts`): the Fight Director's live report (a project just opened)
  and the Deliver panel's prompt (a fight staged among props: the prompt solves without them)
  solved on the main thread while they rendered; now `readSoon` gives the memo's answer, or
  starts the solve in the worker and renders again when it is in (the prompt box says it is
  solving the fight meanwhile; Copy waits). MCP `set_shot` (the shot's fights re-solved),
  `get_fight`, `fight_coverage`, `export_shot`'s prompt and the export's `prompt.txt` (now
  generated once) solve through `offThread`. A solve asked again while the worker has it is
  asked once; one the worker can't answer is solved on the main thread from then on. The
  Timeline's and Inspector's duration and fps edits still re-solve on the main thread (a
  controlled number field can't wait for the worker). Tests: `tests/unit/fight-offthread.test.ts`
  (reads, MCP `set_shot` → `get_fight`), `tests/e2e/fight-worker.spec.ts` (`set_shot`, the
  Deliver prompt).
- A bot's bounding sphere from its bones (fight-speed T4; `src/renderer/mocap/body.ts`): a bot
  clears its skinned meshes' bounds every frame (so the export's depth range and top-down fit
  measure the posed body), and three's draw sort then measured the sphere again by skinning every
  vertex on the CPU, 8–9 ms a mesh, two meshes a bot, every frame. Now each skinned mesh's sphere
  comes from its bones: every skin influence moves its vertex rigidly with its bone, so the vertex
  lies within that bone's reach (the furthest skin it moves, measured once per skin at bind) of
  its joint, and the sphere around those balls holds the whole posed skin (larger than the skin's
  own, never smaller; the bot is never culled, it only orders the draw and starts a pick). The box
  stays the skin's own (exports measure it). Real library: every vertex inside on 34 clips × 4
  times, radius ≤ 1.17 / 1.33 × the skin's, 0.02–0.04 ms a call. Test:
  `tests/unit/bot-bounds.test.ts` (new).
- An export's depth range from each frame's own pose (fight-speed T5;
  `src/renderer/viewport/SceneManager.ts`): `measureDepthRange` measured a moving bot where the
  last render left it (`Box3.setFromObject` updates an object's world matrix, a skinned mesh's
  bind inverse only moves on `updateMatrixWorld`), so a depth pass's shot-wide range hung on what
  rendered before it: the playhead's frame on a depth-only export, the clean pass's last frame
  after one. It now updates the scene's world matrices before it measures. This changes depth
  output on purpose wherever a bot moves (a bot fight's depth mp4 is a new file); the clean pass
  is unchanged (the same bytes) and the normal pass never measures. A combos fight on bots, 10 s:
  depth-only exports from playhead 2 and 8 and the depth after the clean pass were 3 different
  files, now byte-identical. Test: `tests/e2e/mocap-bots.spec.ts` (a bot fight exports the same
  depth from any playhead, with or without the clean pass before it).
- Fight coverage keeps the set out of the sightline (shot-clear T1; `src/engine/camera-clear.ts`,
  `src/renderer/camera-view.ts`, `src/renderer/store.ts`, `src/engine/evaluate.ts`): the gym's
  master wide framed the black bench in front of the fighters' feet, because a view only checked
  rays to the head, chest and pelvis. A view now also measures `setCover`: the share of each
  framed subject's projected box (its posed rig points padded half a body width, clipped to the
  frame) that a set box covers in front of it, by a 12 × 16 grid of rays. Shot words
  (`frame_shot`, every `fight_coverage` mode) and framing presets reject a view whose cover is
  over 10 % on any sample, and the view a search picks is then checked on every frame of its span
  (a frame it fails joins the samples and the search runs again: a fighter's step swung a held
  framing into the alley wall between two samples). Coverage framings are checked from the start
  of the 0.4 s move into them; a coverage over-the-shoulder beat with no clear view (it can only
  rise; the bus shelter's roof) becomes the MS two-shot on the same side; when no view holds on
  every frame, the one clear on the most frames is kept (it was the one never inside a wall's
  margin on the samples, which kept a wide two-shot behind the alley wall); and coverage and
  `frame_shot` start from the lens the camera was asked for (`baseLens`), not the last framing's
  (one coverage run's over-the-shoulder 68 mm put the next run's wide two-shot 14 m back, outside
  the alley). A shot words mark moved closer on a wider lens now plays as asked: the mark keeps
  the solved focal length, `closer` already in it, and the per-frame solve took that as its lens
  and applied `closer` again (0.55 played as 0.30: a wide two-shot on 11 mm with the near fighter
  filling the frame); `solveShotMark` divides it back out. QA's run3 fight (bots) in the gym at
  (0, −2), along the alley at (0, 3) and by the downtown bus shelter, 4 modes × 2 sides, every
  frame at 24 fps: runs with frames where a set piece covers over 10 % of a fighter's box, HEAD 11
  of 24 (gym master right 128/360 frames, alley follow right 301/360 of solid wall, the lens
  inside the gym's mirror for 3), now 4 of 24, each one frame at 10.3 % (the dumpster at a downed
  fighter's feet, at the 10 % line), and the lens never inside the set. A coverage call on bots
  takes 0.4–3.5 s, 6.1 s when no view holds on every frame (HEAD 0.05–3.3 s). Tests:
  `tests/unit/set-cover.test.ts`, `tests/unit/shot-clear-store.test.ts` (new).
- Camera moves fitted to the set (shot-clear T2; `src/engine/move-clear.ts` (new),
  `src/engine/camera-clear.ts`, `src/renderer/camera-view.ts`,
  `src/renderer/viewport/SceneManager.ts`): only people-follow moves kept clear of the set, so an
  orbit inside the alley kit rendered wall. `applyCameraMove` now fits every other preset round
  its subject (`clearMove`): the whole move at once, so it keeps its shape, about the subject's
  aim point at each mark's time: closer on a wider lens (≥ 12 mm), raised, its sweep from the
  first mark cut to ¾ / ½ / ¼ and turned round the subject, the nearest fit whose lens stays out
  of the set and whose subject's box the set covers no more than 20 % on every frame. A clear move
  is unchanged; when no fit is clear the one clear on the most frames is kept and the tool result
  and toast carry a warning (`apply_camera_move` `note` / `warning`). The 39 presets round a
  person in the alley and downtown, from a camera 5 m in front and 5 m off 45° (156 moves, every
  frame): moves with blocked frames and no warning, HEAD 49, now 0 (2 warn: the high drone orbit
  can't clear the alley's 8 m walls). A fit takes ≤ 0.4 s, 1.9 s when none is clear. Test:
  `tests/unit/move-clear.test.ts` (new).
- A bot's plain sit gait sits on its seat prop's top (shot-clear T3; `src/engine/mocap/gait-clips.ts`,
  `src/engine/mocap/library-clips.ts`, `src/renderer/viewport/SceneManager.ts`,
  `src/renderer/viewport/builders.ts`, `src/renderer/mocap/body.ts`): over a seat prop the `sit` gait
  played the chair idle at the take's own height (~0.42 m), so a bot on a stool sat inside it. The
  renderer now passes the seat's top (`AnimInput.seat`, `seatTopOver`, the sit-down's own formula)
  and the gait loop rests on it through `seatLift`, as a sit-down's clip marks do. Real library, the
  chair loop on both bots: the hips' lowest point off the seat top, worst over the loop, stool
  22.9 / 25.1 cm, chair 5.9 / 8.1 cm, couch 12.4 / 14.6 cm, office chair 27.9 / 30.1 cm, now 0.0 cm,
  feet on the floor; built app, Y Bot's Hips on a stool 0.597 → 0.887 m, on a chair 0.597 → 0.677 m.
  Test: `tests/unit/mocap-seats.test.ts` (extended).
- An open road under a car chase (street-kit T1; `src/engine/road-kit.ts`, `src/engine/vehicles.ts`,
  `src/renderer/viewport/road-kit.ts` (new), `src/engine/sequences.ts`, `src/engine/assets.ts`,
  `src/renderer/viewport/builders.ts`, `src/renderer/store.ts`, `src/renderer/control/handler.ts`,
  `src/renderer/panels/Library.tsx`, `mcp/tools.json`): the street kits are 20–36 m tiles and a 6 s
  chase covers ~90 m, so the cars drove off the set within two seconds. `env.openRoad` ("Open
  road") is a city street whose drivable length is `params.length`: asphalt to kerbs at ±5.5 m with
  centre and lane dashes, sidewalks to ±9 m, a lamp post every 15 m each side, a front row of
  buildings with a storefront band and window rows, a taller back row, and an end block across each
  end, so a camera looking down the street sees a facade, never the empty ground; widths and heights
  come from an index hash, and its surfaces sit 2 mm over a standard kit's. The layout is engine
  data (`roadLayout`); a building and its bands draw as one mesh, so the set readers see one box.
  The Library / `spawn_sequence` car chase now lays one under itself in the same undo step (the
  road isn't selected), from 40 m behind the last car's start to 45 m past the lead's end, or runs
  along the open road it is placed on (snapped to its centre line and axis) and lengthens it
  (`spawn_sequence` returns `roadId`). Each car drives one smooth line at the chase's pace from the
  first frame to the last (two marks, the weave in `via` points, no easing: the shot starts
  mid-chase, no heading snaps at a mark; the old 160 m cap went with the void). `vehicles.ts` holds
  each vehicle's box as the builders draw it (the catalog footprint is a placement radius). The
  chase (both styles, 2–4 cars, 6 / 15 s), every frame at 24 fps: car-frames with a corner off the
  street, HEAD staged on Downtown along its street 7143 of 8668, now 0 of 8668 (no two cars
  overlap, no heading step over 2°); void (a ray below the horizon meeting no set, car or kit floor)
  from three live shot-words cameras on the lead, worst frame HEAD on Downtown 11–64 %, now 0 %.
  Test: `tests/unit/road-kit.test.ts` (new).
- Camera moves sized for a vehicle (street-kit T2; `src/engine/camera-moves.ts`, `src/engine/move-clear.ts`,
  `src/engine/vehicles.ts`, `src/renderer/camera-move.ts` (new), `src/renderer/viewport/SceneManager.ts`): the 39
  presets were sized for a person, so on a car the follow, lead and side-track moves rode 1.7 m off
  its bumper and the frame was all car body. `CameraMoveContext.subjectBox` (a vehicle's drawn box)
  makes each preset's near distances (end distances, minimum radii, follow / lead / flank offsets, a
  boom's peak) its longest side / 1.8 m times longer, and a follow height keeps its rise over the aim
  point scaled the same way; aerial altitudes and the low angles stay put, and a person's moves are
  unchanged. `clearMove` then keeps the car whole in frame: a moving car's tracking move rides at its
  speed from the first frame (no eased start or stop), each tracking mark backs off along its own line
  until the car's box fits in 90 % of the frame, marks round a frame that still loses it (a pass over
  the car) back off further, a set fit may not lose the box where the move kept it, and a move that
  still does says so (`leaves LEAD partly out of frame on n of m frames`). The pipeline that was inline
  in `applyCameraMove` is `layCameraMove` (no WebGL), so tests lay moves exactly as the app does. The 39
  presets on a chase's lead car, alone and in a 4-car chase, straight and weaving, the camera starting
  on the road ahead or on the sidewalk (312 moves, every frame at 24 fps): moves that lose the lead's box
  with no warning, HEAD 172, now 0; moves with the lens inside a car's box 0 and 0; 51 warn (40 the
  static moves that look away by design: whip pan, static pan, slow tilt, snap and crash zoom; 11 orbits
  and spirals the street's walls still block on 1–3 % of frames). Laying a move on the road takes 0.44 s
  on average, up to 6.8 s when no set fit is clear (the fallback search). Test:
  `tests/unit/vehicle-moves.test.ts` (new).
- Speed warnings that know what a vehicle can do (street-kit T3; `src/engine/vehicle-speed.ts` (new),
  `src/engine/evaluate.ts`, `src/renderer/panels/Timeline.tsx`, `src/renderer/export/exporter.ts`): upstream
  checks a travel leg against a person's gait speeds times `speedScale`, so a car at a chase's
  15 m/s read as too slow for its "run" (26–135 m/s) and the Timeline told every car to jog. A
  road, rail or water vehicle is now checked on its evaluated path over the shot: its top speed,
  and over each half-second window the change of speed (speeding up, braking) and the turn at the
  mean speed (cornering, v ω), against the class's limits (a sedan 70 m/s, 9 / 11 / 11 m/s²; a bus
  30 m/s, 2.5 / 7 / 4), the worst moment of each kind once per vehicle. A camera that tracks a
  moving subject warns when its marks travel faster than its rig can follow (ground rigs and crane
  8 m/s, drone 30, car mount 70; a mounted camera car always keeps up). They come through the same
  channel, `ShotEvaluator.warnings()`, with a fork `message` the Timeline chips and `metadata.json`
  show; people keep the gait check unchanged. The Library car chase (both styles, 2–4 cars, 6 / 15 s)
  had 180 warnings at HEAD (on Downtown) and 36 after T1, all "try jog"; now 0. `warnings()` is
  worked out once per evaluator: 4 ms on a 15 s 4-car chase. Test: `tests/unit/vehicle-speed.test.ts`
  (new: one per warning, and the chase).
- A car chase that lays its own camera (street-kit T5; `src/renderer/camera-move.ts`, `src/renderer/store.ts`,
  `src/renderer/viewport/SceneManager.ts`, `src/renderer/control/handler.ts`, `mcp/tools.json`): a staged
  chase left the shot camera where it was, at the default pose looking at the origin, so the cars drove
  out of frame and staging needed a camera move and a rig change by hand. Staging a Library /
  `spawn_sequence` car chase on a shot camera with no marks now lays Lead the Subject on the lead car
  through `layCameraMove` (`putCameraMove`, in the same undo step): a camera car in front of LEAD with
  the pursuers behind it in frame; `spawn_sequence` returns `camera` (preset, rig, note / warning). A
  camera with marks is left alone. `layCameraMove` also names the rig a follow or aerial move on a moving
  vehicle needs to keep up (`LaidMove.rig`: Car mount, a drone in the air) while the shot's rig is still
  the default Sticks, and `applyCameraMove` sets it in the same mutate (`apply_camera_move` returns
  `rig`); a rig set by hand stays, and its speed warning with it. The chase as staged (both styles, 2–4
  cars, 6 / 15 s, every frame at 24 fps): the lead's box out of frame, before 3036 of 3036 frames, now 0;
  warnings 0 and 0; pursuers in frame 0.01 → 1.96 per frame. The 13 follow and aerial presets on a
  moving lead (both styles, 2 / 4 cars): camera speed warnings on Sticks 52 of 52 moves, on the rig the
  move names 0. Built app, one click (staged and exported, H3 Max, 15 s, 4 cars): the lead out of frame
  0 of 361 frames in both styles, no warnings. Test: `tests/unit/chase-camera.test.ts` (new).
- Fight coverage off the main thread (main-thread T1; `src/engine/fight/coverage-clear.ts`,
  `src/engine/fight/coverage-memo.ts` (new), `src/engine/fight/coverage.ts`, `src/engine/fight/solve-memo.ts`,
  `src/engine/camera-clear.ts`, `src/engine/shot.ts`, `src/engine/evaluate.ts`, `src/renderer/camera-view.ts`,
  `src/renderer/fight-offthread.ts`, `src/renderer/fight-worker.ts`, `src/renderer/store.ts`): shot-clear's
  every-frame check made a `fight_coverage` call on bots 0.4–6.3 s on the main thread, and the app ran it twice
  (`offThread`'s planning run, then the real one). The solve memo's key leaves out the fight's `coverage`, which the
  solver never reads, so a coverage mode no longer re-solves the fight (every second call did). The search is the
  same, worked out once: a sample's subjects are posed once (`subjectPose`; a shot solve's bodies once per subject),
  each view check once per time and variant, the cast sampled without its camera (`evaluateEntities`), one sample
  store for all of a coverage's framings, and the cover rays cast against each box's cached heading without
  allocating. A coverage's framings (`clearCoverage`, moved from `camera-view.ts`) are remembered by everything they
  read (`coverage-memo.ts`; the marks' ids left out, an action's every run lays fresh ones), so under `offThread` the
  fight worker works them out (a `cover` job beside `solve`) and the store's real run reads them. QA's run3 fight on
  bots, gym / alley / downtown × 4 modes × 2 sides (`.maestro/main-thread/cover.probe.ts`, load 18–65 %): HEAD
  0.43–6.26 s, pre-T1 (3c54c8e) 0.05–3.31 s, now 0.15–0.76 s worked out on one thread and 37–51 ms on the main
  thread with the search in the worker; every case's camera marks equal to HEAD's. Built app, MCP `fight_coverage`
  on the combos fight: HEAD one 0.94–1.29 s task, now none over 50 ms before the commit (the commit's mark rebuild
  and selection box: T2, T3). The 29 fight solutions byte-equal; an export of a covered bot fight equal to HEAD's.
  Tests: `tests/unit/coverage-memo.test.ts` (new), `fight-offthread.test.ts`, `fight-solve-memo.test.ts` (extended),
  e2e `fight-worker.spec.ts` (MCP `fight_coverage` in the worker, equal to the main thread's).

- Staging commit frame (main-thread T2; `src/renderer/viewport/overlay-cache.ts` (new), `src/renderer/viewport/SceneManager.ts`,
  `src/engine/mocap/gait-clips.ts`, `src/renderer/mocap/library.ts`): staging a bot fight cost its commit and first
  frame 207 + 298 ms (HEAD with T1, MCP `stage_fight` of the combos fight; 190 + 198 ms with coverage master). Marks
  share their resources: every mark's tape (two bars and their material) per colour and its number (texture and sprite
  material) per index, a selected lane's time labels per text and colour, each made by the builders' own `markMesh` /
  `labelSprite` once and cloned; a rebuild never disposes the shared ones. A number is a canvas the first time: past
  24 new ones in one task (a staging's hundreds) they are made 48 an idle slice and join the marks still shown then.
  `warmOverlay` compiles the overlay's programs and the selection box's and gizmo's (`compileAsync`, once per renderer and fog) and takes each into use one
  per idle slice: without KHR_parallel_shader_compile three's link stalls the first frame that draws with a program
  (88–99 ms at a staging). A bot's travelling loops are measured (`clipWarp`, cached) one per idle slice once the
  library is in, so the commit's first evaluate measures none (`applyTime` 49 → 5 ms), and `measureWarp`'s floor
  check scans each bone's own points (the 18 clips: 554 → 244 ms, the warps byte-equal). Built app, the same staging
  (`.maestro/main-thread/diag.spec.ts`, load 42–87 %): with T2 alone 180 + 97 ms (154 + 124 with coverage), the rest
  being the selected bots' boxes skinning every vertex in the commit (T3); with T3, 74 + 59 and 70 + 54 ms (with
  coverage master 77 + 72 and 72 + 75, before the numbers' idle slices), no task over 100 ms from the call to the first
  settled frame and no program linked then.
  Editor chrome only: the fight solves (30 dumps) byte-equal, an export of a covered bot fight equal.
  Tests: `tests/unit/overlay-cache.test.ts` (new).

- A selected bot's box (main-thread T3; `src/renderer/mocap/body.ts`, `tests/e2e/fight-worker.spec.ts`): the selection
  box (`BoxHelper`) asks a selected bot's skins for their box every frame, and three's `SkinnedMesh.computeBoundingBox`
  skins every vertex on the CPU (a matrix product per vertex and weight): Stage with 4 bots, 30.3 ms a frame with the
  two fighters selected against 11.8 ms with none (HEAD with T1), and 20 + 28 ms of a staging's commit. A bot skin's
  `computeBoundingBox` is now `skinnedBox`: the same arithmetic in the same order, so the same box to the bit (the
  export's depth range reads it), without the per-vertex costs: each bone's skinning matrix multiplied once a call,
  each distinct (position, skinIndex, skinWeight) skinned once (an FBX skin repeats each point per face: Y Bot 166k
  vertices, 28k distinct), its bind-space position worked out once and its nonzero weights packed, and the divide by
  an affine bone's last row (exactly 1) skipped. A posed Y Bot or X Bot (`.maestro/main-thread/box.probe.ts`): three's
  17–23 ms a frame → 0.7–1.0 ms, the boxes equal to three's to the bit. Built app (`diag.spec.ts`, load 36–93 %): the
  fighters selected 13.5 / 10.5 ms against 11.9 / 8.45 ms with none (+1.6 / +2.05 ms; a prop selected 12.2 / 8.4 ms).
  With main-thread T2, a staging's commit and first frame stay under 100 ms; the fight-worker e2e now holds them to
  150 ms (a loaded run). Tests: `tests/unit/bot-bounds.test.ts` (the box against three's, and a skin whose points
  repeat), e2e `fight-worker.spec.ts`.

- A bot's planted feet stay put through a gait crossfade (chase-feet T1; `src/engine/mocap/plant-lock.ts` (new),
  `src/engine/mocap/footwork.ts`, `src/renderer/mocap/scene.ts`, `src/renderer/mocap/body.ts`,
  `src/renderer/viewport/builders.ts`, `src/renderer/viewport/SceneManager.ts`): a bot braking from a run to a walk (or
  speeding back up) crossfades two loops that have the same foot down at spots their strides put apart, and the blend
  dragged that foot 18–32 cm along the floor. Around a crossfade into a travelling loop, and up to 1.05 s after it, the
  feet are held: `scene.ts` samples the bot's earlier inputs on a fixed 96 Hz grid from the window's first crossfade
  (a function of the document, not of the frame drawn before; each sample worked out once per document, under the
  camera-less evaluator SceneManager passes as `memo`, a crossfade's change found once between the grid samples either
  side), `body.ts` poses each sample with the `resolve` it draws with (`AnimInput.plant`), and `plantCorrection` walks
  them: while a foot's toe or sole is within 2 cm of the floor, its correction cancels the travel of the joint it
  stands on, so it can't jump as it lands; once it lifts, the correction eases out over 0.2 s of its swing. A held foot
  the leg can't reach with the hips sunk up to 8 cm, or one let go of while down (a still pose, or 0.8 s past the last
  crossfade), steps off in a lifted arc over 0.2 s. Two-bone leg IK (`footwork.ts` `reachLeg`, now exported), the
  foot's turn kept; not on a bot holding a weapon. QA's Downtown chase on bots (seeds 7 / 3 / 21, caught and escape,
  `.maestro/chase-feet/skate.probe.ts`): the 10 crossfade slide runs of 18–32 cm → none over 5 cm; slide runs over
  5 cm 68 → 45, none new or longer; a planted toe's largest one-frame move inside a crossfade window 4.8 cm (the stop
  into a standing pose, T2's, unchanged at 7.1); QA's run3 fight: the same report (contacts, overlap, slide runs), the
  bones moved on 11 frames by up to 5.3 cm where a mark clip fades in over a gait crossfade. A bot inside
  a window costs ~0.5–1 ms a frame more (the probe, CPU load 62–90 %). Test: `tests/unit/plant-lock.test.ts` (new).

- A bot steps into a standing pose instead of gliding its feet there (chase-feet T2; `src/engine/mocap/plant-lock.ts`,
  `src/renderer/mocap/scene.ts`): a walk fading into a standing pose (the idle, or a keyframe stand such as the escape's
  hands on hips) blended each planted foot from its stride spot to its spot in the stance, up to 38 cm. The plant lock
  now runs around every gait crossfade, and where the pose stands still a held foot more than 1 cm off its spot steps to
  it (a 0.2 s lifted arc) once the other foot is down and not stepping, the one further off first; past 0.8 s after
  the last crossfade it steps whatever the other foot does. QA's Downtown chase on bots: escape seed 3 COP 1 7.54–7.83 s
  38 cm → 4.8 cm (the trailing foot held, then stepping up once the other lands), seeds 7 / 21 COP 1's stops 14 → under
  5 cm; slide runs over 5 cm 45 → 42 (none new or longer than HEAD's); a planted toe's largest one-frame move inside a
  window 4.8 cm; QA's run3 fight: the same report, the bones moved on 20 frames by up to 6.9 cm (mark clips fading in
  over a gait crossfade). Test: `tests/unit/plant-lock.test.ts` (extended).

- A bot's planted feet stay put under a keyframe beat riding its run (chase-feet T3; `src/engine/mocap/swing-legs.ts`
  (new), `src/engine/mocap/plant-lock.ts` (`boneLow` exported), `src/renderer/mocap/body.ts`,
  `src/renderer/mocap/scene.ts`, `src/renderer/viewport/builders.ts` (`AnimInput.lift`)): the chase's skid, stumble and
  vault put their hip and knee channels on top of the run loop's legs, and on a planted foot that dragged it 17–37 cm.
  A travelling loop under leg channels now shows the beat's pose (its crouch, torso, arms, a swinging leg's tuck) with
  each foot where the loop has it as far as that foot is on the floor (all the way below 3 cm, none above 15 cm),
  reached with two-bone leg IK, the hips sinking where the beat holds them higher than that leg reaches; a root lifted
  15 cm or more over the ground (the vault over its obstacle) keeps the beat's whole legs, as before. QA's Downtown
  chase on bots: the 9 leg-overlay slide runs → none over 5 cm; slide runs over 5 cm 42 → 4 (HEAD 68), none new or
  longer, none over 15 cm; QA's run3 fight: report and bones as T2's. A leg the loop has planted no longer follows
  the beat's stride (the keys were written for the standing rig). Test: `tests/unit/plant-lock.test.ts` (extended).

- One viewport across the modes (main-thread T4; `src/renderer/viewport/ViewportSlot.tsx` (new),
  `src/renderer/App.tsx`, `tests/e2e/fight-worker.spec.ts`): switching to Deliver built a whole new SceneManager
  (a 241–473 ms task on a staged bot fight: program links, shadow map setup, `syncFromStore`). The Viewport now
  renders once into a host element and each mode's layout holds a slot the host moves into (`display: contents`, the
  layout unchanged), so the switch keeps the same SceneManager: no task over 50 ms from the switch to the prompt
  (`.maestro/main-thread/diag.spec.ts`, load 48–88 %). Side effect: the free camera keeps its view across Deliver.
  The fight-worker e2e asserts the same SceneManager across the switch.
- Fight coverage's camera views solved in the worker (main-thread; `src/engine/fight/coverage-memo.ts`,
  `src/renderer/fight-offthread.ts`, `src/renderer/fight-worker.ts`, `src/renderer/store.ts`): the coverage memo
  carries each mark's solved view, so the main thread solves none when a coverage commits (it paid ~56 ms filling the
  bots' hips cache on the first view solve). Tests: `tests/unit/fight-offthread.test.ts` (no view solved on the main
  thread, marks equal), `tests/unit/coverage-memo.test.ts`. In the built app: not measured.

- Viewport navigation, folding panels and a live camera preview (Lior's own test, 2026-10-24;
  `src/renderer/viewport/navigation.ts` (new), `src/renderer/viewport/SceneManager.ts`, `src/renderer/layout/narrow.tsx`,
  `src/renderer/App.tsx`, `src/renderer/narrow.css`, `src/renderer/panels/Help.tsx`, `tests/e2e/navigation.spec.ts`
  (new), `tests/e2e/narrow-layout.spec.ts`): the left button only picks now. The middle button moves the editor view
  (drag orbits, Alt + drag pans across the floor, Shift + drag moves up and down), the wheel zooms, and W A S D / Q E
  fly while the pointer is over the viewport (Shift faster); a camera recording keeps upstream's left-drag orbit and
  right-drag pan as well. Upstream used three's OrbitControls defaults (left orbits, middle dollies, right pans).
  Every panel folds from a titlebar toggle at any width (the left and right panels, the Shoot timeline, the Deliver
  panel), so docked beside Clara the window can show only the stage; the narrow layout's overlays are unchanged and
  the toggles are small pane icons instead of glyphs. While the shot camera's body is dragged, the shot camera rides
  it, so the PiP follows the drag instead of jumping on release. A re-sync during a gizmo drag (the Mixamo library
  finishing its load) no longer detaches the gizmo and kills the drag. Help lists the navigation.

A stable or commercial distribution remains gated on upstream/trademark
permission, platform code signing/notarization, a final FFmpeg/H.264
distribution review, and the ordinary complete third-party compliance review.
