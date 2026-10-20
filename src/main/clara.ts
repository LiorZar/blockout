/**
 * Clara — the separately installed 2DLogic assistant — docked beside
 * Blockout from the titlebar button (never at startup). Clara drives the app
 * through Blockout's HTTP MCP server, in the open project's folder.
 *
 * One controller owns the attach lifecycle: idle → attaching → attached /
 * not-installed / failed. A failed attach gets one retry; a toggle while
 * attaching drops the attempt, and the handle that arrives late is detached;
 * a `closed` from a stale handle is ignored, so there is no re-attach loop.
 *
 * Dependencies are injected and only types come from @2dl/clara-client, so
 * the unit tests run this under Node.
 */

import { win32 } from 'path'
import type { AttachClara, IAttachDeps, IClaraAttachOptions, IClaraHandle, IHostWindow } from '@2dl/clara-client'
import { CLARA_NO_PROJECT, type ClaraState, type ClaraView } from '../shared/clara-types'
import { resolveMcpPort, type McpHttpStatus } from './mcp-http'

export const CLARA_RETRY_MS = 3000

/** Clara keeps the docked host at least this wide (DIP). */
export const CLARA_HOST_MIN_WIDTH = 480

/** BrowserWindow's min-size calls; IHostWindow leaves them out. */
type SizableWindow = IHostWindow & {
  getMinimumSize?(): number[]
  setMinimumSize?(width: number, height: number): void
}

export const CLARA_INSTRUCTIONS =
  'You help filmmakers block shots in Blockout, a grey-box 3D previs app, and export clips that AI video models use as their input video. Call get_state first. Units are meters and seconds; +X is right and -Z is away from the default camera. Every change can be undone. After staging or moving the camera, call screenshot to check the shot before you export. Give each character a different colour and a short label so the video model can tell them apart.'

export function buildAttachOptions(folder: string, mcpUrl: string): IClaraAttachOptions {
  return {
    appId: 'blockout',
    appName: 'Blockout',
    folder,
    mcp: { type: 'http', url: mcpUrl },
    access: 'read-files',
    // The delete card names the thing ("Remove the spear?") from the agent's `name` argument;
    // without one Clara falls back to the tool title.
    tools: { delete_entity: { label: 'Remove {name}' } },
    instructions: CLARA_INSTRUCTIONS
  }
}

/**
 * Development only: launch Clara from a Maestro checkout (`BLOCKOUT_CLARA_DEV`
 * = its root) on a separate pipe, so a dev session never meets the
 * customer's installed Clara. Ignored in packaged builds.
 */
export function devAttachDeps(env: NodeJS.ProcessEnv, isPackaged: boolean): IAttachDeps | undefined {
  const root = env.BLOCKOUT_CLARA_DEV?.trim()
  if (isPackaged || !root) return undefined
  return {
    launch: {
      command: win32.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [win32.join(root, 'out-clara', 'main', 'index.js')]
    },
    pipeSuffix: env.CLARA_PIPE_SUFFIX ?? 'blockout-dev'
  }
}

export function createClaraController(deps: {
  attach: typeof AttachClara
  getWindow(): IHostWindow | null
  getMcp(): McpHttpStatus
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  isPackaged: boolean
  onChange(view: ClaraView): void
  setTimer?: (fn: () => void, ms: number) => void
}): { getState(): ClaraView; toggle(folder: string | null): Promise<ClaraView>; dispose(): void } {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): void => void setTimeout(fn, ms))
  let state: ClaraState = 'win32' === deps.platform ? 'idle' : 'unsupported'
  let error: string | null = null
  let folder: string | null = null
  let handle: IClaraHandle | null = null
  // Bumped by every new attempt or cancel; a result for an older one is stale.
  let generation = 0
  // Blockout's own minWidth (1100) is wider than the share Clara docks it to,
  // and Electron would clamp it, leaving the host under Clara. While Clara is
  // attaching or docked the minimum drops to Clara's host minimum.
  let savedMin: { win: SizableWindow; size: number[] } | null = null

  function relaxMinWidth(win: SizableWindow): void {
    if (savedMin || !win.getMinimumSize || !win.setMinimumSize) return
    try {
      const size = win.getMinimumSize()
      savedMin = { win, size }
      if (size[0]! > CLARA_HOST_MIN_WIDTH) win.setMinimumSize(CLARA_HOST_MIN_WIDTH, size[1]!)
    } catch {
      // window destroyed meanwhile
    }
  }

  function restoreMinWidth(): void {
    const saved = savedMin
    savedMin = null
    if (!saved) return
    try {
      saved.win.setMinimumSize?.(saved.size[0]!, saved.size[1]!)
    } catch {
      // window destroyed meanwhile
    }
  }

  function getState(): ClaraView {
    const mcp = deps.getMcp()
    return { state, error, folder, mcpError: mcp.state === 'error' ? (mcp.message ?? 'unknown error') : null }
  }

  function set(next: ClaraState, nextError: string | null = null): ClaraView {
    state = next
    error = nextError
    const view = getState()
    deps.onChange(view)
    return view
  }

  async function attempt(target: string, isRetry: boolean): Promise<ClaraView> {
    const gen = ++generation
    folder = target
    set('attaching')
    const win = deps.getWindow()
    if (!win) return set('failed', "Blockout's window isn't open")
    relaxMinWidth(win)
    const mcp = deps.getMcp()
    const url = mcp.state === 'listening' && mcp.url ? mcp.url : `http://127.0.0.1:${resolveMcpPort(deps.env)}/mcp`
    let h: IClaraHandle
    try {
      h = await deps.attach(win, buildAttachOptions(target, url), devAttachDeps(deps.env, deps.isPackaged))
    } catch (e) {
      h = { status: 'failed', error: (e as Error).message, Detach: () => {}, on: () => {} }
    }
    if (gen !== generation) {
      if (h.status === 'attached') h.Detach()
      return getState()
    }
    if (h.status === 'attached') {
      handle = h
      h.on('closed', () => {
        if (handle !== h) return
        handle = null
        restoreMinWidth()
        set('idle')
      })
      h.on('error', (message) => {
        if (handle !== h) return
        error = message ?? null
        deps.onChange(getState())
      })
      return set('attached')
    }
    restoreMinWidth()
    if (h.status === 'not-installed') return set('not-installed', h.error)
    const view = set('failed', h.error ?? 'unknown error')
    if (!isRetry) {
      setTimer(() => {
        if (gen === generation && state === 'failed') void attempt(target, true)
      }, CLARA_RETRY_MS)
    }
    return view
  }

  return {
    getState,

    async toggle(target) {
      if (state === 'unsupported') return getState()
      if (state === 'attaching') {
        generation++
        restoreMinWidth()
        return set('idle')
      }
      if (state === 'attached') {
        const h = handle
        handle = null
        h?.Detach()
        restoreMinWidth()
        return set('idle')
      }
      if (!target || !target.trim()) return set('idle', CLARA_NO_PROJECT)
      return attempt(target, false)
    },

    dispose() {
      generation++
      const h = handle
      handle = null
      h?.Detach()
      restoreMinWidth()
      if (state !== 'unsupported') state = 'idle'
    }
  }
}
