import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step, TaskItem, Timeline } from '../../types'
import { median, taskMeter } from '../model/meter'
import type { TaskMeterRow } from '../model/meter'
import { debug, errText, updateUi } from '../state'
import { STEP_GLYPH, signalFlag } from './agentmeta'
import { buckets, clock, elapsed, levels, pips, spark, typeShort, wrapFull, wrapWords } from './fit'
import { exportDigest } from './handoff'
import { podFor, waitStates } from './needs'
import { openPage } from './pagenav'
import { blank, footer, more, opened, page, richDeck, row, section } from './parts'
import type { Action, Detail, Hint, InstSpec, PageBlock, RichRow, Run } from './parts'
import { bars } from './raster'
import type { Ink } from './raster'
import type { ViewCtx } from './shell'
import { C, COL, DECK, GLYPHS, podOf, statusColor } from './style'

const EMPTY = 'No tasks yet. They appear when Claude writes a task list.'
// Rows each section shows before its `+ n more` line.
const ACTIVE_CAP = 1
const QUEUED_CAP = 5
const DONE_CAP = 3
// `d` unfolds the done tasks; a very long list still stops here.
const UNFOLDED_CAP = 20
// Agents tethered under the active task before the more line.
const TETHERED_AGENTS = 4
const OPENED_AGENTS = 3
// The PLAN strip: one column per task (two cells apart while they fit), at most this wide, three rows tall.
const PLAN_MAX = 34
const PLAN_ROWS = 3

/** A task's identity in the pane: its owner and id (ids repeat across agents). */
const keyOf = (x: TaskItem): string => `${x.owner}:${x.id}`

const byNewest = (a: TaskItem, b: TaskItem): number => b.updatedAt - a.updatedAt

