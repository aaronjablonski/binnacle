import type { EngineInterface } from 'claude-code'

import type { AgentRow, Step, Timeline } from '../../types'
import { journalOf, readBody } from '../journal'
import { pathsOf } from '../model/label'
import { debug, errText, leaveDetail, readTimeline, readUi, updateUi } from '../state'
import { tokenText } from './budget'
import { span } from './fit'
import { viewAgent } from './parts'
import type { Action } from './parts'
import { openPage } from './pagenav'
import type { ViewCtx } from './shell'
import { edges } from './style'
import type { PodState } from './style'

export const STEP_GLYPH: Record<Step['status'], string> = {
  running: '·',
  done: '✔',
  error: '✖',
  denied: '⊘',
  interrupted: '◌',
}
/** A workflow run's row glyph. */
export const RUN_GLYPH = '≡'
export const EMPTY = 'No agents yet. Subagents and workflow agents appear here while they run.'

/** The pane's own id: the target of a `$.ui.focus`. */
const PANE_ID = 'binnacle'

/** When main began: its first step, since the `main` row itself carries no start. */
export function mainSince({ t }: ViewCtx): number | undefined {
  let first: number | undefined
  for (const s of t.steps) {
    if (s.agent !== 'main') continue
    if (first === undefined || s.startedAt < first) first = s.startedAt
  }
  return first
}

