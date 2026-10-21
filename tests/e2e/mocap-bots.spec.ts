/**
 * e2e for the mocap bots (docs/plans/2026-10-20-mocap-body.md): the built
 * app reads the user's local Mixamo library through a junction in a fresh
 * config dir, loads Y Bot / X Bot, renders them skinned in every pass, and
 * exports deterministically. Phase 2 (docs/plans/2026-10-20-mocap-clips.md):
 * the clips load, the motion library plays them on bots, and a bot playing
 * a clip exports deterministically. Phase 3 (docs/plans/2026-10-20-mocap-fights.md):
 * a bot fight says it is staging before its solve and reads back without
 * one, and a bot fight exports byte-identically twice. Skipped without the
 * library (it is never in the repo); nothing from it is written into the
 * repo.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { resolveConfigPath } from '../../src/shared/config-paths'

const LIBRARY = resolveConfigPath('mixamo')
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))

let app: ElectronApplication
let page: Page
let port: number
let token: string
const logs: string[] = []

async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const p = (srv.address() as net.AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return p
}

type Rpc<T> = { ok: boolean; data?: T; error?: string }

async function rpc<T>(action: string, params: Record<string, unknown> = {}): Promise<Rpc<T>> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, params })
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Rpc<T>
}

test.describe.configure({ mode: 'serial' })
test.skip(!HAS_LIBRARY, 'no local Mixamo library')

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout mocap-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  symlinkSync(LIBRARY, join(configDir, 'mixamo'), 'junction')
  const env = { ...process.env, BLOCKOUT_SMOKE_DIR: dir, BLOCKOUT_CONFIG_DIR: configDir, BLOCKOUT_MCP_PORT: String(await freePort()) } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.text().startsWith('[mocap]')) logs.push(m.text())
  })
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible({ timeout: 30_000 })
  const discoveryFile = resolveConfigPath('control.json', { env })
  await expect.poll(() => existsSync(discoveryFile)).toBe(true)
  ;({ port, token } = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as { port: number; token: string })
})

test.afterAll(async () => {
  await app?.close()
})

/** Count and horizontal span of depth pixels brighter than `min` in the top half (rows above the horizon). */
function upperSpan(px: number[], w: number, h: number, min = 24): { count: number; width: number } {
  let lo = w
  let hi = -1
  let count = 0
  // readPixels rows run bottom-up: the top half is rows h/2..h-1.
  for (let y = Math.ceil(h / 2); y < h; y++)
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4]! <= min) continue
      count++
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
  return { count, width: hi >= lo ? hi - lo + 1 : 0 }
}

