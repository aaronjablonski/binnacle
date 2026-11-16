// A test helper, not part of the mod: the sessions of the CockpitNow* and
// CockpitSlim mocks (gen-cockpit.js) as timelines, so a test can draw the
// real views with the mock's data, and the states the rulings add (R8, R12,
// R13). Imported by *.test.tsx files only.

import type { AgentRow, Step, TaskItem, Timeline } from '../../types'
import { empty } from '../model/reduce'

export const NOW = 10_000_000_000
const MIN = 60_000

export const TASK_TITLES = [
  'Read the upload handler', 'Map every caller of upload()', 'Choose the limiter algorithm', 'Write the token bucket',
  'Add the limiter middleware', 'Unit-test the bucket', 'Add config for the limits', 'Return 429 with Retry-After',
  'Cover the middleware with tests', 'Wire the limiter into the chain', 'Run the upload tests on staging',
  'Document the limits', 'Update the changelog', 'Open the pull request',
]

/** The lead's list: `done` completed (in order), the next one in progress when `current`, the rest pending. */
export function tasksOf(done: number, current = true, titles: string[] = TASK_TITLES): TaskItem[] {
  return titles.map((subject, i) => ({
    id: String(i + 1),
    subject,
    status: i < done ? 'completed' : i === done && current ? 'in_progress' : 'pending',
    owner: 'main',
    updatedAt: i < done ? NOW - 60 * MIN + i * MIN : i === done && current ? NOW - 12 * MIN : NOW - 70 * MIN,
  }))
}

export const agent = (id: string, type: string, description: string, startedAt: number, extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type, description, status: 'running', startedAt, doing: '', stepCount: 1, ...extra,
})

/** 31 agents that finished earlier in this request. */
export function finished(n = 31, from = NOW - 40 * MIN): Record<string, AgentRow> {
  const out: Record<string, AgentRow> = {}
  for (let i = 0; i < n; i++) out[`d${i}`] = agent(`d${i}`, 'general-purpose', `earlier job ${i}`, from - MIN, { status: 'done', endedAt: from + i * 1000 })
  return out
}

export const step = (id: string, seq: number, agentId: string, tool: string, label: string, status: Step['status'], startedAt: number, extra: Partial<Step> = {}): Step => ({
  id, seq, agent: agentId, tool, label, status, startedAt, ...extra,
})

const KEPT = step('k1', 5, 'main', 'Bash', 'Bash npm test', 'done', NOW - 35 * MIN, { endedAt: NOW - 35 * MIN + 2000, pin: 'Decided: the limiter runs after bodyLimit' })
const NOTES = [
  { text: 'The tests need the staging bucket', agent: 'main', at: NOW - 30 * MIN },
  { text: 'upload() has three callers; the CLI one skips auth', agent: 'main', at: NOW - 20 * MIN },
]

/** CockpitNow: 41 min into the turn, 9 of 14 done, Explorer and Builder working, 31 finished earlier. */
export function busy(): Timeline {
  return {
    ...empty,
    now: { focus: 'Wiring the limiter into the middleware chain', at: NOW - 30 * MIN },
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting to the upload', startedAt: NOW - 41 * MIN }],
    tasks: tasksOf(9),
    agents: {
      main: { ...empty.agents.main! },
      ...finished(),
      e1: agent('e1', 'Explore', 'find every caller of upload()', NOW - 134_000),
      b1: agent('b1', 'general-purpose', 'write the rate limit tests', NOW - 100_000),
    },
    steps: [
      KEPT,
      step('s-e1', 100, 'e1', 'Grep', 'Grep "upload("', 'running', NOW - 20_000, { turnId: 't1', pending: { pattern: 'upload(', path: 'src/server' } }),
      step('s-b1', 101, 'b1', 'Edit', 'Edit test/rateLimit.test.ts', 'running', NOW - 10_000, { turnId: 't1', pending: { file_path: 'test/rateLimit.test.ts' } }),
    ],
    notes: NOTES,
    budget: { contextTokens: 620_000, contextPct: 62, windows: [{ name: 'five_hour', pct: 20 }, { name: 'seven_day', pct: 34 }], at: NOW },
    cache: { at: NOW - 12_000 },
  }
}

/** CockpitNowNeedsYou: Builder asks to run `npm run deploy -- --env staging`, 40 s ago. */
export function asked(): Timeline {
  const t = busy()
  return {
    ...t,
    agents: { ...t.agents, b1: agent('b1', 'general-purpose', 'wire the limiter middleware', NOW - 100_000) },
    steps: [
      KEPT,
      t.steps[1]!,
      step('s-b1', 101, 'b1', 'Bash', 'Bash npm run deploy -- --env staging', 'running', NOW - 45_000, {
        turnId: 't1', asking: NOW - 40_000, pending: { command: 'npm run deploy -- --env staging' },
      }),
    ],
  }
}

