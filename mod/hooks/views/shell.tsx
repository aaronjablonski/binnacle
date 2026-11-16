import type { EngineInterface, On, PaneOpenArgs, PluginOptions, RenderElement, RenderInput, RenderNode } from 'claude-code'

import type { PageKind, Tab, Timeline, UiState } from '../../types'
import { debug, errText, leaveDetail, readTimeline, readUi, updateUi } from '../state'
import { agentPage, agentsView } from './agents'
import { artifactPage, artifactsView } from './artifacts'
import { detailView, stepPage } from './detail'
import { configureEditor, rememberRoot } from './editor'
import { exportDigest } from './handoff'
import { overviewView } from './overview'
import { leavePage, pageOf } from './pagenav'
import { begin, forget, startClock } from './paint'
import { budgetTick, seedBudget } from './budget'
import { needsTick } from './needs'
import type { NotifyMode } from './needs'
import { configureOptions, lookOption, OPTIONS_HOTKEY, optionsPage, toggleOptions } from './options'
import { slimView } from './slim'
import { C, CK, edges, GRID, groundOf, lookAsked, motionOn, TAB_CELL, themeOf, tier } from './style'
import type { Ground, Look, Tier } from './style'
import { lookFor } from './svgview'
import { taskPage, tasksView } from './tasks'
import { pinNewest, timelineView } from './timeline'
import { landing, stopsOf, withStart } from './ring'
import type { Stops } from './ring'

export const PANE = 'mission-control'

/**
 * The five tabs and their label per tier: `label` from 62 columns, `short`
 * from 38, `icon` from 32. Under 32 (slim) no tab is drawn.
 */
export const TABS: { tab: Tab; label: string; short: string; icon: string; hotkey: string }[] = [
  { tab: 'overview', label: 'Now', short: 'Now', icon: '◆', hotkey: '1' },
  { tab: 'tasks', label: 'Tasks', short: 'Tsk', icon: '▣', hotkey: '2' },
  { tab: 'agents', label: 'Agents', short: 'Agt', icon: '◎', hotkey: '3' },
  { tab: 'timeline', label: 'Steps', short: 'Stp', icon: '≡', hotkey: '4' },
  { tab: 'artifacts', label: 'Artifacts', short: 'Art', icon: '↗', hotkey: '5' },
]

/**
 * What a tab draws: the state is read before, so a view is a plain function of
 * it. `$` is its own argument because the engine's scan refuses `$` held in an
 * object. `cols` is `e.props.bodyColumns`; `isFocused` is the pane's
 * `e.props.isFocused` (the footer draws only then); `bodyRows` is
 * `e.props.scroll.bodyRows` (slim drops sections to fit it).
 * `look` (Neo Rich) is computed once per draw from the surface's element
 * table (`lookOf`): `inst`, `richDeck`, `hero` and `page` draw Rasters only
 * when it is `rich`; absent, they draw the text form. `site` is the
 * requestId the draw's Rasters are tracked under for the paint clock (the
 * pane's id); absent, the pane's.
 *
 * The cockpit adds (R2, R21, R24, R35): `ground`, the Raster ground resolved
 * from the `ground` option and the theme (night when absent); `motion`, the
 * `motion` option (the blink; off when absent); `accent`, the `accent`
 * option as given (`iris`, `sky`, `slate`; C7 maps it to a theme key);
 * `isPromptCovered`, the pane's own prop (a dialog may hold the keys, so an
 * ask shows at once).
 */
export type ViewCtx = {
  e: RenderInput; t: Timeline; u: UiState; cols: number; now: number; showCost?: boolean
  isFocused?: boolean; bodyRows?: number
  look?: Look; site?: string
  ground?: Ground; motion?: boolean; accent?: string; isPromptCovered?: boolean
}

/** The rows the tab bar takes above a tab's body: the tabs, their track and the blank under them. */
export const TAB_ROWS = 3
export type View = (ctx: ViewCtx, $: EngineInterface) => RenderElement

/** The key of the tab bar's Options Button (`0`): reached, like a tab, by its hotkey and a click. */
export const OPTIONS_KEY = 'tab-options'

/** Whether `key` is one of the tab bar's Buttons. */
export function isTabKey(key: string): boolean {
  return key === OPTIONS_KEY || TABS.some(x => key === `tab-${x.tab}`)
}

