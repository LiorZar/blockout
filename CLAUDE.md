<!-- Modified in this fork in 2026; see MODIFICATIONS.md. -->

# CLAUDE.md

## What this fork is for

This fork of Blockout exists for **video-to-video AI generation**. You block a shot in grey-box 3D: mannequins, vehicles, a set and a camera move. You export it as a clean blockout clip and hand that clip to an AI video model as its input video. The model keeps the clip's layout, camera path and timing, and renders the finished shot on top.

The exported clip is the product. Everything else (the editor, library, choreography and MCP) is there to produce that clip fast and make it impossible for the model to misread.

## Target models

These are video-input models on Scenario.com (limits verified 2026-10-14):

| Model | Scenario ID | Video input | Limits that shape the export |
|---|---|---|---|
| MiniMax H3 Max 3D to Video | `model_minimax-h3-max-3d-to-video` | `video`: a 3D previs clip | ≤15 s, ≤50 MB, up to 32 shots; output length = input length. Prompt (≤2000 chars) should say what each proxy is ("the blue box is a sedan"). ≤8 reference images; 480P / 768P / 1080P |
| LTX 2.3 Quality – Render to Real | `model_ltx-2-3-quality-render-to-real` | `video`: a 3D/CG/clay render | 720p ≤ ~6 s, 480p ≤ ~15 s; ≤361 frames. Optional first-frame look image; intensity light / strong / strong-v2 |
| Kling V3 Omni Video | `model_kling-v3-omni-video` | `referenceVideo` with `videoReferenceType: "base"` | 3–10 s; ≤7 reference images; follows the camera loosely |
| Seedance 2.0 / 2.5 | `model_bytedance-seedance-2-0` / `model_bytedance-seedance-2-5` | `referenceVideos` (≤3) | Guides camera and motion rather than locking them |

H3 Max is the model built specifically for this job.

## Product priorities

- **Common movie scenes are built in, clickable and fast.** Fights, foot chases, car chases and the other staple scenes should stage with cast, marks and camera in a click or two, then export, with no hand-placing of marks.
- **The clip must be easy for the model to read.** The camera follows the right subject, the export contains no editor chrome, there is no empty void behind the action, and the prompt names what each grey shape stands for.
- **Grey-box, not art.** Upstream's rule still holds: the goal is unambiguous, not beautiful.

## Rules for agents

- A generation on Scenario spends credits. First show Lior the parameters, the prompt and a dry-run cost, then wait for a yes.
- Keep `LICENSE` and `NOTICE` intact, and record fork changes in `MODIFICATIONS.md`.

## Working on the code

[AGENTS.md](AGENTS.md) has the build and test commands, the repo map, the hard rules (engine purity, determinism, `store.mutate`) and the `window.__blockout` automation surface. Read it before making changes.
