import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { roles, usualMs } from '../model/meter'
import { agentGroups, runBoard } from '../model/select'
import { debug, errText, updateUi } from '../state'
import {
  EMPTY,
  RUN_GLYPH,
  STATE_WORD,
  STEP_GLYPH,
  agentFiles,
  agentRow,
  agentActions,
  answerOf,
  jumpToProblem,
  timeCell,
  tokensOf,
} from './agentmeta'
import type { AgentFile, Jump } from './agentmeta'
import { modelName, modelTotals, tokenText } from './budget'
import { crewNode, openedAgent } from './crewnode'
import { bar, clock, crewRow, elapsed, fit, wrapWords } from './fit'
import { openInEditor } from './editor'
import { blank, footer, more, page, richDeck, row, section } from './parts'
import type { Action, DeckCell, FrameSpec, InstSpec, PageField, Run } from './parts'
import { openPage } from './pagenav'
import { Grid, SPRITE, drawSprite, stack } from './raster'
import type { Ink, State } from './raster'
import { runBoardView } from './runboard'
import type { ViewCtx } from './shell'
import { needsYou, waitStates } from './needs'
import { C, DECK, GRID, HULL, cellCol, podOf, roleOf, spriteOf, statusColor } from './style'
import type { Pod, PodState, Role } from './style'
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
 * A model's cell text, `opus 993k`, in `room` columns. The name is whole or
 * absent: when the name and the tokens do not both fit, the tokens stand
 * alone (the MODELS table names the model).
 */
function modelRuns(model: string, tokens: string, room = 10): Run[] {
  const named = model !== '' && model.length + 1 + tokens.length <= room
  return [...(named ? [{ text: `${model} `, dim: true }] : []), { text: tokens, bold: true }]
}

/**
 * A frame the lintel can draw at `cols`: the pill hangs from column 13, and the
 * readout needs the columns between the pill and its own right edge, else it
 * is left out (and the pill with it when even that does not fit). The lintel
 * draws what it is given, so a collision must never reach it.
 */
function frameFor(cols: number, pill: string | undefined, right: string): FrameSpec {
  const pillEnd = pill !== undefined ? 13 + [...pill].length + 2 : 3
  const withPill = pill !== undefined && cols >= pillEnd + 3
  const edge = withPill ? pillEnd : 3
  const withRight = right !== '' && cols >= edge + 4 + [...right].length
  return { ...(withPill ? { pill } : {}), ...(withRight ? { right } : {}) }
}

/** One character's slot in the line-up: its large sprite (9 wide), tokens in words under it. */
const SLOT = SPRITE.L.columns
const LINEUP_MAX = 5

/**
 * The CREW line-up as one instrument: up to five large characters (the lead,
 * then live, failed, done), each with its tokens on the row under it. The
 * slots stay fixed so a change in the crew redraws and never resizes.
 */
function lineupInst(order: AgentRow[], pods: Pod[], slots: number): InstSpec {
  const shown = order.slice(0, slots).map((a, i) => {
    const pod = pods[i]!
    const n = tokensOf(a)
    return { role: pod.role, state: pod.state as State, word: n !== undefined ? tokenText(n) : '' }
  })
  const columns = slots * SLOT
  const draw = (lamp: 'on' | 'dim'): Grid => {
    const g = new Grid(columns, SPRITE.L.rows + 1)
    shown.forEach((s, i) => {
      drawSprite(g, i * SLOT, 0, s.role, s.state, 'L', lamp)
      const ink: Ink = s.state === 'failed' ? 'red' : s.state === 'waiting' || s.state === 'stalled' ? 'amber' : 'mute'
      if (s.word !== '') g.word(i * SLOT, SPRITE.L.rows, s.word.slice(0, SLOT - 1), ink)
    })
    return g
  }
  return {
    key: 'crew-lineup',
    columns,
    rows: SPRITE.L.rows + 1,
    sig: `lineup:${slots}:${shown.map(s => `${s.role}.${s.state}.${s.word}`).join(',')}`,
    frames: () => (shown.some(s => s.state === 'working') ? [draw('on'), draw('dim')] : [draw('on')]),
    fallback: [crewRow(pods.slice(0, slots)), [], [], [], []],
  }
}

/** The MODELS share as one 22-cell stack: the heaviest three models in the iris, orchid and ember hues. */
function modelsInst(models: { model: string; tokens: number }[]): InstSpec {
  const hues: Ink[] = ['orchid', 'iris', 'ember']
  const parts = models.slice(0, 3).map((m, i) => [m.tokens, hues[i]!] as const)
  return {
    key: 'models-share',
    columns: 22,
    rows: 1,
    sig: `models:${models.slice(0, 3).map(m => m.tokens).join(',')}`,
    frames: () => [stack(22, parts)],
    fallback: [bar(models[0]?.tokens ?? 0, models.reduce((n, m) => n + m.tokens, 0), 10, C.model)],
  }
}

