# Set routines: routines that respect the set, and chase framing (lane `set-routines`)

Goal: the Choreographer's chase and dance stay on the set's walkable floor (BACKLOG
"routines ignore the set"), the chase follow cameras keep the other cast out of the
lens (BACKLOG "Chase follow-behind"), then, if time is left, the chase bots' blend
slides. Base `edf6dc0`. Every change in `MODIFICATIONS.md`; upstream files get a fork
helper and a small hook; upstream tests stay as they are.

## My calls

1. **The set as data** (`src/renderer/routine-set.ts`, new; read off the built kit
   geometry like `fight-obstacles.ts`, which stays untouched): *floors* (pieces whose
   top is under 0.35 m: ground planes, asphalt, kerbs, lawns), *solids* (pieces between
   0.35 m and 1.9 m: walls, buildings, shop glass, counters, props; overhead pieces and
   whatever the kit animates or marks editor-only don't count), *streets* (flat strips
   ≥ 12 m long, ≥ 3 m wide, ≥ 2.5 : 1, e.g. asphalt, an alley's ground). Static non-kit
   props count as solids; people, animals, weapons and anything moving in the take don't.
2. **Pure routes** (`src/engine/routine-set.ts`, new): a clearance field on a 0.25 m
   grid (distance to the nearest solid and to the floor's edge). A performer's root keeps
   0.6 m (hips, arm swing, weave). No floors and no solids = no set: routines are exactly
   as before.
3. **Chase route**: the first run lies along the street nearest the click (within 8 m,
   on its centre line), else along the longest clear straight run through the click
   (the routine's own travel direction breaks ties). Its sense is the routine's travel
   direction. The runner starts at the click when the room ahead holds the run; else the
   whole route slides back along the run until it fits (the pursuers' lead-in behind it
   too). When the straight run can't hold the chase at a running pace (mean ≥ 3 m/s),
   the route turns at the end of the run (greedy straight runs, ≤ 100° a corner, the
   longest next run first, ≥ 3 m from its own earlier stretches: a lap, never back
   through itself). Corners are rounded inside the clear space; upstream's weave rides on
   top, cut back wherever it would leave the clear space. The pace fits the route
   (`chase-tracks.ts` already derives the runner's speed from the path's length); when
   even the turned route is short of a running pace the chase runs slower and **warns**
   with the numbers.
4. **Dance (and one-vs-many fight) placement**: the routine keeps its shape and facing;
   if a slot, a formation-change walk or the fight ring comes within 0.6 m of a solid or
   off the floor, the whole routine shifts to the nearest spot where everything fits (up
   to 8 m), then turns (15° steps) if no shift fits; if nothing fits it stays put and
   **warns**. One-vs-many fights share the same fit (same bug class, three lines).
5. **Warnings** reach the Choreographer toast and the MCP results of
   `spawn_choreography` / `choreograph_entities` (`warnings`).

## Tasks

1. **T1 routines on the set** (`BACKLOG.md:24`).
   - Unit test `tests/unit/routine-set.test.ts` on synthetic sets (no library data): a
     walled street, a room, a prop in the dance's spot, a set too small; must fail on HEAD.
   - Probe `.maestro/set-routines/routes.probe.ts` through the store on the real kits
     **downtown, alley, nightclub**: QA's chase (cast at (0, 8), (−0.6, 10.5),
     (0.6, 11.5), `choreograph_entities kind chase ending caught`, 8 s, seeds 7, 3, 21,
     people and bots) and QA's dance (`spawn_choreography dance 4 mixed line seed 11` at
     (0, −1), heading 180).
   - **Targets** (each set, seed, body): **0** frames with a hip inside a solid
     footprint, **0** frames with a hip off the tile, root step **≤ 0.45 m** a frame
     (qa-fixes' bar); chase along the street on downtown.
2. **T2 chase follow framing** (`BACKLOG.md:19`, and the caught runner leaving the
   lead-the-subject frame, `BACKLOG.md:34`).
   - Probe on QA's chase (downtown seed 7, bots; `lead-the-subject` and `follow-behind`
     on RUNNER): per frame the nearest other body to the lens, the largest other body's
     share of the frame (projected box), the runner's `framed` (qa-fixes' measure) and
     whether its hips and head are in frame in the last 0.5 s.
   - **Targets**: other bodies **≥ 2.5 m** from the lens and **≤ 10 %** of the frame on
     every frame; runner `framed` 1.0 incl. the last 0.5 s; a contact sheet I look at.
3. **T3 (if time) chase blend slides** (`BACKLOG.md:34`): `skate-runs.cjs` on the chase
   bots; **target** no slide run > 15 cm at RUNNER run→trip 6.2–6.4 s, COP 2 slowing, the
   tackle dive.
4. **Done**: QA's chase and a dance re-shot on a frozen app of the tree
   (`.maestro/set-routines/SHEET.png`, looked at); full gate, smoke, fork e2e set
   (`--workers=1`, the lock); each task staged alone and reported.

## Results

- **T1** (people and bots, QA's chase seeds 7 / 3 / 21 and two dances on Downtown, Alley,
  Nightclub; `.maestro/set-routines/routes-*.txt`): frames (of 193) with a hip in a solid / off
  the tile, edf6dc0 → tree: Downtown chases 0–2 / 144–148 → 0 / 0 (down the street, the runner
  starts 21.6 m back up it); Alley chases 0–3 / all → 0 / 0 (cut to 4.25–6 s at a run, warned);
  Nightclub chases 3–4 / all → 0 / 0 (a lap of the floor); the Alley's 6 dancers 10–11 / 0–116
  → 0 / 0 (turned 90°); root steps ≤ 0.25 m a frame. `routine-set.test.ts` 12 of 13 fail on
  edf6dc0's routines, 13 / 13 pass.
