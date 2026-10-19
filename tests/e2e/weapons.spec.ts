/**
 * e2e for held weapons (docs/plans/2026-10-19-weapons.md): launch the built
 * app, drive the control server the way the MCP bridge does, and check that
 * the rendered weapon tip is where the engine says it is.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { resolveConfigPath } from '../../src/shared/config-paths'
import { ShotEvaluator } from '../../src/engine/evaluate'
import { personDims, toWorld } from '../../src/engine/skeleton'
import { heldPointLocal, weaponSpec } from '../../src/engine/weapons'
import type { ProjectDoc, V3 } from '../../src/engine/types'

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

/** The engine's world-space tip of a held weapon at time t (from the app's own document). */
async function engineTip(weaponId: string, t: number): Promise<V3> {
  const { doc, sceneId, shotId } = await page.evaluate(() => {
    const st = (window as unknown as { __blockout: { store: { getState(): { doc: unknown; sceneId: string; shotId: string } } } }).__blockout.store.getState()
    return { doc: st.doc, sceneId: st.sceneId, shotId: st.shotId }
  }) as { doc: ProjectDoc; sceneId: string; shotId: string }
  const scene = doc.scenes.find((s) => s.id === sceneId)!
  const shot = scene.shots.find((s) => s.id === shotId)!
  const weapon = scene.entities.find((e) => e.id === weaponId)!
  const holder = scene.entities.find((e) => e.id === weapon.heldBy!.entityId)!
  const st = new ShotEvaluator(scene, shot).evaluate(t).entities.find((e) => e.entityId === holder.id)!
  const spec = weaponSpec(weapon.assetId)!
  const local = heldPointLocal(personDims(holder.assetId, holder.params), st.joints, weapon.heldBy!.hand, spec, spec.tip, weapon.transform.scale)
  return toWorld(local, st.position, st.heading, holder.transform.scale)
}

