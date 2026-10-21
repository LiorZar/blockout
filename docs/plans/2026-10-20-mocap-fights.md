# Mocap fights (phase 3 of docs/plans/2026-10-20-mocap-bots.md)

Lane `mocap-fights`. Goal: on loaded mocap bots the Fight Director plays the
library's fight clips (strikes, blocks, dodges, reactions, falls, the fight
idle) and the blows still land on the exact frame. Procedural people and the
studio mannequins fight exactly as today. Nothing from the library enters git
or `tests/`: unit tests build synthetic clips on the fixture skeleton.

## My calls

- **Bones, not frames, for a bot's contact points.** On a clip the wrist and
  ankle bend, so the rig-rigid hand and toe sit 1–12 cm off the rendered
  ones (measured on the real kicks). Bot poses get `wristL/R` and `ankleL/R`
  frames on the Hand / Foot bones: the hand effector is the palm on the hand
  bone, the toe the ToeBase joint, the held weapon rides the hand bone (a
  `grip` marker in the renderer), and the hand and foot capsules ride them.
  On keyframe poses those bones are rigid with the forearm and shin, so
  nothing changes there.
- **Move → clips** live in a fork table (`fight/clip-moves.ts`), never in the
  move data. A move is one clip per impact (a combo chains clips: jab-cross =
  jab then cross, crossfaded); the clip is picked by target (jab / hook to
  the body, low kick to the legs) and weapon (sword one-handed → sword and
  shield slash, katana → great sword, bat / axe / staff → heavy swing, knife →
  stab, guns → rifle / pistol aim and fire). The clips play as captured
  (orthodox, left lead), so a bot's jab is its left hand: the report carries
  each impact's effector.
- **Impact frame = peak extension** of the striking effector toward the front
  (its furthest point along the clip's facing, root travel removed), first
  frame of a plateau; a weapon's by its strike point (blade, club end, point),
  a gun's by its aim (a fixed point in the aim loop, then the fire clip).
- **Timing.** Each clip plays from its start (or ≤ 0.5 s before its impact)
  to 0.45 s past the impact inside a combo, ≤ 0.9 s past it at the end of a
  beat; the beat's warp snaps each impact onto the frame grid (clip time runs
  piecewise-linearly between marks, bent only at impacts).
- **Skin to skin** (found on the first rendered sheet): with the palm on the
  target surface, a bot's fist sank 4–7 cm into the face. A bot strikes
  skin to skin instead (`mocap/surface.ts`). Rigid per-bone support points
  were 3–4 cm off the rendered skin at bent joints (fist, knee, pointed
  foot), so the renderer registers each vertex's four skin influences and
  normal and the engine skins them as three does (0.1 mm on the fixture):
  the striking part (a fighter's hand as the fist the renderer shows) moves
  along the strike until it just touches the target's skin near the blow
  (the head, the torso and thighs, the lead leg, the guard), measured to the
  closest point on the skin's triangles (vertex normals misread a knee in a
  thigh by 3 cm; the solve's last passes and the report use the triangles). A hand or
  forearm a landed blow would meet first swings just clear (shoulder X,
  ≤ 1.2 rad) and back over 0.4 s. A bot's knee aims at the belly (0.4 of the
  torso), clear of the thighs; in the defender's stance the lead thigh lies
  across the front, and the knee clip's hanging shin came up through it
  (4.7 cm at the impact, 7.4 cm just before), so a striking knee tucks its
  heel on each clip key just enough that its shin and foot stay out of the
  defender's legs. Procedural bodies keep the palm.
- **Solve time.** Measuring against the whole skin made the first bot solves
  4–39 s a fight. The target mesh is cached per pose and searched
  vertex-first (a coarse pass, then the skin around its closest points), a
  bot's pitch solve refines its root by regula falsi, and the floor
  grounding skips bones that can't be lowest.
- **Overlay.** The existing reach solve (shoulder / hip pitch, abduction,
  weapon elbow, torso lean ≤ 20°) runs on the clip pose; it sits on the
  impact mark only and ramps from zero 0.2 s before to zero 0.25 s after.
