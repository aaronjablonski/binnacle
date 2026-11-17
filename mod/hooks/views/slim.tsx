import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, Tab } from '../../types'
import type { Need } from '../model/alerts'
import { oneLine } from '../model/label'
import { leaveDetail, updateUi } from '../state'
import { budgetView, isBudgetOpen, setBudgetOpen, slimGauges } from './budget'
import { doing, listSplit, nameFit, pctBar, span, todoBar, wordFit, wrapWords } from './fit'
import { argOf } from './lay'
import { askerCritter, needsSlot, openNeed, promptRuns } from './needs'
import { cardAgents, noRequest, nowHeader, nowState, noteItems } from './overview'
import { openWatch, watchSentence } from './watch'
import { prChip } from './prblock'
import { openLink } from './artifacts'
import { footerRow } from './tabkit'
import type { NowState } from './overview'
import { blank, heightOf, inst, more, row, runText } from './parts'
import type { Run } from './parts'
import type { ViewCtx } from './shell'
import { C, CK, critterOf, edges, gaugeStyle, statusColor, typeName } from './style'

// Under 32 columns (cockpit spec "CockpitSlim"): one stacked summary, no tab
// bar, in Now's order: the compact header, the needs slot, To do (the bar,
// the current task and the next one), Agents (micro critters), Budget (two
// bars), Notes. Each title is a plain Button with `›` that opens its tab in
// slim form (or the budget view). Short of rows, whole parts go from the
// bottom (R34: Needs you, then To do, then the rest, in that order).

/** Where a section's sum starts: after "Agents" and a space. */
const SUM = 8
/** Where a budget row's bar starts. */
const BAR = 16
const STEP_GLYPH: Record<Step['status'], string> = { running: '▸', done: '✓', error: '✖', denied: '✖', interrupted: '·' }

function openTab($: EngineInterface, tab: Tab): Promise<void> {
  return updateUi($, u => ({ ...leaveDetail(u), tab }))
}


/**
 * A section title as one plain Button: the title bold at 1, the sum at 8
 * when it fits beside `›` (else nothing: the caller draws it on its own
 * row), `›` dim in the last content column.
 */
function title(ctx: ViewCtx, $: EngineInterface, text: string, sum: Run[], key: string, onPress: () => void | Promise<void>, tone?: 'ask'): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const sw = sum.reduce((n, r) => n + r.text.length, 0)
  const at = Math.max(SUM, left + text.length + 1)
  const fits = sw > 0 && at + sw <= right - 1
  const runs: Run[] = [{ text, bold: true, ...(tone === 'ask' ? { color: CK.ask } : {}) }]
  let used = left + text.length
  if (fits) {
    runs.push({ text: ' '.repeat(at - used) }, ...sum)
    used = at + sw
  }
  runs.push({ text: ' '.repeat(Math.max(1, right - used)) }, { text: '›', dim: true })
  return (
    <Box key={`row-${key}`} flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      <Button key={key} plain onPress={onPress}>
        {runs.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
      </Button>
    </Box>
  )
}

/** Whether a title's sum fits on its row (else it takes a row of its own under it). */
function sumFits(ctx: ViewCtx, text: string, sum: Run[]): boolean {
  const { left, right } = edges(ctx.cols)
  const sw = sum.reduce((n, r) => n + r.text.length, 0)
  return Math.max(SUM, left + text.length + 1) + sw <= right - 1
}