/** Agents by role: the lead, then each type's count (roles(t)) added to the role its type plays. */
function roleCounts(ctx: ViewCtx): Record<Role, number> {
  const out: Record<Role, number> = { lead: ctx.t.agents.main !== undefined ? 1 : 0, scout: 0, build: 0, check: 0 }
  for (const r of roles(ctx.t)) out[roleOf(r.type)] += r.count
  return out
}

/**
 * The Agents deck (spec "Agents, list"): CREW (in the rich look a line-up of
 * large characters and `+n`, with `n live` under the label; in the text look
 * every agent as a hull: the lead, then live, failed, done), ROLES (hull, role
 * and count for the four roles, counted from `roles(t)`) and MODELS (the two
 * heaviest, each a value; a share bar or stack beside them).
 */
function agentsDeck(ctx: ViewCtx, $: EngineInterface, states: Map<string, PodState>): RenderElement | null {
  const all = Object.values(ctx.t.agents)
  const subs = all.filter(a => a.id !== 'main').sort(byRank)
  const main = ctx.t.agents.main
  const order = [...(main ? [main] : []), ...subs]
  const pods = order.map(a => {
    const state = states.get(a.id)
    return podOf(state !== undefined ? { ...a, state } : a, ctx.now)
  })
  const live = subs.filter(a => a.status === 'running').length
  const failed = subs.filter(a => a.status === 'error').length
  const rich = ctx.look === 'rich'
  const slots = Math.min(LINEUP_MAX, Math.floor((ctx.cols - DECK.gauge) / SLOT))
  const lineup = rich && slots >= 1 && order.length > 0 ? lineupInst(order, pods, slots) : undefined
  const crew: DeckCell[] = [{ col: DECK.gauge, runs: crewRow(pods), narrow: crewRow(pods, 5), whole: true }]
  // The line-up carries the live and failed counts in the label and the lintel; the hull row has them beside it.
  if (lineup === undefined) crew.push({ col: DECK.value, runs: [{ text: String(live), bold: live > 0, dim: live === 0 }, { text: ' live', dim: true }] })
  if (lineup === undefined && failed > 0) crew.push({ col: DECK.aside, runs: [{ text: String(failed), bold: true, color: C.fail }, { text: ' failed', dim: true }] })
  if (lineup !== undefined && order.length > slots) {
    crew.push({ col: DECK.gauge + lineup.columns + 1, runs: [{ text: `+${order.length - slots}`, dim: true }], whole: true })
  }
  const counts = roleCounts(ctx)
  const rolesCells: DeckCell[] = ROLES.map((role, i) => {
    const n = counts[role]
    return {
      col: cellCol(1 + i),
      runs: [{ text: `${HULL[role][0]} `, dim: true }, { text: `${role} `, dim: true }, { text: String(n), bold: n > 0, dim: n === 0 }],
      whole: true,
    }
  })
  const total = all.reduce((n, a) => n + (tokensOf(a) ?? 0), 0)
  const totals = modelTotals(ctx.t)
  const models: DeckCell[] = rich
    ? totals.slice(0, 2).map((m, i) => ({ col: cellCol(3 + i), runs: modelRuns(m.model, tokenText(m.tokens), 11), whole: true }))
    : totals.slice(0, 2).flatMap((m, i) => [
        { col: cellCol(1 + 2 * i), runs: modelRuns(m.model, tokenText(m.tokens)), whole: true },
        { col: cellCol(2 + 2 * i), runs: bar(m.tokens, total, 10, C.model), whole: true },
      ])
  const right = `${subs.length + (main ? 1 : 0)} agents${failed > 0 ? ` · ${failed} failed` : ''}`
  return richDeck(
    ctx,
    $,
    [
      {
        label: 'CREW',
        cells: crew,
        ...(lineup !== undefined ? { inst: lineup, sub: [{ text: `${live} live`, dim: true }] } : {}),
      },
      { label: 'ROLES', cells: rolesCells },
      ...(models.length > 0
        ? [{ label: 'MODELS', cells: models, ...(rich ? { inst: modelsInst(totals) } : {}) }]
        : []),
    ],
    { key: 'agents-deck', frame: frameFor(ctx.cols, live > 0 ? 'WORKING' : undefined, right) },
  )
}

