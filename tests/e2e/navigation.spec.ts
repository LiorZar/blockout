/**
 * e2e for the fork's viewport navigation (Lior's test, 2026-10-24;
 * src/renderer/viewport/navigation.ts), with a real mouse and keyboard: the
 * left button only picks, middle-drag orbits, Alt + middle-drag pans across
 * the floor, Shift + middle-drag moves the view up and down, the wheel zooms,
 * W A S D / Q E fly while the pointer is over the viewport, and a drag of the
 * shot camera's body moves the shot camera live (the PiP follows the drag).
 * Screenshots go to $BLOCKOUT_VISUAL_DIR when it is set.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let app: ElectronApplication
let page: Page

interface V3 {
  x: number
  y: number
  z: number
}
interface View {
  cam: V3
  target: V3
}

test.describe.configure({ mode: 'serial' })

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z)

async function snap(name: string): Promise<void> {
  const dir = process.env.BLOCKOUT_VISUAL_DIR
  await page.screenshot({ path: dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`) })
}

/** The free camera back at its start pose, settled (no damping left over). */
async function resetView(): Promise<void> {
  await page.evaluate(() => {
    const sm = (window as any).__blockout_scene
    sm.freeCam.position.set(9, 7, 9)
    sm.controls.target.set(0, 1, 0)
    sm.controls.update()
  })
  await page.waitForTimeout(400)
}

async function view(): Promise<View> {
  return page.evaluate(() => {
    const sm = (window as any).__blockout_scene
    const p = sm.freeCam.position
    const t = sm.controls.target
    return { cam: { x: p.x, y: p.y, z: p.z }, target: { x: t.x, y: t.y, z: t.z } }
  })
}

/** Pointer moves reach the page on the next frame: wait until the viewport knows where the pointer is. */
async function expectHovered(hovered: boolean): Promise<void> {
  await expect.poll(() => page.evaluate('window.__blockout_scene.nav.hovered')).toBe(hovered)
}

async function center(): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.viewport-wrap canvas').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function drag(
  button: 'left' | 'middle' | 'right',
  dx: number,
  dy: number,
  modifier?: 'Alt' | 'Shift'
): Promise<void> {
  const c = await center()
  await page.mouse.move(c.x, c.y)
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.down({ button })
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 12 })
  await page.mouse.up({ button })
  if (modifier) await page.keyboard.up(modifier)
  await page.waitForTimeout(600) // damping settles
}

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout nav-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = { ...process.env, BLOCKOUT_SMOKE_DIR: dir, BLOCKOUT_CONFIG_DIR: configDir } as Record<string, string>
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

test('the left and right buttons never move the view; a middle-drag orbits', async () => {
  await resetView()
  const start = await view()
  await drag('left', 160, 40)
  await drag('right', 160, 40)
  const still = await view()
  expect(len(sub(still.cam, start.cam))).toBeLessThan(1e-6)
  expect(len(sub(still.target, start.target))).toBeLessThan(1e-6)

  await drag('middle', 160, 0)
  const orbited = await view()
  expect(len(sub(orbited.target, start.target))).toBeLessThan(1e-6)
  expect(len(sub(orbited.cam, orbited.target))).toBeCloseTo(len(sub(start.cam, start.target)), 3)
  const az = (v: View): number => Math.atan2(v.cam.x - v.target.x, v.cam.z - v.target.z)
  expect(Math.abs(az(orbited) - az(start))).toBeGreaterThan(0.2)
})

test('the wheel zooms', async () => {
  await resetView()
  const start = await view()
  const c = await center()
  await page.mouse.move(c.x, c.y)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(600)
  const zoomed = await view()
  expect(len(sub(zoomed.cam, zoomed.target))).toBeLessThan(len(sub(start.cam, start.target)) * 0.9)
  expect(len(sub(zoomed.target, start.target))).toBeLessThan(1e-6)
})

test('Alt + middle-drag pans across the floor', async () => {
  await resetView()
  const start = await view()
  await drag('middle', 150, 60, 'Alt')
  const panned = await view()
  const moved = sub(panned.target, start.target)
  expect(Math.hypot(moved.x, moved.z)).toBeGreaterThan(0.3)
  expect(Math.abs(moved.y)).toBeLessThan(1e-6)
  // The camera moved with its orbit point: the same angle and distance.
  expect(len(sub(sub(panned.cam, panned.target), sub(start.cam, start.target)))).toBeLessThan(1e-3)
})

