import type { AgentKey, NotifyMode, Step, Timeline, UiState } from '../../types'
import { oneLine } from './label'
import {
  ASK_MS, FAILED_TURN_MS, NOTIFY_ASK_MS, QUIET_BOLD_MS, QUIET_MS, QUIET_SHOW_MS, STALL_FACTOR, STALL_MIN_MS, WATCH_NOTIFY_MS,
} from './limits'
import { median, notifies, runLevel, runLimits, usualMs } from './meter'
import type { RunLimits } from './meter'
import { todoBlock } from './todo'

// The alert model (R1 to R10): what blocks the session on the person (needs),
// what is worth a glance but asks nothing (watch), and the header's state.
// Pure: each selector reads the Timeline and a time, and never changes them.
//
// Needs: the session is blocked on a dialog (permission, question, plan,
// MCP input). Watch: stalled, quiet, long run, repeat, loop; dim, never the
// band's lead, never autoFocus, never a notification unless `watchNotify`.
// A failed turn is neither: the header takes it (R8).

const SPAWNING_TOOLS = new Set(['Agent', 'Task', 'Workflow'])
/** Tools whose running step is itself a dialog waiting on the person. */
const DIALOG_TOOLS: Record<string, NeedKind> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const MIN = 60_000

// ---- Words -------------------------------------------------------------------------

/** R27 for a sentence: `45s`, `12 min`, `1 h 12 min` (`2 h` on the hour). */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

/** Friendly case for an agent type (R23): `general-purpose` General, `Explore` Explorer, `code-reviewer` Code reviewer. */
const KNOWN_TYPES: Record<string, string> = {
  'general-purpose': 'General', explore: 'Explorer', plan: 'Planner', main: 'Claude',
}

/** The name a sentence gives an agent: `Claude` for the lead, its type in friendly case for a subagent, `An agent` when it has none. */
export function agentName(t: Timeline, agent: AgentKey): string {
  if (agent === 'main') return 'Claude'
  const type = oneLine(t.agents[agent]?.type ?? '')
  if (type === '' || type === 'unknown') return 'An agent'
  const known = KNOWN_TYPES[type.toLowerCase()]
  if (known !== undefined) return known
  const words = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean).map((w) => w.toLowerCase())
  if (words.length === 0) return 'An agent'
  const first = words[0]!
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ')
}

/** A step's label without its leading tool name: the command, the file, the input. */
export function commandOf(step: Pick<Step, 'tool' | 'label'>): string {
  const label = oneLine(step.label)
  if (label === step.tool) return ''
  return label.startsWith(`${step.tool} `) ? label.slice(step.tool.length + 1) : label
}

/** The last part of an MCP tool's name (`mcp__server__tool_name` → `tool name`); any other tool as it is. */
function toolWord(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const last = tool.split('__').filter(Boolean).at(-1) ?? tool
  return last.replace(/[_-]+/g, ' ')
}

/** What a permission asks, after its asker: "asks to run a command". */
export function permissionVerb(tool: string): string {
  if (SHELL_TOOLS.has(tool)) return 'asks to run a command'
  if (EDIT_TOOLS.has(tool)) return 'asks to edit a file'
  if (tool === 'Write') return 'asks to write a file'
  if (tool === 'WebFetch') return 'asks to fetch a page'
  if (tool === 'WebSearch') return 'asks to search the web'
  if (tool === 'Agent' || tool === 'Task') return 'asks to start an agent'
  if (tool === 'Workflow') return 'asks to start a workflow'
  return `asks to use ${toolWord(tool)}`
}

// ---- Needs (R1 to R5) ----------------------------------------------------------------