/**
 * What this module knows of the pane's focus ring (ring.ts `Stops`), the
 * element it last landed on, and the pane's last render input, which a tab's
 * press draws the new tab from. Ephemeral UI state, not session state: a
 * reload starts it over. Bounded: `Stops` holds at most MAX_STOPS keys.
 */
const ring: { stops: Stops; at?: string; input?: RenderInput<'Pane'>; look?: Look; options?: PluginOptions } = { stops: { order: [], tabs: [] } }

const ROWS_INLINE = 14
const COLUMNS_DOCK = 62
const COLUMNS_SLIM = 28

/**
 * The pane's `$.ui.open` arguments: 28 columns while `ui.slim`, else 62 (a
 * width the person dragged still wins). `focus` accepts only true, so it is
 * added or left out.
 */
function paneArgs(isFocused: boolean, slim: boolean): PaneOpenArgs {
  const args: PaneOpenArgs = { id: PANE, title: 'Mission Control', columns: slim ? COLUMNS_SLIM : COLUMNS_DOCK, rows: ROWS_INLINE }
  if (isFocused) args.focus = true
  return args
}

/** The tab's label at a tier. */
function tabLabel(x: (typeof TABS)[number], t: Exclude<Tier, 'slim'>): string {
  return t === 'wide' ? x.label : t === 'mid' ? x.short : x.icon
}

/**
 * Writes `ui.paneOpen`: the band reads it to pick its compact form. Press
 * handlers and commands only, never ui.render. Never throws.
 */
async function setPaneOpen($: EngineInterface, open: boolean): Promise<void> {
  try {
    await updateUi($, cur => (cur.paneOpen === open ? cur : { ...cur, paneOpen: open }))
  } catch (err) {
    debug($, `paneOpen write failed: ${errText(err)}`)
  }
}

/**
 * Takes `ui.paneOpen` from the engine's own record of this plugin's panes
 * (`$.ui.panes()`): a session start, a /clear that reset the state, a resume.
 * Never throws; where the record cannot be read the flag keeps its value.
 */
export async function syncPaneOpen($: EngineInterface): Promise<void> {
  try {
    const panes = await $.ui.panes()
    await setPaneOpen($, panes.some(p => p.id === PANE && p.isPlaced))
  } catch (err) {
    debug($, `panes read failed: ${errText(err)}`)
  }
}

export function registerShell(on: On, options: PluginOptions): void {
  configureEditor(options.editor)
  configureOptions(options)
  // Observes every close of the pane (the person's own, /mc close, a press): the
  // flag follows what the hooks beneath settled, and the paint clock drops the
  // pane's Rasters. The one ui.close hook of the module; it answers exactly
  // what next(e) answered.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const settled = await next(e)
    forget(PANE)
    await setPaneOpen($, false)
    return settled
  })

  // Every move of the pane's ring. A person's move onto a tab is sent to the
  // content instead (ring.ts `landing`): the arrows and Tab walk the active
  // tab's rows, and the tabs are reached by their hotkeys, a click and /mc 1-5.
  // It answers what next(e) resolved to, for the move as sent.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    // The kit raises `$.ui.focus` with the plugin's arguments: no origin.
    const isPerson = e.origin?.kind === 'person'
    const dest = isPerson ? landing(ring.stops, ring.at, e.element) : undefined
    // Down off the last row onto one of the engine's own stops: the engine
    // refuses an element in place of its stop, so the ring is kept as the
    // event documents it, by answering without next. It stays on that row.
    if (dest !== undefined && e.element === undefined) return {}
    const sent = dest !== undefined && dest !== e.element ? { ...e, element: dest } : e
    const settled = await next(sent)
    if (settled.deny === undefined) ring.at = sent.element
    return settled
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    try {
      // A new draw of the pane: Rasters it does not track again stop painting.
      begin(PANE)
      // The look option is read on every draw (a press on the Options card's Look row applies at once).
      const rest = await drawnOf($, e, options, lookOption())
      const width = tier(cols)
      // Under 32 columns a hotkeyed tab cannot be drawn: slim is one stacked summary. So is the desktop's `widget` placement (R32): a glance, not the tabs.
      const tree =
        width === 'slim' || e.props.placement === 'widget' ? (
          <Box flexDirection="column">{slim($, e, rest)}</Box>
        ) : (
          <Box flexDirection="column">
            {tabBar($, e, rest, width)}
            {tabsGap($, e)}
            {withFooterOptions($, e, rest, body($, e, rest))}
          </Box>
        )
      // The ring starts on the first content row: the tab bar is never its start.
      const out = withStart(tree, isTabKey)
      ring.stops = stopsOf(out, isTabKey)
      ring.input = e
      ring.look = rest.look
      ring.options = options
      return out
    } catch (err) {
      debug($, `pane failed: ${errText(err)}`)
      return <Text dimColor>{`Mission Control: ${errText(err)}`.slice(0, Math.max(1, cols))}</Text>
    }
  })
}

