# Backlog

## Bugs

- ~~Gait code in `animatePerson` (`src/renderer/viewport/builders.ts`) leans the wrong way for a body facing −Z: the run lean (`torso.rotation.x = baseLean + 0.15`), the elderly `baseLean` (0.18) and the crouch torso (+0.3) all lean the torso backward, and `sit` puts the thighs behind the body (hips −π/2); the `gesture` (talk) arm rises behind the head. Same sign issue as the motion-library fix in MODIFICATIONS.md; upstream bug, worth reporting upstream.~~ DONE
- ~~Motion data: `haymaker` and `elbow-strike` twist the torso the opposite way to the `motions.ts` header (their wind-up brings the striking shoulder forward), so the Fight Director's haymaker impact lands on the wind-up keyframe.~~ DONE (fights play the fork `haymaker-swing` / `elbow-strike-across`; the upstream data stays as it is)
- ~~Upstream `playMotion` (`src/engine/choreography.ts`) clamps root `move.up` to y ≥ 0, so upstream falls and knockdowns float instead of reaching the ground (the Fight Director applies it unclamped).~~ DONE (fix-gaits: `floor.ts` floor rule, `posedMove` marks)
- ~~Motion data: `rifle-aim-sweep` "shoulder it" keyframes (t=0.5–1.5) hold both forearms vertical with the hands at head height 0.7 m apart, so no grip can point a rifle forward.~~ DONE (superseded by rifle-aim-fire; the upstream data stays as it is)
- ~~Motion data: `sword-slash-combo` says "two-handed grip" but the hands are 0.67–0.8 m apart.~~ DONE (fights play the fork `sword-slash-two-hand`)
- ~~Motion data: `shield-brace` / `shield-block` hold both forearms vertical (there is no shoulder-twist channel), so a strapped shield faces forward only with a forearm-vertical hold.~~ DONE (fork `shield-block-face` / `shield-brace-face`; fights block with the shield blocks)
- Upstream classic people render 0.14·s taller than their catalog height (man 1.78 → 1.92 m) because of fixed pelvis/neck offsets in `buildPerson`; the mannequins absorb those offsets and match their catalog height.
- ~~`tests/e2e/control-tools.spec.ts` reads the discovery file from `~/.config/blockout`, which is wrong on Windows (use `resolveConfigPath` + `BLOCKOUT_CONFIG_DIR`).~~ DONE (Lior's ruling: fix the one line; private `BLOCKOUT_CONFIG_DIR`)
- ~~`stills/*_topdown.png` leaks the gizmo into the export.~~ DONE (fixed in 4899552: gizmo, selection boxes and tint hidden in renderTopDown)
- ~~The default "day" lighting renders a flat grey void behind the action.~~ DONE (fix-env: every preset gets a ground to the horizon under a graded sky or a dim room surround; the `*Sky` presets are no longer white; `environment.ts`)
- ~~Fight rest steps and step-ins: the walk cycle plays under the guard joints, so the legs float 5–6 cm for a few frames (`animatePerson` grounds the walk before the joint overrides; found by fix-fight-geom, 2026-10-19).~~ DONE (fix-fight-legs: the gait is grounded after the joint overrides; step-ins walk; lowest foot within ±2 cm on six bodies)
- ~~Elbow strike up to a taller head still misses by 7.1 cm (classic) / 3.3 cm (mannequins), warned; closing it needs a torso lean.~~ DONE (fix-fight-legs: elbows aim at the jaw, arm blows lean ≤ 20° without entering the defender; 0.5 / 0.0 cm)
- Push-ups, cartwheel, crawl (hands on floor), kneel-tie-shoe (rear knee down) and lying falls need a root pitch channel; they touch the floor now but can't make the pose. `sit-down` data reads as kneeling; `mosh-jump` / `cheer-jump` fake a hop with tucked legs and now read as crouch-bounces. (Partly done: the root pitch/yaw/roll channel is in FK, the rig and `floor.ts`; the motion overlay `motions-root.ts` and per-body fits `pose-fit.ts` are committed but not wired in yet. Done for the Mocap bots by mocap-clips: push-ups, crawl, kneel-tie-shoe, sit-down, the falls, get-up and cartwheel play their Mixamo clips and make the pose on both bots (`mocap-clips-real.test.ts`); still open for the procedural bodies.)
- ~~The Choreographer's Duration field is ignored: routines take the shot length (`spawnChoreography`, `store.ts`).~~ DONE (fix-routines: the routine takes the Duration and a shorter shot grows to it in the same undo; a two-person fight keeps the Fight Director's own length. Still open: the MCP result doesn't report the solved length)
- Chase follow-behind: the pursuers' heads fill a third to a half of the frame and sometimes overlap the runner (`.maestro/fix-camera-set-visual/after-footchase-follow-sheet.png`); follow cameras allow other cast 0.5 m from the lens. Keep other bodies ≥ ~2.5 m away and under 10 % of the frame (rise over them, drop back behind the group, or swing to a side).
- `mcp-gaps.spec.ts` "a selection never reaches the top-down blocking diagram" failed once (two consecutive top-down exports differed), then passed alone. A determinism check: find out what leaves renderer state behind.
- Exports have no tone mapping while the viewport uses ACES ×1.45, so exported clips look flatter and darker than the editor (fixed only for the physical sky).
- The night preset (sun 0.7, ambient 0.4) leaves the cast near black; the new ground helps the silhouettes but the bodies don't read.
- ~~Camera framing ignores walls and other cast: `apply_framing 2S` on 6 dancers places the camera outside the nightclub walls (all-black clip), and pursuers block the runner in a chase follow (qa-export 2026-10-19).~~ DONE (fix-camera-set: shot words, coverage, framings and people-follow moves take the nearest clear view and say so; `src/engine/camera-clear.ts`)
- Choreographer chase and dance routines ignore the set and run through buildings (they head toward the editor camera).
- ~~Export folder stamps are UTC (`export-2026-10-19-19-32-01` at 22:32 local).~~ DONE (fix-env: local time, same format; `export/stamp.ts`)
- Mocap crouch is a derived pose (`crouchStill`): the Mixamo crouch idle holds the right hand at head height for the whole loop, so the bots keep its breathing body with the crouched walk's arms. A Mixamo crouch idle with both hands down would replace it.
- Mocap chair sit uses the clip's own seat height (~0.45 m), so a bot on a stool (0.65 m) or a couch cushion overlaps the seat a little.
- X Bot crawl: the left knee joint drifts 2.1 cm per contact (1.6 cm along the travel, from retargeting the Y Bot take onto her proportions; the rest is hip sway), just over the 2 cm slide bar.

## Features

- ~~Fights ignore set dressing: a stagger or knockback can carry a fighter through a bench or post (seen in the 2026-10-19 sword-vs-bat sheet in the gym). Keep fights clear of kit props, or warn when the solved path crosses one.~~ DONE
- ~~Over-the-shoulder shot words: offset the aim so the foreground shoulder stays in frame with long lenses (today the subject's head is centred, per the plan).~~ DONE (shoulder pinned near the frame edge, eyes on the far third and near the upper third; angle and size honoured, qa-clara bugs 4 + 5)
- ~~Target-model export profiles (H3 Max first, then LTX Render-to-Real, Kling V3 Omni, Seedance 2.5) and a proxy-mapping `prompt.txt`.~~ DONE for H3 Max (`minimax-h3-max`, 50 MB bitrate cap) and the proxy-mapping prompt
- Export profiles for LTX 2.3 Render-to-Real (720p ≤ ~6 s / 480p ≤ ~15 s, ≤ 361 frames), Kling V3 Omni (3–10 s) and Seedance 2.5 (CLAUDE.md limits); add a `minDuration` field for Kling.
- Open road / extendable street kit (a 6 s car chase covers ~92 m against a 36 m tile).
- Occlusion-aware camera moves (an orbit inside the alley kit renders only wall).
- Vehicle-aware sizing in the 39 `camera-moves.ts` presets (the shot solver already handles vehicle extents).
- Vehicle-aware speed warnings.
- A read-only top-down view tool for agents (Clara added a camera mark at y 14 m to read the floor plan; `screenshot` takes no view argument).
- ~~Narrow layout: docked beside Clara, Blockout can be 650–950 px wide; below ~950 px the viewport becomes a sliver and the titlebar buttons wrap (seen in the 2026-10-19 Clara test). Collapse the side panels when narrow.~~ DONE
- ~~`fight_coverage` punch-in only pushes in on stagger / knockdown / KO, so a fight of plain hits gets a static camera (Clara noticed it in the Clara test and built the push-in by hand). Tied to the open hit-strength question.~~ DONE
- ~~`prompt.txt` names the subjects and the set but not the action ("a man and a woman in a gym" for a staged fight with a knockout).~~ DONE (`src/engine/prompt-scene.ts`)
- ~~`export_frame` defaults `labels` to true; in a tight shot a label pill shows cut off at the top edge of the frame.~~ DONE
- ~~`delete_entity`'s title "Delete something" and description "Remove an entity from the scene" read as jargon on Clara's approval card; name the thing being deleted (Clara supports a `label` template like "Delete {entityId}").~~ DONE (title, then qa-clara: the card still couldn't name it; now `delete_entity` takes `name` and Clara's label is "Remove {name}")

## Issues

- Report the rig override sign bug (fixed in the fork, see MODIFICATIONS.md) to upstream wassermanproductions/blockout — needs Lior's go before anything is posted.
- Mocap bots (phase 1 leftovers): the bots' fingers stay flat at rest, so a fist punch or a gun grip reads as an open hand until phase 2/3 brings clip poses; the AI reference analysis (`src/main/analyze.ts`) lists the bot ids even on a machine without the Mixamo library (a staged bot then shows as its studio mannequin).
