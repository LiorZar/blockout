# Fight polish (bot fights after phase 3 T5)

Lane `fight-polish`. Goal: on the mocap bots (Y Bot / X Bot on the real
library), every blocked or parried blow reads as a block on the sheet
cameras, a held weapon stays out of the bodies, and the Choreographer's
one-vs-many routines meet the fight bars. Procedural people and studio
mannequins fight exactly as before (`mocap-fights-legacy` hash-identical).

Bars (crd2, T5 and this brief): contact ≤ 1.5 cm on the guard; bodies ≤ 3 cm
in each other on every frame, a transient ≤ 5 cm for ≤ 2 frames outside an
impact ±0.1 s passes when listed; feet ±2 cm; solve time reported before and
after per script with the CPU load.

## My calls

- **A blocked head blow meets a high guard.** The library's head block
  (`blockHead`, "Right Block") meets the blow 52 cm aside of upright, the
  head ducked low with both hands above and behind it, so the fist lands
  beside the face. An unarmed bot blocks or parries a head blow with the
  shell instead: `blockBody`'s guard frame, both forearms up in front of the
  face (hands at head height, 17–23 cm in front of it, elbows 20–30 cm in
  front), rocking back behind them after the blow; mirrored so its outer hand
  sits on the side the blow comes from. Body blocks keep `blockBody` as now.
- **"Reads as a block", measured.** At a blocked or parried blow's impact
  frame the striking part is on the guard (≤ 1.5 cm) and at least 5 cm clear
  of the defender's head and torso (the guard's forearm between them); for a
  weapon, its blade or shaft is likewise clear of the defender's body. The
  sweep prints it per block; the sheets are looked at, front and 3/4.
- **Weapons as the solver models them.** Each held weapon is a few capsules
  (blade, haft, cross guard, axe head) and the shield a disc, in the
  builders' model frame (a test pins them to the built meshes' bounds). A
  weapon's depth in a body is its axis points' skin depth plus the radius,
  against the same skin meshes the body checks use. Its own holder's body
  counts too, without the arm or arms holding it.
- **Weapon bar.** A weapon stays out of every body by ≤ 3 cm on every frame
  (the same transient rule), except the striking weapon against the
  defender on a hit's or KO's impact frame (the contact solve owns that
  frame). A block or parry is the weapons meeting: the attacking weapon at
  least 5 cm clear of the defender's body on the impact frame.
- **Weapons in the solver's body checks.** `bodyOverlap` adds each fighter's
  weapon against the other body, so the orbit search, the post-blow push
  (`separate`) and the guard opening see a blade or shaft as they see a fist.
  Bots only: the procedural and mannequin paths never call them.
- **An armed block meets the weapon in front.** A bot holding a blade,
  club, shaft or shield blocks or parries on its idle with the guard arm
  raised by a small solve (shoulder pitch and abduction, elbow): the
  weapon's guard point (mid-blade, the shield's face) goes to the blow's
  height in front of the struck zone, far enough out that the attacking
  weapon's tip past its strike point stays out of the face, the blade or
  shaft lying across the line of attack and a shield facing the attacker.
  The library's head block ducks the head into the blow and its body block
  raises the hands to the face, so a held weapon went through its own head.
