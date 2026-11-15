import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, TaskItem, Timeline } from '../../types'
import { debug, errText, updateUi } from '../state'
import { buckets10, elapsed, spark10, wrapWords } from './fit'
import { exportDigest } from './handoff'
import { fitHints } from './hints'
import { barCell, blank, footer, more, opened, readout, row, section } from './parts'
import type { Detail, Hint, ReadoutCell, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, statusColor } from './style'

const EMPTY = 'No tasks yet. They appear when Claude writes a task list.'
// Rows each section shows before its `+ n more` line.
const ACTIVE_CAP = 1
const QUEUED_CAP = 5
const DONE_CAP = 3
// `d` unfolds the done tasks; a very long list still stops here.
const UNFOLDED_CAP = 20
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

/** A bar in the dim colour: the queue is not live work. */
const dimBar = (value: number, total: number): Run[] =>
  barCell(value, total).map(r => (r.color === C.live ? { text: r.text, dim: true } : r))

/** The Tasks tab: readouts on one scale, then ACTIVE, QUEUED and DONE. */
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

    // ELAPSED is last: it is the first cell a narrow pane gives up, then QUEUED, then ACTIVE.
    const cells: ReadoutCell[] = [
      { label: 'DONE', value: [{ text: String(done.length), bold: true }, { text: `/${total}`, dim: true }], gfx: barCell(done.length, total) },
      { label: 'ACTIVE', value: String(active.length), gfx: barCell(active.length, total), drop: 3 },
      { label: 'QUEUED', value: String(queued.length), gfx: dimBar(queued.length, total), drop: 2 },
      {
        label: 'ELAPSED',
        value: elapsed(start, now),
        gfx: [{ text: spark10(buckets10(done.map(x => x.updatedAt), start, now)), dim: true }],
        drop: 1,
      },
    ]

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
            glyph: '▸',
            glyphColor: statusColor(x.status),
            name: x.activeForm ?? x.subject,
            bold: true,
            ...(live > 0 && x.owner === 'main' ? { metric: `${live} live` } : {}),
            time: elapsed(x.updatedAt, now),
            onPress: toggleOpen(key),
          }),
        )
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
        const owner = x.owner !== 'main' ? t.agents[x.owner]?.type : undefined
        lines.push(
          row(ctx, $, { key: `task-${keyOf(x)}`, glyph: '○', name: x.subject, ...(owner !== undefined ? { metric: owner } : {}) }),
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
        lines.push(row(ctx, $, { key: `task-${keyOf(x)}`, glyph: '✓', name: x.subject, dim: true, time: elapsed(x.updatedAt, now) }))
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
    const head = readout(ctx, $, cells)
    if (head !== null) out.push(head)
    for (const lines of blocks) {
      if (out.length > 0) out.push(blank(ctx, $, `gap-${out.length}`))
      out.push(...lines)
    }
    const foot = footer(ctx, $, fitHints(hints, cols))
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
