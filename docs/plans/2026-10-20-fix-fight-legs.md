# fix-fight-legs: no floating rest steps; elbows reach a taller head

Lane `fix-fight-legs`, round 4. BACKLOG Bugs: fight rest steps / step-ins float, the elbow strike up to a taller head misses.

## Goal

The walk under a fighter's guard keeps the lowest foot on the floor (±2 cm) on every frame of rest steps and step-ins, on all six bodies; the elbow strike up to a taller head lands on the head surface (±1.5 cm) on man ← woman and the mannequins, or warns with the gap left.

## Before (probe, rendered meshes through `ShotEvaluator` + `animatePerson`)

- Walk / jog frames of the 7 qa-fight scripts: lowest point up to +4.8…+6.3 cm (man/woman, mannequins), elderly −9.6 / +9.8 cm (grapples).
- Elbow to head, B → A: man ← woman 7.1 cm, mannequinMale ← mannequinFemale 3.3 cm, man ← mannequinFemale 15.4 cm, mannequinMale ← woman 0.

## My calls

- **The gait rests where the stand pose would.** The evaluator (fight marks, motion keyframes: `groundY` / `motionRootY`, both `floor.ts`) sets a mark's root height so the stand pose plus its joints rests on the floor. `animatePerson` grounded the gait pose before the joint overrides were added, so the walk + guard pose floated by the guard's knee bend. Now, when overrides are present, the root is corrected after them by `floor.ts lowestY`: the gait-with-overrides pose rests where the stand-with-overrides pose rests (no change without overrides, none for stand). One rule, `floor.ts`, no second grounding model.
- **Arm blows lean the torso** in the reach retry when they still miss after the wider pitch: a torso lean (side bend and pitch, ≤ 20° combined, on top of the move's own torso) is searched together with the limb pitch, smallest lean that lands first. Kicks keep their lift (Lior's ruling) and don't lean. A blow that still can't reach keeps its warning with the gap.
- **The lean keeps the bodies apart.** The first lean found landed woman → man by standing her 13 cm from him, 16 cm inside his body. A lean is valid only if the attacker, placed for that pose, keeps its torso surface and head out of the defender's body (`contact.ts` `bodyClearance`), no deeper than upright. With that, a ≤ 20° lean can't bring the woman's elbow up to the classic man's head middle (it renders 0.14·s above catalog height, BACKLOG).
- **Elbows aim at the jaw.** An elbow to the head lands on the head's surface 35° below its middle (the jaw, still on the head surface; it aimed at the middle). This lands woman → man and the mannequins without any lean; the lean lands the cases the jaw aim leaves short (elderly → man).
- **Step-ins walk.** Fight step-ins (≤ 2.5 m/s) use the walk, not the jog: the jog's designed flight lifted both feet 2–3 cm, over the ±2 cm bar.
- The lean triggers when the arm blow is more than 1.5 cm off (the head-surface tolerance), not the 3 cm warning tolerance, so near-misses land too.

## Tasks

1. Rest steps (bug 1): `animatePerson` final-pose grounding → verify: `tests/unit/fight-legs.test.ts` — every walk / jog frame of the qa-fight scripts on man/woman, child/elderly, both mannequins: rendered lowest point within ±2 cm; `gait-floor`, `motion-floor`, `fight-*` green.
2. Elbow lean (bug 2): `solve.ts` reach retry → verify: `fight-legs.test.ts` — elbow to a taller head on man ← woman, mannequinMale ← mannequinFemale, mixed pairs: report error ≤ 1.5 cm and the rendered elbow on the head surface, or warned with the gap; lean ≤ 20°; head kicks' lift unchanged.
3. Gate, smoke, e2e `fight-camera.spec.ts` + `mannequin.spec.ts`; before / after sheets in `.maestro/fix-fight-legs-visual/`; `MODIFICATIONS.md`, BACKLOG; report to crd.
