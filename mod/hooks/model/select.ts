import type { AgentKey, AgentRow, ArtifactRow, Ev, Note, Run, Step, StepFilter, TaskItem, Timeline, TurnRow } from '../../types'
import { oneLine } from './label'
import { FAILED_TURN_MS, STALL_MS } from './limits'
import { budgetOf, usageOf } from './usage'

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

/**
 * The tree without finished branches: a node stays when it is main, a running
 * agent, or holds one (so the ancestors of running nodes stay). A run node
 * stays only for the running agents under it. Returns a copy; `root` is untouched.
 */
export function runningOnlyTree(root: TreeNode): TreeNode {
  const keep = (node: TreeNode): TreeNode | undefined => {
    const children = node.children.map(keep).filter((c): c is TreeNode => c !== undefined)
    const running = node.kind === 'agent' && node.agent?.status === 'running'
    if (node.key !== 'main' && !running && children.length === 0) return undefined
    return { ...node, children }
  }
  return keep(root) ?? { ...root, children: [] }
}

/** Agents under `node` (not itself, never main, runs not counted) and how many of them run. */
export function branchCounts(node: TreeNode): { agents: number; running: number } {
  let agents = 0
  let running = 0
  const walk = (n: TreeNode) => {
    for (const c of n.children) {
      if (c.kind === 'agent' && c.agent && c.agent.id !== 'main') {
        agents += 1
        if (c.agent.status === 'running') running += 1
      }
      walk(c)
    }
  }
  walk(node)
  return { agents, running }
}

/** Whether `node` or anything under it is one of `ids` (agent ids with a problem). */
export function hasProblemIn(node: TreeNode, ids: Set<string>): boolean {
  if (node.kind === 'agent' && node.agent && ids.has(node.agent.id)) return true
  return node.children.some((c) => hasProblemIn(c, ids))
}

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

// ---- Problems: what needs the person ------------------------------------------

export type ProblemKind = 'asking' | 'repeat' | 'loop' | 'stalled' | 'failed-turn'
export type Problem = {
  key: string; kind: ProblemKind; label: string; agent: AgentKey
  stepId?: string; since: number; count?: number
}

/**
 * A step's call signature: its tool and its label without the leading tool
 * name, whitespace collapsed (`Bash:npm test`). Two calls of one tool on one
 * target share it.
 */
export function signatureOf(step: Step): string {
  let rest = oneLine(step.label)
  if (rest === step.tool) rest = ''
  else if (rest.startsWith(`${step.tool} `)) rest = rest.slice(step.tool.length + 1)
  return `${step.tool}:${rest}`
}

/** What UiState.dismissed holds for a problem: its key, and its count when it has one, so a grown count is new. */
export function dismissKey(p: Problem): string {
  return p.count === undefined ? p.key : `${p.key}#${p.count}`
}

