# fix-fight-geom: fighters touch the floor, blows land on the body surface, misses miss

Lane `fix-fight-geom`, round 3. Bugs 2, 3, 4, 5, 8, 9 of `.maestro/qa-fight/REPORT.md`, all in the fight solver (`src/engine/fight/solve.ts`).

## Goal

Every fight mark keeps the body on the floor (lowest point ≥ −2 cm, ≤ 3 cm unless a kick lift is reported); body blows land on the body surface (±1.5 cm) of classic people and mannequins; body kicks land on the midsection; body / legs misses clear the body by ≥ 10 cm; a shorter attacker reaches a taller head where it can.

## My calls

- **One floor model.** The solver uses `floor.ts` (fix-gaits' body proxy, checked against the rendered meshes) for the lowest point of a posed fighter. Every fight mark's root height puts that point on the floor, plus the reported kick lift. Authored `move.up` drops in fight motions (knockdown, KO, get-up) are replaced by the floor rule; no fight motion has a positive `up`.
- **Between marks.** Where the interpolated pose between two marks would float or sink more than 1 cm, the solver inserts a grounded mark (`fight/ground.ts`), within the 400-mark cap.
- **Body surface.** A body blow's contact point is where the horizontal line from the torso axis toward the attacker leaves the body: the classic torso capsule (radius 0.5·bodyW), or the mannequins' sculpted torso sections (`fight/contact.ts`, the tables copied from `mannequin-mesh.ts`; a unit test checks them against the built mesh). This applies to fists, elbows, knees, feet and weapons.
- **Body kicks aim at the midsection** (0.3·torsoLen up the torso, between the belt and the lower ribs) instead of the chest; punches and elbows stay at the chest, knees at the lower torso. Head kicks keep their lift (Lior's ruling).
- **Body / legs misses fall short.** A miss, slip or duck on a body or legs target aims 15 cm in front of the body in the defender's actual pose at that frame, so the blow stops short. The clearance reported for those blows is the distance from the effector to the body (torso surface, legs, arms). Head slips and ducks are unchanged.
- **Reach.** A blow still more than 3 cm off retries with wider limb pitch (arms 1.0 → 1.8 rad, legs 0.9 → 1.5, abduction 0.6 → 1.0), which brings the attacker in closer; spacing rules still hold (0.35 m outside clinches). The "can't reach" warning stays when it still misses.

## Tasks

1. Floor contact (bugs 2, 3): `fight/ground.ts` + hooks in `solve.ts` (placement root height, defender pose height, every mark, get-up, rest) → verify: `tests/unit/fight-ground.test.ts` — every fight move (strikes, defenses, reactions, get-ups) on classic and mannequin pairs, per frame through `ShotEvaluator`: lowest point ≥ −2 cm, ≤ 3 cm unless a lift is reported; the qa-fight cases (get-up, low-sweep, tackle-lunge, takedown-lunge, duck, boxing-combo slip).
2. Body surface + midsection kicks (bugs 9, 4): `fight/contact.ts` + `fightTarget` → verify: `tests/unit/fight-contact.test.ts` — body hits (punch, elbow, knee, kick, weapon) on man, woman and both mannequins sit on the built mesh's torso surface within ±1.5 cm; body kicks land between the belt and the lower ribs; the woman's body side kick on the man lifts less than before (45 cm).
3. Body / legs misses (bug 5) → verify: `fight-contact.test.ts` — body / legs miss, slip, duck clear the body by ≥ 10 cm (measured from the evaluated rig), the report's clearance agrees.
4. Reach (bug 8) → verify: `fight-contact.test.ts` — elbow-strike woman → man and mannequins, side-kick man → woman's head, haymaker female → male mannequin: within 3 cm, or the warning stays and the error shrinks; `A sweep to head` still warns.
5. Gate, smoke, `fight-camera.spec.ts`; before / after `lift-sheet` and strikes sheet in `.maestro/fix-fight-geom-visual/`; `MODIFICATIONS.md` lines; report to crd.
