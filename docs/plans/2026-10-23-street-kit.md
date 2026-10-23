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

## Done when
Before / after numbers per task; the sheet looked at; one clean full gate, smoke and the fork e2e set (mcp-gaps,
fight-camera, mannequin, weapons, mocap-bots, export-flush, mocap-race, export-editor-only, export-look, fight-worker)
with the lock and `--workers=1`; `MODIFICATIONS.md` entries; BACKLOG items marked DONE; each task staged alone.

## Results
(filled in per task)
