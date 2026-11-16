import { describe, expect, it } from 'vitest'

import type { Ev, LedgerRow, Timeline } from '../mod/types'
import { dayOf, ledgerCsv, ledgerRow, putRow, readLedger, storedLedger, week } from '../mod/hooks/model/ledger'
import { MAX_LEDGER, MAX_LEDGER_MODELS } from '../mod/hooks/model/limits'
import { empty, reduce } from '../mod/hooks/model/reduce'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)
// Local noon, so the day is the same in any time zone the tests run in.
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime()
const DAY = 86_400_000

const row = (session: string, at: number, tokens: Record<string, number> = { m: 1 }, usd?: number): LedgerRow => {
  const r: LedgerRow = { day: dayOf(at), session, tokens, at }
  if (usd !== undefined) r.usd = usd
  return r
}

describe('ledger', () => {
  it('a row holds the day, the session and tokens in + out by model', () => {
    const t = fold([
      { kind: 'usage', at: 1, agent: 'main', model: 'opus', tokensIn: 100, tokensOut: 10 },
      { kind: 'usage', at: 1, agent: 'a1', model: 'sonnet', tokensIn: 50, tokensOut: 5 },
      { kind: 'usage', at: 1, agent: 'a2', model: 'sonnet', tokensIn: 1, tokensOut: 1 },
    ])
    const at = noon(2026, 11, 15)
    expect(ledgerRow(t, 's1', at, 0.42)).toEqual({ day: '2026-11-15', session: 's1', tokens: { opus: 110, sonnet: 57 }, usd: 0.42, at })
  })

  it('keeps the heaviest models and folds the rest into "other"', () => {
    const evs: Ev[] = []
    for (let i = 0; i < MAX_LEDGER_MODELS + 3; i++) evs.push({ kind: 'usage', at: 1, agent: `a${i}`, model: `m${i}`, tokensIn: 100 + i, tokensOut: 0 })
    const r = ledgerRow(fold(evs), 's', noon(2026, 11, 15))
    expect(Object.keys(r.tokens)).toHaveLength(MAX_LEDGER_MODELS)
    expect(r.tokens.other).toBe(100 + 101 + 102 + 103)
  })

  it('replaces the row of the same session, keeping its first day', () => {
    const first = row('s1', noon(2026, 11, 14))
    const rows = putRow([first], { ...row('s1', noon(2026, 11, 15), { m: 9 }) })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokens).toEqual({ m: 9 })
    expect(rows[0]!.day).toBe('2026-11-14')
  })

  it('is capped at 400 rows, the oldest going first', () => {
    let rows: LedgerRow[] = []
    for (let i = 0; i < MAX_LEDGER + 5; i++) rows = putRow(rows, row(`s${i}`, noon(2026, 1, 1) + i * 1000))
    expect(MAX_LEDGER).toBe(400)
    expect(rows).toHaveLength(MAX_LEDGER)
    expect(rows[0]!.session).toBe('s5')
    expect(rows.at(-1)!.session).toBe(`s${MAX_LEDGER + 4}`)
  })

  it('stays well within the store: 400 rows at their largest under 400,000 characters', () => {
    const tokens: Record<string, number> = {}
    for (let i = 0; i < MAX_LEDGER_MODELS; i++) tokens[`${i}`.padEnd(64, 'm')] = 999_999_999_999_999
    let rows: LedgerRow[] = []
    for (let i = 0; i < MAX_LEDGER; i++) rows = putRow(rows, row(`${i}`.padEnd(200, 's'), 1_800_000_000_000 + i, tokens, 123456.789))
    expect(JSON.stringify(storedLedger(rows)).length).toBeLessThan(400_000)
  })

  it('reads an old or foreign stored shape as empty', () => {
    expect(readLedger(undefined)).toEqual([])
    expect(readLedger([row('s', 1)])).toEqual([])
    expect(readLedger({ v: 0, rows: [row('s', 1)] })).toEqual([])
    expect(readLedger({ v: 1, rows: 'x' })).toEqual([])
    const good = row('s', noon(2026, 11, 15))
    expect(readLedger(storedLedger([good, { day: 7 } as unknown as LedgerRow]))).toEqual([good])
  })

  it('this week: seven days ending today, oldest first, sessions counted', () => {
    const today = noon(2026, 11, 15)
    const rows = [
      row('a', today, { opus: 10 }, 1),
      row('b', today - DAY, { opus: 5, sonnet: 5 }, 0.5),
      row('c', today, { sonnet: 2 }),
      row('old', today - 8 * DAY, { opus: 1000 }),
    ]
    const w = week(rows, today)
    expect(w).toHaveLength(7)
    expect(w[0]!.day).toBe(dayOf(today - 6 * DAY))
    expect(w[6]).toEqual({ day: '2026-11-15', tokens: { opus: 10, sonnet: 2 }, total: 12, sessions: 2, usd: 1 })
    expect(w[5]).toEqual({ day: '2026-11-14', tokens: { opus: 5, sonnet: 5 }, total: 10, sessions: 1, usd: 0.5 })
    expect(w[0]).toEqual({ day: dayOf(today - 6 * DAY), tokens: {}, total: 0, sessions: 0 })
  })

  it('CSV: a header, one line per row and model, cost only when asked', () => {
    const rows = [row('a', noon(2026, 11, 15), { opus: 10, sonnet: 2 }, 1.5)]
    expect(ledgerCsv(rows, false)).toBe('day,session,model,tokens\n2026-11-15,a,opus,10\n2026-11-15,a,sonnet,2\n')
    expect(ledgerCsv(rows, true).split('\n')[0]).toBe('day,session,model,tokens,usd')
  })
})
