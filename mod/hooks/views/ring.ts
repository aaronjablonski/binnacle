import type { RenderElement, RenderNode } from 'claude-code'

/**
 * The pane's focus ring, as far as this module can know it: the focusable
 * elements of the last drawing in document order (the order Tab and the
 * arrows walk them), which of them are tabs, where the ring starts, and the
 * element the ring last landed on.
 *
 * Ephemeral UI state, not session state: a reload starts it over, and the
 * next drawing and the next move fill it in again. Bounded: at most
 * MAX_STOPS keys, and one key for where the ring is.
 */
export type Stops = {
  /** The focusable keys (Button, Input, Select) in document order. */
  order: string[]
  /** The tab Buttons among them. */
  tabs: string[]
  /** The element `autoFocus` marks: the first content row. */
  start?: string
}

export const MAX_STOPS = 400

const FOCUSABLE = new Set(['Button', 'Input', 'Select'])

const isElement = (n: RenderNode | undefined): n is RenderElement => typeof n === 'object' && n !== null

/** An element's props; the engine's own node (`type: 'engine'`) has none. */
const propsOf = (el: RenderElement): Record<string, unknown> => ('props' in el && el.props !== undefined ? el.props : {})

const keyOf = (el: RenderElement): string | undefined => {
  const k = propsOf(el).key
  return typeof k === 'string' ? k : undefined
}

const childrenOf = (el: RenderElement): RenderNode[] => {
  const c = (el as { children?: RenderNode[] }).children
  return Array.isArray(c) ? c : []
}

/** The focusable elements of a drawing, in document order, with the first `autoFocus` among them. */
export function stopsOf(tree: RenderNode, isTab: (key: string) => boolean): Stops {
  const order: string[] = []
  const tabs: string[] = []
  let start: string | undefined
  const walk = (n: RenderNode): void => {
    if (!isElement(n) || order.length >= MAX_STOPS) return
    const key = keyOf(n)
    if (FOCUSABLE.has(n.type) && key !== undefined) {
      order.push(key)
      if (isTab(key)) tabs.push(key)
      else if (start === undefined && propsOf(n).autoFocus === true) start = key
    }
    for (const c of childrenOf(n)) walk(c)
  }
  walk(tree)
  return start !== undefined ? { order, tabs, start } : { order, tabs }
}

/**
 * The drawing with the ring's start marked: when no content element carries
 * `autoFocus` (NEEDS YOU's first item does on Now), the first content Button
 * in document order gets it. Tabs never do, and neither does an Input, which
 * would take the keys the hotkeys need. Only that Button and the elements
 * above it are copied; the rest of the tree is passed as it is.
 */
export function withStart(tree: RenderElement, isTab: (key: string) => boolean): RenderElement {
  const marked = stopsOf(tree, isTab).start
  if (marked !== undefined) return tree
  let done = false
  const mark = (n: RenderNode): RenderNode => {
    if (done || !isElement(n)) return n
    const key = keyOf(n)
    if (n.type === 'Button' && key !== undefined && !isTab(key)) {
      done = true
      return { ...n, props: { ...n.props, autoFocus: true } }
    }
    const kids = childrenOf(n)
    if (kids.length === 0) return n
    const next = kids.map(mark)
    return next.some((c, i) => c !== kids[i]) ? ({ ...n, children: next } as RenderElement) : n
  }
  return mark(tree) as RenderElement
}

/**
 * Where a person's move should land instead, or undefined to let it land
 * where the engine sends it.
 *
 * Only a move onto a tab is redirected: the ring stays in the content. From a
 * content row (Up off the first row, or Down wrapping off the last) it stays
 * on that row; from a tab or from nowhere it goes to the first content row.
 * A move off the last content row onto one of the engine's own stops (no
 * `target`) is Down wrapping too, so it stays: the engine refuses an element
 * in place of its stop, so the caller keeps the ring by answering without
 * next. With no tab bar (slim) nothing is redirected.
 */
export function landing(s: Stops, at: string | undefined, target: string | undefined): string | undefined {
  if (s.tabs.length === 0) return undefined
  const content = s.order.filter(k => !s.tabs.includes(k))
  if (content.length === 0) return undefined
  const fromContent = at !== undefined && content.includes(at)
  if (target === undefined) return fromContent && at === content[content.length - 1] ? at : undefined
  if (!s.tabs.includes(target)) return undefined
  if (fromContent) return at
  return s.start !== undefined && content.includes(s.start) ? s.start : content[0]
}

/**
 * Whether a person's scroll of the pane is an arrow key (R54): one row, from
 * the person, with no pointer (the wheel carries one; a page key moves a
 * page, Home and End the whole tree).
 */
export function isArrowScroll(e: { origin: { kind: string }; pointer?: unknown; by: number }): boolean {
  return e.origin.kind === 'person' && e.pointer === undefined && Math.abs(e.by) === 1
}

/**
 * Where an arrow moves the ring (R54: the arrows always walk rows, never the
 * window): the next content row down (`by` > 0) or up, held at the first and
 * the last; from no row, the first row down or the last row up. Undefined
 * when the drawing has no content row.
 */
export function arrowTarget(s: Stops, at: string | undefined, by: number): string | undefined {
  const content = s.order.filter(k => !s.tabs.includes(k))
  if (content.length === 0) return undefined
  const i = at !== undefined ? content.indexOf(at) : -1
  if (i < 0) return by > 0 ? (s.start !== undefined && content.includes(s.start) ? s.start : content[0]) : content[content.length - 1]
  return content[Math.max(0, Math.min(content.length - 1, i + (by > 0 ? 1 : -1)))]
}