- **Reactions by target and the side the blow lands on** (crd ruling: the
  head always goes away from the blow): the side comes from where the
  striking point comes in 0.1 s before the impact (a straight blow by its
  hand: a left lands on the defender's right). Head — an uppercut takes
  `hitUppercut`, a staggering blow `hitHeadBig`, else `hitHeadLeft` (lands
  on the right) / `hitHeadRight`; body — lateral blows (hooks, roundhouse,
  haymaker, elbow) `hitSide` (captured from the left, mirrored for the
  right), shoves and tackles `shoveReact`, the rest `hitStomach`; legs —
  `hitSide`. Blocks and parries play `blockHead` (it leans away from a blow
  on the right; mirrored for the left) / `blockBody` (a shield
  `swordBlocked`), slips and ducks `dodge` (slips away from a blow on the
  left; mirrored for the right), each timed so its guard frame is on the
  impact; the blocking arm still reaches as an overlay. The
  mocap carries the head snap, so the procedural snap is off on clips; the
  guarded rock-back stays (physics).
- **Knockback root.** Staggers, knockdowns and KOs keep the physics' travel,
  prop stops and timing; the clip gives the shape (its own root travel
  profile) and the fall frame. KO falls back (`koBack`) unless the push is
  toward the defender's front (`koStomach`); a knockdown that isn't the last
  beat gets up with `getUpKnockdown`.
- **Fight idle** (`fightIdle`, on shot time) fills the time between beats;
  fighters holding a gun idle on `rifleIdle` / `pistolIdle`.
- **Bot fight marks are posed moves** (`posedMove` + `lockFacing`), so clip
  root travel and the floor line come from the evaluator; the solver writes
  them only for loaded bots.
- **Fallback.** A move with no clip (spinning backfist, sweep, teep, tackle,
  takedown, grapples, spinning back kick, sword thrust, unarmed slashes, the
  bow) plays its retargeted keyframes, crossfaded from and back to the idle.
- **Routines and sequences**: a bot's strikes play their clips laid so each
  impact lands on the keyframe move's impact time, blocks so their guard
  frame lands on the keyframe block's ready time; the routine's exchanges
  keep their timing.

## Tasks

1. Strike data: bot wrist/ankle frames + bone effectors; `fight/clip-moves.ts`
   (table, impact detection, reaction / defense picks).
   → verify: synthetic-clip tests (impact = peak extension, weapon point,
   picks); bot keyframe poses unchanged (effectors, frames ≤ 1e-9).
2. Solve: clip states through the solver; strike plans, defender clip events,
   knockback roots, idle; marks carry `clip` / `posedMove`; report effectors.
   → verify: synthetic tests (impact on target ≤ 1 mm, overlay zero at the
   ramp ends, reaction pick); procedural / mannequin solutions hash-equal to
   HEAD's.
3. Fallback and weapons: keyframe moves crossfaded; weapon and gun clips; the
   held weapon on the hand bone (engine and renderer).
   → verify: synthetic fallback crossfade test; weapon contact ≤ 1.5 cm.
   crd2: the store keeps fight solutions by their inputs (get_fight and the
   Fight Director's report read them back), a bot stage / re-solve toasts
   and paints before it solves; two load-sensitive fork tests get 15 s.
   → verify: store test (no solve on a read, one on an edit), e2e (the
   notice paints before the solve, get_fight < 250 ms).
4. Routines and sequences give bots the strike and block clips.
   → verify: unit test (impact / ready aligned to the keyframe times).
   crd2: a routine that stages a bot fight toasts and paints first (the
   store's callers defer; MCP awaits, then stages at once).
   → verify: store test (the notice, the fight a frame later; people at
   once, no notice).
   T4b (crd2): routine falls (by fall direction, floor contact on the
   keyframe landing), get-ups (matching the fall, standing at the keyframe
   end) and the guard bounce (fight idle on shot time) play clips; only
   moves with no clip keep keyframes; a fight sequence casts its chosen
   bodies, with the busy state.
   → verify: routines test (landing, get-up end, idle time, push-back,
   staying down); store test (two bots, the notice first).
5. Real library (skipped without it): the 7 qa-fight scripts and the weapon
   scripts, Y Bot vs X Bot both ways: contact ≤ 1.5 cm on the impact frame
   (report and evaluator), interpenetration ≤ 3 cm, planted feet ±2 cm; the
   rendered rig read in the app (Playwright driver); before / after sheets in
   `.maestro/mocap-fights-visual/`; double export byte-identical
   (`mocap-bots.spec.ts`); full gate, smoke, fork e2e.

## T5 calls (real-library verification)

- **Bodies apart, measured as rendered.** The check skins both bots with
  the fists the renderer shows (the bare-hand skin read fingers through
  guards that never render). Two bodies' depth in each other: where a
  bone's box (by its support points) meets one of the other body's, each
  body's skin there against the other's skin on those bones and their
  neighbours (`bodyOverlap`).
- **crd2's fixes, in order.** (1) The guard: the striking limb (shoulder
  to fist, hip to toe) is checked against the defender's whole arm on every
  frame of the last 0.25 s before the blow (clip and keyframe strikes), and
  the arm opens from 0.25 s before, all the way by 0.08 s before; a leg the
  striking limb comes through swings out (hip abduction ≤ 10°), except on a
  blow to the legs. (2) After each blow the defender is pushed back by the
  least that clears the frames that overlap (a bisection on the push, ≤
  15 cm, none when pushing doesn't help; when the defender alone can't get
  clear, a kick stepping through or a tackle, the attacker's own travel
  after the blow is held back as far); between two blows the push eases
  out again 0.1 s before the next, so it lands where it was placed. (3) A
  leg of the attacker that meets the defender's legs splays (hip abduction
  ≤ 10°, the least that clears) on each strike key, and at the impact the
  strike is placed with it. (4) What is left (the approach's last 0.125 s
  still more than 2.2 cm deep) is tried swung 15° / 30° either way about
  the target (then 8° / 22° while it is still over 2.5 cm), kept only if
  the blow's skin contact is as good as straight on (or within 5 mm); the
  report names each beat that needed it, and the guard opens again for
  the new way in (the finer ones only beside the best coarse one).
- **A block is met by the arm, at the guard.** A blocked or parried
  blow's skin contact counts its whole striking limb against the guard, so
  the arm stops where it first meets the guard (a hook's forearm used to
  pass through it the frame before the fist touched). Tried and dropped:
  counting the head beside the guard as the block's surface (the fist then
  stopped on the head, 1.6–8.8 cm off the guard: it read as a hit), and the
  neck bending the head away (≤ 30° never cleared the spinning backfist).
