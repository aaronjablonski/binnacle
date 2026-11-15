import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { agentGroups, runBoard } from '../model/select'
import { debug, errText, updateUi } from '../state'
import { EMPTY, RUN_GLYPH, agentOpened, agentRow, jumpToProblem, tokensOf } from './agentmeta'
import type { Jump } from './agentmeta'
import { modelTotals, tokenText } from './budget'
import { bar, crewRow, elapsed, fit, wrapWords } from './fit'
import { blank, deck, footer, more, row, section } from './parts'
import type { DeckCell, Run } from './parts'
import { runBoardView } from './runboard'
import type { ViewCtx } from './shell'
import { needsYou, waitStates } from './needs'
import { C, DECK, GRID, HULL, cellCol, podOf, roleOf } from './style'
import type { PodState, Role } from './style'
import { treeView } from './tree'

// Under this many columns the toggle row would run past the pane (`r: Running` ends at 36).
const NARROW = 38
const TIGHT_CELL = 9

/** A list shows at most this many rows, then `+ n more`. */
const LIST_MAX = 6

const ROLES: Role[] = ['lead', 'scout', 'build', 'check']

const rank: Record<AgentRow['status'], number> = { running: 0, error: 1, done: 2 }
const byRank = (a: AgentRow, b: AgentRow): number => rank[a.status] - rank[b.status] || a.startedAt - b.startedAt

/**
 * A model's cell text, `opus 993k`, in 10 columns. The name is whole or
 * absent: when the name and the tokens do not both fit, the tokens stand
 * alone (the MODELS table names the model).
 */
function modelRuns(model: string, tokens: string): Run[] {
  const named = model !== '' && model.length + 1 + tokens.length <= 10
  return [...(named ? [{ text: `${model} `, dim: true }] : []), { text: tokens, bold: true }]
}

/**
 * The Agents deck (spec "Agents, list"): CREW (every agent as a pod: the lead,
 * then live, failed, done; `n live`, `n failed`), ROLES (hull, role and count
 * for the four roles: the legend) and MODELS (the two heaviest, each a value
 * and a 10-cell share bar).
 */
function agentsDeck(ctx: ViewCtx, $: EngineInterface, states: Map<string, PodState>): RenderElement | null {
  const all = Object.values(ctx.t.agents)
  const subs = all.filter(a => a.id !== 'main').sort(byRank)
  const main = ctx.t.agents.main
  const pods = [...(main ? [main] : []), ...subs].map(a => {
    const state = states.get(a.id)
    return podOf(state !== undefined ? { ...a, state } : a, ctx.now)
  })
  const live = subs.filter(a => a.status === 'running').length
  const failed = subs.filter(a => a.status === 'error').length
  const crew: DeckCell[] = [
    { col: DECK.gauge, runs: crewRow(pods), narrow: crewRow(pods, 5), whole: true },
    { col: DECK.value, runs: [{ text: String(live), bold: live > 0, dim: live === 0 }, { text: ' live', dim: true }] },
  ]
  if (failed > 0) crew.push({ col: DECK.aside, runs: [{ text: String(failed), bold: true, color: C.fail }, { text: ' failed', dim: true }] })
  const count = (role: Role): number => all.filter(a => (a.id === 'main' ? 'lead' : roleOf(a.type)) === role).length
  const roles: DeckCell[] = ROLES.map((role, i) => {
    const n = count(role)
    return {
      col: cellCol(1 + i),
      runs: [{ text: `${HULL[role][0]} `, dim: true }, { text: `${role} `, dim: true }, { text: String(n), bold: n > 0, dim: n === 0 }],
      whole: true,
    }
  })
  const total = all.reduce((n, a) => n + (tokensOf(a) ?? 0), 0)
  const models: DeckCell[] = modelTotals(ctx.t)
    .slice(0, 2)
    .flatMap((m, i) => [
      { col: cellCol(1 + 2 * i), runs: modelRuns(m.model, tokenText(m.tokens)), whole: true },
      { col: cellCol(2 + 2 * i), runs: bar(m.tokens, total, 10, C.model), whole: true },
    ])
  return deck(
    ctx,
    $,
    [
      { label: 'CREW', cells: crew },
      { label: 'ROLES', cells: roles },
      ...(models.length > 0 ? [{ label: 'MODELS', cells: models }] : []),
    ],
    { key: 'agents-deck' },
  )
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
function agentsSection(ctx: ViewCtx, $: EngineInterface, agents: AgentRow[], ids: Set<string>, states: Map<string, PodState>, targets: Jump[]): RenderElement {
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
    const line = agentRow(ctx, $, a, {
      key,
      ...(states.has(a.id) ? { state: states.get(a.id)! } : {}),
      ...(problem ? { flag: 'problem' as const } : {}),
    })
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

function listView(ctx: ViewCtx, $: EngineInterface, ids: Set<string>, states: Map<string, PodState>): { el: RenderElement; targets: Jump[] } {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, u } = ctx
  const groups = agentGroups(t)
  const runless = (groups.find(g => g.run === undefined)?.agents ?? []).filter(a => !u.runningOnly || a.status === 'running')
  const runs = groups
    .flatMap(g => (g.run !== undefined ? [{ run: g.run, agents: g.agents }] : []))
    .filter(g => !u.runningOnly || g.agents.some(a => a.status === 'running'))
  const targets: Jump[] = []
  const sections: RenderElement[] = [agentsSection(ctx, $, [...runless].sort(byRank), ids, states, targets)]
  const nothing = groups.length === 0 && t.steps.length === 0
  if (nothing) sections.push(blank(ctx, $, 'gap-empty'), emptyNote(ctx, $))
  if (runs.length > 0) sections.push(blank(ctx, $, 'gap-runs'), runsSection(ctx, $, runs, ids, targets))
  return { el: <Box key="list" flexDirection="column">{sections}</Box>, targets }
}

/**
 * The Agents tab: the deck (CREW, ROLES, MODELS), the toggle row,
 * then the list or the tree, or a run's board. `n`/`p` visit the rows marked `!`.
 */
export function agentsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  try {
    if (u.run !== undefined) return runBoardView(ctx, u.run, $)
    // The `!` marks and the n/p targets follow the rule `waitStates` does: an
    // ask counts from ASK_MS, and a dismissed problem marks nothing.
    const ids = new Set(needsYou(t, u, now).map(p => p.agent))
    const states = waitStates(ctx.t, ctx.u, ctx.now)
    const body = u.agentsMode === 'tree' ? treeView(ctx, $, ids, states) : listView(ctx, $, ids, states)
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
    const head = agentsDeck(ctx, $, states)
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
