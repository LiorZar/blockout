/**
 * One viewport across the modes (fork addition, main-thread; see
 * MODIFICATIONS.md). The App shell shows the viewport in one place in Stage
 * and Shoot and in another in Deliver (the preview beside the prompt); mounted
 * in each, every switch to Deliver and back built a new SceneManager: a new
 * WebGL context, every visual and mark rebuilt and every shader compiled again,
 * a 0.25–0.5 s task before the prompt showed. Now the Viewport renders once,
 * into a host element (a portal), and each place that shows it holds a slot the
 * host moves into: the SceneManager, its context and its programs live on
 * across the switch. Slot and host are `display: contents`, so the layout is
 * the one the Viewport had in place.
 */

import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Viewport } from './Viewport'

let host: HTMLDivElement | null = null

function viewportHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement('div')
    host.className = 'viewport-host'
    host.style.display = 'contents'
  }
  return host
}

/** Where the viewport shows: the host moves in when the slot mounts. */
export function ViewportSlot(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ref.current?.appendChild(viewportHost())
  }, [])
  return <div ref={ref} className="viewport-slot" style={{ display: 'contents' }} />
}

/** The one Viewport, rendered into the host; the App shell renders it once beside its layouts. */
export function ViewportPortal(): JSX.Element {
  return createPortal(<Viewport />, viewportHost())
}
