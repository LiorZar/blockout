/**
 * e2e for the fork's narrow layout (docs/plans/2026-10-19-fix-narrow.md):
 * docked beside Clara, Blockout is 650–950 px wide. Below the breakpoint the
 * viewport takes the full width, the side panels become overlays opened from
 * two titlebar toggles, and the titlebar stays on one line. At 1400 px
 * the layout is as before. At any width every panel folds away from its
 * titlebar toggle (Lior's test, 2026-10-24). Screenshots go to
 * $BLOCKOUT_VISUAL_DIR when it is set.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let app: ElectronApplication
let page: Page

const NARROW_WIDTHS = [650, 800, 950]
const WIDE_WIDTH = 1400

test.describe.configure({ mode: 'serial' })

async function resize(width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]!
    // Clara relaxes Blockout's 1100 px minimum the same way while docked.
    win.setMinimumSize(600, 700)
    win.setContentSize(w, 950)
  }, width)
  await expect.poll(() => page.evaluate('window.innerWidth')).toBe(width)
}

async function setMode(mode: 'stage' | 'shoot' | 'deliver'): Promise<void> {
  await page.evaluate(`window.__blockout.store.getState().setMode('${mode}')`)
}

async function snap(name: string): Promise<void> {
  const dir = process.env.BLOCKOUT_VISUAL_DIR
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`) })
}

async function width(selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox()
  return box ? box.width : 0
}

/** Every titlebar item is one line tall and inside the bar; nothing scrolls. */
async function expectOneLineTitlebar(): Promise<void> {
  const report = await page.evaluate(`(() => {
    const bar = document.querySelector('.titlebar')
    const b = bar.getBoundingClientRect()
    const bad = []
    for (const el of bar.querySelectorAll(':scope > *, button')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      const tall = el.tagName === 'BUTTON' && !el.closest('.mode-switch') ? r.height > 28 : r.height > 36
      if (tall || r.left < b.left - 0.5 || r.right > b.right + 0.5) bad.push((el.textContent || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))
    }
    return { bad, scroll: bar.scrollWidth, client: bar.clientWidth, height: Math.round(b.height) }
  })()`)
  expect(report).toMatchObject({ bad: [], height: 44 })
  const { scroll, client } = report as { scroll: number; client: number }
  expect(scroll).toBeLessThanOrEqual(client)
}

/** The element is visible, inside the window, and on top at its centre. */
async function expectReachable(selector: string, text: string): Promise<void> {
  const button = page.locator(selector).filter({ hasText: text }).first()
  await expect(button).toBeVisible()
  const onTop = await button.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return r.left >= 0 && r.right <= window.innerWidth && !!hit && el.contains(hit)
  })
  expect(onTop).toBe(true)
}

const leftToggle = (): ReturnType<Page['getByRole']> => page.getByRole('button', { name: 'Scenes & library panel' })
const rightToggle = (): ReturnType<Page['getByRole']> => page.getByRole('button', { name: 'Inspector panel' })
const timelineToggle = (): ReturnType<Page['getByRole']> => page.getByRole('button', { name: 'Timeline panel' })
const deliverToggle = (): ReturnType<Page['getByRole']> => page.getByRole('button', { name: 'Deliver panel' })

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout narrow-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = { ...process.env, BLOCKOUT_SMOKE_DIR: dir, BLOCKOUT_CONFIG_DIR: configDir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible({ timeout: 30_000 })
  await page.evaluate(`window.__blockout.store.getState().addEntity('person.man', { x: 0, z: -3 })`)
})

test.afterAll(async () => {
  await app?.close()
})