export type NeedKind = 'permission' | 'question' | 'plan' | 'input'
export type Need = {
  key: string                // `asking:<stepId>` (permission, question, plan) or `input:<id>`
  kind: NeedKind
  agent: AgentKey            // who asks
  since: number              // when the dialog was raised
  stepId?: string
  tool?: string              // the tool asked for (permission, question, plan)
  command?: string           // its command, file or input on one line ('' when it has none)
  asker: string              // agentName of the asker, or the MCP server for input
  askerAmbiguous: boolean    // two running steps share the asking step's tool and input: do not name the asker in bold (R4)
  who: string                // the sentence's subject: the asker, or "An agent" when ambiguous
  verb: string               // "asks to run a command", "asks you a question", "has a plan for you to approve", "asks for input"
  sentence: string           // who + verb
  message?: string           // input only: the server's message
}
/**
 * What the needs slot shows: the needs; whether a permission is still being
 * checked (R2: draw no tick, a dim "Checking a permission"); and, only with
 * no pane watching, the permissions past their first NOTIFY_ASK_MS whose
 * answer nothing can see (`asked`: the band draws them dim, "asked to run a
 * command · running"; R2 amendment). `asked` is left out when empty.
 */
export type NeedsView = { items: Need[]; checking: boolean; asked?: Need[] }
export type NeedsOptions = {
  /** The pane's `isPromptCovered`: a dialog may hold the keys, so an ask is real at once. The band has no such prop: it passes the pane's observed cover. */
  covered?: boolean
  /**
   * Whether the terminal pane watches the prompt (it drew lately), so the
   * clock settles an ask it saw answered (`answeredAsks`, `settledAsks`).
   * Only `false` changes anything: the band with no pane watching, where a
   * permission outside auto mode is a need for its first NOTIFY_ASK_MS and
   * then `asked`, and an auto-mode one is checked for ASK_MS and then
   * `asked`. Pane views leave it out (they are the watcher).
   */
  watching?: boolean
}

export const CHECKING_TEXT = 'Checking a permission'

function sameCall(t: Timeline, step: Step): boolean {
  return t.steps.some((s) => s !== step && s.status === 'running' && s.tool === step.tool && s.sig !== undefined && s.sig === step.sig)
}

function stepNeed(t: Timeline, s: Step, kind: NeedKind, since: number): Need {
  const ambiguous = s.agent !== 'main' && sameCall(t, s)
  const asker = agentName(t, s.agent)
  const who = ambiguous ? 'An agent' : asker
  const verb = kind === 'question' ? 'asks you a question' : kind === 'plan' ? 'has a plan for you to approve' : permissionVerb(s.tool)
  return {
    key: `asking:${s.id}`, kind, agent: s.agent, since, stepId: s.id, tool: s.tool, command: commandOf(s),
    asker, askerAmbiguous: ambiguous, who, verb, sentence: `${who} ${verb}`,
  }
}

/**
 * What blocks the session on the person, oldest first:
 * - a running step a permission request was raised for (`asking`): a question
 *   for AskUserQuestion, a plan for ExitPlanMode, else a permission;
 * - a running AskUserQuestion or ExitPlanMode step: its dialog is open;
 * - an open MCP input request (elicitation).
 * A permission raised in auto mode is a need only while the prompt is
 * covered (a dialog holds it): uncovered, the classifier may still be
 * deciding or may have allowed it, so it is `checking` (C-1). The clock
 * takes it off once the pane watched it uncovered for ASK_MS (`settledAsks`).
 * With `watching: false` (no pane can see an answer), a permission becomes
 * `asked` after NOTIFY_ASK_MS (ASK_MS in auto mode): never amber for longer
 * than a waiting dialog takes to be noticed. Agent and Workflow asks clear
 * when their agent spawns, so they stay as they are.
 */
export function needs(t: Timeline, now: number, o: NeedsOptions = {}): NeedsView {
  const items: Need[] = []
  const asked: Need[] = []
  let checking = false
  const blind = o.watching === false && o.covered !== true
  for (const s of t.steps) {
    if (s.status !== 'running') continue
    const dialog = DIALOG_TOOLS[s.tool]
    if (dialog !== undefined) {
      items.push(stepNeed(t, s, dialog, s.asking ?? s.startedAt))
      continue
    }
    if (s.asking === undefined) continue
    const exact = SPAWNING_TOOLS.has(s.tool)
    if (t.autoAsk === true && o.covered !== true) {
      if (blind && !exact && now - s.asking >= ASK_MS) asked.push(stepNeed(t, s, 'permission', s.asking))
      else checking = true
      continue
    }
    if (blind && !exact && now - s.asking >= NOTIFY_ASK_MS) {
      asked.push(stepNeed(t, s, 'permission', s.asking))
      continue
    }
    items.push(stepNeed(t, s, 'permission', s.asking))
  }
  for (const a of t.asks ?? []) {
    items.push({
      key: `input:${a.id}`, kind: 'input', agent: a.agent, since: a.at, asker: a.server, askerAmbiguous: false,
      who: a.server, verb: 'asks for input', sentence: `${a.server} asks for input`, message: a.message,
    })
  }
  const order = (a: Need, b: Need) => a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  items.sort(order)
  const view: NeedsView = { items, checking: checking && items.length === 0 }
  if (asked.length > 0) view.asked = asked.sort(order)
  return view
}

