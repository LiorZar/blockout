# Held weapons on mocap bots

Lane `held-weapons`. Goal: a weapon a Mixamo bot holds never sits more than
3 cm inside its own holder, on any frame of any clip, library motion, gait or
fight it can play armed. The clips were recorded empty-handed (or with a
different prop), so a sword, shield or rifle held rigidly in the fist passes
through the body. Procedural people and studio mannequins hold weapons exactly
as before; fights keep every fight-polish bar.

## The measure

Weapon capsules (`weapon-shape.ts`) against the holder's posed skin
(`mocap/surface.ts`), as fight-polish measured its own-body episodes: a
capsule's depth is its axis points' skin depth plus its radius. The holding
forearm and hand are left out (both for a two-handed weapon; a shield also
leaves out the upper arm it is strapped to).

## My calls

- **Bots only.** Every rule below runs on `dims.mocap`; the procedural and
  mannequin hold paths are untouched (their tests and the legacy fight hash
  stay identical).
- **The mirror stands for the other hand.** The bots are symmetric, so a
  weapon in its default hand on a clip and on the mirrored clip covers it in
  either hand.
- **What an armed bot can play** (the probe's coverage): every library clip
  (marks, presets, `mocap-*` motions, fights, gait loops), the keyframe
  motions a bot keeps (presets with no clip), and the gaits as the renderer
  shows them (a stand under a hold pose on the keyframe rig; walk, jog and run
  on their loops with the weapon arm steadied; crouch, sit and lie on their
  loops under the hold pose).
- **The fix sits in the hand, computed from the pose.** Wherever a bot's
  weapon is placed (the engine's grip math and the renderer's, from its own
  rendered pose), one pure rule turns the weapon about its grip in the palm
  just enough to clear the holder's body. A weapon already clear is untouched,
  so a blow that lands still lands with the same weapon.
- **The rule** (`src/engine/weapon-hold.ts`): each core bone's skin as a
  convex hull (64 support planes of its support points, in the bone's
  frame), each finger of the hands too (on its own bone when the pose turns
  it), and for a shield a hand's, forearm's and finger's 3.5 cm wider (the
  skin there bends outside its support points' hull round a grip; padding
  them for a pistol, a sword or an axe that a clip grips in both hands turned
  it out of the other hand and off its mark: a shot 87 cm wide, a block read
  as a hit); the weapon's capsules as points every 3 cm; the least turn about the
  palm that brings every point onto the hulls (linearised, Hildreth's
  min-norm step, re-measured up to 16 times), the normals blended over the
  near planes so a hull's edge doesn't jump. A wedged weapon tries its axis
  along 26 directions, the clearest kept.
- **On a clip, a curve**: the turn per clip frame on the bare clip pose,
  followed frame to frame (each frame starts from the last one's eased 30 %
  back toward rest; a loop goes round twice), so it never flips round a body.
  A joint overlay or a crossfade measures it again on the pose, from the
  curve's turn, only past 1.5 cm in and only back to it (a fight's armed
  guard keeps its weapon off the skin, which the hulls hold a little wide);
  that refine only nudges the curve's turn (no restarts, no wedge search:
  the overlay placed the weapon). The armed guard's own solve sees the curve
  alone (its LM can't follow a turn that moves with its joints: two blocks
  read as hits with it).
