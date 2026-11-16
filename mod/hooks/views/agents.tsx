import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow } from '../../types'
import { usualMs } from '../model/meter'
import { agentGroups, runBoard } from '../model/select'
import { debug, errText, updateUi } from '../state'
import {
  EMPTY,
  STATE_WORD,
  agentFiles,
  agentActions,
  answerOf,
  cellTime,
  jumpToProblem,
  openAgentPage,
  timeCell,
  toggleAllOpen,
  toggleOpen,
  isOpen,
  hasOpen,
} from './agentmeta'
import type { AgentFile, Jump } from './agentmeta'
import { modelName, tokenText } from './budget'
import { agentLine, failedBlock, lineOf, liveCard, stateOf } from './crewnode'
import type { Seg } from './crewnode'
import { clock, ruleBar, span, wordFit, wrapWords } from './fit'
import { openInEditor } from './editor'
import { footerSlot, stepGlyph } from './tabkit'
import type { FootHint } from './overview'
import { blank, frameFootInst, frameTopInst, heightOf, inst, page, section } from './parts'
import type { Action, DeckCell, FrameSpec, PageField, Run } from './parts'
import { openPage } from './pagenav'
import { runBoardView } from './runboard'
import { TAB_ROWS } from './shell'
import type { ViewCtx } from './shell'
import { needsYou, waitStates } from './needs'
import { C, CK, DECK, edges, podOf, statusColor, typeName } from './style'
import type { PodState } from './style'
import { treeView } from './tree'

// The Agents tab (cockpit spec "CockpitAgents", crew spec "Crew map rules",
// rulings R23 to R28 and R31): a header (counts, the model share, tokens),
// `l: List  t: Map  r: Working only`, then the list, as cards for who is
// working, the failures with their reasons, the finished folded to three
// rows, and the runs; or the map. Enter opens the agent's page.

/** Under this many columns the toggle row would run past the pane. */
const NARROW = 38
/** The finished rows listed before `+ n more`. */
export const FINISHED_ROWS = 3
const FINISHED_KEY = 'finished'

/** The deck's frame readout, which `page` (parts.tsx) draws in the pill and at the right. */
const frameFor = (pill: string | undefined, right: string): FrameSpec => ({ ...(pill !== undefined ? { pill } : {}), ...(right !== '' ? { right } : {}) })

/** The right-hand runs flush at `right`, as segments of a row. */
function flushRight(runs: Run[], right: number): Seg[] {
  let col = right + 1 - runs.reduce((n, r) => n + r.text.length, 0)
  return runs.map(r => {
    const seg = { ...r, col }
    col += r.text.length
    return seg
  })
}

