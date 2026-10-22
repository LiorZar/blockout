/**
 * e2e for the mocap library load race (qa-fixes, mocap-qa bug 3;
 * docs/plans/2026-10-23-qa-fixes.md): the bots' bodies load before their 96
 * clips, so a bot fight staged in between used to solve on keyframe moves and
 * keep them. Here the clip reads are held back in the main process; the bots
 * are listed, get_state says the library isn't ready, and stage_fight waits
 * for the clips, so its beats play them. Skipped without the local library
 * (it is never in the repo); nothing from it is written into the repo.
 */
import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { resolveConfigPath } from '../../src/shared/config-paths'

const LIBRARY = resolveConfigPath('mixamo')
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))

let app: ElectronApplication
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

test.describe.configure({ mode: 'serial' })
test.skip(!HAS_LIBRARY, 'no local Mixamo library')

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout mocap-race-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  symlinkSync(LIBRARY, join(configDir, 'mixamo'), 'junction')
  const env = { ...process.env, BLOCKOUT_SMOKE_DIR: dir, BLOCKOUT_CONFIG_DIR: configDir, BLOCKOUT_MCP_PORT: String(await freePort()) } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  // Hold each clip read back 250 ms (the two bodies load at once): the clips take half a minute to come in.
  // After the app is ready, so main's own handler is registered first (a second registration throws).
  await app.evaluate(async ({ app: main, ipcMain }) => {
    await main.whenReady()
    const g = globalThis as unknown as { __mocapRead?: (e: unknown, p: string) => Promise<ArrayBuffer> }
    const fs = process.mainModule!.require('fs/promises') as typeof import('fs/promises')
    const path = process.mainModule!.require('path') as typeof import('path')
    const dirOf = (): string => path.join(process.env.BLOCKOUT_CONFIG_DIR!, 'mixamo')
    g.__mocapRead = async (_e, p) => {
      if (p.startsWith('clips/')) await new Promise((r) => setTimeout(r, 250))
      const data = await fs.readFile(path.join(dirOf(), p))
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    }
    ipcMain.removeHandler('mocap:read')
    ipcMain.handle('mocap:read', (e, p: string) => g.__mocapRead!(e, p))
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible({ timeout: 30_000 })
  const discoveryFile = resolveConfigPath('control.json', { env })
  await expect.poll(() => existsSync(discoveryFile), { timeout: 30_000 }).toBe(true)
  ;({ port, token } = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as { port: number; token: string })
})

test.afterAll(async () => {
  await app?.close()
})

type State = { mocap: { ready: boolean; bots: string[]; clips: number } }
type Fight = { report: { beats: { plays: string }[] } }

test('get_state says the library is still loading while the bots are listed', async () => {
  await expect
    .poll(async () => JSON.stringify((await rpc<{ id: string }[]>('list_assets', { category: 'people' })).data ?? []), { timeout: 60_000 })
    .toContain('person.mocapFemale')
  const st = await rpc<State>('get_state')
  expect(st.ok).toBe(true)
  expect(st.data!.mocap.ready).toBe(false)
  expect(st.data!.mocap.bots).toEqual(expect.arrayContaining(['person.mocapMale', 'person.mocapFemale']))
})

test('a bot fight staged while the clips load waits for them and plays them', async () => {
  test.setTimeout(240_000)
  const r = await rpc<Fight>('stage_fight', {
    script: 'A jab cross to head -> block, hit\nB front kick to body -> hit',
    x: 0,
    z: -2,
    assets: ['person.mocapMale', 'person.mocapFemale'],
    labels: ['BRUNO', 'KIRA']
  })
  expect(r.ok, r.error).toBe(true)
  expect(r.data!.report.beats.map((b) => b.plays)).toEqual(['mocap:jabHead+cross', 'mocap:frontKick'])
  const st = await rpc<State>('get_state')
  expect(st.data!.mocap.ready).toBe(true)
  expect(st.data!.mocap.clips).toBeGreaterThan(50)
})
