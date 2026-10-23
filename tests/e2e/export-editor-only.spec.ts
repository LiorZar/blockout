/**
 * e2e (fork, qa-fixes; mocap-qa bug 6): the nightclub's coloured light cones
 * are blocking dressing. They stay in the editor's viewport but never reach
 * an export pass: a camera inside one was washed green, and the depth pass
 * drew them as solid cones a video model reads as pyramids.
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

/** Show or hide the nightclub's cones by hand (found by their look: open, translucent, 1.6 m by 4 m), and count them. */
async function cones(visible: boolean | null): Promise<{ n: number; visible: number }> {
  return (await page.evaluate(`(() => {
    const found = []
    window.__blockout_scene.scene.traverse((o) => {
      const g = o.geometry?.parameters
      if (o.isMesh && o.geometry.type === 'ConeGeometry' && g.openEnded && g.radius === 1.6 && g.height === 4 && o.material?.transparent) found.push(o)
    })
    if (${visible} !== null) for (const o of found) o.visible = ${visible}
    return { n: found.length, visible: found.filter((o) => o.visible).length }
  })()`)) as { n: number; visible: number }
}

/** Pixels that differ between a frame rendered as is and one with the cones hidden by hand. */
async function coneDiff(pass: 'clean' | 'depth'): Promise<number> {
  const frame = `window.__blockout.renderRawForTest(0, 320, 180, false, '${pass}')`
  await page.evaluate(`void (window.__asIs = ${frame})`)
  await cones(false)
  await page.evaluate(`void (window.__without = ${frame})`)
  await cones(true)
  return (await page.evaluate('window.__asIs.filter((v, k) => v !== window.__without[k]).length')) as number
}

test.beforeAll(async () => {
  const smokeDir = mkdtempSync(join(tmpdir(), 'blockout editor-only-'))
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

  expect((await rpc('add_entity', { assetId: 'env.nightclub', x: 0, z: 0 })).ok).toBe(true)
  await rpc('set_shot', { duration: 1 })
})

test.afterAll(async () => {
  await app?.close()
})

test('the nightclub light cones stay in the viewport but never reach an export pass', async () => {
  expect(await cones(null)).toEqual({ n: 4, visible: 4 })
  // A camera standing inside the cone over (5, −5) at t = 0, and one looking at the room.
  for (const mark of [
    { x: 5, y: 1.6, z: -5, panDeg: 0, tiltDeg: 0 },
    { x: 0, y: 1.7, z: 9, panDeg: 0, tiltDeg: -5 }
  ]) {
    expect((await rpc('clear_camera_marks')).ok).toBe(true)
    expect((await rpc('add_camera_mark', { ...mark, time: 0, focalLength: 24 })).ok).toBe(true)
    expect(await coneDiff('clean')).toBe(0)
    expect(await coneDiff('depth')).toBe(0)
  }
  // Still there for blocking.
  expect(await cones(null)).toEqual({ n: 4, visible: 4 })
})
