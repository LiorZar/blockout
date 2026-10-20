/**
 * Fork: the narrow layout used while Blockout is docked beside Clara
 * (650–950 px). Below NARROW_MAX_WIDTH the viewport takes the full width,
 * the side panels become overlays opened from two titlebar toggles, and the
 * titlebar compacts (rules in ../narrow.css, all scoped to `.app.narrow`).
 * The breakpoint comes from measurements in docs/plans/2026-10-19-fix-narrow.md.
 */

import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'

/** Window widths below this use the narrow layout. */
export const NARROW_MAX_WIDTH = 1000

const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH - 1}px)`

export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => setNarrow(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return narrow
}

export type PanelSide = 'left' | 'right'

export interface OverlayPanels {
  left: boolean
  right: boolean
  toggle(side: PanelSide): void
}

/**
 * Open/closed state of the two overlay panels. Both start closed, close
 * again when the window widens, and the left one closes itself when a
 * placement starts so the floor under it is clickable.
 */
export function useOverlayPanels(narrow: boolean): OverlayPanels {
  const [open, setOpen] = useState({ left: false, right: false })
  // Each new pick (asset, sequence or routine) is a new value.
  const placing = useStore((s) => s.placingAssetId ?? s.placingSequence ?? s.placingChoreography)

  useEffect(() => {
    if (!narrow) setOpen({ left: false, right: false })
  }, [narrow])

  useEffect(() => {
    if (placing) setOpen((o) => (o.left ? { ...o, left: false } : o))
  }, [placing])

  const toggle = useCallback((side: PanelSide) => setOpen((o) => ({ ...o, [side]: !o[side] })), [])
  return { left: open.left, right: open.right, toggle }
}

const TOGGLE_LABEL: Record<PanelSide, string> = {
  left: 'Scenes & library panel',
  right: 'Inspector panel'
}

export function PanelToggle({ side, panels }: { side: PanelSide; panels: OverlayPanels }): JSX.Element {
  const open = panels[side]
  return (
    <button
      className={`btn small panel-toggle${open ? ' active' : ''}`}
      aria-label={TOGGLE_LABEL[side]}
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} the ${side === 'left' ? 'scenes & library' : 'inspector'} panel`}
      onClick={() => panels.toggle(side)}
    >
      {side === 'left' ? '◧' : '◨'}
    </button>
  )
}
