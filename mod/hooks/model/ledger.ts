import type { LedgerRow, Timeline } from '../../types'
import { cut, oneLine } from './label'
import { MAX_LEDGER, MAX_LEDGER_MODELS, MAX_LEDGER_SESSION, MAX_MODEL } from './limits'

// The ledger: one row per session in `$.store`, our own history across
// sessions (no API exposes Claude Code's). Pure: state.ts reads and writes
// the store; these build, bound and read the rows.

/** The `$.store` key the ledger lives under. */
export const LEDGER_KEY = 'mission-control:ledger'
/** The stored value's version: anything else stored under the key reads as an empty ledger. */
const VERSION = 1

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const pad = (n: number): string => String(n).padStart(2, '0')

/** The local day of a time, as YYYY-MM-DD. */
export function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Tokens by model with at most MAX_LEDGER_MODELS names: past that the lightest fold into `other`. */
function boundModels(tokens: Record<string, number>): Record<string, number> {
  const entries = Object.entries(tokens).sort((a, b) => b[1] - a[1])
  if (entries.length <= MAX_LEDGER_MODELS) return Object.fromEntries(entries)
  const kept = entries.filter(([m]) => m !== 'other').slice(0, MAX_LEDGER_MODELS - 1)
  const keptNames = new Set(kept.map(([m]) => m))
  let other = 0
  for (const [m, n] of entries) if (!keptNames.has(m)) other += n
  return Object.fromEntries([...kept, ['other', other]])
}

/**
 * The session's row as the timeline stands: tokens in + out summed by each
 * agent's model (`unknown` without one), its day, and its cost when given.
 * Agents the timeline dropped past its bound are not counted.
 */
export function ledgerRow(t: Timeline, session: string, at: number, usd?: number): LedgerRow {
  const tokens: Record<string, number> = {}
  for (const a of Object.values(t.agents)) {
    const n = (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
    if (n <= 0) continue
    const model = a.model ?? 'unknown'
    tokens[model] = (tokens[model] ?? 0) + n
  }
  const row: LedgerRow = { day: dayOf(at), session: cut(oneLine(session), MAX_LEDGER_SESSION), tokens: boundModels(tokens), at }
  if (count(usd)) row.usd = usd
  return row
}

/**
 * The rows with `row` in: it replaces the row of its session, which keeps its
 * first day, or is added; past MAX_LEDGER the oldest (by `at`) go.
 */
export function putRow(rows: LedgerRow[], row: LedgerRow): LedgerRow[] {
  const i = rows.findIndex((r) => r.session === row.session)
  let next: LedgerRow[]
  if (i >= 0) next = rows.map((r, j) => (j === i ? { ...row, day: r.day } : r))
  else next = [...rows, row]
  if (next.length <= MAX_LEDGER) return next
  const order = next.map((r, j) => ({ j, at: r.at })).sort((a, b) => a.at - b.at)
  const drop = new Set(order.slice(0, next.length - MAX_LEDGER).map((r) => r.j))
  return next.filter((_, j) => !drop.has(j))
}

/** One stored row, or undefined when its shape is not a ledger row's. */
function rowOf(v: unknown): LedgerRow | undefined {
  if (!isObj(v)) return undefined
  if (typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day)) return undefined
  if (typeof v.session !== 'string' || v.session === '' || !count(v.at) || !isObj(v.tokens)) return undefined
  const tokens: Record<string, number> = {}
  for (const [m, n] of Object.entries(v.tokens)) if (count(n)) tokens[cut(m, MAX_MODEL)] = n
  const row: LedgerRow = { day: v.day, session: cut(v.session, MAX_LEDGER_SESSION), tokens: boundModels(tokens), at: v.at }
  if (count(v.usd)) row.usd = v.usd
  return row
}

/** The rows a stored value holds: an old or foreign shape reads as none, and a bad row is skipped; at most MAX_LEDGER, the newest. */
export function readLedger(v: unknown): LedgerRow[] {
  if (!isObj(v) || v.v !== VERSION || !Array.isArray(v.rows)) return []
  const rows: LedgerRow[] = []
  for (const r of v.rows) {
    const got = rowOf(r)
    if (got !== undefined) rows.push(got)
  }
  return rows.length > MAX_LEDGER ? rows.slice(rows.length - MAX_LEDGER) : rows
}

/** The value written to the store for these rows. */
export function storedLedger(rows: LedgerRow[]): { v: number; rows: LedgerRow[] } {
  return { v: VERSION, rows }
}

export type LedgerDay = { day: string; tokens: Record<string, number>; total: number; sessions: number; usd?: number }

/** The seven local days ending on `now`'s, oldest first: tokens by model, their total, sessions counted and cost (when any row had one). */
export function week(rows: LedgerRow[], now: number): LedgerDay[] {
  const days: LedgerDay[] = []
  const today = new Date(now)
  for (let back = 6; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12)
    days.push({ day: dayOf(d.getTime()), tokens: {}, total: 0, sessions: 0 })
  }
  const byDay = new Map(days.map((d) => [d.day, d]))
  for (const r of rows) {
    const d = byDay.get(r.day)
    if (d === undefined) continue
    d.sessions++
    for (const [m, n] of Object.entries(r.tokens)) {
      d.tokens[m] = (d.tokens[m] ?? 0) + n
      d.total += n
    }
    if (r.usd !== undefined) d.usd = (d.usd ?? 0) + r.usd
  }
  return days
}

const csvCell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/** The rows as CSV: one line per row and model, oldest first; the session's cost on its first line when `withCost`. */
export function ledgerCsv(rows: LedgerRow[], withCost: boolean): string {
  let out = withCost ? 'day,session,model,tokens,usd\n' : 'day,session,model,tokens\n'
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    Object.entries(r.tokens).forEach(([m, n], i) => {
      const cells = [r.day, csvCell(r.session), csvCell(m), String(n)]
      if (withCost) cells.push(i === 0 && r.usd !== undefined ? String(r.usd) : '')
      out += `${cells.join(',')}\n`
    })
  }
  return out
}
