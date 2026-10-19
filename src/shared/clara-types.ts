/**
 * Clara (the separately installed assistant) as the titlebar button sees it.
 * Shared by the main-process controller (src/main/clara.ts), the preload
 * bridge and the renderer's ClaraButton.
 */

export type ClaraState = 'unsupported' | 'idle' | 'attaching' | 'attached' | 'not-installed' | 'failed'

export interface ClaraView {
  state: ClaraState
  error: string | null
  folder: string | null
  /** Why Blockout's HTTP MCP tools aren't available, when they aren't. */
  mcpError: string | null
}

export const CLARA_NO_PROJECT = 'Open a project first'

const sentence = (s: string): string => s.trim().replace(/[.\s]+$/, '')

/** The button's tooltip for a view. */
export function claraTooltip(view: ClaraView, hasProject: boolean): string {
  let tip: string
  switch (view.state) {
    case 'attaching':
      tip = 'Opening Clara…'
      break
    case 'attached':
      tip = 'Clara is open. Click to close it.'
      break
    case 'not-installed':
      tip = "Clara isn't installed on this computer."
      break
    case 'failed':
      tip = `Clara couldn't open: ${sentence(view.error ?? 'unknown error')}. Click to try again.`
      break
    default:
      tip = hasProject && view.error !== CLARA_NO_PROJECT ? 'Open Clara' : CLARA_NO_PROJECT
  }
  return view.mcpError ? `${tip} Blockout's tools aren't available: ${sentence(view.mcpError)}.` : tip
}