/**
 * The tab bar and its track (the cockpit mocks): five plain hotkeyed Buttons,
 * each in a Box of the tier's cell width (12, 7 or 5) from column 2, on one
 * line with no wrap and no separators; the open tab bold in the accent, the
 * others dim. Under each tab its own underline, as long as its `n: Label`:
 * `━` in the accent under the open one, `─` in `subtle` under the others,
 * and nothing between them, so the track never runs on under the closed tabs.
 * `0: options` is armed, never drawn (see `optionsArm`).
 */
function tabBar($: EngineInterface, e: RenderInput, rest: Drawn, width: Exclude<Tier, 'slim'>): RenderElement {
  const { u, cols, showCost } = rest
  const { Box, Text, Button } = $.ui.resolve(e)
  const cell = TAB_CELL[width]
  return (
    <Box key="tab-bar" flexDirection="column">
      <Box key="tabs" flexDirection="row">
        <Text>{' '.repeat(GRID.margin)}</Text>
        {TABS.map(x => {
          const label = tabLabel(x, width)
          const isOpen = x.tab === u.tab
          return (
            <Box key={`tabcell-${x.tab}`} width={cell}>
              <Button
                key={`tab-${x.tab}`}
                hotkey={x.hotkey}
                plain
                dimColor={isOpen ? undefined : true}
                onPress={() => switchTab($, x.tab, showCost)}
              >
                {isOpen ? (
                  <Text color={C.accent} bold>
                    {label}
                  </Text>
                ) : (
                  label
                )}
              </Button>
            </Box>
          )
        })}
        {optionsArm($, e, u, cols)}
      </Box>
      <Text key="track" wrap="truncate-end">
        {' '.repeat(GRID.margin)}
        {TABS.map((x, i) => {
          const span = x.hotkey.length + 2 + tabLabel(x, width).length
          const isOpen = x.tab === u.tab
          const last = i === TABS.length - 1
          return (
            <Text key={`track-${x.tab}`} color={isOpen ? C.accent : C.subtle}>
              {(isOpen ? '━' : '─').repeat(span)}
              {last ? '' : ' '.repeat(Math.max(0, cell - span))}
            </Text>
          )
        })}
      </Text>
    </Box>
  )
}

/** The Options Button's label: `0: options`. */
const OPTIONS_LABEL = 'options'

/**
 * The Options Button (`0`): opens the Options page, or closes it when it is
 * open. The mocks' footer says `0 options` as text and draw no button for
 * it, so this one is armed and not seen: a Box of no size that clips it. It
 * stays a real Button (key `tab-options`) so the hotkey, a press and the focus
 * ring reach it at every width. The hotkey is `0`, as a Button takes only a
 * digit or a lowercase letter (the mocks' `,` is not one).
 */
function optionsArm($: EngineInterface, e: RenderInput, u: UiState, cols: number): RenderElement | null {
  if (cols < 1) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const isOpen = pageOf(u)?.kind === 'options'
  return (
    <Box key="tabs-options-arm" width={0} height={0} overflow="hidden">
      <Button key={OPTIONS_KEY} hotkey={OPTIONS_HOTKEY} plain dimColor={isOpen ? undefined : true} onPress={() => toggleOptions($, isOpen)}>
        <Text>{OPTIONS_LABEL}</Text>
      </Button>
    </Box>
  )
}

/** The blank row under the tab bar. */
function tabsGap($: EngineInterface, e: RenderInput): RenderElement {
  const { Text } = $.ui.resolve(e)
  return <Text key="tabs-gap">{' '}</Text>
}

