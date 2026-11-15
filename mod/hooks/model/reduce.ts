import type { AgentKey, AgentRow, ArtifactRow, Budget, Ev, Run, Step, TaskItem, Timeline, TurnRow } from '../../types'
import { basename, cut, isDoc, labelOf, oneLine, pathsOf, sigOf, tail2 } from './label'
import {
  MAX_AGENTS, MAX_ARTIFACTS, MAX_CHANGED, MAX_LINE, MAX_MODEL, MAX_NOTES, MAX_PENDING, MAX_PENDING_STEPS, MAX_REF, MAX_RESULT, MAX_RUNS, MAX_STEP_ID, MAX_STEPS, MAX_TASKS,
  MAX_TURNS,
} from './limits'
import { windowsOf } from './usage'

const DOING_MAX = 80
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** The input keys step.end reads, per tool; a step of any other tool keeps no `pending`. */
const PENDING_KEYS: Record<string, readonly string[]> = {
  TaskCreate: ['subject', 'activeForm'],
  TaskUpdate: ['taskId', 'status', 'subject', 'activeForm'],
  Write: ['file_path', 'notebook_path'],
  Edit: ['file_path', 'notebook_path'],
  MultiEdit: ['file_path', 'notebook_path'],
  NotebookEdit: ['file_path', 'notebook_path'],
  Artifact: ['file_path', 'title'],
}
const TASK_STATUS = new Set<TaskItem['status']>(['pending', 'in_progress', 'completed'])

const mainRow: AgentRow = {
  id: 'main', parent: 'main', type: 'main', description: '',
  status: 'running', startedAt: 0, doing: '', stepCount: 0,
}

export const empty: Timeline = {
  seq: 0, turns: [], steps: [],
  agents: { main: mainRow }, runs: {},
  tasks: [], notes: [], artifacts: [], changed: [],
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined
/** One line, trimmed, cut to MAX_LINE; undefined for a non-string or an empty string. */
const line = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = cut(oneLine(v), MAX_LINE)
  return s === '' ? undefined : s
}
/** A finite, non-negative number, or undefined. */
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const modelOf = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const m = cut(oneLine(v), MAX_MODEL)
  return m === '' ? undefined : m
}
const taskStatus = (v: unknown): TaskItem['status'] | undefined =>
  TASK_STATUS.has(v as TaskItem['status']) ? (v as TaskItem['status']) : undefined

/**
 * The primitive values of the keys step.end reads for this tool, each string
 * cut to MAX_PENDING; undefined when the tool has none.
 */
function keepPending(tool: string, input: Obj): Obj | undefined {
  const keys = PENDING_KEYS[tool]
  if (keys === undefined) return undefined
  const out: Obj = {}
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') out[k] = cut(v, MAX_PENDING)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * Drops items past `max`: those `finished` says are done go first, oldest
 * (by `at`) first; then the oldest of the rest. `keep` items are never dropped.
 */
function dropOldest<T>(list: T[], max: number, finished: (x: T) => boolean, at: (x: T) => number, keep: (x: T) => boolean = () => false): T[] {
  const over = list.length - max
  if (over <= 0) return list
  const order = list
    .map((x, i) => ({ i, done: finished(x), at: at(x) }))
    .filter((r) => !keep(list[r.i]!))
    .sort((a, b) => (a.done === b.done ? a.at - b.at : a.done ? -1 : 1))
  const drop = new Set(order.slice(0, over).map((r) => r.i))
  return list.filter((_, i) => !drop.has(i))
}

function boundTasks(tasks: TaskItem[]): TaskItem[] {
  return dropOldest(tasks, MAX_TASKS, (x) => x.status === 'completed', (x) => x.updatedAt)
}

function boundAgents(agents: Record<AgentKey, AgentRow>): Record<AgentKey, AgentRow> {
  const rows = Object.values(agents)
  if (rows.length <= MAX_AGENTS) return agents
  const kept = dropOldest(rows, MAX_AGENTS, (a) => a.status !== 'running', (a) => a.endedAt ?? a.startedAt, (a) => a.id === 'main')
  return Object.fromEntries(kept.map((a) => [a.id, a]))
}

function boundRuns(runs: Record<string, Run>): Record<string, Run> {
  const rows = Object.values(runs)
  if (rows.length <= MAX_RUNS) return runs
  return Object.fromEntries(dropOldest(rows, MAX_RUNS, () => true, (r) => r.startedAt).map((r) => [r.runId, r]))
}

function newAgent(id: AgentKey, at: number): AgentRow {
  return { id, parent: 'main', type: 'unknown', description: '', status: 'running', startedAt: at, doing: '', stepCount: 0 }
}

function withAgent(t: Timeline, id: AgentKey, at: number, fn: (a: AgentRow) => AgentRow): Timeline {
  const old = t.agents[id]
  const agents = { ...t.agents, [id]: fn(old ?? newAgent(id, at)) }
  return { ...t, agents: old === undefined ? boundAgents(agents) : agents }
}

function dropPast<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list
}

