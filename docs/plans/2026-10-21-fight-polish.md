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
- **Routines** (below, once measured).

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
