import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentGroups, problems, runBoard } from '../model/select'
import { debug, errText, updateUi } from '../state'
import { EMPTY, RUN_GLYPH, agentOpened, agentRow, jumpToProblem, tokensOf } from './agentmeta'
import type { Jump } from './agentmeta'
import { modelTotals, tokenText } from './budget'
import { elapsed, fit, wrapWords } from './fit'
import { barCell, blank, footer, more, readout, row, section } from './parts'
import type { ReadoutCell } from './parts'
import { runBoardView } from './runboard'
import type { ViewCtx } from './shell'
import { C, GRID } from './style'
import { treeView } from './tree'

// Under this many columns the toggle row would run past the pane (`r: Running` ends at 36).
const NARROW = 38
const TIGHT_CELL = 9

/** A list shows at most this many rows, then `+ n more`. */
const LIST_MAX = 6

const rank: Record<AgentRow['status'], number> = { running: 0, error: 1, done: 2 }
const byRank = (a: AgentRow, b: AgentRow): number => rank[a.status] - rank[b.status] || a.startedAt - b.startedAt

/** LIVE, DONE, FAILED (bars of all subagents), then the two heaviest models by share of all tokens. */
function headReadout(ctx: ViewCtx, $: EngineInterface): RenderElement | null {
  const subs = Object.values(ctx.t.agents).filter(a => a.id !== 'main')
  const total = subs.length
  const live = subs.filter(a => a.status === 'running').length
  const done = subs.filter(a => a.status === 'done').length
  const failed = subs.filter(a => a.status === 'error').length
  const cells: ReadoutCell[] = [
    { label: 'LIVE', value: String(live), gfx: barCell(live, total) },
    { label: 'DONE', value: String(done), gfx: barCell(done, total, C.subtle) },
    { label: 'FAILED', value: failed > 0 ? [{ text: String(failed), bold: true, color: C.fail }] : String(failed), gfx: barCell(failed, total, C.fail) },
  ]
  const all = Object.values(ctx.t.agents).reduce((n, a) => n + (tokensOf(a) ?? 0), 0)
  modelTotals(ctx.t)
    .slice(0, 2)
    .forEach((m, i) => {
      cells.push({
        label: m.model.toUpperCase(),
        value: tokenText(m.tokens),
        gfx: barCell(m.tokens, all, C.model),
        drop: 2 - i,
      })
    })
  return readout(ctx, $, cells)
}

/**
 * `l: List  t: Tree  r: Running` on the first three cells; the open ones bold,
 * the rest dim. Under 38 columns three cells do not fit, so it is `l: List  t: Tree  r: Run`
 * in cells of 9.
 */
function toggles(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { u } = ctx
  const tight = ctx.cols < NARROW
  const cell = tight ? TIGHT_CELL : GRID.cell
  const item = (key: string, hotkey: string, label: string, on: boolean, press: () => void): RenderElement => (
    <Box key={`cell-${key}`} width={cell}>
      <Button key={key} hotkey={hotkey} plain dimColor={!on} onPress={press}>
        {on ? <Text bold>{label}</Text> : label}
      </Button>
    </Box>
  )
  return (
    <Box key="toggles" flexDirection="row">
      <Text>{' '.repeat(GRID.margin)}</Text>
      {item('mode-list', 'l', 'List', u.agentsMode === 'list', () => void updateUi($, cur => ({ ...cur, agentsMode: 'list' })))}
      {item('mode-tree', 't', 'Tree', u.agentsMode === 'tree', () => void updateUi($, cur => ({ ...cur, agentsMode: 'tree' })))}
      {item('mode-running', 'r', tight ? 'Run' : 'Running', u.runningOnly, () => void updateUi($, cur => ({ ...cur, runningOnly: !cur.runningOnly })))}
    </Box>
  )
}

/** The empty state, wrapped by word at the content margin. */
function emptyNote(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  return (
    <Box key="empty" flexDirection="column">
      {wrapWords(EMPTY, Math.max(1, ctx.cols - GRID.margin), 4).map((l, i) => (
        <Text key={`empty-${i}`} dimColor wrap="truncate-end">{`${' '.repeat(GRID.margin)}${l}`}</Text>
      ))}
    </Box>
  )
}

