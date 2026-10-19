/**
 * e2e for the fork's MCP tool gaps (see docs/plans/2026-10-19-clara-mcp.md):
 * launch the built app, create a project in a temp dir whose name contains a
 * space, then drive the control server exactly as the MCP bridge does. The
 * HTTP MCP server runs on a free port (never the default 17480).
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resolveConfigPath } from '../../src/shared/config-paths'

let app: ElectronApplication
let page: Page
let smokeDir: string
let port: number
let token: string
let mcpPort: number

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const p = (srv.address() as net.AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return p
}

type Rpc<T> = { ok: boolean; data?: T; error?: string }

/** POST a control action the same way the MCP bridge does. */
async function rpc<T>(action: string, params: Record<string, unknown> = {}): Promise<Rpc<T>> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, params })
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Rpc<T>
}

/**
 * Run `fn` (source of `(s) => …`) against the live store state. Passed as an
 * expression string: the renderer's CSP forbids eval, CDP evaluation doesn't.
 */
async function evalStore<T>(fn: string): Promise<T> {
  return (await page.evaluate(`(${fn})(window.__blockout.store.getState())`)) as T
}

test.beforeAll(async () => {
  smokeDir = mkdtempSync(join(tmpdir(), 'blockout gaps-'))
  const configDir = join(smokeDir, 'config')
  mkdirSync(configDir, { recursive: true })
  mcpPort = await freePort()
  const env = {
    ...process.env,
    BLOCKOUT_SMOKE_DIR: smokeDir,
    BLOCKOUT_CONFIG_DIR: configDir,
    BLOCKOUT_MCP_PORT: String(mcpPort)
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible()

  const discoveryFile = resolveConfigPath('control.json', { env })
  await expect.poll(() => existsSync(discoveryFile)).toBe(true)
  ;({ port, token } = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as { port: number; token: string })
})

test.afterAll(async () => {
  await app?.close()
})

test('the titlebar Clara button is offered once a project is open', async () => {
  // Never clicked here: that would launch the Clara installed on this machine.
  const button = page.locator('.titlebar').getByRole('button', { name: 'Clara' })
  if ('win32' !== process.platform) {
    await expect(button).toHaveCount(0)
    return
  }
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('title', 'Open Clara')
  await page.locator('.titlebar').screenshot({ path: test.info().outputPath('titlebar.png') })
})

test('MCP over HTTP reaches the running app', async () => {
  const tools = JSON.parse(readFileSync(join(__dirname, '../../mcp/tools.json'), 'utf-8')) as unknown[]
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)))
  try {
    const listed = await client.listTools()
    expect(listed.tools.length).toBe(tools.length)
    const result = await client.callTool({ name: 'get_state', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]!.text
    expect(JSON.parse(text).ok).toBe(true)
    expect(result.isError).toBe(false)
  } finally {
    await client.close()
  }
})

test('apply_camera_move follows the entity it is given', async () => {
  expect((await rpc('add_entity', { assetId: 'env.residentialStreet', x: 0, z: 0 })).ok).toBe(true)
  const spawned = await rpc<{ entityIds: string[] }>('spawn_sequence', { type: 'carChase', count: 2 })
  expect(spawned.ok).toBe(true)
  const ids = spawned.data?.entityIds ?? []
  expect(ids.length).toBe(2)
  const lead = await evalStore<string>(
    `(s) => s.scene().entities.find((e) => ${JSON.stringify(ids)}.includes(e.id) && e.label?.text === 'LEAD').id`
  )

  const chase = ids.find((id) => id !== lead)!
  const moved = await rpc('apply_camera_move', { presetId: 'follow-behind', entityId: chase })
  expect(moved.ok).toBe(true)
  expect(await evalStore<string>('(s) => s.shot().camera.trackEntityId')).toBe(chase)

  const movedLead = await rpc('apply_camera_move', { presetId: 'follow-behind', entityId: lead })
  expect(movedLead.ok).toBe(true)
  expect(await evalStore<string>('(s) => s.shot().camera.trackEntityId')).toBe(lead)

  // No entityId and nothing selected: a vehicle, never the street kit.
  await evalStore('(s) => s.setSelection(null)')
  expect((await rpc('apply_camera_move', { presetId: 'follow-behind' })).ok).toBe(true)
  const tracked = await evalStore<string>('(s) => s.scene().entities.find((e) => e.id === s.shot().camera.trackEntityId)?.assetId')
  expect(tracked).toMatch(/^vehicle\./)
})

