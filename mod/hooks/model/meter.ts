import type { AgentRow, NotifyMode, TaskItem, Timeline, TurnRow } from '../../types'
import {
  AGENT_LIMIT_MIN, CACHE_HOUR_MS, CACHE_TTL_MS, DONE_TURN_MS, PACE_MIN_MS, PACE_MIN_POINTS, PACE_SPAN_MS, TURN_LIMIT_MIN,
} from './limits'

// The distilled features' selectors: pace, the cache line, the task meter,
// roles and long runs, done turns and the turn's cost share. Pure: each reads
// the Timeline (and a time, where it needs one) and never changes it.

const MIN = 60_000
const TEN_MIN = 600_000
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const subagents = (t: Timeline): AgentRow[] => Object.values(t.agents).filter((a) => a.id !== 'main')
const tokensOf = (a: { tokensIn?: number; tokensOut?: number }): number => (a.tokensIn ?? 0) + (a.tokensOut ?? 0)

/** The middle of the values (the mean of the two middle ones for an even count); undefined for none. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

// ---- Pace -----------------------------------------------------------------------

/** One window's pace (or the context's, named `context`). */
export type PaceRow = {
  name: string
  pct: number            // the newest reading
  per10: number          // points per 10 minutes over the run read
  fullIn: number         // ms from the newest reading until it reaches 100 at that rate
  since: number          // when the run read starts (the oldest sample used)
  trend: number[]        // 10 readings evenly spaced from `since` to the newest, to one decimal
  resetsAt?: number
  beforeReset?: boolean  // it fills before it resets
  shortBy?: number       // when it does: how long before the reset (ms)
}
export type Pace = { context?: PaceRow; windows: PaceRow[]; outPerMin?: number }

type Point = { at: number; v: number }

/** `n` readings evenly spaced over the points, each the straight line between its neighbours, to one decimal. */
function trendOf(points: Point[], n: number): number[] {
  const a = points[0]!.at
  const span = points[points.length - 1]!.at - a
  const out: number[] = []
  let j = 0
  for (let i = 0; i < n; i++) {
    const at = a + (span * i) / (n - 1)
    while (j < points.length - 2 && points[j + 1]!.at < at) j++
    const p = points[j]!
    const q = points[Math.min(j + 1, points.length - 1)]!
    const v = q.at === p.at ? q.v : p.v + ((q.v - p.v) * (at - p.at)) / (q.at - p.at)
    out.push(Math.round(v * 10) / 10)
  }
  return out
}

/**
 * The pace of one series read over the points since its last drop (a reset):
 * undefined until it moved PACE_MIN_POINTS or more over PACE_MIN_MS or more.
 */
function paceOf(name: string, points: Point[], resetsAt: number | undefined): PaceRow | undefined {
  let from = 0
  for (let i = 1; i < points.length; i++) if (points[i]!.v < points[i - 1]!.v) from = i
  const run = points.slice(from)
  if (run.length < 2) return undefined
  const a = run[0]!
  const b = run[run.length - 1]!
  const span = b.at - a.at
  const moved = b.v - a.v
  if (span < PACE_MIN_MS || moved < PACE_MIN_POINTS) return undefined
  const perMs = moved / span
  const fullIn = Math.round(Math.max(0, 100 - b.v) / perMs)
  const row: PaceRow = { name, pct: b.v, per10: perMs * TEN_MIN, fullIn, since: a.at, trend: trendOf(run, 10) }
  if (resetsAt !== undefined) {
    row.resetsAt = resetsAt
    const fullAt = b.at + fullIn
    row.beforeReset = fullAt < resetsAt
    if (row.beforeReset) row.shortBy = resetsAt - fullAt
  }
  return row
}

/**
 * The rate of each window and of the context over the last 30 minutes of the
 * measure ring, and output tokens per minute of turn time. A window shows only
 * once it moved 2 points over 5 minutes (PACE_MIN_*); one that has not is left out.
 */
