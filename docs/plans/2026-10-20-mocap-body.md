# Mocap body (phase 1 of docs/plans/2026-10-20-mocap-bots.md)

Lane `mocap-body`. Goal: Mixamo Y Bot (male) and X Bot (female) as two person
bodies, `person.mocapMale` / `person.mocapFemale` ("Mocap man" / "Mocap woman"),
driven by every existing gait, motion and fight through the 18-channel rig,
read from a local library (`resolveConfigPath('mixamo')`) that never enters git.

## My calls

- **The body call** is `skeleton.ts`: `personDims` returns a bot's fitted
  dims (with `dims.mocap`), and `poseFrames` / `poseEffectors` branch on
  `dims.mocap` before anything else, so the 11-bone path is untouched
  (bit-identical, pinned by a test against a frozen copy). Consumers with a
  private rig chain (weapons `handFrame` / arm IK, contact capsules, the floor
  and pose-fit proxies) switch to the body call or a bot proxy.
- **Retarget**: the rig's world rotations act on an "A-rest" of the bot (arms
  hang straight down, palms in; legs vertical; everything else at bind). The
  torso rotation is spread over Spine/Spine1/Spine2 in thirds (slerp powers,
  so they compose exactly), the head's half on Neck. Bot frames for
  consumers sit at the mixamorig joints with the rig's orientation; the torso
  and head frames are virtual origins rigid with Spine2 / Head.
- **Floor proxy = support points**, not capsules: per bone, the extreme
  skinned vertices in 128 directions. A capsule around a flat hand or sole
  floats a push-up 3+ cm, past the ±2 cm bar. Contact uses fitted capsules
  per limb plus a torso loft cut from the mesh.
- **Scale**: each bot is normalized to its catalog height (1.80 / 1.70);
  `height` scales it, `build` is ignored (a skinned mesh can't widen).
- **No library / not loaded yet**: a bot id evaluates and renders as the
  matching studio mannequin, and the bots are hidden from pickers and
  `list_assets`. When the library loads, bot visuals swap in.
- **Defaults**: the UI pickers (Fight Director Bodies, Choreographer Bodies,
  Inspector Body) default to Mocap when the library is present. MCP / engine
  defaults stay man + woman so scripted runs don't change with the machine.
- **Hold**: bot visuals carry named marker objects (`elbowL` … `torso`) on the
  bones with the rig frames' world transforms, so `hold.ts` finds the hand
  `(0, −lowerArmLen, 0)` = the palm. `steadyArm` re-poses a bot through a hook.

## Tasks

1. Engine body kind (`src/engine/mocap/`), dispatch in skeleton / floor /
   pose-fit / contact / weapons.
   → verify: fixture-skeleton unit tests (FK, frames, effectors, proxies,
   legacy bit-identical, fight solve + weapon hold on bots).
2. Library access: `src/main/mocap.ts` IPC (`mocap:list` / `mocap:read`,
   confined), preload, `src/renderer/mocap/` loader (FBXLoader,
   SkeletonUtils.clone, 0.01 m, face −Z) that registers bind data + vertex
   samples with the engine.
   → verify: confinement unit test; extraction test on a three-built fixture
   skinned mesh; app log lists bones and clips (with the library).
3. Rendering: catalog entries, skinned builder (placeholder then swap),
   retarget from the hidden rig, markers + `steadyArm` hook, tint, depth-pass
   skinning chunks, exports wait for the library.
   → verify: rendered bones = engine FK ≤ 1 mm (fixture); gaits + presets
   grounded ±2 cm every 1/12 s (fixture; real bots when the library exists).
4. Pickers, prompt, MCP: Library, Inspector Body, Fight Director Bodies,
   Choreographer Bodies, prompt "grey mannequin", `list_assets`, tools.json.
   → verify: mcp-catalog + prompt-scene tests.
5. `tests/e2e/mocap-bots.spec.ts` (skips without the library), visual sheet
   in `.maestro/mocap-body-visual/`, full gate, smoke, fork e2e.
