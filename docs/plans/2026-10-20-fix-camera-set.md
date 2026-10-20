# fix-camera-set: framing and people-follow cameras stay in open space

Lane `fix-camera-set`, round 4, 2026-10-20. Bug (BACKLOG, Bugs): camera framing ignores walls and other cast. qa-export (`.maestro/qa-export/REPORT.md` B3 c, d): `apply_framing 2S` on 6 dancers puts the camera 12.1 m out, behind the nightclub's back wall (24/24 black frames); a chase `follow-behind` has the pursuers block the runner and ends inside the runner's body and a building; `lead-the-subject` crosses storefront walls.

## Goal

Shot words (`frame_shot`, the Shot panel), `apply_framing` and the people-follow cameras (`follow`-category camera moves on a person, fight coverage) keep the camera in open space (not inside a wall, prop or body) with the framed subject unblocked by other cast or set. When the asked-for view is blocked, take the nearest clear alternative and say so; warn when none exists. A clear view stays exactly as asked.

## My calls

- **Solve at mark time, store the result as data.** The clearance search runs when a mark is made (frame_shot / Shot panel / coverage / apply_framing / camera move), over samples of the time the mark drives. Shot words keep the outcome in the spec as `ShotSpec.view` (`turnDeg`, `raise`, `closer`, `blockedBy`, `noClearView`), which `solveShot` applies every frame. The per-frame solver stays pure and geometry-free, the camera never jumps mid-mark, and `get_state` shows why a camera moved.
- **Alternatives, nearest first:** move closer on a wider lens (same frame size; factors 0.85 / 0.7 / 0.55 / 0.45, lens ≥ 12 mm), raise the camera (0.5 / 1 / 1.5 / 2.5 m, re-aimed), swing round the subject (20° steps). Cost: one step of closer = one 0.5 m raise = 20° of swing; ties keep that order. Shots on a fight line swing at most 60° so they never cross it; OTS only raises.
- **Clear** = the camera is never inside a set box or a body (20 cm / 12 cm margins) and, in ≥ 90 % of the samples, every framed subject shows its head and chest (weights head 0.4, chest 0.35, pelvis 0.25; ≥ 0.75). Framed subjects never count as blocking each other; the OTS shoulder entity doesn't block.
- **Set geometry as data:** `cameraBoxes(scene, take)` (additive export in `renderer/fight-obstacles.ts`) reads each static prop's and kit's meshes as oriented boxes with their full height (walls above the body band count); transparent meshes (glass, light cones) and anything under 0.35 m (floors, rugs, kerbs) don't. Cast comes from the evaluator per sample: people as posed spheres (FK), moving vehicles and animals as boxes.
- **2S math moves into `framing.ts`** (`groupShotPose`) so the nightclub case is unit-testable; SceneManager calls it. Every `apply_framing` kind except DUTCH goes through the clearance.
- **Follow moves:** each of the preset's marks takes the cheapest clear alternative (plus a cost for differing from the previous mark), then the evaluated camera path is checked every 1/8 s and a cleared mark is inserted wherever it passes through a wall or body or loses the subject (≤ 12 insertions). Vehicles stay out of scope (Lior's ruling).

## Tasks

1. `src/engine/camera-clear.ts` (pure): set boxes, body spheres, segment/inside tests, view score, variants + `chooseView`, `clearMarks` for follow paths, `describeView`. → verify: `tests/unit/camera-clear.test.ts` (wall blocks, glass doesn't, inside detection, nearest-variant order, notes).
2. `ShotSpec.view` in `shot.ts`. → verify: `tests/unit/shot.test.ts` unchanged and green; new cases in `camera-clear-shot.test.ts` (turn / raise / closer move the camera as described, no `view` = identical pose).
3. Renderer helper `src/renderer/camera-view.ts` + `cameraBoxes`; store `setShotAtTime` and `writeCoverage` clear their shot words; `frame_shot` / `fight_coverage` report the note. → verify: store test, a shot words mark behind a wall is cleared and noted; clear view leaves the spec unchanged.
4. `apply_framing` (2S via `groupShotPose`, all kinds cleared) → verify: the nightclub 2S on 6 dancers puts the camera inside the room with every dancer visible.
5. People-follow camera moves → verify: the downtown chase `follow-behind` keeps the runner unblocked (≥ 90 % of 1/8 s samples) and the camera out of walls and bodies; `lead-the-subject` stays out of storefronts.
6. Docs (`mcp/tools.json` descriptions, AGENTS.md line, MODIFICATIONS.md, BACKLOG DONE), full gate, smoke, e2e `fight-camera` + `mcp-gaps` + `placement`; before/after frame sheets of the qa-export nightclub 2S and foot-chase follow through `analyze.mjs` (0 flat frames, subject visible ≥ 90 %) in `.maestro/fix-camera-set-visual/`.
