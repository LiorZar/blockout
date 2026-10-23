/**
 * e2e for bot fight solves off the main thread (fork, fight-speed;
 * docs/plans/2026-10-23-fight-speed.md): the built app reads the user's
 * local Mixamo library (as mocap-bots.spec.ts does), MCP stages a Y Bot vs
 * X Bot combos fight while the page records its long tasks and frames, and
 * the fight the worker solved is the fight the main thread solves. The bar
 * is the solve's: every main-thread task until the fight is committed (the
 * render's frames go on meanwhile); the commit and the first frames of the
 * new fight (its marks overlay, a shader's first use) are logged.
 * Skipped without the library (it is never in the repo).
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { resolveConfigPath } from '../../src/shared/config-paths'

const LIBRARY = resolveConfigPath('mixamo')
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))
const BOTS = ['person.mocapMale', 'person.mocapFemale']
const COMBOS = 'A double-jab-body-shot to body -> hit, hit, hit\nB boxing-combo to head -> slip, hit power 0.8\nA jab-hook-cross to head -> parry, hit power 0.8\nB elbow to head -> hit power 0.8\nA knee to body -> hit power 0.8'
/** The longest main-thread task allowed while a fight solves (ms), and the longest wait for a frame then. */
const LONG_TASK = 100
const FRAME_GAP = 250

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

/** The active scene's fight, its fighters' tracks and the shot, ids left out (each staging makes its own). */
async function stagedFight(): Promise<string> {
  return page.evaluate(() => {
    type Doc = { id: string; [k: string]: unknown }
    const st = (window as unknown as { __blockout: { store: { getState(): { scene(): { entities: (Doc & { label?: { text: string } })[]; fights?: (Doc & { fighterIds: string[] })[]; blocking: { id: string; tracks: { entityId: string; marks: Doc[] }[] }[] }; shot(): { blockingTakeId: string; duration: number } } } } }).__blockout.store.getState()
    const sc = st.scene()
    const label = (id: string): string => sc.entities.find((e) => e.id === id)?.label?.text ?? id
    const fight = sc.fights![sc.fights!.length - 1]!
    const take = sc.blocking.find((b) => b.id === st.shot().blockingTakeId)!
    return JSON.stringify({
      tracks: take.tracks.filter((t) => fight.fighterIds.includes(t.entityId)).map((t) => ({ who: label(t.entityId), marks: t.marks.map(({ id: _id, ...m }) => m) })),
      fight: { ...fight, id: null, fighterIds: fight.fighterIds.map(label) },
      duration: st.shot().duration
    })
  })
}

test.describe.configure({ mode: 'serial' })
test.skip(!HAS_LIBRARY, 'no local Mixamo library')

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout fight-worker-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  symlinkSync(LIBRARY, join(configDir, 'mixamo'), 'junction')
  const env = { ...process.env, BLOCKOUT_SMOKE_DIR: dir, BLOCKOUT_CONFIG_DIR: configDir, BLOCKOUT_MCP_PORT: String(await freePort()) } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (/^\[(mocap|fight)\]/.test(m.text())) logs.push(m.text())
  })
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible({ timeout: 30_000 })
  const discoveryFile = resolveConfigPath('control.json', { env })
  await expect.poll(() => existsSync(discoveryFile)).toBe(true)
  ;({ port, token } = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as { port: number; token: string })
  await expect.poll(() => logs.join('\n'), { timeout: 120_000 }).toMatch(/\[mocap\] library: 2 characters, \d+ clips/)
})

test.afterAll(async () => {
  await app?.close()
})