/**
 * Only the newest MAX_PENDING_STEPS steps keep their `pending`: a step whose
 * end has not come by then (a lost or very late step.end) is left without it.
 */
function boundPending(steps: Step[]): Step[] {
  let over = -MAX_PENDING_STEPS
  for (const s of steps) if (s.pending !== undefined) over++
  if (over <= 0) return steps
  return steps.map((s) => {
    if (over <= 0 || s.pending === undefined) return s
    over--
    const { pending: _drop, ...rest } = s
    return rest
  })
}

function boundSteps(steps: Step[]): Step[] {
  let over = steps.length - MAX_STEPS
  if (over <= 0) return steps
  return steps.filter((s) => {
    if (over > 0 && s.pin === undefined) { over--; return false }
    return true
  })
}

function boundArtifacts(list: ArtifactRow[]): ArtifactRow[] {
  let out = list
  while (out.length > MAX_ARTIFACTS) {
    let oldest = 0
    out.forEach((a, i) => { if (a.updatedAt < out[oldest]!.updatedAt) oldest = i })
    out = out.filter((_, i) => i !== oldest)
  }
  return out
}

function putArtifact(t: Timeline, row: Omit<ArtifactRow, 'count'>): Timeline {
  const i = t.artifacts.findIndex((a) => a.id === row.id)
  if (i < 0) return { ...t, artifacts: boundArtifacts([...t.artifacts, { ...row, count: 1 }]) }
  const old = t.artifacts[i]!
  const next: ArtifactRow = { ...old, ...row, count: old.count + 1 }
  for (const k of ['ref', 'summary', 'stepId'] as const) if (row[k] === undefined && old[k] !== undefined) next[k] = old[k]
  return { ...t, artifacts: t.artifacts.map((a, j) => (j === i ? next : a)) }
}

function putTask(t: Timeline, id: string, fn: (old: TaskItem | undefined) => TaskItem | undefined): Timeline {
  const i = t.tasks.findIndex((x) => x.id === id)
  const res = fn(i < 0 ? undefined : t.tasks[i])
  if (i < 0) return res ? { ...t, tasks: boundTasks([...t.tasks, res]) } : t
  return { ...t, tasks: res ? t.tasks.map((x, j) => (j === i ? res : x)) : t.tasks.filter((_, j) => j !== i) }
}

function openTurn(t: Timeline, agent: AgentKey): string | undefined {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const x = t.turns[i]!
    if (x.agent === agent && x.endedAt === undefined) return x.id
  }
  return undefined
}

const isWorkflowAgent = (a: AgentRow): boolean => a.id !== 'main' && (a.runId !== undefined || a.type === 'workflow-subagent')

/** A StructuredOutput input on one line: `key: value` joined by ` · `, nested values as JSON, cut to MAX_RESULT. */
function resultLine(input: Obj): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    let text: string
    if (typeof v === 'string') text = v
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) text = String(v)
    else {
      try {
        text = JSON.stringify(v) ?? ''
      } catch {
        text = ''
      }
    }
    parts.push(`${k}: ${text}`)
  }
  return cut(oneLine(parts.join(' · ')), MAX_RESULT)
}