test('Shift + middle-drag moves the view up and down, never under the floor', async () => {
  await resetView()
  const start = await view()
  await drag('middle', 0, 120, 'Shift') // the scene follows the cursor down: the view rises
  const raised = await view()
  const dCam = sub(raised.cam, start.cam)
  const dTarget = sub(raised.target, start.target)
  expect(dCam.y).toBeGreaterThan(0.3)
  expect(dTarget.y).toBeCloseTo(dCam.y, 6)
  expect(Math.hypot(dCam.x, dCam.z, dTarget.x, dTarget.z)).toBeLessThan(1e-6)

  await drag('middle', 0, -2000, 'Shift')
  const lowest = await view()
  expect(lowest.target.y).toBeGreaterThanOrEqual(-1e-9)
  expect(lowest.cam.y).toBeGreaterThanOrEqual(0.1 - 1e-9)
})

test('W A S D / Q E fly over the viewport, not while typing or off it', async () => {
  await resetView()
  const c = await center()
  await page.mouse.move(c.x, c.y)
  await expectHovered(true)
  const start = await view()
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(400)
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(100)
  const forward = await view()
  const moved = sub(forward.cam, start.cam)
  const look = sub(start.target, start.cam)
  expect(Math.abs(moved.y)).toBeLessThan(1e-6)
  expect(moved.x * look.x + moved.z * look.z).toBeGreaterThan(0.5)
  expect(len(sub(sub(forward.target, start.target), moved))).toBeLessThan(1e-6)

  await page.keyboard.down('KeyE')
  await page.waitForTimeout(300)
  await page.keyboard.up('KeyE')
  await page.waitForTimeout(100)
  expect((await view()).cam.y).toBeGreaterThan(forward.cam.y + 0.3)

  // Typing in a field flies nothing.
  const before = await view()
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'nav-probe'
    document.body.appendChild(input)
    input.focus()
  })
  await page.keyboard.down('KeyD')
  await page.waitForTimeout(300)
  await page.keyboard.up('KeyD')
  await page.evaluate(() => document.getElementById('nav-probe')!.remove())
  expect(len(sub((await view()).cam, before.cam))).toBeLessThan(1e-6)

  // Off the viewport (over the titlebar) the keys fly nothing either.
  const bar = (await page.locator('.titlebar').boundingBox())!
  await page.mouse.move(bar.x + 20, bar.y + bar.height / 2)
  await expectHovered(false)
  await page.keyboard.down('KeyS')
  await page.waitForTimeout(300)
  await page.keyboard.up('KeyS')
  expect(len(sub((await view()).cam, before.cam))).toBeLessThan(1e-6)
})

test('dragging the camera body moves the shot camera live, so the PiP follows', async () => {
  await resetView()
  await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    store.setMode('shoot')
    store.addEntity('person.man', { x: 0, y: 0, z: 0 }) // something for the PiP to show
    if (store.shot().camera.marks.length === 0) store.dropCameraMark({ x: 0, y: 1.6, z: 5 }, 0, 0, 35)
    store.setPipSize('small') // bottom-right, clear of the probe grid
    store.setSelection({ kind: 'camera' })
    store.setTime(0)
  })
  await page.waitForTimeout(400)
  const markBefore: V3 = await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    return store.shot().camera.marks[0].position
  })
  const c = await center()
  let grab: { x: number; y: number } | null = null
  outer: for (let dx = -180; dx <= 180; dx += 20) {
    for (let dy = -160; dy <= 160; dy += 20) {
      await page.mouse.move(c.x + dx, c.y + dy)
      await page.waitForTimeout(14)
      const axis = await page.evaluate(() => (window as any).__blockout_scene.transform.axis)
      if (axis === 'X' || axis === 'Z') {
        grab = { x: c.x + dx, y: c.y + dy }
        break outer
      }
    }
  }
  expect(grab, 'no camera gizmo axis found').toBeTruthy()
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x + 90, grab!.y + 10, { steps: 12 })
  await page.waitForTimeout(150)
  const mid = await page.evaluate(() => {
    const sm = (window as any).__blockout_scene
    const v = (p: any): V3 => ({ x: p.x, y: p.y, z: p.z })
    return { shot: v(sm.shotCam.position), body: v(sm.cameraBody.position), dragging: sm.transform.dragging }
  })
  await snap('nav-camera-drag-mid')
  await page.mouse.up()
  await page.waitForTimeout(300)
  expect(mid.dragging).toBe(true)
  expect(len(sub(mid.body, markBefore))).toBeGreaterThan(0.05)
  expect(len(sub(mid.shot, mid.body))).toBeLessThan(1e-6)
  const markAfter: V3 = await page.evaluate(() => {
    const store = (window as any).__blockout.store.getState()
    return store.shot().camera.marks[0].position
  })
  expect(len(sub(markAfter, mid.body))).toBeLessThan(0.05)
})