/** An asked permission's words in the past, for the band's dim line: "asked to run a command". */
export function askedVerb(n: Pick<Need, 'verb'>): string {
  return n.verb.replace(/^asks\b/, 'asked')
}

/**
 * The permission asks the person answered while the pane watched (F C1):
 * steps still running and still marked `asking` whose dialog the pane saw
 * covering the prompt (`coveredAt`: by step id, the number of the drawing
 * that saw it) and, in a later drawing, saw gone (`uncoveredAt`: the number
 * of the latest drawing without `isPromptCovered`). The clock
 * takes each off the Timeline with `step.unask`; the band, the cards and the
 * notifications then follow it. Pure.
 */
export function answeredAsks(t: Timeline, coveredAt: ReadonlyMap<string, number>, uncoveredAt: number | undefined): string[] {
  if (uncoveredAt === undefined || coveredAt.size === 0) return []
  const out: string[] = []
  for (const s of t.steps) {
    if (s.status !== 'running' || s.asking === undefined || DIALOG_TOOLS[s.tool] !== undefined) continue
    const at = coveredAt.get(s.id)
    if (at !== undefined && uncoveredAt > at) out.push(s.id)
  }
  return out
}

/**
 * The permission asks the pane saw settled without a dialog (C-1, R2
 * amendment): steps still running and still marked `asking` (not a
 * question or plan) while the pane has watched the prompt uncovered, in one
 * unbroken run of drawings since `clearSince`, for ASK_MS from the ask or
 * from the start of that run, whichever is later. A permission that waits
 * on the person covers the prompt with its dialog, so an ask the pane saw
 * uncovered that long was settled by the classifier (auto mode) or answered
 * before the pane looked. Pure; the clock applies `step.unask`.
 */
export function settledAsks(t: Timeline, now: number, clearSince: number | undefined): string[] {
  if (clearSince === undefined) return []
  const out: string[] = []
  for (const s of t.steps) {
    if (s.status !== 'running' || s.asking === undefined || DIALOG_TOOLS[s.tool] !== undefined) continue
    if (now - Math.max(s.asking, clearSince) >= ASK_MS) out.push(s.id)
  }
  return out
}

// ---- Watch (R6) --------------------------------------------------------------------------

export type WatchKind = 'stalled' | 'long-step' | 'quiet' | 'long-run' | 'repeat' | 'loop'
export type Watch = {
  key: string                // stable per thing watched; with `count`, the dismiss key (`dismissKey`)
  kind: WatchKind
  agent: AgentKey
  since: number              // when it began to qualify
  who: string                // agentName, or "This turn" for the lead's long turn
  sentence: string           // the row's words after the kind
  stepId?: string
  command?: string
  count?: number             // repeat and loop: the runs counted
  ranMs?: number             // stalled, long-step and long-run: how long it has run; quiet: how long without activity
  limitMs?: number           // long-run: the limit it passed
  usualMs?: number           // long-run: the median of finished agents of its type
}

/** Tools whose runs repeat as a matter of course: three in a turn are a loop only when one failed. */
const ROUTINE_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
])
/** Steps that run as long as something else does (an agent, a dialog): never stalled on their own. */
const NO_STALL_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'AskUserQuestion', 'ExitPlanMode'])