/** The step with its ask mark dropped; the same timeline when it has none. */
function unask(t: Timeline, id: string): Timeline {
  const i = t.steps.findIndex((s) => s.id === id)
  if (i < 0 || t.steps[i]!.asking === undefined) return t
  const { asking: _asked, ...rest } = t.steps[i]!
  return { ...t, steps: t.steps.map((x, j) => (j === i ? rest : x)) }
}

function stepStart(t: Timeline, ev: Extract<Ev, { kind: 'step.start' }>): Timeline {
  if (t.steps.some((s) => s.id === ev.id)) return t
  const input = isObj(ev.input) ? ev.input : {}
  const label = labelOf(ev.tool, input)
  const seq = t.seq + 1
  const step: Step = {
    id: ev.id, seq, agent: ev.agent, tool: ev.tool, label, status: 'running',
    startedAt: ev.at, sig: sigOf(ev.tool, input),
  }
  const pending = keepPending(ev.tool, input)
  if (pending !== undefined) step.pending = pending
  const turnId = openTurn(t, ev.agent)
  if (turnId !== undefined) step.turnId = turnId
  // An agent's first step shows the call that spawned it went ahead: its ask is settled.
  const spawner = t.agents[ev.agent]
  const settled = spawner?.spawnStep !== undefined && spawner.stepCount === 0 ? unask(t, spawner.spawnStep) : t
  let next: Timeline = { ...settled, seq, steps: boundPending(boundSteps([...settled.steps, step])) }
  next = withAgent(next, ev.agent, ev.at, (a) => {
    const row: AgentRow = { ...a, stepCount: a.stepCount + 1, doing: label, lastStepAt: ev.at }
    if (ev.tool === 'StructuredOutput' && isWorkflowAgent(a)) row.result = resultLine(input)
    return row
  })
  if (ev.tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos: TaskItem[] = []
    input.todos.forEach((td, i) => {
      if (!isObj(td)) return
      const item: TaskItem = {
        id: `todo:${ev.agent}:${i}`,
        subject: line(td.content) ?? line(td.subject) ?? `Todo ${i + 1}`,
        status: taskStatus(td.status) ?? 'pending',
        owner: ev.agent, updatedAt: ev.at,
      }
      const af = line(td.activeForm)
      if (af !== undefined) item.activeForm = af
      todos.push(item)
    })
    next = { ...next, tasks: boundTasks([...next.tasks.filter((x) => x.owner !== ev.agent), ...todos]) }
  }
  return next
}

