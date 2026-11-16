import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, TaskItem, Timeline } from '../../types'
import { oneLine } from '../model/label'
import { median, taskMeter } from '../model/meter'
import type { TaskMeterRow } from '../model/meter'
import { NO_LIST_TEXT, todoBlock } from '../model/todo'
import { debug, errText, updateUi } from '../state'
import { openAgentPage, runningStep } from './agentmeta'
import { lineOf, stateOf } from './crewnode'
import type { Seg } from './crewnode'
import { clock, doing, fitRuns, levels, span, todoBar, typeShort, wordFit, wrapFull } from './fit'
import { doingView, waitStates } from './needs'
import { openPage } from './pagenav'
import { blank, frameFootInst, frameTopInst, inst, page, runText, section } from './parts'
import type { InstSpec, PageBlock, Run } from './parts'
import { Grid } from './raster'
import type { Ground } from './raster'
import type { ViewCtx } from './shell'
import { accentName, C, CK, COL, critterGlyph, critterOf, edges, palette, podOf, statusColor, typeName } from './style'
import { colHeads, flushRight, growBody, hasTime, midEnd, moreRow, nameLimit, stepGlyph } from './tabkit'
import type { FootHint } from './overview'

// The Tasks tab (cockpit spec "CockpitTasks"): a header (how many are done,
// the pace sentence, the bar, "Effort so far" with one bar a task and the
// heaviest), then Doing now (its agents tethered as micro critters), Up next
// and Done, and "Earlier" for the lists of earlier requests (R12). Enter
// opens a task's page.

// Rows each section shows before its `+ n more` line.
const ACTIVE_CAP = 1
const QUEUED_CAP = 5
const DONE_CAP = 3
const EARLIER_CAP = 3
// `d` unfolds the done tasks; a very long list still stops here.
const UNFOLDED_CAP = 20
// Agents tethered under the active task before the more line.
const TETHERED_AGENTS = 4

/** A task's identity in the pane: its owner and id (ids repeat across agents). */
const keyOf = (x: TaskItem): string => `${x.owner}:${x.id}`

const byNewest = (a: TaskItem, b: TaskItem): number => b.updatedAt - a.updatedAt

