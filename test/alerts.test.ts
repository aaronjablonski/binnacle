import { describe, expect, it } from 'vitest'

import type { Ev, Timeline } from '../mod/types'
import {
  agentName, alertNotes, answeredAsks, askedVerb, autoFocuses, CHECKING_TEXT, headerState, needs, settledAsks, spanText, watch,
} from '../mod/hooks/model/alerts'
import { ASK_MS, NOTIFY_ASK_MS, QUIET_MS, WATCH_NOTIFY_MS } from '../mod/hooks/model/limits'
import { empty, reduce } from '../mod/hooks/model/reduce'
import { listCounts, NO_LIST_TEXT, todoBlock } from '../mod/hooks/model/todo'

const fold = (evs: Ev[], from: Timeline = empty): Timeline => evs.reduce(reduce, from)
const MIN = 60_000
let clock = 10_000_000
const at = () => ++clock
const start = (id: string, tool: string, input: Record<string, unknown> = {}, agent = 'main', when = at()): Ev =>
  ({ kind: 'step.start', at: when, id, agent, tool, input })
const end = (id: string, status: 'done' | 'error' = 'done', when = at()): Ev => ({ kind: 'step.end', at: when, id, status })
const spawn = (id: string, type = 'Explore', when = at()): Ev => ({ kind: 'agent.start', at: when, id, parent: 'main', type, description: `desc ${id}` })
const turnStart = (turnId: string, when = at(), prompt = turnId): Ev => ({ kind: 'turn.start', at: when, turnId, agent: 'main', prompt })
const turnEnd = (turnId: string, extra: Partial<Extract<Ev, { kind: 'turn.end' }>> = {}, when = at()): Ev =>
  ({ kind: 'turn.end', at: when, turnId, agent: 'main', answer: '', failed: false, ...extra })
const ask = (id: string, auto = false, when = at()): Ev => ({ kind: 'step.ask', at: when, id, auto })
const list = (agent: string, items: [string, 'todo' | 'doing' | 'done'][], when = at()): Ev =>
  ({ kind: 'update', at: when, agent, update: { tasks: items.map(([title, state]) => ({ title, state })) } })
const UI = { notified: [] as string[], dismissed: [] as string[] }