/** The `┌ AGENTS` section: main, then live, failed and done; the opened row always shows. */
function agentsSection(ctx: ViewCtx, $: EngineInterface, agents: AgentRow[], ids: Set<string>, targets: Jump[]): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const main = ctx.t.agents.main
  const ordered = [...(main ? [main] : []), ...agents]
  let shown = ordered.slice(0, LIST_MAX)
  const open = ctx.u.agentOpen
  const pinned = open !== undefined ? ordered.find(a => a.id === open) : undefined
  if (pinned !== undefined && !shown.includes(pinned)) shown = [...shown.slice(0, LIST_MAX - 1), pinned]
  const hidden = ordered.filter(a => !shown.includes(a))
  const what = hidden.every(a => a.status === 'done') ? 'more done' : 'more'
  const rows = shown.map((a, i) => {
    const key = `agent-${a.id}`
    const problem = ids.has(a.id)
    if (problem) targets.push({ key, open: a.id })
    const line = agentRow(ctx, $, a, { key, ...(problem ? { flag: 'problem' as const } : {}) })
    const detail = agentOpened(ctx, $, a)
    if (detail === null) return line
    const last = i === shown.length - 1 && hidden.length === 0
    return (
      <Box key={`blk-${a.id}`} flexDirection="column">
        {i === 0 ? null : blank(ctx, $, `pre-${a.id}`)}
        {line}
        {detail}
        {last ? null : blank(ctx, $, `post-${a.id}`)}
      </Box>
    )
  })
  return (
    <Box key="agents" flexDirection="column">
      {section(ctx, $, 'AGENTS', 'tokens', 'time')}
      {rows}
      {hidden.length > 0 ? more(ctx, $, hidden.length, what) : null}
    </Box>
  )
}

/** The `┌ RUNS` section: one row per workflow run; a press opens its board. */
function runsSection(
  ctx: ViewCtx,
  $: EngineInterface,
  runs: { run: { runId: string; name: string }; agents: AgentRow[] }[],
  ids: Set<string>,
  targets: Jump[],
): RenderElement {
  const { Box } = $.ui.resolve(ctx.e)
  const shown = runs.slice(0, LIST_MAX)
  const rows = shown.map(g => {
    const id = g.run.runId
    const failed = g.agents.filter(a => a.status === 'error').length
    const problem = g.agents.some(a => ids.has(a.id))
    const key = `run-open-${id}`
    if (problem) targets.push({ key, open: `run:${id}` })
    const board = runBoard(ctx.t, id, ctx.now)
    return row(ctx, $, {
      key,
      glyph: RUN_GLYPH,
      name: g.run.name,
      metric: failed > 0 ? `${g.agents.length} · ✖ ${failed}` : String(g.agents.length),
      time: board !== undefined ? elapsed(0, board.elapsed) : '',
      ...(problem ? { flag: 'problem' as const } : {}),
      onPress: () => updateUi($, cur => ({ ...cur, run: id })),
    })
  })
  return (
    <Box key="runs" flexDirection="column">
      {section(ctx, $, 'RUNS', 'agents', 'time')}
      {rows}
      {runs.length > shown.length ? more(ctx, $, runs.length - shown.length) : null}
    </Box>
  )
}

function listView(ctx: ViewCtx, $: EngineInterface, ids: Set<string>): { el: RenderElement; targets: Jump[] } {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, u } = ctx
  const groups = agentGroups(t)
  const runless = (groups.find(g => g.run === undefined)?.agents ?? []).filter(a => !u.runningOnly || a.status === 'running')
  const runs = groups
    .flatMap(g => (g.run !== undefined ? [{ run: g.run, agents: g.agents }] : []))
    .filter(g => !u.runningOnly || g.agents.some(a => a.status === 'running'))
  const targets: Jump[] = []
  const sections: RenderElement[] = [agentsSection(ctx, $, [...runless].sort(byRank), ids, targets)]
  const nothing = groups.length === 0 && t.steps.length === 0
  if (nothing) sections.push(blank(ctx, $, 'gap-empty'), emptyNote(ctx, $))
  if (runs.length > 0) sections.push(blank(ctx, $, 'gap-runs'), runsSection(ctx, $, runs, ids, targets))
  return { el: <Box key="list" flexDirection="column">{sections}</Box>, targets }
}

/**
 * The Agents tab: the readout (LIVE, DONE, FAILED, two models), the toggle row,
 * then the list or the tree, or a run's board. `n`/`p` visit the rows marked `!`.
 */
export function agentsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  try {
    if (u.run !== undefined) return runBoardView(ctx, u.run, $)
    const ids = new Set(problems(t, now, u.dismissed).map(p => p.agent))
    const body = u.agentsMode === 'tree' ? treeView(ctx, $, ids) : listView(ctx, $, ids)
    const jump = (dir: 1 | -1) => () => void jumpToProblem($, body.targets, dir)
    const foot = footer(ctx, $, [
      { text: '↵ open' },
      ...(body.targets.length > 0
        ? [
            { hotkey: 'n', label: 'next !', key: 'hint-next', onPress: jump(1) },
            { hotkey: 'p', label: 'prev', key: 'hint-prev', onPress: jump(-1) },
          ]
        : []),
    ])
    const head = headReadout(ctx, $)
    return (
      <Box flexDirection="column">
        {head}
        {head !== null ? blank(ctx, $, 'gap-readout') : null}
        {toggles(ctx, $)}
        {blank(ctx, $, 'gap-toggles')}
        {body.el}
        {foot !== null ? blank(ctx, $, 'gap-footer') : null}
        {foot}
      </Box>
    )
  } catch (err) {
    debug($, `agents view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Agents: ${errText(err)}`, cols)}</Text>
  }
}
