import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step, Timeline } from '../../types'
import { journalOf, readBody } from '../journal'
import { pathsOf } from '../model/label'
import { debug, errText, leaveDetail, readTimeline, readUi, updateUi } from '../state'
import { modelName, tokenText } from './budget'
import { clock, elapsed } from './fit'
import { opened, row, viewAgent } from './parts'
import type { Action, Detail, Flag, Run } from './parts'
import { openPage } from './pagenav'
import type { ViewCtx } from './shell'
import { podOf, roleOf } from './style'
import type { Pod, PodState } from './style'

export const STEP_GLYPH: Record<Step['status'], string> = {
  running: '·',
  done: '✔',
  error: '✖',
  denied: '⊘',
  interrupted: '◌',
}
/**
 * An agent's row glyph: live in the accent (`statusColor`), a failure in error, done dim.
 * @deprecated Neo draws agents as hulls: `podOf(agent, ctx.now).hull` (style.ts).
 */
export const AGENT_GLYPH: Record<AgentRow['status'], string> = { running: '▸', done: '✓', error: '✖' }
// `main` stays 'running' for the whole session, so it gets no status glyph.
/** @deprecated Neo draws main as the lead's hull: `podOf(main, ctx.now).hull` (style.ts). */
export const MAIN_GLYPH = '◆'
/** A workflow run's row glyph. */
export const RUN_GLYPH = '≡'
export const WORKFLOW_TYPE = 'workflow-subagent'
export const EMPTY = 'No agents yet. Subagents and workflow agents appear here while they run.'

/** The pane's own id: the target of a `$.ui.focus`. */
const PANE_ID = 'mission-control'

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

/** The metric: `41k`; `…` while it runs with no usage yet; `–` when it never reported. */
export function tokensCell(a: AgentRow): string {
  const n = tokensOf(a)
  if (n !== undefined) return tokenText(n)
  return a.status === 'running' ? '…' : '–'
}

/** The time: how long it ran (main: since its first step; '' before it has one). */
export function timeCell(ctx: ViewCtx, a: AgentRow): string {
  if (a.id === 'main') {
    const since = mainSince(ctx)
    return since === undefined ? '' : elapsed(since, ctx.now)
  }
  const end = a.status === 'running' ? ctx.now : (a.endedAt ?? ctx.now)
  return elapsed(a.startedAt, end)
}

/** The gutter flag a pod's signal is: `!` problem, `?` waiting, `z` stalled; none without a signal. */
export function signalFlag(pod: Pod): Flag | undefined {
  const text = pod.signal?.text
  return text === '!' ? 'problem' : text === '?' ? 'waiting' : text === 'z' ? 'stalled' : undefined
}

/** What `row` draws for an agent, and what its press does (open it). */
export type AgentRowOpts = {
  key: string
  /** A problem the pod has no signal for (a repeat or a loop) shows `!`. */
  flag?: Flag
  /** `waiting` or `stalled` (see `waitStates`); absent, the pod follows the agent's status. */
  state?: PodState
  depth?: 0 | 1 | 2
  /** The tethered tree's prefix (`├╌ ╰╌ ┆`), in place of a guide. */
  tether?: { last?: boolean; outer?: boolean }
  /** Replaces the description (a tree row may carry styled runs). */
  name?: string | Run[]
}

/**
 * One agent as a table row: its hull at 2 (`podOf`: shape for the role, fill
 * for the state), description, tokens at 38 and time at 50. The pod's signal
 * is the gutter flag: `!` (failed), `?` (waiting), `z` (stalled). A press opens its page.
 */
export function agentRow(ctx: ViewCtx, $: EngineInterface, a: AgentRow, o: AgentRowOpts): RenderElement {
  const isMain = a.id === 'main'
  const pod = podOf(o.state !== undefined ? { ...a, state: o.state } : a, ctx.now)
  const flag: Flag | undefined = signalFlag(pod) ?? o.flag
  const name = o.name ?? (isMain ? 'main' : a.description !== '' ? a.description : a.type)
  return row(ctx, $, {
    key: o.key,
    glyph: pod.hull.text,
    ...(pod.hull.color !== undefined ? { glyphColor: pod.hull.color } : {}),
    name,
    bold: ctx.u.agentOpen === a.id,
    metric: tokensCell(a),
    time: timeCell(ctx, a),
    ...(flag !== undefined ? { flag } : {}),
    ...(o.depth !== undefined ? { depth: o.depth } : {}),
    ...(o.tether !== undefined ? { tether: o.tether } : {}),
    // Enter on an agent row opens its page (rich rule 4); `b` comes back to the row.
    onPress: () => openAgentPage($, a.id, o.key),
  })
}

/** The `result` (or what it is doing, or did last) and `agent` lines of an opened row. */
export function agentDetails(a: AgentRow): Detail[] {
  const out: Detail[] = []
  if (a.result !== undefined && a.result !== '') out.push({ key: 'result', value: a.result })
  else if (a.doing !== '') out.push({ key: a.status === 'running' ? 'doing' : 'last', value: a.doing })
  const model = a.model !== undefined ? modelName(a.model) : ''
  const kind = a.id === 'main' ? 'main' : a.type
  const role = a.id === 'main' ? 'lead' : roleOf(a.type)
  const parts = [role, ...(kind !== role ? [kind] : []), ...(model !== '' ? [model] : []), `${a.stepCount} steps`]
  if (a.id !== 'main') parts.push(clock(a.startedAt))
  out.push({ key: 'agent', value: parts.join(' · ') })
  return out
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

/** The opened part under an agent's row, or null while it is closed. */
export function agentOpened(ctx: ViewCtx, $: EngineInterface, a: AgentRow): RenderElement | null {
  if (ctx.u.agentOpen !== a.id) return null
  return opened(ctx, $, agentDetails(a), agentActions($, a))
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
  waiting: 'asks permission',
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