describe('needs', () => {
  it('a permission request is one need with its tool, command and asker, and clears when its step ends', () => {
    const t = fold([spawn('a1', 'general-purpose'), start('s1', 'Bash', { command: 'npm run deploy -- --env staging' }, 'a1'), ask('s1')])
    const v = needs(t, clock)
    expect(v.checking).toBe(false)
    expect(v.items).toHaveLength(1)
    expect(v.items[0]).toMatchObject({
      key: 'asking:s1', kind: 'permission', agent: 'a1', tool: 'Bash', command: 'npm run deploy -- --env staging',
      asker: 'General', askerAmbiguous: false, who: 'General', verb: 'asks to run a command', sentence: 'General asks to run a command',
    })
    expect(watch(t, clock)).toEqual([])
    expect(needs(fold([end('s1')], t), clock).items).toEqual([])
  })

  it('R4: two running steps with one tool and input do not name the asker', () => {
    const t = fold([spawn('a1'), spawn('a2'), start('s1', 'Bash', { command: 'npm test' }, 'a1'), start('s2', 'Bash', { command: 'npm test' }, 'a2'), ask('s2')])
    const [n] = needs(t, clock).items
    expect([n!.asker, n!.askerAmbiguous, n!.who, n!.sentence]).toEqual(['Explorer', true, 'An agent', 'An agent asks to run a command'])
  })

  // C-1 (meaning changed): an uncovered auto-mode ask no longer becomes a need at ASK_MS; it stays "Checking a
  // permission" (the classifier may have allowed it) until the clock settles it from what the pane saw (settledAsks).
  it('R2, C-1: in auto mode an uncovered ask is only "Checking a permission", however long; covered, or outside auto, it shows at once', () => {
    const t = fold([start('s1', 'Bash', { command: 'ls' }), ask('s1', true, 1000)])
    expect(t.autoAsk).toBe(true)
    expect(needs(t, 1000 + ASK_MS - 1)).toEqual({ items: [], checking: true })
    expect(CHECKING_TEXT).toBe('Checking a permission')
    expect(needs(t, 1000 + ASK_MS - 1, { covered: true }).items).toHaveLength(1)
    expect(needs(t, 1000 + ASK_MS)).toEqual({ items: [], checking: true })
    expect(needs(t, 1000 + 25_000)).toEqual({ items: [], checking: true })
    expect(needs(t, 1000 + 5 * MIN, { watching: true })).toEqual({ items: [], checking: true })
    const manual = fold([start('s2', 'Bash', { command: 'ls' }), ask('s2', false, 2000)])
    expect(manual.autoAsk).toBeUndefined()
    expect(needs(manual, 2001).items.map((n) => n.key)).toEqual(['asking:s2'])
  })

  it('I-1: with no pane watching, a permission is a need for its first minute, then a dim "asked"; auto mode: checked for 20 s, then the same', () => {
    const manual = fold([start('s1', 'Bash', { command: 'cargo build' }, 'main', 0), ask('s1', false, 0)])
    expect(needs(manual, NOTIFY_ASK_MS - 1, { watching: false }).items.map((n) => n.key)).toEqual(['asking:s1'])
    const late = needs(manual, NOTIFY_ASK_MS, { watching: false })
    expect([late.items, late.checking, late.asked?.map((n) => n.key)]).toEqual([[], false, ['asking:s1']])
    expect(askedVerb(late.asked![0]!)).toBe('asked to run a command')
    // The pane watching (or the option left out) changes nothing: the clock clears what it saw answered.
    expect(needs(manual, 10 * MIN, { watching: true }).items).toHaveLength(1)
    expect(needs(manual, 10 * MIN).asked).toBeUndefined()
    const auto = fold([start('s2', 'Bash', { command: 'npm test' }, 'main', 0), ask('s2', true, 0)])
    expect(needs(auto, ASK_MS - 1, { watching: false })).toEqual({ items: [], checking: true })
    const after = needs(auto, ASK_MS, { watching: false })
    expect([after.items, after.checking, after.asked?.map((n) => n.key)]).toEqual([[], false, ['asking:s2']])
    // Exact asks stay as they are: an Agent ask clears at its spawn, a question or plan with its dialog.
    const agent = fold([start('s3', 'Agent', { description: 'x' }, 'main', 0), ask('s3', false, 0)])
    expect(needs(agent, 10 * MIN, { watching: false }).items.map((n) => n.key)).toEqual(['asking:s3'])
    const q = fold([start('q1', 'AskUserQuestion', { questions: [] }, 'main', 0)])
    expect(needs(q, 10 * MIN, { watching: false }).items.map((n) => n.kind)).toEqual(['question'])
  })

  it('C-1: an ask the pane watched uncovered for 20 s, from the ask or from the start of its watch, is settled; a question never', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' }, 'main', 0), ask('s1', true, 1000), start('q1', 'AskUserQuestion', { questions: [] }, 'main', 0), ask('q1', false, 1000)])
    expect(settledAsks(t, 1000 + ASK_MS - 1, 0)).toEqual([])
    expect(settledAsks(t, 1000 + ASK_MS, 0)).toEqual(['s1'])
    // The pane began watching after the ask: 20 s from then.
    expect(settledAsks(t, 5000 + ASK_MS - 1, 5000)).toEqual([])
    expect(settledAsks(t, 5000 + ASK_MS, 5000)).toEqual(['s1'])
    expect(settledAsks(t, 10 * MIN, undefined)).toEqual([])
  })

  it('R1: a question, a plan and an MCP input request each have their own sentence', () => {
    const t = fold([
      start('q', 'AskUserQuestion', { questions: [] }, 'main', 100),
      start('p', 'ExitPlanMode', { plan: 'x' }, 'main', 200),
      { kind: 'input.ask', at: 300, id: 'el1', agent: 'main', server: 'github', message: 'Pick a repo' },
    ])
    expect(needs(t, 400).items.map((n) => [n.kind, n.sentence])).toEqual([
      ['question', 'Claude asks you a question'],
      ['plan', 'Claude has a plan for you to approve'],
      ['input', 'github asks for input'],
    ])
    const answered = fold([{ kind: 'input.done', id: 'el1', server: 'github' }, end('q'), end('p')], t)
    expect(needs(answered, 500).items).toEqual([])
  })

  it('an input request does not outlive its turn', () => {
    const t = fold([turnStart('t1'), { kind: 'input.ask', at: at(), id: '', agent: 'main', server: 'db', message: 'm' }])
    expect(needs(t, clock).items).toHaveLength(1)
    expect(fold([turnEnd('t1')], t).asks).toBeUndefined()
  })

})

