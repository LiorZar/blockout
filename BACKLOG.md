# Backlog

## Bugs

- Gait code in `animatePerson` (`src/renderer/viewport/builders.ts`) leans the wrong way for a body facing −Z: the run lean (`torso.rotation.x = baseLean + 0.15`), the elderly `baseLean` (0.18) and the crouch torso (+0.3) all lean the torso backward, and `sit` puts the thighs behind the body (hips −π/2); the `gesture` (talk) arm rises behind the head. Same sign issue as the motion-library fix in MODIFICATIONS.md; upstream bug, worth reporting upstream.
- Motion data: `haymaker` and `elbow-strike` twist the torso the opposite way to the `motions.ts` header (their wind-up brings the striking shoulder forward), so the Fight Director's haymaker impact lands on the wind-up keyframe.
- Upstream `playMotion` (`src/engine/choreography.ts`) clamps root `move.up` to y ≥ 0, so upstream falls and knockdowns float instead of reaching the ground (the Fight Director applies it unclamped).
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

## Issues

- Report the rig override sign bug (fixed in the fork, see MODIFICATIONS.md) to upstream wassermanproductions/blockout — needs Lior's go before anything is posted.