/**
 * A step's call signature: its tool and its `sig`, the hash of its normalised
 * input (`Bash:1x2y3z`). A step without a sig (stored by an earlier version)
 * falls back to its label without the leading tool name (`Bash:npm test`).
 */
export function signatureOf(step: Step): string {
  if (typeof step.sig === 'string' && step.sig !== '') return `${step.tool}:${step.sig}`
  return `${step.tool}:${commandOf(step)}`
}

const endOf = (s: Step): number => s.endedAt ?? s.startedAt

/** The failures since a signature's newest success, newest first; running, denied and interrupted runs are passed over. */
function trailingFailures(runs: Step[]): Step[] {
  const out: Step[] = []
  for (const s of [...runs].sort((a, b) => b.seq - a.seq)) {
    if (s.status === 'done') break
    if (s.status === 'error') out.push(s)
  }
  return out
}

function groupBy(steps: Step[], keyOf: (s: Step) => string | undefined): Map<string, Step[]> {
  const out = new Map<string, Step[]>()
  for (const s of steps) {
    const k = keyOf(s)
    if (k === undefined) continue
    const list = out.get(k)
    if (list) list.push(s)
    else out.set(k, [s])
  }
  return out
}

/**
 * The median run time of the finished (done or error) earlier runs of each
 * call signature in this session (R41): `npm test` is measured against
 * `npm test`, never against every Bash call.
 */
function signatureMedians(t: Timeline): Map<string, number> {
  const times = new Map<string, number[]>()
  for (const s of t.steps) {
    if ((s.status !== 'done' && s.status !== 'error') || s.endedAt === undefined) continue
    const sig = signatureOf(s)
    const list = times.get(sig)
    if (list) list.push(s.endedAt - s.startedAt)
    else times.set(sig, [s.endedAt - s.startedAt])
  }
  const out = new Map<string, number>()
  for (const [sig, list] of times) out.set(sig, median(list)!)
  return out
}

/** A run time in a long-run sentence (M2): whole minutes under 2 h, so it reads beside the limit (`64 min (limit 60)`); `2 h 5 min` from there. */
function runText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN)
  return m >= 1 && m < 120 ? `${m} min` : spanText(ms)
}

/** The key a dismissal stores for a watch row (or a problem): its key, and its count when it has one, so a grown count is new. */
export function dismissKey(p: { key: string; count?: number }): string {
  return p.count === undefined ? p.key : `${p.key}#${p.count}`
}

function withCommand(who: string, command: string, rest: string): string {
  return command !== '' ? `${who}: ${command} ${rest}` : `${who}: ${rest}`
}

/**
 * What is worth a glance and asks nothing, newest first (by `since`):
 * - `stalled`: one running step past STALL_MIN_MS and past STALL_FACTOR times
 *   the median of the earlier finished runs of its call signature (R41);
 *   never a step that is a need, nor an Agent, Workflow or dialog step;
 * - `long-step`: such a step past STALL_MIN_MS with no earlier run of its
 *   signature to measure against (R41): a glance, never a notification;
 * - `quiet`: a running loop (the lead's open turn, or a subagent) with no step
 *   running and no activity for QUIET_MS (it may be thinking); the lead is not
 *   quiet while a subagent runs;
 * - `long-run`: a running subagent past `agentLimitMin`, or the open main turn
 *   past `turnLimitMin` (60 and 120 by default; 0 is off);
 * - `repeat`: one signature's newest runs ended `error` twice or more in a row;
 * - `loop`: one signature ran three times or more in one turn, unless it is a
 *   repeat, or its tool is routine and none of those runs failed.
 * An agent that is only thinking, under QUIET_MS, is neither a need nor a row.
 * A row whose `dismissKey` is in `dismissed` is left out; a repeat or loop
 * comes back once its count grows.
 */