export function pace(t: Timeline, now: number): Pace {
  const list = (t.samples?.list ?? []).filter((s) => s.at >= now - PACE_SPAN_MS && s.at <= now)
  const out: Pace = { windows: [] }
  const ctx: Point[] = []
  for (const s of list) if (typeof s.ctx === 'number') ctx.push({ at: s.at, v: s.ctx })
  const c = paceOf('context', ctx, undefined)
  if (c !== undefined) out.context = c
  ;(t.samples?.names ?? []).forEach((name, i) => {
    const points: Point[] = []
    for (const s of list) {
      const v = s.w[i]
      if (typeof v === 'number') points.push({ at: s.at, v })
    }
    const resetsAt = t.budget?.windows.find((w) => w.name === name)?.resetsAt
    const row = paceOf(name, points, resetsAt)
    if (row !== undefined) out.windows.push(row)
  })
  let tokens = 0
  let ms = 0
  for (const a of Object.values(t.agents)) {
    if (a.ms === undefined || a.ms <= 0) continue
    tokens += a.tokensOut ?? 0
    ms += a.ms
  }
  if (ms > 0) out.outPerMin = Math.round((tokens / ms) * MIN)
  return out
}

// ---- Cache line -----------------------------------------------------------------

export type CacheAgent = { id: string; type: string; read: number; write: number; fresh: number; readShare: number }
export type CacheLine = {
  read: number; write: number; fresh: number; total: number   // input tokens over the agents that report cache counts
  readShare: number; writeShare: number; freshShare: number   // 0 to 1; 0 when total is 0
  byAgent: CacheAgent[]                                       // heaviest input first
  ttlMs: number                                               // 5 minutes, or an hour once the session showed it (CacheClock.hour)
  warmUntil?: number                                          // the estimated end of the cache's life: the last main reply plus ttlMs
  resend?: number                                             // what a cold cache makes the next prompt re-send: the context's tokens
}

const share = (part: number, total: number): number => (total > 0 ? part / total : 0)

/**
 * Tokens read from the cache, written to it and sent fresh, with shares, over
 * the agents whose rows carry cache counts (rows an earlier version stored
 * have none and are left out); and the estimated time it stays warm.
 */
export function cacheLine(t: Timeline): CacheLine {
  const byAgent: CacheAgent[] = []
  for (const a of Object.values(t.agents)) {
    if (a.cacheRead === undefined && a.cacheWrite === undefined) continue
    const read = a.cacheRead ?? 0
    const write = a.cacheWrite ?? 0
    const fresh = Math.max(0, (a.tokensIn ?? 0) - read - write)
    byAgent.push({ id: a.id, type: a.type, read, write, fresh, readShare: share(read, read + write + fresh) })
  }
  byAgent.sort((x, y) => y.read + y.write + y.fresh - (x.read + x.write + x.fresh))
  let read = 0
  let write = 0
  let fresh = 0
  for (const r of byAgent) {
    read += r.read
    write += r.write
    fresh += r.fresh
  }
  const total = read + write + fresh
  const ttlMs = t.cache?.hour === true ? CACHE_HOUR_MS : CACHE_TTL_MS
  const out: CacheLine = {
    read, write, fresh, total,
    readShare: share(read, total), writeShare: share(write, total), freshShare: share(fresh, total),
    byAgent, ttlMs,
  }
  if (t.cache !== undefined) out.warmUntil = t.cache.at + ttlMs
  if (t.budget?.contextTokens !== undefined) out.resend = t.budget.contextTokens
  return out
}

// ---- Task meter -----------------------------------------------------------------

export type TaskMeterRow = {
  task: TaskItem
  tokens: number         // the main loop's turns attributed to it plus its agents' tokens
  ms: number             // the main loop's turn time attributed to it
  agentMs: number        // its agents' turn time, summed (they may overlap)
  agents: number; running: number; runningTokens: number
}
export type TaskMeter = { rows: TaskMeterRow[]; heaviest?: string; total: number }   // heaviest: the key (`taskKey`) of the task with the most tokens

/** A task's identity: its owner and id (ids repeat across owners: main and each subagent keep their own lists). */
export const taskKey = (x: Pick<TaskItem, 'owner' | 'id'>): string => `${x.owner}:${x.id}`