/** A sum on its own row at the left edge. */
function sumRow(ctx: ViewCtx, $: EngineInterface, sum: Run[], key: string): RenderElement {
  const { Text } = $.ui.resolve(ctx.e)
  return (
    <Text key={key} wrap="truncate-end">
      {' '.repeat(edges(ctx.cols).left)}
      {sum.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
    </Text>
  )
}

type Block = RenderElement[]

/** The slim Needs you: the amber head and count, then behind `▍` who asks, the command wrapped to two lines, the words in place of a control (R3). */
function needsBlock(ctx: ViewCtx, $: EngineInterface, st: NowState): Block {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const items = st.view.items
  const n: Need | undefined = items[0]
  if (n === undefined) return needsSlot(ctx, $, st.view)
  const { left, right } = edges(ctx.cols)
  const room = right - (left + 1) + 1
  const verb = n.kind === 'permission' && (n.tool === 'Bash' || n.tool === 'PowerShell') ? 'asks to run' : n.verb
  const head = wrapWords(`${n.who} ${verb}`, room, 2)
  const cmd = oneLine(n.kind === 'input' ? n.message ?? '' : n.command ?? '')
  const lines = cmd !== '' ? wrapWords(cmd, room, 2) : []
  const hint = promptRuns(n, ctx.isFocused === true, room)
  const mark = (k: string, body: RenderElement | string): RenderElement => (
    <Box key={k} flexDirection="row">
      <Text color={CK.ask}>{'▍ '}</Text>
      {body}
    </Box>
  )
  const out: Block = [
    <Box key="slim-needs-head" flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      <Text key="slim-needs-title" bold color={CK.ask}>
        {'Needs you'}
      </Text>
      <Text key="slim-needs-count" bold color={CK.ask}>
        {`${' '.repeat(Math.max(1, right - left - 9 - String(items.length).length + 1))}${items.length}`}
      </Text>
    </Box>,
    mark(
      'slim-need-0',
      <Button key={`open-${n.key}`} plain autoFocus onPress={() => openNeed($, n)}>
        {head[0]!.startsWith(n.who)
          ? [
              <Text key="slim-need-who" bold={n.askerAmbiguous ? undefined : true}>
                {n.who}
              </Text>,
              <Text key="slim-need-verb">{head[0]!.slice(n.who.length)}</Text>,
            ]
          : [<Text key="slim-need-line">{head[0]}</Text>]}
      </Button>,
    ),
  ]
  if (head[1] !== undefined) out.push(mark('slim-need-1', <Text key="slim-need-1-t">{head[1]}</Text>))
  lines.forEach((l, i) =>
    out.push(
      mark(
        `slim-need-cmd-${i}`,
        <Text key={`slim-need-cmd-${i}-t`} bold>
          {l}
        </Text>,
      ),
    ),
  )
  out.push(mark('slim-need-hint', <Text key="slim-need-hint-t">{hint.map((r, i) => runText(r, ctx.e, $, `slim-hint-${i}`))}</Text>))
  return out
}

/**
 * Watch in slim (R3-B I6): one dim line with the count and the top item, which opens it ("◔ 2 to watch", then the top
 * row's sentence wrapped under it). With nothing to watch but a quiet turn, "◌ quiet 30 min", as the header says at 62.
 */
function watchSlim(ctx: ViewCtx, $: EngineInterface, st: NowState): Block {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const top = st.watch[0]
  if (top === undefined) {
    if (st.hs.state !== 'working' || st.hs.quiet === 'none' || st.hs.quietMs === undefined) return []
    return [<Text key="slim-quiet" dimColor wrap="truncate-end">{`${' '.repeat(left)}◌ quiet ${span(st.hs.quietMs)}`}</Text>]
  }
  const head = `${st.watch.length} to watch`
  const lines = wrapWords(watchSentence(top), Math.max(1, right - (left + 2) + 1), 3)
  return [
    <Box key="slim-watch-head" flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      <Button key="slim-watch" plain dimColor onPress={() => openWatch($, top, 'slim-watch')}>
        {`◔ ${head}`}
      </Button>
    </Box>,
    ...lines.map((l, i) => (
      <Text key={`slim-watch-${i}`} dimColor wrap="truncate-end">
        {`${' '.repeat(left + 2)}${l}`}
      </Text>
    )),
  ]
}

/** To do in slim: the title and "9 of 14", the bar, a blank, the current task and the next (wrapped to two lines each), `+ n more`. */
function todoBlock(ctx: ViewCtx, $: EngineInterface, st: NowState, full: boolean): Block {
  const { Text } = $.ui.resolve(ctx.e)
  const todo = st.todo
  const { left, right } = edges(ctx.cols)
  const press = (): Promise<void> => openTab($, 'tasks')
  // R3-B M7: before any request there is no list to say is missing.
  if (todo.empty && noRequest(ctx.t)) return []
  if (todo.empty) return [title(ctx, $, 'To do', [], 'slim-go-tasks', press), <Text key="slim-todo-none" dimColor>{`${' '.repeat(left)}${wordFit('No to-do list', right - left + 1)}`}</Text>]
  const sum: Run[] = [{ text: String(todo.done), bold: true }, { text: ` of ${todo.total}`, dim: true }]
  const out: Block = [
    title(ctx, $, 'To do', sum, 'slim-go-tasks', press),
    <Text key="slim-todo-bar">
      {' '.repeat(left)}
      {todoBar(right - left + 1, todo.total, todo.done, todo.current !== undefined ? 1 : 0, todo.paused ? { current: { color: CK.ask } } : {}).map((r, i) => runText(r, ctx.e, $, `slim-bar-${i}`))}
    </Text>,
  ]
  if (!full) return out
  const room = right - (left + 2) + 1
  const pending = todo.items.filter(x => x.status === 'pending')
  const rows: Block = []
  const task = (key: string, glyph: Run, text: string, bold: boolean): void => {
    wrapWords(oneLine(text), room, 2).forEach((l, i) =>
      rows.push(
        <Text key={`${key}-${i}`} wrap="truncate-end">
          {' '.repeat(left)}
          {i === 0 ? runText(glyph, ctx.e, $, `${key}-g`) : ' '}
          {' '}
          <Text bold={bold ? true : undefined}>{l}</Text>
        </Text>,
      ),
    )
  }
  if (todo.current !== undefined) task('slim-task', { text: '▸', color: todo.paused ? CK.ask : CK.accent }, todo.current.subject, true)
  const next = pending[0]
  if (next !== undefined) task('slim-next', { text: '○', color: CK.rule }, next.subject, false)
  const shown = (todo.current !== undefined ? 1 : 0) + (next !== undefined ? 1 : 0)
  const rest = todo.open - shown
  if (rest > 0) rows.push(<Text key="slim-todo-more" dimColor>{`${' '.repeat(left + 2)}+ ${rest} more`}</Text>)
  if (todo.current === undefined && next === undefined) rows.push(<Text key="slim-todo-all" dimColor>{`${' '.repeat(left)}All ${todo.total} done`}</Text>)
  return [...out, blank(ctx, $, 'slim-todo-gap'), ...rows]
}

/** Agents in slim: the title and its sum (R30: "1 working · 1 waiting", on its own row when it does not fit), then each card agent as a micro critter at 1 with its name and what it does at 7. */
function agentsBlock(ctx: ViewCtx, $: EngineInterface, st: NowState, max: number): Block {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const all = cardAgents(ctx.t).filter(a => a.status === 'running')
  if (all.length === 0) return []
  const { left, right } = edges(ctx.cols)
  const asking = new Map(st.view.items.map(n => [n.agent, n]))
  const waiting = all.filter(a => asking.has(a.id)).length
  const sum: Run[] = [{ text: String(all.length - waiting), bold: true }, { text: ' working', dim: true }]
  if (waiting > 0) sum.push({ text: ' · ', dim: true }, { text: String(waiting), color: CK.ask, bold: true }, { text: ' waiting', color: CK.ask })
  const press = (): Promise<void> => openTab($, 'agents')
  const out: Block = [title(ctx, $, 'Agents', sumFits(ctx, 'Agents', sum) ? sum : [], 'slim-go-agents', press)]
  if (!sumFits(ctx, 'Agents', sum)) out.push(sumRow(ctx, $, sum, 'slim-agents-sum'))
  const textAt = left + 6
  const room = right - textAt + 1
  const ground = ctx.ground ?? 'night'
  all.slice(0, max).forEach((a, i) => {
    const need = asking.get(a.id)
    const step = ctx.t.steps.filter(s => s.agent === a.id && s.status === 'running').sort((x, y) => y.seq - x.seq)[0]
    const crit = need !== undefined ? askerCritter(ctx, need, 'micro') : critterOf(a, { size: 'micro', ground, motion: ctx.motion === true })
    if (i > 0) out.push(blank(ctx, $, `slim-agent-gap-${i}`))
    out.push(
      <Box key={`slim-agent-${a.id}`} flexDirection="row">
        <Text>{' '.repeat(left)}</Text>
        <Box key={`slim-agent-${a.id}-who`} width={textAt - left} flexShrink={0}>
          {inst(ctx, $, { key: `slim-crit-${a.id}`, ...crit })}
        </Box>
        <Box key={`slim-agent-${a.id}-text`} flexDirection="column" width={room} flexShrink={0}>
          <Text key={`slim-agent-${a.id}-name`} bold wrap="truncate-end">
            {wordFit(typeName(a.type), room)}
          </Text>
          {need !== undefined ? (
            <Text key={`slim-agent-${a.id}-doing`} color={CK.ask} wrap="truncate-end">
              {wordFit('Waiting for you', room)}
            </Text>
          ) : (
            <Text key={`slim-agent-${a.id}-doing`} dimColor wrap="truncate-end">
              {doing(step, st.view, room)}
            </Text>
          )}
        </Box>
      </Box>,
    )
  })
  if (all.length > max) out.push(<Text key="slim-agents-more" dimColor>{`${' '.repeat(textAt)}+ ${all.length - max} more`}</Text>)
  return out
}

/** Budget in slim: the title, then the context and the hotter window, each as its word, its figure at 10 and a 9-cell bar at 16. */
function budgetBlock(ctx: ViewCtx, $: EngineInterface): Block {
  const { Text } = $.ui.resolve(ctx.e)
  const gauges = slimGauges(ctx.t)
  if (gauges.length === 0) return []
  const { left, right } = edges(ctx.cols)
  const cells = right - BAR + 1
  const out: Block = [title(ctx, $, 'Budget', [], 'slim-go-budget', () => setBudgetOpen($, true))]
  gauges.forEach(g => {
    const fig = `${Math.round(g.pct)}%`
    const lead = `${g.label.padEnd(9)}`
    out.push(
      <Text key={`slim-budget-${g.label}`} wrap="truncate-end">
        {' '.repeat(left)}
        <Text dimColor>{lead}</Text>
        {runText({ text: fig, ...(g.pct >= 70 ? gaugeStyle(g.pct) : {}) }, ctx.e, $, `slim-budget-${g.label}-pct`)}
        {cells >= 4 ? ' '.repeat(Math.max(1, BAR - left - lead.length - fig.length)) : ''}
        {cells >= 4 ? pctBar(cells, g.pct, g.pct >= 90 ? CK.fail : CK.accent).map((r, i) => runText(r, ctx.e, $, `slim-budget-${g.label}-${i}`)) : null}
      </Text>,
    )
  })
  return out
}

/** Notes in slim: the title with the count before `›`, then the newest kept step or note wrapped to two lines. */
function notesBlock(ctx: ViewCtx, $: EngineInterface): Block {
  const { Text } = $.ui.resolve(ctx.e)
  const items = noteItems(ctx.t)
  if (items.length === 0) return []
  const { left, right } = edges(ctx.cols)
  const first = items[0]!
  const lines = wrapWords(oneLine(first.text), right - (left + 2) + 1, 2)
  const count = String(items.length)
  return [
    title(ctx, $, 'Notes', [{ text: `${' '.repeat(Math.max(0, right - 3 - SUM - count.length + 1))}${count}`, dim: true }], 'slim-go-notes', () => openTab($, 'artifacts')),
    ...lines.map((l, i) => (
      <Text key={`slim-note-${i}`} wrap="truncate-end">
        {' '.repeat(left)}
        {i === 0 ? <Text color={first.star ? CK.accent : CK.rule}>{first.star ? '★' : '·'}</Text> : ' '}
        {` ${l}`}
      </Text>
    )),
  ]
}

/** The PR in slim (R46): one row, `#123 ✓ stack 2/4`, a plain Button opening the current PR. */
function prSlim(ctx: ViewCtx, $: EngineInterface): Block {
  const runs = prChip(ctx.pr)
  if (runs.length === 0) return []
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { left } = edges(ctx.cols)
  const url = ctx.pr?.current?.url
  const body = runs.map((r, i) => runText(r, ctx.e, $, `slim-pr-${i}`))
  return [
    <Box key="slim-pr-row" flexDirection="row">
      <Text>{' '.repeat(left)}</Text>
      {url !== undefined && url !== '' ? (
        <Button key="slim-pr" plain onPress={() => openLink($, url, ctx.e.surface)}>
          {body}
        </Button>
      ) : (
        <Text key="slim-pr" wrap="truncate-end">{body}</Text>
      )}
    </Box>,
  ]
}

/** The stack at a drop level: 0 all; 1 without Notes; 2 also without Budget; 3 also without Watch; 4 one agent; 5 no agents; 6 To do without its tasks. */
function stackAt(ctx: ViewCtx, $: EngineInterface, st: NowState, level: number): Block {
  const blocks: Block[] = [
    [nowHeader(ctx, $, st.view, st.hs, st.todo, { short: true, svg: false })],
    needsBlock(ctx, $, st),
    level < 4 ? prSlim(ctx, $) : [],
    level < 3 ? watchSlim(ctx, $, st) : [],
    todoBlock(ctx, $, st, level < 6),
    level < 5 ? agentsBlock(ctx, $, st, level < 4 ? 2 : 1) : [],
    level < 2 ? budgetBlock(ctx, $) : [],
    level < 1 ? notesBlock(ctx, $) : [],
  ]
  const out: Block = []
  blocks.forEach((b, i) => {
    if (b.length === 0) return
    if (out.length > 0) out.push(blank(ctx, $, `slim-gap-${i}`))
    out.push(...b)
  })
  return out
}

const rowsOf = (els: Block): number => els.reduce((n, el) => n + heightOf(el), 0)

/** `↵ open   esc prompt` (R28: the keys in the accent), only while the pane has the keys. */
function slimFooter(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  return footerRow(ctx, $, [
    { key: '↵', label: 'open' },
    { key: 'esc', label: 'prompt' },
  ])
}

const TAB_TITLE: Record<Tab, string> = { overview: 'Now', tasks: 'Tasks', agents: 'Agents', timeline: 'Steps', artifacts: 'Artifacts' }

/** The name-only list of a tab, in slim form: `b: back` on its first row, the tab's title, its rows. */
function tabList(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(ctx.e)
  const { t, u } = ctx
  const { left } = edges(ctx.cols)
  const st = nowState(ctx)
  type Item = { key: string; glyph: string; color?: string; text: string; dim?: boolean }
  const items: Item[] = []
  if (u.tab === 'tasks') {
    const rank = { in_progress: 0, pending: 1, completed: 2 }
    for (const x of [...t.tasks].sort((a, b) => rank[a.status] - rank[b.status])) {
      const glyph = x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▸' : '○'
      items.push({ key: `task-${x.id}`, glyph, ...(x.status === 'in_progress' ? { color: C.live } : {}), text: x.subject, dim: x.status === 'completed' })
    }
  } else if (u.tab === 'agents') {
    const rank = { running: 0, error: 1, done: 2 }
    for (const a of Object.values(t.agents).filter(x => x.id !== 'main').sort((x, y) => rank[x.status] - rank[y.status] || y.startedAt - x.startedAt)) {
      const color = statusColor(a.status)
      // R3-B I6: the agent's name and its state (the glyph, and the word for the ones that need you or failed), then its job.
      const asking = st.view.items.some(n => n.agent === a.id)
      const word = asking ? ' (waiting)' : a.status === 'error' ? ' (failed)' : ''
      items.push({ key: `agent-${a.id}`, glyph: asking ? '?' : a.status === 'running' ? '▸' : a.status === 'error' ? '✖' : '✓', ...(asking ? { color: CK.ask } : color !== undefined ? { color } : {}), text: `${typeName(a.type)}${word} ${a.description}`.trim() })
    }
  } else if (u.tab === 'timeline') {
    for (const s of [...t.steps].sort((a, b) => b.seq - a.seq)) {
      const color = statusColor(s.status)
      items.push({ key: `step-${s.id}`, glyph: STEP_GLYPH[s.status], ...(color !== undefined ? { color } : {}), text: argOf(s.tool, s.label) || s.tool })
    }
  } else {
    for (const a of [...t.artifacts].sort((x, y) => y.updatedAt - x.updatedAt)) {
      items.push({ key: `artifact-${a.id}`, glyph: a.kind === 'link' ? '⎇' : '↗', text: a.title })
    }
  }
  // R3-B I6 (R37): the list grows with the pane's rows; an item whose first word is wider than the pane is cut at a part (or a lone `…`), never left out of the list or the count.
  const room = Math.max(1, ctx.cols - 5)
  const usable = items
  const bar = slimFooter(ctx, $)
  const free = (ctx.bodyRows ?? 46) - 2 - (bar !== null ? 2 : 0)
  const { shown: take } = listSplit(usable.length, Math.max(1, free))
  const shown = usable.slice(0, take)
  const els: RenderElement[] = [
    <Box key="slim-back-row" flexDirection="row" paddingLeft={left} columnGap={3}>
      <Button key="slim-back" hotkey="b" plain onPress={() => openTab($, 'overview')}>
        back
      </Button>
    </Box>,
    <Text key="slim-tab-title" bold>
      {`${' '.repeat(left)}${TAB_TITLE[u.tab]}`}
    </Text>,
    ...shown.map(i => row(ctx, $, { key: i.key, glyph: i.glyph, ...(i.color !== undefined ? { glyphColor: i.color } : {}), name: nameFit(oneLine(i.text), room), ...(i.dim === true ? { dim: true } : {}) })),
  ]
  if (usable.length > shown.length) els.push(more(ctx, $, usable.length - shown.length))
  if (shown.length === 0) els.push(<Text key="slim-empty" dimColor>{`${' '.repeat(left + 1)}Nothing yet.`}</Text>)
  return <Box flexDirection="column">{[...els, ...(bar !== null ? [blank(ctx, $, 'slim-tab-gap'), bar] : [])]}</Box>
}

/**
 * The pane under 32 columns (cockpit spec "CockpitSlim"): the shell calls it
 * whenever `ctx.cols < 32`, whatever the tab. On Now it is the stack above,
 * with the footer on the last row; when the stack is taller than
 * `bodyRows`, whole parts go from the bottom (Notes, Budget, Watch, one agent, the
 * agents, To do's tasks), so Needs you and To do stay longest (R34).
 */
export function slimView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  if (isBudgetOpen()) return <Box flexDirection="column">{[budgetView(ctx, $)]}</Box>
  if (ctx.u.tab !== 'overview') return tabList(ctx, $)
  const st = nowState(ctx)
  const bar = slimFooter(ctx, $)
  const spare = bar !== null ? 2 : 0
  const rows = ctx.bodyRows ?? 46
  // While a dialog is up, Notes give their rows to it (the slim ask board draws none).
  let level = st.view.items.length > 0 ? 1 : 0
  let built = stackAt(ctx, $, st, level)
  while (rowsOf(built) + spare > rows && level < 6) {
    level += 1
    built = stackAt(ctx, $, st, level)
  }
  const out = [...built]
  if (bar !== null) {
    const pad = Math.max(1, rows - 1 - rowsOf(built))
    for (let i = 0; i < pad; i++) out.push(blank(ctx, $, `slim-pad-${i}`))
    out.push(bar)
  }
  return <Box flexDirection="column">{out}</Box>
}