export function watch(t: Timeline, now: number, dismissed: readonly string[] = [], limits?: RunLimits): Watch[] {
  const out: Watch[] = []
  const running = (agent: AgentKey) => agent === 'main' || t.agents[agent]?.status === 'running'

  // Stalled steps (with earlier runs of the same call to measure against), else long steps (R41).
  const medians = signatureMedians(t)
  for (const s of t.steps) {
    if (s.status !== 'running' || s.asking !== undefined || NO_STALL_TOOLS.has(s.tool) || !running(s.agent)) continue
    const ran = now - s.startedAt
    const median = medians.get(signatureOf(s))
    const limit = median === undefined ? STALL_MIN_MS : Math.max(STALL_MIN_MS, STALL_FACTOR * median)
    if (ran <= limit) continue
    const kind: WatchKind = median === undefined ? 'long-step' : 'stalled'
    const who = agentName(t, s.agent)
    const command = commandOf(s) || s.tool
    out.push({
      key: `${kind}:${s.id}`, kind, agent: s.agent, since: s.startedAt + limit, who, stepId: s.id, command, ranMs: ran,
      sentence: withCommand(who, command, `has run ${spanText(ran)}`),
    })
  }

  // Quiet loops.
  const liveSubs = Object.values(t.agents).filter((a) => a.id !== 'main' && a.status === 'running')
  const lastOf = new Map<AgentKey, number>()
  const busy = new Set<AgentKey>()
  for (const s of t.steps) {
    if (s.status === 'running') busy.add(s.agent)
    lastOf.set(s.agent, Math.max(lastOf.get(s.agent) ?? 0, endOf(s), s.startedAt))
  }
  const quiet = (agent: AgentKey, from: number) => {
    if (busy.has(agent)) return
    const last = Math.max(from, lastOf.get(agent) ?? 0)
    if (now - last <= QUIET_MS) return
    const who = agentName(t, agent)
    const ms = now - last
    out.push({ key: `quiet:${agent}:${last}`, kind: 'quiet', agent, since: last + QUIET_MS, who, ranMs: ms, sentence: `${who}: no activity for ${spanText(ms)}, may be thinking` })
  }
  const turn = [...t.turns].reverse().find((x) => x.agent === 'main')
  if (turn !== undefined && turn.endedAt === undefined && liveSubs.length === 0) quiet('main', turn.startedAt)
  for (const a of liveSubs) quiet(a.id, Math.max(a.startedAt, a.lastStepAt ?? 0))

  // Long runs.
  const { agentLimitMin, turnLimitMin } = runLimits(limits)
  for (const a of liveSubs) {
    const ran = now - a.startedAt
    if (runLevel(ran, agentLimitMin) !== 'over') continue
    const limitMs = agentLimitMin * MIN
    const who = agentName(t, a.id)
    const usual = usualMs(t, a.type)
    const w: Watch = {
      key: `long-run:${a.id}`, kind: 'long-run', agent: a.id, since: a.startedAt + limitMs, who, ranMs: ran, limitMs,
      sentence: `${who} has run ${runText(ran)} (limit ${agentLimitMin})${usual !== undefined ? `, usually ${spanText(usual)}` : ''}`,
    }
    if (usual !== undefined) w.usualMs = usual
    out.push(w)
  }
  if (turn !== undefined && turn.endedAt === undefined && runLevel(now - turn.startedAt, turnLimitMin) === 'over') {
    const limitMs = turnLimitMin * MIN
    const ran = now - turn.startedAt
    out.push({
      key: `long-run:turn:${turn.id}`, kind: 'long-run', agent: 'main', since: turn.startedAt + limitMs, who: 'This turn', ranMs: ran, limitMs,
      sentence: `This turn has run ${runText(ran)} (limit ${turnLimitMin})`,
    })
  }

  // Repeats and loops.
  const repeats = new Set<string>()
  for (const [sig, list] of groupBy(t.steps, signatureOf)) {
    const failed = trailingFailures(list)
    if (failed.length < 2) continue
    repeats.add(sig)
    const last = failed[0]!
    const first = failed[failed.length - 1]!
    const who = agentName(t, last.agent)
    const command = commandOf(last) || last.tool
    out.push({
      key: `repeat:${sig}:${first.id}`, kind: 'repeat', agent: last.agent, since: endOf(last), who, stepId: last.id, command, count: failed.length,
      sentence: withCommand(who, command, `failed ${failed.length} times in a row`),
    })
  }
  const inTurn = groupBy(t.steps, (s) => {
    if (s.turnId === undefined) return undefined
    const sig = signatureOf(s)
    return repeats.has(sig) ? undefined : JSON.stringify([s.turnId, sig])
  })
  for (const list of inTurn.values()) {
    if (list.length < 3) continue
    if (ROUTINE_TOOLS.has(list[0]!.tool) && !list.some((s) => s.status === 'error')) continue
    const last = list.reduce((a, b) => (b.seq >= a.seq ? b : a))
    const who = agentName(t, last.agent)
    const command = commandOf(last) || last.tool
    out.push({
      key: `loop:${last.turnId}:${signatureOf(last)}`, kind: 'loop', agent: last.agent, since: last.startedAt, who, stepId: last.id, command, count: list.length,
      sentence: withCommand(who, command, `ran ${list.length} times this turn`),
    })
  }

  const gone = new Set(dismissed)
  return out.filter((w) => !gone.has(dismissKey(w))).sort((a, b) => b.since - a.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// ---- Header (R7, R8, R12) ---------------------------------------------------------------

export type HeaderKind = 'working' | 'waiting' | 'stopped' | 'idle' | 'idle-open' | 'all-done'
export type HeaderState = {
  state: HeaderKind
  /** The open main turn's time so far; absent when no main turn runs. */
  turnMs?: number
  /** Time since the session's last activity (a step, a turn, an agent), while working with no step running (R6, R7). */
  quietMs?: number
  /** How the header draws the quiet time (R7): not at all under QUIET_SHOW_MS, dim, then bold past QUIET_BOLD_MS. */
  quiet: 'none' | 'dim' | 'bold'
  /** stopped: why ("Stopped by an error", the reason in red). */
  reason?: string
  /** Tasks of the lead's list still open (idle-open: "Stopped with 3 to do open"). */
  open: number
}

function lastActivity(t: Timeline): number {
  let last = 0
  for (const s of t.steps) last = Math.max(last, endOf(s), s.startedAt)
  for (const x of t.turns) last = Math.max(last, x.endedAt ?? x.startedAt)
  for (const a of Object.values(t.agents)) last = Math.max(last, a.endedAt ?? 0, a.lastStepAt ?? 0, a.startedAt)
  return last
}

/**
 * The header's state, in this order: waiting (a need is up), working (the
 * main turn, a subagent or a step runs), stopped (the newest main turn failed;
 * not one the person interrupted), idle-open (the turn ended with lead tasks
 * open: no ALL DONE), all-done (the lead's list is complete), else idle.
 */
export function headerState(t: Timeline, now: number, view: NeedsView): HeaderState {
  const list = todoBlock(t)
  const turn = [...t.turns].reverse().find((x) => x.agent === 'main')
  const base = { open: list.open, quiet: 'none' as const }
  // R6/R7 (I-3): quiet only while no step runs in any loop; a long build is a Watch row, never "quiet".
  const stepRunning = t.steps.some((s) => s.status === 'running')
  const working = (turn !== undefined && turn.endedAt === undefined) ||
    stepRunning ||
    Object.values(t.agents).some((a) => a.id !== 'main' && a.status === 'running')
  const timing = (): Pick<HeaderState, 'turnMs' | 'quietMs' | 'quiet'> => {
    const quietMs = Math.max(0, now - lastActivity(t))
    const out: Pick<HeaderState, 'turnMs' | 'quietMs' | 'quiet'> = stepRunning
      ? { quiet: 'none' }
      : { quietMs, quiet: quietMs >= QUIET_BOLD_MS ? 'bold' : quietMs >= QUIET_SHOW_MS ? 'dim' : 'none' }
    if (turn !== undefined && turn.endedAt === undefined) out.turnMs = Math.max(0, now - turn.startedAt)
    return out
  }
  if (view.items.length > 0) return { ...base, state: 'waiting', ...(working ? timing() : {}) }
  if (working) return { ...base, state: 'working', ...timing() }
  if (turn !== undefined && turn.failed === true && turn.aborted !== true) {
    const reason = t.failure?.turnId === turn.id ? t.failure.reason : 'An API error ended the turn'
    return { ...base, state: 'stopped', reason }
  }
  if (turn !== undefined && list.open > 0) return { ...base, state: 'idle-open' }
  if (!list.empty && list.open === 0) return { ...base, state: 'all-done' }
  return { ...base, state: 'idle' }
}

// ---- autoFocus ------------------------------------------------------

/** Whether a row of this kind may take the pane's focus on its own: needs only, never a watch row. */
export function autoFocuses(kind: NeedKind | WatchKind | 'failed-turn'): boolean {
  return kind === 'permission' || kind === 'question' || kind === 'plan' || kind === 'input'
}

// ---- Notifications (R8, R10) ------------------------------------------------------------

export type AlertNote = { id: string; text: string }
export type AlertOptions = {
  mode?: NotifyMode; watchNotify?: boolean; limits?: RunLimits; freshMs: number
  /**
   * Whether the pane is watching the prompt: it drew on the terminal lately,
   * so an ask the person answered was taken off the Timeline (`step.unask`)
   * when the pane saw its dialog close. Without it the model cannot tell an
   * answered permission from a waiting one.
   */
  watching?: boolean
  /** The pane's observed cover (`paneCovered`): a dialog holds the prompt, so an auto-mode ask is real (C-1). */
  covered?: boolean
}

/**
 * The notifications the clock raises now, each once by id (`u.notified`):
 * - a need (with `waits` or more; an auto-mode permission only while the
 *   pane sees its dialog, `covered`), once it has waited ASK_MS on Agent or
 *   Workflow and NOTIFY_ASK_MS on any other tool or dialog (a real dialog
 *   raises Claude Code's own notification first). A permission on any tool
 *   but Agent and Workflow notifies only while the pane is `watching`: with
 *   no pane nothing clears an answered ask before its step ends, and the
 *   engine notifies for a dialog that really waits. An Agent or Workflow ask
 *   clears when its agent spawns, and a question, plan or input need lasts
 *   exactly as long as its dialog, so those notify either way;
 * - a turn that failed within `freshMs` (with `all`; R8);
 * - a watch row that has stood WATCH_NOTIFY_MS, only with `watchNotify` (R10),
 *   and never a `long-step` row (R41).
 * Never a watch row otherwise.
 */
export function alertNotes(t: Timeline, u: Pick<UiState, 'notified' | 'dismissed'>, now: number, o: AlertOptions): AlertNote[] {
  const mode = o.mode ?? 'waits'
  const out: AlertNote[] = []
  const seen = new Set(u.notified)
  if (notifies(mode, 'wait')) {
    const gone = new Set(u.dismissed)
    for (const n of needs(t, now, { covered: o.covered === true }).items) {
      const id = n.stepId ?? n.key
      // The views still offer `x` on an ask until wave 2: a dismissed one is not raised.
      if (seen.has(id) || gone.has(n.key)) continue
      const spawns = n.tool !== undefined && SPAWNING_TOOLS.has(n.tool)
      if (n.kind === 'permission' && !spawns && o.watching !== true) continue
      const wait = spawns ? ASK_MS : NOTIFY_ASK_MS
      if (now - n.since < wait) continue
      const what = n.kind === 'permission' && n.command !== undefined && n.command !== '' ? `${n.tool} ${n.command}` : n.sentence
      out.push({ id, text: `Waiting on you: ${oneLine(what)}` })
    }
  }
  if (notifies(mode, 'failed')) {
    for (const x of t.turns) {
      if (x.failed !== true || x.aborted === true || x.endedAt === undefined || now - x.endedAt > Math.min(o.freshMs, FAILED_TURN_MS)) continue
      const id = `failed-turn:${x.id}`
      if (!seen.has(id)) out.push({ id, text: `Turn failed: ${oneLine(x.prompt)}` })
    }
  }
  if (o.watchNotify === true) {
    for (const w of watch(t, now, u.dismissed, o.limits)) {
      const id = `watch:${dismissKey(w)}`
      if (w.kind === 'long-step' || seen.has(id) || now - w.since < WATCH_NOTIFY_MS) continue
      out.push({ id, text: `Watch: ${w.sentence}` })
    }
  }
  return out
}