- **The arm lifts only where the fist is in the body** (a hand on the knee
  on a get-up, a bow bringing the fist to the thigh): no turn frees a handle
  from a thigh. The lift is one scalar along one way for every pose (the
  arm raised forward and a little out; negative = back and in), the least
  lift past which the weapon stays out (a lift that only grazes clear
  doesn't count), so any more lift is clear too. On a clip each run of
  frames that need it lifts one way (forward if that clears all of them,
  else whichever of back and in, straight out to the side, or the elbow
  opened clears the most frames — the elbow never past 0.1 rad short of
  straight, and never for a shield: its easing swung the disc through the
  body on a dance spin), eased in and out over 5 frames either side as the largest of
  the neighbours' lifts; the turn is then solved again on the lifted poses,
  and a frame the eased lift leaves in the body gets its lift scaled back
  (¾, ½, ¼, none) to the most a solve clears there. Applied by
  `applyHolds`, so the engine and the renderer see the same pose.
- **Held poses, per clip family** (crd2: the weapon may go out to the side
  or turn away, in the hand, the frame reading): a hand at the chin
  (`think`) opens the elbow, the long gun held out from the face; a shield
  on hits, falls and kneels turns off the head and lifts back or out with
  the arm; the other hand on a two-handed clip (`greatSword`, `clap`) is
  kept off by the finger hulls (and a shield by the 3.5 cm pad); a dance step's eased
  lift is cut where it would carry the weapon into a leg.
- **The on-pose refine never makes it worse**: when its solve can't clear
  the pose it keeps the clearest turn it passed (at least the curve's), not
  its last step (a shield on `greatSword` flipped to 9 cm in the torso). On the
  keyframe rig (`holdJoints(…, rig)`, before the off hand reaches the
  support) it measures the weapon within 12 cm of the grip unturned, so the
  lift follows the pose without jumping when the turn flips. A keyframe
  motion can still bring the fist in between two frames (a bow, a hard
  landing: up to 0.64 rad in one frame), so the evaluator eases the rig lift
  (`easedRigLift`): it looks at the holder's own marks on the 24 fps grid
  0.25 s either side (state(t) is pure, so it may look ahead; those states
  are kept per evaluator, the floor line of a posed move skipped) and takes
  the largest lift there, weighted by a cosine of its distance, never less
  than the frame's own lift the same way, so it eases in before the dip and
  out after it and every frame stays as clear as before.
- **Crouch, crouched walk, sit, lie: the loop's own arms hold the weapon.**
  The standing hold pose added to those loops put the fist in the body (a
  rifle's stock in the belly sitting, the shield on the face lying) and no
  one arm move clears a whole loop under it. So `applyHolds` leaves a bot on
  those gaits without the hold pose; the renderer plays the loop as is
  (`mocap/scene.ts` adds the clip's arm lift at the loop's clip time) and
  turns the weapon on the loop's curve (`hold.ts` via `BotHold.loop`) — the
  same rule as any mark clip, which the clip sweep covers. Per pose: crouch
  idle, crouched walk and the floor / chair sit hold it in the resting hand,
  turned off the thighs and belly; lying, the shield turns off the face to
  the side of the body (still in the hand).
- **A shield faces out**: turned about the forearm so its face points away
  from the spine (hips to neck) before any other turn; it sat across the
  face and chest in every guard.
- **On the move a long weapon rides on the shoulder** (`TRAVEL_CARRY`, per
  weapon, blended in by speed to 1 m/s by `travelCarry`): a stride lifted the
  thigh into the fists of the idle hold, and the first carry (the arm raised
  forward) pointed a bat or a katana straight ahead like a lance. A bat or a
  katana now rests back on the shoulder, both fists at the chest (shoulder
  −1.1, elbow +2.0); a spear rides upright at the shoulder in one hand, its
  butt in front of the legs and ≥ 37 cm off the floor on a run (−1.4, +1.4);
  a staff the same (−1.1, +1.6); the long guns keep the carry across the
  body (−0.45, +0.6), the bow upright at the side. On walk, jog and run, both
  bots: bat, katana, spear and staff ≥ 0.7 cm clear of the holder; the worst
  of any long weapon 0.01 cm in (the bow).
- **The renderer's walk steadies both arms**: `mocapSteady` started each call
  from the unsteadied pose, so a two-handed weapon's own arm kept swinging
  with the walk clip under the hold pose (a bat in the head on a jog,
  9.8 cm). It now builds on the arm steadied before.
- **Solve time**: the rule's measure is exact but cheaper (flat arrays, no
  allocation per point, the plane that last separated a point tried first,
  normals only when another step follows); the on-pose refine above no
  longer restarts or wedge-searches (that was 70 % of the axe-shield solve).

## Tasks

1. **Measure** (`.maestro/held-weapons/`): probe every clip × weapon × bot ×
   mirror, the keyframe motions, the rendered gaits, the fight scripts; list
   every run deeper than 3 cm. → verify: the table covers the brief's cases
   (shield `fightIdle`, staff `heavySwing`, falls, `rifleAim` stock, walking
   bat) with numbers.
2. **Fix** with TDD (synthetic clips): the hold rule, kind by kind. →
   verify: probe shows no run deeper than 3 cm; fight sweeps (unarmed and
   weapon scripts, both orders, routines) still pass; legacy hash identical.
3. **Prove**: before / after sheets (front, 3/4) of the worst frames per
   weapon kind in `.maestro/held-weapons-visual/`, looked at; the real-library
   test extended (skipped without the library); full gate, smoke, fork e2e set
   via heavy.mjs; `MODIFICATIONS.md` entry; stage by path.
