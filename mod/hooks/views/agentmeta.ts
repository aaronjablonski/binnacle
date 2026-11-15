import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRow, Step } from '../../types'
import { problems } from '../model/select'
import { debug, errText, leaveDetail, readUi, updateUi } from '../state'
import { modelName, tokenText } from './budget'
import { clock, elapsed } from './fit'
import { opened, row, viewAgent } from './parts'
import type { Action, Detail, Flag, Run } from './parts'
import type { ViewCtx } from './shell'
import { podOf, roleOf } from './style'
import type { PodState } from './style'

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

/** Opens the agent's row in place, or closes it when it is the open one. */
export async function toggleOpen($: EngineInterface, id: string): Promise<void> {
  await updateUi($, u => {
    if (u.agentOpen === id) {
      const { agentOpen: _open, ...rest } = u
      return rest
    }
    return { ...u, agentOpen: id }
  })
}

/**
 * The pod states the model's problems give an agent: `asking` is `waiting`
 * (signal `?`), `stalled:<id>` is `stalled` (signal `z`); asking wins. Other
 * agents follow their status (failed shows `!`). A dismissed problem gives none.
 */
export function podStates(ctx: ViewCtx): Map<string, PodState> {
  const out = new Map<string, PodState>()
  for (const p of problems(ctx.t, ctx.now, ctx.u.dismissed)) {
    if (p.kind === 'asking') out.set(p.agent, 'waiting')
    else if (p.kind === 'stalled' && out.get(p.agent) !== 'waiting') out.set(p.agent, 'stalled')
  }
  return out
}

/** `row`'s gutter Text (its first child) redrawn as the pod's signal: `?` or `z` (`row` itself only knows `!`). */
function withGutter(el: RenderElement, s: Run): RenderElement {
  // The element's children sit in `props.children` (JSX) or beside `props` (a drawn tree).
  const box = el as unknown as { props?: { children?: unknown }; children?: unknown }
  const inProps = Array.isArray(box.props?.children)
  const kids = inProps ? box.props?.children : box.children
  if (!Array.isArray(kids)) return el
  const first = kids[0] as { props?: Record<string, unknown>; children?: unknown } | undefined
  if (first === undefined || (first as { type?: unknown }).type !== 'Text') return el
  const text = `${s.text} `
  const style = { color: s.color, ...(s.bold === true ? { bold: true } : {}) }
  const gutter =
    'children' in first
      ? { ...first, props: { ...first.props, ...style }, children: [text] }
      : { ...first, props: { ...first.props, ...style, children: text } }
  const next = [gutter, ...kids.slice(1)]
  return (inProps ? { ...box, props: { ...box.props, children: next } } : { ...box, children: next }) as unknown as RenderElement
}

/** What `row` draws for an agent, and what its press does (open it). */
export type AgentRowOpts = {
  key: string
  /** A problem the pod has no signal for (a repeat or a loop) shows `!`. */
  flag?: Flag
  /** `waiting` or `stalled` (see `podStates`); absent, the pod follows the agent's status. */
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
 * is the gutter flag: `!` (failed), `?` (waiting), `z` (stalled). A press opens it.
 */
export function agentRow(ctx: ViewCtx, $: EngineInterface, a: AgentRow, o: AgentRowOpts): RenderElement {
  const isMain = a.id === 'main'
  const pod = podOf(o.state !== undefined ? { ...a, state: o.state } : a, ctx.now)
  const sig = pod.signal
  const mark = sig !== undefined && sig.text !== '!'
  const flag: Flag | undefined = mark ? undefined : sig !== undefined ? 'problem' : o.flag
  const name = o.name ?? (isMain ? 'main' : a.description !== '' ? a.description : a.type)
  const line = row(ctx, $, {
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
    onPress: () => toggleOpen($, a.id),
  })
  return mark ? withGutter(line, sig) : line
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
async function chatAgent($: EngineInterface, a: AgentRow): Promise<void> {
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
