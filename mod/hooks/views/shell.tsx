import type { EngineInterface, On, PaneOpenArgs, RenderElement, RenderInput, Timer } from 'claude-code'

import type { Tab, Timeline, UiState } from '../../types'
import { debug, errText, leaveDetail, readTimeline, readUi, updateUi } from '../state'
import { agentsView } from './agents'
import { detailView } from './detail'
import { rule } from './fit'
import { overviewView } from './overview'
import { C } from './style'
import { tasksView } from './tasks'
import { pinNewest, timelineView } from './timeline'

export const PANE = 'mission-control'

export const TABS: { tab: Tab; label: string; hotkey: string }[] = [
  { tab: 'overview', label: 'Overview', hotkey: '1' },
  { tab: 'tasks', label: 'Tasks', hotkey: '2' },
  { tab: 'agents', label: 'Agents', hotkey: '3' },
  { tab: 'timeline', label: 'Timeline', hotkey: '4' },
  { tab: 'artifacts', label: 'Artifacts', hotkey: '5' },
]

/**
 * What a tab draws: the state is read before, so a view is a plain function of
 * it. `$` is its own argument because the engine's scan refuses `$` held in an
 * object.
 */
export type ViewCtx = { e: RenderInput; t: Timeline; u: UiState; cols: number; now: number }
export type View = (ctx: ViewCtx, $: EngineInterface) => RenderElement

const NARROW = 56
const ROWS_INLINE = 14
const COLUMNS_DOCK = 62

/** The pane's `$.ui.open` arguments. `focus` accepts only true, so it is added or left out. */
function paneArgs(isFocused: boolean): PaneOpenArgs {
  const args: PaneOpenArgs = { id: PANE, title: 'Mission Control', columns: COLUMNS_DOCK, rows: ROWS_INLINE }
  if (isFocused) args.focus = true
  return args
}

export function registerShell(on: On, _options: { autoOpen?: boolean }): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    try {
      const t = await readTimeline($)
      const u = await readUi($)
      const now = await $.clock.now()
      const short = cols < NARROW
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {TABS.flatMap((x, i) => {
              const label = short ? x.label.slice(0, 3) : x.label
              const isOpen = x.tab === u.tab
              const tab = (
                <Button
                  key={`tab-${x.tab}`}
                  hotkey={x.hotkey}
                  plain
                  dimColor={!isOpen}
                  onPress={() => updateUi($, cur => ({ ...leaveDetail(cur), tab: x.tab }))}
                >
                  {isOpen ? (
                    <Text backgroundColor={C.accent} color={C.tabFg} bold>{` ${label} `}</Text>
                  ) : (
                    <Text>{label}</Text>
                  )}
                </Button>
              )
              if (i === 0) return [tab]
              return [
                <Text key={`sep-${x.tab}`} dimColor>
                  │
                </Text>,
                tab,
              ]
            })}
          </Box>
          <Text color={C.rule}>{rule(cols)}</Text>
          {body($, e, { t, u, cols, now })}
        </Box>
      )
    } catch (err) {
      debug($, `pane failed: ${errText(err)}`)
      return <Text dimColor>{`Mission Control: ${errText(err)}`.slice(0, Math.max(1, cols))}</Text>
    }
  })
}

type Drawn = { t: Timeline; u: UiState; cols: number; now: number }

// A view that throws must not leave the pane blank: one dim line says why (E5).
// Each view is called by name: the engine's scan follows `$` only into
// functions it can see declared or imported, never one held in a variable.
function body($: EngineInterface, e: RenderInput, rest: Drawn): RenderElement {
  const { Text } = $.ui.resolve(e)
  try {
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
        // The tabs whose task has not landed yet.
        return <Text dimColor>Coming in a later task.</Text>
    }
  } catch (err) {
    debug($, `view failed: ${errText(err)}`)
    return <Text dimColor>{`This tab failed: ${errText(err)}`.slice(0, Math.max(1, rest.cols))}</Text>
  }
}

/** The tab a `/mc` word names: its number, its name, or a 3-letter prefix of it. */
function tabFor(word: string): { tab: Tab; label: string } | undefined {
  const w = word.toLowerCase()
  for (const x of TABS) {
    if (w === x.hotkey || w === x.tab) return x
    if (w.length === 3 && x.tab.startsWith(w)) return x
  }
  return undefined
}

/** The answer of `/mc`, `/mc close` and `/mc pin`. */
export async function runMc($: EngineInterface, args: string): Promise<{ text: string }> {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === '') {
    try {
      const opened = await $.ui.open(paneArgs(true))
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
      return { text: 'Mission Control closed.' }
    } catch (err) {
      debug($, `close failed: ${errText(err)}`)
      return { text: `Could not close Mission Control: ${errText(err)}` }
    }
  }
  const target = tabFor(word)
  if (word !== 'pin' && target !== undefined) {
    try {
      await updateUi($, cur => ({ ...leaveDetail(cur), tab: target.tab }))
      const opened = await $.ui.open(paneArgs(true))
      if (!opened.isPlaced) return { text: `Mission Control: ${target.label}. It waits for a wider terminal.` }
      return { text: `Mission Control: ${target.label}.` }
    } catch (err) {
      debug($, `tab failed: ${errText(err)}`)
      return { text: `Could not open Mission Control: ${errText(err)}` }
    }
  }
  if (word === 'pin') {
    try {
      const note = args.trim().slice('pin'.length).trim()
      return await pinNewest($, note)
    } catch (err) {
      debug($, `pin failed: ${errText(err)}`)
      return { text: `Could not pin: ${errText(err)}` }
    }
  }
  return { text: 'Unknown tab. Try /mc 1-5 or a tab name.' }
}

// The one timer of this module instance; a reload starts a fresh module.
let ticker: Timer | undefined

async function tick($: EngineInterface): Promise<void> {
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
export async function startShell($: EngineInterface, options: { autoOpen?: boolean }): Promise<void> {
  if (options.autoOpen === true) {
    try {
      const opened = await $.ui.open(paneArgs(false))
      if (!opened.isPlaced) debug($, `pane waits: ${opened.reason}`)
    } catch (err) {
      debug($, `autoOpen failed: ${errText(err)}`)
    }
  }
  try {
    if (ticker) ticker.cancel()
    ticker = $.clock.every(1000, () => {
      void tick($)
    })
  } catch (err) {
    debug($, `clock failed: ${errText(err)}`)
  }
}
