import type { EngineInterface, On, PaneOpenArgs, PluginOptions, RenderElement, RenderInput } from 'claude-code'

import type { PageKind, Tab, Timeline, UiState } from '../../types'
import { debug, errText, leaveDetail, readTimeline, readUi, updateUi } from '../state'
import { cacheLine } from '../model/meter'
import { agentPage, agentsView } from './agents'
import { artifactPage, artifactsView } from './artifacts'
import { stepPage } from './detail'
import { configureEditor, rememberRoot } from './editor'
import { exportDigest } from './handoff'
import { overviewView } from './overview'
import { leavePage, pageOf } from './pagenav'
import { begin, clockRunning, forget, startClock } from './paint'
import { budgetTick, seedBudget } from './budget'
import { delightsTick } from './delights'
import { needsTick, observeCover } from './needs'
import type { NotifyMode } from './needs'
import { accentOption, configureOptions, lookOption, OPTIONS_HOTKEY, optionsPage, toggleOptions } from './options'
import { slimView } from './slim'
import { C, GRID, groundOf, lookAsked, motionOn, themeOf, tier } from './style'
import type { Ground, Look } from './style'
import { lookFor } from './svgview'
import { taskPage, tasksView } from './tasks'
import { pinNewest, timelineView } from './timeline'
import { landing, stopsOf, withStart } from './ring'
import type { Stops } from './ring'
import { aspectFromEnv, setCellAspect } from './raster'

export const PANE = 'binnacle'

/**
 * The five tabs and their label per width (R42, back at its original threshold,
 * R3-B M16): `label` (the full names) from 54 columns, `short` (whole short words)
 * from 38, `icon` from 32. Under 32 (slim) no tab is drawn. A tab is drawn
 * `n: label`, so five full names take 53 columns with two spaces between and
 * five short words 42 with one; from 38 to 42 the short words are `n:label`
 * (the colon with no space, hotkeys armed apart), which take 36 with one space.
 */
export const TABS: { tab: Tab; label: string; short: string; icon: string; hotkey: string }[] = [
  { tab: 'overview', label: 'Now', short: 'Now', icon: '◆', hotkey: '1' },
  { tab: 'tasks', label: 'Tasks', short: 'Tasks', icon: '▣', hotkey: '2' },
  { tab: 'agents', label: 'Agents', short: 'Crew', icon: '◎', hotkey: '3' },
  { tab: 'timeline', label: 'Steps', short: 'Steps', icon: '≡', hotkey: '4' },
  { tab: 'artifacts', label: 'Artifacts', short: 'Files', icon: '↗', hotkey: '5' },
]

/** How the tab bar is laid out at `cols`: which label each tab shows and the width of one tab's cell (the gap included). */
export type TabPlan = { form: 'label' | 'short' | 'icon'; /** The short words as `n:label`, 38 to 42 columns. */ compact: boolean; cell: (i: number) => number }

/** The mocks' 12-wide cells from 62 columns; from 54 the full names with two spaces between; from 47 the short words with two, from 43 with one, from 38 as `n:label` with one; icons below. */
export function tabPlan(cols: number): TabPlan {
  const form = cols >= 54 ? 'label' : cols >= 38 ? 'short' : 'icon'
  const compact = form === 'short' && cols < 43
  if (cols >= 62) return { form, compact, cell: () => 12 }
  if (form === 'icon') return { form, compact, cell: () => 5 }
  const gap = cols >= 47 || form === 'label' ? 2 : 1
  return { form, compact, cell: i => TABS[i]!.hotkey.length + (compact ? 1 : 2) + labelOf(TABS[i]!, form).length + gap }
}

/** A tab's label in a form. */
function labelOf(x: (typeof TABS)[number], form: TabPlan['form']): string {
  return form === 'label' ? x.label : form === 'short' ? x.short : x.icon
}

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
  /** A dry draw (the hidden one that finds a tab's first row): no instrument is tracked, no burst starts or stops, nothing is recorded. */
  dry?: boolean
}

/** The rows the tab bar takes above a tab's body: the tabs, their track and the blank under them. */
export const TAB_ROWS = 3
export type View = (ctx: ViewCtx, $: EngineInterface) => RenderElement

