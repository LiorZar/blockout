# fix-root-pitch: floor motions make their pose, jumps leave the floor (2026-10-20)

Lane `fix-root-pitch`, round 4. BACKLOG bug: push-ups, cartwheel, crawl, kneel-tie-shoe and the lying falls need a root pitch channel; `sit-down` reads as kneeling; `mosh-jump` / `cheer-jump` read as crouch-bounces.

## Goal

Each listed motion reads as itself on all six bodies (man, woman, child, elderly, both mannequins), measured on FK: push-ups prone and near horizontal on hands and toes, crawl on hands and knees, kneel with the rear knee down, lying falls end lying, the cartwheel goes over through the hands, sit-down sits, the jumps leave the floor and land grounded. Nothing goes below the floor; the rendered rig matches FK.

## My calls

- **Root channels live in mark joints**: `rootX` pitch (+ tips forward / prone, like `torsoX`), `rootY` yaw (+ counter-clockwise from above), `rootZ` roll (+ to the right, like `torsoZ`). They rotate the whole body about the **pelvis joint** (the mark position stays under the pelvis, so a cartwheel's travel is just `move.forward`). FK: the pelvis frame in `poseFrames`; renderer: the pelvis group in `animatePerson`; grounding: `floor.ts` already takes every proxy point (hands, knees, back) through `poseFrames`.
- **Not in `MOTION_PRESETS`.** Upstream `round4.test.ts` allows only the 18 rig joints in library keyframes, and fights look up `knockdown-fall` / `ko-collapse` / `get-up-from-ground` there. So the fixed motions are a fork overlay (`motions-root.ts`, `ROOT_MOTIONS`, same ids, names and durations) that the playback lookups resolve first (`playableMotion`): `apply_motion` (`choreographMotion`), the Inspector motion list (now through `choreographMotion`), routines (`choreography.ts`) and crowd sequences (`sequences.ts`). The library listing and the Fight Director keep the upstream entries (follow-up for crd: the Fight Director could play these falls).
- **Per-body fits.** Bodies differ (classic vs mannequin legs, the elderly stoop), so a fixed pitch misses the second contact by 3–10 cm. An overlay keyframe can carry `fit`: level two contact groups (hands, feet, knees, torso, one knee, one foot) by turning listed channels (`rootX`; both hips; a front hip + knee pair that keeps the shin vertical). The floor rule (`floorMarks`, `floorRoutine`) applies it per performer body before grounding; the spec rides on the internal mark spec and never reaches the document.
- **Root angles interpolate on the shortest arc** (evaluator), so a cartwheel's full roll (0, ½π, π, −½π, 0) never spins back into the next mark.
- **Grounded keyframes stay grounded between them**: on a posed move the body's lowest point follows the straight line between keyframe lows (`posedMoveY` without the root-line floor), so hands and toes don't hover mid-push-up or mid-cartwheel.
- **Poses**: sit-down ends in the `sit` gait pose (thighs level, shins vertical, soles down: a seat the user dresses with a chair); the lying falls end supine (`knockdown-fall`, `fall-backwards`, `stumble-back-fall`, `lie-down-sleep`) or prone (`trip-and-fall-flat`, `ko-collapse`); `get-up-from-ground` starts from the knockdown's supine end (routines play knockdown → get-up); the cartwheel turns side-on (yaw ½π), rolls over right hand, both hands, left hand, lands and faces the heading again; the jumps take off extended, clear the floor at the apex and land into a crouch.

## Tasks

1. Root channel through FK, renderer, floor, mirror, evaluator → verify: `tests/unit/root-pose.test.ts` — rendered rig = FK (effectors 1e-6, lowest point = proxy within 5 mm) with root channels on six bodies; `mirrorJoints` negates yaw / roll; shortest-arc interpolation; grounded posed legs stay on the floor. `skeleton`, `floor`, `motion-floor` green.
2. Overlay, fits and playback lookups + push-ups, crawl, kneel-tie-shoe, sit-down, lying falls, get-up → verify: `tests/unit/root-motions.test.ts` — per motion × six bodies, its pose criteria on FK at its keyframes, and no body point below −2 cm at every 1/24 s through `ShotEvaluator`; the ids played by `apply_motion`, routines and sequences are the overlay's.
3. Cartwheel + mosh-jump / cheer-jump → verify: same file — inverted on both hands, a hand on the floor through the over-phase, standing at both ends; jumps: both feet ≥ 10 cm up at the apex, grounded at takeoff and landing.
4. Gate, smoke, `mannequin.spec.ts` + `weapons.spec.ts`; sheets per motion (classic man + male mannequin, side view) in `.maestro/fix-root-pitch-visual/`; `MODIFICATIONS.md`, `BACKLOG.md`, AGENTS.md note.
