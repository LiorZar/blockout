# Backlog

## Bugs

- ~~Gait code in `animatePerson` (`src/renderer/viewport/builders.ts`) leans the wrong way for a body facing −Z: the run lean (`torso.rotation.x = baseLean + 0.15`), the elderly `baseLean` (0.18) and the crouch torso (+0.3) all lean the torso backward, and `sit` puts the thighs behind the body (hips −π/2); the `gesture` (talk) arm rises behind the head. Same sign issue as the motion-library fix in MODIFICATIONS.md; upstream bug, worth reporting upstream.~~ DONE
- Motion data: `haymaker` and `elbow-strike` twist the torso the opposite way to the `motions.ts` header (their wind-up brings the striking shoulder forward), so the Fight Director's haymaker impact lands on the wind-up keyframe.
- Upstream `playMotion` (`src/engine/choreography.ts`) clamps root `move.up` to y ≥ 0, so upstream falls and knockdowns float instead of reaching the ground (the Fight Director applies it unclamped).
- Motion data: `rifle-aim-sweep` "shoulder it" keyframes (t=0.5–1.5) hold both forearms vertical with the hands at head height 0.7 m apart, so no grip can point a rifle forward.
- Motion data: `sword-slash-combo` says "two-handed grip" but the hands are 0.67–0.8 m apart.
- Motion data: `shield-brace` / `shield-block` hold both forearms vertical (there is no shoulder-twist channel), so a strapped shield faces forward only with a forearm-vertical hold.
- Upstream classic people render 0.14·s taller than their catalog height (man 1.78 → 1.92 m) because of fixed pelvis/neck offsets in `buildPerson`; the mannequins absorb those offsets and match their catalog height.
- `README.md:199` has a stray `>>>>>>> Stashed changes` merge marker.
- `tests/e2e/control-tools.spec.ts` reads the discovery file from `~/.config/blockout`, which is wrong on Windows (use `resolveConfigPath` + `BLOCKOUT_CONFIG_DIR`).
- `stills/*_topdown.png` leaks the gizmo into the export.
- The default "day" lighting renders a flat grey void behind the action.

## Features

- Over-the-shoulder shot words: offset the aim so the foreground shoulder stays in frame with long lenses (today the subject's head is centred, per the plan).
- Target-model export profiles (H3 Max first, then LTX Render-to-Real, Kling V3 Omni, Seedance 2.5) and a proxy-mapping `prompt.txt`.
- Open road / extendable street kit (a 6 s car chase covers ~92 m against a 36 m tile).
- Occlusion-aware camera moves (an orbit inside the alley kit renders only wall).
- Vehicle-aware sizing in the 39 `camera-moves.ts` presets (the shot solver already handles vehicle extents).
- Vehicle-aware speed warnings.
- Narrow layout: docked beside Clara, Blockout can be 650–950 px wide; below ~950 px the viewport becomes a sliver and the titlebar buttons wrap (seen in the 2026-10-19 Clara test). Collapse the side panels when narrow.
- `fight_coverage` punch-in only pushes in on stagger / knockdown / KO, so a fight of plain hits gets a static camera (Clara noticed it in the Clara test and built the push-in by hand). Tied to the open hit-strength question.
- `prompt.txt` names the subjects and the set but not the action ("a man and a woman in a gym" for a staged fight with a knockout).
- ~~`export_frame` defaults `labels` to true; in a tight shot a label pill shows cut off at the top edge of the frame.~~ DONE
- ~~`delete_entity`'s title "Delete something" and description "Remove an entity from the scene" read as jargon on Clara's approval card; name the thing being deleted (Clara supports a `label` template like "Delete {entityId}").~~ DONE

## Issues

- Report the rig override sign bug (fixed in the fork, see MODIFICATIONS.md) to upstream wassermanproductions/blockout — needs Lior's go before anything is posted.
