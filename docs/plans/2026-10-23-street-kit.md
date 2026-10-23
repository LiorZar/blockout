# street-kit: a car chase that stays on the road and reads (2026-10-23)

Lane `street-kit`, coordinator `crd3`. Brief: `.maestro/handoffs/worker-street-kit.md`. Base: `c14e267` (HEAD now
`22e4cd3`, docs only). Runs beside `main-thread` (fight coverage cost, SceneManager marks / selection, Deliver).

## Goal

A Library car chase (straight or weaving, 2–4 cars, 6 s or H3 Max's 15 s) runs on a street from the first frame to the
last, the camera-move presets frame a car instead of sitting in its bumper, and the warnings speak about cars, not gaits.

## My calls

- **The chase lays its own road.** A new procedural kit `env.openRoad` ("Open road": asphalt, kerbs, sidewalks, lane
  dashes, lamp posts every 15 m, two rows of buildings, a cross-street block closing each end of the vista) whose
  length is a parameter (`params.length`, m). Staging a car chase adds one under the cars, laid along the chase from
  40 m behind the last car's start to 45 m past the lead's end, in the same undo step; the click path is unchanged
  (Sequences → Car chase → Stage → click). When the click lands on an open road already in the scene, the chase runs
  along that road (snapped to its centre line and axis) and lengthens it instead of laying a second one. Other kits are
  left alone (a chase clicked onto Downtown lays its road there; its surfaces sit 2 mm above a standard kit's so
  nothing flickers).
- **Layout in the engine, meshes in the renderer.** `src/engine/road-kit.ts` lists the kit's boxes as plain data
  (deterministic: building heights from an index hash, no randomness); `src/renderer/viewport/road-kit.ts` builds
  them; `buildAsset` hands `env.openRoad` its params. The set readers (`routine-set.ts`, `fight-obstacles.ts`) read it
  like any kit.
- **A chase car drives a smooth line at speed.** Each car is two marks (frame 0 and the last frame, no easing: the shot
  starts mid-chase) with `via` points every ~8 m, so its heading never snaps at a mark. Pace 15.3 m/s (the old 17 ×
  0.9) at every duration; the 160 m cap goes (the road follows the shot).
- **Real vehicle sizes.** `src/engine/vehicles.ts`: length / width / height of each vehicle as the builders draw it, and
  each class's plausible top speed and accelerations. "A vehicle's box" in every target is that box.
- **Camera presets on a vehicle: scaled, then fitted.** `CameraMoveContext.subjectBox` (vehicles only) makes each
  preset's near distances (end distances, minimum radii, follow / lead / flank offsets) `k = longest side / 1.8 m`
  times longer, and a follow height keeps its rise over the aim point scaled the same way; aerial altitudes, knee-high
  and low-angle heights stay as they are. Then each tracking mark is pushed back along its own bearing until the
  car's box fits inside 90 % of the frame. Shot-clear's set fit (`clearMove`) runs after it as before; for a vehicle
  its per-frame check also rejects a fit that loses the car's box from frame, when the sized move kept it. A move that
  still loses it (whip pan, snap zoom, static pan by design) warns.
- **"In the chase group"**: the subject is always the one car the move is built around; the group's other cars are
  obstacles (the lens never inside one; they already count as cover in `clearMove`).
- **Speed warnings in the existing channel**: `ShotEvaluator.warnings()` (Timeline chips, `metadata.json`). Vehicles
  (wheeled, rail) drop the person-gait check (a car's "run" wanted 26–135 m/s) for a vehicle check on the evaluated
  path: top speed, and acceleration over a 0.5 s window (a car rounds a mark's corner in about half a second), split
  into speeding up, braking and cornering. A camera that tracks a moving entity and travels faster than its rig can
  (ground rigs and crane 8 m/s, drone 30, car mount 70) warns too. `SpeedWarning` gains a fork `message` the chips
  show.

## Tasks

### T1 Open road (`BACKLOG.md:52`)
- Test first: `tests/unit/road-kit.test.ts`: the layout is deterministic and covers its length; a staged chase (both
  styles × 2/3/4 cars × 6/15 s) keeps every car's box inside the kerbs and on the road on every frame at 24 fps, no two
  cars' boxes overlap, the road reaches past every car by its margins.
- **Target:** cars off the road (any corner outside the kerbs or past the road's end): before = the chase staged on
  Downtown along its street (HEAD's best case) / after = 0 car-frames. Void (built-app ray grid from the shot camera:
  a ray below the horizon that meets no kit or cast) on every frame of the proof moves: 0.

### T2 Vehicle-aware camera moves (`BACKLOG.md:54`)
- Test first: `tests/unit/vehicle-moves.test.ts`: follow-behind on a sedan keeps the lens out of its box and the box in
  frame; a person's moves are unchanged (bit-identical marks).
- **Target:** the 39 presets on the lead car, alone and in a 4-car chase, both styles, on the open road, every frame at
  24 fps: frames with the lens inside any vehicle's box = 0; frames with the lead car's box partly out of frame = 0 or
  the move warns. Before / after counts (probe `.maestro/street-kit/moves.probe.ts`).

### T3 Vehicle speed warnings (`BACKLOG.md:55`)
- Tests first, one per warning: too fast, speeding up, braking, cornering, a follow camera that can't keep up; and the
  Library car chase (both styles, 2–4 cars, 6 / 15 s) with no warning.
- **Target:** HEAD's Library car chase warnings (before) → 0; each implausible case warns once per vehicle.

### T4 Proof
- Export the car chase (H3 Max, 15 s, 4 cars, both styles) on the new road through the built app over MCP, before
  (HEAD app) and after; `.maestro/street-kit/SHEET.png`; check the lead car framed, no editor chrome, no void,
  `prompt.txt` names each proxy and the road.

### T5 The chase lays its camera (crd3's rulings on Lior's open questions)
- crd3: a Library / MCP car chase also lays a camera in the same undo step, a follow on the lead with a rig that can keep
  up, fitted by `layCameraMove`, only when the shot camera has no marks yet; `apply_camera_move` with a follow-type preset
  on a moving vehicle sets a rig that keeps up (Car mount, Drone for an aerial follow) in the same mutate, a rig set by
  hand stays and its warning with it; a chase dropped on Downtown keeps laying its own road (one BACKLOG line).
- **My call: Lead the Subject** on LEAD. All five follow candidates keep the lead's box in frame with no warning on a
  freshly staged chase (`chasecam.probe.ts`, presets mode); Lead the Subject shows the pursuers too (1.96 of the 2 on
  average in frame per frame, follow-behind and the side tracks 0.71), so the clip reads as a chase.
- **My call: "set by hand" = not the default Sticks.** The document doesn't record who set a rig; Sticks is what a new
  shot gets, so a follow over Sticks takes the rig it needs and any other rig stays.
- **My call: follow-type = the `follow` and `aerial` categories** (every aerial preset rides along with its subject);
  aerial, or a subject flying over 3 m, takes Drone, the rest Car mount (no mount entity: the marks stay in the world,
  a camera car). "Moving" = the subject travels over 1 m in the shot (nine samples). Orbits, pushes and pans keep the rig.
- Test first: `tests/unit/chase-camera.test.ts`. **Target:** a freshly staged chase (both styles, 2–4 cars, 6 / 15 s)
  keeps the lead's box in frame on every frame with 0 warnings, in one click; the follow / aerial presets on a moving
  lead: camera speed warnings over Sticks → 0 on the rig the move names.

## Done when
Before / after numbers per task; the sheet looked at; one clean full gate, smoke and the fork e2e set (mcp-gaps,
fight-camera, mannequin, weapons, mocap-bots, export-flush, mocap-race, export-editor-only, export-look, fight-worker)
with the lock and `--workers=1`; `MODIFICATIONS.md` entries; BACKLOG items marked DONE; each task staged alone.

## Results

Probes and runs under `.maestro/street-kit/`; every frame at 24 fps unless said.

| Task | Measure | Before | After | Evidence |
|---|---|---|---|---|
| T1 open road (`add591c`) | car-frames with a corner off the street (both styles, 2–4 cars, 6 / 15 s) | 7143 / 8668 (HEAD, on Downtown) | 0 / 8668; no overlaps, no heading step > 2° | `chase-head-downtown.txt`, `chase-t1.txt` |
| | void, worst frame (ray grid, 3 live shot-words cameras on the lead) | 11–64 % | 0 % | `void-head-downtown.txt`, `void-t1.txt`, `t1-look.png` |
| T2 vehicle moves (`387a8b3`) | of 312 preset moves on the lead (39 × alone / 4 cars × straight / weaving × 2 starts): lose the lead's box with no warning | 172 | 0 | `moves-head.txt`, `moves-t2b.txt`, `t2-moves.png` |
| | moves with the lens inside a car | 0 | 0 (51 warn: 40 static by design, 11 orbits / spirals 1–3 % blocked by the street walls) | same |
| | lay time | — | 0.44 s mean, 6.8 s max (BACKLOG line) | same |
| T3 speed warnings (`c945991`) | Library chase warnings (both styles, 2–4 cars, 6 / 15 s) | 180 (HEAD on Downtown), 36 after T1, all "try jog" | 0; 19 tests, one per warning | `chase-t3.txt`, `tests/unit/vehicle-speed.test.ts` |
| | `warnings()` cost, 15 s 4-car chase | — | 4.0 ms per fresh evaluator | `warncost.probe.ts` |
| T4 proof | H3 Max export, 15 s, 4 cars, 1920×1080, 24 fps, 360 frames: lead's box out of frame | 361 / 361 both styles (camera in its bumper) | 0 / 361 (worst reach 0.98 straight, 0.85 weaving) | `export-before.txt`, `export-t3.txt` |
| | speed warnings / export warnings | 20 per export / none | 0 / none | same |
| T5 chase camera | freshly staged chase, camera as staged (both styles, 2–4 cars, 6 / 15 s): lead's box out of frame | 3036 / 3036 (default camera, no marks) | 0 / 3036; warnings 0 → 0; lens inside a car 0; pursuers in frame 0.01 → 1.96 per frame | `chasecam-bare-t5.txt`, `chasecam-staged-t5.txt` |
| | 13 follow / aerial presets on the moving lead (2 styles × 2 / 4 cars, 52 moves): camera speed warnings | 52 on Sticks | 0 on the rig the move names | `chasecam-rig-t5.txt` |
| | built app, one click (spawn_sequence, export, nothing else), H3 Max 15 s 4 cars | — | lead out of frame 0 / 361 (worst reach 0.85 straight, 0.86 weaving), speed warnings 0, export warnings none, 3.4 / 4.0 MB; `spawn_sequence` → `camera {presetId: lead-the-subject, rig: carMount}`; `apply_camera_move` follow-behind over Sticks → `rig: carMount`, overhead-track-follow → `drone`, over Handheld → kept | `export-t5.txt`, `run-export-t5/export.json` |

**Sheet** `.maestro/street-kit/SHEET.png` (looked at): one row per style, before (HEAD on Downtown, camera by hand) |
after T1–T4 (open road, camera by hand) | after T5 (one click). Before: the car's roof and tail fill the frame over the
empty ground. After: the car framed on the street, buildings and lamp posts both sides, no void, no editor chrome; T5:
LEAD head-on with the pursuers behind it. `prompt.txt` (T5, both styles): "The red box on wheels (LEAD) is a sedan car.
The 3 grey boxes on wheels are an SUV, a pickup truck and a van. … chase LEAD toward the camera. Camera: car-mounted …
Setting: a long city street lined with buildings." Every proxy and the road are named.

**Gate** (lock, `--workers=1` for e2e). Staged tree (`c945991` + T5, checkout-index snapshot, its own build):
typecheck / lint 0, `Test Files 107 passed (107)`, `Tests 1788 passed (1788)`; smoke `6 passed`; fork e2e set (mcp-gaps,
fight-camera, mannequin, weapons, mocap-bots, export-flush, mocap-race, export-editor-only, export-look, fight-worker)
`89 passed (5.5m)` (`idx-t5.txt`, `idx-smoke-t5.txt`, `idx-e2e-t5.txt`). Working tree (with main-thread's unstaged
work): `Test Files 108 passed (108)`, `Tests 1793 passed`; smoke `6 passed`; e2e `84 passed, 1 failed`: main-thread's
new unstaged `fight-worker.spec.ts:180` first-frames bar, 146 ms > 100 (`gate-final.txt`, `smoke-final.txt`,
`e2e-final.txt`).
