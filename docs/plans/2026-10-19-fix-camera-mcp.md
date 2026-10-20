# fix-camera-mcp — round-3 gaps 4, 6, 11, 12, 13, 16, 14 + 17

Goal: close the audit gaps (`.maestro/audit/GAPS.md`) in the shot solver, the camera-mark MCP surface, the Clara-facing error and style polish, and the docs.

## My calls

- **Gap 6, OTS solve.** Replace the fixed "0.55 m behind, 0.25 m out" camera with an exact two-point solve: the near shoulder joint lands at NDC (±0.7, −0.7) on A's side of the frame and the subject's eyes on the far third line (x = ∓1/3; y puts the head-top at the size's fill line, as singles do). With a lens, the size sets the distance to the subject; without one, the camera sits 0.6 m from the shoulder and the lens is solved for the size. When lens + size can't both hold (camera would pass A, or a wide size on a long lens), the shoulder composition wins and `achievedSize` reports the size actually got. The line-side push stays (then re-aims at the eyes).
- The fork test `shot.test.ts` "OTS over A's right shoulder" asserted the subject's head centred and the camera within 0.7 m of the shoulder at 50 mm; both contradict the gap-6 spec (eyes in the far third; MCU at 50 mm needs ~2 m). Its assertions move to the new spec. `fight-coverage.test.ts` (no lens, ≤ 0.7 m) is unchanged.
- **Gap 4.** `update_mark` on a shot mark with pose fields (`x/y/z/panDeg/tiltDeg/rollDeg`, and `focalLength` when the words fix the lens or it's an OTS) errors and names `release: true`; `release: true` freezes the solved pose, drops `shot`, then applies the edits, in one undo step. `time/hold/ease/focusDistance` edits need no release. `get_state` camera marks carry `shot`.
- **Gap 11.** `contact-sheet-<stamp>.png` / `animatic-<stamp>.mp4`, same stamp format as `export_shot` (to the second).
- **Gap 13.** People: `heightScale` clamps to 0.8–1.2, `build` to 0.8–1.3 (the rig's `personDims` ranges); the result says when a value was clamped. Non-people: the values are not stored and the result carries a note.

## Tasks

1. Gap 6 — `shot.ts` OTS solve. → verify: `shot.test.ts` new cases (shoulder inside |NDC| ≤ 0.95 at 35/50/85 mm, both shoulders; eyes on the far third; MCU honoured at 50 mm) red then green; `fight-coverage.test.ts`, `shot-track.test.ts` green; before/after sheet in `.maestro/fix-camera-mcp-visual/`.
2. Gap 4 — `update_mark` release, `get_state` shot. → verify: `fight-camera.spec.ts` new test red then green.
3. Gap 11 — timestamped contact sheet / animatic. → verify: `mcp-gaps.spec.ts` asserts stamped names, red then green.
4. Gap 12 — stale-id errors name `get_state`. → verify: `mcp-gaps.spec.ts` asserts on all five, red then green.
5. Gap 13 — `set_entity_style` clamps and notes. → verify: `mcp-gaps.spec.ts`, red then green.
6. Gap 16 — tool call before a project is open. → verify: `mcp-gaps.spec.ts` new test (MCP HTTP `isError`, "No project open").
7. Gate: typecheck + lint + unit, smoke (engine + export touched), fork e2e `fight-camera` + `mcp-gaps`.
8. Gaps 14 + 17 docs (after crd says go): `mcp/README.md` tool table, `AGENTS.md` upstream tools + held weapons / hit power bullet, `README.md:199` marker + header. → verify: `mcp-catalog.test.ts`, a name diff of the tables against `mcp/tools.json`.

## Extra tasks (crd, from `.maestro/qa-clara/REPORT.md`)

My calls:
- **Bug 1.** Text only: positive `panDeg` / `rotationDeg` turn counter-clockwise seen from above (0 faces −Z, +90 faces −X), as the code always did.
- **Bugs 4 + 5.** The OTS eyes go as near the upper third line as the size allows: head-top no higher than the size's fill line, the size's visible region (e.g. chest-up for an MCU) inside the frame. `angle` moves the camera height target the shoulder bisection aims for (eye = A's eye line, high = above A's head, low = A's chest, ground = near the floor), as far as the shoulder stays in frame; `overhead` counts as `high`. The tool text says both limits.
- **Bug 7.** `delete_entity` takes an optional `name` (ignored by the handler); `buildAttachOptions` passes `tools: { delete_entity: { label: 'Remove {name}' } }`. Without a name the card falls back to the tool title (Clara's template rule).

9. Bug 1 — tool text + conventions string + AGENTS.md. → verify: e2e asserts a +90 panDeg camera looks toward −X (the rendered camera's forward), and an add_entity rotationDeg 90 faces −X.
10. Bugs 4 + 5 — `shot.ts` OTS angle + eye line. → verify: `shot.test.ts` cases (eyes at 1/3 for WS, ≥ the visible region for MCU; high camera above low camera, shoulder still inside |NDC| ≤ 0.95), red then green; after-sheet.
11. Bug 7 — `delete_entity name`, Clara label. → verify: `clara-controller.test.ts` asserts the attach options carry the template; `mcp-catalog.test.ts` green.
12. qa-export B7 — Shot panel subjects from `framingCandidates` (no `env.*` kits, people first). → verify: `shot.test.ts` framingCandidates case, red then green.
13. qa-export B11 — `freshPath` in `exporter.ts`: a repeat name within one second gets -2, -3…. → verify: `mcp-gaps.spec.ts` two back-to-back `export_frame` calls, red on the old build, green after.
