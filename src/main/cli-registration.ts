/**
 * Register Blockout's HTTP MCP server with the claude, codex and copilot CLIs
 * the customer has installed, so plain `claude` / `codex` / `copilot` reach
 * the same tools as Clara. Packaged builds only (see index.ts); a marker file
 * skips the work when nothing changed since the last launch. Never rejects:
 * a missing or failing CLI is skipped and logged.
 *
 * No `electron` import — the unit tests run this under Node with a fake exec.
 */

import { exec as execCmd } from 'child_process'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'

export type ExecFn = (
  file: string,
  args: string[]
) => Promise<{ code: number | null; stdout: string; stderr: string; notFound: boolean }>

interface CliSpec {
  cli: string
  get(name: string): string[]
  add(name: string, url: string): string[]
  remove(name: string): string[]
}

const CLIS: CliSpec[] = [
  {
    cli: 'claude',
    get: (n) => ['mcp', 'get', n],
    add: (n, u) => ['mcp', 'add', '--transport', 'http', '--scope', 'user', n, u],
    remove: (n) => ['mcp', 'remove', '--scope', 'user', n]
  },
  {
    cli: 'codex',
    get: (n) => ['mcp', 'get', n],
    add: (n, u) => ['mcp', 'add', n, '--url', u],
    remove: (n) => ['mcp', 'remove', n]
  },
  {
    cli: 'copilot',
    get: (n) => ['mcp', 'get', n],
    add: (n, u) => ['mcp', 'add', '--transport', 'http', n, u],
    remove: (n) => ['mcp', 'remove', n]
  }
]

const quote = (a: string): string => (/^[\w./:@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)

/**
 * Through the shell, because the CLIs are `.cmd` shims on Windows. One
 * command line (not execFile + shell args, which Node deprecates); every
 * argument here is a fixed word, the server name or our URL.
 */
const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve) => {
    execCmd([file, ...args].map(quote).join(' '), { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
      const notFound =
        (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ||
        code === 9009 ||
        code === 127 ||
        /not recognized/i.test(String(stderr))
      resolve({ code, stdout: String(stdout), stderr: String(stderr), notFound })
    })
  })

interface Marker {
  url: string
  version: string
  registered: string[]
}

async function readMarker(path: string): Promise<Marker | null> {
  try {
    const m = JSON.parse(await readFile(path, 'utf-8')) as Partial<Marker>
    if (typeof m.url === 'string' && typeof m.version === 'string' && Array.isArray(m.registered)) {
      return { url: m.url, version: m.version, registered: m.registered.filter((c) => typeof c === 'string') }
    }
  } catch {
    // No marker yet (first launch) or a corrupt one: check every CLI.
  }
  return null
}

/** One CLI: true when it now points `name` at `url`. */
async function registerOne(spec: CliSpec, name: string, url: string, exec: ExecFn, log: (line: string) => void): Promise<boolean> {
  try {
    const got = await exec(spec.cli, spec.get(name))
    if (got.notFound) return false
    if (got.code === 0 && got.stdout.includes(url)) return true
    // Registered elsewhere (an older stdio bridge or another port): replace it.
    if (got.code === 0) await exec(spec.cli, spec.remove(name))
    const added = await exec(spec.cli, spec.add(name, url))
    if (added.notFound) return false
    if (added.code === 0) return true
    log(`${spec.cli}: mcp add failed (exit ${added.code}): ${(added.stderr || added.stdout).trim()}`)
  } catch (e) {
    log(`${spec.cli}: ${(e as Error).message}`)
  }
  return false
}

export async function registerWithClis(opts: {
  name: string
  url: string
  version: string
  markerPath: string
  exec?: ExecFn
  log?: (line: string) => void
}): Promise<string[]> {
  const exec = opts.exec ?? defaultExec
  const log = opts.log ?? ((): void => {})
  try {
    const marker = await readMarker(opts.markerPath)
    const done = new Set(marker && marker.url === opts.url && marker.version === opts.version ? marker.registered : [])
    const recorded: string[] = []
    let changed = !marker || marker.url !== opts.url || marker.version !== opts.version
    for (const spec of CLIS) {
      if (done.has(spec.cli)) {
        recorded.push(spec.cli)
        continue
      }
      changed = true
      if (await registerOne(spec, opts.name, opts.url, exec, log)) recorded.push(spec.cli)
    }
    if (changed) {
      try {
        await mkdir(dirname(opts.markerPath), { recursive: true })
        await writeFile(opts.markerPath, JSON.stringify({ url: opts.url, version: opts.version, registered: recorded }))
      } catch (e) {
        log(`marker: ${(e as Error).message}`)
      }
    }
    return recorded
  } catch (e) {
    log(`registration: ${(e as Error).message}`)
    return []
  }
}

/** A log that appends timestamped lines to `path`, keeping the last `maxLines`. */
export function createFileLog(path: string, maxLines = 200): ((line: string) => void) & { flush(): Promise<void> } {
  let pending: string[] = []
  let chain: Promise<void> = Promise.resolve()
  const write = async (): Promise<void> => {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    try {
      await mkdir(dirname(path), { recursive: true })
      let old: string[] = []
      try {
        old = (await readFile(path, 'utf-8')).split('\n').filter((l) => l.length > 0)
      } catch {
        // New log file.
      }
      await writeFile(path, [...old, ...batch].slice(-maxLines).join('\n') + '\n', 'utf-8')
    } catch {
      // Logging must never break the app.
    }
  }
  const log = (line: string): void => {
    pending.push(`${new Date().toISOString()} ${line}`)
    chain = chain.then(write)
  }
  return Object.assign(log, { flush: (): Promise<void> => chain })
}