test('apply_camera_move with an unknown entity names the id and get_state', async () => {
  const res = await rpc('apply_camera_move', { presetId: 'follow-behind', entityId: 'ent_nope' })
  expect(res.ok).toBe(false)
  expect(res.error).toContain('ent_nope')
  expect(res.error).toContain('get_state')
})

test('two labelled add_entity calls get different colours', async () => {
  const a = await rpc<{ entityId: string; color: string }>('add_entity', { assetId: 'person.man', x: -1, z: -3, label: 'A' })
  const b = await rpc<{ entityId: string; color: string }>('add_entity', { assetId: 'person.woman', x: 1, z: -3, label: 'B' })
  expect(a.ok && b.ok).toBe(true)
  expect(a.data?.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(b.data?.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(a.data?.color).not.toBe(b.data?.color)
})

test('set_lighting goldenHourSky shows in get_state', async () => {
  const res = await rpc<{ lighting: string; sunElevationDeg: number }>('set_lighting', { preset: 'goldenHourSky', sunElevationDeg: 12, fog: 0.3 })
  expect(res.ok).toBe(true)
  const state = await rpc<{ scene: { lighting: string; environment: { lighting: string; sunElevationDeg: number; fog: number } } }>('get_state')
  expect(state.data?.scene.environment.lighting).toBe('goldenHourSky')
  expect(state.data?.scene.environment.sunElevationDeg).toBe(12)
  expect(state.data?.scene.environment.fog).toBeCloseTo(0.3)
  const bad = await rpc('set_lighting', { preset: 'sunset' })
  expect(bad.ok).toBe(false)
  expect(bad.error).toContain('goldenHourSky')
})

test('set_entity_style color red gives #e5484d', async () => {
  const placed = await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: 0, z: -5 })
  const id = placed.data!.entityId
  const res = await rpc<{ color: string; label: string; heightScale: number; hideInExports: boolean }>('set_entity_style', {
    entityId: id,
    color: 'red',
    label: 'VILLAIN',
    heightScale: 9,
    hideInExports: true
  })
  expect(res.ok).toBe(true)
  expect(res.data?.color).toBe('#e5484d')
  expect(res.data?.label).toBe('VILLAIN')
  expect(res.data?.heightScale).toBe(1.5)
  expect(res.data?.hideInExports).toBe(true)
  const bad = await rpc('set_entity_style', { entityId: id, color: 'banana' })
  expect(bad.ok).toBe(false)
  expect(bad.error).toContain('banana')
})

test('set_camera_rig shows in get_state', async () => {
  const res = await rpc<{ rig: string; intensity: number }>('set_camera_rig', { rig: 'handheld', intensity: 0.6 })
  expect(res.data).toEqual({ rig: 'handheld', intensity: 0.6 })
  const state = await rpc<{ shot: { rig: string; rigIntensity: number } }>('get_state')
  expect(state.data?.shot.rig).toBe('handheld')
  const bad = await rpc('set_camera_rig', { rig: 'gimbal' })
  expect(bad.ok).toBe(false)
  expect(bad.error).toContain('steadicam')
})

test('new_scene then select_scene round-trips', async () => {
  const first = await rpc<{ scene: { id: string }; shot: { id: string } }>('get_state')
  const firstSceneId = first.data!.scene.id
  const created = await rpc<{ sceneId: string; shotId: string }>('new_scene', { name: 'Rooftop' })
  expect(created.ok).toBe(true)
  expect(created.data?.sceneId).not.toBe(firstSceneId)
  const state = await rpc<{ scene: { id: string; name: string }; allScenes: { id: string; shots: { id: string }[] }[] }>('get_state')
  expect(state.data?.scene.id).toBe(created.data?.sceneId)
  expect(state.data?.scene.name).toBe('Rooftop')
  expect(state.data?.allScenes.length).toBe(2)
  const back = await rpc<{ sceneId: string }>('select_scene', { sceneId: firstSceneId })
  expect(back.data?.sceneId).toBe(firstSceneId)
  const shot = await rpc<{ shotId: string }>('select_shot', { shotId: created.data!.shotId })
  expect(shot.data?.shotId).toBe(created.data?.shotId)
  expect((await rpc<{ scene: { id: string } }>('get_state')).data?.scene.id).toBe(created.data?.sceneId)
  await rpc('select_scene', { sceneId: firstSceneId })
})

