<!-- Modified in this fork (2026): MiniMax H3 Max, maxFileMB / maxPromptChars / promptStyle, the prompt's scene sections; see MODIFICATIONS.md. -->

# Generator profiles

A profile tells Blockout how a target AI generator consumes references and constrains the export (duration cap, resolution, fps), plus how to phrase the adherence instruction in the generated prompt. Profiles are **data, not code** — updating for a new model version is an edit, not a release.

Built-ins live in `src/engine/profiles.ts` (`BUILTIN_PROFILES`). Video: Seedance 2.0, MiniMax H3 Max (fork), Veo 3.1, Kling 2.x, LTX 2.3, Wan 2.2. Image: GPT Image 2, Nano Banana, Ideogram, Krea 2.

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

Profiles with `depthVideo` in `refModes` also get a pre-wired `comfyui-workflow.json` in the export package.

## Adding or updating a profile

1. Edit `BUILTIN_PROFILES` in `src/engine/profiles.ts` (copy the closest existing profile).
2. Keep `exportWidth` divisible by 2 (h264 yuv420p requires even dimensions; heights are derived and evened automatically).
3. Run `npm test` — `schema.test.ts` asserts every profile produces a working prompt.
4. If the model needs a different prompt structure (not just a different adherence clause), extend `generatePrompt` in `src/engine/prompt.ts` behind a profile field, not a hardcoded id check.

## Prompting notes

The generated prompt is assembled from actual scene data: lens/sensor/aspect/lighting line, camera choreography per leg (push/track/boom/pan/tilt/zoom with timings), each labeled subject's marks and gaits with arrival times, the setting, then the profile's adherence clause and a standing instruction that grey placeholder figures should be replaced with the described subjects while keeping positions/timing identical.

## Fork: MiniMax H3 Max and the scene sections

`minimax-h3-max` targets **MiniMax H3 Max 3D to Video** on Scenario (`model_minimax-h3-max-3d-to-video`): attach `*_reference.mp4` as its `video` input and paste `prompt.txt`. Limits (CLAUDE.md): ≤ 15 s (the output is as long as the clip), ≤ 50 MB, prompt ≤ 2000 characters, 480P / 768P / 1080P. Deliver and `export_shot` (`warnings`) say when a shot is longer than the profile's `maxDuration` or uses an aspect the profile doesn't list (`profileWarnings`).

Every profile's prompt now opens with three scene sections (`src/engine/prompt-scene.ts`), each only when it has something to say:

1. **Proxy map** — one line per visible subject, in the colour it renders: `The orange mannequin (A) is a man holding a katana (the green shape) in A's right hand.` Unlabelled look-alikes share a counted line (`The 8 grey figures are 4 men and 4 women.`); labelled primitives read `The red box stands for "BOMB".`
2. **Action** in time order — fights from their beat scripts with each blow's outcome (`A slashes at B's body with the katana, B blocks, then it knocks B out.`), motion-library moves, walks / runs / drives with screen direction, chases.
3. **Camera** — live shot words (`wide shot of A and B; then medium close-up on B, over A's right shoulder, 50mm`), else the overall move named once (`handheld; moves forward; the lens goes from 35mm to 85mm`), never per-leg pans or timings (upstream's v5 rule).

Then upstream's look line and setting, then the directive. Image profiles get the proxy map only.
