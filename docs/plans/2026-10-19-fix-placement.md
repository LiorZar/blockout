# fix-placement: an armed placement wins the floor click; camera moves skip set kits

Bugs B5 and B6 from `.maestro/qa-export/REPORT.md`.

## Goal

- **B5:** after placing a set kit, the next armed placement (asset, sequence, Choreographer routine, Fight Director fight) stages on the floor click even when the click lands on the kit's transform gizmo. A gizmo drag still works when nothing is armed.
- **B6:** camera moves and framing never build around a selected `env.*` kit while the scene has cast (people, vehicles, animals). They fall back to the cast. A kit is used only when passed explicitly by id (MCP `apply_camera_move entityId`, `apply_framing entityIds`), or when the scene has no cast at all.

## My calls

- **Placement keeps selecting the kit.** The Inspector and gizmo stay usable for moving the set right after placing it, as with every other asset. Both bugs are fixed at their roots instead (armed placement disables the gizmo; framing ignores selected kits), so `store.ts` needs no change.
- **Cast = `person.*`, `vehicle.*`, `animal.*`.** Props don't count: with only a kit and props, a selected kit is still honoured.
- **While a placement is armed the gizmo is disabled (`transform.enabled = false`)**, not hidden. TransformControls registers its `pointerdown` before ours and would start a drag on the kit; disabling it stops that, and our handler skips its gizmo guard while armed.
- **Same rule for the SHOOT size buttons (`autoFrame`) and the Inspector's "built around …" hint**, so the label matches what Apply move does.

## Tasks

1. `pickFramingSubjectIds(entities, selected, min, { explicit })`: drop selected kits when the scene has cast, unless explicit. Callers: `framingSubjects` (explicit when ids are passed), `autoFrame`, Inspector camera-move hint.
   → verify: new cases in `tests/unit/framing-subjects.test.ts` fail first, then pass (`--nolock` vitest).
2. `SceneManager.onPointerDown`: an armed placement skips the gizmo guard; the store subscription sets `transform.enabled = !armed`.
   → verify: new fork spec `tests/e2e/placement.spec.ts` clicks the real UI: Library → Downtown → floor; Choreographer → Fight → Stage fight → same floor spot → the fight is staged; select the kit; 🎥 Camera → Follow Behind → Apply move → the track subject is Fighter A, the toast doesn't name the kit. Screenshots in `.maestro/fix-placement-visual/`.
3. Gate: typecheck + lint + full vitest, smoke, `placement.spec.ts`, and upstream `interaction.spec.ts` (real-mouse gizmo drag still works).