describe('watch', () => {
  it('a thinking agent (no step, under ten minutes) yields neither a need nor a row', () => {
    const t = fold([spawn('a1', 'Explore', 0)])
    expect(needs(t, 9 * MIN).items).toEqual([])
    expect(watch(t, 9 * MIN)).toEqual([])
  })

  it('quiet: a running loop with no step and no activity for ten minutes; the lead too', () => {
    const t = fold([spawn('a1', 'Explore', 0)])
    const got = watch(t, QUIET_MS + 1)
    expect(got.map((w) => [w.kind, w.agent, w.sentence])).toEqual([['quiet', 'a1', 'Explorer: no activity for 10 min, may be thinking']])
    const lead = fold([turnStart('t1', 0)])
    expect(watch(lead, QUIET_MS + 1).map((w) => [w.kind, w.agent])).toEqual([['quiet', 'main']])
    // The lead is not quiet while a subagent runs, nor while a step runs.
    expect(watch(fold([spawn('a2', 'Explore', QUIET_MS)], lead), QUIET_MS + 1).some((w) => w.agent === 'main')).toBe(false)
    expect(watch(fold([start('s', 'Bash', { command: 'sleep' }, 'main', 1)], lead), QUIET_MS + 2).some((w) => w.kind === 'quiet')).toBe(false)
  })

  it('stalled: one step past 5 min and past 3x the median of earlier runs of the same call; with none, a Long step (R41)', () => {
    const base = fold([
      start('b1', 'Bash', { command: 'npm test' }, 'main', 0), end('b1', 'done', 2 * MIN),
      start('b2', 'Bash', { command: 'npm test' }, 'main', 2 * MIN), end('b2', 'done', 4 * MIN),
      start('b3', 'Bash', { command: 'npm test' }, 'main', 4 * MIN),
    ])
    // median 2 min: 3x is 6 min.
    expect(watch(base, 4 * MIN + 6 * MIN).some((w) => w.kind === 'stalled')).toBe(false)
    const got = watch(base, 4 * MIN + 14 * MIN).filter((w) => w.kind === 'stalled')
    expect(got.map((w) => w.sentence)).toEqual(['Claude: npm test has run 14 min'])
    expect(watch(base, 4 * MIN + 14 * MIN).some((w) => w.kind === 'long-step')).toBe(false)
    // No earlier run of the call: past 5 min it is a Long step, never Stalled.
    const first = fold([start('g', 'Grep', { pattern: 'x' }, 'main', 0)])
    expect(watch(first, 5 * MIN).some((w) => w.kind === 'stalled' || w.kind === 'long-step')).toBe(false)
    expect(watch(first, 5 * MIN + 1).some((w) => w.kind === 'stalled')).toBe(false)
    expect(watch(first, 5 * MIN + 1).filter((w) => w.kind === 'long-step').map((w) => [w.key, w.sentence])).toEqual([['long-step:g', 'Claude: "x" has run 5 min']])
    // Quick runs of other commands of the same tool are no history: `npm run build` after three fast `ls` is a Long step.
    const other = fold([
      start('l1', 'Bash', { command: 'ls' }, 'main', 0), end('l1', 'done', 1000),
      start('l2', 'Bash', { command: 'ls' }, 'main', 2000), end('l2', 'done', 3000),
      start('nb', 'Bash', { command: 'npm run build' }, 'main', 4000),
    ])
    expect(watch(other, 4000 + 6 * MIN).map((w) => w.kind)).toEqual(['long-step'])
    // An Agent call runs as long as its agent: never stalled.
    expect(watch(fold([start('ag', 'Agent', {}, 'main', 0)]), 60 * MIN).some((w) => w.kind === 'stalled' || w.kind === 'long-step')).toBe(false)
  })

  it('long run: 60 min an agent and 120 a turn by default, 0 disables; never a need', () => {
    const t = fold([spawn('a1', 'Explore', 0), start('s', 'Read', { file_path: 'a' }, 'a1', 0), end('s', 'done', 1), turnStart('t1', 0)])
    const busy = (now: number) => fold([start(`r${now}`, 'Read', { file_path: String(now) }, 'a1', now - 1000)], t)
    expect(watch(busy(59 * MIN), 59 * MIN).some((w) => w.kind === 'long-run')).toBe(false)
    const at64 = busy(64 * MIN)
    const rows = watch(at64, 64 * MIN).filter((w) => w.kind === 'long-run')
    // M2: one unit beside the limit while under 2 h.
    expect(rows.map((w) => w.sentence)).toEqual(['Explorer has run 64 min (limit 60)'])
    expect(watch(at64, 64 * MIN, [], { agentLimitMin: 0 }).some((w) => w.kind === 'long-run')).toBe(false)
    const late = busy(121 * MIN)
    expect(watch(late, 121 * MIN).filter((w) => w.key.startsWith('long-run:turn')).map((w) => w.sentence)).toEqual(['This turn has run 2 h 1 min (limit 120)'])
    expect(watch(late, 121 * MIN, [], { agentLimitMin: 0, turnLimitMin: 0 }).some((w) => w.kind === 'long-run')).toBe(false)
    expect(needs(late, 121 * MIN).items).toEqual([])
  })

  it('repeat and loop are Watch rows with words; a dismissed one returns when its count grows', () => {
    const t = fold([
      turnStart('t1'),
      start('a', 'Bash', { command: 'npm test' }), end('a', 'error'),
      start('b', 'Bash', { command: 'npm test' }), end('b', 'error'),
      start('c', 'Grep', { pattern: 'x' }), end('c'), start('d', 'Grep', { pattern: 'x' }), end('d'), start('e', 'Grep', { pattern: 'x' }), end('e'),
    ])
    const got = watch(t, clock)
    expect(got.map((w) => [w.kind, w.sentence])).toEqual([
      ['loop', 'Claude: "x" ran 3 times this turn'],
      ['repeat', 'Claude: npm test failed 2 times in a row'],
    ])
    const key = `${got[1]!.key}#2`
    expect(watch(t, clock, [key]).map((w) => w.kind)).toEqual(['loop'])
    const grown = fold([start('f', 'Bash', { command: 'npm test' }), end('f', 'error')], t)
    expect(watch(grown, clock, [key]).some((w) => w.kind === 'repeat')).toBe(true)
    expect(needs(grown, clock).items).toEqual([])
  })

  it('a failed turn is neither a need nor a Watch row: the header says stopped with the reason', () => {
    const t = fold([turnStart('t1'), turnEnd('t1', { failed: true, reason: 'Claude declined: policy' })])
    expect(needs(t, clock).items).toEqual([])
    expect(watch(t, clock)).toEqual([])
    expect(headerState(t, clock, needs(t, clock))).toMatchObject({ state: 'stopped', reason: 'Claude declined: policy' })
    // An interrupt is not a failure.
    const aborted = fold([turnStart('t2'), turnEnd('t2', { failed: true, aborted: true })])
    expect(headerState(aborted, clock, needs(aborted, clock)).state).not.toBe('stopped')
  })
})

