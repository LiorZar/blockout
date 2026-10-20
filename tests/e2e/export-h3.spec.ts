/**
 * e2e for the fork's MiniMax H3 Max export (docs/plans/2026-10-19-export-h3.md):
 * stage a 15 s weapon fight with punch-in coverage over the control server,
 * export it with `export_shot { profileId: 'minimax-h3-max' }`, and check the
 * clip H3 Max will take (≤ 15 s, ≤ 50 MB, 1080p, 24 fps) and the prompt
 * (proxy map, action, camera, ≤ 2000 characters). Deliver then flags a shot
 * that is too long. Set H3_EVIDENCE_DIR to keep the clip, prompt, frames
 * and a Deliver screenshot.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveConfigPath } from '../../src/shared/config-paths'

let app: ElectronApplication
let page: Page
let port: number
let token: string

type Rpc<T> = { ok: boolean; data?: T; error?: string }

async function rpc<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, params })
  })
  const body = (await res.json()) as Rpc<T>
  if (!body.ok) throw new Error(`${action}: ${body.error}`)
  return body.data as T
}

const evidence = process.env.H3_EVIDENCE_DIR

test.beforeAll(async () => {
  const smokeDir = mkdtempSync(join(tmpdir(), 'blockout h3-'))
  const configDir = join(smokeDir, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = { ...process.env, BLOCKOUT_SMOKE_DIR: smokeDir, BLOCKOUT_CONFIG_DIR: configDir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js'], env })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible()
  const discoveryFile = resolveConfigPath('control.json', { env })
  await expect.poll(() => existsSync(discoveryFile)).toBe(true)
  ;({ port, token } = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as { port: number; token: string })
  if (evidence) mkdirSync(evidence, { recursive: true })
})

test.afterAll(async () => {
  await app?.close()
})

test('a 15 s weapon fight exports for H3 Max under 50 MB with a prompt that maps proxies and tells the action', async () => {
  test.setTimeout(900_000)
  const profiles = await rpc<{ id: string; maxDuration?: number; maxFileMB?: number; maxPromptChars?: number }[]>('list_export_profiles')
  const h3 = profiles.find((p) => p.id === 'minimax-h3-max')
  expect(h3).toMatchObject({ maxDuration: 15, maxFileMB: 50, maxPromptChars: 2000 })

  await rpc('set_shot', { duration: 15, fps: 24, aspect: '16:9' })
  await rpc('add_entity', { assetId: 'env.warehouse', x: 0, z: 0 })
  await rpc('set_lighting', { preset: 'interiorCool' })
  const staged = await rpc<{ fightId: string; report: { beats: unknown[]; warnings: string[] } }>('stage_fight', {
    script: [
      'A slash to head -> block',
      'B haymaker to head -> parry',
      'A thrust to body -> slip',
      'B front kick to body -> block',
      // A block here: a knockdown's get-up would push the KO past 15 s and the solver drops it.
      'A slash to head -> block',
      'B roundhouse to head -> duck',
      'A slash to body -> ko'
    ].join('\n'),
    assets: ['person.mannequinMale', 'person.mannequinFemale'],
    weapons: ['prop.katana', 'prop.baseballBat'],
    coverage: 'punch-in'
  })
  expect(staged.report.beats.length).toBeGreaterThanOrEqual(5)

  const res = await rpc<{ packagePath: string; prompt: string; warnings: string[] }>('export_shot', {
    profileId: 'minimax-h3-max',
    passes: { clean: true, depth: false, normal: false }
  })
  expect(res.warnings).toEqual([])

  const pkg = res.packagePath
  const ref = readdirSync(pkg).find((f) => f.endsWith('_reference.mp4'))!
  const mp4 = join(pkg, ref)
  const probe = JSON.parse(
    execFileSync(process.env.BLOCKOUT_FFPROBE || 'ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', mp4]).toString()
  )
  const stream = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
  const bytes = statSync(mp4).size
  expect(Number(probe.format.duration)).toBeGreaterThan(14.9)
  expect(Number(probe.format.duration)).toBeLessThanOrEqual(15.05)
  expect(stream.avg_frame_rate).toBe('24/1')
  expect(stream.width).toBe(1920)
  expect(stream.height).toBe(1080)
  expect(bytes).toBeLessThanOrEqual(50e6)

  const prompt = readFileSync(join(pkg, 'prompt.txt'), 'utf-8').trimEnd()
  if (evidence) {
    copyFileSync(mp4, join(evidence, 'h3_reference.mp4'))
    writeFileSync(join(evidence, 'prompt.txt'), prompt + '\n')
    writeFileSync(
      join(evidence, 'probe.json'),
      JSON.stringify({ bytes, MB: bytes / 1e6, duration: probe.format.duration, bitRate: probe.format.bit_rate, fps: stream.avg_frame_rate, width: stream.width, height: stream.height, frames: stream.nb_frames, promptChars: prompt.length, report: staged.report }, null, 2)
    )
    for (const t of [1, 3.5, 6, 8.5, 11, 13.5]) {
      execFileSync(process.env.BLOCKOUT_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', '-vf', 'scale=960:-2', join(evidence, `frame-${String(t).replace('.', '_')}s.png`)])
    }
  }

  expect(prompt).toBe(res.prompt)
  expect(prompt.length).toBeLessThanOrEqual(2000)
  expect(prompt).toMatch(/^The \w+ mannequin \(A\) is a man holding a katana \(the \w+ shape\) in A's right hand\./)
  expect(prompt).toMatch(/The \w+ mannequin \(B\) is a woman holding a baseball bat/)
  expect(prompt).toContain("A slashes at B's head with the katana")
  expect(prompt).toContain('knocks B out')
  expect(prompt).toContain('Camera:')
  expect(prompt).toContain('grey-box 3D previs')

  // Deliver names the cap when the shot is longer than H3 Max takes.
  await rpc('set_shot', { duration: 18 })
  await page.evaluate(`window.__blockout.store.getState().setMode('deliver')`)
  await page.locator('.deliver-panel select').first().selectOption('minimax-h3-max')
  await expect(page.locator('.deliver-panel .warning-chip').first()).toContainText('takes at most 15 s')
  if (evidence) await page.screenshot({ path: join(evidence, 'deliver-over-cap.png') })
})

test('export_shot warns when a 15 s shot goes to seedance-2 (10 s cap)', async () => {
  test.setTimeout(600_000)
  await rpc('set_shot', { duration: 15 })
  const res = await rpc<{ packagePath: string; warnings: string[] }>('export_shot', {
    profileId: 'seedance-2',
    passes: { clean: true, depth: false, normal: false },
    resolution: '720p'
  })
  expect(res.warnings).toHaveLength(1)
  expect(res.warnings[0]).toContain('Seedance 2.0 takes at most 10 s')
  if (evidence) writeFileSync(join(evidence, 'seedance-15s-warnings.json'), JSON.stringify(res.warnings, null, 2) + '\n')
})