/** The agents working on a task: those it was in progress for, or the agent that owns it. */
function agentsOn(t: Timeline, task: TaskItem): AgentRow[] {
  if (task.owner !== 'main') {
    const owner = t.agents[task.owner]
    return owner !== undefined ? [owner] : []
  }
  return Object.values(t.agents)
    .filter(a => a.id !== 'main' && a.taskId === task.id)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** When the session began: the earliest turn, step or task time; `now` when there is none. */
function startOf(t: Timeline, now: number): number {
  const times = [...t.turns.map(x => x.startedAt), ...t.steps.map(x => x.startedAt), ...t.tasks.map(x => x.updatedAt)]
  return times.length > 0 ? Math.min(...times) : now
}

/** A token count as `72k` or `1.2M`; empty for none. */
function tok(n: number): string {
  if (n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Tokens as `72k` or `1.2M`; empty when the agent has none yet. */
function tokensOf(a: AgentRow): string {
  return tok((a.tokensIn ?? 0) + (a.tokensOut ?? 0))
}

/** What a task took in wall-clock time: the main loop's turns on it and its agents' own. */
const spentMs = (m: TaskMeterRow | undefined): number => (m !== undefined ? m.ms + m.agentMs : 0)

const [PIP_DONE, PIP_NOW, PIP_QUEUED] = GLYPHS.pip

type PlanCol = { tokens: number; state: 'done' | 'active' | 'queued'; first: number }

/**
 * The PLAN strip's columns: one per task, its height the tokens it took and
 * its state the colour. Over what fits, tasks are bucketed in runs (a run is
 * `active` if any of its tasks is, `queued` if all are, else `done`).
 */
function planCols(rows: TaskMeterRow[], room: number): { cols: PlanCol[]; pitch: 1 | 2 } {
  const one: PlanCol[] = rows.map((m, i) => ({
    tokens: m.tokens,
    state: m.task.status === 'completed' ? 'done' : m.task.status === 'in_progress' ? 'active' : 'queued',
    first: i,
  }))
  const cap = Math.max(4, Math.min(PLAN_MAX, room))
  if (one.length * 2 <= cap) return { cols: one, pitch: 2 }
  if (one.length <= cap) return { cols: one, pitch: 1 }
  const size = Math.ceil(one.length / cap)
  const out: PlanCol[] = []
  for (let i = 0; i < one.length; i += size) {
    const run = one.slice(i, i + size)
    out.push({
      tokens: run.reduce((n, c) => n + c.tokens, 0),
      state: run.some(c => c.state === 'active') ? 'active' : run.every(c => c.state === 'queued') ? 'queued' : 'done',
      first: i,
    })
  }
  return { cols: out, pitch: 1 }
}

const PLAN_INK: Record<PlanCol['state'], Ink> = { done: 'mute', active: 'iris', queued: 'rest' }
const PLAN_TEXT: Record<PlanCol['state'], Omit<Run, 'text'>> = { done: { dim: true }, active: { color: C.live }, queued: { color: C.subtle } }

/**
 * The PLAN instrument (the task meter): one column per task, three rows
 * tall, its height the tokens it took, its colour its state (done `mute`,
 * active `iris`, queued `rest`, the heaviest `ember`). The text form is the
 * same box in eighth blocks.
 */
function planInst(t: Timeline, meter: TaskMeterRow[], heaviest: string | undefined, room: number): InstSpec {
  const { cols, pitch } = planCols(meter, room)
  const vals = cols.map(c => c.tokens)
  const heavy = heaviest !== undefined ? meter.findIndex(m => m.task.id === heaviest) : -1
  let peak = -1
  cols.forEach((c, i) => {
    if (heavy >= 0 && c.first <= heavy) peak = i
  })
  const hueOf = (i: number): Ink => (cols[i]?.state === 'active' ? 'iris' : i === peak ? 'ember' : PLAN_INK[cols[i]?.state ?? 'queued'])
  const columns = Math.max(1, cols.length * pitch)
  const lv = levels(vals, PLAN_ROWS)
  const textRows: Run[][] = []
  for (let r = 0; r < PLAN_ROWS; r++) {
    const runs: Run[] = []
    cols.forEach((c, i) => {
      const part = Math.max(0, Math.min(8, (lv[i] ?? 0) - (PLAN_ROWS - 1 - r) * 8))
      const glyph = part > 0 ? GLYPHS.sparks[part - 1]! : r === PLAN_ROWS - 1 ? GLYPHS.sparks[0] : ' '
      const style = i === peak && c.state !== 'active' ? { color: C.lead } : PLAN_TEXT[c.state]
      runs.push({ text: glyph, ...style })
      if (pitch === 2) runs.push({ text: ' ' })
    })
    textRows.push(runs)
  }
  return {
    key: 'plan',
    columns,
    rows: PLAN_ROWS,
    sig: `plan:${pitch}:${peak}:${cols.map(c => `${c.state[0]}${c.tokens}`).join(',')}`,
    frames: () => [bars(PLAN_ROWS, vals, { pitch, hueOf: (i: number) => hueOf(i) })],
    fallback: textRows,
  }
}

/** The PACE instrument: tasks closed per bucket of the session, one row. */
function paceInst(values: number[], n: 10 | 22): InstSpec {
  const text = spark(values, n)
  return {
    key: 'pace',
    columns: n,
    rows: 1,
    sig: `pace:${n}:${values.join(',')}`,
    frames: () => [bars(1, values.slice(-n), { hueOf: () => 'iris' })],
    fallback: [text],
  }
}

/** The Tasks tab: the PLAN and PACE deck, then ACTIVE (agents tethered under the task), QUEUED and DONE. */
export function tasksView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  try {
    if (t.tasks.length === 0) {
      return (
        <Box flexDirection="column">
          {wrapWords(EMPTY, Math.max(1, cols - 2), 4).map((l, i) => (
            <Text key={`empty-${i}`} dimColor wrap="truncate-end">{`  ${l}`}</Text>
          ))}
        </Box>
      )
    }
    const total = t.tasks.length
    const active = t.tasks.filter(x => x.status === 'in_progress').sort(byNewest)
    const queued = t.tasks.filter(x => x.status === 'pending')
    const done = t.tasks.filter(x => x.status === 'completed').sort(byNewest)
    const start = startOf(t, now)
    const waits = waitStates(t, u, now)
    const meter = taskMeter(t)
    const byTask = new Map<string, TaskMeterRow>(meter.rows.map(m => [keyOf(m.task), m]))

    const activeCount = active.length > 0 ? 1 : 0
    const doneTimes = done.map(x => x.updatedAt)
    const gauge = cols >= 62 ? 22 : 10
    const paceValues = buckets(doneTimes, start, now, gauge)
    const plan = planInst(t, meter.rows, meter.heaviest, cols - DECK.gauge - 2)
    const peak = meter.rows.reduce((n, m) => Math.max(n, m.tokens), 0)
    const anyLive = Object.values(t.agents).some(a => a.status === 'running')
    const planValues = meter.rows.map(m => m.tokens)
    const rows: RichRow[] = []
    if (ctx.look !== 'rich') {
      rows.push({
        key: 'deck-tasks',
        label: 'TASKS',
        cells: [
          { col: DECK.gauge, runs: pips(done.length, total, 22, activeCount), narrow: pips(done.length, total, 10, activeCount), whole: true },
          { col: DECK.value, runs: [{ text: String(done.length), bold: true }, { text: `/${total}`, dim: true }] },
          { col: DECK.aside, runs: [{ text: elapsed(start, now), dim: true }] },
        ],
      })
    }
    rows.push({
      key: 'deck-plan',
      label: 'PLAN',
      inst: plan,
      cells: [
        { col: DECK.gauge, runs: spark(planValues, 22), narrow: spark(planValues, 10), whole: true },
        { col: DECK.value, runs: [{ text: tok(meter.total) === '' ? '0' : tok(meter.total), bold: true }, { text: ' all', dim: true }] },
        { col: DECK.aside, runs: peak > 0 ? [{ text: 'peak ', dim: true }, { text: tok(peak), bold: true }] : [{ text: 'no tokens yet', dim: true }] },
      ],
    })
    rows.push({
      key: 'deck-pace',
      label: 'PACE',
      inst: paceInst(paceValues, gauge),
      cells: [
        { col: DECK.gauge, runs: spark(paceValues, gauge), whole: true },
        ...(done.length > 0
          ? [{ col: DECK.value, runs: [{ text: elapsed(0, Math.round(Math.max(0, now - start) / done.length)), bold: true }, { text: ' each', dim: true }] }]
          : []),
        { col: DECK.aside, runs: [{ text: String(queued.length), bold: true }, { text: ' queued', dim: true }] },
      ],
    })
    const deckEl = richDeck(ctx, $, rows, {
      key: 'tasks-deck',
      frame: (() => {
        const pill = anyLive || active.length > 0 ? 'WORKING' : 'IDLE'
        return { pill, right: `${done.length} of ${total}` }
      })(),
    })
    // The strip names its heaviest and current column (the rich form only: the text deck has no room).
    const heavyAt = meter.heaviest !== undefined ? meter.rows.findIndex(m => m.task.id === meter.heaviest) : -1
    const nowAt = meter.rows.findIndex(m => m.task.status === 'in_progress')
    const capRoom = Math.max(0, cols - (DECK.gauge + 2) - 1)
    const heavyText = heavyAt >= 0 ? `▴${heavyAt + 1} heaviest` : ''
    const nowText = nowAt >= 0 ? `▴${nowAt + 1} now` : ''
    // What fits the row: both, else the current one, else nothing.
    const both = [heavyText, nowText].filter(x => x !== '').join('  ')
    const captionText = both.length <= capRoom ? both : nowText.length <= capRoom ? nowText : ''
    const captionEl =
      ctx.look === 'rich' && captionText !== '' ? (
        <Text key="plan-caption" wrap="truncate-end">
          {' '.repeat(DECK.gauge + 2)}
          <Text color={C.lead}>{captionText === both ? heavyText : ''}</Text>
          {captionText === both && heavyText !== '' && nowText !== '' ? '  ' : ''}
          <Text color={C.live} bold>
            {nowText}
          </Text>
        </Text>
      ) : null

    const toggleOpen = (key: string) => (): Promise<void> =>
      updateUi($, s => {
        if (s.taskOpen === key) {
          const { taskOpen: _closed, ...rest } = s
          return rest
        }
        return { ...s, taskOpen: key }
      })
    const toPage = (key: string) => (): Promise<void> => openPage($, 'task', key)

    const blocks: RenderElement[][] = []

    if (active.length > 0) {
      const lines: RenderElement[] = [section(ctx, $, 'ACTIVE', 'tokens', 'time')]
      for (const x of active.slice(0, ACTIVE_CAP)) {
        const key = keyOf(x)
        const open = u.taskOpen === key
        const agents = agentsOn(t, x)
        const live = agents.filter(a => a.status === 'running').length
        const m = byTask.get(key)
        const used = m !== undefined ? tok(m.tokens) : ''
        lines.push(
          row(ctx, $, {
            key: `task-${key}`,
            glyph: PIP_NOW,
            glyphColor: statusColor(x.status),
            name: x.activeForm ?? x.subject,
            bold: true,
            ...(used !== '' ? { metric: used } : live > 0 && x.owner === 'main' ? { metric: `${live} live` } : {}),
            time: elapsed(x.updatedAt, now),
            onPress: toggleOpen(key),
          }),
        )
        const shown = agents.slice(0, TETHERED_AGENTS)
        const hidden = agents.length - shown.length
        shown.forEach((a, i) => {
          const pod = podFor(a, waits, now)
          const flag = signalFlag(pod)
          const at = tokensOf(a)
          lines.push(
            row(ctx, $, {
              key: `task-agent-${a.id}`,
              ...(flag !== undefined ? { flag } : {}),
              glyph: pod.hull.text,
              ...(pod.hull.color !== undefined ? { glyphColor: pod.hull.color } : {}),
              name: a.description,
              depth: 1,
              tether: { last: i === shown.length - 1 && hidden === 0 },
              ...(at !== '' ? { metric: at } : {}),
              time: elapsed(a.startedAt, now),
            }),
          )
        })
        if (hidden > 0) lines.push(more(ctx, $, hidden, 'more agents', 1))
        if (open) {
          const details: Detail[] =
            agents.length === 0
              ? [{ key: 'agents', value: 'none working on it' }]
              : agents.slice(0, OPENED_AGENTS).map((a, i) => ({
                  key: i === 0 ? 'agent' : '',
                  value: [{ text: `${a.type} · ${a.description}` }, ...(a.doing !== '' ? [{ text: ` · ${a.doing}`, dim: true }] : [])],
                }))
          if (m !== undefined && m.running > 0 && m.tokens > 0) {
            details.push({ key: 'tokens', value: `${m.running} live: ${tok(m.runningTokens) || '0'} of the ${tok(m.tokens)}` })
          }
          const actions: Action[] = [{ hotkey: 'p', label: 'page', key: `page-${key}`, onPress: toPage(key) }]
          lines.push(opened(ctx, $, details, actions))
        }
      }
      if (active.length > ACTIVE_CAP) lines.push(more(ctx, $, active.length - ACTIVE_CAP, 'more active'))
      blocks.push(lines)
    }

    if (queued.length > 0) {
      const lines: RenderElement[] = [section(ctx, $, 'QUEUED')]
      for (const x of queued.slice(0, QUEUED_CAP)) {
        const ownerType = x.owner !== 'main' ? t.agents[x.owner]?.type : undefined
        const owner = ownerType !== undefined ? typeShort(ownerType) : undefined
        lines.push(
          row(ctx, $, {
            key: `task-${keyOf(x)}`,
            glyph: PIP_QUEUED,
            name: x.subject,
            ...(owner !== undefined ? { metric: owner } : {}),
            onPress: toPage(keyOf(x)),
          }),
        )
      }
      if (queued.length > QUEUED_CAP) lines.push(more(ctx, $, queued.length - QUEUED_CAP))
      blocks.push(lines)
    }

    const unfolded = u.doneAll === true
    if (done.length > 0) {
      const cap = unfolded ? UNFOLDED_CAP : DONE_CAP
      const lines: RenderElement[] = [section(ctx, $, 'DONE', 'tokens', 'time')]
      for (const x of done.slice(0, cap)) {
        const m = byTask.get(keyOf(x))
        const used = m !== undefined ? tok(m.tokens) : ''
        const took = spentMs(m)
        lines.push(
          row(ctx, $, {
            key: `task-${keyOf(x)}`,
            glyph: PIP_DONE,
            name: x.subject,
            dim: true,
            ...(used !== '' ? { metric: used } : {}),
            time: took > 0 ? elapsed(0, took) : elapsed(x.updatedAt, now),
            onPress: toPage(keyOf(x)),
          }),
        )
      }
      if (done.length > cap) lines.push(more(ctx, $, done.length - cap))
      blocks.push(lines)
    }

    const hints: Hint[] = []
    if (active.length > 0 || queued.length > 0 || done.length > 0) hints.push({ text: '↵ open' })
    if (done.length > DONE_CAP) {
      hints.push({
        hotkey: 'd',
        label: unfolded ? 'newest 3' : 'all done',
        key: 'hint-d',
        onPress: () =>
          updateUi($, s => {
            if (s.doneAll === true) {
              const { doneAll: _folded, ...rest } = s
              return rest
            }
            return { ...s, doneAll: true }
          }),
      })
    }
    hints.push({ hotkey: 'e', label: 'export', key: 'hint-e', onPress: async () => void (await exportDigest($)) })

    const out: RenderElement[] = []
    if (deckEl !== null) out.push(deckEl)
    if (captionEl !== null) out.push(captionEl)
    for (const lines of blocks) {
      if (out.length > 0) out.push(blank(ctx, $, `gap-${out.length}`))
      out.push(...lines)
    }
    const foot = footer(ctx, $, hints)
    if (foot !== null) {
      out.push(blank(ctx, $, 'gap-footer'))
      out.push(foot)
    }
    return <Box flexDirection="column">{out}</Box>
  } catch (err) {
    debug($, `tasks view failed: ${errText(err)}`)
    return <Text dimColor>{`Tasks: ${errText(err)}`.slice(0, Math.max(1, cols))}</Text>
  }
}

// ---- the task page ---------------------------------------------------------------

const PILL = { in_progress: 'ACTIVE', completed: 'DONE', pending: 'QUEUED' } as const
const STATUS_WORD = { in_progress: 'in progress', completed: 'done', pending: 'queued' } as const
// What each share of the stack takes: the accent first, then the other hues.
const SHARE_COLORS = [C.lead, C.live, C.model, C.result, C.wait, C.fail]
const STACK_CELLS = 28

/** Each part's cells out of `cells` by largest remainder; a part with nothing gets none. */
function shareCells(values: number[], cells: number): number[] {
  const sum = values.reduce((a, b) => a + b, 0)
  if (sum <= 0) return values.map(() => 0)
  const raw = values.map(v => (v * cells) / sum)
  const n = raw.map(Math.floor)
  let left = cells - n.reduce((a, b) => a + b, 0)
  raw
    .map((v, i) => [v - Math.floor(v), i] as const)
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => {
      if (left > 0 && values[i]! > 0) {
        n[i] = n[i]! + 1
        left--
      }
    })
  return n
}

/**
 * The task page (`ui.page = { kind: 'task', id: '<owner>:<id>' }`; Enter on a
 * queued or done task, `p` on the opened active one). The full subject and
 * the active form; STATUS, TIME against what a task usually takes here
 * (the median of the done ones) and TOKENS; TOKENS stacked by agent; its
 * agents, each with its hull and its whole description and what it is doing;
 * and the steps its agents ran. Nothing is cut: text wraps in full.
 */
export function taskPage(ctx: ViewCtx, $: EngineInterface, id: string): RenderElement {
  const { t, cols, now } = ctx
  const index = t.tasks.findIndex(x => keyOf(x) === id)
  const task = t.tasks[index]
  if (task === undefined) return page(ctx, $, { key: 'task-page', title: 'This task is gone.' })
  const meter = taskMeter(t)
  const m = meter.rows[index]
  const agents = agentsOn(t, task)
  const room = Math.max(8, cols - COL.name)
  const took = spentMs(m)
  const spentText = took > 0 ? elapsed(0, took) : task.status === 'in_progress' ? elapsed(task.updatedAt, now) : task.status === 'completed' ? 'not recorded' : 'not started'
  const usual = median(meter.rows.filter(r => r.task.status === 'completed' && keyOf(r.task) !== id && spentMs(r) > 0).map(spentMs))
  const timeValue: Run[] = [{ text: spentText, bold: true }, ...(usual !== undefined ? [{ text: ` · usually ${elapsed(0, usual)}`, dim: true }] : [])]
  const status = statusColor(task.status)

  const fields = [
    { label: 'STATUS', value: [{ text: STATUS_WORD[task.status], ...(status !== undefined ? { color: status } : {}) }, { text: ` · updated ${clock(task.updatedAt, true)}`, dim: true }] as Run[] },
    { label: 'TIME', value: timeValue },
    { label: 'TOKENS', value: [{ text: tok(m?.tokens ?? 0) || '0', bold: true }, ...(m !== undefined && m.agents > 0 ? [{ text: ` · ${m.agents} ${m.agents === 1 ? 'agent' : 'agents'}`, dim: true }] : [])] as Run[] },
    ...(task.owner !== 'main' ? [{ label: 'OWNER', value: t.agents[task.owner]?.type ?? task.owner }] : []),
  ]

  const blocks: PageBlock[] = []
  // Tokens stacked by agent: the main loop's own, then each agent's.
  const parts: { name: string; tokens: number }[] = []
  if ((task.tokens ?? 0) > 0) parts.push({ name: 'main', tokens: task.tokens ?? 0 })
  for (const a of agents) parts.push({ name: a.type, tokens: (a.tokensIn ?? 0) + (a.tokensOut ?? 0) })
  const shown = parts.filter(p => p.tokens > 0)
  if (shown.length > 0) {
    const total = shown.reduce((n, p) => n + p.tokens, 0)
    const cells = shareCells(
      shown.map(p => p.tokens),
      Math.min(STACK_CELLS, room),
    )
    const lines: Run[][] = [shown.map((p, i) => ({ text: '▄'.repeat(cells[i] ?? 0), color: SHARE_COLORS[i % SHARE_COLORS.length] })).filter(r => r.text !== '')]
    shown.forEach((p, i) => {
      lines.push([
        { text: '▄ ', color: SHARE_COLORS[i % SHARE_COLORS.length] },
        { text: p.name, bold: true },
        { text: ` ${tok(p.tokens)} · ${Math.round((p.tokens / total) * 100)}%`, dim: true },
      ])
    })
    blocks.push({ key: 'tokens', label: 'TOKENS BY AGENT', lines })
  }

  if (agents.length > 0) {
    const lines: Run[][] = []
    agents.forEach((a, i) => {
      if (i > 0) lines.push([{ text: '' }])
      const pod = podOf(a, now)
      const at = tokensOf(a)
      lines.push([
        pod.hull,
        { text: ' ' },
        ...(pod.signal !== undefined ? [pod.signal, { text: ' ' }] : []),
        { text: a.type, bold: true },
        { text: `${at !== '' ? ` · ${at}` : ''} · ${elapsed(a.startedAt, a.status === 'running' ? now : (a.endedAt ?? a.startedAt))} · ${a.status}`, dim: true },
      ])
      for (const l of wrapFull(a.description, room)) lines.push([{ text: l }])
      if (a.status === 'running' && a.doing !== '') for (const l of wrapFull(`now: ${a.doing}`, room)) lines.push([{ text: l, dim: true }])
    })
    blocks.push({ key: 'agents', label: 'AGENTS', lines })
  } else {
    blocks.push({ key: 'agents', label: 'AGENTS', lines: [[{ text: task.status === 'pending' ? 'None yet: the task has not started.' : 'No agent worked on it.', dim: true }]] })
  }

  const ids = new Set(agents.map(a => a.id))
  const steps: Step[] = t.steps.filter(s => ids.has(s.agent)).sort((a, b) => a.seq - b.seq)
  if (steps.length > 0) {
    const lines: Run[][] = steps.map(s => {
      const color = statusColor(s.status)
      const who = t.agents[s.agent]?.type ?? s.agent
      return [
        { text: `${STEP_GLYPH[s.status]} `, ...(color !== undefined ? { color } : { dim: true }) },
        { text: s.label },
        { text: ` · ${who} · ${clock(s.startedAt, true)}`, dim: true },
      ]
    })
    blocks.push({ key: 'steps', label: 'STEPS', lines })
  }

  return page(ctx, $, {
    key: 'task-page',
    frame: { pill: PILL[task.status], right: `task ${index + 1} of ${t.tasks.length}` },
    title: task.subject,
    ...(task.activeForm !== undefined ? { body: task.activeForm } : {}),
    fields,
    blocks,
  })
}
