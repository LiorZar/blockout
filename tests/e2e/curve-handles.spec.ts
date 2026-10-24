/**
 * e2e for the fork's curve handles (Lior's test, 2026-10-24;
 * src/renderer/viewport/curve-handles.ts), with a real mouse: the selected
 * person's marks show knobs, dragging the middle mark's knob bends the path
 * live (the mark's handle is written while the button is held), the drag is
 * one undo step, and a double-click on the knob makes the mark automatic
 * again. Clara curves paths through the MCP: `handle` and `via` on
 * add_actor_mark / add_camera_mark / update_mark (null / [] straighten them),
 * over the control path and over the MCP HTTP transport Clara connects to.
 * Screenshots go to $BLOCKOUT_VISUAL_DIR when it is set.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resolveConfigPath } from '../../src/shared/config-paths'

let app: ElectronApplication
let page: Page
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

interface V3 {
  x: number
  y: number
  z: number
}

test.describe.configure({ mode: 'serial' })

async function snap(name: string): Promise<void> {
  const dir = process.env.BLOCKOUT_VISUAL_DIR
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`) })
}

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout curves-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = {
    ...process.env,
    BLOCKOUT_SMOKE_DIR: dir,
    BLOCKOUT_CONFIG_DIR: configDir,
    BLOCKOUT_MCP_PORT: String((mcpPort = await freePort()))
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
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

/** The middle mark's handle, as the document holds it. */
async function handle(): Promise<V3 | undefined> {
  return page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    const take = store.scene().blocking.find((b: any) => b.id === store.shot().blockingTakeId)
    const marks = [...take.tracks[0].marks].sort((a: any, b: any) => a.time - b.time)
    return marks[1].handle
  })
}

/** The person's x at a time: 0 on the straight first leg. */
async function xAt(t: number): Promise<number> {
  return page.evaluate((t) => {
    const sm = (window as any).__blockout_scene
    const store = (window as any).__blockout.store.getState()
    const id = store.scene().blocking.find((b: any) => b.id === store.shot().blockingTakeId).tracks[0].entityId
    return sm.evaluator.evaluate(t).entities.find((e: any) => e.entityId === id).position.x
  }, t)
}

/** Where the middle mark's outgoing knob is on screen. */
async function knobOnScreen(): Promise<{ x: number; y: number; set: boolean }> {
  return page.evaluate(() => {
    const sm = (window as any).__blockout_scene
    const store = (window as any).__blockout.store.getState()
    const take = store.scene().blocking.find((b: any) => b.id === store.shot().blockingTakeId)
    const marks = [...take.tracks[0].marks].sort((a: any, b: any) => a.time - b.time)
    const k = sm.handles.knobs.find((k: any) => k.markId === marks[1].id && k.side === 'out')
    const v = sm.freeCam.position.clone().set(k.at.x, k.at.y + 0.03, k.at.z).project(sm.freeCam)
    const rect = sm.canvas.getBoundingClientRect()
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, set: k.set }
  })
}

test('dragging a mark knob bends the path live, as one undo step; a double-click straightens it', async () => {
  await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    store.setMode('shoot')
    store.addEntity('person.man', { x: 0, y: 0, z: 0 })
    const id = store.scene().entities[store.scene().entities.length - 1].id
    store.setSelection({ kind: 'entity', entityId: id })
    store.setTime(0)
    // Marks at 0 s, 2 s and 4 s: down -Z, then a right-angle turn to +X.
    store.dropActorMark(id, { x: 0, y: 0, z: 0 })
    store.dropActorMark(id, { x: 0, y: 0, z: -6 })
    store.dropActorMark(id, { x: 6, y: 0, z: -6 })
    store.setTime(4)
    const sm = (window as any).__blockout_scene
    sm.freeCam.position.set(3, 16, 1)
    sm.controls.target.set(3, 0, -4)
    sm.controls.update()
  })
  await page.waitForTimeout(800)
  expect(await handle()).toBeUndefined()
  expect(Math.abs(await xAt(1))).toBeLessThan(1e-6)
  const knob = await knobOnScreen()
  expect(knob.set).toBe(false)
  await snap('curve-before')

  const undoBefore: number = await page.evaluate(() => (window as any).__blockout.store.getState().undoStack.length)
  await page.mouse.move(knob.x, knob.y)
  await page.mouse.down()
  await page.mouse.move(knob.x - 40, knob.y - 60, { steps: 12 })
  await page.waitForTimeout(200)
  // Live: the handle is in the document and the path bent while the button is held.
  const live = await handle()
  expect(live).toBeTruthy()
  expect(Math.abs(await xAt(1))).toBeGreaterThan(0.05)
  await snap('curve-drag-mid')
  await page.mouse.up()
  await page.waitForTimeout(300)
  await snap('curve-after')

  const after = (await handle())!
  // Dragged up-left on a top view: the outgoing handle points -Z, so the turn is rounded.
  expect(after.z).toBeLessThan(-0.5)
  expect(Math.abs(after.y)).toBeLessThan(1e-6)
  expect((await knobOnScreen()).set).toBe(true)
  const undoAfter: number = await page.evaluate(() => (window as any).__blockout.store.getState().undoStack.length)
  expect(undoAfter).toBe(undoBefore + 1)

  await page.evaluate(() => (window as any).__blockout.store.getState().undo())
  await page.waitForTimeout(200)
  expect(await handle()).toBeUndefined()
  await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    store.redo()
    const id = store.scene().entities[store.scene().entities.length - 1].id
    store.setSelection({ kind: 'entity', entityId: id })
  })
  await page.waitForTimeout(300)
  expect(await handle()).toBeTruthy()

  const set = await knobOnScreen()
  await page.mouse.dblclick(set.x, set.y)
  await page.waitForTimeout(300)
  expect(await handle()).toBeUndefined()
  expect(Math.abs(await xAt(1))).toBeLessThan(1e-6)
})

