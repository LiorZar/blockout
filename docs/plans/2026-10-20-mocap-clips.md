# Mocap clips (phase 2 of docs/plans/2026-10-20-mocap-bots.md)

Lane `mocap-clips`. Goal: the bots (Y Bot / X Bot) play the library's real
Mixamo clips for gaits and the motion library. Fight moves stay on the
keyframe path (phase 3), but the clip path is built so phase 3 can use it.
Nothing from the library enters git or `tests/`: tests build synthetic clips
on the hand-built fixture skeleton.

## My calls

- **Clip data** (engine `mocap/clip.ts`): the renderer samples each FBX take
  at its frames and registers per frame the core bones' world rotations and
  the hips position (entity space). The engine stores them as rig rotations
  G relative to the source bot's A-rest (`W · restQ⁻¹`), so any bot plays a
  clip as `G · restQ_bot` (the bind correction), hips scaled by hip height.
  It also stores each frame's clearance: the source bot's lowest point over
  the clip's lowest (its ground). Fingers are render-only (renderer keeps
  their deltas from bind).
- **The body call** takes an optional clip state: `poseFrames(dims, joints,
  clip?)`, `poseEffectors`, `bodyLowY`. Procedural bodies ignore it, so they
  stay bit-identical. `EntityState.clip` carries it from the evaluator to the
  consumers and the renderer.
- **Overlay**: `joints` on a clip pose pre-multiply the clip's local rotation
  of the matching bone (the torso spread over the three spine bones, the head
  half on the neck, root channels about the hips). Zero joints = the clip.
- **Mark clip runs**: between two marks on the same clip (and mirror) the
  clip time runs linearly; any other pair crossfades (shortest arc) over the
  leg. Root travel: a root-motion clip moves the entity by its hips track
  (the pose's hips stay over the root); in-place clips travel the path.
  Floor: entity y = the marks' floor line + the clip's clearance (scaled)
  − the posed bot's lowest point (support points per bone).
- **Gaits**: the renderer maps each gait to its loop clip on a loaded bot;
  travelling gaits run on distance through a time warp measured off the
  clip's planted contacts; idle loops on shot time. Gait changes crossfade
  over 0.25 s, found by bisection on a camera-less evaluator (pure in t).
- **Library**: a fork table maps preset id → clip; clip-only clips get
  `mocap-<key>` ids. On a loaded bot every motion entry point lays a clip run
  (2 marks plus anchors); everything else keeps the keyframe motion.
  `list_motion_presets` adds `mocap: true` and the clip-only entries.
- **Hands**: clips play their finger tracks (in the engine pose, so the floor
  sees them); otherwise relaxed; fists for Fight Director fighters, weapon
  hands and the `handL` / `handR` channels (1 = fist).
- **Floor for clips**: a source frame within a 2 cm contact band of its floor
  is grounded exactly, higher frames keep their height (Mixamo sinks hands
  and arms 4–12 cm into the floor when on the ground).
- **Gait travel**: a time warp off the planted contact; the slide metric is a
  flat foot (heel and ball within 3 mm). Stand-to-sit and turn clips aren't
  auto-inserted (their root steps pull the body off its mark): they are
  library motions.
- **Runs**: a one-shot clip plays out and holds its last frame (keyframes
  repeat); a loop fills the span; back-to-back runs end 0.25 s early to
  crossfade; a clip starting over crossfades (never plays backwards).
- **Routines and sequences**: a bot's strikes and blocks keep their
  keyframes (the routines' exchanges are timed on them; Fight Director moves
  are phase 3); reactions, falls, get-ups, dances and gestures play clips.
  Sequences get a Bodies select (Mocap by default with the library).

## Tasks

1. Clip data: engine registry, sampling, loop, mirror, blend, clip pose +
   overlay, clearance; renderer FBX take → frames, fingers, loading.
   → verify: unit tests on a synthetic clip (fixture rig).
2. Mark `clip` field: types / schema / evaluate, body call, consumers,
   renderer clip pose.
   → verify: evaluator unit tests, `parseProject` round-trip, old projects
   unchanged.
3. Gaits from clips (renderer), transitions.
   → verify: real library: feet ±2 cm on both bots every 1/12 s; planted
   foot slide < 2 cm per step on walk, jog, run, crouch-walk.
4. Library: preset → clip table, clip-only entries, apply paths, MCP,
   prompt-scene.
   → verify: mcp-catalog; the BACKLOG floor moves make their pose on both
   bots (real library).
5. Determinism e2e, full gate, smoke, fork e2e, visual sheet in
   `.maestro/mocap-clips-visual/`.

## crd's rulings after T5, and my calls on them

1. **Crouch** (ruled: trim the crouch idle to its hand-free span). The
   library's crouch idle holds the right hand up for its whole 1.37 s loop,
   so it has no hand-free span. **My call:** the crouch still plays
   `crouchStill`, built when both clips register: the crouch idle (its
   breathing body) with each arm bone and finger at the crouched walk's mean
   rotation under its parent. No download.
   → verify: synthetic unit test; real library: both hands below the chest
   every 1/12 s on both bots.
2. **Sit**: a chair sit only over a seat prop, a floor sit otherwise.
   **My calls:** seats are the catalog's chair, stool, armchair, couch,
   office chair, wheelchair, toilet, bench and lounger, matched by catalog
   footprint × scale on the same floor (±0.5 m). The sit-down checks at apply
   time under the hips and under where stand-to-sit lands them. If the seat
   is under the hips, the run starts the stand-to-sit travel in front so
   the hips land where they stood, never snapped to the seat's centre (a
   couch is long). The sit gait checks every frame against where the seats
   are at that time (pure in t), so a chair placed later still counts.
   Routines and sequences know no seats and sit on the floor.
   → verify: `mocap-seats.test.ts`; real sits (floor and chair); e2e.
3. Procedural bodies: BACKLOG item stays open.
4. **Travelling runs on the warp.** **My calls:** the library's sprint is
   flagged in place, but its hips walk 3.1 m forward over planted feet;
   registration takes out that straight-line travel (only forward travel
   over 0.25 m, the sway stays), and it then plays on the warp like the
   others. Knee slide in the real check counts along the travel only: the
   knee joint sits 5 cm over the round knee and rolls sideways with the
   hips' sway (X Bot crawl: 2.1 cm total, of which ≈1.3 cm sideways).
   → verify: real run slide check (crawl, sneak, drunk walk, sprint).
5. Mirrored travel: `choreographMotion` takes `mirror`, so the run is laid
   mirrored, travel included (a small fix).