/** A run of `━` cells as segments from `col`. */
function barSegs(runs: Run[], col: number): Seg[] {
  const out: Seg[] = []
  let at = col
  for (const r of runs) {
    out.push({ ...r, col: at })
    at += r.text.length
  }
  return out
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** One legend row of the share bar: a `■` in the bar's colour, the model's name and its percent, from column 43. */
function legend(models: { model: string; pct: number }[], i: number): Seg[] {
  const m = models[i]
  return m === undefined ? [] : [{ col: 43, text: '■', color: CK.accent, ...(i === 0 ? {} : { dim: true }) }, { col: 45, text: `${cap(m.model)} ${m.pct}%` }]
}

/** The model shares, whole percents that sum to 100 (heaviest first). */
function shares(totals: { model: string; tokens: number }[]): { model: string; pct: number; tokens: number }[] {
  const sum = totals.reduce((n, m) => n + m.tokens, 0)
  if (sum <= 0) return []
  const out = totals.map(m => ({ model: m.model, tokens: m.tokens, pct: Math.round((m.tokens * 100) / sum) }))
  const off = 100 - out.reduce((n, m) => n + m.pct, 0)
  if (out.length > 0) out[0]!.pct += off
  return out
}

/** The tokens each model carried, over the agents of the list (the lead is not one): heaviest first. */
function modelsOf(subs: AgentRow[]): { model: string; tokens: number }[] {
  const by = new Map<string, number>()
  for (const a of subs) {
    if (a.model === undefined || (a.tokensIn === undefined && a.tokensOut === undefined)) continue
    by.set(modelName(a.model), (by.get(modelName(a.model)) ?? 0) + (a.tokensIn ?? 0) + (a.tokensOut ?? 0))
  }
  return [...by].map(([model, tokens]) => ({ model, tokens })).sort((x, y) => y.tokens - x.tokens || x.model.localeCompare(y.model))
}

const tokensIn = (a: AgentRow): number => (a.tokensIn ?? 0) + (a.tokensOut ?? 0)

/**
 * The header: the lintel, "2 agents working" with the finished and failed
 * counts flush right, a blank, the Models share (a `━` bar and its legend),
 * the Tokens line, the sill. Models and Tokens leave when nothing reported.
 */
function listHeader(ctx: ViewCtx, $: EngineInterface, subs: AgentRow[]): RenderElement[] {
  const { Text } = $.ui.resolve(ctx.e)
  const { left, right } = edges(ctx.cols)
  const ground = ctx.ground ?? 'night'
  const live = subs.filter(a => a.status === 'running').length
  const finished = subs.filter(a => a.status === 'done').length
  const failed = subs.filter(a => a.status === 'error').length
  const count: Run = { text: live === 0 ? 'No agents working' : `${live} ${live === 1 ? 'agent' : 'agents'} working`, bold: true }
  const tail: Run[] = []
  if (finished > 0) tail.push({ text: `${finished} finished`, dim: true })
  if (failed > 0) tail.push(...(tail.length > 0 ? [{ text: ' · ', dim: true }] : []), { text: `${failed} failed`, color: CK.fail })
  const out: RenderElement[] = [inst(ctx, $, frameTopInst('agents-lintel', ctx.cols, 'iris', ground))]
  const first: Seg[] = [{ col: left, ...count }]
  const room = right - left + 1 - count.text.length - 2
  if (tail.length > 0 && tail.reduce((n, r) => n + r.text.length, 0) <= room) first.push(...flushRight(tail, right))
  out.push(lineOf(ctx, $, { key: 'agents-count', body: first }))
  const models = shares(modelsOf(subs))
  const total = subs.reduce((n, a) => n + tokensIn(a), 0)
  const reported = subs.some(a => a.tokensIn !== undefined || a.tokensOut !== undefined)
  let second: Seg[] = []
  if (models.length > 0 || reported) out.push(<Text key="agents-gap1"> </Text>)
  if (models.length > 0) {
    const label: Seg = { col: left, text: 'Models', dim: true }
    second = []
    if (ctx.cols >= 62) {
      const cells = 28
      const parts: { count: number; color: string; dim?: boolean }[] = models.slice(0, 2).map((m, i) => ({ count: m.tokens, color: CK.accent, ...(i === 0 ? {} : { dim: true }) }))
      const rest = models.slice(2).reduce((n, m) => n + m.tokens, 0)
      if (rest > 0) parts.push({ count: rest, color: C.subtle })
      const bar = barSegs(ruleBar(cells, parts, undefined, true), 12)
      out.push(lineOf(ctx, $, { key: 'agents-models', body: [label, ...bar, ...legend(models, 0)] }))
      second = legend(models, 1)
    } else {
      const words = models.slice(0, 3).map(m => `${cap(m.model)} ${m.pct}%`).join(' · ')
      out.push(lineOf(ctx, $, { key: 'agents-models', body: [label, { col: 12, text: wordFit(words, Math.max(1, right - 11)) }] }))
    }
  }
  if (reported) {
    const noun = `across ${subs.length} ${subs.length === 1 ? 'agent' : 'agents'}`
    out.push(lineOf(ctx, $, { key: 'agents-tokens', body: [{ col: left, text: 'Tokens', dim: true }, { col: 12, text: tokenText(total) }, { col: 12 + tokenText(total).length + 1, text: noun, dim: true }, ...second] }))
  }
  out.push(inst(ctx, $, frameFootInst('agents-sill', ctx.cols, 'iris', ground)))
  return out
}

/**
 * `l: List  t: Map  r: Working only` from column 2: the open one bold with a
 * space either side, the rest dim, three columns apart. Under 38 columns the
 * last is `r: Run`.
 */
function toggles(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { u } = ctx
  const tight = ctx.cols < NARROW
  const item = (key: string, hotkey: string, label: string, on: boolean, press: () => void): RenderElement => (
    <Box key={`cell-${key}`} flexDirection="row" width={hotkey.length + 2 + label.length + (on ? 2 : 0)}>
      <Text key={`${key}-pad`}>{on ? ' ' : ''}</Text>
      <Button key={key} hotkey={hotkey} plain dimColor={!on} onPress={press}>
        {on ? <Text bold>{label}</Text> : label}
      </Button>
    </Box>
  )
  return (
    <Box key="toggles" flexDirection="row" paddingLeft={edges(ctx.cols).left} columnGap={3}>
      {item('mode-list', 'l', 'List', u.agentsMode === 'list', () => void updateUi($, cur => ({ ...cur, agentsMode: 'list' })))}
      {item('mode-tree', 't', 'Map', u.agentsMode === 'tree', () => void updateUi($, cur => ({ ...cur, agentsMode: 'tree' })))}
      {item('mode-running', 'r', tight ? 'Run' : 'Working only', u.runningOnly, () => void updateUi($, cur => ({ ...cur, runningOnly: !cur.runningOnly })))}
    </Box>
  )
}

/** The empty state, wrapped by word at the content margin. */
function emptyNote(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { left } = edges(ctx.cols)
  return (
    <Box key="empty" flexDirection="column">
      {wrapWords(EMPTY, Math.max(1, ctx.cols - left), 4).map((l, i) => (
        <Text key={`empty-${i}`} dimColor wrap="truncate-end">{`${' '.repeat(left)}${l}`}</Text>
      ))}
    </Box>
  )
}

/** A block of the list and whether it ends on an empty row of its own (a card's third row), so no blank follows it. */
type Block = { els: RenderElement[]; gap: boolean }

/** The runs section: one row a workflow run, `▸ review workflow  3 of 5 agents done` and its time; a press opens its board. */
function runsBlock(ctx: ViewCtx, $: EngineInterface, runs: { run: { runId: string; name: string }; agents: AgentRow[] }[], ids: Set<string>, targets: Jump[]): Block {
  const { left, right } = edges(ctx.cols)
  const els: RenderElement[] = [section(ctx, $, 'Runs', String(runs.length), { key: 'sec-runs' })]
  for (const g of runs) {
    const id = g.run.runId
    const key = `run-open-${id}`
    if (g.agents.some(a => ids.has(a.id))) targets.push({ key, open: `run:${id}` })
    const board = runBoard(ctx.t, id, ctx.now)
    const failed = g.agents.filter(a => a.status === 'error').length
    const done = g.agents.filter(a => a.status === 'done').length
    const time = board !== undefined ? cellTime(board.elapsed) : ''
    const detail = `${done} of ${g.agents.length} agents done${failed > 0 ? ` · ${failed} failed` : ''}`
    const timeCol = right - time.length + 1
    const room = Math.max(1, timeCol - 2 - (left + 2))
    const nameText = wordFit(g.run.name, room)
    const detailRoom = room - nameText.length - 2
    const body: Seg[] = [
      { col: left, text: '▸', color: CK.accent },
      { col: left + 2, text: nameText },
      ...(detailRoom >= 6 ? [{ col: left + 2 + nameText.length + 2, text: wordFit(detail, detailRoom), dim: true }] : []),
      ...(time !== '' ? [{ col: timeCol, text: time, dim: true }] : []),
    ]
    els.push(lineOf(ctx, $, { key, body, onPress: () => updateUi($, cur => ({ ...cur, run: id })) }))
  }
  return { els, gap: false }
}

/**
 * The list body: Working (a card each), Failed (a micro critter, the reason,
 * `v g s` on the first), Finished (three rows and `+ n more`), Runs.
 * `targets` are the rows `n`/`p` visit.
 */
function listBody(ctx: ViewCtx, $: EngineInterface, ids: Set<string>, states: Map<string, PodState>, since: Map<string, number>): { el: RenderElement; targets: Jump[]; failed: number } {
  const { Box } = $.ui.resolve(ctx.e)
  const { t, u } = ctx
  const { left } = edges(ctx.cols)
  const groups = agentGroups(t)
  const subs = (groups.find(g => g.run === undefined)?.agents ?? []).slice()
  const runs = groups
    .flatMap(g => (g.run !== undefined ? [{ run: g.run, agents: g.agents }] : []))
    .filter(g => !u.runningOnly || g.agents.some(a => a.status === 'running'))
  const targets: Jump[] = []
  const blocks: Block[] = []
  const working = subs.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const failed = u.runningOnly ? [] : subs.filter(a => a.status === 'error').sort((a, b) => b.startedAt - a.startedAt)
  const done = u.runningOnly ? [] : subs.filter(a => a.status === 'done').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  if (working.length > 0) {
    const els: RenderElement[] = [section(ctx, $, 'Working', String(working.length), { key: 'sec-working' })]
    for (const a of working) {
      const key = `agent-${a.id}`
      if (ids.has(a.id)) targets.push({ key, open: a.id })
      els.push(liveCard(ctx, $, a, { key, state: stateOf(a, states), ...(since.has(a.id) ? { since: since.get(a.id)! } : {}), onPress: () => openAgentPage($, a.id, key) }))
    }
    blocks.push({ els, gap: true })
  }
  if (failed.length > 0) {
    const els: RenderElement[] = [section(ctx, $, 'Failed', [{ text: String(failed.length), color: CK.fail }], { tone: 'fail', key: 'sec-failed' })]
    failed.forEach((a, i) => {
      const key = `agent-${a.id}`
      if (ids.has(a.id)) targets.push({ key, open: a.id })
      els.push(failedBlock(ctx, $, a, { key, keys: i === 0 }))
    })
    blocks.push({ els, gap: false })
  }
  if (done.length > 0) {
    const els: RenderElement[] = [section(ctx, $, 'Finished', String(done.length), { key: 'sec-finished' })]
    const all = isOpen(u.folded, FINISHED_KEY)
    const shown = all ? done : done.slice(0, FINISHED_ROWS)
    for (const a of shown) {
      const key = `agent-${a.id}`
      els.push(agentLine(ctx, $, a, { key, state: 'done', onPress: () => openAgentPage($, a.id, key) }))
    }
    if (done.length > FINISHED_ROWS) {
      els.push(
        lineOf(ctx, $, {
          key: 'finished-more',
          body: [{ col: left + 2, text: all ? 'fewer' : `+ ${done.length - FINISHED_ROWS} more`, dim: true }],
          onPress: () => updateUi($, cur => toggleOpen(cur, FINISHED_KEY)),
        }),
      )
    }
    blocks.push({ els, gap: false })
  }
  if (runs.length > 0) blocks.push(runsBlock(ctx, $, runs, ids, targets))
  const out: RenderElement[] = []
  blocks.forEach((b, i) => {
    if (i > 0 && !blocks[i - 1]!.gap) out.push(blank(ctx, $, `gap-block-${i}`))
    out.push(...b.els)
  })
  return { el: <Box key="list" flexDirection="column">{out}</Box>, targets, failed: failed.length }
}

/**
 * The Agents tab: the header and toggle row, then the list or the map, or a
 * run's board; the footer on the last row while the pane holds the keys.
 * `n`/`p` visit the rows with a problem.
 */
export function agentsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  try {
    if (u.run !== undefined) return runBoardView(ctx, u.run, $)
    const problems = needsYou(t, u, now)
    const ids = new Set(problems.map(p => p.agent))
    const since = new Map(problems.filter(p => p.kind === 'asking').map(p => [p.agent, p.since] as const))
    const states = waitStates(ctx.t, ctx.u, ctx.now)
    const subs = Object.values(t.agents).filter(a => a.id !== 'main' && (a.runId === undefined || t.runs[a.runId] === undefined))
    const hasRuns = Object.keys(t.runs).length > 0
    const modes = toggles(ctx, $)
    const out: RenderElement[] = []
    let targets: Jump[] = []
    let hints: FootHint[] = [{ key: '↵', label: 'open' }, { key: 'esc', label: 'prompt' }]
    const jump = (dir: 1 | -1) => () => void jumpToProblem($, targets, dir)
    // `n` is drawn only on the map ("next flag"); `p` is armed without a hint, and on the list both are (the mock's list footer has neither).
    const nextPrev = (shown: boolean): FootHint[] =>
      targets.length > 0
        ? [
            { hotkey: 'n', label: 'next flag', id: 'hint-next', onPress: jump(1), hidden: !shown },
            { hotkey: 'p', label: 'prev', id: 'hint-prev', onPress: jump(-1), hidden: true },
          ]
        : []
    if (u.agentsMode === 'tree') {
      const map = treeView(ctx, $, ids, states)
      targets = map.targets
      out.push(modes, blank(ctx, $, 'gap-toggles'), map.el)
      hints = [
        { key: '↵', label: 'open' },
        ...(map.unfoldable || hasOpen(u.folded) ? [{ hotkey: 'd', label: hasOpen(u.folded) ? 'fold done' : 'unfold done', id: 'hint-unfold', onPress: () => void updateUi($, cur => toggleAllOpen(cur)) }] : []),
        ...(targets.length > 0 ? [...nextPrev(true), { key: 'esc', label: 'prompt' }, { key: 'r', label: 'working only' }] : [{ key: 'r', label: 'working only' }, { key: 'esc', label: 'prompt' }]),
      ]
    } else if (subs.length === 0 && !hasRuns) {
      out.push(modes, blank(ctx, $, 'gap-toggles'), emptyNote(ctx, $))
    } else {
      const list = listBody(ctx, $, ids, states, since)
      targets = list.targets
      // F M6: the toggles sit in the row under the tabs on the list as on the map, so pressing `t` moves nothing but the lists.
      out.push(modes)
      if (subs.length > 0) out.push(...listHeader(ctx, $, subs), blank(ctx, $, 'gap-readout'))
      else out.push(blank(ctx, $, 'gap-toggles'))
      out.push(list.el)
      hints = [{ key: '↵', label: 'open agent' }, ...(list.failed > 0 ? [{ key: 'v', label: 'transcript' }] : []), ...nextPrev(false), { key: 'esc', label: 'prompt' }]
    }
    const foot = footerSlot(ctx, $, hints)
    if (foot !== null) {
      const rows = (ctx.bodyRows ?? 46) - TAB_ROWS
      const used = out.reduce((n, el) => n + heightOf(el), 0)
      const pad = Math.max(1, rows - 1 - used)
      for (let i = 0; i < pad; i++) out.push(blank(ctx, $, `pad-${i}`))
      out.push(foot)
    }
    return <Box flexDirection="column">{out}</Box>
  } catch (err) {
    debug($, `agents view failed: ${errText(err)}`)
    return <Text dimColor>{wordFit(`Agents: ${errText(err)}`, cols)}</Text>
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

/** The page frame's pill word per state (R30: waiting is WAITING, not the permission sentence). */
const PILL_WORD: Record<PodState, string> = { queued: 'QUEUED', working: 'WORKING', waiting: 'WAITING', stalled: 'STALLED', failed: 'FAILED', done: 'DONE' }

const STEP_STATUS: Record<string, string> = { running: 'running', done: 'ok', error: 'failed', denied: 'denied', interrupted: 'stopped' }

/** The most files the page lists; the rest are counted under them. */
const FILES_MAX = 40
const STEPS_MAX = 60

/**
 * The agent page (`ui.page = { kind: 'agent', id: <AgentKey> }`; spec
 * "Detail pages"): its large character, full description (wrapped, never
 * cut), what it is doing; AGENT (type, model), TOKENS in and out,
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
  const model = a.model !== undefined && a.model !== '' ? modelName(a.model) : undefined
  const order = Object.values(t.agents).sort((x, y) => (x.id === 'main' ? -1 : y.id === 'main' ? 1 : x.startedAt - y.startedAt))
  const index = order.findIndex(x => x.id === id) + 1

  const kindLine = [typeName(isMain ? 'main' : a.type), ...(model !== undefined ? [model] : [])].join(' · ')
  const fields: PageField[] = [{ key: 'agent-page-type', label: 'Agent', value: kindLine }]

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
  fields.push({ key: 'agent-page-tokens', label: 'Tokens', value: tokens })

  const took = timeCell(ctx, a)
  const usual = isMain ? undefined : usualMs(t, a.type)
  const timeValue: Run[] = [
    { text: took === '' ? '–' : took, bold: took !== '' },
    ...(usual !== undefined ? [{ text: ` · usual ${cellTime(usual)}`, dim: true }] : []),
  ]
  const timeCells: DeckCell[] = isMain
    ? []
    : [
        { col: DECK.value, runs: [{ text: 'started', dim: true }] },
        { col: DECK.aside, runs: clock(a.startedAt, true) },
      ]
  fields.push({ key: 'agent-page-time', label: 'Time', value: timeValue, cells: timeCells })

  fields.push({
    key: 'agent-page-state',
    label: 'State',
    value: [{ text: STATE_WORD[pod.state], bold: true, color: pill.color }],
    cells:
      a.lastStepAt !== undefined
        ? [
            { col: DECK.value, runs: [{ text: 'last step', dim: true }] },
            { col: DECK.aside, runs: `${span(now - a.lastStepAt)} ago` },
          ]
        : [],
  })

  // Its parent's task: ids repeat across owners.
  const task = a.taskId !== undefined ? t.tasks.find(x => x.owner === a.parent && x.id === a.taskId) : undefined
  if (task !== undefined) {
    const glyph = task.status === 'completed' ? '▪' : task.status === 'in_progress' ? '▸' : '▫'
    fields.push({
      key: 'agent-page-task',
      label: 'Task',
      value: `${glyph} ${task.id} ${task.subject}`,
      onPress: () => openPage($, 'task', `${task.owner}:${task.id}`),
    })
  }

  // The steps, newest first: each a line that opens its page (the label in full, wrapped), its status beside it.
  const steps = t.steps.filter(s => s.agent === id).sort((x, y) => y.seq - x.seq)
  fields.push({
    key: 'agent-steps-head',
    label: 'Steps',
    value: [{ text: steps.length === 0 ? 'none yet' : `${steps.length} · newest first`, dim: true }],
  })
  steps.slice(0, STEPS_MAX).forEach(s => {
    fields.push({
      key: `agent-step-${s.id}`,
      label: clock(s.startedAt, true),
      value: `${stepGlyph(s.status)} ${s.label}`,
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
  if (files.length > 0) fields.push({ key: 'agent-files-head', label: 'Files', value: [{ text: `${files.length}`, dim: true }] })
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
      ? [{ key: 'result', label: a.status === 'running' ? 'Result so far' : 'Result', text: result }]
      : doing !== undefined
        ? [{ key: 'result', label: 'Last step', text: doing }]
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
      ...frameFor(PILL_WORD[pod.state], `agent ${index} of ${order.length}`),
      pillColor: pill.color,
      pillHue: pill.hue,
      ...(pod.state === 'waiting' || pod.state === 'stalled' ? { tone: 'warning' as const } : {}),
    },
    title: isMain ? typeName('main') : a.description !== '' ? a.description : typeName(a.type),
    ...(a.status === 'running' && a.doing !== '' ? { body: a.doing } : {}),
    fields,
    blocks,
    actions,
  })
}
