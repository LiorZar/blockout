/**
 * Fork: the narrow layout used while Blockout is docked beside Clara
 * (650–950 px). Below NARROW_MAX_WIDTH the viewport takes the full width,
 * the side panels become overlays opened from two titlebar toggles, and the
 * titlebar compacts (rules in ../narrow.css, all scoped to `.app.narrow`).
 * The breakpoint comes from measurements in docs/plans/2026-10-19-fix-narrow.md.
 *
 * Fork (Lior's test, 2026-10-24): at any width every panel folds away from a
 * titlebar toggle (the left and right panels, the Shoot timeline, the Deliver
 * panel), so docked beside Clara the window can show only the stage. Wide,
 * they start open and fold out of the grid; narrow, the side panels stay
 * overlays that start closed.
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

export type PanelSide = 'left' | 'right' | 'timeline' | 'deliver'

export interface OverlayPanels {
  left: boolean
  right: boolean
  timeline: boolean
  deliver: boolean
  toggle(side: PanelSide): void
}

/**
 * Open/closed state of the two overlay panels. Both start closed, close
 * again when the window widens, and the left one closes itself when a
 * placement starts so the floor under it is clickable.
 */
export function useOverlayPanels(narrow: boolean): OverlayPanels {
  const [open, setOpen] = useState({ left: false, right: false })
  // Wide layout and both layouts' timeline and Deliver panel: open until folded.
  const [shown, setShown] = useState({ left: true, right: true, timeline: true, deliver: true })
  // Each new pick (asset, sequence or routine) is a new value.
  const placing = useStore((s) => s.placingAssetId ?? s.placingSequence ?? s.placingChoreography)

  useEffect(() => {
    if (!narrow) setOpen({ left: false, right: false })
  }, [narrow])

  useEffect(() => {
    if (placing) setOpen((o) => (o.left ? { ...o, left: false } : o))
  }, [placing])

  const toggle = useCallback(
    (side: PanelSide) => {
      if (narrow && (side === 'left' || side === 'right')) setOpen((o) => ({ ...o, [side]: !o[side] }))
      else setShown((o) => ({ ...o, [side]: !o[side] }))
    },
    [narrow]
  )
  const sides = narrow ? open : shown
  return { left: sides.left, right: sides.right, timeline: shown.timeline, deliver: shown.deliver, toggle }
}

const TOGGLE_LABEL: Record<PanelSide, string> = {
  left: 'Scenes & library panel',
  right: 'Inspector panel',
  timeline: 'Timeline panel',
  deliver: 'Deliver panel'
}

const TOGGLE_NAME: Record<PanelSide, string> = {
  left: 'scenes & library panel',
  right: 'inspector panel',
  timeline: 'timeline',
  deliver: 'export settings panel'
}

/** The window as an outline with the panel's strip filled in (dim while the panel is folded). */
function PaneIcon({ side, open }: { side: PanelSide; open: boolean }): JSX.Element {
  const [x, y, w, h] = side === 'left' ? [2, 2, 4, 10] : side === 'timeline' ? [2, 8, 12, 4] : [10, 2, 4, 10]
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      <rect x="0.5" y="0.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" />
      <rect x={x} y={y} width={w} height={h} rx="0.5" fill="currentColor" opacity={open ? 1 : 0.3} />
    </svg>
  )
}

export function PanelToggle({ side, panels }: { side: PanelSide; panels: OverlayPanels }): JSX.Element {
  const open = panels[side]
  return (
    <button
      className={`btn small panel-toggle${open ? ' active' : ''}`}
      aria-label={TOGGLE_LABEL[side]}
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} the ${TOGGLE_NAME[side]}`}
      onClick={() => panels.toggle(side)}
    >
      <PaneIcon side={side} open={open} />
    </button>
  )
}