function stepEnd(t: Timeline, ev: Extract<Ev, { kind: 'step.end' }>): Timeline {
  const i = t.steps.findIndex((s) => s.id === ev.id)
  if (i < 0) return t
  const step = t.steps[i]!
  if (step.status !== 'running' && step.status !== 'interrupted') return t
  const pending = step.pending ?? {}
  const { pending: _drop, asking: _asked, ...rest } = step
  const ended: Step = { ...rest, status: ev.status, endedAt: ev.at }
  let next: Timeline = { ...t, steps: t.steps.map((s, j) => (j === i ? ended : s)) }
  if (ev.status !== 'done') return next
  const result = isObj(ev.result) ? ev.result : {}
  const agent = step.agent

  if (step.tool === 'TaskCreate') {
    const id = isObj(result.task) ? idOf(result.task.id) : undefined
    if (id !== undefined) {
      next = putTask(next, id, (old) => {
        const item: TaskItem = {
          id, subject: line(pending.subject) ?? old?.subject ?? `Task ${id}`,
          status: old?.status ?? 'pending', owner: old?.owner ?? agent, updatedAt: ev.at,
        }
        const af = line(pending.activeForm) ?? old?.activeForm
        if (af !== undefined) item.activeForm = af
        return item
      })
    }
  } else if (step.tool === 'TaskUpdate') {
    const id = idOf(pending.taskId) ?? idOf(result.taskId)
    if (id !== undefined) {
      next = putTask(next, id, (old) => {
        if (pending.status === 'deleted') return undefined
        const item: TaskItem = { ...(old ?? { id, subject: `Task ${id}`, status: 'pending', owner: agent }), updatedAt: ev.at }
        const st = taskStatus(pending.status)
        if (st) item.status = st
        const subject = line(pending.subject)
        if (subject !== undefined) item.subject = subject
        const af = line(pending.activeForm)
        if (af !== undefined) item.activeForm = af
        return item
      })
    }
  } else if (WRITE_TOOLS.has(step.tool)) {
    for (const p of pathsOf(step.tool, pending)) {
      if (isDoc(p)) {
        next = putArtifact(next, { id: `doc:${p}`, kind: 'document', title: tail2(p), ref: p, stepId: step.id, agent, updatedAt: ev.at })
      } else if (!next.changed.includes(p) && next.changed.length < MAX_CHANGED) {
        next = { ...next, changed: [...next.changed, p] }
      }
    }
  } else if (step.tool === 'Artifact') {
    const raw = str(result.url)
    const url = raw === undefined ? undefined : cut(oneLine(raw), MAX_REF)
    if (url) {
      const fp = str(pending.file_path)
      const title = line(pending.title) ?? (fp ? line(basename(fp)) : undefined) ?? 'Page'
      next = putArtifact(next, { id: `page:${url}`, kind: 'page', title, ref: url, stepId: step.id, agent, updatedAt: ev.at })
    }
  } else if (step.tool === 'Workflow') {
    const runId = str(result.runId)
    const name = str(result.workflowName)
    if (runId && name) {
      const old = next.runs[runId]
      const run: Run = { runId, name: cut(oneLine(name), MAX_LINE), parent: agent, startedAt: old?.startedAt ?? step.startedAt }
      next = { ...next, runs: boundRuns({ ...next.runs, [runId]: run }) }
    }
  }
  return next
}

function agentStart(t: Timeline, ev: Extract<Ev, { kind: 'agent.start' }>): Timeline {
  let next = t
  if (ev.runId !== undefined && !next.runs[ev.runId]) {
    const run: Run = { runId: ev.runId, name: 'workflow', parent: ev.parent, startedAt: ev.at }
    next = { ...next, runs: boundRuns({ ...next.runs, [ev.runId]: run }) }
  }
  let taskId: string | undefined
  let best = -Infinity
  for (const x of next.tasks) {
    if (x.owner === ev.parent && x.status === 'in_progress' && x.updatedAt >= best) { best = x.updatedAt; taskId = x.id }
  }
  return withAgent(next, ev.id, ev.at, (old) => {
    const row: AgentRow = {
      ...old, id: ev.id, parent: ev.parent, type: cut(oneLine(str(ev.type) ?? ''), DOING_MAX), description: cut(oneLine(ev.description ?? ''), MAX_LINE),
      status: 'running',
    }
    if (old.stepCount === 0) row.startedAt = ev.at
    if (ev.runId !== undefined) row.runId = ev.runId
    if (ev.agentIndex !== undefined) row.agentIndex = ev.agentIndex
    if (taskId !== undefined) row.taskId = taskId
    const spawnStep = typeof ev.spawnStep === 'string' && ev.spawnStep !== '' ? cut(ev.spawnStep, MAX_STEP_ID) : undefined
    if (spawnStep !== undefined) row.spawnStep = spawnStep
    return row
  })
}

