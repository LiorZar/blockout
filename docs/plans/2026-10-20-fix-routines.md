# fix-routines: Choreographer Duration works; routines stay out of buildings

Lane `fix-routines`, round 4 (2026-10-20). Bugs: BACKLOG "The Choreographer's Duration field is ignored" and "Choreographer chase and dance routines ignore the set" (qa-export B8, B9).

## Goal

- The Choreographer's Duration (and MCP `durationS`) is the routine's length. A shot shorter than that grows to it in the same undoable step; a longer shot is never shortened.
- Chases run through open space (streets, open floor) and around props and buildings; dances stand on open floor. The set's footprints are data (read off the built geometry like the fight props). The chase direction comes from the set. A set with no room for the duration says so.

## My calls

- **Duration:** `spawnChoreography` and `choreographEntities` use `spec.durationS`; when the shot is shorter, the shot's duration becomes `durationS` inside the routine's own mutate, and the shot's fights are re-solved for it (`refightShot`, as `growShot` does). A two-person fight still goes through the Fight Director with a `durationS` script; the solver's shot-fit rule decides the shot length there.
- **Set data:** a new `routineSet(scene, take)` in `renderer/fight-obstacles.ts` returns the solid footprints (like `fightObstacles`, but curbs under 0.3 m and see-through light volumes such as the nightclub's cones don't block) and the set floors (kit meshes under 0.3 m: ground, asphalt, sidewalks). `fightObstacles` is unchanged.
- **Chase route** (new pure `engine/routine-set.ts`): the runner still starts where you click. From there the route takes straight open runs (a body keeps 0.5 m from every prop and stays on the set floor when the click is on it), choosing the longest run first, so on a street it runs along the street. It may turn up to 100° at a corner and keeps 3 m from its own earlier stretch, so in a room it runs a lap instead of doubling back. The upstream serpentine weave rides on top, tapered at the corners and cut back wherever it would leave the clear space. The heading you clicked with (or MCP `headingDeg`) only breaks ties between runs of about equal length.
- **Short of room:** when no route is long enough for the duration, the chase runs the route it found, slower, and warns with the numbers (UI toast; MCP `warnings`).
- **Dance placement:** the dance keeps facing the camera / `headingDeg` (the audience). If a formation slot or a formation-change walk would come within 0.6 m of a prop or leave the floor, the whole routine shifts (up to 6 m) and turns (up to 180°) to the nearest spot where everything fits, cheapest shift first; if nothing fits, it stays where it was clicked and warns.
- **No set:** with no props and no floors, routines are exactly as before (the upstream choreography tests are untouched and keep passing).
- One-vs-many fights (3+ fighters) are out of scope; they still ignore the set.

## Tasks

1. **Duration** (`store.ts` `spawnChoreography` / `choreographEntities`, `handler.ts` result, `tools.json`).
   Test `tests/unit/routine-duration.test.ts`: Duration 8 on a 5 s shot → marks reach 8 s, shot 8 s, one undo restores 5 s; Duration 4 on a 10 s shot → shot stays 10 s.
   Check: `npx vitest run tests/unit/routine-duration.test.ts`.
2. **Routes and placement** (`engine/routine-set.ts`, chase hook in `choreography.ts`, `routineSet` in `fight-obstacles.ts`, store wiring, warnings in the toast and the MCP result).
   Tests `tests/unit/routine-set.test.ts` (engine, synthetic boxes: a corridor route, a room lap, a tie broken by the heading, determinism, a too-small room warns, dance shift) and `tests/unit/routine-set-store.test.ts` (downtown + nightclub kits through the store, seeds 1–6: every performer's evaluated position at 30 Hz keeps `BODY_RADIUS` from every footprint and stays on the floor; a set with no room warns).
   Check: both files green.
3. **Gate and proof:** full gate, smoke (engine touched), e2e `interaction.spec.ts` + `placement.spec.ts`; before / after top-downs of the UI foot chase (downtown) and dance (nightclub) in `.maestro/fix-routines-visual/` (before: the frozen `.maestro/qa-app`; after: this build).