for (const w of NARROW_WIDTHS) {
  test(`${w} px: full-width viewport, one-line titlebar, panels behind toggles`, async () => {
    await resize(w)
    for (const mode of ['stage', 'shoot'] as const) {
      await setMode(mode)
      await expect(page.locator('.app')).toHaveClass(/\bnarrow\b/)
      expect((await width('.viewport-wrap')) / w).toBeGreaterThanOrEqual(0.99)
      await expect(page.locator('.main > .panel')).toHaveCount(2)
      await expect(page.locator('.main > .panel').first()).toBeHidden()
      await expect(page.locator('.main > .panel.right')).toBeHidden()
      await expectOneLineTitlebar()
      await expectReachable('.titlebar button', '?')
      if ('win32' === process.platform) await expectReachable('.titlebar button', 'Clara')
      await expect(timelineToggle()).toHaveCount('shoot' === mode ? 1 : 0)
      await snap(`${mode}-${w}`)

      await leftToggle().click()
      await expect(leftToggle()).toHaveAttribute('aria-pressed', 'true')
      const left = page.locator('.main > .panel').first()
      await expect(left).toBeVisible()
      await expect(left.getByText('Scenes & shots', { exact: false })).toBeVisible()
      if ('stage' === mode) await expect(left.locator('.library-item').first()).toBeVisible()
      await rightToggle().click()
      await expect(rightToggle()).toHaveAttribute('aria-pressed', 'true')
      const right = page.locator('.main > .panel.right')
      await expect(right).toBeVisible()
      await expect(right.getByRole('button', { name: 'Selection' })).toBeVisible()
      for (const panel of [left, right]) {
        const box = (await panel.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(w + 0.5)
      }
      // Overlays float above the viewport: it keeps its full width.
      expect((await width('.viewport-wrap')) / w).toBeGreaterThanOrEqual(0.99)
      await snap(`${mode}-${w}-open`)

      await leftToggle().click()
      await rightToggle().click()
      await expect(left).toBeHidden()
      await expect(right).toBeHidden()
    }

    await setMode('deliver')
    await expect(leftToggle()).toHaveCount(0)
    await expect(rightToggle()).toHaveCount(0)
    await expect(deliverToggle()).toHaveAttribute('aria-pressed', 'true')
    const preview = await width('.deliver-preview')
    expect(preview / w).toBeGreaterThanOrEqual(0.55)
    expect(preview).toBeGreaterThan(await width('.deliver-panel'))
    await expectOneLineTitlebar()
    await snap(`deliver-${w}`)
    await deliverToggle().click()
    await expect(page.locator('.deliver-panel')).toBeHidden()
    expect(await width('.deliver-preview')).toBe(w)
    await deliverToggle().click()
    await expect(page.locator('.deliver-panel')).toBeVisible()
    await setMode('stage')
  })
}

test('650 px: the longest Clara label still fits on one line', async () => {
  test.skip('win32' !== process.platform, 'the Clara button is Windows-only')
  await resize(650)
  // Clicking would launch the Clara installed here; relabel the button the
  // way it reads while Clara is docked.
  const clara = page.locator('.titlebar button').filter({ hasText: 'Clara' })
  await clara.evaluate((el) => {
    el.firstChild!.nodeValue = 'Close Clara'
  })
  await expectOneLineTitlebar()
  await expectReachable('.titlebar button', 'Close Clara')
  await snap('stage-650-close-clara')
  await clara.evaluate((el) => {
    el.firstChild!.nodeValue = 'Clara'
  })
})

test('650 px: picking a Library item closes the overlay so the floor is clickable', async () => {
  await resize(650)
  await setMode('stage')
  await leftToggle().click()
  const left = page.locator('.main > .panel').first()
  await left.locator('.library-item').first().click()
  await expect(left).toBeHidden()
  await expect(leftToggle()).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate('window.__blockout.store.getState().placingAssetId')).toBeTruthy()
  await page.keyboard.press('Escape')
})

test(`${WIDE_WIDTH} px: the docked layout is unchanged`, async () => {
  await resize(WIDE_WIDTH)
  for (const mode of ['stage', 'shoot'] as const) {
    await setMode(mode)
    await expect(page.locator('.app')).not.toHaveClass(/\bnarrow\b/)
    await expect(leftToggle()).toHaveAttribute('aria-pressed', 'true')
    await expect(rightToggle()).toHaveAttribute('aria-pressed', 'true')
    expect(await width('.main > .panel')).toBe(200)
    expect(await width('.main > .panel.right')).toBe(264)
    expect(await width('.viewport-wrap')).toBe(WIDE_WIDTH - 464)
    await expectOneLineTitlebar()
    await expect(page.locator('.titlebar .app-name')).toBeVisible()
    await expect(page.locator('.titlebar button').filter({ hasText: '? Help' })).toBeVisible()
    await snap(`${mode}-${WIDE_WIDTH}`)
  }
  await setMode('deliver')
  expect(await width('.deliver-panel')).toBe(380)
  await snap(`deliver-${WIDE_WIDTH}`)
  await setMode('stage')
})

test(`${WIDE_WIDTH} px: every panel folds away and the stage takes the window`, async () => {
  await resize(WIDE_WIDTH)
  await setMode('shoot')
  const before = (await page.locator('.viewport-wrap').boundingBox())!
  await leftToggle().click()
  await expect(page.locator('.main > .panel').first()).toBeHidden()
  expect(await width('.viewport-wrap')).toBe(WIDE_WIDTH - 264)
  await rightToggle().click()
  await expect(page.locator('.main > .panel.right')).toBeHidden()
  expect(await width('.viewport-wrap')).toBe(WIDE_WIDTH)
  await timelineToggle().click()
  await expect(page.locator('.timeline')).toBeHidden()
  const stageOnly = (await page.locator('.viewport-wrap').boundingBox())!
  expect(stageOnly.height).toBeGreaterThan(before.height + 100)
  await expectOneLineTitlebar()
  await snap(`shoot-${WIDE_WIDTH}-stage-only`)
  // The folds hold across the modes; Deliver's panel folds on its own.
  await setMode('stage')
  expect(await width('.viewport-wrap')).toBe(WIDE_WIDTH)
  await setMode('deliver')
  await deliverToggle().click()
  expect(await width('.deliver-preview')).toBe(WIDE_WIDTH)
  await snap(`deliver-${WIDE_WIDTH}-folded`)
  await deliverToggle().click()
  expect(await width('.deliver-panel')).toBe(380)
  await setMode('shoot')
  for (const toggle of [leftToggle(), rightToggle(), timelineToggle()]) await toggle.click()
  await expect(page.locator('.timeline')).toBeVisible()
  expect(await width('.viewport-wrap')).toBe(WIDE_WIDTH - 464)
  await setMode('stage')
})