function applyUpdate(t: Timeline, ev: Extract<Ev, { kind: 'update' }>): Timeline {
  const u: Obj = isObj(ev.update) ? ev.update : {}
  const focus = line(u.focus)
  const nxt = line(u.next)
  const note = line(u.note)
  let next = t
  if (ev.agent === 'main') {
    if (focus !== undefined) {
      next = { ...next, now: nxt !== undefined ? { focus, next: nxt, at: ev.at } : { focus, at: ev.at } }
    } else if (nxt !== undefined) {
      next = { ...next, now: { focus: next.now?.focus ?? '', next: nxt, at: ev.at } }
    }
  } else if (focus !== undefined) {
    next = withAgent(next, ev.agent, ev.at, (a) => ({ ...a, doing: cut(focus, DOING_MAX) }))
  }
  if (note !== undefined) {
    next = { ...next, notes: dropPast([...next.notes, { text: note, agent: ev.agent, at: ev.at }], MAX_NOTES) }
  }
  const art = u.artifact
  if (isObj(art) && (art.kind === 'result' || art.kind === 'link')) {
    const title = line(art.title)
    if (title !== undefined) {
      const ref = typeof art.ref === 'string' && art.ref.trim() !== '' ? cut(oneLine(art.ref), MAX_REF) : undefined
      const summary = line(art.summary)
      const row: Omit<ArtifactRow, 'count'> = { id: `${art.kind}:${ref ?? title}`, kind: art.kind, title, agent: ev.agent, updatedAt: ev.at }
      if (ref !== undefined) row.ref = ref
      if (summary !== undefined) row.summary = summary
      next = putArtifact(next, row)
    }
  }
  return next
}

function turnStart(t: Timeline, ev: Extract<Ev, { kind: 'turn.start' }>): Timeline {
  const row = { id: ev.turnId, agent: ev.agent, prompt: cut(oneLine(str(ev.prompt) ?? ''), MAX_LINE), startedAt: ev.at }
  const next: Timeline = { ...t, turns: dropPast([...t.turns, row], MAX_TURNS) }
  return withAgent(next, ev.agent, ev.at, (a) => (ev.agent === 'main' || a.status === 'running' ? a : { ...a, status: 'running' }))
}

function turnEnd(t: Timeline, ev: Extract<Ev, { kind: 'turn.end' }>): Timeline {
  const turns = t.turns.map((x): TurnRow => {
    if (x.id !== ev.turnId || x.endedAt !== undefined) return x
    return ev.failed === true ? { ...x, endedAt: ev.at, failed: true } : { ...x, endedAt: ev.at }
  })
  const steps = t.steps.map((s): Step => {
    if (s.agent !== ev.agent || s.status !== 'running') return s
    const { asking: _asked, ...rest } = s
    return { ...rest, status: 'interrupted', endedAt: ev.at }
  })
  const first = cut(oneLine((str(ev.answer) ?? '').trim().split(/\r?\n/)[0] ?? ''), DOING_MAX)
  return withAgent({ ...t, turns, steps }, ev.agent, ev.at, (a) => {
    const row: AgentRow = { ...a }
    if (first !== '') row.doing = first
    if (ev.agent !== 'main') {
      row.status = ev.failed ? 'error' : 'done'
      row.endedAt = ev.at
    }
    return row
  })
}

/** Marks a running step as sent to ask; the first ask's time is kept. */
function stepAsk(t: Timeline, ev: Extract<Ev, { kind: 'step.ask' }>): Timeline {
  const i = t.steps.findIndex((s) => s.id === ev.id)
  if (i < 0) return t
  const s = t.steps[i]!
  if (s.status !== 'running' || s.asking !== undefined || typeof ev.at !== 'number') return t
  return { ...t, steps: t.steps.map((x, j) => (j === i ? { ...s, asking: ev.at } : x)) }
}

/** Adds a turn's token counts to its agent; a model given replaces the one held. */
function addUsage(t: Timeline, ev: Extract<Ev, { kind: 'usage' }>): Timeline {
  const tokensIn = count(ev.tokensIn)
  const tokensOut = count(ev.tokensOut)
  const model = modelOf(ev.model)
  if (tokensIn === undefined && tokensOut === undefined && model === undefined) return t
  return withAgent(t, ev.agent, ev.at, (a) => {
    const row: AgentRow = { ...a }
    if (tokensIn !== undefined) row.tokensIn = (a.tokensIn ?? 0) + tokensIn
    if (tokensOut !== undefined) row.tokensOut = (a.tokensOut ?? 0) + tokensOut
    if (model !== undefined) row.model = model
    return row
  })
}

