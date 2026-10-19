/**
 * The main-process Clara controller (src/main/clara.ts): attach from the
 * titlebar button, retry once on failure, and never leave a late or stale
 * handle behind. Driven by a fake AttachClara and fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachClara, IClaraAttachOptions, IClaraHandle, IHostWindow } from '@2dl/clara-client'
import {
  CLARA_INSTRUCTIONS,
  CLARA_RETRY_MS,
  buildAttachOptions,
  createClaraController,
  devAttachDeps
} from '../../src/main/clara'
import { claraTooltip, type ClaraView } from '../../src/shared/clara-types'
import type { McpHttpStatus } from '../../src/main/mcp-http'

const FOLDER = 'D:\\My Films\\Chase 1'
const URL = 'http://127.0.0.1:17480/mcp'

type Status = IClaraHandle['status']

interface FakeHandle extends IClaraHandle {
  detached: number
  fire(e: 'closed' | 'error', arg?: string): void
}

function handle(status: Status, error: string | null = null): FakeHandle {
  const listeners: Record<string, ((arg?: string) => void)[]> = {}
  const h = {
    status,
    error,
    detached: 0,
    Detach(): void {
      h.detached++
    },
    on(e: 'closed' | 'error', cb: (arg?: string) => void): void {
      ;(listeners[e] ??= []).push(cb)
    },
    fire(e: 'closed' | 'error', arg?: string): void {
      for (const cb of listeners[e] ?? []) cb(arg)
    }
  }
  return h
}

const win = { id: 1 } as unknown as IHostWindow

function setup(opts: {
  results?: (FakeHandle | Promise<FakeHandle>)[]
  platform?: NodeJS.Platform
  mcp?: McpHttpStatus
} = {}): {
  ctrl: ReturnType<typeof createClaraController>
  calls: IClaraAttachOptions[]
  views: ClaraView[]
} {
  const calls: IClaraAttachOptions[] = []
  const views: ClaraView[] = []
  const queue = [...(opts.results ?? [])]
  const attach = (async (_w: IHostWindow, options: IClaraAttachOptions) => {
    calls.push(options)
    return (await queue.shift()) ?? handle('failed', 'no more fakes')
  }) as unknown as typeof AttachClara
  const ctrl = createClaraController({
    attach,
    getWindow: () => win,
    getMcp: () => opts.mcp ?? { state: 'listening', port: 17480, url: URL },
    env: {},
    platform: opts.platform ?? 'win32',
    isPackaged: true,
    onChange: (v) => views.push(v)
  })
  return { ctrl, calls, views }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Clara controller', () => {
  it('not Windows: unsupported, attach never called', async () => {
    const { ctrl, calls } = setup({ platform: 'darwin' })
    expect(ctrl.getState().state).toBe('unsupported')
    expect((await ctrl.toggle(FOLDER)).state).toBe('unsupported')
    expect(calls).toEqual([])
  })

  it('a null or empty folder stays idle with "Open a project first"', async () => {
    const { ctrl, calls } = setup()
    expect(await ctrl.toggle(null)).toMatchObject({ state: 'idle', error: 'Open a project first' })
    expect((await ctrl.toggle('')).state).toBe('idle')
    expect(calls).toEqual([])
  })

  it('success: attached, options equal buildAttachOptions with the folder verbatim', async () => {
    const { ctrl, calls, views } = setup({ results: [handle('attached')] })
    const view = await ctrl.toggle(FOLDER)
    expect(view).toEqual({ state: 'attached', error: null, folder: FOLDER, mcpError: null })
    expect(calls).toEqual([buildAttachOptions(FOLDER, URL)])
    expect(calls[0]!.folder).toBe('D:\\My Films\\Chase 1')
    expect(views.map((v) => v.state)).toEqual(['attaching', 'attached'])
  })

  it('attach options are exact', () => {
    expect(buildAttachOptions(FOLDER, URL)).toEqual({
      appId: 'blockout',
      appName: 'Blockout',
      folder: FOLDER,
      mcp: { type: 'http', url: URL },
      access: 'read-files',
      instructions: CLARA_INSTRUCTIONS
    })
    expect(CLARA_INSTRUCTIONS).toContain('Call get_state first.')
  })

  it('MCP not listening: Clara still gets the default URL so it can offer Retry', async () => {
    const { ctrl, calls } = setup({ results: [handle('attached')], mcp: { state: 'error', message: 'listen EADDRINUSE: address already in use 127.0.0.1:17480' } })
    await ctrl.toggle(FOLDER)
    expect(calls[0]!.mcp).toEqual({ type: 'http', url: 'http://127.0.0.1:17480/mcp' })
  })

  it('failed retries once after 3000 ms and then stops', async () => {
    const { ctrl, calls } = setup({ results: [handle('failed', 'updating'), handle('failed', 'still updating')] })
    expect(await ctrl.toggle(FOLDER)).toMatchObject({ state: 'failed', error: 'updating' })
    expect(CLARA_RETRY_MS).toBe(3000)
    await vi.advanceTimersByTimeAsync(2999)
    expect(calls.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.length).toBe(2)
    expect(ctrl.getState()).toMatchObject({ state: 'failed', error: 'still updating' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.length).toBe(2)
  })

  it('a retry that succeeds ends attached', async () => {
    const { ctrl } = setup({ results: [handle('failed', 'busy'), handle('attached')] })
    await ctrl.toggle(FOLDER)
    await vi.advanceTimersByTimeAsync(CLARA_RETRY_MS)
    expect(ctrl.getState().state).toBe('attached')
  })

  it('not-installed never retries', async () => {
    const { ctrl, calls } = setup({ results: [handle('not-installed')] })
    expect((await ctrl.toggle(FOLDER)).state).toBe('not-installed')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.length).toBe(1)
  })

  it('toggle while attaching: the late handle is detached and the state ends idle', async () => {
    let resolve!: (h: FakeHandle) => void
    const late = handle('attached')
    const { ctrl } = setup({ results: [new Promise<FakeHandle>((r) => (resolve = r))] })
    const first = ctrl.toggle(FOLDER)
    expect(ctrl.getState().state).toBe('attaching')
    expect((await ctrl.toggle(FOLDER)).state).toBe('idle')
    resolve(late)
    await first
    expect(late.detached).toBe(1)
    expect(ctrl.getState().state).toBe('idle')
  })

  it('toggle while attached calls Detach and ends idle', async () => {
    const h = handle('attached')
    const { ctrl } = setup({ results: [h] })
    await ctrl.toggle(FOLDER)
    expect((await ctrl.toggle(FOLDER)).state).toBe('idle')
    expect(h.detached).toBe(1)
  })

  it('closed from the current handle goes idle; a stale closed is ignored', async () => {
    const old = handle('attached')
    const current = handle('attached')
    const { ctrl } = setup({ results: [old, current] })
    await ctrl.toggle(FOLDER)
    await ctrl.toggle(FOLDER) // detach old
    await ctrl.toggle(FOLDER) // attach current
    expect(ctrl.getState().state).toBe('attached')
    old.fire('closed')
    expect(ctrl.getState().state).toBe('attached')
    current.fire('closed')
    expect(ctrl.getState().state).toBe('idle')
    // No re-attach loop after Clara closes.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctrl.getState().state).toBe('idle')
  })

  it('an MCP error state fills mcpError', () => {
    const { ctrl } = setup({ mcp: { state: 'error', message: 'listen EADDRINUSE: address already in use 127.0.0.1:17480' } })
    expect(ctrl.getState().mcpError).toContain('EADDRINUSE')
    expect(setup().ctrl.getState().mcpError).toBeNull()
  })

  it('dispose detaches an attached handle and drops a late one', async () => {
    const h = handle('attached')
    const { ctrl } = setup({ results: [h] })
    await ctrl.toggle(FOLDER)
    ctrl.dispose()
    expect(h.detached).toBe(1)
    expect(ctrl.getState().state).toBe('idle')
  })
})

describe('devAttachDeps', () => {
  it('is undefined when packaged or when the flag is unset', () => {
    expect(devAttachDeps({ BLOCKOUT_CLARA_DEV: 'D:\\Git\\maestro' }, true)).toBeUndefined()
    expect(devAttachDeps({}, false)).toBeUndefined()
    expect(devAttachDeps({ CLARA_DEV: 'D:\\Git\\maestro' }, false)).toBeUndefined()
  })

  it('launches the Maestro dev build with its own pipe', () => {
    expect(devAttachDeps({ BLOCKOUT_CLARA_DEV: 'D:\\Git\\maestro' }, false)).toEqual({
      launch: {
        command: 'D:\\Git\\maestro\\node_modules\\electron\\dist\\electron.exe',
        args: ['D:\\Git\\maestro\\out-clara\\main\\index.js']
      },
      pipeSuffix: 'blockout-dev'
    })
    expect(devAttachDeps({ BLOCKOUT_CLARA_DEV: 'D:/Git/maestro', CLARA_PIPE_SUFFIX: 'x' }, false)?.pipeSuffix).toBe('x')
  })
})

describe('claraTooltip', () => {
  const v = (state: ClaraView['state'], extra: Partial<ClaraView> = {}): ClaraView => ({
    state,
    error: null,
    folder: null,
    mcpError: null,
    ...extra
  })

  it('has the exact copy per state', () => {
    expect(claraTooltip(v('attaching'), true)).toBe('Opening Clara…')
    expect(claraTooltip(v('attached'), true)).toBe('Clara is open. Click to close it.')
    expect(claraTooltip(v('not-installed'), true)).toBe("Clara isn't installed on this computer.")
    expect(claraTooltip(v('failed', { error: 'pipe busy' }), true)).toBe("Clara couldn't open: pipe busy. Click to try again.")
    expect(claraTooltip(v('idle'), true)).toBe('Open Clara')
    expect(claraTooltip(v('idle'), false)).toBe('Open a project first')
  })

  it("adds the MCP problem to any state", () => {
    expect(claraTooltip(v('idle', { mcpError: 'listen EADDRINUSE: address already in use 127.0.0.1:17480' }), true)).toBe(
      "Open Clara Blockout's tools aren't available: listen EADDRINUSE: address already in use 127.0.0.1:17480."
    )
  })
})