const endOf = (s: Step): number => s.endedAt ?? s.startedAt
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** Steps grouped by a key `keyOf` gives; a step it gives no key for is left out. */
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
 * What needs the person, newest first (by `since`):
 * - `asking`: a running step whose tool.check resolved `ask` (since: the ask);
 * - `repeat`: one signature ended `error` twice or more in the session (since: the newest failure's end);
 * - `loop`: one signature ran three times or more in one turn, unless it is already a repeat (since: the newest run's start);
 * - `stalled`: a running subagent that started no step for more than STALL_MS (since: its last step, or its start);
 * - `failed-turn`: a turn that ended failed within FAILED_TURN_MS of `now` (since: its end).
 * A problem whose `dismissKey` is in `dismissed` is left out; a repeat or loop
 * comes back once its count grows.
 */
export function problems(t: Timeline, now: number, dismissed: string[]): Problem[] {
  const out: Problem[] = []
  for (const s of t.steps) {
    if (s.status === 'running' && s.asking !== undefined) {
      out.push({ key: `asking:${s.id}`, kind: 'asking', label: s.label, agent: s.agent, stepId: s.id, since: s.asking })
    }
  }

  const failures = groupBy(t.steps, (s) => (s.status === 'error' ? signatureOf(s) : undefined))
  const repeats = new Set<string>()
  for (const [sig, list] of failures) {
    if (list.length < 2) continue
    repeats.add(sig)
    const last = list.reduce((a, b) => (endOf(b) >= endOf(a) ? b : a))
    out.push({
      key: `repeat:${sig}`, kind: 'repeat', label: last.label, agent: last.agent,
      stepId: last.id, since: endOf(last), count: list.length,
    })
  }

  const inTurn = groupBy(t.steps, (s) => {
    if (s.turnId === undefined) return undefined
    const sig = signatureOf(s)
    return repeats.has(sig) ? undefined : JSON.stringify([s.turnId, sig])
  })
  for (const list of inTurn.values()) {
    if (list.length < 3) continue
    const last = list.reduce((a, b) => (b.seq >= a.seq ? b : a))
    out.push({
      key: `loop:${last.turnId}:${signatureOf(last)}`, kind: 'loop', label: last.label, agent: last.agent,
      stepId: last.id, since: last.startedAt, count: list.length,
    })
  }

  for (const a of subagents(t)) {
    if (a.status !== 'running') continue
    const since = a.lastStepAt ?? a.startedAt
    if (now - since > STALL_MS) out.push({ key: `stalled:${a.id}`, kind: 'stalled', label: a.description || a.type, agent: a.id, since })
  }

  for (const x of t.turns) {
    if (x.failed !== true || x.endedAt === undefined || now - x.endedAt > FAILED_TURN_MS) continue
    out.push({ key: `failed-turn:${x.id}`, kind: 'failed-turn', label: x.prompt, agent: x.agent, since: x.endedAt })
  }

  const quiet = new Set(dismissed)
  return out.filter((p) => !quiet.has(dismissKey(p))).sort((a, b) => b.since - a.since || byKey(a, b))
}

// ---- Find -----------------------------------------------------------------------

/**
 * Steps whose tool, label, agent type or pin note contains `query`,
 * case-insensitive, newest first. A blank query matches every step.
 */
export function findSteps(t: Timeline, query: string): Step[] {
  const q = query.trim().toLowerCase()
  const newestFirst = [...t.steps].sort((a, b) => b.seq - a.seq)
  if (q === '') return newestFirst
  const has = (v: string | undefined) => v !== undefined && v.toLowerCase().includes(q)
  return newestFirst.filter((s) => has(s.tool) || has(s.label) || has(t.agents[s.agent]?.type) || has(s.pin))
}

// ---- Workflow run board -----------------------------------------------------------

export type RunBoard = { run: Run; agents: AgentRow[]; steps: Record<AgentKey, Step[]>; done: number; failed: number; elapsed: number }

const bySpawn = (a: AgentRow, b: AgentRow) =>
  (a.agentIndex ?? Number.MAX_SAFE_INTEGER) - (b.agentIndex ?? Number.MAX_SAFE_INTEGER) || a.startedAt - b.startedAt

/**
 * One workflow run: its agents in spawn order (agentIndex, then start), each
 * agent's steps oldest first, how many agents are done and failed, and the
 * elapsed ms from the run's start: to `now` while an agent runs and `now` is
 * given, else to the newest end or start seen among its agents and steps.
 * Undefined for a run the timeline does not hold.
 */
export function runBoard(t: Timeline, runId: string, now?: number): RunBoard | undefined {
  const run = t.runs[runId]
  if (run === undefined) return undefined
  const agents = subagents(t).filter((a) => a.runId === runId).sort(bySpawn)
  const steps: Record<AgentKey, Step[]> = {}
  for (const a of agents) steps[a.id] = []
  let last = run.startedAt
  for (const s of t.steps) {
    const list = steps[s.agent]
    if (list === undefined) continue
    list.push(s)
    last = Math.max(last, endOf(s))
  }
  for (const list of Object.values(steps)) list.sort((a, b) => a.seq - b.seq)
  for (const a of agents) last = Math.max(last, a.endedAt ?? a.startedAt)
  const running = agents.some((a) => a.status === 'running')
  const to = running && now !== undefined ? now : last
  return {
    run, agents, steps,
    done: agents.filter((a) => a.status === 'done').length,
    failed: agents.filter((a) => a.status === 'error').length,
    elapsed: Math.max(0, to - run.startedAt),
  }
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
      const out: Ev[] = [{ kind: 'turn.end', at, turnId, agent: agentOf(e), answer: typeof e.answer === 'string' ? e.answer : '', failed }]
      const u = usageOf(e.usage)
      if (u !== undefined) out.push({ kind: 'usage', at, agent: agentOf(e), ...u })
      return out
    }
    case 'tool.check': {
      const id = s(e.tool_use_id)
      return id && r.decision === 'ask' ? [{ kind: 'step.ask', at, id }] : []
    }
    case 'session.measure':
      return [{ kind: 'measure', at, budget: budgetOf(e, at) }]
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
      if (!id) return []
      const out: Ev[] = [{ kind: 'agent.start', at, id, parent: s(e.parentAgentId) ?? 'main', type: 'unknown', description: '' }]
      const model = s(r.model)
      if (model) out.push({ kind: 'agent.model', id, model })
      return out
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
        out.push(paired, ...evs.slice(1))
        continue
      }
    }
    out.push(...evs)
  }
  return out
}
