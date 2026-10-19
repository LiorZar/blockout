/**
 * e2e for the studio mannequins (docs/plans/2026-10-19-mannequin.md): launch
 * the built app, then drive the control server the way the MCP bridge does
 * (same pattern as fight-camera.spec.ts).
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs'
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
  const dir = mkdtempSync(join(tmpdir(), 'blockout mannequin-'))
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

const DESIGN_SCRIPT = `A jab cross to head -> block, hit
B hook to body -> hit power 0.9
A front kick to body -> parry
B roundhouse to head -> ko power 1`

type Report = { beats: { impactTimes: number[]; contactErrorM: number[] }[]; warnings: string[] }

test.describe('mannequins', () => {
  let male = ''
  let female = ''

  test('list_assets lists both mannequins as people', async () => {
    const res = await rpc<{ id: string; name: string; category: string }[]>('list_assets', { category: 'people' })
    expect(res.ok, res.error).toBe(true)
    expect(res.data).toEqual(
      expect.arrayContaining([
        { id: 'person.mannequinMale', name: 'Mannequin (male)', category: 'people' },
        { id: 'person.mannequinFemale', name: 'Mannequin (female)', category: 'people' }
      ])
    )
  })

  test('add_entity builds the sculpted mannequins in the viewport', async () => {
    expect((await rpc('set_shot', { duration: 12 })).ok).toBe(true)
    male = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.mannequinMale', x: -1.5, z: -3 })).data!.entityId
    female = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.mannequinFemale', x: 1.5, z: -3 })).data!.entityId
    expect(male).toBeTruthy()
    expect(female).toBeTruthy()
    const parts = await page.evaluate(() => {
      const sm = (window as unknown as { __blockout_scene: { scene: { getObjectByName(n: string): { getObjectByName(n: string): unknown } | undefined } } }).__blockout_scene
      const has = (id: string): boolean[] => {
        const g = sm.scene.getObjectByName(id)
        return ['chestMesh', 'headMesh', 'nose', 'handL', 'footR', 'elbowL', 'elbowR'].map((n) => !!g?.getObjectByName(n))
      }
      return { male: has('person.mannequinMale'), female: has('person.mannequinFemale') }
    })
    expect(parts.male.every(Boolean)).toBe(true)
    expect(parts.female.every(Boolean)).toBe(true)
  })

  test('apply_motion jab-cross / front-kick, then export_frame at the impact', async () => {
    expect((await rpc<{ applied: number }>('apply_motion', { entityIds: [male], presetId: 'jab-cross' })).data!.applied).toBe(1)
    expect((await rpc<{ applied: number }>('apply_motion', { entityIds: [female], presetId: 'front-kick' })).data!.applied).toBe(1)
    const moves = await rpc<{ id: string; impacts: { t: number }[] }[]>('list_fight_moves')
    const kick = moves.data!.find((m) => m.id === 'front-kick')!
    expect((await rpc('set_time', { t: kick.impacts[0]!.t })).ok).toBe(true)
    const frame = await rpc<{ path: string }>('export_frame', { resolution: '720p' })
    expect(frame.ok, frame.error).toBe(true)
    expect(existsSync(frame.data!.path)).toBe(true)
    expect(statSync(frame.data!.path).size).toBeGreaterThan(10_000)
  })

  test('stage_fight with the Design script on the two mannequins lands every hit within 3 cm', async () => {
    const a = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.mannequinMale', x: -0.6, z: -8, label: 'A' })).data!.entityId
    const b = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.mannequinFemale', x: 0.6, z: -8, label: 'B' })).data!.entityId
    const res = await rpc<{ fightId: string; report: Report }>('stage_fight', { script: DESIGN_SCRIPT, fighterIds: [a, b], x: 0, z: -8, headingDeg: 0 })
    expect(res.ok, res.error).toBe(true)
    const beats = res.data!.report.beats
    expect(beats).toHaveLength(4)
    const outcomes = [['block', 'hit'], ['hit'], ['parry'], ['ko']]
    beats.forEach((beat, k) => {
      beat.contactErrorM.forEach((e, i) => {
        if (outcomes[k]![i] === 'hit' || outcomes[k]![i] === 'ko') expect(e, `beat ${k + 1} blow ${i + 1}`).toBeLessThanOrEqual(0.03)
      })
    })
  })

  test('the store stages a fight with mannequin bodies (the Fight Director Bodies choice)', async () => {
    const spawned = await page.evaluate(() => {
      const store = (window as unknown as { __blockout: { store: { getState(): any } } }).__blockout.store
      const st = store.getState()
      const before = st.scene().entities.length
      st.stageFight({
        beats: [{ attacker: 0, move: 'jab-cross', target: 'head', outcomes: ['hit', 'hit'], power: 0.7 }],
        at: { x: 6, z: -8, heading: 0 },
        assets: ['person.mannequinMale', 'person.mannequinFemale']
      })
      return store.getState().scene().entities.slice(before).map((e: { assetId: string }) => e.assetId)
    })
    expect(spawned).toEqual(['person.mannequinMale', 'person.mannequinFemale'])
  })
})