/** The key of the footer's visible Options Button (no hotkey: the hidden `tab-options` arms `0`). */
export const FOOTER_OPTIONS_KEY = 'footer-options'
/** The footer's Options hint: `0 options`, nine cells. */
const FOOTER_OPTIONS_WIDTH = 9

type Node = RenderNode | undefined | null | false

const isEl = (n: Node): n is RenderElement => typeof n === 'object' && n !== null
const propsOf = (el: RenderElement): Record<string, unknown> => ('props' in el && el.props !== undefined ? (el.props as Record<string, unknown>) : {})
const kidsOf = (el: RenderElement): Node[] => {
  const c = (el as { children?: Node[] }).children
  return Array.isArray(c) ? c : []
}
/** A node's text, its children's strings joined. */
function textOfNode(n: Node): string {
  if (typeof n === 'string') return n
  if (typeof n === 'number') return String(n)
  return isEl(n) ? kidsOf(n).map(textOfNode).join('') : ''
}

/** The columns a node's text takes on one row (a Button's label when it has no children; a plain hotkeyed Button is drawn `k: label`). */
function widthOfNode(n: Node): number {
  if (typeof n === 'string') return n.length
  if (typeof n === 'number') return String(n).length
  if (!isEl(n)) return 0
  const kids = kidsOf(n)
  const own = kids.length === 0 ? (typeof propsOf(n).label === 'string' ? (propsOf(n).label as string).length : 0) : kids.reduce<number>((w, k) => w + widthOfNode(k), 0)
  const hotkey = n.type === 'Button' ? propsOf(n).hotkey : undefined
  return typeof hotkey === 'string' ? own + hotkey.length + 2 : own
}

/**
 * The Options key drawn where the mocks keep their hints (task C6): the
 * footer's `0 options`, the key in the accent and the word dim (R28), as a
 * plain Button with no hotkey (the engine would draw `0:` on a hotkeyed one)
 * that presses the same toggle as the hidden `tab-options`, which keeps
 * arming `0`. A footer that already says `0 options` as text (Now) has it
 * turned into the Button in place; any other footer takes it at its right
 * end when its hints leave the room (no hint is ever given up for it). Nothing
 * where there is no footer (the pane has not the keys, a page of its own) or
 * on the Options page itself.
 */
function withFooterOptions($: EngineInterface, e: RenderInput, rest: Drawn, tree: RenderElement): RenderElement {
  if (pageOf(rest.u)?.kind === 'options') return tree
  const { Box, Text, Button } = $.ui.resolve(e)
  const isOpen = false
  const button = (): RenderElement => (
    <Button key={FOOTER_OPTIONS_KEY} plain onPress={() => toggleOptions($, isOpen)}>
      <Text color={CK.accent}>{OPTIONS_HOTKEY}</Text>
      <Text dimColor>{` ${OPTIONS_LABEL}`}</Text>
    </Button>
  )
  const { left, right } = edges(rest.cols)
  let done = false
  const walk = (n: Node): Node => {
    if (done || !isEl(n)) return n
    if (propsOf(n).key === 'footer' && n.type === 'Box') {
      done = true
      const kids = kidsOf(n).filter((k): k is RenderNode => k !== null && k !== undefined && k !== false)
      const at = kids.findIndex(k => isEl(k) && k.type === 'Text' && textOfNode(k) === `${OPTIONS_HOTKEY} ${OPTIONS_LABEL}`)
      if (at >= 0) return { ...n, children: kids.map((k, i) => (i === at ? button() : k)) } as RenderElement
      const gap = typeof propsOf(n).columnGap === 'number' ? (propsOf(n).columnGap as number) : 3
      const used = (list: RenderNode[]): number => left + list.reduce((w, k) => w + widthOfNode(k), 0) + gap * Math.max(0, list.length - 1)
      const start = right - FOOTER_OPTIONS_WIDTH + 1
      // A footer already full to the right edge keeps its hints and draws no Options key (the hidden `0` still arms): a hint is never given up for it.
      if (used(kids) + gap > start) return n
      const room = start - used(kids) - 2 * gap
      const out: RenderNode[] = [...kids]
      if (room > 0) out.push(<Box key="footer-options-gap" width={room} flexShrink={0} />)
      out.push(button())
      return { ...n, children: out } as RenderElement
    }
    const kids = kidsOf(n)
    if (kids.length === 0) return n
    const next = kids.map(walk)
    return next.some((c, i) => c !== kids[i]) ? ({ ...n, children: next } as RenderElement) : n
  }
  return walk(tree) as RenderElement
}