/** The rendered tip: the weapon visual's world matrix, posed at t by the SceneManager. */
async function renderedTip(weaponId: string, t: number, tip: V3): Promise<V3> {
  return await page.evaluate(
    ([id, t, p]) => {
      type Root = { updateWorldMatrix(parents: boolean, children: boolean): void; matrixWorld: { elements: number[] } }
      const sm = (window as unknown as { __blockout_scene: { applyTime(t: number): void; visuals: Map<string, { root: Root }> } })
        .__blockout_scene
      sm.applyTime(t)
      const root = sm.visuals.get(id)!.root
      root.updateWorldMatrix(true, false)
      const e = root.matrixWorld.elements
      return {
        x: e[0]! * p.x + e[4]! * p.y + e[8]! * p.z + e[12]!,
        y: e[1]! * p.x + e[5]! * p.y + e[9]! * p.z + e[13]!,
        z: e[2]! * p.x + e[6]! * p.y + e[10]! * p.z + e[14]!
      }
    },
    [weaponId, t, tip] as const
  )
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockout weapons-'))
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

type Held = { entityId: string; hand: 'L' | 'R' }
type StateEntity = { id: string; assetId: string; x: number; y: number; z: number; heldBy?: Held }

test.describe('held weapons', () => {
  let a = ''
  let sword = ''

  test('list_weapons lists the catalog with the usual hands', async () => {
    const res = await rpc<{ weapons: { assetId: string; twoHanded: boolean; usualHand: string }[]; held: unknown[] }>('list_weapons')
    expect(res.ok, res.error).toBe(true)
    expect(res.data!.weapons).toHaveLength(12)
    expect(res.data!.weapons.find((w) => w.assetId === 'prop.sword')).toMatchObject({ twoHanded: false, usualHand: 'R' })
    expect(res.data!.weapons.find((w) => w.assetId === 'prop.bow')!.usualHand).toBe('L')
    expect(res.data!.held).toEqual([])
  })

  test('hold_weapon spawns a sword in A\'s right hand; get_state shows the hold at the hand', async () => {
    expect((await rpc('set_shot', { duration: 2 })).ok).toBe(true)
    a = (await rpc<{ entityId: string }>('add_entity', { assetId: 'person.man', x: 0, z: -3, label: 'A', rotationDeg: 30 })).data!.entityId
    const res = await rpc<{ weaponId: string; hand: string; color: string }>('hold_weapon', { entityId: a, assetId: 'prop.sword', hand: 'R' })
    expect(res.ok, res.error).toBe(true)
    sword = res.data!.weaponId
    expect(res.data!.hand).toBe('R')
    expect(res.data!.color).toMatch(/^#[0-9a-f]{6}$/)
    const state = await rpc<{ scene: { entities: StateEntity[] } }>('get_state')
    const w = state.data!.scene.entities.find((e) => e.id === sword)!
    expect(w.heldBy).toEqual({ entityId: a, hand: 'R' })
    // Reported at the grip in the hand: about hip height, within arm's reach of A.
    expect(w.y).toBeGreaterThan(0.6)
    expect(Math.hypot(w.x - 0, w.z + 3)).toBeLessThan(0.7)
  })

  test('bad hold_weapon calls are refused with a reason', async () => {
    expect((await rpc('hold_weapon', { entityId: a, assetId: 'prop.sword', hand: 'X' })).error).toContain('L or R')
    expect((await rpc('hold_weapon', { entityId: a })).error).toContain('assetId')
    expect((await rpc('hold_weapon', { entityId: a, assetId: 'prop.cup' })).error).toContain('list_weapons')
    expect((await rpc('hold_weapon', { entityId: 'ent_nope', assetId: 'prop.sword' })).error).toContain('get_state')
    expect((await rpc('drop_weapon', { weaponId: a })).ok).toBe(false)
  })

  test('sword-slash-combo: the rendered tip is where the engine says, every 0.1 s', async () => {
    expect((await rpc<{ applied: number }>('apply_motion', { entityIds: [a], presetId: 'sword-slash-combo' })).data!.applied).toBe(1)
    const spec = weaponSpec('prop.sword')!
    let moved = 0
    let prev: V3 | null = null
    for (let i = 0; i <= 20; i++) {
      const t = i * 0.1
      const engine = await engineTip(sword, t)
      const rendered = await renderedTip(sword, t, spec.tip)
      // The renderer's stand gait adds a ≤ 5 mm breathing bob to the whole rig (Y only).
      expect(Math.hypot(rendered.x - engine.x, rendered.z - engine.z), `t=${t}`).toBeLessThan(1e-4)
      expect(Math.abs(rendered.y - engine.y), `t=${t}`).toBeLessThan(0.0051)
      if (prev) moved += Math.hypot(engine.x - prev.x, engine.y - prev.y, engine.z - prev.z)
      prev = engine
    }
    // The blade really swings (not a static prop following nothing).
    expect(moved).toBeGreaterThan(1.5)
  })

  test('a mid-swing frame renders byte-identically twice (determinism)', async () => {
    const [x, y] = await page.evaluate(() => {
      const b = (window as unknown as { __blockout: { renderRawForTest(t: number, w: number, h: number): number[] } }).__blockout
      return [b.renderRawForTest(0.4, 320, 180), b.renderRawForTest(0.4, 320, 180)]
    })
    expect(x.length).toBe(320 * 180 * 4)
    expect(Buffer.from(x).equals(Buffer.from(y))).toBe(true)
  })

  test('export_shot writes the clip; the prompt names the sword in A\'s right hand', async () => {
    const res = await rpc<{ packagePath: string; prompt: string }>('export_shot', { passes: { clean: true, depth: false, normal: false } })
    expect(res.ok, res.error).toBe(true)
    const pkg = res.data!.packagePath
    expect(res.data!.prompt).toBe(readFileSync(join(pkg, 'prompt.txt'), 'utf-8').trim())
    expect(res.data!.prompt).toMatch(/a sword \(the \w+ shape\) in A's right hand/)
    const clips = readdirSync(pkg).filter((f) => f.endsWith('_reference.mp4'))
    expect(clips).toHaveLength(1)
    expect(statSync(join(pkg, clips[0]!)).size).toBeGreaterThan(10_000)
  })

  test('stage_fight with weapons: a sword fight and a shot land on their frames (≤ 3 cm)', async () => {
    expect((await rpc('new_scene', { name: 'Armed fight' })).ok).toBe(true)
    expect((await rpc('set_shot', { duration: 10 })).ok).toBe(true)
    const moves = await rpc<{ id: string; aliases: string[] }[]>('list_fight_moves')
    expect(moves.data!.find((m) => m.id === 'pistol-aim-fire')?.aliases).toContain('shoot')
    expect(moves.data!.find((m) => m.id === 'sword-slash-combo')?.aliases).toContain('sword slash')
    const res = await rpc<{ fightId: string; report: { beats: { contactErrorM: number[] }[]; warnings: string[] } }>('stage_fight', {
      script: 'A sword slash to head -> block, hit\nB shoot to body -> hit\nA sword thrust to body -> parry',
      weapons: ['prop.sword', 'prop.pistol'],
      x: 0,
      z: -4
    })
    expect(res.ok, res.error).toBe(true)
    expect(res.data!.report.warnings).toEqual([])
    expect(res.data!.report.beats).toHaveLength(3)
    for (const b of res.data!.report.beats) for (const e of b.contactErrorM) expect(e).toBeLessThanOrEqual(0.03)
    const held = (await rpc<{ held: { assetId: string; hand: string }[] }>('list_weapons')).data!.held
    expect(held.map((h) => h.assetId).sort()).toEqual(['prop.pistol', 'prop.sword'])
    expect((await rpc('stage_fight', { script: 'A jab', weapons: ['prop.cup', null] })).error).toContain('list_weapons')
  })

  test('drop_weapon stands the sword where the hand was; deleting A leaves other weapons on the ground', async () => {
    expect((await rpc('select_scene', { sceneId: (await rpc<{ allScenes: { id: string }[] }>('get_state')).data!.allScenes[0]!.id })).ok).toBe(true)
    expect((await rpc('set_time', { t: 0 })).ok).toBe(true)
    const grip = (await rpc<{ scene: { entities: StateEntity[] } }>('get_state')).data!.scene.entities.find((e) => e.id === sword)!
    const dropped = await rpc<{ dropped: string; x: number; z: number }>('drop_weapon', { weaponId: sword })
    expect(dropped.ok, dropped.error).toBe(true)
    expect(dropped.data!.x).toBeCloseTo(grip.x, 6)
    expect(dropped.data!.z).toBeCloseTo(grip.z, 6)
    const axe = (await rpc<{ weaponId: string }>('hold_weapon', { entityId: a, assetId: 'prop.axe' })).data!.weaponId
    expect((await rpc('delete_entity', { entityId: a })).ok).toBe(true)
    const after = (await rpc<{ scene: { entities: StateEntity[] } }>('get_state')).data!.scene.entities
    const left = after.find((e) => e.id === axe)!
    expect(left.heldBy).toBeUndefined()
    expect(left.y).toBe(0)
    expect((await rpc<{ held: unknown[] }>('list_weapons')).data!.held).toEqual([])
  })
})
