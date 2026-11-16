// A test helper, not part of the mod: the sessions of the CockpitAgents and
// CrewMapClear mocks (gen-cockpit.js, gen-crew.js) as timelines, so a test can
// draw the real list and map with the mocks' data, and the states the crew
// map rules add (a flagged agent, a failure, an unfolded task). Imported by
// *.test.tsx files only.

import type { AgentRow, Step, TaskItem, Timeline } from '../../types'
import { empty } from '../model/reduce'

export const NOW = 10_000_000_000
const MIN = 60_000
const SEC = 1000

export const agent = (id: string, type: string, description: string, startedAt: number, extra: Partial<AgentRow> = {}): AgentRow => ({
  id, parent: 'main', type, description, status: 'running', startedAt, doing: '', stepCount: 1, ...extra,
})

export const step = (id: string, seq: number, agentId: string, tool: string, label: string, status: Step['status'], startedAt: number, extra: Partial<Step> = {}): Step => ({
  id, seq, agent: agentId, tool, label, status, startedAt, ...extra,
})

const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-5-5'

/**
 * CockpitAgents: Explorer and Builder working, one failed Explorer, 31 finished
 * (Checker, Builder, Explorer the newest three), a workflow run with 3 of 5
 * agents done. 34 agents report 1.9M tokens, 71 % of them on Sonnet.
 */
export function listSession(): Timeline {
  const agents: Record<string, AgentRow> = { main: { ...empty.agents.main!, model: OPUS } }
  agents.e1 = agent('e1', 'Explore', 'find every caller of upload()', NOW - (2 * MIN + 14 * SEC), { model: OPUS, tokensIn: 25_000, tokensOut: 6_000 })
  agents.b1 = agent('b1', 'builder', 'write the rate limit tests', NOW - (MIN + 40 * SEC), { model: SONNET, tokensIn: 42_000, tokensOut: 10_000 })
  agents.f1 = agent('f1', 'Explore', 'check the CLI caller', NOW - 20 * MIN, {
    status: 'error', endedAt: NOW - 20 * MIN + 3 * MIN + 2 * SEC, model: SONNET, tokensIn: 10_000, tokensOut: 2_000,
    result: 'the file src/cli/upload.ts does not exist',
  })
  const named: [string, string, string, number, number][] = [
    ['d0', 'checker', 'review the token bucket', 64_000, 5 * MIN + 10 * SEC],
    ['d1', 'builder', 'write the token bucket', 90_000, 7 * MIN + 44 * SEC],
    ['d2', 'Explore', 'read the upload handler', 38_000, MIN + 52 * SEC],
  ]
  named.forEach(([id, type, description, tokens, took], i) => {
    const end = NOW - (5 + i) * MIN
    agents[id] = agent(id, type, description, end - took, { status: 'done', endedAt: end, model: SONNET, tokensIn: tokens * 0.8, tokensOut: tokens * 0.2 })
  })
  for (let i = 0; i < 28; i++) {
    const end = NOW - (30 + i) * MIN
    agents[`o${i}`] = agent(`o${i}`, 'general-purpose', `earlier job ${i}`, end - 4 * MIN, {
      status: 'done', endedAt: end, model: i < 9 ? OPUS : SONNET, tokensIn: 45_600, tokensOut: 11_400,
    })
  }
  const run = { runId: 'r1', name: 'review workflow', parent: 'main', startedAt: NOW - 8 * MIN }
  for (let i = 0; i < 5; i++) {
    agents[`w${i}`] = agent(`w${i}`, 'workflow-subagent', `review part ${i}`, NOW - 8 * MIN + i * SEC, {
      runId: 'r1', agentIndex: i, ...(i < 3 ? { status: 'done' as const, endedAt: NOW - 4 * MIN } : {}),
    })
  }
  return {
    ...empty,
    now: { focus: 'Wiring the limiter into the middleware chain', at: NOW - 30 * MIN },
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting to the upload', startedAt: NOW - 41 * MIN }],
    agents,
    runs: { r1: run },
    steps: [
      step('s-e1', 100, 'e1', 'Grep', 'Grep "upload("', 'running', NOW - 20 * SEC, { turnId: 't1', pending: { pattern: 'upload(', path: 'src/server' } }),
      step('s-b1', 101, 'b1', 'Edit', 'Edit test/rateLimit.test.ts', 'running', NOW - 10 * SEC, { turnId: 't1', pending: { file_path: 'test/rateLimit.test.ts' } }),
    ],
  }
}

const TYPE = { scout: 'Explore', build: 'builder', check: 'code-reviewer' } as const
type Mix = [keyof typeof TYPE, number][]

const task = (id: number, subject: string, status: TaskItem['status']): TaskItem => ({ id: String(id), subject, status, owner: 'main', updatedAt: NOW - 60 * MIN })

/**
 * CrewMapClear: 35 agents in a long session. Main working; task 12 has one
 * working Builder and 3 done; 7 done tasks (11 to 5); task 13 queued; 4 done
 * agents with no task. Every group's numbers are the mock's.
 */