test('select_scene with a bad id gets an error mentioning get_state', async () => {
  const res = await rpc('select_scene', { sceneId: 'scene_nope' })
  expect(res.ok).toBe(false)
  expect(res.error).toContain('scene_nope')
  expect(res.error).toContain('get_state')
})

test.describe('marks, motion and history', () => {
  test.beforeAll(async () => {
    await rpc('clear_camera_marks')
    for (const [time, z] of [[3, 4], [0, 6], [1.5, 5]] as const) {
      await rpc('add_camera_mark', { x: 0, y: 1.6, z, panDeg: 0, tiltDeg: 0, time })
    }
  })

  test('list_marks camera returns ids sorted by time', async () => {
    const res = await rpc<{ id: string; time: number }[]>('list_marks', { lane: 'camera' })
    expect(res.ok).toBe(true)
    expect(res.data?.map((m) => m.time)).toEqual([0, 1.5, 3])
    expect(res.data?.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true)
  })

  test('update_mark moves a camera mark and list_marks shows it', async () => {
    const before = await rpc<{ id: string; time: number }[]>('list_marks', { lane: 'camera' })
    const first = before.data![0]!
    const res = await rpc<{ id: string; time: number; focalLength: number }>('update_mark', {
      lane: 'camera',
      markId: first.id,
      time: 2.5,
      focalLength: 50
    })
    expect(res.ok).toBe(true)
    const after = await rpc<{ id: string; time: number; focalLength: number }[]>('list_marks', { lane: 'camera' })
    expect(after.data?.map((m) => m.time)).toEqual([1.5, 2.5, 3])
    const moved = after.data?.find((m) => m.id === first.id)
    expect(moved?.time).toBe(2.5)
    expect(moved?.focalLength).toBe(50)
  })

  test('update_mark with an unknown markId names list_marks', async () => {
    const res = await rpc('update_mark', { lane: 'camera', markId: 'cmark_nope', time: 1 })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('cmark_nope')
    expect(res.error).toContain('list_marks')
    const lane = await rpc('list_marks', { lane: 'ent_nope' })
    expect(lane.ok).toBe(false)
    expect(lane.error).toContain('get_state')
  })

  test('delete_marks with one id leaves n-1 marks', async () => {
    const before = await rpc<{ id: string }[]>('list_marks', { lane: 'camera' })
    const n = before.data!.length
    const res = await rpc<{ deleted: number }>('delete_marks', { lane: 'camera', markIds: [before.data![1]!.id] })
    expect(res.data?.deleted).toBe(1)
    const after = await rpc<{ id: string }[]>('list_marks', { lane: 'camera' })
    expect(after.data?.length).toBe(n - 1)
  })

  test('apply_motion jab-cross on a man gives applied 1', async () => {
    const man = await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: 3, z: -2 })
    const res = await rpc<{ applied: number }>('apply_motion', { entityIds: [man.data!.entityId], presetId: 'jab-cross' })
    expect(res.ok).toBe(true)
    expect(res.data?.applied).toBe(1)
    const marks = await rpc<{ id: string }[]>('list_marks', { lane: man.data!.entityId })
    expect(marks.data?.length).toBeGreaterThan(0)
    const car = await rpc<{ entityId: string }>('add_entity', { assetId: 'vehicle.sedan', x: 6, z: -2 })
    const none = await rpc('apply_motion', { entityIds: [car.data!.entityId], presetId: 'jab-cross' })
    expect(none.ok).toBe(false)
    const bad = await rpc('apply_motion', { entityIds: [man.data!.entityId], presetId: 'moonwalk-9000' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('list_motion_presets')
  })

  test('undo reverts the last edit and redo restores it', async () => {
    await rpc('set_lighting', { preset: 'night' })
    await new Promise((r) => setTimeout(r, 900)) // past the store's 800 ms edit coalescing
    await rpc('set_camera_rig', { rig: 'drone' })
    const undone = await rpc('undo')
    expect(undone.ok).toBe(true)
    const state = await rpc<{ scene: { lighting: string }; shot: { rig: string } }>('get_state')
    expect(state.data?.shot.rig).not.toBe('drone')
    expect(state.data?.scene.lighting).toBe('night')
    expect((await rpc('redo')).ok).toBe(true)
    expect((await rpc<{ shot: { rig: string } }>('get_state')).data?.shot.rig).toBe('drone')
  })

  test('save_project writes the project file', async () => {
    const folder = await evalStore<string>('(s) => s.projectFolder')
    const res = await rpc<{ saved: boolean }>('save_project')
    expect(res.ok).toBe(true)
    expect(res.data?.saved).toBe(true)
    expect(existsSync(join(folder, 'project.json'))).toBe(true)
    expect(folder.startsWith(smokeDir)).toBe(true)
    expect(await evalStore<boolean>('(s) => s.dirty')).toBe(false)
  })
})

