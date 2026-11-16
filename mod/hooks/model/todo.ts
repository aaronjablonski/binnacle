import type { AgentKey, TaskItem, Timeline } from '../../types'

// The to-do block's data (R11 to R14): the lead's list for the current
// request, the counts a subagent's card shows, and the scoping rules. Pure.

/**
 * Whether a task belongs to the conversation that stands: one last written
 * before a `/clear` (`clearedAt`, C1) belongs to the cleared one, whatever
 * its state. Every task when there was no `/clear`.
 */
export function inConversation(x: TaskItem, clearedAt: number | undefined): boolean {
  return clearedAt === undefined || x.updatedAt >= clearedAt
}

/**
 * Whether a lead task belongs to the current request's list: a task completed
 * before `listFrom` (a prompt that started with the whole list done) is
 * "Earlier", and so is every task of a conversation a `/clear` ended
 * (`clearedAt`, C1); every other task is current.
 */
export function inLeadList(x: TaskItem, listFrom: number | undefined, clearedAt?: number): boolean {
  return inConversation(x, clearedAt) && !(listFrom !== undefined && x.status === 'completed' && x.updatedAt < listFrom)
}

/**
 * Whether `owner` keeps its list with the task tools (TaskCreate, TaskUpdate,
 * TodoWrite) in the conversation that stands: then the update tool's `tasks`
 * is ignored for it (R16). A cleared conversation's tasks do not count (C1).
 */
export function usesTaskTools(t: Timeline, owner: AgentKey): boolean {
  return t.tasks.some((x) => x.owner === owner && !x.id.startsWith('list:') && inConversation(x, t.clearedAt))
}

/** Where the lead's list comes from: the task tools, the update tool's `tasks` field, or nowhere yet. */
export type ListSource = 'tools' | 'update' | 'none'

export type TodoBlock = {
  /** The lead's current list, in the order it was written (R11: the lead's only). */
  items: TaskItem[]
  done: number
  total: number
  /** Tasks not completed. */
  open: number
  /** The task in progress (the newest one when several are). */
  current?: TaskItem
  /** The first pending task. */
  next?: TaskItem
  /** The one done row drawn above the current task (R14): the newest completed task. */
  lastDone?: TaskItem
  /** Lead tasks of earlier requests, folded away (the Tasks tab's "Earlier"). */
  earlier: TaskItem[]
  /** No list for this request: the block draws its head and "No to-do list for this request" (R12). */
  empty: boolean
  /** True while a need blocks the current task (R5): the asker is the lead, or nothing else is running. */
  paused: boolean
  source: ListSource
  /** When the current request began: the newest main turn's start; undefined before any. */
  since?: number
}

/** The words the empty To do block draws (R12). */
export const NO_LIST_TEXT = 'No to-do list for this request'

/**
 * The lead's to-do block. `askers` are the agents with an open need
 * (`needs(...).items.map(n => n.agent)`); paused follows R5.
 */
/**
 * An owner's tasks in their current list. Where the task tools wrote any, the
 * field's `list:` items are left out (R16: never merged; heals a timeline an
 * earlier build stored with both).
 */
function ownList(t: Timeline, owner: AgentKey): TaskItem[] {
  const all = t.tasks.filter((x) => x.owner === owner && (owner !== 'main' ? inConversation(x, t.clearedAt) : inLeadList(x, t.listFrom, t.clearedAt)))
  return all.some((x) => !x.id.startsWith('list:')) ? all.filter((x) => !x.id.startsWith('list:')) : all
}

export function todoBlock(t: Timeline, askers: readonly AgentKey[] = []): TodoBlock {
  const lead = t.tasks.filter((x) => x.owner === 'main')
  const items = ownList(t, 'main')
  const earlier = lead.filter((x) => !inLeadList(x, t.listFrom, t.clearedAt))
  let current: TaskItem | undefined
  let lastDone: TaskItem | undefined
  for (const x of items) {
    if (x.status === 'in_progress' && (current === undefined || x.updatedAt >= current.updatedAt)) current = x
    if (x.status === 'completed' && (lastDone === undefined || x.updatedAt >= lastDone.updatedAt)) lastDone = x
  }
  const next = items.find((x) => x.status === 'pending')
  const done = items.filter((x) => x.status === 'completed').length
  const othersRunning = Object.values(t.agents).some((a) => a.id !== 'main' && a.status === 'running')
  const paused = current !== undefined && askers.length > 0 && (askers.includes('main') || !othersRunning)
  const source: ListSource = items.length === 0 ? 'none' : items.some((x) => !x.id.startsWith('list:')) ? 'tools' : 'update'
  const out: TodoBlock = { items, done, total: items.length, open: items.length - done, earlier, empty: items.length === 0, paused, source }
  if (current !== undefined) out.current = current
  if (next !== undefined) out.next = next
  if (lastDone !== undefined) out.lastDone = lastDone
  for (let i = t.turns.length - 1; i >= 0; i--) {
    if (t.turns[i]!.agent === 'main') {
      out.since = t.turns[i]!.startedAt
      break
    }
  }
  return out
}

/** A subagent's own list as its card counts it ("3 of 5", R11); total 0 when it keeps none. */
export function listCounts(t: Timeline, agent: AgentKey): { done: number; total: number } {
  const items = ownList(t, agent)
  return { done: items.filter((x) => x.status === 'completed').length, total: items.length }
}

/**
 * M14: the words the Effort block says once, dim, while a task's tokens are
 * still to come. The model has no live per-task tokens: a main turn's usage
 * arrives with `turn.complete` and goes to the task in progress then
 * (reduce.ts `addUsage`), so during one long turn Effort stays flat.
 */
export const EFFORT_LATER_TEXT = 'counted when the turn ends'

/** Whether the lead's turn is running with a task in progress, whose tokens are counted only when the turn ends (M14). */
export function effortCountedLater(t: Timeline): boolean {
  let lead: Timeline['turns'][number] | undefined
  for (const x of t.turns) if (x.agent === 'main' && (lead === undefined || x.startedAt >= lead.startedAt)) lead = x
  return lead !== undefined && lead.endedAt === undefined && todoBlock(t).current !== undefined
}
