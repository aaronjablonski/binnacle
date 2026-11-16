import type { AgentKey, AgentRow, ArtifactRow, Ev, Note, Run, Step, StepFilter, TaskItem, Timeline, TurnRow } from '../../types'
import { dismissKey, needs, signatureOf, watch } from './alerts'
import type { NeedKind, NeedsOptions } from './alerts'
import { sigOf } from './label'
import { FAILED_TURN_MS } from './limits'
import type { RunLimits } from './meter'
import { budgetOf, usageOf } from './usage'

const byStart = (a: { startedAt: number }, b: { startedAt: number }) => a.startedAt - b.startedAt
const subagents = (t: Timeline): AgentRow[] => Object.values(t.agents).filter((a) => a.id !== 'main')

export type TaskNode = { task: TaskItem; agents: { agent: AgentRow; tasks: TaskItem[] }[] }

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

/** Whether `node` or anything under it is one of `ids` (agent ids with a problem). */
export function hasProblemIn(node: TreeNode, ids: Set<string>): boolean {
  if (node.kind === 'agent' && node.agent && ids.has(node.agent.id)) return true
  return node.children.some((c) => hasProblemIn(c, ids))
}

export type TreeLine = { key: string; prefix: string; node: TreeNode; folded: boolean }

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

// ---- Problems: the legacy union the views read until wave 2 -------------------

export type ProblemKind = 'asking' | 'repeat' | 'loop' | 'stalled' | 'failed-turn' | 'long-run'
export type Problem = {
  key: string; kind: ProblemKind; label: string; agent: AgentKey
  stepId?: string; since: number; count?: number
  limitMs?: number; usualMs?: number     // long-run only: the limit it passed, and the median time of finished agents of its type
  sentence?: string                      // the alert model's words for it (alerts.ts)
  need?: NeedKind                        // asking only: which dialog
}

export { dismissKey, signatureOf }

/**
 * The step a permission prompt was raised for: the newest running step of
 * `tool`, not already asking, whose sig matches `input`'s. The prompt names
 * no tool_use_id, so the call is found by what it runs. A step in `agent`'s
 * loop wins; else any loop's. Undefined when none matches.
 */
export function promptedStep(t: Timeline, tool: string, input: unknown, agent: AgentKey): Step | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const sig = sigOf(tool, input as Record<string, unknown>)
  let any: Step | undefined
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const s = t.steps[i]!
    if (s.status !== 'running' || s.asking !== undefined) continue
    if (s.tool !== tool || s.sig !== sig) continue
    if (s.agent === agent) return s
    any ??= s
  }
  return any
}

const endOf = (s: Step): number => s.endedAt ?? s.startedAt
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/**
 * The alert model's needs, watch rows and recent failed turns as one list of
 * problems, newest first, for the views that still read one list (wave 2
 * splits them: `needs`, `watch` and `headerState` in alerts.ts).
 * - `asking`: a need (permission, question, plan, MCP input), by R2 as
 *   `needs` applies it: pass `{ covered: true }` to list every ask at once;
 * - `stalled`: a stalled step or a quiet loop (R6);
 * - `long-run`, `repeat`, `loop`: as `watch`;
 * - `failed-turn`: a turn that ended failed within FAILED_TURN_MS of `now`.
 * A problem whose `dismissKey` is in `dismissed` is left out. The views still
 * offer `x` on an ask until wave 2 removes it; the model's `needs` takes no
 * dismissals (owner ruling 4: no `x` on a permission).
 */
export function problems(t: Timeline, now: number, dismissed: string[], limits?: RunLimits, o: NeedsOptions = {}): Problem[] {
  const out: Problem[] = []
  const labelOfStep = (id: string | undefined) => (id !== undefined ? t.steps.find((s) => s.id === id)?.label : undefined)
  for (const n of needs(t, now, o).items) {
    const p: Problem = { key: n.key, kind: 'asking', label: labelOfStep(n.stepId) ?? n.sentence, agent: n.agent, since: n.since, sentence: n.sentence, need: n.kind }
    if (n.stepId !== undefined) p.stepId = n.stepId
    out.push(p)
  }
  const quiet = new Set(dismissed)
  for (const w of watch(t, now, [], limits)) {
    // A long step has nothing to measure against (R41): a glance on Now's Watch, not a problem the other views flag.
    if (w.kind === 'long-step') continue
    const a = t.agents[w.agent]
    const agentLabel = w.agent === 'main' ? '' : a?.description || a?.type || ''
    const turn = w.agent === 'main' ? [...t.turns].reverse().find((x) => x.agent === 'main') : undefined
    const label = w.stepId !== undefined ? labelOfStep(w.stepId) ?? w.sentence : agentLabel || turn?.prompt || w.sentence
    // A quiet loop keeps the legacy stall's key and time (its last activity), which the views and their dismissals read.
    const isQuiet = w.kind === 'quiet'
    const p: Problem = {
      key: isQuiet ? `stalled:${w.agent}` : w.key, kind: w.kind === 'quiet' ? 'stalled' : w.kind, label, agent: w.agent,
      since: isQuiet ? now - (w.ranMs ?? 0) : w.since, sentence: w.sentence,
    }
    if (w.stepId !== undefined) p.stepId = w.stepId
    if (w.count !== undefined) p.count = w.count
    if (w.limitMs !== undefined) p.limitMs = w.limitMs
    if (w.usualMs !== undefined) p.usualMs = w.usualMs
    out.push(p)
  }
  for (const x of t.turns) {
    if (x.failed !== true || x.endedAt === undefined || now - x.endedAt > FAILED_TURN_MS) continue
    const p: Problem = { key: `failed-turn:${x.id}`, kind: 'failed-turn', label: x.prompt, agent: x.agent, since: x.endedAt }
    out.push(p)
  }
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
// A tool.check line yields nothing: its `ask` is no prompt (auto mode asks before
// its classifier decides), so it marks no step.

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
      const end: Extract<Ev, { kind: 'turn.end' }> = { kind: 'turn.end', at, turnId, agent: agentOf(e), answer: typeof e.answer === 'string' ? e.answer : '', failed }
      if (e.isAborted === true || e.reason === 'aborted') end.aborted = true
      const out: Ev[] = [end]
      const u = usageOf(e.usage)
      const ms = typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0 ? e.durationMs : undefined
      if (u !== undefined) {
        const ev: Extract<Ev, { kind: 'usage' }> = { kind: 'usage', at, agent: agentOf(e), ...u, turnId }
        if (ms !== undefined) ev.ms = ms
        out.push(ev)
      }
      return out
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