describe('Watch never leads the band, never autoFocuses, never notifies', () => {
  const quiet = fold([spawn('a1', 'Explore', 0), turnStart('t0', 0)])
  const now = QUIET_MS + WATCH_NOTIFY_MS + 1

  it('the band lead is a need only', () => {
    expect(watch(quiet, now).length > 0).toBe(true)
    // M11: `bandLead` (the first need) is gone; the band leads with `needs(...).items[0]`.
    expect(needs(quiet, now).items[0]).toBeUndefined()
    const asking = fold([start('s1', 'Bash', { command: 'x' }, 'main', now - 1), ask('s1', false, now - 1)], quiet)
    expect(needs(asking, now).items[0]?.key).toBe('asking:s1')
  })

  it('autoFocus is for needs only', () => {
    for (const k of ['permission', 'question', 'plan', 'input'] as const) expect(autoFocuses(k)).toBe(true)
    for (const k of ['stalled', 'long-step', 'quiet', 'long-run', 'repeat', 'loop', 'failed-turn'] as const) expect(autoFocuses(k)).toBe(false)
  })

  it('R41: a Long step never notifies, even with watchNotify; a Stalled step does', () => {
    const long = fold([start('nb', 'Bash', { command: 'npm run build' }, 'main', 0)])
    const at = 5 * MIN + WATCH_NOTIFY_MS + 1
    expect(watch(long, at).map((w) => w.kind)).toEqual(['long-step'])
    expect(alertNotes(long, UI, at, { mode: 'all', watchNotify: true, freshMs: 15_000 })).toEqual([])
    const stalled = fold([
      start('b1', 'Bash', { command: 'npm test' }, 'main', 0), end('b1', 'done', MIN),
      start('b2', 'Bash', { command: 'npm test' }, 'main', MIN),
    ])
    const later = MIN + 5 * MIN + WATCH_NOTIFY_MS + 1
    expect(alertNotes(stalled, UI, later, { mode: 'all', watchNotify: true, freshMs: 15_000 }).map((n) => n.id)).toEqual(['watch:stalled:b2'])
  })

  it('no notification for a Watch row unless watchNotify, and then once after 10 min', () => {
    expect(alertNotes(quiet, UI, now, { mode: 'all', freshMs: 15_000 })).toEqual([])
    const on = alertNotes(quiet, UI, now, { mode: 'all', watchNotify: true, freshMs: 15_000 })
    expect(on.map((n) => n.text)).toEqual(['Watch: Explorer: no activity for 20 min, may be thinking'])
    expect(alertNotes(quiet, { ...UI, notified: on.map((n) => n.id) }, now, { mode: 'all', watchNotify: true, freshMs: 15_000 })).toEqual([])
    expect(alertNotes(quiet, UI, QUIET_MS + WATCH_NOTIFY_MS - 1000, { mode: 'all', watchNotify: true, freshMs: 15_000 })).toEqual([])
  })

  it('C-1: an auto-mode ask notifies only once the pane sees its dialog; never while it is only checked', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' }, 'main', 0), ask('s1', true, 0)])
    expect(alertNotes(t, UI, 10 * MIN, { freshMs: 15_000, watching: true })).toEqual([])
    expect(alertNotes(t, UI, 59_000, { freshMs: 15_000, watching: true, covered: true })).toEqual([])
    expect(alertNotes(t, UI, 60_000, { freshMs: 15_000, watching: true, covered: true })).toEqual([{ id: 's1', text: 'Waiting on you: Bash npm test' }])
  })

  it('a need notifies after a minute (20 s on Agent), a fresh failed turn with all', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' }, 'main', 0), ask('s1', false, 0)])
    expect(alertNotes(t, UI, 59_000, { freshMs: 15_000, watching: true })).toEqual([])
    expect(alertNotes(t, UI, 60_000, { freshMs: 15_000, watching: true })).toEqual([{ id: 's1', text: 'Waiting on you: Bash npm test' }])
    const agent = fold([start('s2', 'Agent', { description: 'find callers' }, 'main', 0), ask('s2', false, 0)])
    expect(alertNotes(agent, UI, ASK_MS, { freshMs: 15_000 }).map((n) => n.id)).toEqual(['s2'])
    const f = fold([turnStart('tf', 0), turnEnd('tf', { failed: true }, 1000)])
    expect(alertNotes(f, UI, 2000, { mode: 'waits', freshMs: 15_000 })).toEqual([])
    expect(alertNotes(f, UI, 2000, { mode: 'all', freshMs: 15_000 }).map((n) => n.id)).toEqual(['failed-turn:tf'])
  })
})

