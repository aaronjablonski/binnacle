// A test helper, not part of the mod: the sessions of the CockpitTasks,
// CockpitSteps and CockpitArtifacts mocks (gen-cockpit.js) as timelines, so
// a test can draw the real tabs with the mock's data. Imported by
// *.test.tsx files only.

import type { Step, Timeline, TurnRow, UiState } from '../../types'
import { empty } from '../model/reduce'
import { agent, busy, NOW, runTurn, runTurnId, step, TASK_TITLES, tasksOf } from './now.fixtures.testkit'

export { NOW }
const MIN = 60_000

/** The tokens each of the 14 tasks took in the Tasks mock (k); the last four have not started. */
export const TOK = [38, 212, 64, 90, 51, 120, 77, 45, 41, 96, 0, 0, 0, 0]
/** The minutes each done task took (the mock shows 6, 4 and 9 for the newest three). */
const TOOK = [3, 11, 5, 7, 4, 8, 9, 4, 6]

/** CockpitTasks: 9 of 14 done, the 10th in progress with Explorer and Builder tethered, 4 up next. */
export function tasksTimeline(): Timeline {
  const t = busy()
  const tasks = tasksOf(9).map((x, i) => ({ ...x, ...(TOK[i]! > 0 ? { tokens: TOK[i]! * 1000 } : {}), ...(i < 9 ? { ms: TOOK[i]! * MIN } : {}) }))
  return {
    ...t,
    tasks,
    agents: {
      main: { ...empty.agents.main! },
      e1: { ...agent('e1', 'Explore', 'find every caller of upload()', NOW - 134_000), taskId: '10' },
      b1: { ...agent('b1', 'general-purpose', 'write the rate limit tests', NOW - 100_000), taskId: '10' },
    },
    steps: [
      step('s-e1', 100, 'e1', 'Grep', 'Grep "upload("', 'running', NOW - 20_000, { turnId: runTurnId('e1'), pending: { pattern: 'upload(', path: 'src/server' } }),
      step('s-b1', 101, 'b1', 'Edit', 'Edit middleware/index.ts', 'running', NOW - 10_000, { turnId: runTurnId('b1'), pending: { file_path: 'middleware/index.ts' } }),
    ],
  }
}

/** R12: a new request began with the old list all done: its 14 tasks fold away as Earlier. */
export function earlierTimeline(): Timeline {
  const t = tasksTimeline()
  return { ...t, tasks: tasksOf(14), listFrom: NOW - 5 * MIN, turns: [{ id: 't2', agent: 'main', prompt: 'document the limits', startedAt: NOW - MIN }], agents: { main: { ...empty.agents.main! } }, steps: [] }
}

export const stepsUi = (extra: Partial<UiState> = {}): UiState => ({
  tab: 'timeline', filter: { kind: 'all' }, agentsMode: 'list', folded: [], openTurns: [], dismissed: [], query: '', runningOnly: false,
  notified: [], toasted: [], slim: false, ...extra,
})

const PROMPTS = [
  { id: 't0', prompt: 'set up the staging bucket', steps: 56, at: '09:20' },
  { id: 't1a', prompt: 'why does the CLI skip auth?', steps: 21, at: '09:47' },
  { id: 't1b', prompt: 'fix the flaky upload test', steps: 38, at: '10:12' },
  { id: 't1c', prompt: 'review the upload route', steps: 30, at: '09:05' },
  { id: 't1d', prompt: 'rename the upload helper', steps: 27, at: '08:40' },
]

/** The clock time `hh:mm` as a local time of day on the day of NOW (the views draw `clock`, which reads local time). */
function atClock(hhmm: string): number {
  const d = new Date(NOW)
  const [h, m] = hhmm.split(':').map(Number)
  d.setHours(h!, m!, 0, 0)
  return d.getTime() - 24 * 60 * MIN
}