type Drawn = {
  t: Timeline; u: UiState; cols: number; now: number; showCost: boolean
  isFocused: boolean; bodyRows: number; look: Look; site: string
  ground: Ground; motion: boolean; accent: string; isPromptCovered: boolean
}

/**
 * What a drawing of the pane reads: the state, the clock and the pane's
 * props, and the look, once per draw, from the surface's element table.
 * The theme (`/config`'s `theme` row) gives the Raster ground under the
 * `ground` option's `auto`, and on an ANSI or daltonized theme the text look
 * unless the `look` option asks for another (R21).
 */
async function drawnOf($: EngineInterface, e: RenderInput<'Pane'>, options: PluginOptions, look?: string): Promise<Drawn> {
  const theme = await themeOf($)
  const asked = lookAsked(look, theme)
  return {
    look: lookFor($.ui.resolve(e), e.surface, asked !== undefined ? { look: asked } : {}),
    site: PANE,
    t: await readTimeline($),
    u: await readUi($),
    cols: e.props.bodyColumns,
    now: await $.clock.now(),
    showCost: options.showCost === true,
    isFocused: e.props.isFocused,
    bodyRows: e.props.scroll.bodyRows,
    ground: groundOf(options.ground, theme),
    motion: motionOn(options.motion),
    accent: typeof options.accent === 'string' ? options.accent : 'iris',
    isPromptCovered: e.props.isPromptCovered === true,
  }
}

/**
 * A tab's press (its hotkey or a click): opens the tab, then moves the ring
 * onto the tab's first content row, as `autoFocus` marks it in the drawing
 * the switch brings. That row is found by drawing the tab here, from the
 * pane's last render input; `$.ui.focus` waits for the engine's own drawing.
 * Never throws; a ring that cannot move stays where it was.
 */
async function switchTab($: EngineInterface, tab: Tab, showCost: boolean): Promise<void> {
  await updateUi($, cur => ({ ...leavePage(leaveDetail(cur)), tab }))
  const e = ring.input
  if (e === undefined) return
  let key: string | undefined
  try {
    const rest = { ...(await drawnOf($, e, { ...(ring.options ?? {}), showCost })), look: ring.look ?? 'text' }
    if (tier(rest.cols) === 'slim') return
    key = stopsOf(withStart(body($, e, rest), isTabKey), isTabKey).start
    if (key === undefined) return
    const moved = await $.ui.focus({ requestId: PANE, key })
    if (moved.deny !== undefined) debug($, `tab ${tab}: focus ${key} denied: ${moved.deny}`)
  } catch (err) {
    debug($, `tab ${tab}: focus ${key ?? '(none)'} failed: ${errText(err)}`)
  }
}

// The slim stack has its own fallback line, as a tab has in `body`.
function slim($: EngineInterface, e: RenderInput, rest: Drawn): RenderElement {
  const { Text } = $.ui.resolve(e)
  try {
    return slimView({ e, ...rest }, $)
  } catch (err) {
    debug($, `slim view failed: ${errText(err)}`)
    return <Text dimColor>{`Failed: ${errText(err)}`.slice(0, Math.max(1, rest.cols))}</Text>
  }
}

// A view that throws must not leave the pane blank: one dim line says why (E5).
// Each view is called by name: the engine's scan follows `$` only into
// functions it can see declared or imported, never one held in a variable.
function body($: EngineInterface, e: RenderInput, rest: Drawn): RenderElement {
  const { Text } = $.ui.resolve(e)
  try {
    // A detail page replaces the open tab's list until `b` (or a tab) clears it.
    const open = pageOf(rest.u)
    if (open !== undefined) return pageBody($, e, rest, open.kind, open.id)
    // A step open on the Timeline tab replaces the tab's list.
    if (rest.u.tab === 'timeline' && rest.u.detail !== undefined) return detailView({ e, ...rest }, $)
    switch (rest.u.tab) {
      case 'overview':
        return overviewView({ e, ...rest }, $)
      case 'tasks':
        return tasksView({ e, ...rest }, $)
      case 'agents':
        return agentsView({ e, ...rest }, $)
      case 'timeline':
        return timelineView({ e, ...rest }, $)
      default:
        return artifactsView({ e, ...rest }, $)
    }
  } catch (err) {
    debug($, `view failed: ${errText(err)}`)
    return <Text dimColor>{`This tab failed: ${errText(err)}`.slice(0, Math.max(1, rest.cols))}</Text>
  }
}