test.describe('export tools', () => {
  let shotName: string

  test.beforeAll(async () => {
    await rpc('new_scene', { name: 'Export check' })
    await rpc('add_entity', { assetId: 'person.man', x: 0, z: -3, label: 'HERO' })
    await rpc('set_shot', { duration: 1 })
    shotName = (await rpc<{ shot: { name: string } }>('get_state')).data!.shot.name
  })

  test('list_export_profiles lists seedance-2', async () => {
    const res = await rpc<{ id: string; name: string; maxDuration: number; fps: number }[]>('list_export_profiles')
    expect(res.ok).toBe(true)
    expect(res.data?.some((p) => p.id === 'seedance-2' && p.fps > 0 && p.maxDuration > 0)).toBe(true)
  })

  test('export_shot with defaults writes the package and returns its prompt', async () => {
    const res = await rpc<{ packagePath: string; relativePath: string; prompt: string }>('export_shot')
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    const pkg = res.data!.packagePath
    expect(pkg.startsWith(smokeDir)).toBe(true)
    expect(existsSync(join(pkg, `${shotName}_reference.mp4`))).toBe(true)
    expect(existsSync(join(pkg, `${shotName}_depth.mp4`))).toBe(true)
    expect(existsSync(join(pkg, 'prompt.txt'))).toBe(true)
    expect(res.data!.relativePath.startsWith('exports/')).toBe(true)
    expect(res.data!.relativePath).not.toContain('\\')
    expect(res.data!.prompt).toBe(readFileSync(join(pkg, 'prompt.txt'), 'utf-8').trim())
  })

  test('export_shot with an unknown profile names list_export_profiles', async () => {
    const res = await rpc('export_shot', { profileId: 'nope' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('nope')
    expect(res.error).toContain('list_export_profiles')
  })

  test('two export_shot calls at once: one runs, one is refused', async () => {
    const both = await Promise.all([
      rpc('export_shot', { passes: { clean: true, depth: false, normal: false } }),
      rpc('export_shot', { passes: { clean: true, depth: false, normal: false } })
    ])
    expect(both.filter((r) => r.ok).length).toBe(1)
    const refused = both.find((r) => !r.ok)
    expect(refused?.error).toContain('An export is already running.')
    // The app stays usable afterwards.
    expect((await rpc('get_state')).ok).toBe(true)
  })

  test('export_frame, export_contact_sheet and export_scene_animatic write files', async () => {
    const frame = await rpc<{ path: string }>('export_frame', { resolution: '720p' })
    expect(frame.ok).toBe(true)
    expect(existsSync(frame.data!.path)).toBe(true)
    const sheet = await rpc<{ path: string }>('export_contact_sheet')
    expect(sheet.ok).toBe(true)
    expect(existsSync(sheet.data!.path)).toBe(true)
    const animatic = await rpc<{ path: string }>('export_scene_animatic', { resolution: '720p' })
    expect(animatic.error).toBeUndefined()
    expect(existsSync(animatic.data!.path)).toBe(true)
  })

  test('edits during a running export_shot are refused, reads still work', async () => {
    await rpc('set_shot', { duration: 3 })
    const before = (await rpc<{ scene: { lighting: string; entities: unknown[] } }>('get_state')).data!.scene
    const exporting = rpc('export_shot')
    await expect
      .poll(() => evalStore<boolean>('(s) => s.exportProgress.running'), { intervals: [25] })
      .toBe(true)
    const lighting = await rpc('set_lighting', { preset: before.lighting === 'night' ? 'day' : 'night' })
    const placed = await rpc('add_entity', { assetId: 'person.woman', x: 2, z: -4, label: 'LATE' })
    const read = await rpc('get_state')
    expect(await evalStore<boolean>('(s) => s.exportProgress.running')).toBe(true)
    expect((await exporting).ok).toBe(true)
    expect(lighting.ok).toBe(false)
    expect(lighting.error).toBe('An export is already running.')
    expect(placed.ok).toBe(false)
    expect(placed.error).toBe('An export is already running.')
    expect(read.ok).toBe(true)
    const after = (await rpc<{ scene: { lighting: string; entities: unknown[] } }>('get_state')).data!.scene
    expect(after.lighting).toBe(before.lighting)
    expect(after.entities.length).toBe(before.entities.length)
    await rpc('set_shot', { duration: 1 })
  })
})

test('a multi-selection never reaches exported pixels', async () => {
  await rpc('new_scene', { name: 'Selection chrome' })
  const a = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: -0.8, z: -3 })).data!.entityId
  const b = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.woman', x: 0.8, z: -3 })).data!.entityId
  expect((await rpc('apply_framing', { kind: '2S', entityIds: [a, b] })).ok).toBe(true)
  const report = await page.evaluate(`(async () => {
    const w = window
    const settle = () => new Promise((r) => setTimeout(r, 200))
    w.__blockout.store.getState().setSelection({ kind: 'entities', entityIds: ${JSON.stringify([a, b])} })
    await settle()
    const extraBoxes = w.__blockout_scene.extraSelectionBoxes.length
    const selected = w.__blockout.renderRawForTest(0.5, 320, 180)
    w.__blockout.store.getState().setSelection(null)
    await settle()
    const none = w.__blockout.renderRawForTest(0.5, 320, 180)
    let diffs = 0
    for (let i = 0; i < none.length; i++) if (selected[i] !== none[i]) diffs++
    return { extraBoxes, diffs, length: none.length }
  })()`) as { extraBoxes: number; diffs: number; length: number }
  expect(report.extraBoxes).toBeGreaterThan(0)
  expect(report.length).toBe(320 * 180 * 4)
  expect(report.diffs).toBe(0)
})