/** CockpitNowWatch: 1 h 12 min into the turn, Explorer past its 60 min limit, `npm test upload` failed 3 times in a row. */
export function watching(): Timeline {
  const t = busy()
  const fail = (i: number): Step => step(`f${i}`, 10 + i, 'main', 'Bash', 'Bash npm test upload', 'error', NOW - (11 - i) * MIN, { endedAt: NOW - (11 - i) * MIN + 20_000, turnId: 't1' })
  return {
    ...t,
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting to the upload', startedAt: NOW - 72 * MIN }],
    agents: { ...t.agents, e1: agent('e1', 'Explore', 'find every caller of upload()', NOW - 64 * MIN, { spawnStep: 'spawn-e1' }) },
    steps: [
      KEPT, fail(0), fail(1), fail(2),
      step('s-e1', 100, 'e1', 'Grep', 'Grep "upload("', 'running', NOW - 20_000, { turnId: 't1', pending: { pattern: 'upload(', path: 'vendor/' } }),
      t.steps[2]!,
    ],
    budget: { contextTokens: 853_000, contextPct: 85, windows: [{ name: 'five_hour', pct: 20 }, { name: 'seven_day', pct: 34 }], at: NOW },
  }
}

/** CockpitNowIdle: finished 2 min ago after 1 h 18 min, 14 of 14 done, 33 agents done, the cache warm for 2:51. */
export function idle(): Timeline {
  const t = busy()
  const files = ['middleware/rateLimit.ts', 'middleware/index.ts', 'config/limits.ts', 'test/rateLimit.test.ts', 'docs/limits.md', 'CHANGELOG.md']
  const start = NOW - 80 * MIN
  return {
    ...t,
    now: { focus: 'Rate limiting is wired in and tested', at: NOW - 3 * MIN },
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting to the upload', startedAt: start, endedAt: NOW - 2 * MIN }],
    tasks: tasksOf(14),
    agents: {
      main: { ...empty.agents.main! },
      ...finished(31, NOW - 40 * MIN),
      e1: agent('e1', 'Explore', 'find every caller of upload()', NOW - 50 * MIN, { status: 'done', endedAt: NOW - 30 * MIN }),
      b1: agent('b1', 'general-purpose', 'write the rate limit tests', NOW - 50 * MIN, { status: 'done', endedAt: NOW - 20 * MIN }),
    },
    steps: [KEPT, ...files.map((f, i) => step(`w${i}`, 20 + i, 'main', 'Edit', `Edit ${f}`, 'done', NOW - (60 - i) * MIN, { endedAt: NOW - (60 - i) * MIN + 1000, turnId: 't1' }))],
    artifacts: [
      { id: 'a1', kind: 'document', title: 'Rate limit design', agent: 'main', count: 1, updatedAt: NOW - 50 * MIN },
      { id: 'a2', kind: 'document', title: 'the plan', agent: 'main', count: 1, updatedAt: NOW - 45 * MIN },
    ],
    budget: { contextTokens: 644_000, contextPct: 64, windows: [{ name: 'five_hour', pct: 20 }, { name: 'seven_day', pct: 35 }], at: NOW },
    cache: { at: NOW - 129_000 },
  }
}

/** R8: the turn stopped on an error with the list open; nothing runs. */
export function stopped(): Timeline {
  const t = idle()
  return {
    ...t,
    now: { focus: 'Wiring the limiter into the middleware chain', at: NOW - 30 * MIN },
    tasks: tasksOf(9),
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting to the upload', startedAt: NOW - 41 * MIN, endedAt: NOW - MIN, failed: true }],
    failure: { turnId: 't1', reason: 'The API was overloaded (529)' },
  }
}

/** R12: busy, but the request has no to-do list. */
export function noList(): Timeline {
  return { ...busy(), tasks: [] }
}

/** R12: the turn ended normally with 5 tasks open; nothing runs. */
export function endedOpen(): Timeline {
  const t = idle()
  return {
    ...t,
    now: { focus: 'Wiring the limiter into the middleware chain', at: NOW - 30 * MIN },
    tasks: tasksOf(9),
  }
}

/** R13: 40 tasks, 25 done, the 26th in progress. */
export function longList(): Timeline {
  const titles = Array.from({ length: 40 }, (_, i) => (i < TASK_TITLES.length ? TASK_TITLES[i]! : `Follow-up task ${i + 1}`))
  return { ...busy(), tasks: tasksOf(25, true, titles) }
}