- **A guard reaches across for a blow that sweeps past it** (crd2's leads
  for the spinning backfist, punches fm b5, 3.17 cm in the head on the
  impact frame: blockHead leans the head 52 cm aside with both hands
  beside it, and the backfist comes in from the far side). (a) The other
  guard hand alone: worse, 5.8 cm. (b) The guard arm reaching across
  (shoulder adduction): 0.2 rad → 2.5 cm, 0.3 → 1.35, 0.45 → 0.05 cm
  (with the orbit). (c) The block clip mirrored alone: 3.3 cm; (a) and (c)
  together cleared it too (0.45 cm), but (b) came first and is the smaller
  change. So a bare guard a blocked blow still sinks past reaches across
  by 0.45 rad before the orbit search, kept only if that helps by 5 mm
  (punches fm b5: kept; punches mf b5 and the combos parry tried it and
  kept straight on).
- **Speed, cheap wins only** (crd2: no worker). Bit-identical on all 14
  scripts × both orders (a hash of tracks and report): the guard-check and
  push-back searches stop at their first failing frame (the last to fail,
  or the deepest, tried first); a bot's unarmed contact points are cached
  by pose; a block's aim and guard arm and a lean's upright pitch start
  from the last pass's answer. The orbit search tries the finer angles only
  beside the best coarse one, and stops after the coarse ones when they
  are under the bar even if the last couldn't land (it used to run the
  fine ones then; no result changed). Not done: caching the approach's
  defender poses (it profiles under 0.3 s a script) and a box test before
  skinning the defender's arm (tried: the guard is near the blow on almost
  every check, so it saved nothing). crd2's "skip the orbit for a block
  overlapping only on its impact frame" no longer applies: every blocked
  blow's approach peaks a frame before its impact.
- **Before the first clip the defender is crossfading** from its idle (5b's
  lead-in), and the solver's defender timeline now says so, so the guard
  and orbit checks see the pose the evaluator plays.
- **Waiting fighters hold their idle.** A bot done well before the other
  (the attacker while the defender gets up) crossfades into its idle where
  it stands and holds it; the other comes to guard distance of it (it used
  to morph out of its last pose over the whole wait, sinking up to 10 cm).
  A keyframe move crossfades from the idle into its first pose before its
  step-in, and an idle reached by a walk is posed half a frame on, so the
  move after it crossfades on the floor line.
- **Speed.** A bot's pitch solve starts from the last pass's answer
  (secant), a later lean pass looks near the last lean, the sign test
  visits only each shell of the vertex grid, a bone set's triangles are
  cached, and the bodies are compared bone box by bone box.
