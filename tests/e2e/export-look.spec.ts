/**
 * e2e (fork, export-look): an export's clean pass is the viewport's picture.
 * The viewport tone-maps (ACES, exposure 1.45); exports used to skip it, so a
 * clip came out flatter and darker than the editor (only the physical sky was
 * compensated). Here the viewport, in Deliver mode, draws a frame through the
 * shot camera; it is read back from the viewport's own GL and compared with the
 * export frame of the same camera, time and pixel size. The depth and normal
 * passes are data: they never take the look.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { resolveConfigPath } from '../../src/shared/config-paths'

let app: ElectronApplication
let page: Page
let port: number
let token: string

/** Export vs viewport: mean luminance (0–255) within this, and each 7×7 probe within PROBE levels per channel. */
const LUMA = 2
const PROBE = 6

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
  const json = (await res.json()) as Rpc<T>
  expect(json.error ?? '').toBe('')
  return json
}

interface Compared {
  exportLuma: number
  viewportLuma: number
  probeMax: number
}

/** The viewport's next shot-camera frame (Deliver mode) against the export frame at t, same pixel size. */
async function compare(t: number): Promise<Compared> {
  await page.evaluate(`(() => {
    const s = window.__blockout.store.getState()
    s.setSelection(null)
    s.setTime(${t})
    s.setMode('deliver')
  })()`)
  await page.waitForTimeout(1000)
  const res = (await page.evaluate(`(async () => {
    const viewport = () => new Promise((resolve) => {
      const m = window.__blockout_scene
      const r = m.renderer
      const orig = r.render
      r.render = function (scene, cam) {
        orig.call(this, scene, cam)
        if (cam !== m.shotCam) return
        r.render = orig
        const vp = { copy(v) { Object.assign(this, { x: v.x, y: v.y, z: v.z, w: v.w }); return this } }
        r.getCurrentViewport(vp)
        const gl = r.getContext()
        const px = new Uint8Array(vp.z * vp.w * 4)
        gl.readPixels(vp.x, vp.y, vp.z, vp.w, gl.RGBA, gl.UNSIGNED_BYTE, px)
        resolve({ w: vp.z, h: vp.w, px })
      }
    })
    const luma = (px) => {
      let s = 0
      for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
      return s / (px.length / 4)
    }
    const probe = (px, W, H, rx, ry) => {
      const cx = Math.round(rx * (W - 1))
      const cy = Math.round(ry * (H - 1))
      const acc = [0, 0, 0]
      let n = 0
      for (let y = cy - 3; y <= cy + 3; y++)
        for (let x = cx - 3; x <= cx + 3; x++) {
          const k = (y * W + x) * 4
          acc[0] += px[k]; acc[1] += px[k + 1]; acc[2] += px[k + 2]; n++
        }
      return acc.map((v) => v / n)
    }
    const first = await viewport()
    // The export frame at the viewport's size also sets the shot camera's aspect to it; then the viewport again.
    const ex = window.__blockout.renderRawForTest(${t}, first.w, first.h)
    const vp = await viewport()
    let probeMax = 0
    for (const [rx, ry] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.8], [0.5, 0.15], [0.15, 0.15], [0.85, 0.8], [0.1, 0.9], [0.9, 0.1]]) {
      const a = probe(ex, vp.w, vp.h, rx, ry)
      const b = probe(vp.px, vp.w, vp.h, rx, ry)
      for (let c = 0; c < 3; c++) probeMax = Math.max(probeMax, Math.abs(a[c] - b[c]))
    }
    return { exportLuma: luma(ex), viewportLuma: luma(vp.px), probeMax }
  })()`)) as Compared
  await page.evaluate(`window.__blockout.store.getState().setMode('stage')`)
  await page.waitForTimeout(300)
  return res
}

test.beforeAll(async () => {
  const smokeDir = mkdtempSync(join(tmpdir(), 'blockout export-look-'))
  const configDir = join(smokeDir, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = {
    ...process.env,
    BLOCKOUT_SMOKE_DIR: smokeDir,
    BLOCKOUT_CONFIG_DIR: configDir,
    BLOCKOUT_MCP_PORT: String(await freePort())
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
  await rpc('set_shot', { duration: 1 })
})

test.afterAll(async () => {
  await app?.close()
})

test('a day street exports as the viewport shows it', async () => {
  await rpc('add_entity', { assetId: 'env.cityStreet', x: 0, z: 0 })
  await rpc('set_lighting', { preset: 'day' })
  await rpc('add_entity', { assetId: 'person.man', x: -1, z: -2 })
  await rpc('add_entity', { assetId: 'person.woman', x: 1, z: -3 })
  await rpc('clear_camera_marks')
  await rpc('add_camera_mark', { x: 0, y: 1.6, z: 4, panDeg: 0, tiltDeg: -4, time: 0, focalLength: 28 })
  const c = await compare(0.5)
  expect(Math.abs(c.exportLuma - c.viewportLuma), JSON.stringify(c)).toBeLessThanOrEqual(LUMA)
  expect(c.probeMax, JSON.stringify(c)).toBeLessThanOrEqual(PROBE)
})

test('the physical sky is tone-mapped once, as in the viewport', async () => {
  await rpc('new_scene', { name: 'Sky' })
  await rpc('set_shot', { duration: 1 })
  await rpc('set_lighting', { preset: 'middaySky' })
  await rpc('add_entity', { assetId: 'person.man', x: 0, z: -3 })
  await rpc('clear_camera_marks')
  await rpc('add_camera_mark', { x: 0, y: 1.2, z: 2, panDeg: 0, tiltDeg: 8, time: 0, focalLength: 24 })
  const c = await compare(0.5)
  expect(Math.abs(c.exportLuma - c.viewportLuma), JSON.stringify(c)).toBeLessThanOrEqual(LUMA)
  expect(c.probeMax, JSON.stringify(c)).toBeLessThanOrEqual(PROBE)
})

test('the depth and normal passes stay linear: the look never reaches them', async () => {
  // Catch the export renderer, then render each pass at two exposures.
  const changed = (await page.evaluate(`(() => {
    const sm = window.__blockout_scene
    const orig = sm.renderFrameAt
    let renderer = null
    sm.renderFrameAt = function (r, ...rest) { renderer = r; return orig.call(this, r, ...rest) }
    window.__blockout.renderRawForTest(0.5, 160, 90)
    sm.renderFrameAt = orig
    const out = {}
    const was = renderer.toneMappingExposure
    for (const pass of ['clean', 'depth', 'normal']) {
      const a = window.__blockout.renderRawForTest(0.5, 160, 90, false, pass)
      renderer.toneMappingExposure = was * 3
      const b = window.__blockout.renderRawForTest(0.5, 160, 90, false, pass)
      renderer.toneMappingExposure = was
      out[pass] = a.filter((v, k) => v !== b[k]).length
    }
    return out
  })()`)) as Record<string, number>
  expect(changed.clean).toBeGreaterThan(1000)
  expect(changed.depth).toBe(0)
  expect(changed.normal).toBe(0)
})
