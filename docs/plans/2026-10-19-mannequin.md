# Mannequin people (male and female)

Goal: two new people that look like the sculpted, joint-broken studio mannequins of game engines, so a blocked shot reads as human bodies to video models. Procedural three.js only, same rig as today's people, so every motion, gait, the shot solver and the fight solver work unchanged.

## My calls

- **Ids and names**: `person.mannequinMale` "Mannequin (male)" 1.80 m, `person.mannequinFemale` "Mannequin (female)" 1.70 m; prompt nouns "a man" / "a woman". No engine or product names anywhere.
- **Proportions**: same length formulas as the classic rig (legs 0.47 H, head, torso, limb splits). Two new `PersonDims` fields, `shoulderX` and `hipX` (joint offsets from the midline), replace the hard-coded `bodyW × 0.55` / `bodyW × 0.28` in FK and in `buildPerson`; classic people keep identical values. Male: broad shoulders, narrow hips; female: narrower shoulders, joints of the hips wider.
- **Mesh**: a new file `src/renderer/viewport/mannequin-mesh.ts` (three.js only) lofts elliptical / superelliptical cross-sections into smooth segments (torso with chest and waist, pelvis, tapered limbs, head with jaw and nose ridge, palm + thumb + grouped fingers, foot with heel), plus darker joint pieces (shoulder, elbow, hip, knee, kneecap). Female: narrower waist, wider hips, chest. No hair, no face details. ≤ 8k triangles each.
- **Rig**: `buildMannequin` in `builders.ts` builds the same named joint groups at the same `personDims` positions and reuses `animatePerson`; hand stays at `(0, −lowerArmLen, 0)` in `elbowL/R`.
- **Material**: light grey Lambert with `origColor`, so `setTint` (label colour, lerp 0.65) works as on today's people; joints a darker grey.
- **Fight Director**: a Bodies select (Classic / Mannequin) passes `assets` to `armFightPlacement` (the store already accepts it). The Choreographer's spawn stays classic (its performer assets live in the upstream engine); "Apply to selected" retargets mannequins.

## Tasks

1. `personDims` cases + `shoulderX`/`hipX` + catalog entries → verify: `skeleton.test.ts` (dims for both ids, catalog has both) red then green.
2. Mesh + `buildMannequin` + Library thumbs → verify: FK cross-check covers both ids at 1e-6; triangle count ≤ 8000; every mesh tint-aware; deterministic (two builds give identical geometry).
3. Fight Director body style → verify: typecheck + lint.
4. e2e `tests/e2e/mannequin.spec.ts` (list_assets, add_entity both, apply_motion jab-cross / front-kick, export_frame, Design-script fight on the two mannequins with every hit ≤ 3 cm) → verify: Playwright green.
5. Visual contact sheet `.maestro/mannequin-visual/sheet.png` (rest front/side/back, punch, kick, walk, fight impact, top-down) → verify: looked at, iterate until it reads as the mannequin and male ≠ female.
6. Docs (`MODIFICATIONS.md`, `AGENTS.md`) and the full gate + smoke → verify: `Test Files` line, smoke passed.
