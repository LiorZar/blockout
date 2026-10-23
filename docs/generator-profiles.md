<!-- Modified in this fork (2026): MiniMax H3 Max, LTX 2.3 Render to Real, Kling V3 Omni, Seedance 2.5, maxFileMB / maxPromptChars / promptStyle / minDuration / maxFrames / resolutionCaps, the prompt's scene sections; see MODIFICATIONS.md. -->

# Generator profiles

A profile tells Blockout how a target AI generator consumes references and constrains the export (duration cap, resolution, fps), plus how to phrase the adherence instruction in the generated prompt. Profiles are **data, not code** — updating for a new model version is an edit, not a release.

Built-ins live in `src/engine/profiles.ts` (`BUILTIN_PROFILES`). Video: Seedance 2.0, MiniMax H3 Max, LTX 2.3 Render to Real, Kling V3 Omni and Seedance 2.5 (fork), Veo 3.1, Kling 2.x, LTX 2.3, Wan 2.2. Image: GPT Image 2, Nano Banana, Ideogram, Krea 2.

## Fields

| Field | Meaning |
|---|---|
| `id`, `name`, `vendor`, `kind` | Identity; `kind` is `'video'` or `'image'` |
| `maxDuration` | Hard per-clip cap in seconds — the Deliver panel warns when the shot exceeds it |
| `recommendedDuration` | Sweet spot shown to the user |
| `aspects` | Aspect ratios the model accepts |
| `exportWidth` | Long-edge resolution for exports targeting this model |
| `fps` | Export frame rate |
| `refModes` | How the model consumes references, in priority order: `referenceVideo`, `firstFrame`, `lastFrame`, `depthVideo`, `stills` |
| `attachHint` | One sentence shown in Deliver telling the user what to attach where |
| `adherenceClause` | Appended to the generated prompt; instructs the model to match the reference exactly |
| `maxFileMB` | Fork, optional: the model's input-video size cap; the encoder adds a bitrate ceiling so every pass stays under it (`encoderMaxKbps` in `profile-limits.ts`) |
| `maxPromptChars` | Fork, optional: the model's prompt cap; the prompt's scene sections are trimmed to fit (default budget 1500) |
| `promptStyle` | Fork, optional: `'previs'` ends the prompt with this profile's `adherenceClause` instead of the generic motion-reference directive — for models whose input IS the blockout clip |
| `minDuration` | Fork, optional: the model's shortest clip in seconds; a shorter shot gets a warning |
| `maxFrames` | Fork, optional: the model's frame cap; a shot with more frames (duration × the shot's fps) gets a warning |
| `resolutionCaps` | Fork, optional: output tiers whose length cap depends on the resolution, largest first (`[{ label: '720p', maxDuration: 6 }, { label: '480p', maxDuration: 15 }]`); a shot past the first tier is told which tier to pick |

Profiles with `depthVideo` in `refModes` also get a pre-wired `comfyui-workflow.json` in the export package (fork: not the `previs` profiles, whose models are hosted).

## Adding or updating a profile

1. Edit `BUILTIN_PROFILES` in `src/engine/profiles.ts` (copy the closest existing profile).
2. Keep `exportWidth` divisible by 2 (h264 yuv420p requires even dimensions; heights are derived and evened automatically).
3. Run `npm test` — `schema.test.ts` asserts every profile produces a working prompt.
4. If the model needs a different prompt structure (not just a different adherence clause), extend `generatePrompt` in `src/engine/prompt.ts` behind a profile field, not a hardcoded id check.

## Prompting notes

The generated prompt is assembled from actual scene data: lens/sensor/aspect/lighting line, camera choreography per leg (push/track/boom/pan/tilt/zoom with timings), each labeled subject's marks and gaits with arrival times, the setting, then the profile's adherence clause and a standing instruction that grey placeholder figures should be replaced with the described subjects while keeping positions/timing identical.

## Fork: MiniMax H3 Max and the scene sections

`minimax-h3-max` targets **MiniMax H3 Max 3D to Video** on Scenario (`model_minimax-h3-max-3d-to-video`): attach `*_reference.mp4` as its `video` input and paste `prompt.txt`. Limits (CLAUDE.md): ≤ 15 s (the output is as long as the clip), ≤ 50 MB, prompt ≤ 2000 characters, 480P / 768P / 1080P. Deliver and `export_shot` (`warnings`) say when a shot is longer than the profile's `maxDuration` or uses an aspect the profile doesn't list (`profileWarnings`).

The other video-input models on Scenario (CLAUDE.md's table; the model pages where it is silent) follow the same pattern; the clip is `*_reference.mp4` in every case, and Deliver / `export_shot` warn with the limits below (`profileWarnings`):

| Profile | Model | Limits | Prompt |
|---|---|---|---|
| `ltx-2.3-render-to-real` | LTX 2.3 Quality – Render to Real (`model_ltx-2-3-quality-render-to-real`), `video` input | 720p up to ~6 s, 480p up to ~15 s (`resolutionCaps`; a 6–15 s shot is told to pick 480p), ≤ 361 frames (`maxFrames`); keeps the clip's aspect; exports at 720p | `previs`: turn the grey-box render into real footage. The optional first-frame image is a finished look, not the grey still, so `refModes` is the video only |
| `kling-v3-omni` | Kling V3 Omni Video (`model_kling-v3-omni-video`), `referenceVideo` with `videoReferenceType: "base"` | 3–10 s (`minDuration` / `maxDuration`), prompt ≤ 2500 characters, 16:9 / 9:16 / 1:1, up to 7 look images | `previs`, and the clause asks for the base video's camera outright: Kling follows it loosely |
| `seedance-2.5` | Seedance 2.5 (`model_bytedance-seedance-2-5`), one of `referenceVideos` (≤ 3) | 4–15 s (Scenario makes 4–30 s and Auto matches the longest reference; 15 s is kept until a longer reference is confirmed), exports at 720p | The generic motion-reference directive: Seedance guides the camera and motion rather than locking them, so the action and camera sections carry the shot |

Every profile's prompt now opens with three scene sections (`src/engine/prompt-scene.ts`), each only when it has something to say:

1. **Proxy map** — one line per visible subject, in the colour it renders: `The orange mannequin (A) is a man holding a katana (the green shape) in A's right hand.` Unlabelled look-alikes share a counted line (`The 8 grey figures are 4 men and 4 women.`); labelled primitives read `The red box stands for "BOMB".`
2. **Action** in time order — fights from their beat scripts with each blow's outcome (`A slashes at B's body with the katana, B blocks, then it knocks B out.`), motion-library moves, walks / runs / drives with screen direction, chases.
3. **Camera** — live shot words (`wide shot of A and B; then medium close-up on B, over A's right shoulder, 50mm`), else the overall move named once (`handheld; moves forward; the lens goes from 35mm to 85mm`), never per-leg pans or timings (upstream's v5 rule).

Then upstream's look line and setting, then the directive. Image profiles get the proxy map only.