describe('an answered ask (F C1)', () => {
  it('the pane saw the dialog cover the prompt and then close: the ask is answered, and only that one', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm run deploy' }), ask('s1'), start('s2', 'Bash', { command: 'ls' }), ask('s2')])
    // s1 seen covered by drawing 3; s2 never seen covered.
    expect(answeredAsks(t, new Map([['s1', 3]]), 4)).toEqual(['s1'])
    expect(answeredAsks(t, new Map([['s1', 3]]), 3)).toEqual([])
    expect(answeredAsks(t, new Map([['s1', 3]]), 2)).toEqual([])
    expect(answeredAsks(t, new Map([['s1', 3]]), undefined)).toEqual([])
    // A question or a plan lasts as long as its own step: the pane never answers it.
    const q = fold([start('q1', 'AskUserQuestion', { questions: [] }), ask('q1')])
    expect(answeredAsks(q, new Map([['q1', 1]]), 2)).toEqual([])
  })

  it('after step.unask the step keeps running and nothing needs you: the header works, the band leads with nothing, no notification', () => {
    const t = fold([turnStart('tr', 0), start('s1', 'Bash', { command: 'npm run deploy -- --env staging' }, 'main', 0), ask('s1', false, 0)])
    expect(needs(t, 1000).items.map((n) => n.key)).toEqual(['asking:s1'])
    const answered = fold([{ kind: 'step.unask', id: 's1' }], t)
    const s1 = answered.steps.find((s) => s.id === 's1')!
    expect([s1.status, s1.asking]).toEqual(['running', undefined])
    const at = 3 * MIN
    const view = needs(answered, at)
    expect(view).toEqual({ items: [], checking: false })
    expect(headerState(answered, at, view).state).toBe('working')
    expect(view.items[0]).toBeUndefined()
    expect(alertNotes(answered, UI, at, { mode: 'all', freshMs: 15_000, watching: true })).toEqual([])
  })

  it('with no pane watching, a permission on a running step never notifies; an Agent ask, a question and an input request still do', () => {
    const t = fold([start('s1', 'Bash', { command: 'npm test' }, 'main', 0), ask('s1', false, 0)])
    expect(alertNotes(t, UI, 10 * MIN, { freshMs: 15_000 })).toEqual([])
    expect(alertNotes(t, UI, 10 * MIN, { freshMs: 15_000, watching: false })).toEqual([])
    const q = fold([start('q1', 'AskUserQuestion', { questions: [] }, 'main', 0)])
    expect(alertNotes(q, UI, MIN, { freshMs: 15_000 }).map((n) => n.id)).toEqual(['q1'])
    const input = fold([{ kind: 'input.ask', at: 0, id: 'el1', agent: 'main', server: 'github', message: 'Pick' }])
    expect(alertNotes(input, UI, MIN, { freshMs: 15_000 }).map((n) => n.id)).toEqual(['input:el1'])
  })
})