/**
 * Tokens and time per task, in the tasks' order: agents count toward the task
 * they spawned under, the one with id `taskId` owned by their parent (ids
 * repeat across owners); main-loop turns toward the task in progress at their
 * end (TaskItem.tokens and ms). A running agent's tokens arrive only when its
 * turn ends, so an active task lags.
 */
export function taskMeter(t: Timeline): TaskMeter {
  const rows: TaskMeterRow[] = t.tasks.map((task) => ({ task, tokens: task.tokens ?? 0, ms: task.ms ?? 0, agentMs: 0, agents: 0, running: 0, runningTokens: 0 }))
  const at = new Map(rows.map((r, i) => [taskKey(r.task), i]))
  for (const a of subagents(t)) {
    const i = a.taskId === undefined ? undefined : at.get(taskKey({ owner: a.parent, id: a.taskId }))
    if (i === undefined) continue
    const r = rows[i]!
    r.tokens += tokensOf(a)
    r.agentMs += a.ms ?? 0
    r.agents++
    if (a.status === 'running') {
      r.running++
      r.runningTokens += tokensOf(a)
    }
  }
  let total = 0
  let heaviest: TaskMeterRow | undefined
  for (const r of rows) {
    total += r.tokens
    if (r.tokens > 0 && (heaviest === undefined || r.tokens > heaviest.tokens)) heaviest = r
  }
  const out: TaskMeter = { rows, total }
  if (heaviest !== undefined) out.heaviest = taskKey(heaviest.task)
  return out
}

// ---- Roles and long runs --------------------------------------------------------

export type Role = { type: string; count: number; running: number; tokens: number; medianMs?: number }

const finishedMs = (a: AgentRow): number | undefined =>
  a.status !== 'running' && a.endedAt !== undefined && a.endedAt >= a.startedAt ? a.endedAt - a.startedAt : undefined

/** One row per subagent type: how many, how many running, their tokens, and the median time of the finished ones; most first. */
export function roles(t: Timeline): Role[] {
  const groups = new Map<string, AgentRow[]>()
  for (const a of subagents(t)) {
    const list = groups.get(a.type)
    if (list) list.push(a)
    else groups.set(a.type, [a])
  }
  const out: Role[] = []
  for (const [type, list] of groups) {
    const row: Role = { type, count: list.length, running: list.filter((a) => a.status === 'running').length, tokens: list.reduce((n, a) => n + tokensOf(a), 0) }
    const m = median(list.map(finishedMs).filter((x): x is number => x !== undefined))
    if (m !== undefined) row.medianMs = m
    out.push(row)
  }
  return out.sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
}

/** What agents of `type` usually take: the median time of the finished ones; undefined when none finished. */
export function usualMs(t: Timeline, type: string): number | undefined {
  return median(subagents(t).filter((a) => a.type === type).map(finishedMs).filter((x): x is number => x !== undefined))
}

/** The long-run limits in minutes; 0 switches one off. */
export type RunLimits = { agentLimitMin?: number; turnLimitMin?: number }

const minutes = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)

/** The limits as options give them: a missing, negative or non-number value takes its default (20 for an agent, 60 for a turn). */
export function runLimits(o: { agentLimitMin?: unknown; turnLimitMin?: unknown } | undefined): Required<RunLimits> {
  return { agentLimitMin: minutes(o?.agentLimitMin, AGENT_LIMIT_MIN), turnLimitMin: minutes(o?.turnLimitMin, TURN_LIMIT_MIN) }
}

export type RunLevel = 'ok' | 'over'

/** How a run `elapsed` ms long stands against `limitMin`: over past it, else ok (no near amber: R6); ok when the limit is 0 (off). */
export function runLevel(elapsed: number, limitMin: number): RunLevel {
  if (!(limitMin > 0)) return 'ok'
  return elapsed > limitMin * MIN ? 'over' : 'ok'
}

