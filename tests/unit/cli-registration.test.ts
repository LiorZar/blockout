/**
 * Packaged builds register the HTTP MCP server with the claude, codex and
 * copilot CLIs (src/main/cli-registration.ts). Driven here by a fake exec.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerWithClis, createFileLog, type ExecFn } from '../../src/main/cli-registration'

const URL1 = 'http://127.0.0.1:17480/mcp'
const URL2 = 'http://127.0.0.1:18000/mcp'

type Reply = { code: number | null; stdout?: string; stderr?: string; notFound?: boolean } | 'throw'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'blockout cli-'))
  dirs.push(d)
  return d
}

/** A fake exec answering by "<file> <args...>" prefix; unmatched → exit 0. */
function fakeExec(replies: Record<string, Reply>): { exec: ExecFn; calls: string[] } {
  const calls: string[] = []
  const exec: ExecFn = async (file, args) => {
    const line = [file, ...args].join(' ')
    calls.push(line)
    const key = Object.keys(replies).find((k) => line.startsWith(k))
    const r = key ? replies[key]! : { code: 0 }
    if (r === 'throw') throw new Error('spawn exploded')
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', notFound: r.notFound ?? false }
  }
  return { exec, calls }
}

const NOT_FOUND: Reply = { code: 9009, stderr: "'codex' is not recognized as an internal or external command", notFound: true }

describe('registerWithClis', () => {
  it('a CLI that is not installed is skipped and not recorded', async () => {
    const markerPath = join(tmp(), 'mcp-registration.json')
    const { exec, calls } = fakeExec({
      'claude mcp get': { code: 0, stdout: `blockout\n  Type: http\n  URL: ${URL1}\n` },
      'codex mcp get': NOT_FOUND,
      'copilot mcp get': NOT_FOUND
    })
    const recorded = await registerWithClis({ name: 'blockout', url: URL1, version: '1.0.0', markerPath, exec })
    expect(recorded).toEqual(['claude'])
    expect(calls.some((c) => c.startsWith('codex mcp add'))).toBe(false)
    expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toEqual({ url: URL1, version: '1.0.0', registered: ['claude'] })
  })

  it('get exits 0 with our url: no add, recorded', async () => {
    const { exec, calls } = fakeExec({ 'claude mcp get': { code: 0, stdout: URL1 }, codex: NOT_FOUND, copilot: NOT_FOUND })
    const recorded = await registerWithClis({ name: 'blockout', url: URL1, version: '1', markerPath: join(tmp(), 'm.json'), exec })
    expect(recorded).toEqual(['claude'])
    expect(calls.filter((c) => c.startsWith('claude'))).toEqual(['claude mcp get blockout'])
  })

  it('get exits 0 with another url: remove then add', async () => {
    const { exec, calls } = fakeExec({
      'claude mcp get': { code: 0, stdout: 'command: node C:\\old\\blockout-mcp.mjs' },
      codex: NOT_FOUND,
      copilot: NOT_FOUND
    })
    const recorded = await registerWithClis({ name: 'blockout', url: URL1, version: '1', markerPath: join(tmp(), 'm.json'), exec })
    expect(recorded).toEqual(['claude'])
    expect(calls.filter((c) => c.startsWith('claude'))).toEqual([
      'claude mcp get blockout',
      'claude mcp remove --scope user blockout',
      `claude mcp add --transport http --scope user blockout ${URL1}`
    ])
  })

  it('get exits non-zero: add (codex and copilot syntax)', async () => {
    const { exec, calls } = fakeExec({ claude: NOT_FOUND, 'codex mcp get': { code: 1 }, 'copilot mcp get': { code: 1 } })
    const recorded = await registerWithClis({ name: 'blockout', url: URL1, version: '1', markerPath: join(tmp(), 'm.json'), exec })
    expect(recorded).toEqual(['codex', 'copilot'])
    expect(calls).toContain(`codex mcp add blockout --url ${URL1}`)
    expect(calls).toContain(`copilot mcp add --transport http blockout ${URL1}`)
    expect(calls.some((c) => c.includes(' remove '))).toBe(false)
  })

  it('add fails: not recorded, one log line', async () => {
    const lines: string[] = []
    const { exec } = fakeExec({
      'claude mcp get': { code: 1 },
      'claude mcp add': { code: 1, stderr: 'config is read-only' },
      codex: NOT_FOUND,
      copilot: NOT_FOUND
    })
    const recorded = await registerWithClis({
      name: 'blockout',
      url: URL1,
      version: '1',
      markerPath: join(tmp(), 'm.json'),
      exec,
      log: (l) => lines.push(l)
    })
    expect(recorded).toEqual([])
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('claude')
    expect(lines[0]).toContain('config is read-only')
  })

  it('marker matches url + version and lists all three: zero exec calls', async () => {
    const markerPath = join(tmp(), 'm.json')
    writeFileSync(markerPath, JSON.stringify({ url: URL1, version: '2', registered: ['claude', 'codex', 'copilot'] }))
    const { exec, calls } = fakeExec({})
    const recorded = await registerWithClis({ name: 'blockout', url: URL1, version: '2', markerPath, exec })
    expect(calls).toEqual([])
    expect(recorded).toEqual(['claude', 'codex', 'copilot'])
  })

  it('the url changed: all three are re-checked', async () => {
    const markerPath = join(tmp(), 'm.json')
    writeFileSync(markerPath, JSON.stringify({ url: URL1, version: '2', registered: ['claude', 'codex', 'copilot'] }))
    const { exec, calls } = fakeExec({ 'claude mcp get': { code: 0, stdout: URL1 }, 'codex mcp get': { code: 0, stdout: URL1 }, 'copilot mcp get': { code: 0, stdout: URL1 } })
    const recorded = await registerWithClis({ name: 'blockout', url: URL2, version: '2', markerPath, exec })
    expect(calls.filter((c) => c.includes(' get '))).toEqual(['claude mcp get blockout', 'codex mcp get blockout', 'copilot mcp get blockout'])
    expect(calls).toContain(`claude mcp add --transport http --scope user blockout ${URL2}`)
    expect(recorded).toEqual(['claude', 'codex', 'copilot'])
    expect(JSON.parse(readFileSync(markerPath, 'utf-8')).url).toBe(URL2)
  })

  it('exec throws: the call resolves anyway', async () => {
    const lines: string[] = []
    const { exec } = fakeExec({ claude: 'throw', codex: 'throw', copilot: 'throw' })
    const markerPath = join(tmp(), 'm.json')
    await expect(
      registerWithClis({ name: 'blockout', url: URL1, version: '1', markerPath, exec, log: (l) => lines.push(l) })
    ).resolves.toEqual([])
    expect(lines.length).toBe(3)
  })

  it('an unreadable marker folder still resolves', async () => {
    const { exec } = fakeExec({ 'claude mcp get': { code: 0, stdout: URL1 }, codex: NOT_FOUND, copilot: NOT_FOUND })
    const markerPath = join(tmp(), 'missing', 'deeper', 'm.json')
    await expect(registerWithClis({ name: 'blockout', url: URL1, version: '1', markerPath, exec })).resolves.toEqual(['claude'])
    expect(existsSync(markerPath)).toBe(true)
  })
})

describe('createFileLog', () => {
  it('appends lines and keeps the last 200', async () => {
    const path = join(tmp(), 'logs', 'mcp-registration.log')
    const log = createFileLog(path, 200)
    for (let i = 0; i < 205; i++) log(`line ${i}`)
    await log.flush()
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(200)
    expect(lines[0]).toContain('line 5')
    expect(lines[199]).toContain('line 204')
  })
})