/** The agents working on a task: those it was in progress for, or the agent that owns it; the newest first, as the mock lists them. */
function agentsOn(t: Timeline, task: TaskItem): AgentRow[] {
  if (task.owner !== 'main') {
    const owner = t.agents[task.owner]
    return owner !== undefined ? [owner] : []
  }
  return Object.values(t.agents)
    .filter(a => a.id !== 'main' && a.parent === 'main' && a.taskId === task.id)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** A token count as `72k` or `1.2M`; empty for none. */
function tok(n: number): string {
  if (n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** What a task took in wall-clock time: the main loop's turns on it and its agents' own. */
const spentMs = (m: TaskMeterRow | undefined): number => (m !== undefined ? m.ms + m.agentMs : 0)

// ---- the pace sentence ---------------------------------------------------------

const FIVE_MIN = 5 * 60_000

/** "about 20 min left at this pace": the average time a done task took this request, times the tasks left, rounded to the nearest minute under 10 min and the nearest 5 minutes above (never biased low). Nothing before one is done. */
function paceRuns(done: number, open: number, since: number | undefined, now: number): Run[] {
  if (open <= 0 || done <= 0 || since === undefined || now <= since) return []
  const left = ((now - since) / done) * open
  const rounded = left < 10 * 60_000 ? Math.max(60_000, Math.round(left / 60_000) * 60_000) : Math.round(left / FIVE_MIN) * FIVE_MIN
  return [{ text: 'about ', dim: true }, { text: span(rounded), bold: true }, { text: ' left at this pace', dim: true }]
}

// ---- Effort so far -------------------------------------------------------------

type Unit = { tokens: number; state: 'done' | 'active' | 'queued' }

/**
 * One bar a task: three cells to a task (a two-cell bar and a gap) while they
 * fit, else two, else one; past that, tasks share a bar in runs (a run is
 * active if any of its tasks is, queued if all are, else done).
 */
function effortUnits(rows: TaskMeterRow[], room: number): { units: Unit[]; pitch: 3 | 2 | 1 } {
  const one: Unit[] = rows.map(m => ({ tokens: m.tokens, state: m.task.status === 'completed' ? 'done' : m.task.status === 'in_progress' ? 'active' : 'queued' }))
  if (one.length * 3 <= room) return { units: one, pitch: 3 }
  if (one.length * 2 <= room) return { units: one, pitch: 2 }
  if (one.length <= room) return { units: one, pitch: 1 }
  const size = Math.ceil(one.length / Math.max(1, room))
  const out: Unit[] = []
  for (let i = 0; i < one.length; i += size) {
    const run = one.slice(i, i + size)
    out.push({
      tokens: run.reduce((n, c) => n + c.tokens, 0),
      state: run.some(c => c.state === 'active') ? 'active' : run.every(c => c.state === 'queued') ? 'queued' : 'done',
    })
  }
  return { units: out, pitch: 1 }
}

const EFFORT_ROWS = 2

/** The effort chart as an instrument: two rows of eighth blocks, the task in progress bright, the done ones soft, the rest at rest. */
function effortInst(rows: TaskMeterRow[], width: number, ground: Ground): InstSpec {
  const { units, pitch } = effortUnits(rows, width)
  const barW = pitch === 3 ? 2 : 1
  const lv = levels(units.map(u => u.tokens), EFFORT_ROWS)
  const used = units.length * pitch
  const text: Run[][] = [[], []]
  units.forEach((u, i) => {
    const v = lv[i] ?? 0
    for (let r = 0; r < EFFORT_ROWS; r++) {
      const k = EFFORT_ROWS - 1 - r
      const part = Math.max(0, Math.min(8, v - k * 8))
      const glyph = part > 0 ? '▁▂▃▄▅▆▇█'[part - 1]! : r === EFFORT_ROWS - 1 ? '▁' : ' '
      const style: Omit<Run, 'text'> = v <= 0 ? { color: C.subtle } : u.state === 'active' ? { color: CK.accent } : u.state === 'done' ? { color: CK.accent, dim: true } : { color: C.subtle }
      text[r]!.push({ text: glyph.repeat(barW), ...style }, ...(pitch === 1 ? [] : [{ text: ' '.repeat(pitch - barW) }]))
    }
  })
  return {
    key: 'effort',
    columns: Math.max(1, used),
    rows: EFFORT_ROWS,
    sig: `effort:${ground}:${accentName()}:${pitch}:${units.map(u => `${u.state[0]}${u.tokens}`).join(',')}`,
    frames: () => {
      const g = new Grid(Math.max(1, used), EFFORT_ROWS, palette(ground))
      units.forEach((u, i) => {
        const v = lv[i] ?? 0
        for (let w = 0; w < barW; w++) {
          for (let k = 0; k < EFFORT_ROWS; k++) {
            const part = Math.max(0, Math.min(8, v - k * 8))
            const rr = EFFORT_ROWS - 1 - k
            if (part > 0) g.lv(i * pitch + w, rr, part, u.state === 'active' ? 'iris' : u.state === 'done' ? 'irisSoft' : 'rest')
            else if (k === 0) g.lv(i * pitch + w, rr, 1, 'rest')
          }
        }
      })
      return [g]
    },
    fallback: text,
  }
}

// ---- the rows ------------------------------------------------------------------

/** One task row at absolute columns: the glyph at 2, the name at 4, a figure ending at 49, a time ending at 59. */
function taskRow(
  ctx: ViewCtx,
  $: EngineInterface,
  r: { key: string; glyph: Run; name: Run[]; mid?: Run; time?: Run | Run[]; mark?: string; onPress: () => void | Promise<void> },
): RenderElement {
  const mid = midEnd(ctx.cols)
  const { right } = edges(ctx.cols)
  const name = (fitRuns(r.name, Math.max(1, nameLimit(ctx.cols) - COL.name)) as Run[]).filter(x => x.text !== '')
  const body: Seg[] = [{ col: 2, ...r.glyph }]
  let col: number = COL.name
  for (const n of name) {
    body.push({ ...n, col })
    col += n.text.length
  }
  if (r.mid !== undefined && mid !== undefined) body.push(...flushRight([r.mid], mid))
  if (r.time !== undefined && hasTime(ctx.cols)) body.push(...flushRight(Array.isArray(r.time) ? r.time : [r.time], right))
  return lineOf(ctx, $, {
    key: r.key,
    ...(r.mark !== undefined ? { pre: [{ col: 0, text: '▍', color: r.mark }] } : {}),
    body,
    onPress: r.onPress,
  })
}

/** The dim line of a plain sentence at column 2, cut at a word. */
function noteRow(ctx: ViewCtx, $: EngineInterface, key: string, text: string): RenderElement {
  const { left, right } = edges(ctx.cols)
  return lineOf(ctx, $, { key, body: [{ col: left, text: wordFit(text, right - left + 1), dim: true }] })
}

/** One tethered agent: its micro critter at column 4 (badge column kept), the type bold at 10 and what it does dim, the time at 59; three rows (two for the last, the section's gap being the third). */
function tetherRow(ctx: ViewCtx, $: EngineInterface, t: Timeline, a: AgentRow, state: ReturnType<typeof stateOf>, last: boolean): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { right } = edges(ctx.cols)
  const ground = ctx.ground ?? 'night'
  const room = Math.max(1, right - 10 + 1)
  const what: Run[] =
    state === 'waiting'
      ? [{ text: 'Waiting for your answer', color: CK.ask }]
      : state === 'failed'
        ? [{ text: oneLine((a.result ?? a.doing ?? '').split('\n')[0] ?? '') || 'Stopped by an error', color: CK.fail }]
        : [{ text: doing(runningStep(t, a.id), doingView(ctx), Math.max(0, room - span(ctx.now - a.startedAt).length - 2 - typeName(a.type).length - 2)), dim: true }]
  const time: Run[] = [{ text: span(ctx.now - a.startedAt), dim: true }]
  const rw = time[0]!.text.length
  const name = typeName(a.type)
  // F M14: a doing line that does not fit leaves the row whole (the verb at least stays when it fits), never a cut.
  const left = fitRuns([{ text: name, bold: true }, ...(what[0]!.text === '' ? [] : [{ text: '  ', dim: true }, ...what])], Math.max(1, room - rw - 2)) as Run[]
  const lw = left.reduce((n, x) => n + x.text.length, 0)
  const body = [...left, { text: ' '.repeat(Math.max(1, room - lw - rw)) }, ...time].filter(x => x.text !== '')
  const key = `task-agent-${a.id}`
  return (
    <Box key={`row-${key}`} flexDirection="row">
      <Text key={`${key}-pad`}>{' '.repeat(COL.name)}</Text>
      {inst(ctx, $, { key: `${key}-who`, ...critterOf(a, { state, size: 'micro', ground, motion: ctx.motion === true }) })}
      <Text key={`${key}-gap`}> </Text>
      <Box key={`${key}-text`} flexDirection="column" width={room} flexShrink={0}>
        <Button key={key} plain onPress={() => openAgentPage($, a.id, key)}>
          {body.map((r, i) => runText(r, ctx.e, $, `${key}-${i}`))}
        </Button>
        <Text key={`${key}-gap1`}> </Text>
        {last ? null : <Text key={`${key}-gap2`}> </Text>}
      </Box>
    </Box>
  )
}

/** The Tasks tab: the header, then Doing now (agents tethered under the task), Up next, Done and Earlier. */
export function tasksView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  const { left, right } = edges(cols)
  const ground = ctx.ground ?? 'night'
  try {
    const block = todoBlock(t)
    // The current request's tasks: the lead's list and every other agent's own.
    const current: TaskItem[] = [...block.items, ...t.tasks.filter(x => x.owner !== 'main')]
    const active = current.filter(x => x.status === 'in_progress').sort(byNewest)
    const queued = current.filter(x => x.status === 'pending')
    const done = current.filter(x => x.status === 'completed').sort(byNewest)
    const earlier = [...block.earlier].sort(byNewest)
    const meter = taskMeter(t)
    const byTask = new Map<string, TaskMeterRow>(meter.rows.map(m => [keyOf(m.task), m]))
    // Effort so far is this request's tasks only: the folded ones of earlier requests are not bars.
    const currentKeys = new Set(current.map(keyOf))
    const chartRows = meter.rows.filter(m => currentKeys.has(keyOf(m.task)))
    const waits = waitStates(t, u, now)
    const toPage = (key: string) => (): Promise<void> => openPage($, 'task', key, `task-${key}`)
    const unfolded = u.doneAll === true
    // R37: Up next, Done and Earlier keep the mock's caps at 46 rows and grow with the pane after that.
    const lists = [
      { count: queued.length, cap: QUEUED_CAP },
      { count: done.length, cap: unfolded ? UNFOLDED_CAP : DONE_CAP },
      { count: earlier.length, cap: unfolded ? UNFOLDED_CAP : EARLIER_CAP },
    ]
    const build = (caps: number[]): { out: RenderElement[]; hints: FootHint[] } => {
      const out: RenderElement[] = []
      const gap = (): void => void out.push(blank(ctx, $, `gap-${out.length}`))

      const emptyList = current.length === 0
      if (!emptyList) {
        // The counts are the lead's list (R11); with no lead list, every task.
        const lead = block.total > 0
        const total = lead ? block.total : current.length
        const nDone = lead ? block.done : done.length
        const hasCurrent = lead ? block.current !== undefined : active.length > 0
        out.push(inst(ctx, $, frameTopInst('tasks-lintel', cols, 'iris', ground)))
        const sentence: Run[] = nDone === total && total > 0 ? [{ text: `All ${total} done`, bold: true }] : [{ text: `${nDone} of ${total} done`, bold: true }]
        const pace = paceRuns(nDone, total - nDone, block.since, now)
        const paceW = pace.reduce((n, r) => n + r.text.length, 0)
        const first: Seg[] = [{ col: left, ...sentence[0]! }]
        if (paceW > 0 && paceW + sentence[0]!.text.length + 4 <= right - left + 1) first.push(...flushRight(pace, right))
        out.push(lineOf(ctx, $, { key: 'tasks-count', body: first }))
        out.push(blank(ctx, $, 'tasks-gap-bar'))
        out.push(
          <Text key="tasks-bar" wrap="truncate-end">
            {' '.repeat(left)}
            {todoBar(right - left + 1, total, nDone, hasCurrent ? 1 : 0).map((r, i) => runText(r, ctx.e, $, `tasks-bar-${i}`))}
          </Text>,
        )
        out.push(blank(ctx, $, 'tasks-gap-effort'))
        const chartCol = 18
        const room = right - chartCol + 1
        const heavy = chartRows.reduce<TaskMeterRow | undefined>((a, m) => (m.tokens > 0 && (a === undefined || m.tokens > a.tokens) ? m : a), undefined)
        if (room >= 12 && cols >= 50) {
          out.push(
            <Box key="tasks-effort" flexDirection="row">
              <Box key="tasks-effort-words" flexDirection="column" width={chartCol} flexShrink={0}>
                <Text key="tasks-effort-0" dimColor>{`${' '.repeat(left)}Effort so far`}</Text>
                <Text key="tasks-effort-1" dimColor>{`${' '.repeat(left)}one bar a task`}</Text>
              </Box>
              {inst(ctx, $, effortInst(chartRows, room, ground))}
            </Box>,
          )
        }
        if (heavy !== undefined) {
          const tail = `, ${tok(heavy.tokens)}`
          const label = wordFit(oneLine(heavy.task.subject), Math.max(1, right - left + 1 - 'Heaviest: '.length - tail.length))
          out.push(
            lineOf(ctx, $, {
              key: 'tasks-heaviest',
              body: [{ col: left, text: 'Heaviest: ', dim: true }, { col: left + 10, text: label }, { col: left + 10 + label.length, text: tail, dim: true }],
            }),
          )
        } else if (room < 12 || cols < 50) {
          out.push(noteRow(ctx, $, 'tasks-effort-none', 'Effort so far: no tokens yet'))
        }
        out.push(inst(ctx, $, frameFootInst('tasks-sill', cols, 'iris', ground)))
        gap()
      }

      const doneCap = caps[1]!
      const doneShown = done.slice(0, doneCap)
      const doneMore = done.length - doneShown.length

      if (emptyList) {
        out.push(section(ctx, $, 'To do', undefined, { key: 'sec-todo' }))
        out.push(noteRow(ctx, $, 'todo-none', NO_LIST_TEXT))
        if (earlier.length > 0) gap()
      }

      if (active.length > 0) {
        out.push(section(ctx, $, 'Doing now', String(active.length), { key: 'sec-doing' }))
        for (const x of active.slice(0, ACTIVE_CAP)) {
          const key = keyOf(x)
          const m = byTask.get(key)
          const used = m !== undefined ? tok(m.tokens) : ''
          out.push(
            taskRow(ctx, $, {
              key: `task-${key}`,
              glyph: { text: '▸', color: CK.accent },
              name: [{ text: oneLine(x.activeForm ?? x.subject), bold: true }],
              ...(used !== '' ? { mid: { text: used, dim: true } } : {}),
              time: { text: span(now - x.updatedAt), color: CK.accent },
              mark: CK.accent,
              onPress: toPage(key),
            }),
          )
          const agents = agentsOn(t, x)
          const shown = agents.slice(0, TETHERED_AGENTS)
          // The last agent keeps two rows when the section's gap follows (the mock's six rows for two agents); a more line keeps the blank.
          shown.forEach((a, i) => out.push(tetherRow(ctx, $, t, a, stateOf(a, waits), i === shown.length - 1 && agents.length === shown.length)))
          if (agents.length > shown.length) out.push(moreRow(ctx, $, 'tether-more', `+ ${agents.length - shown.length} more agents`))
        }
        if (active.length > ACTIVE_CAP) out.push(moreRow(ctx, $, 'active-more', `+ ${active.length - ACTIVE_CAP} more doing now`))
        if (queued.length > 0 || done.length > 0 || earlier.length > 0) gap()
      }

      if (queued.length > 0) {
        out.push(section(ctx, $, 'Up next', String(queued.length), { key: 'sec-next' }))
        queued.slice(0, caps[0]!).forEach((x, i) => {
          const ownerType = x.owner !== 'main' ? t.agents[x.owner]?.type : undefined
          out.push(
            taskRow(ctx, $, {
              key: `task-${keyOf(x)}`,
              glyph: { text: '○', color: C.subtle },
              name: [{ text: oneLine(x.subject) }],
              ...(ownerType !== undefined ? { mid: { text: typeShort(ownerType), dim: true } } : {}),
              ...(i === 0 ? { time: { text: 'next', dim: true } } : {}),
              onPress: toPage(keyOf(x)),
            }),
          )
        })
        if (queued.length > caps[0]!) out.push(moreRow(ctx, $, 'queued-more', `+ ${queued.length - caps[0]!} more to do`))
        if (done.length > 0 || earlier.length > 0) gap()
      }

      if (done.length > 0) {
        out.push(section(ctx, $, 'Done', colHeads(cols, String(done.length), 'tokens', 'time'), { key: 'sec-done' }))
        for (const x of doneShown) {
          const m = byTask.get(keyOf(x))
          const used = m !== undefined ? tok(m.tokens) : ''
          const took = spentMs(m)
          out.push(
            taskRow(ctx, $, {
              key: `task-${keyOf(x)}`,
              glyph: { text: '✓', dim: true },
              name: [{ text: oneLine(x.subject), dim: true }],
              ...(used !== '' ? { mid: { text: used, dim: true } } : {}),
              time: { text: took > 0 ? span(took) : span(now - x.updatedAt), dim: true },
              onPress: toPage(keyOf(x)),
            }),
          )
        }
        // `d` lists every done task where the rule shows only some (and folds them again).
        if (unfolded || doneMore > 0) {
          const toggle = (): Promise<void> =>
            updateUi($, s => {
              if (s.doneAll === true) {
                const { doneAll: _folded, ...rest } = s
                return rest
              }
              return { ...s, doneAll: true }
            })
          out.push(
            <Box key="done-more" flexDirection="row" paddingLeft={COL.name} columnGap={3}>
              <Text key="done-more-text" dimColor>{doneMore > 0 ? `+ ${doneMore} more` : ''}</Text>
              <Button key="hint-d" hotkey="d" plain dimColor onPress={toggle}>
                {unfolded ? 'newest 3' : 'show all'}
              </Button>
            </Box>,
          )
        }
        if (earlier.length > 0) gap()
      }

      if (earlier.length > 0) {
        out.push(section(ctx, $, 'Earlier', String(earlier.length), { key: 'sec-earlier' }))
        const cap = caps[2]!
        for (const x of earlier.slice(0, cap)) {
          out.push(
            taskRow(ctx, $, {
              key: `task-${keyOf(x)}`,
              glyph: { text: '✓', dim: true },
              name: [{ text: oneLine(x.subject), dim: true }],
              onPress: toPage(keyOf(x)),
            }),
          )
        }
        if (earlier.length > cap) out.push(moreRow(ctx, $, 'earlier-more', `+ ${earlier.length - cap} more`))
      }

      const hints: FootHint[] = []
      if (current.length > 0 || earlier.length > 0) hints.push({ key: '↵', label: 'open task' })
      if (unfolded || doneMore > 0) hints.push({ key: 'd', label: unfolded ? 'newest 3' : 'all done' })
      hints.push({ key: 'esc', label: 'prompt' })
    return { out, hints }
    }
    return <Box flexDirection="column">{growBody(ctx, $, lists, build)}</Box>
  } catch (err) {
    debug($, `tasks view failed: ${errText(err)}`)
    return <Text dimColor>{`Tasks: ${errText(err)}`.slice(0, Math.max(1, cols))}</Text>
  }
}

// ---- the task page ---------------------------------------------------------------

const PILL = { in_progress: 'ACTIVE', completed: 'DONE', pending: 'QUEUED' } as const
const STATUS_WORD = { in_progress: 'in progress', completed: 'done', pending: 'queued' } as const
// What each share of the stack takes: the accent, the accent soft, then greys.
const SHARE_STYLES: Omit<Run, 'text'>[] = [{ color: CK.accent }, { color: CK.accent, dim: true }, { dim: true }, { color: C.subtle }]
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
 * task row): the full subject and the active form; status, time against what
 * a task usually takes here (the median of the done ones) and tokens; tokens
 * stacked by agent; its agents (a state glyph in the state's colour, the type
 * and the whole description); and the steps its agents ran. Nothing is cut:
 * text wraps in full.
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
  const spentText = took > 0 ? span(took) : task.status === 'in_progress' ? span(now - task.updatedAt) : task.status === 'completed' ? 'not recorded' : 'not started'
  const usual = median(meter.rows.filter(r => r.task.status === 'completed' && keyOf(r.task) !== id && spentMs(r) > 0).map(spentMs))
  const timeValue: Run[] = [{ text: spentText, bold: true }, ...(usual !== undefined ? [{ text: ` · usually ${span(usual)}`, dim: true }] : [])]
  const status = statusColor(task.status)

  const fields = [
    { label: 'Status', value: [{ text: STATUS_WORD[task.status], ...(status !== undefined && task.status !== 'in_progress' ? { color: status } : {}) }, { text: ` · updated ${clock(task.updatedAt, true)}`, dim: true }] as Run[] },
    { label: 'Time', value: timeValue },
    { label: 'Tokens', value: [{ text: tok(m?.tokens ?? 0) || '0', bold: true }, ...(m !== undefined && m.agents > 0 ? [{ text: ` · ${m.agents} ${m.agents === 1 ? 'agent' : 'agents'}`, dim: true }] : [])] as Run[] },
    ...(task.owner !== 'main' ? [{ label: 'Owner', value: t.agents[task.owner] !== undefined ? typeName(t.agents[task.owner]!.type) : task.owner }] : []),
  ]

  const blocks: PageBlock[] = []
  // Tokens stacked by agent: the main loop's own, then each agent's.
  const parts: { name: string; tokens: number }[] = []
  if ((task.tokens ?? 0) > 0) parts.push({ name: 'Main', tokens: task.tokens ?? 0 })
  for (const a of agents) parts.push({ name: typeName(a.type), tokens: (a.tokensIn ?? 0) + (a.tokensOut ?? 0) })
  const shown = parts.filter(p => p.tokens > 0)
  if (shown.length > 0) {
    const total = shown.reduce((n, p) => n + p.tokens, 0)
    const cells = shareCells(
      shown.map(p => p.tokens),
      Math.min(STACK_CELLS, room),
    )
    const lines: Run[][] = [shown.map((_p, i) => ({ text: '━'.repeat(cells[i] ?? 0), ...SHARE_STYLES[i % SHARE_STYLES.length]! })).filter(r => r.text !== '')]
    shown.forEach((p, i) => {
      lines.push([
        { text: '■ ', ...SHARE_STYLES[i % SHARE_STYLES.length]! },
        { text: p.name, bold: true },
        { text: ` ${tok(p.tokens)} · ${Math.round((p.tokens / total) * 100)}%`, dim: true },
      ])
    })
    blocks.push({ key: 'tokens', label: 'Tokens by agent', lines })
  }

  if (agents.length > 0) {
    const lines: Run[][] = []
    agents.forEach((a, i) => {
      if (i > 0) lines.push([{ text: '' }])
      const pod = podOf(a, now)
      const glyph = critterGlyph(pod.state)
      const at = (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
      lines.push([
        glyph.glyph,
        ...(glyph.badge !== undefined ? [glyph.badge] : []),
        { text: ' ' },
        { text: typeName(a.type), bold: true },
        { text: `${at > 0 ? ` · ${tok(at)}` : ''} · ${span((a.status === 'running' ? now : (a.endedAt ?? a.startedAt)) - a.startedAt)} · ${a.status}`, dim: true },
      ])
      for (const l of wrapFull(a.description, room)) lines.push([{ text: l }])
      if (a.status === 'running' && a.doing !== '') for (const l of wrapFull(`now: ${a.doing}`, room)) lines.push([{ text: l, dim: true }])
    })
    blocks.push({ key: 'agents', label: 'Agents', lines })
  } else {
    blocks.push({ key: 'agents', label: 'Agents', lines: [[{ text: task.status === 'pending' ? 'None yet: the task has not started.' : 'No agent worked on it.', dim: true }]] })
  }

  const ids = new Set(agents.map(a => a.id))
  const steps = t.steps.filter(s => ids.has(s.agent)).sort((a, b) => a.seq - b.seq)
  if (steps.length > 0) {
    const lines: Run[][] = steps.map(s => {
      const color = statusColor(s.status)
      const who = t.agents[s.agent] !== undefined ? typeName(t.agents[s.agent]!.type) : s.agent
      return [
        { text: `${stepGlyph(s.status)} `, ...(color !== undefined ? { color } : { dim: true }) },
        { text: s.label },
        { text: ` · ${who} · ${clock(s.startedAt, true)}`, dim: true },
      ]
    })
    blocks.push({ key: 'steps', label: 'Steps', lines })
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

