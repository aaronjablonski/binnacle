import type { AgentRow, ArtifactRow, Ev, Note, Run, Step, StepFilter, TaskItem, Timeline, TurnRow } from '../../types'

const byStart = (a: { startedAt: number }, b: { startedAt: number }) => a.startedAt - b.startedAt
const subagents = (t: Timeline): AgentRow[] => Object.values(t.agents).filter((a) => a.id !== 'main')

export type TaskNode = { task: TaskItem; agents: { agent: AgentRow; tasks: TaskItem[] }[] }

/**
 * Main's tasks, each with the agents spawned while it was in progress and those
 * agents' own tasks. Tasks of agents not linked to a main task follow at the top level.
 */
export function taskTree(t: Timeline): TaskNode[] {
  const linked = new Set<string>()
  const nodes: TaskNode[] = []
  for (const task of t.tasks) {
    if (task.owner !== 'main') continue
    const agents = subagents(t)
      .filter((a) => a.parent === 'main' && a.taskId === task.id)
      .sort(byStart)
      .map((agent) => {
        linked.add(agent.id)
        return { agent, tasks: t.tasks.filter((x) => x.owner === agent.id) }
      })
    nodes.push({ task, agents })
  }
  for (const task of t.tasks) {
    if (task.owner !== 'main' && !linked.has(task.owner)) nodes.push({ task, agents: [] })
  }
  return nodes
}