/**
 * `l: List  t: Map  r: Running` on the first three cells; the open ones bold,
 * the rest dim. Under 38 columns three cells do not fit, so it is `l: List  t: Map  r: Run`
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
      {item('mode-tree', 't', 'Map', u.agentsMode === 'tree', () => void updateUi($, cur => ({ ...cur, agentsMode: 'tree' })))}
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
    const opts = {
      key,
      ...(states.has(a.id) ? { state: states.get(a.id)! } : {}),
      ...(problem ? { flag: 'problem' as const } : {}),
    }
    // The rich look gives every row its small character (two lines); the text look keeps the hull glyph.
    const line = ctx.look === 'rich' ? crewNode(ctx, $, a, { ...opts, columns: true }) : agentRow(ctx, $, a, opts)
    const detail = openedAgent(ctx, $, a)
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


/** The state pill's word, its text-look colour and its Raster hue; waiting and stalled turn the frame amber. */
const PILL: Record<PodState, { color: string; hue: 'iris' | 'amber' | 'red' | 'mint' | 'orchid' }> = {
  queued: { color: C.subtle, hue: 'orchid' },
  working: { color: C.live, hue: 'iris' },
  waiting: { color: C.wait, hue: 'amber' },
  stalled: { color: C.wait, hue: 'amber' },
  failed: { color: C.fail, hue: 'red' },
  done: { color: C.result, hue: 'mint' },
}

const STEP_STATUS: Record<string, string> = { running: 'running', done: 'ok', error: 'failed', denied: 'denied', interrupted: 'stopped' }

/** The most files the page lists; the rest are counted under them. */
const FILES_MAX = 40
const STEPS_MAX = 60

/**
 * The agent page (`ui.page = { kind: 'agent', id: <AgentKey> }`; spec
 * "Detail pages"): its large character, full description (wrapped, never
 * cut), what it is doing; AGENT (type, role, model), TOKENS in and out,
 * TIME and start, STATE, TASK (a press opens the task's page); every file
 * its steps read or edited, each a line that `o: open`s it in the editor
 * (images too); STEPS as a list; its full result or answer. Actions: `v`
 * transcript, `g` chat, `s` steps, `o` open the newest file, `b` back.
 */
