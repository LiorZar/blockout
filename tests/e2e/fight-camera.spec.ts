/**
 * e2e for shot words and the Fight Director (docs/plans/2026-10-19-fight-camera.md):
 * launch the built app, create a project, then drive the control server the
 * way the MCP bridge does (same pattern as mcp-gaps.spec.ts).
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

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout fight-'))
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
  const discoveryFile = resolveConfigPath('control.json', { env })
  await expect.poll(() => existsSync(discoveryFile)).toBe(true)
  ;({ port, token } = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as { port: number; token: string })
})

test.afterAll(async () => {
  await app?.close()
})

type CamMark = { id: string; time: number; shot?: { size: string; subjectIds: string[]; over?: { entityId: string } } }

test.describe('shot words', () => {
  let a = ''
  let b = ''

  test('frame_shot with words puts a live MCU shot mark on the camera', async () => {
    a = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: -0.6, z: -3, label: 'A' })).data!.entityId
    b = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.woman', x: 0.6, z: -3, label: 'B' })).data!.entityId
    expect((await rpc('clear_camera_marks')).ok).toBe(true)
    const res = await rpc<{ markId: string; time: number; achievedSize?: string }>('frame_shot', {
      words: "MCU on B, over A's right shoulder, 50mm"
    })
    expect(res.ok, res.error).toBe(true)
    expect(res.data!.markId).toBeTruthy()
    expect(res.data!.achievedSize).toBeTruthy()
    const marks = await rpc<CamMark[]>('list_marks', { lane: 'camera' })
    expect(marks.data).toHaveLength(1)
    expect(marks.data![0]!.shot?.size).toBe('MCU')
    expect(marks.data![0]!.shot?.subjectIds).toEqual([b])
    expect(marks.data![0]!.shot?.over?.entityId).toBe(a)
  })

  test('frame_shot with structured fields updates the mark at that time', async () => {
    const res = await rpc<{ markId: string; time: number }>('frame_shot', { size: 'WS', subjectIds: [a, b], angle: 'high', time: 0 })
    expect(res.ok, res.error).toBe(true)
    const marks = await rpc<CamMark[]>('list_marks', { lane: 'camera' })
    expect(marks.data).toHaveLength(1)
    expect(marks.data![0]!.shot?.size).toBe('WS')
  })

  test('a shot mark: get_state shows its shot; pose edits need release: true', async () => {
    type Pose = CamMark & { x: number; y: number; panDeg: number; hold: number }
    const state = await rpc<{ shot: { cameraMarks: Pose[] } }>('get_state')
    const mark = state.data!.shot.cameraMarks[0]!
    expect(mark.shot?.size).toBe('WS')
    expect(mark.shot?.subjectIds).toEqual([a, b])
    // A pose edit alone would be re-solved away every frame: refused, and the error says how to release.
    const refused = await rpc('update_mark', { lane: 'camera', markId: mark.id, x: 2, panDeg: 10 })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('release: true')
    expect(refused.error).toContain('frame_shot')
    // Timing edits keep the words.
    const held = await rpc<Pose>('update_mark', { lane: 'camera', markId: mark.id, hold: 0.5 })
    expect(held.ok, held.error).toBe(true)
    expect(held.data!.shot?.size).toBe('WS')
    expect(held.data!.hold).toBe(0.5)
    // release: true freezes the solved pose, drops the words, then applies the edits.
    const released = await rpc<Pose>('update_mark', { lane: 'camera', markId: mark.id, release: true, x: 2, panDeg: 10 })
    expect(released.ok, released.error).toBe(true)
    expect(released.data!.shot).toBeUndefined()
    expect(released.data!.x).toBe(2)
    expect(released.data!.panDeg).toBe(10)
    expect(released.data!.y).toBeCloseTo(mark.y, 6)
    const after = await rpc<{ shot: { cameraMarks: Pose[] } }>('get_state')
    expect(after.data!.shot.cameraMarks[0]!.shot).toBeUndefined()
    expect(after.data!.shot.cameraMarks[0]!.x).toBe(2)
    // One undo brings the words back.
    expect((await rpc('undo')).ok).toBe(true)
    expect((await rpc<CamMark[]>('list_marks', { lane: 'camera' })).data![0]!.shot?.size).toBe('WS')
    const plain = await rpc('update_mark', { lane: 'camera', markId: mark.id, release: true })
    expect(plain.ok, plain.error).toBe(true)
    expect((await rpc<CamMark[]>('list_marks', { lane: 'camera' })).data![0]!.shot).toBeUndefined()
    expect((await rpc('undo')).ok).toBe(true)
  })

  test("frame_shot words 'MCU on nobody' is an error", async () => {
    const res = await rpc('frame_shot', { words: 'MCU on nobody' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('nobody')
    const bad = await rpc('frame_shot', { size: 'MCU', subjectIds: ['ent_nope'] })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('get_state')
  })

  test('screenshot after framing returns an image', async () => {
    const shot = await rpc<{ imageBase64: string }>('screenshot')
    expect(shot.ok).toBe(true)
    expect(shot.data!.imageBase64.length).toBeGreaterThan(1000)
  })
})

const DESIGN_SCRIPT = `A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1`

type Report = {
  beats: { index: number; impactTimes: number[]; contactErrorM: number[]; physics: { result: string }[]; warnings: string[] }[]
  warnings: string[]
}
type Staged = { fightId: string; script: string; report: Report }
type State = {
  scene: { entities: { id: string; label?: string; color?: string }[]; fights: { id: string; name: string; fighterIds: string[]; beats: number }[] }
}

test.describe('fight director', () => {
  let fightId = ''

  test('list_fight_moves lists the strikes with their impacts', async () => {
    // A 4-beat fight needs more than the default 5 s shot.
    expect((await rpc('set_shot', { duration: 12 })).ok).toBe(true)
    const res = await rpc<{ id: string; impacts: { effector: string; t: number }[] }[]>('list_fight_moves')
    expect(res.ok, res.error).toBe(true)
    const jab = res.data!.find((m) => m.id === 'jab-cross')!
    expect(jab.impacts.map((i) => i.effector)).toEqual(['handR', 'handL'])
  })

  test('stage_fight with the Design script lands every hit and spawns two coloured fighters', async () => {
    const before = (await rpc<State>('get_state')).data!.scene.entities.length
    const res = await rpc<Staged>('stage_fight', { script: DESIGN_SCRIPT, x: 0, z: -8, headingDeg: 0 })
    expect(res.ok, res.error).toBe(true)
    fightId = res.data!.fightId
    const beats = res.data!.report.beats
    expect(beats).toHaveLength(4)
    const outcomes = [['block', 'hit'], ['hit'], ['parry'], ['ko']]
    beats.forEach((b, k) => {
      b.contactErrorM.forEach((e, i) => {
        if (outcomes[k]![i] === 'hit' || outcomes[k]![i] === 'ko') expect(e, `beat ${k + 1} blow ${i + 1}`).toBeLessThanOrEqual(0.03)
      })
    })
    const state = (await rpc<State>('get_state')).data!
    const added = state.scene.entities.slice(before)
    expect(added).toHaveLength(2)
    expect(added.map((e) => e.label)).toEqual(['A', 'B'])
    expect(added[0]!.color).not.toBe(added[1]!.color)
    expect(state.scene.fights.find((f) => f.id === fightId)).toMatchObject({ beats: 4 })
  })

  test('update_fight with one line changed re-solves the defender', async () => {
    const state = (await rpc<State>('get_state')).data!
    const fight = state.scene.fights.find((f) => f.id === fightId)!
    const defender = fight.fighterIds[1]!
    const before = await rpc<{ time: number; x: number; z: number }[]>('list_marks', { lane: defender })
    const changed = DESIGN_SCRIPT.replace('A front kick to body -> parry', 'A front kick to body -> hit power 1')
    const res = await rpc<Staged>('update_fight', { fightId, script: changed })
    expect(res.ok, res.error).toBe(true)
    expect(res.data!.script).toContain('front-kick to body -> hit power 1')
    const after = await rpc<{ time: number; x: number; z: number }[]>('list_marks', { lane: defender })
    expect(JSON.stringify(after.data)).not.toBe(JSON.stringify(before.data))
  })

  test('get_fight reads it back; a bad id names get_state', async () => {
    const res = await rpc<Staged>('get_fight', { fightId })
    expect(res.ok, res.error).toBe(true)
    expect(res.data!.report.beats).toHaveLength(4)
    const bad = await rpc('get_fight', { fightId: 'fight_nope' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('get_state')
  })

  test('set_shot fps / duration re-solves the fight (gap 2)', async () => {
    type SetShot = { ok: boolean; fights?: { fightId: string; beats: number; warnings: string[] }[] }
    const fps30 = await rpc<SetShot>('set_shot', { fps: 30 })
    expect(fps30.ok, fps30.error).toBe(true)
    expect(fps30.data!.fights?.map((f) => f.fightId)).toContain(fightId)
    const at30 = (await rpc<Staged>('get_fight', { fightId })).data!.report
    const times = at30.beats.flatMap((b) => b.impactTimes)
    expect(times.length).toBeGreaterThan(4)
    for (const t of times) expect(Math.abs(t * 30 - Math.round(t * 30)), `impact ${t}`).toBeLessThan(1e-6)

    const short = await rpc<SetShot>('set_shot', { duration: 4 })
    const mine = short.data!.fights!.find((f) => f.fightId === fightId)!
    expect(mine.beats).toBeLessThan(4)
    expect(mine.warnings.some((w) => w.includes('past the end of the shot'))).toBe(true)

    const back = await rpc<SetShot>('set_shot', { duration: 12, fps: 24 })
    expect(back.data!.fights!.find((f) => f.fightId === fightId)!.beats).toBe(4)
  })

  test('get_fight reports a rifle fight the way stage_fight did (qa-clara bug 2)', async () => {
    const staged = await rpc<Staged>('stage_fight', { script: 'A shoot to body -> hit', weapons: ['prop.rifle', null], x: 12, z: -8 })
    expect(staged.ok, staged.error).toBe(true)
    expect(staged.data!.report.beats).toHaveLength(1)
    const read = await rpc<Staged>('get_fight', { fightId: staged.data!.fightId })
    expect(read.ok, read.error).toBe(true)
    expect(read.data!.report.beats).toHaveLength(1)
    expect(read.data!.report.warnings).toEqual(staged.data!.report.warnings)
    expect(read.data!.report.beats[0]!.impactTimes).toEqual(staged.data!.report.beats[0]!.impactTimes)
    expect((await rpc('delete_fight', { fightId: staged.data!.fightId })).ok).toBe(true)
  })

  test('stage_fight random martial-arts with a KO ending ends on a ko', async () => {
    const res = await rpc<Staged>('stage_fight', { random: { seed: 7, style: 'martial-arts', ending: 'ko' }, x: 6, z: -8 })
    expect(res.ok, res.error).toBe(true)
    const lines = res.data!.script.trim().split('\n')
    expect(lines[lines.length - 1]).toMatch(/-> (.*, )?ko/)
  })

  test('delete_fight forgets the fight and keeps its marks', async () => {
    const state = (await rpc<State>('get_state')).data!
    const fighter = state.scene.fights.find((f) => f.id === fightId)!.fighterIds[0]!
    expect((await rpc('delete_fight', { fightId })).ok).toBe(true)
    const after = (await rpc<State>('get_state')).data!
    expect(after.scene.fights.some((f) => f.id === fightId)).toBe(false)
    expect((await rpc<unknown[]>('list_marks', { lane: fighter })).data!.length).toBeGreaterThan(5)
  })
})

test.describe('fight coverage', () => {
  test('fight_coverage punch-in replaces the camera with live shot marks', async () => {
    const state = (await rpc<State>('get_state')).data!
    const fightId = state.scene.fights[0]!.id
    const res = await rpc<{ fightId: string; mode: string; lineSide: number; cameraMarks: number }>('fight_coverage', { fightId, mode: 'punch-in', side: 'left' })
    expect(res.ok, res.error).toBe(true)
    expect(res.data!.lineSide).toBe(-1)
    const marks = await rpc<CamMark[]>('list_marks', { lane: 'camera' })
    expect(marks.data!.length).toBeGreaterThanOrEqual(2)
    for (const m of marks.data!) expect(m.shot, m.id).toBeTruthy()
    const bad = await rpc('fight_coverage', { fightId, mode: 'crane' })
    expect(bad.ok).toBe(false)
  })

  test('fight_coverage follow puts the camera on a handheld rig', async () => {
    const state = (await rpc<State>('get_state')).data!
    const res = await rpc('fight_coverage', { fightId: state.scene.fights[0]!.id, mode: 'follow' })
    expect(res.ok, res.error).toBe(true)
    const after = await rpc<{ shot: { rig: string; rigIntensity: number; trackEntityId: string | null } }>('get_state')
    expect(after.data!.shot.rig).toBe('handheld')
    expect(after.data!.shot.trackEntityId).toBeNull()
  })
})

test.describe('fight director panel', () => {
  test('a new fight defaults to master camera coverage (qa-export B12)', async () => {
    expect((await rpc('new_scene', { name: 'Panel' })).ok).toBe(true)
    const choreo = page.locator('.panel-section', { has: page.locator('.panel-title', { hasText: /^Choreographer$/ }) }).first()
    await choreo.locator('select').first().selectOption({ label: '🥋 Fight' })
    const cover = choreo.locator('.field', { has: page.locator('label', { hasText: 'Camera coverage' }) }).locator('select')
    await expect(cover).toHaveValue('master')
  })

  test('the Choreographer keeps Fight after DELIVER → STAGE (qa-fight bug 7)', async () => {
    const setMode = (mode: string): Promise<void> =>
      page.evaluate((m) => (window as unknown as { __blockout: { store: { getState(): { setMode(x: string): void } } } }).__blockout.store.getState().setMode(m), mode)
    await setMode('deliver')
    await setMode('stage')
    const choreo = page.locator('.panel-section', { has: page.locator('.panel-title', { hasText: /^Choreographer$/ }) }).first()
    await expect(choreo.locator('select').first()).toHaveValue('fight')
    await expect(choreo.locator('label', { hasText: 'Camera coverage' })).toBeVisible()
  })
})