/** The key of the tab bar's Options Button (`0`): reached, like a tab, by its hotkey and a click. */
export const OPTIONS_KEY = 'tab-options'

/** The key prefix of a hidden armed Button (`armKeys`): never a stop the ring lands on. */
export const ARM_PREFIX = 'arm-'

/** Whether `key` is one of the tab bar's Buttons, or a hidden armed key (the ring treats both as not content). */
export function isTabKey(key: string): boolean {
  return key === OPTIONS_KEY || key.startsWith(ARM_PREFIX) || TABS.some(x => key === `tab-${x.tab}`)
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
  const args: PaneOpenArgs = { id: PANE, title: 'Binnacle', columns: slim ? COLUMNS_SLIM : COLUMNS_DOCK, rows: ROWS_INLINE }
  if (isFocused) args.focus = true
  return args
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
  // Observes every close of the pane (the person's own, /binnacle close, a press): the
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
  // tab's rows, and the tabs are reached by their hotkeys, a click and /binnacle 1-5.
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
      // Every tab notes what the pane saw, so an answered ask clears whichever tab is open (FX1 concern 2).
      observeCover({ t: rest.t, now: rest.now, isPromptCovered: rest.isPromptCovered, e })
      const width = tier(cols)
      // Under 32 columns a hotkeyed tab cannot be drawn: slim is one stacked summary. So is the desktop's `widget` placement (R32): a glance, not the tabs.
      const tree =
        width === 'slim' || e.props.placement === 'widget' ? (
          <Box flexDirection="column">{slim($, e, rest)}</Box>
        ) : (
          <Box flexDirection="column">
            {tabBar($, e, rest)}
            {tabsGap($, e)}
            {body($, e, rest)}
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
      return <Text dimColor>{`Binnacle: ${errText(err)}`.slice(0, Math.max(1, cols))}</Text>
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
 * `0 options` is armed here, never drawn (see `optionsArm`).
 */
function tabBar($: EngineInterface, e: RenderInput, rest: Drawn): RenderElement {
  const { u, cols, showCost } = rest
  const { Box, Text, Button } = $.ui.resolve(e)
  const plan = tabPlan(cols)
  return (
    <Box key="tab-bar" flexDirection="column">
      <Box key="tabs" flexDirection="row">
        <Text>{' '.repeat(GRID.margin)}</Text>
        {TABS.map((x, i) => {
          const label = plan.compact ? `${x.hotkey}:${labelOf(x, plan.form)}` : labelOf(x, plan.form)
          const isOpen = x.tab === u.tab
          return (
            <Box key={`tabcell-${x.tab}`} width={plan.cell(i)}>
              <Button
                key={`tab-${x.tab}`}
                {...(plan.compact ? {} : { hotkey: x.hotkey })}
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
        {plan.compact ? armKeys($, e, TABS.map(x => ({ id: `tab-${x.tab}`, hotkey: x.hotkey, onPress: () => switchTab($, x.tab, showCost) }))) : null}
        {optionsArm($, e, u, cols)}
      </Box>
      <Text key="track" wrap="truncate-end">
        {' '.repeat(GRID.margin)}
        {TABS.map((x, i) => {
          const span = x.hotkey.length + (plan.compact ? 1 : 2) + labelOf(x, plan.form).length
          const isOpen = x.tab === u.tab
          const last = i === TABS.length - 1
          return (
            <Text key={`track-${x.tab}`} color={isOpen ? C.accent : C.subtle}>
              {(isOpen ? '━' : '─').repeat(span)}
              {last ? '' : ' '.repeat(Math.max(0, plan.cell(i) - span))}
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

/**
 * The footer's hidden armed keys (R28 amended): `n`, `p` and other keys that
 * have no visible Button in the body, each a plain Button in a Box of no size
 * that clips it, so the footer text is the only thing drawn. The one place
 * these are made (with `optionsArm` for `0`); `footerRow` calls it. Keyed
 * `arm-<id>`, which the ring treats as not content (`isTabKey`).
 */
export function armKeys($: EngineInterface, e: RenderInput, arms: { id: string; hotkey: string; onPress: () => void | Promise<void> }[]): RenderElement | null {
  if (arms.length === 0) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box key="footer-arms" width={0} height={0} overflow="hidden">
      {arms.map(x => (
        <Button key={`${ARM_PREFIX}${x.id}`} hotkey={x.hotkey} plain onPress={x.onPress}>
          <Text>{x.hotkey}</Text>
        </Button>
      ))}
    </Box>
  )
}

type Drawn = {
  t: Timeline; u: UiState; cols: number; now: number; showCost: boolean
  isFocused: boolean; bodyRows: number; look: Look; site: string
  ground: Ground; motion: boolean; accent: string; isPromptCovered: boolean; dry?: boolean
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
  const accent = accentOption() ?? options.accent
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
    accent: typeof accent === 'string' ? accent : 'iris',
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
    // Drawn only to find the first row, never shown: no one-shot move starts here (motion sketches).
    const rest = { ...(await drawnOf($, e, { ...(ring.options ?? {}), showCost })), look: ring.look ?? 'text', motion: false, dry: true }
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

/** The tab a `/binnacle` digit names: 1 to 5. */
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
 * Turns the strip off and opens the pane the way `/binnacle` does, at the slim
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
 * The commands, and nothing else: `/binnacle`, `/binnacle 1-5`, `/binnacle keep <note>`,
 * `/binnacle export`, `/binnacle close`, `/binnacle slim`, `/binnacle strip`, `/binnacle options`. `/binnacle`, `/binnacle 1-5` and
 * `/binnacle slim` open the pane and so turn the strip off; `/binnacle strip` closes it:
 * whichever ran last wins.
 */
export async function runMc($: EngineInterface, args: string): Promise<{ text: string }> {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === '') {
    try {
      await seedBudget($, { skipIfFresh: true })
      const opened = await openPane($)
      if (!opened.isPlaced) return { text: 'Binnacle is open and waits for a wider terminal.' }
      return { text: 'Binnacle opened.' }
    } catch (err) {
      debug($, `open failed: ${errText(err)}`)
      return { text: `Could not open Binnacle: ${errText(err)}` }
    }
  }
  if (word === 'close') {
    try {
      await $.ui.close({ id: PANE })
      await setPaneOpen($, false)
      return { text: 'Binnacle closed.' }
    } catch (err) {
      debug($, `close failed: ${errText(err)}`)
      return { text: `Could not close Binnacle: ${errText(err)}` }
    }
  }
  if (word === 'export') return exportDigest($)
  const target = tabFor(args.trim())
  if (target !== undefined) {
    try {
      await seedBudget($, { skipIfFresh: true })
      await updateUi($, cur => ({ ...leavePage(leaveDetail(cur)), tab: target.tab }))
      const opened = await openPane($)
      if (!opened.isPlaced) return { text: `Binnacle: ${target.label}. It waits for a wider terminal.` }
      return { text: `Binnacle: ${target.label}.` }
    } catch (err) {
      debug($, `tab failed: ${errText(err)}`)
      return { text: `Could not open Binnacle: ${errText(err)}` }
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
      const said = slim ? `Binnacle: slim, ${COLUMNS_SLIM} columns.` : `Binnacle: full width, ${COLUMNS_DOCK} columns.`
      if (!opened.isPlaced) return { text: `${said} It waits for a wider terminal.` }
      return { text: said }
    } catch (err) {
      debug($, `slim failed: ${errText(err)}`)
      return { text: `Could not resize Binnacle: ${errText(err)}` }
    }
  }
  if (word === 'strip') {
    try {
      if (await isStrip($)) {
        const opened = await openPane($)
        if (!opened.isPlaced) return { text: 'Binnacle is open and waits for a wider terminal.' }
        return { text: 'Binnacle opened.' }
      }
      await updateUi($, cur => ({ ...cur, strip: true }))
      await $.ui.close({ id: PANE })
      await setPaneOpen($, false)
      return { text: 'Binnacle: strip, above the prompt.' }
    } catch (err) {
      debug($, `strip failed: ${errText(err)}`)
      return { text: `Could not switch the strip: ${errText(err)}` }
    }
  }
  if (word === 'options') {
    try {
      await updateUi($, cur => ({ ...cur, page: { kind: 'options', id: '' } }))
      const opened = await openPane($)
      if (!opened.isPlaced) return { text: 'Binnacle: options. It waits for a wider terminal.' }
      return { text: 'Binnacle: options.' }
    } catch (err) {
      debug($, `options failed: ${errText(err)}`)
      return { text: `Could not open the options: ${errText(err)}` }
    }
  }
  return { text: 'Unknown. Try /binnacle, /binnacle 1-5, keep <note>, export, close, slim, strip or options.' }
}

/** How long after its last event the session still counts as live: the toasts, notifications and sweep the tick raises are fresh for 15 s at most. */
const LIVE_AFTER_MS = 20_000

/**
 * Whether the clock has anything to do (M10): a step, a subagent or the main
 * turn runs; something ended, was measured or was asked within LIVE_AFTER_MS;
 * or the prompt cache is warm (its countdown redraws by the minute). Pure.
 */
export function clockLive(t: Timeline, now: number): boolean {
  if (t.steps.some(s => s.status === 'running')) return true
  if (Object.values(t.agents).some(a => a.id !== 'main' && (a.status === 'running' || (a.endedAt !== undefined && now - a.endedAt <= LIVE_AFTER_MS)))) return true
  for (const x of t.turns) if ((x.agent === 'main' && x.endedAt === undefined) || (x.endedAt !== undefined && now - x.endedAt <= LIVE_AFTER_MS)) return true
  if (t.budget !== undefined && now - t.budget.at <= LIVE_AFTER_MS) return true
  if ((t.asks ?? []).length > 0) return true
  const warm = cacheLine(t).warmUntil
  return warm !== undefined && warm > now
}

/** The clock's tick; resolves whether the clock should keep running (`clockLive`). */
async function tick($: EngineInterface, notify: NotifyMode | undefined, motion: boolean): Promise<boolean> {
  await needsTick($, notify)
  await budgetTick($)
  await delightsTick($, { motion })
  try {
    const t = await readTimeline($)
    // `main` is a row of its own and stays 'running' for the whole session.
    const isAgentRunning = Object.values(t.agents).some(a => a.id !== 'main' && a.status === 'running')
    const isStepRunning = t.steps.some(s => s.status === 'running')
    if (isAgentRunning || isStepRunning) $.ui.invalidate('ui.render')
    return clockLive(t, await $.clock.now())
  } catch (err) {
    debug($, `tick failed: ${errText(err)}`)
    return true
  }
}

/** What the clock's tick reads of the options, set at session start; `wakeClock` needs it to start the clock again. */
let clockOptions: { notify: NotifyMode | undefined; motion: boolean } | undefined

/**
 * Starts the 1 s clock again after it stopped for want of anything live
 * (M10), on the engine of the hook that wrote to the Timeline. No-op while it
 * runs, or before the session started it. Never throws.
 */
export function wakeClock($: EngineInterface): void {
  const o = clockOptions
  if (o === undefined || clockRunning()) return
  try {
    startClock($, () => tick($, o.notify, o.motion))
  } catch (err) {
    debug($, `clock failed: ${errText(err)}`)
  }
}

/** Session-start work, called from register.tsx's one session.start hook. Never throws. */
export async function startShell($: EngineInterface, options: { autoOpen?: boolean; notify?: NotifyMode; motion?: unknown }): Promise<void> {
  // The terminal's cell aspect, for the gauge ring's round dots (FX4): read once here, before the pane can open (M8), never in render.
  try {
    const [WT_SESSION, TERM_PROGRAM, TERM] = await Promise.all([$.env.get('WT_SESSION'), $.env.get('TERM_PROGRAM'), $.env.get('TERM')])
    setCellAspect(aspectFromEnv({ WT_SESSION, TERM_PROGRAM, TERM }))
  } catch (err) {
    debug($, `env read failed: ${errText(err)}`)
  }
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
    clockOptions = { notify: options.notify, motion: motionOn(options.motion) }
    startClock($, () => tick($, options.notify, motionOn(options.motion)))
  } catch (err) {
    debug($, `clock failed: ${errText(err)}`)
  }
}
