/**
 * e2e for qa-export B5/B6 (docs/plans/2026-10-19-fix-placement.md), clicking
 * the real UI: a just-placed set kit stays selected with its gizmo under the
 * cursor. An armed Fight Director placement must still stage on the next floor
 * click at that spot, and Follow Behind must be built around a fighter, not
 * the selected set. With nothing armed the gizmo still owns its drag.
 * Screenshots go to $BLOCKOUT_VISUAL_DIR when it is set.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'

let app: ElectronApplication
let page: Page

type St = {
  entities: { id: string; assetId: string; name: string; x: number; z: number }[]
  fights: { fighterIds: string[] }[]
  selected: string[]
  armed: boolean
  trackEntityId: string | null
}

async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const p = (srv.address() as net.AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return p
}

async function state(): Promise<St> {
  return (await page.evaluate(`(() => {
    const s = window.__blockout.store.getState()
    const sel = s.selection
    return {
      entities: s.scene().entities.map((e) => ({ id: e.id, assetId: e.assetId, name: e.name, x: e.transform.position.x, z: e.transform.position.z })),
      fights: (s.scene().fights || []).map((f) => ({ fighterIds: f.fighterIds })),
      selected: sel && sel.kind === 'entity' ? [sel.entityId] : sel && sel.kind === 'entities' ? sel.entityIds : [],
      armed: !!(s.placingAssetId || s.placingSequence || s.placingChoreography),
      trackEntityId: s.shot().camera.trackEntityId || null
    }
  })()`)) as St
}

const gizmo = (): Promise<{ axis: string | null; enabled: boolean }> =>
  page.evaluate('({ axis: window.__blockout_scene.transform.axis, enabled: window.__blockout_scene.transform.enabled })') as Promise<{
    axis: string | null
    enabled: boolean
  }>

async function snap(name: string): Promise<void> {
  const dir = process.env.BLOCKOUT_VISUAL_DIR
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`) })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout placement-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = {
    ...process.env,
    BLOCKOUT_SMOKE_DIR: dir,
    BLOCKOUT_CONFIG_DIR: configDir,
    BLOCKOUT_MCP_PORT: String(await freePort())
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close()
})

test('a fight placement wins over the set gizmo; Follow Behind targets a fighter; the gizmo still drags', async () => {
  const box = (await page.locator('.viewport-wrap canvas').boundingBox())!
  const at = (fx: number, fy: number): { x: number; y: number } => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const spot = at(0.5, 0.62)

  // 1. Library → Downtown → floor click: the kit is placed and stays selected.
  await page.locator('.library-item', { has: page.locator('.name', { hasText: /^Downtown$/ }) }).first().click()
  await page.mouse.click(spot.x, spot.y)
  await expect.poll(async () => (await state()).entities.filter((e) => e.assetId === 'env.downtown').length).toBe(1)
  const kit = (await state()).entities.find((e) => e.assetId === 'env.downtown')!
  expect((await state()).selected).toEqual([kit.id])
  // Its gizmo is under the cursor: this is the click qa-export saw swallowed.
  await page.mouse.move(spot.x + 3, spot.y)
  await page.mouse.move(spot.x, spot.y)
  await expect.poll(async () => (await gizmo()).axis).toBeTruthy()
  await snap('placement-1-kit-gizmo')

  // 2. Choreographer → Fight → Stage fight arms the placement and disables the gizmo.
  const choreo = page.locator('.panel-section', { has: page.locator('.panel-title', { hasText: /^Choreographer$/ }) }).first()
  await choreo.locator('select').first().selectOption({ label: '🥋 Fight' })
  await choreo.getByRole('button', { name: /Stage fight/ }).click()
  expect((await state()).armed).toBe(true)
  expect((await gizmo()).enabled).toBe(false)

  // 3. Click the same floor spot: the fight is staged there; the set didn't move.
  await page.mouse.click(spot.x, spot.y)
  await expect.poll(async () => (await state()).fights.length).toBe(1)
  let st = await state()
  const fighterIds = st.fights[0]!.fighterIds
  expect(st.armed).toBe(false)
  expect(st.selected).toEqual(fighterIds)
  const kitAfter = st.entities.find((e) => e.id === kit.id)!
  expect([kitAfter.x, kitAfter.z]).toEqual([kit.x, kit.z])
  for (const id of fighterIds) {
    const f = st.entities.find((e) => e.id === id)!
    expect(Math.hypot(f.x - kit.x, f.z - kit.z)).toBeLessThan(3)
  }
  expect((await gizmo()).enabled).toBe(true)
  await snap('placement-2-fight-staged')

  // 4. Select the set again, as a user would to move it: click it away from the fighters.
  const selectKit = async (): Promise<void> => {
    for (const [fx, fy] of [[0.15, 0.85], [0.85, 0.85], [0.1, 0.55], [0.9, 0.55], [0.3, 0.95], [0.7, 0.95]] as const) {
      const p = at(fx, fy)
      await page.mouse.click(p.x, p.y)
      if ((await state()).selected[0] === kit.id) return
    }
  }
  await selectKit()
  expect((await state()).selected).toEqual([kit.id])

  // 5. Inspector → 🎥 Camera → Follow Behind → Apply move: built around a fighter.
  await page.getByRole('button', { name: '🎥 Camera' }).click()
  const moves = page.locator('.panel-section', { has: page.locator('.panel-title', { hasText: /^Camera moves$/ }) }).first()
  await moves.locator('select').selectOption({ label: 'Follow Behind' })
  await expect(moves.locator('label').first()).not.toContainText('Downtown')
  await moves.getByRole('button', { name: 'Apply move' }).click()
  await expect.poll(async () => (await state()).trackEntityId).not.toBeNull()
  st = await state()
  expect(fighterIds).toContain(st.trackEntityId)
  const toast = page.locator('.toast', { hasText: 'Follow Behind on' }).last()
  await expect(toast).toBeVisible()
  await expect(toast).not.toContainText('Downtown')
  await snap('placement-3-follow-behind-fighter')

  // 6. Nothing armed: a drag on the set's gizmo still moves the set.
  await selectKit()
  expect((await state()).selected).toEqual([kit.id])
  await page.mouse.move(spot.x + 3, spot.y)
  await page.mouse.move(spot.x, spot.y)
  await expect.poll(async () => (await gizmo()).axis).toBeTruthy()
  await page.mouse.down()
  await page.mouse.move(spot.x + 40, spot.y + 10, { steps: 8 })
  await page.mouse.up()
  st = await state()
  expect(st.selected).toEqual([kit.id])
  const moved = st.entities.find((e) => e.id === kit.id)!
  expect(Math.hypot(moved.x - kit.x, moved.z - kit.z)).toBeGreaterThan(0.1)
  await snap('placement-4-gizmo-drag')
})