describe('headerState', () => {
  it('I-3: no "quiet" while a step runs, however long; quiet counts from the last step end once none runs', () => {
    const t = fold([turnStart('t1', 0), start('e2e', 'Bash', { command: 'npm run e2e' }, 'main', 0)])
    expect(headerState(t, 6 * MIN, needs(t, 6 * MIN))).toMatchObject({ state: 'working', quiet: 'none' })
    expect(headerState(t, 6 * MIN, needs(t, 6 * MIN)).quietMs).toBeUndefined()
    const ended = fold([end('e2e', 'done', 7 * MIN)], t)
    expect(headerState(ended, 7 * MIN + 2 * MIN, needs(ended, 9 * MIN))).toMatchObject({ quiet: 'dim', quietMs: 2 * MIN })
  })

  it('working with the turn time; quiet dim from 2 min, bold from 5', () => {
    const t = fold([turnStart('t1', 0), start('s', 'Read', { file_path: 'a' }, 'main', 0), end('s', 'done', 1000)])
    const h = (now: number) => headerState(t, now, needs(t, now))
    expect(h(60_000)).toMatchObject({ state: 'working', turnMs: 60_000, quiet: 'none' })
    expect(h(1000 + 2 * MIN)).toMatchObject({ quiet: 'dim', quietMs: 2 * MIN })
    expect(h(1000 + 6 * MIN).quiet).toBe('bold')
  })

  it('waiting while a need is up; idle-open when the turn ended with tasks open; all-done when the list is complete; idle with no list', () => {
    const asking = fold([turnStart('t1', 0), start('s', 'Bash', { command: 'x' }, 'main', 0), ask('s', false, 0)])
    expect(headerState(asking, 10, needs(asking, 10)).state).toBe('waiting')
    const open = fold([turnStart('t2', 0), list('main', [['A', 'done'], ['B', 'todo'], ['C', 'todo'], ['D', 'todo']], 1), turnEnd('t2', {}, 2)])
    expect(headerState(open, 10, needs(open, 10))).toMatchObject({ state: 'idle-open', open: 3 })
    const done = fold([list('main', [['A', 'done'], ['B', 'done']], 3)], open)
    expect(headerState(done, 10, needs(done, 10)).state).toBe('all-done')
    const none = fold([turnStart('t3', 0), turnEnd('t3', {}, 1)])
    expect(headerState(none, 10, needs(none, 10)).state).toBe('idle')
  })
})