export function mapSession(): Timeline {
  const agents: Record<string, AgentRow> = { main: { ...empty.agents.main!, model: OPUS, tokensIn: 150_000, tokensOut: 34_000, doing: 'Edit middleware/rateLimit.ts' } }
  const tasks: TaskItem[] = []
  const add = (group: string, taskId: string | undefined, mix: Mix, tokens: number, minutes: number, endAgo: number): void => {
    const roles = mix.flatMap(([r, n]) => Array.from({ length: n }, () => r))
    const each = tokens / roles.length
    roles.forEach((r, i) => {
      const end = NOW - endAgo * MIN
      agents[`${group}-${i}`] = agent(`${group}-${i}`, TYPE[r], `${r} job ${group} ${i}`, end - minutes * MIN + i * SEC, {
        status: 'done', endedAt: end - i * SEC, model: SONNET, tokensIn: each * 0.8, tokensOut: each * 0.2, ...(taskId !== undefined ? { taskId } : {}),
      })
    })
  }
  // Task 12: three done agents (78k, 13 min) and the working Builder (18k, 48 s).
  add('t12', '12', [['scout', 2], ['check', 1]], 78_000, 13, 1)
  agents['t12-0'] = { ...agents['t12-0']!, startedAt: NOW - 14 * MIN }
  agents.live = agent('live', 'builder', 'wire limiter middleware', NOW - 48 * SEC, { taskId: '12', model: SONNET, tokensIn: 14_000, tokensOut: 4_000 })
  const done: [number, string, Mix, number, number][] = [
    [11, 'Add limiter config', [['scout', 2], ['build', 3], ['check', 1]], 141_000, 22],
    [10, 'Token bucket store', [['scout', 1], ['build', 3], ['check', 1]], 118_000, 19],
    [9, 'Redis adapter', [['scout', 2], ['build', 1], ['check', 1]], 74_000, 12],
    [8, 'Upload route audit', [['scout', 3], ['check', 1]], 66_000, 9],
    [7, 'Error shapes for 429', [['build', 2], ['check', 1]], 52_000, 8],
    [6, 'Fixtures for burst tests', [['build', 2], ['check', 1]], 41_000, 7],
    [5, 'Read the middleware order', [['scout', 2]], 22_000, 3],
  ]
  done.forEach(([id, subject, mix, tokens, minutes], i) => {
    tasks.push(task(id, subject, 'completed'))
    add(`t${id}`, String(id), mix, tokens, minutes, 5 + i * 5)
  })
  // Task 11 (the one the unfolded mock opens): its six agents with the mock's jobs, tokens and times.
  const end11 = NOW - 5 * MIN
  const unfolded: [keyof typeof TYPE, string, number, number, number][] = [
    ['scout', 'find config loaders', 22_000, 190, 0],
    ['scout', 'read env schema', 14_000, 112, 4],
    ['build', 'add the config type', 31_000, 304, 7],
    ['build', 'wire config defaults', 28_000, 280, 11],
    ['build', 'document the options', 19_000, 151, 15],
    ['check', 'review limiter config', 27_000, 283, 17],
  ]
  unfolded.forEach(([r, description, tokens, dur, startMin], i) => {
    const start = i === 5 ? end11 - dur * SEC : end11 - 22 * MIN + startMin * MIN
    agents[`t11-${i}`] = { ...agents[`t11-${i}`]!, type: TYPE[r], description, startedAt: start, endedAt: i === 5 ? end11 : start + dur * SEC, tokensIn: tokens * 0.8, tokensOut: tokens * 0.2 }
  })
  tasks.push(task(12, 'Wire limiter into the chain', 'in_progress'), task(13, 'Document the limits', 'pending'))
  add('none', undefined, [['scout', 3], ['build', 1]], 38_000, 6, 60)
  return {
    ...empty,
    now: { focus: 'Wiring the limiter into the middleware chain', at: NOW - 30 * MIN },
    turns: [{ id: 't1', agent: 'main', prompt: 'add rate limiting', startedAt: NOW - (60 + 48) * MIN }],
    agents,
    tasks,
    steps: [
      step('s-m', 90, 'main', 'Bash', 'Bash npm test', 'done', NOW - 108 * MIN, { turnId: 't1', endedAt: NOW - 107 * MIN }),
      step('s-live', 101, 'live', 'Edit', 'Edit middleware/rateLimit.ts', 'running', NOW - 10 * SEC, { turnId: 't1', pending: { file_path: 'middleware/rateLimit.ts' } }),
    ],
  }
}

/** The map session with one working agent also asking for permission (a flag), and one failed agent. */
export function flaggedSession(): Timeline {
  const t = mapSession()
  const waiting = agent('ask', 'builder', 'deploy to staging', NOW - 5 * MIN, { taskId: '13', model: SONNET, tokensIn: 3_000, tokensOut: 1_000 })
  const failed = agent('boom', 'Explore', 'read the config schema', NOW - 9 * MIN, {
    taskId: '11', status: 'error', endedAt: NOW - 8 * MIN, model: SONNET, tokensIn: 4_000, tokensOut: 1_000, result: 'the schema file is missing',
  })
  return {
    ...t,
    agents: { ...t.agents, ask: waiting, boom: failed },
    steps: [
      ...t.steps,
      step('s-ask', 102, 'ask', 'Bash', 'Bash npm run deploy -- --env staging', 'running', NOW - 90 * SEC, { turnId: 't1', asking: NOW - 40 * SEC, pending: { command: 'npm run deploy -- --env staging' } }),
    ],
  }
}
