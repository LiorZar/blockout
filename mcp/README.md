<!-- Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md. -->

# Blockout MCP — drive the app from an AI agent

Blockout ships a small [MCP](https://modelcontextprotocol.io) server so an AI agent — **Claude Code, Codex, Hermes, OpenClaw, or any MCP client** — can drive a **running** copy of the app: stage entities, choreograph camera and actor marks, apply camera moves, scrub the timeline, and pull a viewport screenshot. It's the same set of moves you'd make by hand, exposed as tools.

This is the agent-integration guide. For the product itself, see the [main README](../README.md).

---

## How it works

```
 MCP client  ──stdio──▶  blockout-mcp.mjs  ──HTTP+bearer──▶  control server  ──IPC──▶  renderer
 (Claude Code)           (this bridge)      127.0.0.1:<rnd>   (src/main)                (the app)
```

- On launch, Blockout's main process starts a **localhost-only HTTP control server** on a **random port** with a **bearer token**, and writes a protocol-v1 descriptor to `~/.config/blockout/control.json` on macOS/Linux or `%APPDATA%\blockout\control.json` on Windows. Legacy `{ port, token, pid }` descriptors remain readable.
- The bridge **`blockout-mcp.mjs`** is a zero-dependency Node ≥18 stdio server. It reads that file, forwards each `tools/call` to the control server, which relays it to the renderer over the `control:invoke` / `control:result` IPC pair and returns the result.
- **Discovery and auth are automatic** — nothing to configure. The server binds to `127.0.0.1` only and every request must carry the bearer token, so it is not reachable off-machine. The port is random, so there are no port conflicts to manage.
- **The app must be running.** If it isn't, every tool returns `Blockout isn't running — launch the app first.` Launch with `npm run dev` (or the packaged app) so the control server comes up.

---

## Connect

Use an **absolute path** to `blockout-mcp.mjs` in every config below. From a
source checkout it is `<repo>/mcp/blockout-mcp.mjs`. Packaged locations are:

- macOS: `/Applications/Blockout.app/Contents/Resources/mcp/blockout-mcp.mjs`
- Windows per-user install: `%LOCALAPPDATA%\Programs\Blockout\resources\mcp\blockout-mcp.mjs`

### Claude Code

One line:

```bash
claude mcp add blockout -- node /absolute/path/to/blockout-mcp.mjs
```

Then in a session, `/mcp` should list **blockout** as connected (once the app is running). Remove it with `claude mcp remove blockout`.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.blockout]
command = "node"
args = ["/absolute/path/to/blockout-mcp.mjs"]
```

### Hermes

The bridge is also published standalone at [wassermanproductions/blockout-mcp](https://github.com/wassermanproductions/blockout-mcp) for Hermes's git-install flow (a catalog entry is proposed in [hermes-agent#60706](https://github.com/NousResearch/hermes-agent/pull/60706) — once merged, `hermes mcp install official/blockout` is all you need). Manual config in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  blockout:
    command: "node"
    args: ["/absolute/path/to/blockout/mcp/blockout-mcp.mjs"]
```

Launch the Blockout app, then start a new Hermes session to load the tools.

### OpenClaw / any generic MCP client

Any client that takes the standard stdio server list accepts this JSON block:

```json
{
  "mcpServers": {
    "blockout": {
      "command": "node",
      "args": ["/absolute/path/to/blockout-mcp.mjs"]
    }
  }
}
```

No `env`, no headers, no URL — the bridge discovers the running app on its own.

### HTTP transport (no Node needed)

The running app also serves the same tools itself, over MCP Streamable HTTP at
`http://127.0.0.1:17480/mcp` (`GET /health` answers `{ ok: true, app: "blockout" }`).
Both transports read one catalog, `mcp/tools.json`, and relay through the same
control path, so every edit is undoable and shows live.

```bash
claude mcp add --transport http --scope user blockout http://127.0.0.1:17480/mcp
codex mcp add blockout --url http://127.0.0.1:17480/mcp
copilot mcp add --transport http blockout http://127.0.0.1:17480/mcp
```

- Set `BLOCKOUT_MCP_PORT` to move it: an integer `1024`–`65535`, or `0` for any
  free port (the app logs the URL). Anything else falls back to `17480`.
- It binds `127.0.0.1` only, answers 403 when the `Host` header isn't
  `127.0.0.1:<port>` / `localhost:<port>`, and 403 to any request carrying an
  `Origin` header, so web pages can't reach it.
- If the port is taken (say, by a second copy of Blockout), that copy runs without
  the HTTP tools; the first copy's server is untouched. The stdio bridge keeps
  working either way.
- **Installed copies register themselves.** On launch, a packaged Blockout
  adds this URL as `blockout` to each of `claude`, `codex` and `copilot` that
  is installed (user scope), and remembers it in `mcp-registration.json` in
  its user-data folder so later launches skip the work; problems go to
  `logs/mcp-registration.log` there. An earlier stdio registration named
  `blockout` is replaced by the HTTP one, which has the same tools.

### Clara (Windows)

Clara is 2DLogic's assistant, installed separately (Blockout never bundles
it). With a project open, the **Clara** button in the titlebar docks Clara
beside Blockout (Blockout 75 %, Clara 25 %); click it again, or Clara's close
button, to undock and get the window's old size back. Clara works through the
customer's own signed-in `claude` or `codex`, uses this HTTP server's tools,
and may read files inside the project folder only (`read-files`). Deletes
(`destructiveHint` tools) show an approval card first. The button's tooltip
says when Clara isn't installed, why it couldn't open (it retries once), and
when Blockout's tools aren't available (for example, port 17480 is taken).

- Clara writes a `.clara\` folder into the project folder.
- Development: with `BLOCKOUT_CLARA_DEV` set to a Maestro checkout and an
  unpackaged Blockout, the button launches that checkout's Clara build on its
  own pipe (`CLARA_PIPE_SUFFIX`, default `blockout-dev`). Set `CLARA_DATA_DIR`
  to keep its data out of your real profile.

---

## Tools

62 tools, listed in [`tools.json`](tools.json), the one catalog both transports serve (`tests/unit/mcp-catalog.test.ts` keeps it in step with the app). Coordinates are in **meters**: `+X` right, `−Z` forward/away from the default camera; **heading 0 faces −Z**; `rotationDeg` / `panDeg` turn counter-clockwise seen from above (90 faces −X); `tiltDeg` is positive up. Focal lengths are mm on Super 35 (24 wide, 35 normal, 50–85 tight).

| Tool | Params | Does |
|---|---|---|
| `get_state` | — | **Call first.** Project / scene / active-shot summary: placed entities (id, asset, label, colour, position, held weapons) and the actor + camera marks on the timeline (camera marks with their ids and any `shot` words), the rig, `allScenes`, and `mocap` (`ready` once the Mixamo library has loaded every clip; until then a tool that casts or moves a bot waits for it, up to 120 s). |
| `list_assets` | `category?` | The placeable asset catalog (people, animals, vehicles, furniture, environment kits, primitives). Filter by category. |
| `add_entity` | `assetId, x, z, label?, rotationDeg?, color?` | Place an entity on the ground. A labelled entity gets its own colour automatically (or `color`: a name or hex). Returns the new id and colour. |
| `move_entity` | `entityId, x, z, y?, rotationDeg?` | Reposition an entity; omitted fields unchanged. |
| `delete_entity` | `entityId, name?` | Remove an entity with its marks; weapons it held are set down. `name` ("the spear") is shown on Clara's approval card. |
| `add_actor_mark` | `entityId, x, z, time, gait?` | Drop a timeline mark: at `time` the actor is at `x,z`. Chain marks to choreograph a walk. `gait`: walk / jog / run / stand. |
| `add_camera_mark` | `x, y, z, panDeg, tiltDeg, time, focalLength?` | Drop a camera mark: camera at `x,y,z` looking `panDeg`/`tiltDeg` at `time`. |
| `clear_camera_marks` | — | Clear the active shot's camera marks (keeps actor marks). |
| `set_shot` | `name?, duration?, aspect?, fps?` | Update active-shot settings; omitted fields unchanged. |
| `new_shot` | `name?` | New shot in the scene (same blocking, fresh camera). |
| `apply_framing` | `kind: 2S\|OTS\|REV\|TOP\|LOW\|DUTCH, entityIds?` | Auto-frame the camera relative to labelled subjects, or the `entityIds` you name. |
| `list_action_presets` | — | Motion-path presets for non-character performers (plane, heli, bird, chase moves, debris…). Call before `apply_action_preset`. |
| `apply_action_preset` | `entityId, presetId` | Lay a full motion path (with altitude) on an entity from its current pose. Replaces its marks. |
| `list_sequence_styles` | — | Styles available per sequence type (dance styles, fight formats, chase modes). |
| `spawn_sequence` | `type, count, style?, x?, z?, headingDeg?, bodies?` | Stage a whole choreographed crowd — `dance` / `fight` / `footChase` / `carChase` — performers *and* their choreography, in one call. A fight of exactly two is solved by the Fight Director (blows land; returns `fightId`); for a scripted fight use `stage_fight`. `bodies: ["person.mocapMale", "person.mocapFemale"]` casts the men and the women as those bodies (the mocap bots play their motions as clips); a car chase ignores it. |
| `list_choreography_options` | — | The choreography vocabulary: kinds, styles per kind, formations, endings per kind. Call before `spawn_choreography` / `choreograph_entities`. |
| `spawn_choreography` | `kind, performers, durationS?, style?, bpm?, formation?, canon?, mirror?, formationChange?, ending?, seed?, x?, z?, headingDeg?, bodies?` | Stage a full routine — a dance number, a paired / one-vs-many fight, or a foot chase — spawning fresh performers *and* their per-beat blocking. A fight of exactly two is solved by the Fight Director (blows land; returns `fightId`); for a scripted fight use `stage_fight`. `bodies: ["person.mocapMale", "person.mocapFemale"]` casts the men and the women as those bodies (the mocap bots play their motions as clips; a fight of two hands them to the Fight Director). |
| `choreograph_entities` | `entityIds, kind, style?, durationS?, bpm?, formation?, canon?, mirror?, formationChange?, ending?, seed?` | Retarget existing people into a routine: keeps their assets/labels, replaces their timeline. Centers on the group. A fight of exactly two is solved by the Fight Director (blows land; returns `fightId`); for a scripted fight use `stage_fight`. |
| `list_motion_presets` | `category?` | The single-performer motion library (fight / dance / gesture / everyday / sport / stunt) as `{ id, name, category, duration }`. |
| `list_camera_moves` | — | The camera moves: the 42 move ids and names shared with Ebook Studio, each followed by Blockout's variants of it (orbits, cranes, drone follows, dolly zoom, whip pan…). Call before `apply_camera_move`. |
| `apply_camera_move` | `presetId, entityId?` | Generate a full set of camera marks for a move (a shared id such as `dolly-in`, a variant, or an old id such as `slow-push-in`), built around a subject and riding along if it moves. Track moves enable aim-lock. Replaces camera marks. |
| `set_track_subject` | `entityId?` | Aim-lock the shot camera onto an entity (omit `entityId` to turn tracking off). |
| `snap_to_ground` | `entityId` | Rest an entity on the ground plane. |
| `set_time` | `t` | Scrub the playhead to `t` seconds. |
| `play` / `stop` | — | Start / stop timeline playback. |
| `screenshot` | — | Capture the current viewport as a PNG (returned as an image result). |
| `list_presets` | — | Saved global stage presets, as `{ id, name, savedAt, entityCount }`. |
| `save_preset` | `name` | Save the current staging as a named global preset. |
| `apply_preset` | `id` | Load a saved stage preset into the current scene. |
| `import_scan` | `sourcePath` | Import a Gaussian-splat / photogrammetry scan (`.ply/.splat/.spz/.ksplat`) into `scans/` as an editor-only environment. Returns the created scan. |
| `set_scan_transform` | `scanId, position?, rotationDeg?, scale?, visible?, flipped?` | Position / rotate / scale / show-hide an imported scan; `flipped` rights upside-down .splat exports. Omitted fields unchanged. |
| `remove_scan` | `scanId` | Remove an imported scan from the current scene. |
| `set_reference` | `videoPath, handoffVersion?, mode?, opacity?` | Attach a reference clip (copied into `refs/`) as a ghost/PIP underlay. Motion Previs sends independent handoff protocol version `1`; missing version remains accepted for legacy clients. |
| `new_scene` | `name?` | Add a scene after the last one and switch to it (one empty shot). Returns its scene and shot ids. |
| `select_scene` / `select_shot` | `sceneId` / `shotId` | Switch scene (to its first shot) or shot; ids are in `get_state` `allScenes`. |
| `set_lighting` | `preset, sunAzimuthDeg?, sunElevationDeg?, fog?` | One of the 9 lighting presets (`day`, `goldenHour`, `night`, `interiorWarm`, `interiorCool`, `club`, `middaySky`, `goldenHourSky`, `blueHourSky`). |
| `set_entity_style` | `entityId, label?, color?, name?, heightScale?, build?, hideInExports?` | An entity's label, colour and name; height (0.8–1.2) and build (0.8–1.3) for people only (the result's `notes` say when a value was clamped or ignored); hide it from exports. |
| `set_camera_rig` | `rig, intensity?` | What the camera is mounted on: `sticks`, `dolly`, `steadicam`, `handheld`, `crane`, `drone`, `carMount`; `intensity` 0–1 scales shake or drift. |
| `list_marks` | `lane` | The marks on one lane (`camera` or an entity id), sorted by time, with their ids. |
| `update_mark` | `lane, markId, time?, x?, y?, z?, gait?, hold?, easeIn?, easeOut?, panDeg?, tiltDeg?, rollDeg?, focalLength?, focusDistance?, release?` | Edit one mark. A camera mark framed by shot words is re-solved every frame: its pose takes edits only with `release: true`, which freezes the framing into a plain mark first. |
| `delete_marks` | `lane, markIds` | Delete marks from one lane. |
| `apply_motion` | `entityIds, presetId` | A motion-library move (`list_motion_presets`) on people, replacing their marks. |
| `undo` / `redo` / `save_project` | — | History, and save now (the app also autosaves). |
| `list_export_profiles` | — | The AI models Blockout exports for: length limits (minimum, frame cap and length per output resolution where a model has them), aspects, frame rate, file and prompt caps, what to attach where. |
| `export_shot` | `profileId?, passes?, labels?, resolution?` | Export the clean package (default `seedance-2`, clean + depth; `minimax-h3-max` for MiniMax H3 Max, `ltx-2.3-render-to-real`, `kling-v3-omni`, `seedance-2.5` for those models): reference video, depth video, stills and `prompt.txt`. Returns `packagePath`, `relativePath`, `prompt` and `warnings` (limits the shot breaks). |
| `export_frame` | `profileId?, resolution?, labels?` | The frame at the playhead as a full-quality PNG. |
| `export_contact_sheet` | — | One PNG of every shot's first frame in the scene, captioned. |
| `export_scene_animatic` | `profileId?, resolution?` | Every shot of the scene exported in order and joined into one video (shots must share aspect and fps). |

| `frame_shot` | `words` or `size, subjectIds, over?, side?, angle?, lens?, dutchDeg?`; `time?` | Frame the camera with shot words — "MCU on B, over A's right shoulder, 50mm" — or the same fields. The mark is re-solved every frame from the subjects, so the framing holds while they move. Over a shoulder, that shoulder stays in frame and the subject's eyes sit on the far third; a high or low angle may back the camera off (`achievedSize` says what the frame is). |
| `list_fight_moves` | — | Strikes a fight script can use, with aliases, default targets and impacts. |
| `stage_fight` | `script` / `beats` / `random`, `x?, z?, headingDeg?, fighterIds?, assets?, labels?, exaggeration?, coverage?, weapons?` | Stage a scripted two-person fight blow by blow ("A jab cross to head -> block, hit"); hits land on their frame. `weapons: ["prop.sword", "prop.pistol"]` arms A and B: "A sword slash to head -> parry" lands the blade, "B shoot to body -> hit" fires along a line through the target. Returns `{ fightId, script, report }`. |
| `update_fight` | `fightId, script?, beats?, exaggeration?, coverage?` | Re-solve a staged fight. |
| `get_fight` / `delete_fight` | `fightId` | Read a fight's script and report / forget a fight (its marks stay). |
| `fight_coverage` | `fightId, mode, side?` | Replace the camera with fight coverage: `master`, `punch-in`, `over-shoulder` or `follow`, never crossing the fight line. |
| `list_weapons` | — | Holdable weapons (`assetId, kind, strike, twoHanded, usualHand`) and who holds what in the scene. |
| `hold_weapon` | `entityId, assetId` or `weaponId, hand?` | Put a weapon in a person's hand — a new one from `assetId`, or pick up `weaponId`. It follows the hand through every move; `get_state` shows `heldBy` and the weapon's position in the hand. |
| `drop_weapon` | `weaponId` | Let go; it stands where the hand was at the playhead. |

Export file names carry a date-time stamp (a repeat within one second gets `-2`), so nothing is overwritten.

---

## A worked session

Launch the app first (`npm run dev`), then have the agent run:

```jsonc
// 1. Orient — always start here.
get_state {}
// → { project, scene: { entities: [], marks: [] }, shot: {...} }

// 2. Set the stage.
add_entity { "assetId": "env.downtown", "x": 0, "z": 0 }
add_entity { "assetId": "person.man", "x": -1, "z": 1, "label": "THIEF" }
// → { ok: true, data: { entityId: "e_7f3a" } }

// 3. Stage a whole car chase — performers and choreography in one call.
spawn_sequence { "type": "carChase", "count": 5, "style": "weaving", "z": -10 }
// → { ok: true, data: { staged: 5, entityIds: [...] } }

// 4. Give the shot camera a move built around the lead car.
list_camera_moves {}                         // find a preset id
apply_camera_move { "presetId": "follow" }

// 5. Scrub to mid-shot and look at the result.
set_time { "t": 2.5 }
screenshot {}                                // returns a PNG of the viewport
```

From here the agent can `set_shot` the aspect/duration, drop `add_actor_mark`s to refine blocking, or `apply_framing` for coverage — then you switch to **Deliver** in the UI and export the package.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `Blockout isn't running — launch the app first.` | The app isn't up (or has quit). Launch `npm run dev` / the packaged app and retry; the control server starts with the app. |
| Tools connect but every call errors after a restart | A stale control descriptor from a crashed session. It is normally deleted on quit and rewritten on launch. Quit the app fully and relaunch; if needed, delete `~/.config/blockout/control.json` (macOS/Linux) or `%APPDATA%\blockout\control.json` (Windows). |
| `node: command not found` in the client | The MCP client's PATH doesn't include Node. Use an absolute node path in the config's `command`, or launch the client from a shell where `node --version` works (Node ≥18). |
| Client can't find the server | Check the **absolute path** to `blockout-mcp.mjs` in your config, and that it points at *this* repo. |
| Port conflicts | None to worry about — the control server binds a **random** localhost port each launch and advertises it via the discovery file. |

The bridge and control server are localhost-only and token-gated; nothing is exposed off your machine.