describe('to-do block', () => {
  it('the header count is the lead\'s list only; a subagent\'s list is on its card', () => {
    const t = fold([turnStart('t1'), list('main', [['Read the route', 'done'], ['Write the limiter', 'doing'], ['Test it', 'todo']]), spawn('a1'), list('a1', [['Scan', 'done'], ['Report', 'todo']])])
    const b = todoBlock(t)
    expect([b.done, b.total, b.open, b.current?.subject, b.next?.subject, b.lastDone?.subject, b.source]).toEqual([1, 3, 2, 'Write the limiter', 'Test it', 'Read the route', 'update'])
    expect(listCounts(t, 'a1')).toEqual({ done: 1, total: 2 })
    expect(listCounts(t, 'main')).toEqual({ done: 1, total: 3 })
  })

  it('a list belongs to one request: a new prompt with every task done folds it into Earlier; no list is the empty state', () => {
    const t = fold([turnStart('t1'), list('main', [['A', 'done'], ['B', 'done']]), turnEnd('t1')])
    const next = fold([turnStart('t2')], t)
    const b = todoBlock(next)
    expect([b.empty, b.total, b.earlier.map((x) => x.subject)]).toEqual([true, 0, ['A', 'B']])
    expect(NO_LIST_TEXT).toBe('No to-do list for this request')
    // The new request's list stands alone; the earlier one stays folded.
    const again = fold([list('main', [['C', 'doing']])], next)
    expect(todoBlock(again).items.map((x) => x.subject)).toEqual(['C'])
    expect(todoBlock(again).earlier.map((x) => x.subject)).toEqual(['A', 'B'])
    // A list with work open does not fold.
    const open = fold([turnStart('o1'), list('main', [['X', 'todo']]), turnEnd('o1'), turnStart('o2')])
    expect(todoBlock(open).items.map((x) => x.subject)).toEqual(['X'])
  })

  it('R16: an owner that uses the task tools keeps them; the tasks field is ignored for it, never merged', () => {
    const t = fold([start('tw', 'TodoWrite', { todos: [{ content: 'From TodoWrite', status: 'in_progress' }] }), list('main', [['From the field', 'todo']])])
    expect(todoBlock(t).items.map((x) => x.subject)).toEqual(['From TodoWrite'])
    expect(todoBlock(t).source).toBe('tools')
  })

  // Review C1C2 C-1: the order the guide's haiku run took (field first, then the task tools) never merges either.
  it('R16: a list sent in the tasks field, then rebuilt with TaskCreate, is replaced whole; later tasks updates are ignored', () => {
    const created = (id: string, subject: string): Ev[] => [
      start(`c${id}`, 'TaskCreate', { subject }), { kind: 'step.end', at: at(), id: `c${id}`, status: 'done', result: { task: { id } } },
    ]
    const t = fold([turnStart('t1'), list('main', [['A', 'doing'], ['B', 'todo'], ['C', 'todo']]), ...created('1', 'A'), ...created('2', 'B')])
    const b = todoBlock(t)
    expect(b.items.map((x) => [x.id, x.subject])).toEqual([['1', 'A'], ['2', 'B']])
    expect([b.total, b.source]).toEqual([2, 'tools'])
    expect(t.tasks.some((x) => x.id.startsWith('list:'))).toBe(false)
    const later = fold([list('main', [['Z', 'doing']])], t)
    expect(todoBlock(later).items.map((x) => x.subject)).toEqual(['A', 'B'])
    // A subagent's field list goes the same way, and the lead's list is untouched.
    const sub = fold([spawn('a1'), list('a1', [['Scan', 'doing']]),
      start('ca', 'TaskCreate', { subject: 'Scan' }, 'a1'), { kind: 'step.end', at: at(), id: 'ca', status: 'done', result: { task: { id: '9' } } }], t)
    expect(listCounts(sub, 'a1')).toEqual({ done: 0, total: 1 })
    expect(sub.tasks.filter((x) => x.owner === 'a1').map((x) => x.id)).toEqual(['9'])
    expect(todoBlock(sub).total).toBe(2)
  })

  it('R16: a timeline an earlier build stored with both kinds reads as the task-tool list alone', () => {
    const t: Timeline = {
      ...empty,
      tasks: [
        { id: 'list:main:0:0', subject: 'A', status: 'in_progress', owner: 'main', updatedAt: 1 },
        { id: '1', subject: 'A', status: 'completed', owner: 'main', updatedAt: 2 },
      ],
    }
    expect(todoBlock(t).items.map((x) => x.id)).toEqual(['1'])
    expect(listCounts(t, 'main')).toEqual({ done: 1, total: 1 })
  })

  it('R5: paused only when the asker is the lead or nothing else is running', () => {
    const t = fold([list('main', [['Work', 'doing']]), spawn('a1')])
    expect(todoBlock(t, ['a1']).paused).toBe(false)
    expect(todoBlock(t, ['main']).paused).toBe(true)
    const alone = fold([list('main', [['Work', 'doing']])])
    expect(todoBlock(alone, ['a9']).paused).toBe(true)
    expect(todoBlock(alone, []).paused).toBe(false)
  })
})

describe('words', () => {
  it('spans per R27, and friendly agent names per R23', () => {
    expect([spanText(45_000), spanText(12 * MIN), spanText(72 * MIN), spanText(120 * MIN)]).toEqual(['45s', '12 min', '1 h 12 min', '2 h'])
    const t = fold([spawn('a', 'general-purpose'), spawn('b', 'Explore'), spawn('c', 'code-reviewer'), spawn('d', 'unknown')])
    expect(['main', 'a', 'b', 'c', 'd', 'zz'].map((x) => agentName(t, x))).toEqual(['Claude', 'General', 'Explorer', 'Code reviewer', 'An agent', 'An agent'])
  })
})