/** The main turn running now, how long it has run and how that stands against its limit; undefined when none runs. */
export function turnClock(t: Timeline, now: number, limits?: RunLimits): { turn: TurnRow; ms: number; level: RunLevel } | undefined {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const x = t.turns[i]!
    if (x.agent !== 'main') continue
    if (x.endedAt !== undefined) return undefined
    const ms = Math.max(0, now - x.startedAt)
    return { turn: x, ms, level: runLevel(ms, runLimits(limits).turnLimitMin) }
  }
  return undefined
}

// ---- Done turns -----------------------------------------------------------------

const newestMain = (t: Timeline): TurnRow | undefined => {
  for (let i = t.turns.length - 1; i >= 0; i--) if (t.turns[i]!.agent === 'main') return t.turns[i]
  return undefined
}

/**
 * The newest main turn when it ended normally (not failed, not interrupted)
 * after running longer than `minMs` (60 s): the turn a done notification is
 * for. Undefined while it runs, and for a short, failed or interrupted turn.
 */
export function doneTurn(t: Timeline, minMs = DONE_TURN_MS): { turn: TurnRow; ms: number } | undefined {
  const x = newestMain(t)
  if (x === undefined || x.endedAt === undefined || x.failed === true || x.aborted === true) return undefined
  const ms = x.endedAt - x.startedAt
  return ms > minMs ? { turn: x, ms } : undefined
}

export type NotifyWhat = 'wait' | 'done' | 'failed'
const NOTIFY_LEVEL: Record<NotifyMode, number> = { off: 0, waits: 1, done: 2, all: 3 }
const NEEDS_LEVEL: Record<NotifyWhat, number> = { wait: 1, done: 2, failed: 3 }

/** Whether the `notify` option raises a notification for `what`: waits from `waits`, done turns from `done`, failed turns at `all`. An unknown or missing mode reads as `waits`. */
export function notifies(mode: NotifyMode | undefined, what: NotifyWhat): boolean {
  const level = mode !== undefined && mode in NOTIFY_LEVEL ? NOTIFY_LEVEL[mode] : NOTIFY_LEVEL.waits
  return level >= NEEDS_LEVEL[what]
}

export type ThisTurn = {
  turn: TurnRow
  ms?: number                  // its length once it ended
  tasksClosed: TaskItem[]      // completed during it
  agentsFinished: AgentRow[]   // subagents that ended during it
  files: number                // distinct files a write tool changed during it
  errors: number               // steps that ended in an error during it
}

/** The file a write step changed, read from its label without the tool name. */
const fileOf = (label: string, tool: string): string => (label.startsWith(`${tool} `) ? label.slice(tool.length + 1) : label)

/** What the newest main turn did: tasks closed, agents finished, files changed and errors; undefined before any main turn. */
export function thisTurn(t: Timeline): ThisTurn | undefined {
  const turn = newestMain(t)
  if (turn === undefined) return undefined
  const from = turn.startedAt
  const to = turn.endedAt ?? Infinity
  const within = (at: number | undefined): boolean => at !== undefined && at >= from && at <= to
  const files = new Set<string>()
  let errors = 0
  for (const s of t.steps) {
    if (!within(s.startedAt)) continue
    if (s.status === 'error') errors++
    if (s.status === 'done' && WRITE_TOOLS.has(s.tool)) files.add(fileOf(s.label, s.tool))
  }
  const out: ThisTurn = {
    turn,
    tasksClosed: t.tasks.filter((x) => x.status === 'completed' && within(x.updatedAt)),
    agentsFinished: subagents(t).filter((a) => a.status !== 'running' && within(a.endedAt)),
    files: files.size,
    errors,
  }
  if (turn.endedAt !== undefined) out.ms = turn.endedAt - turn.startedAt
  return out
}

// ---- Session cost ---------------------------------------------------------------

/** The newest main turn's share of the session's cost (US dollars): its end less its start; undefined without a cost. */
export function turnShare(t: Timeline): number | undefined {
  const c = t.turnCost
  return c === undefined || c.to === undefined ? undefined : Math.max(0, c.to - c.from)
}