- **The armed guard keeps clear of its holder and meets the blow 30 cm out.**
  The guard point sits 30 cm in front of the struck zone (20 cm let the
  attacking bat or axe pass within 2–4 cm of the defender's free arm). The
  guard arm's solve keeps its weapon 1.5 cm off its own body at the guard and
  a quarter, half and three quarters of the way in (the overlay blends in
  linearly; a straight blend swept a sword 4–5 cm through its own torso),
  part by part no deeper than the idle already holds it (the library idle
  holds a shield 2–5 cm in its holder: not ours). The free arm (a one-handed
  weapon) swings out of the attacking weapon's way, 5 cm clear.
- **A weapon in the other body after a blow swings out; a push can't move it.**
  A spear riding its holder's fall into the attacker lies along the line
  between them, so pushing the defender away only slides it along itself.
  Its arm swings instead (pitch, else abduction, the least that clears every
  frame, no deeper into its holder), eased in and out like the push; the
  push then sees the bodies alone.
- **Armed bots rest apart by their weapon's reach.** Resting between beats
  at guard distance (1.1 m), a spear held out in the idle, or swept up from
  its walking carry into the idle as the holder arrives, went 5–10 cm into
  the other. The rest gap is the weapon's reach plus the other's lead leg
  plus 5 cm; the walk is then laid, looked at frame by frame, and laid again
  further apart by as much as a weapon went in (at most 3 more times).
- **A guard arm swung open keeps its weapon out of its holder.** A defender's
  arm in the way of a fist swings out with the weapon in it: the swing must
  clear the weapon too, and not put it deeper into its holder over the
  approach or while the opening eases off after the impact; when no pitch
  does that it swings out sideways, else stays.
- **Solve time back down (crd2: each weapon script ≤ 2× its pre-lane time or
  ≤ 2 s).** The weapon checks cost katana-spear 0.6 → 3.2 s and axe-shield
  0.9 → 5.5 s. A blow's placement asks for its armed guard eight times per
  pass as the attacker settles: a guard point within 5 mm (and the line of
  attack within 1.8°) of one already solved for that aim pose reuses it, and
  the holder's body parts are built once per aim pose. A weapon whose axis
  points all stay further than their radius (plus the bone pad) from a body's
  bone boxes is out of it without a skin test, and a skin is built only from
  the bones it comes near and their neighbours. The swing and guard searches
  check the frame that failed last first, and of a swing's two checks (out of
  the other body, no deeper in its own) the one that failed last. The guard memo moves a guard point by up
  to 5 mm: the sweeps' blocks and episodes stay within 0.3 cm of before, the
  same swings and guards picked.
- **Clip-and-hold mismatches are listed, not fixed** (crd2): a shield in
  `fightIdle`, a long gun's stock on `rifleAim`, a staff on `heavySwing`,
  weapons in falls, get-ups and `hitHeadBig`, and a club in the procedural
  walking hold (a bot walking between clips plays keys).
- **Routines: a bot strikes from where the keyframe move strikes.** The
  routine stands an attacker at fighting range (1.2 m) and its strike clip
  then carries it on into the hero (the brief's cause). A strike's first clip
  run starts back by the clip's own root travel to its impact, so at the
  impact the root is where the routine put it, and the plain step-in mark
  before it moves back with it (no slide back before the blow).
- **Routines: a keyframe-only lunge stops short of its target.** The tackle
  has no clip, and its keyframes lunge 1.5 m, straight through a hero who
  dodges in place (the dodge clip barely moves; the keyframe dodge doesn't
  move the root either). A routine strike's play carries its target distance
  (`reach`); on a bot a keyframe strike's marks stay 0.75 m short of it.
  Procedural routines are unchanged (the tag is all they get).
- **The routine sweep builds as the app does.** The probe passed bodies that
  didn't match the routine's casting (male / female alternate per attacker),
  so p1–p3 were grounded and clip-scaled with the other body: brawl's 14
  feet misses (±2.0–2.2 cm) were that, and are 0 built as spawnChoreography
  builds it (no `ctx.bodies`). Baseline re-measured the same way.

## Tasks

1. Blocks read as blocks (unarmed): the shell for head blocks and parries;
   the block measure in the sweep. → verify: punches b5 and combos b3 both
   orders: guard ≤ 1.5 cm, head and torso ≥ 5 cm clear, overlap episodes 0;
   real-library unit test green; sheets front + 3/4 looked at.
2. Weapons vs bodies: weapon shapes, the sweep measure, the solver's checks;
   then fix what fails, weapon blocks and parries included. → verify:
   sweep both orders, 0 failing episodes with weapons; every weapon block
   and parry's weapon ≥ 5 cm clear of the body; sheets.
3. Routines: sparring and brawl to the script bars, feet ±2 cm,
   martial-arts clean. → verify: routines sweep 0 failing episodes, feet 0.
4. Gate, smoke, fork e2e set (mcp-gaps, fight-camera, mannequin, weapons,
   mocap-bots, export-flush); solve times before / after with the load;
   before / after sheets for every changed solve; stage by path.