interface MarkOut {
  id: string
  time: number
  x: number
  z: number
  handle?: V3
  via?: V3[]
}

test('Clara curves paths: handle and via on the mark tools, null and [] straighten them', async () => {
  const id: string = await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    return store.scene().blocking.find((b: any) => b.id === store.shot().blockingTakeId).tracks[0].entityId
  })
  const marks = (await rpc<MarkOut[]>('list_marks', { lane: id })).data!
  expect(marks.map((m) => m.time)).toEqual([0, 2, 4])
  const middle = marks[1]!.id

  const bent = await rpc<MarkOut>('update_mark', { lane: id, markId: middle, handle: { x: 2, z: -2 } })
  expect(bent.ok).toBe(true)
  expect(bent.data?.handle).toEqual({ x: 2, y: 0, z: -2 })
  expect(Math.abs(await xAt(1))).toBeGreaterThan(0.05)
  const straight = await rpc<MarkOut>('update_mark', { lane: id, markId: middle, handle: null })
  expect(straight.data?.handle).toBeUndefined()
  expect(Math.abs(await xAt(1))).toBeLessThan(1e-6)

  // A last leg from (6, -6) to (6, 0) through a point off to the side.
  const added = await rpc('add_actor_mark', { entityId: id, x: 6, z: 0, time: 5, via: [{ x: 9, z: -3 }] })
  expect(added.ok).toBe(true)
  const last = (await rpc<MarkOut[]>('list_marks', { lane: id })).data!.at(-1)!
  expect(last.via).toEqual([{ x: 9, y: 0, z: -3 }])
  expect(await xAt(4.5)).toBeGreaterThan(6.5)
  await rpc('update_mark', { lane: id, markId: last.id, via: [] })
  expect((await rpc<MarkOut[]>('list_marks', { lane: id })).data!.at(-1)!.via).toBeUndefined()
  expect(await xAt(4.5)).toBeCloseTo(6, 6)

  const bad = await rpc('update_mark', { lane: id, markId: middle, handle: { x: 1 } })
  expect(bad.ok).toBe(false)
  expect(bad.error).toContain('handle must be {x, z}')

  // The camera: a dolly from z 5 to z -3 that swings out to +X.
  await rpc('clear_camera_marks')
  await rpc('add_camera_mark', { x: 0, y: 1.6, z: 5, panDeg: 0, tiltDeg: 0, time: 0, handle: { x: 4, z: -2 } })
  await rpc('add_camera_mark', { x: 0, y: 1.6, z: -3, panDeg: 0, tiltDeg: 0, time: 4 })
  const camX: number = await page.evaluate(() => (window as any).__blockout_scene.evaluator.evaluate(2).camera.position.x)
  expect(camX).toBeGreaterThan(0.5)
})

test('over MCP: the mark tools list handle and via, and update_mark curves and straightens a path', async () => {
  const id: string = await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    return store.scene().blocking.find((b: any) => b.id === store.shot().blockingTakeId).tracks[0].entityId
  })
  const client = new Client({ name: 'e2e-curves', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)))
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: T; error?: string }> => {
    const result = await client.callTool({ name, arguments: args })
    return JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
  }
  try {
    const listed = await client.listTools()
    for (const name of ['add_actor_mark', 'add_camera_mark', 'update_mark']) {
      const props = (listed.tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties
      expect(Object.keys(props), name).toEqual(expect.arrayContaining(['handle', 'via']))
    }
    const marks = (await call<MarkOut[]>('list_marks', { lane: id })).data!
    const middle = marks.find((m) => m.time === 2)!.id
    const bent = await call<MarkOut>('update_mark', { lane: id, markId: middle, handle: { x: 2, z: -2 } })
    expect(bent.ok).toBe(true)
    expect(bent.data?.handle).toEqual({ x: 2, y: 0, z: -2 })
    expect(Math.abs(await xAt(1))).toBeGreaterThan(0.05)
    const straight = await call<MarkOut>('update_mark', { lane: id, markId: middle, handle: null })
    expect(straight.ok).toBe(true)
    expect(straight.data?.handle).toBeUndefined()
    expect(Math.abs(await xAt(1))).toBeLessThan(1e-6)
  } finally {
    await client.close()
  }
})
