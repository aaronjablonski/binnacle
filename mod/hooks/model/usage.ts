import type { Budget, BudgetWindow, UiState } from '../../types'
import { cut, oneLine } from './label'
import { MAX_DISMISSED, MAX_HITS, MAX_NOTIFIED, MAX_QUERY, MAX_TOASTED, MAX_WINDOW_NAME, MAX_WINDOWS } from './limits'

// What the engine reports about cost and quota, read into the contract's
// shapes. Pure and defensive: the capture hooks and the fixture reader both
// pass the engine's values through here.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A finite, non-negative number, or undefined. */
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

export type Usage = { model?: string; tokensIn: number; tokensOut: number }

/**
 * A turn's `usage` (TurnUsage: ModelUsage plus `model`) as the counts the
 * Agents tab shows. `tokensIn` is the whole input side: uncached input, cache
 * reads and cache writes. Undefined when it carries neither count.
 */
export function usageOf(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined
  const input = count(u.input_tokens)
  const output = count(u.output_tokens)
  if (input === undefined && output === undefined) return undefined
  const out: Usage = {
    tokensIn: (input ?? 0) + (count(u.cache_read_input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0),
    tokensOut: output ?? 0,
  }
  if (typeof u.model === 'string' && u.model.trim() !== '') out.model = u.model
  return out
}

/** One rate-limit window, or undefined when its name or percentage is unusable. */
export function windowOf(w: unknown): BudgetWindow | undefined {
  if (!isObj(w)) return undefined
  const rawName = typeof w.name === 'string' ? w.name : w.kind
  const pct = typeof w.pct === 'number' ? w.pct : w.percentUsed
  if (typeof rawName !== 'string' || typeof pct !== 'number' || !Number.isFinite(pct)) return undefined
  const name = cut(oneLine(rawName), MAX_WINDOW_NAME)
  if (name === '') return undefined
  const out: BudgetWindow = { name, pct }
  const resets = typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) : w.resetsAt
  if (typeof resets === 'number' && Number.isFinite(resets)) out.resetsAt = resets
  return out
}

/** The usable windows, at most MAX_WINDOWS, in the order given. */
export function windowsOf(list: unknown): BudgetWindow[] {
  if (!Array.isArray(list)) return []
  const out: BudgetWindow[] = []
  for (const w of list) {
    if (out.length >= MAX_WINDOWS) break
    const got = windowOf(w)
    if (got !== undefined) out.push(got)
  }
  return out
}

/**
 * A `session.measure` input (SessionMeasureInput) as a Budget measured at
 * `at`: `context.percent`, each `rateLimits[]` window by its `kind` with
 * `percentUsed` and `resetsAt` (ISO 8601, kept as ms), and `cost.usd`.
 */
export function budgetOf(e: unknown, at: number): Budget {
  const m = isObj(e) ? e : {}
  const b: Budget = { windows: windowsOf(m.rateLimits), at }
  const pct = isObj(m.context) ? m.context.percent : undefined
  if (typeof pct === 'number' && Number.isFinite(pct)) b.contextPct = pct
  const usd = isObj(m.cost) ? count(m.cost.usd) : undefined
  if (usd !== undefined) b.costUsd = usd
  return b
}

/** The newest `max` strings of a list; an absent list reads as empty. The same list when nothing is over. */
const newest = (list: string[] | undefined, max: number): string[] => {
  if (!Array.isArray(list)) return []
  return list.length > max ? list.slice(list.length - max) : list
}

/**
 * The pane's state with its lists and query held to their bounds, and any of
 * them (or `runningOnly`) a partial value lacks filled in; the same value
 * when nothing changes.
 */
export function boundUi(u: UiState): UiState {
  const dismissed = newest(u.dismissed, MAX_DISMISSED)
  const notified = newest(u.notified, MAX_NOTIFIED)
  const toasted = newest(u.toasted, MAX_TOASTED)
  const rawQuery: unknown = u.query
  const query = typeof rawQuery !== 'string' ? '' : rawQuery.length > MAX_QUERY ? rawQuery.slice(0, MAX_QUERY) : rawQuery
  const runningOnly = u.runningOnly === true
  const rawHits: unknown = u.hits
  const hits = !Array.isArray(rawHits) ? undefined : rawHits.length > MAX_HITS ? rawHits.slice(0, MAX_HITS) : (rawHits as string[])
  const same = hits === u.hits && dismissed === u.dismissed && notified === u.notified && toasted === u.toasted &&
    query === u.query && runningOnly === u.runningOnly
  if (same) return u
  const next = { ...u, dismissed, notified, toasted, query, runningOnly }
  if (hits === undefined) delete next.hits
  else next.hits = hits
  return next
}