/**
 * The body of a detail page: each kind's page is drawn by its view's own
 * function (tasks.tsx `taskPage`, agents.tsx `agentPage`, detail.tsx
 * `stepPage`, artifacts.tsx `artifactPage`), called by name so the engine's
 * scan follows `$` into it.
 */
function pageBody($: EngineInterface, e: RenderInput, rest: Drawn, kind: PageKind, id: string): RenderElement {
  switch (kind) {
    case 'task':
      return taskPage({ e, ...rest }, $, id)
    case 'agent':
      return agentPage({ e, ...rest }, $, id)
    case 'step':
      return stepPage({ e, ...rest }, $, id)
    case 'options':
      return optionsPage({ e, ...rest }, $, id)
    default:
      return artifactPage({ e, ...rest }, $, id)
  }
}

/** The tab a `/mc` digit names: 1 to 5. */
function tabFor(word: string): { tab: Tab; label: string } | undefined {
  return TABS.find(x => word === x.hotkey)
}

/** Whether the person asked for the slim pane; false when the state cannot be read. */
async function isSlim($: EngineInterface): Promise<boolean> {
  try {
    return (await readUi($)).slim
  } catch (err) {
    debug($, `slim read failed: ${errText(err)}`)
    return false
  }
}

/** Whether the person asked for the strip in the band; false when the state cannot be read. */
async function isStrip($: EngineInterface): Promise<boolean> {
  try {
    return (await readUi($)).strip === true
  } catch (err) {
    debug($, `strip read failed: ${errText(err)}`)
    return false
  }
}

/**
 * Turns the strip off and opens the pane the way `/mc` does, at the slim
 * width while `ui.slim`. Throws what the open throws.
 */
async function openPane($: EngineInterface): Promise<{ isPlaced: boolean }> {
  await updateUi($, cur => (cur.strip === true ? { ...cur, strip: false } : cur))
  const opened = await $.ui.open(paneArgs(true, await isSlim($)))
  await setPaneOpen($, opened.isPlaced)
  return opened
}

/**
 * What a press in the band's strip does after its own write (the tab, the
 * agent or step it opens): the strip goes and the pane opens on that.
 * Never throws.
 */
export async function leaveStrip($: EngineInterface): Promise<void> {
  try {
    await openPane($)
  } catch (err) {
    debug($, `leave strip failed: ${errText(err)}`)
  }
}

/**
 * The commands, and nothing else: `/mc`, `/mc 1-5`, `/mc keep <note>`,
 * `/mc export`, `/mc close`, `/mc slim`, `/mc strip`, `/mc options`. `/mc`, `/mc 1-5` and
 * `/mc slim` open the pane and so turn the strip off; `/mc strip` closes it:
 * whichever ran last wins.
 */