/** CockpitSteps: 212 steps over 41 minutes, 3 kept, 3 failed; this turn holds 40 and 5 earlier turns the rest. */
export function stepsTimeline(): { t: Timeline; ids: { running: string; done: string; failed: string; kept: string; view: string[] } } {
  const steps: Step[] = []
  let seq = 1
  const turns: TurnRow[] = PROMPTS.map(p => ({ id: p.id, agent: 'main', prompt: p.prompt, startedAt: atClock(p.at), endedAt: atClock(p.at) + 5 * MIN }))
  // Earlier turns: one step each, spread over their own time.
  PROMPTS.forEach((p, ti) => {
    for (let i = 0; i < p.steps; i++) {
      const at = NOW - 41 * MIN - (PROMPTS.length - ti) * 12 * MIN + i * 1000
      steps.push(step(`o${ti}-${i}`, seq++, 'main', 'Read', `Read src/file${i}.ts`, 'done', at, { turnId: p.id, endedAt: at + 500 }))
    }
  })
  const start = NOW - 41 * MIN
  turns.push({ id: 't1', agent: 'main', prompt: 'add rate limiting to the upload', startedAt: start, endedAt: undefined as unknown as number })
  // C2: each subagent run is a turn of its own, as the reducer records it; its steps carry that turn's id.
  turns.push(runTurn('e1', 'find every caller', NOW - 8 * MIN), runTurn('b1', 'write the rate limit tests', NOW - 6 * MIN))
  const cur: Step[] = []
  const mk = (id: string, tool: string, label: string, status: Step['status'], agentId: string, startedAt: number, extra: Partial<Step> = {}): void => {
    cur.push(step(id, 0, agentId, tool, label, status, startedAt, { turnId: agentId === 'main' ? 't1' : runTurnId(agentId), ...extra }))
  }
  // The 34 older steps of this turn come first (oldest), then the six the mock lists (oldest to newest).
  for (let i = 0; i < 34; i++) mk(`n${i}`, 'Read', `Read src/part${i}.ts`, 'done', 'main', start + i * 30_000, { endedAt: start + i * 30_000 + 800, ...(i === 8 || i === 29 ? { status: 'error' as const } : {}), ...(i === 12 ? { pin: '' } : i === 20 ? { pin: 'check the order' } : {}) })
  mk('k1', 'Read', 'Read middleware/bodyLimit.ts', 'done', 'main', NOW - 9 * MIN, { endedAt: NOW, pin: 'limiter order matters' })
  mk('g1', 'Read', 'Read src/server/routes.ts', 'done', 'e1', NOW - 8 * MIN, { endedAt: NOW - 4 * MIN })
  mk('g2', 'Grep', 'Grep “upload(” in src/server', 'done', 'e1', NOW - 7 * MIN, { endedAt: NOW - 3 * MIN })
  mk('f1', 'Bash', 'Bash npm test upload', 'error', 'b1', NOW - 6 * MIN, { endedAt: NOW - 3 * MIN })
  mk('d1', 'Edit', 'Edit test/rateLimit.test.ts', 'done', 'b1', NOW - 40_000, { endedAt: NOW })
  mk('r1', 'Edit', 'Edit middleware/index.ts', 'running', 'main', NOW - 5_000)
  cur.forEach(s => steps.push({ ...s, seq: seq++ }))
  const t = busy()
  return {
    t: {
      ...empty,
      turns,
      steps,
      agents: {
        main: { ...empty.agents.main! },
        e1: agent('e1', 'Explore', 'find every caller', NOW - 8 * MIN),
        b1: agent('b1', 'general-purpose', 'write the rate limit tests', NOW - 6 * MIN),
      },
      budget: t.budget,
      tasks: tasksOf(9),
    },
    ids: { running: 'r1', done: 'd1', failed: 'f1', kept: 'k1', view: ['r1', 'd1', 'n31', 'n32', 'n33', 'n30'] },
  }
}

/** CockpitArtifacts: two artifacts (a page made at step 148, a document), six files changed, three steps kept, 9 tasks, last exported at 13:30. */
export function artifactsTimeline(): Timeline {
  const t = busy()
  const edit = (id: string, seq: number, path: string, ago: number): Step => step(id, seq, 'main', 'Edit', `Edit ${path}`, 'done', NOW - ago, { turnId: 't1', endedAt: NOW - ago + 500 })
  const steps: Step[] = [
    step('s148', 148, 'main', 'Write', 'Write docs/rate-limit-design.md', 'done', NOW - 9 * MIN, { turnId: 't1', endedAt: NOW - 9 * MIN + 500 }),
    step('kp1', 150, 'main', 'Write', 'Write notes.md', 'done', NOW - 6 * MIN, { turnId: 't1', endedAt: NOW - 6 * MIN + 500, pin: 'The limiter runs after bodyLimit' }),
    step('kp2', 151, 'main', 'Read', 'Read middleware/bodyLimit.ts', 'done', NOW - 9 * MIN, { turnId: 't1', endedAt: NOW - 9 * MIN + 500, pin: 'limiter order matters' }),
    step('kp3', 152, 'main', 'Bash', 'Bash npm test', 'error', NOW - 3 * MIN, { turnId: 't1', endedAt: NOW - 3 * MIN + 500, pin: 'the failing 429 test' }),
    edit('e1', 160, 'middleware/rateLimit.ts', 8 * MIN), edit('e2', 161, 'middleware/rateLimit.ts', 6 * MIN), edit('e3', 162, 'middleware/rateLimit.ts', 4 * MIN), edit('e4', 163, 'middleware/rateLimit.ts', 2 * MIN),
    edit('e5', 164, 'middleware/index.ts', 4 * MIN), edit('e6', 165, 'middleware/index.ts', 1000),
    edit('e7', 166, 'test/rateLimit.test.ts', 3 * MIN), edit('e8', 167, 'test/rateLimit.test.ts', 2 * MIN), edit('e9', 168, 'test/rateLimit.test.ts', 40_000),
  ]
  return {
    ...t,
    tasks: tasksOf(9, false).slice(0, 9),
    steps,
    agents: { main: { ...empty.agents.main! } },
    artifacts: [
      { id: 'a1', kind: 'page', title: 'Rate limit design', ref: 'claude.ai/artifact/9f2c41', agent: 'main', count: 2, updatedAt: NOW - 9 * MIN, stepId: 's148' },
      { id: 'a2', kind: 'document', title: 'docs/rate-limit-plan.md', ref: 'docs/rate-limit-plan.md', agent: 'main', count: 1, updatedAt: NOW - 12 * MIN },
    ],
    changed: ['config/limits.ts', 'docs/limits.md', 'CHANGELOG.md', 'test/rateLimit.test.ts', 'middleware/index.ts', 'middleware/rateLimit.ts'],
    lastExport: { at: atClock('13:30') + 24 * 60 * MIN, path: '/tmp/export.md' },
  }
}