export function agentPage(ctx: ViewCtx, $: EngineInterface, id: string): RenderElement {
  const { t, now } = ctx
  const a = t.agents[id]
  if (a === undefined) return page(ctx, $, { key: 'agent-page', title: 'This agent is gone.' })
  const isMain = id === 'main'
  const waits = waitStates(t, ctx.u, now)
  const state = waits.get(id)
  const pod = podOf(state !== undefined ? { ...a, state } : a, now)
  const pill = PILL[pod.state]
  const role = isMain ? 'lead' : roleOf(a.type)
  const model = a.model !== undefined && a.model !== '' ? modelName(a.model) : undefined
  const order = Object.values(t.agents).sort((x, y) => (x.id === 'main' ? -1 : y.id === 'main' ? 1 : x.startedAt - y.startedAt))
  const index = order.findIndex(x => x.id === id) + 1

  const kind = isMain ? 'main' : a.type
  const kindLine = [kind, ...(role !== kind ? [role] : []), ...(model !== undefined ? [model] : [])].join(' · ')
  const fields: PageField[] = [{ key: 'agent-page-type', label: 'AGENT', value: kindLine }]

  const tokensIn = a.tokensIn
  const tokensOut = a.tokensOut
  const tokens: Run[] =
    tokensIn === undefined && tokensOut === undefined
      ? [{ text: a.status === 'running' ? 'not reported yet' : 'not reported', dim: true }]
      : [
          { text: tokenText(tokensIn ?? 0), bold: true },
          { text: ' in · ', dim: true },
          { text: tokenText(tokensOut ?? 0), bold: true },
          { text: ' out', dim: true },
        ]
  fields.push({ key: 'agent-page-tokens', label: 'TOKENS', value: tokens })

  const took = timeCell(ctx, a)
  const usual = isMain ? undefined : usualMs(t, a.type)
  const timeValue: Run[] = [
    { text: took === '' ? '–' : took, bold: took !== '' },
    ...(usual !== undefined ? [{ text: ` · usual ${elapsed(0, usual)}`, dim: true }] : []),
  ]
  const timeCells: DeckCell[] = isMain
    ? []
    : [
        { col: DECK.value, runs: [{ text: 'started', dim: true }] },
        { col: DECK.aside, runs: clock(a.startedAt, true) },
      ]
  fields.push({ key: 'agent-page-time', label: 'TIME', value: timeValue, cells: timeCells })

  fields.push({
    key: 'agent-page-state',
    label: 'STATE',
    value: [{ text: STATE_WORD[pod.state], bold: true, color: pill.color }],
    cells:
      a.lastStepAt !== undefined
        ? [
            { col: DECK.value, runs: [{ text: 'last step', dim: true }] },
            { col: DECK.aside, runs: `${elapsed(a.lastStepAt, now)} ago` },
          ]
        : [],
  })

  const task = a.taskId !== undefined ? t.tasks.find(x => x.id === a.taskId) : undefined
  if (task !== undefined) {
    const glyph = task.status === 'completed' ? '▪' : task.status === 'in_progress' ? '▸' : '▫'
    fields.push({
      key: 'agent-page-task',
      label: 'TASK',
      value: `${glyph} ${task.id} ${task.subject}`,
      onPress: () => openPage($, 'task', `${task.owner}:${task.id}`),
    })
  }

  // The steps, newest first: each a line that opens its page (the label in full, wrapped), its status beside it.
  const steps = t.steps.filter(s => s.agent === id).sort((x, y) => y.seq - x.seq)
  fields.push({
    key: 'agent-steps-head',
    label: 'STEPS',
    value: [{ text: steps.length === 0 ? 'none yet' : `${steps.length} · newest first`, dim: true }],
  })
  steps.slice(0, STEPS_MAX).forEach(s => {
    fields.push({
      key: `agent-step-${s.id}`,
      label: clock(s.startedAt, true),
      value: `${STEP_GLYPH[s.status]} ${s.label}`,
      cells: [{ col: DECK.aside, runs: [{ text: STEP_STATUS[s.status] ?? s.status, dim: s.status === 'done', color: statusColor(s.status) }] }],
      onPress: () => openPage($, 'step', s.id),
    })
  })
  if (steps.length > STEPS_MAX) {
    fields.push({ key: 'agent-steps-more', label: '', value: [{ text: `+ ${steps.length - STEPS_MAX} earlier steps: s opens them all`, dim: true }] })
  }

  // The files: each a line that opens it (the path in full, wrapped), its kind on the first line.
  const files = agentFiles(t, id)
  const shownFiles: AgentFile[] = files.slice(0, FILES_MAX)
  if (files.length > 0) fields.push({ key: 'agent-files-head', label: 'FILES', value: [{ text: `${files.length}`, dim: true }] })
  shownFiles.forEach((f, i) => {
    const what = f.image ? 'image' : f.read ? 'read' : f.times > 1 ? `edited ${f.times}` : 'edited'
    fields.push({
      key: `agent-file-${i}`,
      label: 'o: open',
      value: f.path,
      cells: [{ col: DECK.aside, runs: [{ text: what, dim: true }] }],
      onPress: () => void openInEditor($, f.path, undefined, ctx.e.surface),
    })
  })
  if (files.length > shownFiles.length) {
    fields.push({ key: 'agent-files-more', label: '', value: [{ text: `+ ${files.length - shownFiles.length} more files`, dim: true }] })
  }

  const result = a.result !== undefined && a.result !== '' ? a.result : answerOf(id)
  const doing = result === undefined && a.status !== 'running' && a.doing !== '' ? a.doing : undefined
  const blocks = [
    ...(result !== undefined
      ? [{ key: 'result', label: a.status === 'running' ? 'RESULT SO FAR' : 'RESULT', text: result }]
      : doing !== undefined
        ? [{ key: 'result', label: 'LAST STEP', text: doing }]
        : []),
  ]

  const common = agentActions($, a)
  const steps0 = common[0]!
  const actions: Action[] = [...common.slice(1), steps0]
  if (files.length > 0) {
    const newest = files[0]!
    actions.push({
      hotkey: 'o',
      label: files.length > 1 ? 'open newest' : 'open',
      key: 'agent-page-open',
      onPress: () => void openInEditor($, newest.path, undefined, ctx.e.surface),
    })
  }

  return page(ctx, $, {
    key: 'agent-page',
    frame: {
      ...frameFor(ctx.cols, STATE_WORD[pod.state].toUpperCase().replace('ASKS PERMISSION', 'WAITING'), `agent ${index} of ${order.length}`),
      pillColor: pill.color,
      pillHue: pill.hue,
      ...(pod.state === 'waiting' || pod.state === 'stalled' ? { tone: 'warning' as const } : {}),
    },
    who: { key: 'agent-page-who', ...spriteOf(a, now, state) },
    title: isMain ? 'main' : a.description !== '' ? a.description : a.type,
    ...(a.status === 'running' && a.doing !== '' ? { body: a.doing } : {}),
    fields,
    blocks,
    actions,
  })
}
