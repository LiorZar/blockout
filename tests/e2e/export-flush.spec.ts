/**
 * e2e for export determinism under GL flushes (docs/plans/2026-10-21-fix-topdown.md):
 * the browser may flush the GL command stream anywhere in a frame, and with
 * antialiasing a draw blending over an earlier antialiased edge (the shadow
 * catcher over a grid line) came out one level different when a flush fell
 * between the two. Flushing after every draw must not change any exported pixel.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
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

/** Flush GL after every object's draw (on) or restore the scene's own hooks (off). */
async function flushAfterEveryDraw(on: boolean): Promise<void> {
  await page.evaluate(`(() => {
    const w = window
    w.__flushHooks ??= new Map()
    w.__blockout_scene.scene.traverse((o) => {
      if (${on}) {
        if (!w.__flushHooks.has(o)) w.__flushHooks.set(o, o.onAfterRender)
        o.onAfterRender = (renderer) => renderer.getContext().flush()
      }
    })
    if (!${on}) {
      for (const [o, hook] of w.__flushHooks) o.onAfterRender = hook
      w.__flushHooks.clear()
    }
  })()`)
}

async function topDown(): Promise<Buffer> {
  const res = await rpc<{ packagePath: string }>('export_shot', { passes: { clean: true, depth: false }, resolution: '720p' })
  expect(res.error).toBeUndefined()
  const stills = join(res.data!.packagePath, 'stills')
  const file = readdirSync(stills).find((f) => f.endsWith('_topdown.png'))!
  return readFileSync(join(stills, file))
}

test.beforeAll(async () => {
  const smokeDir = mkdtempSync(join(tmpdir(), 'blockout flush-'))
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

  // Two people on the grid and a 2S camera: the shadow catcher blends over
  // grid lines and over the people's edges against the ground.
  const a = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: -0.8, z: -3 })).data!.entityId
  const b = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.woman', x: 0.8, z: -3 })).data!.entityId
  expect((await rpc('apply_framing', { kind: '2S', entityIds: [a, b] })).ok).toBe(true)
  await rpc('set_shot', { duration: 1 })
})

test.afterAll(async () => {
  await app?.close()
})

test('a GL flush after every draw never changes the top-down diagram', async () => {
  for (let i = 0; i < 3; i++) {
    const plain = await topDown()
    await flushAfterEveryDraw(true)
    const flushed = await topDown()
    await flushAfterEveryDraw(false)
    expect(flushed.equals(plain)).toBe(true)
  }
})

test('a GL flush after every draw never changes a clean frame', async () => {
  const frame = 'window.__blockout.renderRawForTest(0.5, 640, 360)'
  // Fork (export-look T4): on ANGLE / D3D11 the GPU's floats can move by one ulp from one moment to the
  // next (while the page composites, and as the GPU warms up after an idle gap), flipping a value now and
  // then (docs/plans/2026-10-23-export-look.md). A plain frame on each side of the flushed one tells
  // whether the GPU held still across the comparison; only such a comparison counts, and it is exact.
  await page.evaluate('window.__blockout_scene.suspendLive = true')
  try {
    for (let i = 0; i < 3; i++) {
      let compared = false
      for (let attempt = 0; attempt < 8 && !compared; attempt++) {
        await page.evaluate(`void (window.__plainFrame = ${frame})`)
        await flushAfterEveryDraw(true)
        await page.evaluate(`void (window.__flushedFrame = ${frame})`)
        await flushAfterEveryDraw(false)
        await page.evaluate(`void (window.__plainAfter = ${frame})`)
        if (!(await page.evaluate('window.__plainFrame.every((v, k) => v === window.__plainAfter[k])'))) continue
        compared = true
        const diffs = await page.evaluate('window.__plainFrame.filter((v, k) => v !== window.__flushedFrame[k]).length')
        expect(diffs).toBe(0)
      }
      expect(compared, 'the GPU held still across one of 8 comparisons').toBe(true)
    }
  } finally {
    await page.evaluate('window.__blockout_scene.suspendLive = false')
  }
})
