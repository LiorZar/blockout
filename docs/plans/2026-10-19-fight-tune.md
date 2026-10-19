# Fight tune: hit power and shouldered rifle aim

Brief: `.maestro/handoffs/worker-fight-tune.md`. Lior: "Punches rock, weapons harder" and "Add shouldered aim".

## Goal

1. Blows land with the outcomes in the brief's table at exaggeration 1.5, same-size fighters (jab absorbs with a head snap; power punches and front/side kicks stagger; roundhouse and spinning back kick knock down; blades at least stagger; bat/axe/staff knock down; a guard takes the edge off; a big fighter shrugs off a child). Punch-in coverage then pushes in on the Design script's hooks and kicks.
2. A shouldered rifle aim (`rifle-aim-fire`) that rifle and shotgun gun beats play; pistols keep `pistol-aim-fire`.

## My calls

- **Strike speed = a nominal peak speed per blow**, not the keyframe average. `STRIKE_SPEED` in `fight/moves.ts` gives each strike's impacts a speed in m/s (jab 5.5, cross 9, hook 10, haymaker 11, front/side kick 8, roundhouse 12, spinning back kick 13, slash 9, thrust 8, ...); unknown moves fall back per effector (hand 8, elbow 7, foot 10, knee 7). A test keeps the table in step with the detected impacts.
- **Effective mass scales with the attacker's body** (`(H/1.78)² · build`, the same law as the defender's mass), so a child hits a big fighter softly. Gun shots keep the bullet rule and ignore the shooter.
- **Weapons add heft**: the weapon's mass (new `WeaponSpec.mass`) joins the hand's, the off hand adds half a hand on a two-hander, and a swing's speed grows with the weapon's reach: `× (arm + reach) / arm`. Thrusts (`sword-thrust`, `knife-lunge`) get no leverage. Guns in a shot beat get none of this.
- **A guard takes half** (`DEFENDED` 0.35 → 0.5): still clearly weaker (a knockdown becomes a stagger, a stagger an absorb), and a parried kick still drives the defender back a step, so punch-in fires on the Design script's parried front kick.
- `grapple-shove` and `takedown-lunge` join the 20 kg whole-body moves (they were 2 m/s hand blows, i.e. nothing).
- **Shouldered long guns keep the stock on the shoulder**: `WeaponSpec.stock` (rifle, shotgun) and the shoulder mount turns the barrel so the stock, not the grip line, points at the shoulder; the gun stays upright (world up leads, the thumb only breaks ties). Without the stock rule the butt sits 7 cm above the shoulder for any arm pose.
- **Both long guns' stocks rise 12° above the grip's barrel line** (shotgun stock point at the upper middle of its butt plate), so one aim pose levels both guns.
- **Support grips moved back along the fore-end / pump** (rifle z −0.24 → −0.17, shotgun −0.24 → −0.18, both still on the part): from the old point the support arm only reached with a 27° torso twist that folded the firing elbow across the chest.
- **The aim pose is one set of joints** (bladed torso, elbow tucked, head down on the stock) chosen so the barrel is level on both body proportions (classic people and mannequins; ±2.1°), the butt is within 4.5 cm of the shoulder and the support hand reaches the fore-end.
- **The gun picks the aim**: any gun beat (`shoot`, `fire`, either aim id) plays `rifle-aim-fire` for a shoulder-mounted gun and `pistol-aim-fire` otherwise, mirrored onto a left-hand gun. `list_fight_moves` lists both with the guns that use them.
- Reports to crd per job (the brief), the full gate once per job.

## Tasks

Job 1 (hit power)
1. `fight/physics.ts`: attacker scaling, weapon heft, `DEFENDED` 0.5, body moves; `WeaponSpec.mass` in `weapons.ts`. → verify: new `tests/unit/fight-tune.test.ts` outcome table green; `fight-physics.test.ts` updated.
2. `fight/moves.ts`: `STRIKE_SPEED` + fallback. → verify: table/impact sync test; `fight-moves.test.ts` speed range updated.
3. `fight/solve.ts`: pass attacker and weapon heft to `impact`. → verify: armed fights through `solveFight` give the weapon outcomes, contact ≤ 3 cm; the Design script's punch-in pushes in on the hook, the front kick and the roundhouse.
4. Visual: Design script with punch-in, and sword vs bat, contact sheets at impact + 0.3 s in `.maestro/fight-tune-visual/`. → verify: look at the sheets.
5. Full gate. Report Job 1 to crd.

Job 2 (rifle aim)
6. `weapons.ts`: `stock` + upright shoulder mount. → verify: butt on the shoulder line; `weapons-render.test.ts` (rendered = engine) green.
7. `src/engine/motions-fork.ts` with `rifle-aim-fire`, joined onto `MOTION_PRESETS` by a one-line hook in `motions.ts`. → verify: new `tests/unit/rifle-aim.test.ts`: barrel ≤ 3°, butt ≤ 6 cm, support IK ≤ 1 cm, rifle and shotgun, both hands, man and both mannequins; every motion-enumerating test green.
8. Gun beats: aim move per gun, mirrored for the left hand, `list_fight_moves` guns (`moves.ts`, `solve.ts`, `handler.ts`, `mcp/tools.json`). → verify: a rifle gun beat's barrel line passes within 3 cm of the target through `ShotEvaluator`; a pistol beat keeps `pistol-aim-fire`.
9. Visual `rifle.png` (rifle and shotgun, side and front, plus a rifle gun beat). Full gate, smoke, e2e `fight-camera` / `weapons` / `mannequin`; `MODIFICATIONS.md`, BACKLOG. Report Job 2 to crd.