function agentModel(t: Timeline, ev: Extract<Ev, { kind: 'agent.model' }>): Timeline {
  const model = modelOf(ev.model)
  if (model === undefined) return t
  const at = t.agents[ev.id]?.startedAt ?? 0
  return withAgent(t, ev.id, at, (a) => ({ ...a, model }))
}

/** The budget replaced whole by the newest measurement. */
function measure(t: Timeline, ev: Extract<Ev, { kind: 'measure' }>): Timeline {
  const src: Partial<Budget> = isObj(ev.budget) ? ev.budget : {}
  const budget: Budget = { windows: windowsOf(src.windows), at: ev.at }
  if (typeof src.contextPct === 'number' && Number.isFinite(src.contextPct)) budget.contextPct = src.contextPct
  const usd = count(src.costUsd)
  if (usd !== undefined) budget.costUsd = usd
  return { ...t, budget }
}

function pin(t: Timeline, id: string, note: string | undefined): Timeline {
  const i = t.steps.findIndex((s) => s.id === id)
  if (i < 0) return t
  const s = t.steps[i]!
  if (note === undefined && s.pin === undefined) return t
  let changed: Step
  if (note === undefined) { const { pin: _p, ...rest } = s; changed = rest } else changed = { ...s, pin: note }
  return { ...t, steps: t.steps.map((x, j) => (j === i ? changed : x)) }
}

/** Folds one event into the Timeline. Pure: never mutates `t`, never throws (returns `t` on a bad event). */
export function reduce(t: Timeline, ev: Ev): Timeline {
  try {
    switch (ev.kind) {
      case 'step.start': return stepStart(t, ev)
      case 'step.end': return stepEnd(t, ev)
      case 'agent.start': return agentStart(t, ev)
      case 'update': return applyUpdate(t, ev)
      case 'turn.start': return turnStart(t, ev)
      case 'turn.end': return turnEnd(t, ev)
      case 'pin': return pin(t, ev.id, typeof ev.note === 'string' ? cut(oneLine(ev.note), MAX_LINE) : '')
      case 'unpin': return pin(t, ev.id, undefined)
      case 'step.ask': return stepAsk(t, ev)
      case 'step.unask': return typeof ev.id === 'string' ? unask(t, ev.id) : t
      case 'usage': return addUsage(t, ev)
      case 'agent.model': return agentModel(t, ev)
      case 'measure': return measure(t, ev)
      default: return t
    }
  } catch {
    return t
  }
}

/** The newest time anything in `t` happened: a step's or turn's start or end, an agent's start, last step or end. */
function lastActivity(t: Timeline): number {
  let last = 0
  for (const s of t.steps) last = Math.max(last, s.endedAt ?? s.startedAt)
  for (const x of t.turns) last = Math.max(last, x.endedAt ?? x.startedAt)
  for (const a of Object.values(t.agents)) last = Math.max(last, a.endedAt ?? 0, a.lastStepAt ?? 0, a.startedAt)
  return last
}

/**
 * A stored timeline folded through an interrupt pass, for adopting it into a
 * new session: nothing that was running then can end now. Running steps
 * become `interrupted` with their ask dropped; running subagents become
 * `done`. Both end at the timeline's last activity. Main stays as it is. Pure.
 */
export function settle(t: Timeline): Timeline {
  const last = lastActivity(t)
  const steps = t.steps.map((s): Step => {
    if (s.status !== 'running') return s
    const { asking: _asked, ...rest } = s
    return { ...rest, status: 'interrupted', endedAt: s.endedAt ?? last }
  })
  const agents: Record<AgentKey, AgentRow> = {}
  for (const [id, a] of Object.entries(t.agents)) {
    agents[id] = a.id === 'main' || a.status !== 'running' ? a : { ...a, status: 'done', endedAt: last }
  }
  return { ...t, steps, agents }
}