test('a selection never reaches the top-down blocking diagram', async () => {
  // Runs on the "Selection chrome" scene staged by the test above.
  await rpc('set_shot', { duration: 1 })
  const ids = (await rpc<{ scene: { entities: { id: string }[] } }>('get_state')).data!.scene.entities.map((e) => e.id)
  const topDown = async (): Promise<Buffer> => {
    const res = await rpc<{ packagePath: string }>('export_shot', { passes: { clean: true, depth: false }, resolution: '720p' })
    expect(res.error).toBeUndefined()
    const stills = join(res.data!.packagePath, 'stills')
    const file = readdirSync(stills).find((f) => f.endsWith('_topdown.png'))!
    return readFileSync(join(stills, file))
  }
  await evalStore(`(s) => s.setSelection({ kind: 'entities', entityIds: ${JSON.stringify(ids)} })`)
  await new Promise((r) => setTimeout(r, 200))
  expect(await evalStore<boolean>('() => { const g = window.__blockout_scene.transform; return !!g.object }')).toBe(true)
  const selected = await topDown()
  await evalStore('(s) => s.setSelection(null)')
  await new Promise((r) => setTimeout(r, 200))
  const none = await topDown()
  expect((await topDown()).equals(none)).toBe(true) // the diagram itself is deterministic
  expect(selected.equals(none)).toBe(true)
})