export async function runMc($: EngineInterface, args: string): Promise<{ text: string }> {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === '') {
    try {
      await seedBudget($, { skipIfFresh: true })
      const opened = await openPane($)
      if (!opened.isPlaced) return { text: 'Mission Control is open and waits for a wider terminal.' }
      return { text: 'Mission Control opened.' }
    } catch (err) {
      debug($, `open failed: ${errText(err)}`)
      return { text: `Could not open Mission Control: ${errText(err)}` }
    }
  }
  if (word === 'close') {
    try {
      await $.ui.close({ id: PANE })
      await setPaneOpen($, false)
      return { text: 'Mission Control closed.' }
    } catch (err) {
      debug($, `close failed: ${errText(err)}`)
      return { text: `Could not close Mission Control: ${errText(err)}` }
    }
  }
  if (word === 'export') return exportDigest($)
  const target = tabFor(args.trim())
  if (target !== undefined) {
    try {
      await seedBudget($, { skipIfFresh: true })
      await updateUi($, cur => ({ ...leavePage(leaveDetail(cur)), tab: target.tab }))
      const opened = await openPane($)
      if (!opened.isPlaced) return { text: `Mission Control: ${target.label}. It waits for a wider terminal.` }
      return { text: `Mission Control: ${target.label}.` }
    } catch (err) {
      debug($, `tab failed: ${errText(err)}`)
      return { text: `Could not open Mission Control: ${errText(err)}` }
    }
  }
  if (word === 'keep') {
    // Keep is the person's word for the reducer's `pin` event.
    try {
      const note = args.trim().slice('keep'.length).trim()
      return await pinNewest($, note)
    } catch (err) {
      debug($, `keep failed: ${errText(err)}`)
      return { text: `Could not keep: ${errText(err)}` }
    }
  }
  if (word === 'slim') {
    try {
      // From the strip, slim is asked for, not toggled: the last command wins.
      const fromStrip = await isStrip($)
      await updateUi($, cur => ({ ...cur, slim: fromStrip ? true : !cur.slim }))
      const slim = await isSlim($)
      const opened = await openPane($)
      const said = slim ? `Mission Control: slim, ${COLUMNS_SLIM} columns.` : `Mission Control: full width, ${COLUMNS_DOCK} columns.`
      if (!opened.isPlaced) return { text: `${said} It waits for a wider terminal.` }
      return { text: said }
    } catch (err) {
      debug($, `slim failed: ${errText(err)}`)
      return { text: `Could not resize Mission Control: ${errText(err)}` }
    }
  }
  if (word === 'strip') {
    try {
      if (await isStrip($)) {
        const opened = await openPane($)
        if (!opened.isPlaced) return { text: 'Mission Control is open and waits for a wider terminal.' }
        return { text: 'Mission Control opened.' }
      }
      await updateUi($, cur => ({ ...cur, strip: true }))
      await $.ui.close({ id: PANE })
      await setPaneOpen($, false)
      return { text: 'Mission Control: strip, above the prompt.' }
    } catch (err) {
      debug($, `strip failed: ${errText(err)}`)
      return { text: `Could not switch the strip: ${errText(err)}` }
    }
  }
  if (word === 'options') {
    try {
      await updateUi($, cur => ({ ...cur, page: { kind: 'options', id: '' } }))
      const opened = await openPane($)
      if (!opened.isPlaced) return { text: 'Mission Control: options. It waits for a wider terminal.' }
      return { text: 'Mission Control: options.' }
    } catch (err) {
      debug($, `options failed: ${errText(err)}`)
      return { text: `Could not open the options: ${errText(err)}` }
    }
  }
  return { text: 'Unknown. Try /mc, /mc 1-5, keep <note>, export, close, slim, strip or options.' }
}

async function tick($: EngineInterface, notify: NotifyMode | undefined): Promise<void> {
  await needsTick($, notify)
  await budgetTick($)
  try {
    const t = await readTimeline($)
    // `main` is a row of its own and stays 'running' for the whole session.
    const isAgentRunning = Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running')
    const isStepRunning = t.steps.some(s => s.status === 'running')
    if (isAgentRunning || isStepRunning) $.ui.invalidate('ui.render')
  } catch (err) {
    debug($, `tick failed: ${errText(err)}`)
  }
}

/** Session-start work, called from register.tsx's one session.start hook. Never throws. */
export async function startShell($: EngineInterface, options: { autoOpen?: boolean; notify?: NotifyMode }): Promise<void> {
  // The strip stands in for the pane: a reload or a resumed session keeps it.
  if (options.autoOpen === true && !(await isStrip($))) {
    try {
      const opened = await $.ui.open(paneArgs(false, await isSlim($)))
      if (!opened.isPlaced) debug($, `pane waits: ${opened.reason}`)
    } catch (err) {
      debug($, `autoOpen failed: ${errText(err)}`)
    }
  }
  // A restored or reloaded session starts with the flag false until the engine says the pane is up.
  await syncPaneOpen($)
  // A draw makes a relative path absolute for a file link without waiting on the engine.
  try {
    rememberRoot(await $.session.root())
  } catch (err) {
    debug($, `root read failed: ${errText(err)}`)
  }
  // The mod's one 1 s clock lives in paint.ts: each period runs this tick,
  // then the rich instruments' paint pass. A second start cancels the first.
  try {
    startClock($, () => tick($, options.notify))
  } catch (err) {
    debug($, `clock failed: ${errText(err)}`)
  }
}
