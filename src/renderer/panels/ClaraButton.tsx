/**
 * Titlebar button that docks Clara (the separately installed assistant)
 * beside Blockout, working in the open project's folder. Hidden where Clara
 * isn't supported; disabled until a project is open. State lives in the main
 * process (src/main/clara.ts) — this only mirrors it.
 */

import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { claraTooltip, type ClaraView } from '../../shared/clara-types'

export function ClaraButton(): JSX.Element | null {
  const projectFolder = useStore((s) => s.projectFolder)
  const [view, setView] = useState<ClaraView | null>(null)

  useEffect(() => {
    // Subscribe first so no push between the two is lost.
    const off = window.blockout.clara.onState(setView)
    void window.blockout.clara.getState().then(setView)
    return off
  }, [])

  if (!view || view.state === 'unsupported') return null
  const hasProject = !!projectFolder
  return (
    <button
      className={`btn small${view.state === 'attaching' ? ' clara-pulse' : ''}`}
      title={claraTooltip(view, hasProject)}
      disabled={!hasProject}
      onClick={() => {
        void window.blockout.clara.toggle(useStore.getState().projectFolder).then(setView)
      }}
    >
      {view.state === 'attached' ? 'Close Clara' : 'Clara'}
    </button>
  )
}