const runningFirst = (a: AgentRow, b: AgentRow) =>
  (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.startedAt - b.startedAt

/** Agents grouped by workflow run: the runless group first, running agents first inside each. */
export function agentGroups(t: Timeline): { run?: Run; agents: AgentRow[]; done: number }[] {
  const all = subagents(t)
  const count = (list: AgentRow[]) => list.filter((a) => a.status === 'done').length
  const groups: { run?: Run; agents: AgentRow[]; done: number }[] = []
  const runless = all.filter((a) => a.runId === undefined || !t.runs[a.runId]).sort(runningFirst)
  if (runless.length > 0) groups.push({ agents: runless, done: count(runless) })
  for (const run of Object.values(t.runs).sort(byStart)) {
    const agents = all.filter((a) => a.runId === run.runId).sort(runningFirst)
    groups.push({ run, agents, done: count(agents) })
  }
  return groups
}

export type TreeNode = { key: string; kind: 'agent' | 'run'; agent?: AgentRow; run?: Run; done?: number; children: TreeNode[] }

/** Main at the root; each agent under its parent, or under its run's node, which sits under the run's caller. */
export function agentTree(t: Timeline): TreeNode {
  type Item = { node: TreeNode; startedAt: number; parentKey: string }
  const items = new Map<string, Item>()
  const root: TreeNode = { key: 'main', kind: 'agent', children: [] }
  if (t.agents.main) root.agent = t.agents.main
  const all = subagents(t)
  for (const run of Object.values(t.runs)) {
    const done = all.filter((a) => a.runId === run.runId && a.status === 'done').length
    items.set(`run:${run.runId}`, { node: { key: `run:${run.runId}`, kind: 'run', run, done, children: [] }, startedAt: run.startedAt, parentKey: run.parent })
  }
  for (const a of all) {
    const parentKey = a.runId !== undefined && t.runs[a.runId] ? `run:${a.runId}` : a.parent
    items.set(a.id, { node: { key: a.id, kind: 'agent', agent: a, children: [] }, startedAt: a.startedAt, parentKey })
  }
  // Attach by walking down from main so a cycle in parents can never loop; anything unreached joins main.
  const kids = new Map<string, Item[]>()
  for (const it of items.values()) {
    const p = it.parentKey !== it.node.key && (it.parentKey === 'main' || items.has(it.parentKey)) ? it.parentKey : 'main'
    kids.set(p, [...(kids.get(p) ?? []), it])
  }
  const seen = new Set<string>(['main'])
  const attach = (node: TreeNode) => {
    for (const it of (kids.get(node.key) ?? []).sort(byStart)) {
      if (seen.has(it.node.key)) continue
      seen.add(it.node.key)
      node.children.push(it.node)
      attach(it.node)
    }
  }
  attach(root)
  const lost = [...items.values()].filter((it) => !seen.has(it.node.key)).sort(byStart)
  for (const it of lost) {
    seen.add(it.node.key)
    root.children.push(it.node)
  }
  root.children.sort((a, b) => startOf(a) - startOf(b))
  return root
}

const startOf = (n: TreeNode) => n.agent?.startedAt ?? n.run?.startedAt ?? 0

export type TreeLine = { key: string; prefix: string; node: TreeNode; folded: boolean }

/** The tree depth-first, one line per node, skipping the children of folded keys. */
export function treeLines(root: TreeNode, folded: string[]): TreeLine[] {
  const out: TreeLine[] = []
  const walk = (node: TreeNode, prefix: string, indent: string) => {
    const isFolded = folded.includes(node.key)
    out.push({ key: node.key, prefix, node, folded: isFolded })
    if (isFolded) return
    node.children.forEach((c, i) => {
      const last = i === node.children.length - 1
      walk(c, indent + (last ? '└─ ' : '├─ '), indent + (last ? '   ' : '│  '))
    })
  }
  walk(root, '', '')
  return out
}

function matches(s: Step, f: StepFilter): boolean {
  switch (f.kind) {
    case 'all': return true
    case 'pinned': return s.pin !== undefined
    case 'errors': return s.status === 'error'
    case 'agent': return s.agent === f.id
  }
}

/** Steps that pass the filter, grouped by turn: newest turn first, newest step first. */
export function stepGroups(t: Timeline, f: StepFilter): { turn?: TurnRow; steps: Step[] }[] {
  const turns = new Map(t.turns.map((x) => [x.id, x]))
  const groups = new Map<string, { turn?: TurnRow; steps: Step[]; key: number }>()
  const steps = t.steps.filter((s) => matches(s, f)).sort((a, b) => b.seq - a.seq)
  for (const s of steps) {
    const turn = s.turnId !== undefined ? turns.get(s.turnId) : undefined
    const id = turn ? `t:${turn.id}` : ''
    let g = groups.get(id)
    if (!g) {
      g = { steps: [], key: turn ? turn.startedAt : s.startedAt }
      if (turn) g.turn = turn
      groups.set(id, g)
    }
    g.steps.push(s)
  }
  return [...groups.values()].sort((a, b) => b.key - a.key).map(({ key: _k, ...g }) => g)
}

export type Summary = {
  focus?: string; next?: string; focusAt?: number; fromClaude: boolean
  done: number; total: number; current?: TaskItem; upcoming?: TaskItem
  running: AgentRow[]; finished: number
  latest: Step[]; steps: number; errors: number; changed: number     // latest: newest 4, pinned ones included
  notes: Note[]; artifacts: ArtifactRow[]                            // newest 3 each
}

/** What the overview and the band show. */
export function summary(t: Timeline): Summary {
  let current: TaskItem | undefined
  for (const x of t.tasks) if (x.status === 'in_progress' && (!current || x.updatedAt >= current.updatedAt)) current = x
  const upcoming = t.tasks.find((x) => x.status === 'pending')
  const all = subagents(t)
  const s: Summary = {
    fromClaude: t.now !== undefined,
    done: t.tasks.filter((x) => x.status === 'completed').length,
    total: t.tasks.length,
    running: all.filter((a) => a.status === 'running').sort(byStart),
    finished: all.filter((a) => a.status !== 'running').length,
    latest: [...t.steps].sort((a, b) => b.seq - a.seq).slice(0, 4),
    steps: t.steps.length,
    errors: t.steps.filter((x) => x.status === 'error').length,
    changed: t.changed.length,
    notes: t.notes.slice(-3).reverse(),
    artifacts: [...t.artifacts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3),
  }
  const focus = t.now?.focus || (current ? current.activeForm ?? current.subject : undefined)
  if (focus) s.focus = focus
  if (t.now) {
    s.focusAt = t.now.at
    if (t.now.next !== undefined) s.next = t.now.next
  }
  if (current) s.current = current
  if (upcoming) s.upcoming = upcoming
  return s
}

// ---- Probe fixture lines (test/fixtures/probe-*.jsonl) → events ----------------
// A line is { at, event, e, r? }. tool.call / agent.spawn carry `e` only (written
// before next); tool.result / agent.spawned are the probe's own result lines.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const agentOf = (e: Obj): string => s(e.agentId) ?? 'main'

/** One probe line → zero or more events. `agent.spawn` alone yields none and
 * `agent.spawned` alone an `unknown` agent: use `fixtureEvents` to pair them. */
export function fromFixture(line: unknown): Ev[] {
  if (!isObj(line) || !isObj(line.e)) return []
  const at = typeof line.at === 'number' ? line.at : 0
  const e = line.e
  const r = isObj(line.r) ? line.r : {}
  switch (line.event) {
    case 'turn.start': {
      const turnId = s(e.turnId)
      return turnId ? [{ kind: 'turn.start', at, turnId, agent: agentOf(e), prompt: typeof e.text === 'string' ? e.text : '' }] : []
    }
    case 'turn.complete': {
      const turnId = s(e.turnId)
      if (!turnId) return []
      const failed = e.isAborted === true || (e.reason !== undefined && e.reason !== 'answer')
      return [{ kind: 'turn.end', at, turnId, agent: agentOf(e), answer: typeof e.answer === 'string' ? e.answer : '', failed }]
    }
    case 'tool.call': {
      const id = s(e.tool_use_id)
      const tool = s(e.tool)
      if (!id || !tool) return []
      const { tool: _t, tool_use_id: _u, agentId: _a, ...input } = e
      return [{ kind: 'step.start', at, id, agent: agentOf(e), tool, input }]
    }
    case 'tool.result': {
      const id = s(e.tool_use_id)
      if (!id) return []
      if (r.deny !== undefined) return [{ kind: 'step.end', at, id, status: 'denied' }]
      return [{ kind: 'step.end', at, id, status: r.isError === true ? 'error' : 'done', result: r.result }]
    }
    case 'agent.spawned': {
      const id = s(r.agentId)
      return id ? [{ kind: 'agent.start', at, id, parent: s(e.parentAgentId) ?? 'main', type: 'unknown', description: '' }] : []
    }
    default:
      return []
  }
}

/** Probe lines in order → events, pairing each `agent.spawned` with the oldest
 * unpaired `agent.spawn` of the same `tool_use_id` (workflow agents share one). */
export function fixtureEvents(lines: unknown[]): Ev[] {
  const waiting = new Map<string, Obj[]>()
  const out: Ev[] = []
  for (const line of lines) {
    if (isObj(line) && isObj(line.e) && line.event === 'agent.spawn') {
      const key = s(line.e.tool_use_id)
      if (key) waiting.set(key, [...(waiting.get(key) ?? []), line.e])
      continue
    }
    const evs = fromFixture(line)
    if (isObj(line) && isObj(line.e) && line.event === 'agent.spawned' && evs[0]?.kind === 'agent.start') {
      const key = s(line.e.tool_use_id) ?? ''
      const queue = waiting.get(key) ?? []
      const spawn = queue.shift()
      if (spawn) {
        const ev = evs[0]
        const wf = isObj(spawn.workflow) ? spawn.workflow : undefined
        const paired: Ev = {
          ...ev,
          parent: s(spawn.parentAgentId) ?? ev.parent,
          type: s(spawn.subagentType) ?? ev.type,
          description: typeof spawn.description === 'string' ? spawn.description : '',
        }
        if (wf && s(wf.runId)) paired.runId = s(wf.runId)
        if (wf && typeof wf.agentIndex === 'number') paired.agentIndex = wf.agentIndex
        out.push(paired)
        continue
      }
    }
    out.push(...evs)
  }
  return out
}
