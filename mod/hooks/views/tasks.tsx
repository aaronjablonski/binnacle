import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, TaskItem, Timeline } from '../../types'
import { debug, errText, updateUi } from '../state'
import { buckets, elapsed, pips, spark, typeShort, wrapWords } from './fit'
import { signalFlag } from './agentmeta'
import { exportDigest } from './handoff'
import { podFor, waitStates } from './needs'
import { blank, deck, footer, more, opened, page, row, section } from './parts'
import type { Detail, Hint } from './parts'
import type { ViewCtx } from './shell'
import { DECK, GLYPHS, statusColor } from './style'

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

/** Tokens as `72k` or `1.2M`; empty when the agent has none yet. */
function tokensOf(a: AgentRow): string {
  const n = (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
  if (n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const [PIP_DONE, PIP_NOW, PIP_QUEUED] = GLYPHS.pip

/** The Tasks tab: the TASKS and PACE deck, then ACTIVE (agents tethered under the task), QUEUED and DONE. */
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

    const activeCount = active.length > 0 ? 1 : 0
    const doneTimes = done.map(x => x.updatedAt)
    const deckEl = deck(
      ctx,
      $,
      [
        {
          label: 'TASKS',
          cells: [
            { col: DECK.gauge, runs: pips(done.length, total, 22, activeCount), narrow: pips(done.length, total, 10, activeCount), whole: true },
            { col: DECK.value, runs: [{ text: String(done.length), bold: true }, { text: `/${total}`, dim: true }] },
            { col: DECK.aside, runs: [{ text: elapsed(start, now), dim: true }] },
          ],
        },
        {
          label: 'PACE',
          cells: [
            {
              col: DECK.gauge,
              runs: spark(buckets(doneTimes, start, now, 22), 22),
              narrow: spark(buckets(doneTimes, start, now, 10), 10),
              whole: true,
            },
            ...(done.length > 0
              ? [{ col: DECK.value, runs: [{ text: elapsed(0, Math.round(Math.max(0, now - start) / done.length)), bold: true }, { text: ' each', dim: true }] }]
              : []),
            { col: DECK.aside, runs: [{ text: String(queued.length), bold: true }, { text: ' queued', dim: true }] },
          ],
        },
      ],
      { key: 'tasks-deck' },
    )

    const toggleOpen = (key: string) => (): Promise<void> =>
      updateUi($, s => {
        if (s.taskOpen === key) {
          const { taskOpen: _closed, ...rest } = s
          return rest
        }
        return { ...s, taskOpen: key }
      })

    const blocks: RenderElement[][] = []

    if (active.length > 0) {
      const lines: RenderElement[] = [section(ctx, $, 'ACTIVE', 'agents', 'time')]
      for (const x of active.slice(0, ACTIVE_CAP)) {
        const key = keyOf(x)
        const open = u.taskOpen === key
        const agents = agentsOn(t, x)
        const live = agents.filter(a => a.status === 'running').length
        lines.push(
          row(ctx, $, {
            key: `task-${key}`,
            glyph: PIP_NOW,
            glyphColor: statusColor(x.status),
            name: x.activeForm ?? x.subject,
            bold: true,
            ...(live > 0 && x.owner === 'main' ? { metric: `${live} live` } : {}),
            time: elapsed(x.updatedAt, now),
            onPress: toggleOpen(key),
          }),
        )
        const shown = agents.slice(0, TETHERED_AGENTS)
        const hidden = agents.length - shown.length
        shown.forEach((a, i) => {
          const pod = podFor(a, waits, now)
          const flag = signalFlag(pod)
          const tok = tokensOf(a)
          lines.push(
            row(ctx, $, {
              key: `task-agent-${a.id}`,
              ...(flag !== undefined ? { flag } : {}),
              glyph: pod.hull.text,
              ...(pod.hull.color !== undefined ? { glyphColor: pod.hull.color } : {}),
              name: a.description,
              depth: 1,
              tether: { last: i === shown.length - 1 && hidden === 0 },
              ...(tok !== '' ? { metric: tok } : {}),
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
          lines.push(opened(ctx, $, details, []))
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
          row(ctx, $, { key: `task-${keyOf(x)}`, glyph: PIP_QUEUED, name: x.subject, ...(owner !== undefined ? { metric: owner } : {}) }),
        )
      }
      if (queued.length > QUEUED_CAP) lines.push(more(ctx, $, queued.length - QUEUED_CAP))
      blocks.push(lines)
    }

    const unfolded = u.doneAll === true
    if (done.length > 0) {
      const cap = unfolded ? UNFOLDED_CAP : DONE_CAP
      const lines: RenderElement[] = [section(ctx, $, 'DONE', undefined, 'ago')]
      for (const x of done.slice(0, cap)) {
        lines.push(row(ctx, $, { key: `task-${keyOf(x)}`, glyph: PIP_DONE, name: x.subject, dim: true, time: elapsed(x.updatedAt, now) }))
      }
      if (done.length > cap) lines.push(more(ctx, $, done.length - cap))
      blocks.push(lines)
    }

    const hints: Hint[] = []
    if (active.length > 0) hints.push({ text: '↵ open' })
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

/**
 * The task page (`ui.page = { kind: 'task', id: '<owner>:<id>' }`). A stub
 * from R1b so page routing has a body: the full subject and the active form.
 * R4 replaces it with the spec's page (status, time against the usual,
 * tokens by agent, its agents, its steps).
 */
export function taskPage(ctx: ViewCtx, $: EngineInterface, id: string): RenderElement {
  const task = ctx.t.tasks.find(x => `${x.owner}:${x.id}` === id)
  if (task === undefined) return page(ctx, $, { key: 'task-page', title: 'This task is gone.' })
  return page(ctx, $, {
    key: 'task-page',
    frame: { pill: task.status === 'in_progress' ? 'ACTIVE' : task.status === 'completed' ? 'DONE' : 'QUEUED' },
    fields: [
      { label: 'TASK', value: [{ text: task.subject, bold: true }] },
      ...(task.activeForm !== undefined ? [{ label: 'NOW', value: task.activeForm }] : []),
    ],
  })
}
