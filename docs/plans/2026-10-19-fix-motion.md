# fix-motion: fight motions that read wrong, rifle aim on every body, the bow (2026-10-19)

Lane `fix-motion`, round 3. Gaps 5, 7 and 10 of `.maestro/audit/GAPS.md`.

## Goal

Blows in a staged fight come after their wind-up, a two-handed slash keeps both hands on the grip, a shield faces the attacker when it blocks, a shouldered long gun aims level with the stock in the shoulder on all six bodies, and `A shoot …` with a bow looses an arrow along the arrow line.

## Measured before the fix (rig FK, reference man)

- `haymaker`: the detected impact is the wind-up keyframe (t 0.3): torsoY +0.8 brings the right shoulder forward, the "swing" (t 0.6) puts the hand 0.83 m to the right at the body plane. `elbow-strike`: the same inverted twist (load +0.5, snap −0.5). `hook-punch` and `jab-cross` follow the header.
- `sword-slash-combo`: hands 0.68–0.87 m apart; its twist is inverted too (ready +0.5, slash −0.6).
- Shield in L: `shield-brace` / `shield-block` already face within 8° of forward (both forearms vertical, so the weapon arm is vertical too). In fights a shield holder blocks with `block-high` / `block-low`: `block-low` turns the shield face to the floor (normal (0, −0.98, 0.22)), `block-high` 20° up, plus the solver's elbow fix tilts it further.
- `rifle-aim-fire` at the aim keyframe: elderly barrel −12.5° (man −2.2°); child support hand 5.3 cm (rifle) / 7.1 cm (shotgun) short and the stock 9.3 / 7.8 cm past the shoulder.

## My calls

- **Replacements keep the upstream move ids in fights.** `moves.ts` maps `haymaker`, `elbow-strike`, `sword-slash-combo` to fork motions (`fightMotion(id)`); scripts, random pools, saved fights, `STRIKE_SPEED`, `HOOK_MOVES` / `CLINCH_MOVES` and physics keep using the upstream ids, and the solver plays the fork keyframes (one lookup line in `solve.ts`). The fork motions are in the library under their own ids and are not listed twice in `list_fight_moves`. Same pattern as `rifle-aim-fire` behind `shoot`.
- **Twist fix = header signs**: the wind-up turns the striking shoulder back (torsoY < 0 for the right hand), the blow turns it forward. The sword slash gets the same fix.
- **Two-handed slash**: the left hand sits 8 cm below the right on the handle (left arm from IK on the reference man), right hand leads, so the blow is always the right hand's.
- **Shields**: fork `shield-block-face` / `shield-brace-face` replace the library motions (shield face toward the threat, centre at chest / head height, the other arm in a ready guard). In fights a shield holder blocks with them (low / high) instead of `block-low` / `block-high`, mirrored when the shield is in the right hand, and the blow lands on the shield.
- **Long guns on every body**: `holdJoints` retargets the gun arm of a shouldered gun to the reference man's hold: same barrel pitch, same grip-to-shoulder distance (shoulder X + elbow, two-channel Newton). Exactly zero on the man. The support hand slides back along the fore-end to the farthest point it can reach (at most halfway to the grip); `supportReach` reports the slide and any shortfall, and a gun beat's fight report warns about it.
- **Bow**: `shoot` / `fire` with a bow plays `bow-draw-loose`; the shot is the loose keyframe (the draw arm opens after full draw), fired from the bow hand (native L, mirrored for a right-hand bow), aimed along the arrow. A fighter with a gun and a bow shoots the gun.

## Tasks

1. Haymaker + elbow replacements, `fightMotion` → verify: `fight-moves.test.ts` — impact after the wind-up keyframe, striking hand in front of its shoulder at impact, upstream data unchanged.
2. Two-handed slash → verify: `fight-moves.test.ts` — hands ≤ 0.15 m apart at every keyframe on all six bodies, two right-hand impacts; `fight-weapons.test.ts` sword / axe / bat contacts ≤ 3 cm.
3. Shields → verify: `fight-weapons.test.ts` — library motions face within 10° of forward (both hands, six bodies); a shield block's face within 20° of the attacker at the impact frame through `ShotEvaluator`, contact ≤ 3 cm.
4. Rifle aim on six bodies → verify: `rifle-aim.test.ts` extended to man, woman, both mannequins, child, elderly (barrel ≤ 3°, stock ≤ 6 cm, support on the fore-end or reported).
5. Bow shot beat → verify: `fight-weapons.test.ts` — arrow line through the target ≤ 3 cm, shot on the loose keyframe, both hands.
6. Visual sheets in `.maestro/fix-motion-visual/` (haymaker / elbow impacts, two-handed sword, shield, rifle on six bodies, bow shot), full gate, smoke, `weapons.spec.ts` / `fight-camera.spec.ts`; `MODIFICATIONS.md`, `BACKLOG.md`.
7. qa-clara Bug 6: a shot echoes as `shoot` (`formatFightScript`), the beat label says `shoot`, and each beat report names the motion it played (`plays`) → verify: `fight-weapons.test.ts` — echo round-trips, `plays` is rifle / pistol / bow aim.
8. qa-clara Bug 9: `spinning-back-fist` is an alias of `spinning-backfist` (`DUPLICATE_MOVES`): one catalog entry, the old id parses, solves and plays the kept move → verify: `fight-moves.test.ts`.
9. qa-cast Bug 3: `apply_motion` mirrors a weapon motion when the performer's weapon for it is only in the other hand (`mirrorForHeld` / `mirrorForHolder` in `moves.ts`, a hook in the store's `applyMotionToEntities`) → verify: `weapon-motions.test.ts` — rifle / shotgun aim in either hand on six bodies, sword slash swings the armed arm.
10. qa-cast Bug 7: unheld weapons rest on the floor (`weaponRestLift`: one table lifts the spec points and the built geometry, `onFloor` in `weapon-builders.ts`, also on the upstream sword) → verify: `weapon-motions.test.ts` — lowest point 0 ± 2 mm for all 12; `weapons-render.test.ts` FK = renderer.