test.describe('bot fight solves off the main thread', () => {
  let worker = ''

  test('MCP stages a bot combos fight with the app live: no main-thread task over 100 ms while it solves', async () => {
    test.setTimeout(180_000)
    expect((await rpc('set_shot', { duration: 15 })).ok).toBe(true)
    // The bots drawn once first (their skinned meshes' shaders), away from the fight.
    for (const [k, assetId] of BOTS.entries()) expect((await rpc('add_entity', { assetId, x: 20 + k, z: 20 })).ok).toBe(true)
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
      const w = window as unknown as {
        __fw: { long: { start: number; ms: number }[]; frames: number[]; done: boolean; commit: number }
        __blockout: { store: { getState(): { doc: unknown }; subscribe(fn: (s: { doc: unknown }) => void): () => void } }
      }
      const rec: (typeof w)['__fw'] = { long: [], frames: [], done: false, commit: 0 }
      w.__fw = rec
      // The fight's commit: the first change to the document from here.
      const doc = w.__blockout.store.getState().doc
      const off = w.__blockout.store.subscribe((st) => {
        if (st.doc === doc) return
        rec.commit = performance.now()
        off()
      })
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) rec.long.push({ start: e.startTime, ms: e.duration })
      }).observe({ type: 'longtask' })
      const frame = (): void => {
        rec.frames.push(performance.now())
        if (!rec.done) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    const t0 = await page.evaluate(() => performance.now())
    const staged = await rpc<{ fightId: string; report: { beats: unknown[] } }>('stage_fight', { script: COMBOS, assets: BOTS, x: 0, z: -6 })
    expect(staged.ok, staged.error).toBe(true)
    expect(staged.data!.report.beats).toHaveLength(5)
    await page.waitForTimeout(500)
    const rec = await page.evaluate(() => {
      const r = (window as unknown as { __fw: { long: { start: number; ms: number }[]; frames: number[]; done: boolean; commit: number } }).__fw
      r.done = true
      return { ...r, now: performance.now() }
    })
    expect(rec.commit, 'the fight was committed').toBeGreaterThan(t0)
    // Until the commit: the solve. From it: the new fight's scene and first frames.
    const solving = rec.long.filter((x) => x.start >= t0 && x.start + x.ms <= rec.commit)
    const after = rec.long.filter((x) => x.start + x.ms > rec.commit)
    const frames = rec.frames.filter((f) => f >= t0 && f <= rec.commit)
    const gaps = frames.map((f, k) => (k > 0 ? f - frames[k - 1]! : f - t0))
    const list = (xs: { start: number; ms: number }[]): string => xs.map((x) => `${x.ms.toFixed(0)}@${(x.start - t0).toFixed(0)}`).join(' ') || 'none'
    console.log(`[fight-worker] committed after ${(rec.commit - t0).toFixed(0)} ms: ${frames.length} frames, worst gap ${Math.max(0, ...gaps).toFixed(0)} ms, longest task ${Math.max(0, ...solving.map((x) => x.ms)).toFixed(0)} ms (${solving.length} over 50 ms); commit and first frames: ${list(after)}`)
    expect(logs.filter((l) => l.startsWith('[fight]')), 'the worker says nothing went wrong').toEqual([])
    expect(Math.max(0, ...solving.map((x) => x.ms)), 'the longest main-thread task while the fight solves').toBeLessThanOrEqual(LONG_TASK)
    expect(Math.max(0, ...gaps), 'the longest wait for a frame while the fight solves').toBeLessThanOrEqual(FRAME_GAP)
    worker = await stagedFight()
  })

  test('the fight the worker solved is the fight the main thread solves', async () => {
    test.setTimeout(180_000)
    expect(worker).not.toBe('')
    const fight = JSON.parse(worker) as { fight: { beats: unknown[]; origin: { x: number; z: number; heading: number }; exaggeration: number }; tracks: { who: string }[] }
    expect((await rpc('new_scene', {})).ok).toBe(true)
    expect((await rpc('set_shot', { duration: 15 })).ok).toBe(true)
    // The same staging, its solves on the main thread (the store's own action, synchronous).
    await page.evaluate(
      ({ beats, at, assets, labels, exaggeration }) => {
        const st = (window as unknown as { __blockout: { store: { getState(): { stageFight(input: unknown): unknown } } } }).__blockout.store.getState()
        st.stageFight({ beats, at, assets, labels, exaggeration })
      },
      { beats: fight.fight.beats, at: fight.fight.origin, assets: BOTS, labels: fight.tracks.map((t) => t.who), exaggeration: fight.fight.exaggeration }
    )
    const here = JSON.parse(await stagedFight()) as { fight: { name: string } }
    const there = JSON.parse(worker) as { fight: { name: string } }
    here.fight.name = there.fight.name
    expect(JSON.stringify(here)).toBe(JSON.stringify(there))
  })
})
