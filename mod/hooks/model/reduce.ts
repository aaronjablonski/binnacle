import type { AgentKey, AgentRow, ArtifactRow, Ev, Step, TaskItem, Timeline } from '../../types'
import { basename, cut, isDoc, labelOf, oneLine, pathsOf, tail2 } from './label'
import { MAX_ARTIFACTS, MAX_CHANGED, MAX_LINE, MAX_NOTES, MAX_STEPS, MAX_TURNS } from './limits'

const DOING_MAX = 80
/** Strings kept in a step's `pending` input are cut to this. */
const PENDING_STRING_MAX = 1000
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
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
const taskStatus = (v: unknown): TaskItem['status'] | undefined =>
  TASK_STATUS.has(v as TaskItem['status']) ? (v as TaskItem['status']) : undefined

/** The input's primitive values only, long strings cut: enough for step.end, small in $.state. */
function keepPending(input: Obj): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = cut(v, PENDING_STRING_MAX)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

function newAgent(id: AgentKey, at: number): AgentRow {
  return { id, parent: 'main', type: 'unknown', description: '', status: 'running', startedAt: at, doing: '', stepCount: 0 }
}

function withAgent(t: Timeline, id: AgentKey, at: number, fn: (a: AgentRow) => AgentRow): Timeline {
  const a = t.agents[id] ?? newAgent(id, at)
  return { ...t, agents: { ...t.agents, [id]: fn(a) } }
}

function dropPast<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list
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
  if (i < 0) return res ? { ...t, tasks: [...t.tasks, res] } : t
  return { ...t, tasks: res ? t.tasks.map((x, j) => (j === i ? res : x)) : t.tasks.filter((_, j) => j !== i) }
}

function openTurn(t: Timeline, agent: AgentKey): string | undefined {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const x = t.turns[i]!
    if (x.agent === agent && x.endedAt === undefined) return x.id
  }
  return undefined
}

function stepStart(t: Timeline, ev: Extract<Ev, { kind: 'step.start' }>): Timeline {
  if (t.steps.some((s) => s.id === ev.id)) return t
  const input = isObj(ev.input) ? ev.input : {}
  const label = labelOf(ev.tool, input)
  const seq = t.seq + 1
  const step: Step = {
    id: ev.id, seq, agent: ev.agent, tool: ev.tool, label, status: 'running',
    startedAt: ev.at, pending: keepPending(input),
  }
  const turnId = openTurn(t, ev.agent)
  if (turnId !== undefined) step.turnId = turnId
  let next: Timeline = { ...t, seq, steps: boundSteps([...t.steps, step]) }
  next = withAgent(next, ev.agent, ev.at, (a) => ({ ...a, stepCount: a.stepCount + 1, doing: label }))
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
    next = { ...next, tasks: [...next.tasks.filter((x) => x.owner !== ev.agent), ...todos] }
  }
  return next
}

function stepEnd(t: Timeline, ev: Extract<Ev, { kind: 'step.end' }>): Timeline {
  const i = t.steps.findIndex((s) => s.id === ev.id)
  if (i < 0) return t
  const step = t.steps[i]!
  if (step.status !== 'running' && step.status !== 'interrupted') return t
  const pending = step.pending ?? {}
  const { pending: _drop, ...rest } = step
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
    const url = str(result.url)
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
      next = { ...next, runs: { ...next.runs, [runId]: { runId, name: cut(oneLine(name), MAX_LINE), parent: agent, startedAt: old?.startedAt ?? step.startedAt } } }
    }
  }
  return next
}

function agentStart(t: Timeline, ev: Extract<Ev, { kind: 'agent.start' }>): Timeline {
  let next = t
  if (ev.runId !== undefined && !next.runs[ev.runId]) {
    next = { ...next, runs: { ...next.runs, [ev.runId]: { runId: ev.runId, name: 'workflow', parent: ev.parent, startedAt: ev.at } } }
  }
  let taskId: string | undefined
  let best = -Infinity
  for (const x of next.tasks) {
    if (x.owner === ev.parent && x.status === 'in_progress' && x.updatedAt >= best) { best = x.updatedAt; taskId = x.id }
  }
  return withAgent(next, ev.id, ev.at, (old) => {
    const row: AgentRow = {
      ...old, id: ev.id, parent: ev.parent, type: ev.type, description: cut(oneLine(ev.description ?? ''), MAX_LINE),
      status: 'running',
    }
    if (old.stepCount === 0) row.startedAt = ev.at
    if (ev.runId !== undefined) row.runId = ev.runId
    if (ev.agentIndex !== undefined) row.agentIndex = ev.agentIndex
    if (taskId !== undefined) row.taskId = taskId
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
    next = withAgent(next, ev.agent, ev.at, (a) => ({ ...a, doing: focus }))
  }
  if (note !== undefined) {
    next = { ...next, notes: dropPast([...next.notes, { text: note, agent: ev.agent, at: ev.at }], MAX_NOTES) }
  }
  const art = u.artifact
  if (isObj(art) && (art.kind === 'result' || art.kind === 'link')) {
    const title = line(art.title)
    if (title !== undefined) {
      const ref = typeof art.ref === 'string' && art.ref.trim() !== '' ? oneLine(art.ref) : undefined
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
  const turns = t.turns.map((x) => (x.id === ev.turnId && x.endedAt === undefined ? { ...x, endedAt: ev.at } : x))
  const steps = t.steps.map((s) => (s.agent === ev.agent && s.status === 'running' ? { ...s, status: 'interrupted' as const, endedAt: ev.at } : s))
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
      default: return t
    }
  } catch {
    return t
  }
}