/** Input and output tokens, or undefined when the agent has reported none. */
export function tokensOf(a: AgentRow): number | undefined {
  if (a.tokensIn === undefined && a.tokensOut === undefined) return undefined
  return (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
}

/** The metric: `41k`; `–` while it has reported no usage (R3-B M1: never a lone `…`). */
export function tokensCell(a: AgentRow): string {
  const n = tokensOf(a)
  return n !== undefined ? tokenText(n) : '–'
}

/**
 * A duration for a table's time cell (R27's words), at most 9 wide so it
 * never meets the tokens column at 49: `14 min`, `1 h 5 min`; where hours
 * and minutes do not fit (`1 h 48 min`) the minutes alone, `108 min` (M3:
 * R27's words, never `1h 48m`). R3-B M5: `room` is wider than 9 where no tokens column
 * stands beside the time (under 46 columns), and then `1 h 48 min` is kept whole.
 */
export function cellTime(ms: number, room = 9): string {
  const s = span(ms)
  if (s.length <= room) return s
  return `${Math.floor(Math.max(0, ms) / 60_000)} min`
}

/** The room a time cell has at `cols` columns: 9 beside the tokens column, the whole of R27's longest form (10) without it. */
export const timeRoom = (cols: number): number => (agentCols(cols).tokens === undefined ? 12 : 9)

/** The time: how long it ran (main: since its first step; '' before it has one). */
export function timeCell(ctx: ViewCtx, a: AgentRow): string {
  if (a.id === 'main') {
    const since = mainSince(ctx)
    return since === undefined ? '' : cellTime(ctx.now - since, timeRoom(ctx.cols))
  }
  const end = a.status === 'running' ? ctx.now : (a.endedAt ?? ctx.now)
  return cellTime(end - a.startedAt, timeRoom(ctx.cols))
}

/**
 * The columns of an agent table (the list's rows, the map): the time ends at
 * the right edge (59 at 62), the tokens 10 before it (49), the map's state
 * word starts 23 before it (36). Narrower panes drop the state under 56
 * columns and the tokens under 46; the time stays.
 */
export function agentCols(cols: number): { left: number; right: number; time: number; tokens?: number; state?: number } {
  const { left, right } = edges(cols)
  return { left, right, time: right, ...(cols >= 46 ? { tokens: right - 10 } : {}), ...(cols >= 56 ? { state: right - 23 } : {}) }
}

/** Scrolls the chat to the call that spawned the agent. A press only; a refusal is toasted. */
export async function chatAgent($: EngineInterface, a: AgentRow): Promise<void> {
  try {
    if (a.spawnStep === undefined) {
      $.ui.toast('Not shown in chat: this agent has no spawn call.')
      return
    }
    const got = await $.ui.scroll({ to: { requestId: a.spawnStep }, block: 'center' })
    if (got.deny !== undefined) $.ui.toast(`Not shown in chat: ${got.deny}`)
  } catch (err) {
    debug($, `agent in chat failed: ${errText(err)}`)
    $.ui.toast(`Not shown in chat: ${errText(err)}`)
  }
}

/** `s: steps  v: transcript  g: chat` (main has no transcript view and no spawn call: `s: steps`). */
export function agentActions($: EngineInterface, a: AgentRow): Action[] {
  const steps: Action = {
    hotkey: 's',
    label: 'steps',
    key: `agent-steps-${a.id}`,
    onPress: () => updateUi($, u => ({ ...leaveDetail(u), tab: 'timeline', filter: { kind: 'agent', id: a.id } })),
  }
  if (a.id === 'main') return [steps]
  return [
    steps,
    { hotkey: 'v', label: 'transcript', key: `agent-view-${a.id}`, onPress: () => viewAgent($, a.id) },
    { hotkey: 'g', label: 'chat', key: `agent-chat-${a.id}`, onPress: () => chatAgent($, a) },
  ]
}

/** A row `n`/`p` can jump to: its element key, and the `agentOpen` value that marks the cursor on it. */
export type Jump = { key: string; open: string }

/**
 * `n` (dir 1) and `p` (dir -1): the next or previous `!` row after the one
 * `ui.agentOpen` marks (the first, or the last, when none is), wrapping. It
 * opens an agent's row and moves the focus ring onto the row. A press only.
 */
export async function jumpToProblem($: EngineInterface, targets: Jump[], dir: 1 | -1): Promise<void> {
  if (targets.length === 0) return
  try {
    const u = await readUi($)
    const at = targets.findIndex(t => t.open === u.agentOpen)
    const i = at < 0 ? (dir === 1 ? 0 : targets.length - 1) : (at + dir + targets.length) % targets.length
    const target = targets[i]!
    await updateUi($, cur => ({ ...cur, agentOpen: target.open }))
    await $.ui.focus({ requestId: PANE_ID, key: target.key })
  } catch (err) {
    debug($, `jump to problem failed: ${errText(err)}`)
  }
}
/** What a pod's state is called on a row's facts line and on the agent page. */
export const STATE_WORD: Record<PodState, string> = {
  queued: 'queued',
  working: 'working',
  waiting: 'waiting',
  stalled: 'stalled',
  failed: 'failed',
  done: 'done',
}

// ---------- the agent page's data: files, and the answer ----------

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Full paths and answers read from the journal on a press: a view may not read the disk, so the page draws what has arrived. */
const stepPaths = new Map<string, string>()
const answers = new Map<string, string>()
const CACHE_MAX = 400

function remember(m: Map<string, string>, k: string, v: string): void {
  if (m.size >= CACHE_MAX && !m.has(k)) {
    const oldest = m.keys().next().value
    if (oldest !== undefined) m.delete(oldest)
  }
  m.set(k, v)
}

/** One file an agent touched: its path as far as is known, whether it only read it, and how many steps did. */
export type AgentFile = { path: string; read: boolean; times: number; image: boolean }

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i
export const isImage = (path: string): boolean => IMAGE.test(path)

const tailOf = (label: string, tool: string): string => (label.startsWith(`${tool} `) ? label.slice(tool.length + 1) : label)
const slashed = (p: string): string => p.replace(/\\/g, '/')

/**
 * The files an agent read or edited, newest first, from its steps. A path is
 * the full one from the step's input (a running step keeps it; a finished
 * step's is read from the journal when the agent's page is opened and kept
 * here), else a changed path that ends with the label's two segments, else
 * the label's own.
 */
export function agentFiles(t: Timeline, agentId: string): AgentFile[] {
  const out = new Map<string, AgentFile & { seq: number }>()
  for (const s of t.steps) {
    if (s.agent !== agentId || !FILE_TOOLS.has(s.tool)) continue
    const tail = tailOf(s.label, s.tool)
    const known = s.pending !== undefined ? pathsOf(s.tool, s.pending)[0] : undefined
    const matched = tail === '' ? undefined : t.changed.find(c => slashed(c) === slashed(tail) || slashed(c).endsWith(`/${slashed(tail)}`))
    const path = known ?? stepPaths.get(s.id) ?? matched ?? tail
    if (path === '') continue
    const read = s.tool === 'Read'
    const cur = out.get(path)
    if (cur === undefined) out.set(path, { path, read, times: 1, image: isImage(path), seq: s.seq })
    else {
      cur.times += 1
      cur.read = cur.read && read
      cur.seq = Math.max(cur.seq, s.seq)
    }
  }
  return [...out.values()].sort((a, b) => b.seq - a.seq).map(({ seq: _seq, ...f }) => f)
}

/** The agent's full answer once the journal has given it (the text of the call that spawned it), else undefined. */
export function answerOf(agentId: string): string | undefined {
  return answers.get(agentId)
}

const LOAD_STEPS = 120

/**
 * Reads what the agent's page shows from the journal: the full path of each
 * file step and the spawn call's text (the agent's answer). From a press
 * (the page's opening); then writes the pane's state again so it redraws.
 * Never throws.
 */
export async function primeAgentPage($: EngineInterface, agentId: string): Promise<void> {
  try {
    const t = await readTimeline($)
    const a = t.agents[agentId]
    if (a === undefined) return
    const journal = await journalOf($, t)
    let got = false
    if (a.spawnStep !== undefined && !answers.has(a.id)) {
      const body = await readBody($, journal, a.spawnStep)
      if (body !== undefined && body.text.trim() !== '') {
        remember(answers, a.id, body.text)
        got = true
      }
    }
    const steps = t.steps.filter(s => s.agent === agentId && FILE_TOOLS.has(s.tool) && !stepPaths.has(s.id)).slice(-LOAD_STEPS)
    for (const s of steps) {
      const body = await readBody($, journal, s.id)
      const p = body !== undefined ? pathsOf(s.tool, body.input)[0] : undefined
      if (p !== undefined) {
        remember(stepPaths, s.id, p)
        got = true
      }
    }
    if (got) await updateUi($, u => ({ ...u }))
  } catch (err) {
    debug($, `prime agent page failed: ${errText(err)}`)
  }
}

/** Opens the agent's page (`ui.page`), from the row keyed `from`, and starts reading what it shows. A press only. */
export async function openAgentPage($: EngineInterface, agentId: string, from?: string): Promise<void> {
  await openPage($, 'agent', agentId, from)
  await primeAgentPage($, agentId)
}

// ---------- what the cockpit's list and map read of an agent ----------

/** The newest running step of an agent. */
export function runningStep(t: Timeline, agent: string): Step | undefined {
  let out: Step | undefined
  for (const s of t.steps) if (s.agent === agent && s.status === 'running' && (out === undefined || s.seq > out.seq)) out = s
  return out
}

/** The first non-blank line of a text, whitespace collapsed. */
const firstLine = (text: string | undefined): string => (text ?? '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(l => l !== '') ?? ''

/**
 * Why a failed agent stopped, in one sentence: "Stopped: <what it said>",
 * from its result, else the step that failed last, else what it was doing;
 * "Stopped by an error" when the timeline holds no words for it.
 */
export function failReason(t: Timeline, a: AgentRow): string {
  let said = firstLine(a.result)
  if (said === '') {
    const failed = t.steps.filter(s => s.agent === a.id && s.status === 'error').sort((x, y) => y.seq - x.seq)[0]
    said = failed !== undefined ? `${firstLine(failed.label)} failed` : firstLine(a.doing)
  }
  return said === '' ? 'Stopped by an error' : `Stopped: ${said.replace(/^stopped:?\s*/i, '')}`
}

/**
 * What the person unfolded on the map and the list, kept in `ui.folded`
 * beside the fold keys older versions wrote: `open:<key>` for one branch or
 * chip, `open:all` for every folded group (`d`). Done groups are folded by
 * default, so a key here means "show them".
 */
export const OPEN_ALL = 'open:all'
export const isOpen = (folded: readonly string[], key: string): boolean => folded.includes(OPEN_ALL) || folded.includes(`open:${key}`)
export const hasOpen = (folded: readonly string[]): boolean => folded.some(k => k.startsWith('open:'))

/** Unfolds or folds one group (a key already shown by `open:all` has nothing to fold). */
export function toggleOpen<U extends { folded: string[] }>(u: U, key: string): U {
  const k = `open:${key}`
  return { ...u, folded: u.folded.includes(k) ? u.folded.filter(x => x !== k) : [...u.folded, k].slice(-200) }
}

/** `d`: unfold every done group, or fold them all again. */
export function toggleAllOpen<U extends { folded: string[] }>(u: U): U {
  return { ...u, folded: hasOpen(u.folded) ? u.folded.filter(k => !k.startsWith('open:')) : [...u.folded, OPEN_ALL].slice(-200) }
}