test.describe('mocap bots', () => {
  let bot = ''

  test('the library loads both bots and logs their bones and clips', async () => {
    await expect.poll(() => logs.join('\n'), { timeout: 120_000 }).toMatch(/\[mocap\] library: 2 characters, \d+ clips/)
    expect(logs.join('\n')).toMatch(/\[mocap\] .+ as person\.mocapMale: \d+ bones/)
    expect(logs.join('\n')).toMatch(/\[mocap\] .+ as person\.mocapFemale: \d+ bones/)
  })

  test('the pickers offer the bots and default to them', async () => {
    const people = await rpc<{ id: string }[]>('list_assets', { category: 'people' })
    expect(people.data!.map((a) => a.id)).toEqual(expect.arrayContaining(['person.mocapMale', 'person.mocapFemale']))
    // Library tiles.
    await expect(page.locator('.library-item .name', { hasText: 'Mocap man' })).toHaveCount(1)
    await expect(page.locator('.library-item .name', { hasText: 'Mocap woman' })).toHaveCount(1)
    // Choreographer and Fight Director bodies.
    const routine = page.locator('.panel-section', { hasText: 'Choreographer' }).locator('select').first()
    await routine.selectOption('dance')
    await expect(page.locator('select[title^="Who Spawn routine casts"]')).toHaveValue('mocap')
    await routine.selectOption('fight')
    await expect(page.locator('select[title^="What Stage fight spawns"]')).toHaveValue('mocap')
    await page.locator('.panel-section', { hasText: 'Choreographer' }).locator('select').first().selectOption('dance')
    // A routine spawned with the bots casts them.
    const cast = await page.evaluate(() => {
      const store = (window as unknown as { __blockout: { store: { getState(): { spawnChoreography(spec: unknown, at: unknown): void; scene(): { entities: { assetId: string }[] } } } } }).__blockout.store
      const before = store.getState().scene().entities.length
      store.getState().spawnChoreography({ kind: 'dance', performers: 2, durationS: 4, seed: 3, style: 'hiphop', bodies: ['person.mocapMale', 'person.mocapFemale'] }, { x: 6, z: -6, heading: 0 })
      return store.getState().scene().entities.slice(before).map((e) => e.assetId)
    })
    expect(cast).toEqual(['person.mocapMale', 'person.mocapFemale'])
    expect((await rpc('undo')).ok).toBe(true)
  })

  test('a bot is a skinned character in the scene', async () => {
    const res = await rpc<{ entityId: string }>('add_entity', { assetId: 'person.mocapMale', x: 0, z: 0, rotationDeg: 180 })
    expect(res.ok, res.error).toBe(true)
    bot = res.data!.entityId
    const skinned = await page.evaluate((id) => {
      const sm = (window as unknown as { __blockout_scene: { visuals: Map<string, { built: { group: { traverse(f: (o: { isSkinnedMesh?: boolean }) => void): void } } }> } }).__blockout_scene
      let n = 0
      sm.visuals.get(id)!.built.group.traverse((o) => {
        if (o.isSkinnedMesh) n++
      })
      return n
    }, bot)
    expect(skinned).toBe(2)
    // The Inspector's Body list carries both bots.
    await page.evaluate((id) => {
      ;(window as unknown as { __blockout: { store: { getState(): { setSelection(s: unknown): void } } } }).__blockout.store.getState().setSelection({ kind: 'entity', entityId: id })
    }, bot)
    const body = page.locator('select[title^="The body this person renders"]')
    await expect(body).toHaveValue('person.mocapMale')
    await expect(body.locator('option[value="person.mocapFemale"]')).toHaveCount(1)
  })

  test('the depth pass shows the posed bot, not the bind pose', async () => {
    expect((await rpc('clear_camera_marks')).ok).toBe(true)
    expect((await rpc('add_camera_mark', { x: 0, y: 1.4, z: 4, panDeg: 0, tiltDeg: 0, time: 0, focalLength: 35 })).ok).toBe(true)
    const setArms = (raise: number): Promise<void> =>
      page.evaluate(
        ([id, r]) => {
          const store = (window as unknown as { __blockout: { store: { getState(): { mutate(l: string, f: (d: { scenes: { entities: { id: string; params?: Record<string, number> }[] }[] }) => void): void } } } }).__blockout.store
          store.getState().mutate('arms', (d) => {
            for (const s of d.scenes) for (const e of s.entities) if (e.id === id) e.params = { ...(e.params ?? {}), joint_shoulderLX: r as number, joint_shoulderRX: r as number }
          })
        },
        [bot, raise] as const
      )
    const depth = (): Promise<number[]> => page.evaluate(() => (window as unknown as { __blockout: { renderRawForTest(t: number, w: number, h: number, d: boolean, pass: string): number[] } }).__blockout.renderRawForTest(0, 320, 180, false, 'depth'))
    await setArms(0)
    const down = await depth()
    await setArms(-3)
    const up = await depth()
    let diffs = 0
    for (let i = 0; i < down.length; i += 4) if (down[i] !== up[i]) diffs++
    // Raising the arms changes the depth image (a bind-pose depth pass would ignore it) ...
    expect(diffs).toBeGreaterThan(300)
    // ... and arms hanging read narrow above the horizon (a T-pose would span about two thirds of the frame).
    const span = upperSpan(down, 320, 180)
    expect(span.count).toBeGreaterThan(200)
    expect(span.width / 320).toBeLessThan(0.3)
    expect(upperSpan(up, 320, 180).count).toBeGreaterThan(span.count)
    await setArms(0)
  })

  test('a double export of a walking bot is byte-identical', async () => {
    test.setTimeout(300_000)
    expect((await rpc('set_shot', { duration: 2 })).ok).toBe(true)
    expect((await rpc('add_actor_mark', { entityId: bot, x: -1.2, z: 0, time: 0, gait: 'walk' })).ok).toBe(true)
    expect((await rpc('add_actor_mark', { entityId: bot, x: 1.2, z: 0, time: 2, gait: 'walk' })).ok).toBe(true)
    const pkgs: string[] = []
    for (let k = 0; k < 2; k++) {
      const res = await rpc<{ packagePath: string }>('export_shot', { passes: { clean: true, depth: true, normal: false } })
      expect(res.ok, res.error).toBe(true)
      pkgs.push(res.data!.packagePath)
    }
    const ffmpeg = process.env.BLOCKOUT_FFMPEG || 'ffmpeg'
    for (const suffix of ['_reference.mp4', '_depth.mp4']) {
      const [a, b] = pkgs.map((p) => join(p, readdirSync(p).find((f) => f.endsWith(suffix))!))
      const md5 = (f: string): string => execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-f', 'framemd5', '-']).toString().replace(/^#.*$/gm, '')
      expect(md5(a!), suffix).toBe(md5(b!))
      expect(readFileSync(a!).equals(readFileSync(b!)), `${suffix} bytes`).toBe(true)
    }
  })

  test('the clips are sampled and the motion library plays them on bots (and keyframes on everyone else)', async () => {
    const [, total, sampled] = logs.join('\n').match(/library: 2 characters, (\d+) clips, (\d+) sampled/) ?? []
    expect(Number(total)).toBeGreaterThan(0)
    expect(Number(sampled)).toBe(Number(total))
    const presets = await rpc<{ id: string; mocap?: boolean; mocapOnly?: boolean }[]>('list_motion_presets')
    expect(presets.data!.find((p) => p.id === 'push-ups')?.mocap).toBe(true)
    expect(presets.data!.some((p) => p.id.startsWith('mocap-') && p.mocapOnly)).toBe(true)
    expect((await rpc('apply_motion', { entityIds: [bot], presetId: 'push-ups' })).ok).toBe(true)
    const marks = await rpc<{ clip?: { id: string; at: number } }[]>('list_marks', { lane: bot })
    expect(marks.ok, marks.error).toBe(true)
    expect(marks.data!.map((m) => m.clip?.id)).toEqual(['pushUp', 'pushUp'])
    const man = await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: 3, z: 0 })
    expect((await rpc('apply_motion', { entityIds: [man.data!.entityId], presetId: 'push-ups' })).ok).toBe(true)
    const manMarks = await rpc<{ clip?: unknown }[]>('list_marks', { lane: man.data!.entityId })
    expect(manMarks.data!.length).toBeGreaterThan(2)
    expect(manMarks.data!.every((m) => !m.clip)).toBe(true)
    const refused = await rpc('apply_motion', { entityIds: [man.data!.entityId], presetId: presets.data!.find((p) => p.mocapOnly)!.id })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/Mocap man/)
    expect((await rpc('delete_entity', { entityId: man.data!.entityId })).ok).toBe(true)
  })

  test('a bot sits down on a chair under it, and on the floor without one', async () => {
    expect((await rpc('set_shot', { duration: 8 })).ok).toBe(true)
    const sitMarks = async (): Promise<(string | undefined)[]> => {
      expect((await rpc('apply_motion', { entityIds: [bot], presetId: 'sit-down' })).ok).toBe(true)
      return (await rpc<{ clip?: { id: string } }[]>('list_marks', { lane: bot })).data!.map((m) => m.clip?.id)
    }
    expect(await sitMarks()).toEqual(['sitFloor', 'sitFloor'])
    const chair = await rpc<{ entityId: string }>('add_entity', { assetId: 'furniture.chair', x: 0, z: 0, rotationDeg: 180 })
    expect(chair.ok, chair.error).toBe(true)
    expect(await sitMarks()).toEqual(['standToSit', 'standToSit', 'sitChair', 'sitChair'])
    expect((await rpc('delete_entity', { entityId: chair.data!.entityId })).ok).toBe(true)
  })

  test('a double export of a bot dancing a clip run is byte-identical', async () => {
    test.setTimeout(300_000)
    expect((await rpc('set_shot', { duration: 3 })).ok).toBe(true)
    expect((await rpc('apply_motion', { entityIds: [bot], presetId: 'salsa-step' })).ok).toBe(true)
    const pkgs: string[] = []
    for (let k = 0; k < 2; k++) {
      const res = await rpc<{ packagePath: string; prompt: string }>('export_shot', { passes: { clean: true, depth: true, normal: false } })
      expect(res.ok, res.error).toBe(true)
      pkgs.push(res.data!.packagePath)
      expect(res.data!.prompt.toLowerCase()).toContain('salsa')
    }
    const ffmpeg = process.env.BLOCKOUT_FFMPEG || 'ffmpeg'
    for (const suffix of ['_reference.mp4', '_depth.mp4']) {
      const [a, b] = pkgs.map((p) => join(p, readdirSync(p).find((f) => f.endsWith(suffix))!))
      const md5 = (f: string): string => execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-f', 'framemd5', '-']).toString().replace(/^#.*$/gm, '')
      expect(md5(a!), suffix).toBe(md5(b!))
      expect(readFileSync(a!).equals(readFileSync(b!)), `${suffix} bytes`).toBe(true)
    }
  })

  test('a bot fight says it is staging, paints that, then solves; reading it back solves nothing', async () => {
    test.setTimeout(120_000)
    expect((await rpc('set_shot', { duration: 8 })).ok).toBe(true)
    // Watch for the notice, every frame, and the moment the store's stageFight starts.
    await page.evaluate(() => {
      const w = window as unknown as { __mfStage: { toastAt: number; stageAt: number; frames: number[]; done: boolean }; __blockout: { store: { getState(): Record<string, unknown>; setState(p: Record<string, unknown>): void } } }
      const rec = (w.__mfStage = { toastAt: 0, stageAt: 0, frames: [] as number[], done: false })
      const seen = (): void => {
        if (!rec.toastAt && Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent?.includes('Staging fight'))) rec.toastAt = performance.now()
      }
      new MutationObserver(seen).observe(document.body, { childList: true, subtree: true, characterData: true })
      const frame = (): void => {
        rec.frames.push(performance.now())
        if (!rec.done) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
      const store = w.__blockout.store
      const stage = store.getState().stageFight as (input: unknown) => unknown
      store.setState({
        stageFight: (input: unknown) => {
          rec.stageAt = performance.now()
          store.setState({ stageFight: stage })
          return stage(input)
        }
      })
    })
    const staged = await rpc<{ fightId: string; report: unknown }>('stage_fight', { script: 'A jab to head -> hit\nB hook to head -> block', assets: ['person.mocapMale', 'person.mocapFemale'], x: 12, z: -6 })
    expect(staged.ok, staged.error).toBe(true)
    const rec = await page.evaluate(() => {
      const r = (window as unknown as { __mfStage: { toastAt: number; stageAt: number; frames: number[]; done: boolean } }).__mfStage
      r.done = true
      return r
    })
    expect(rec.toastAt).toBeGreaterThan(0)
    expect(rec.stageAt).toBeGreaterThan(rec.toastAt)
    expect(rec.frames.some((f) => f > rec.toastAt && f < rec.stageAt), 'a frame between the notice and the solve').toBe(true)
    // get_fight reads the solution back: no solve (a bot solve takes a second or more).
    const t0 = Date.now()
    const read = await rpc<{ report: unknown }>('get_fight', { fightId: staged.data!.fightId })
    expect(read.ok, read.error).toBe(true)
    expect(Date.now() - t0).toBeLessThan(250)
    expect(read.data!.report).toEqual(staged.data!.report)
  })

  test('a double export of a bot fight on clips is byte-identical', async () => {
    test.setTimeout(300_000)
    expect((await rpc('new_scene', { name: 'Bot fight export' })).ok).toBe(true)
    const staged = await rpc<{ report: { beats: { plays: string }[] } }>('stage_fight', { script: 'A jab cross to head -> block, hit power 0.8\nB hook to head -> hit power 0.8', assets: ['person.mocapMale', 'person.mocapFemale'], x: 0, z: -4 })
    expect(staged.ok, staged.error).toBe(true)
    expect(staged.data!.report.beats.every((b) => b.plays.startsWith('mocap:'))).toBe(true)
    const pkgs: string[] = []
    for (let k = 0; k < 2; k++) {
      const res = await rpc<{ packagePath: string }>('export_shot', { passes: { clean: true, depth: true, normal: false } })
      expect(res.ok, res.error).toBe(true)
      pkgs.push(res.data!.packagePath)
    }
    const ffmpeg = process.env.BLOCKOUT_FFMPEG || 'ffmpeg'
    for (const suffix of ['_reference.mp4', '_depth.mp4']) {
      const [a, b] = pkgs.map((p) => join(p, readdirSync(p).find((f) => f.endsWith(suffix))!))
      const md5 = (f: string): string => execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-f', 'framemd5', '-']).toString().replace(/^#.*$/gm, '')
      expect(md5(a!), suffix).toBe(md5(b!))
      expect(readFileSync(a!).equals(readFileSync(b!)), `${suffix} bytes`).toBe(true)
    }
  })
})
