// The pull request and GitHub stack the session works on, from `gh`'s JSON.
// Pure: the fetch (`../pr.ts`) runs the commands and hands their stdout here.
//
// Sources:
// - `gh stack view --json` (github/gh-stack): `{ trunk, currentBranch,
//   branches: [{ name, isCurrent, isMerged, isQueued, needsRebase, pr? }] }`,
//   bottom of the stack first. Exits non-zero off a stack.
// - `gh pr list --state all --json number,title,url,state,isDraft,headRefName,
//   reviewDecision,statusCheckRollup`: matched to branches by `headRefName`.

import type { Pr, PrChecks, PrState, StackItem } from '../../types'

export const PR_LIST_FIELDS = 'number,title,url,state,isDraft,headRefName,isCrossRepository,reviewDecision,statusCheckRollup'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

/** The rollup of a PR's checks: any failure fails, any running is pending, all passed (or skipped) pass. */
export function rollChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const o = obj(c)
    if (o === undefined) continue
    // CheckRun: status + conclusion; StatusContext: state.
    const conclusion = (str(o.conclusion) ?? str(o.state) ?? '').toUpperCase()
    const status = (str(o.status) ?? '').toUpperCase()
    if (FAILED.includes(conclusion)) return 'fail'
    if ((status !== '' && status !== 'COMPLETED') || conclusion === 'PENDING' || conclusion === 'EXPECTED' || conclusion === '') pending = true
  }
  return pending ? 'pending' : 'pass'
}

function toPr(v: unknown): Pr | undefined {
  const o = obj(v)
  if (o === undefined || typeof o.number !== 'number') return undefined
  const state = (str(o.state) ?? 'OPEN').toUpperCase()
  const review = (str(o.reviewDecision) ?? '').toUpperCase()
  return {
    number: o.number,
    title: (str(o.title) ?? '').slice(0, 200),
    url: (str(o.url) ?? '').slice(0, 300),
    head: (str(o.headRefName) ?? '').slice(0, 200),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    ...(o.isDraft === true ? { draft: true as const } : {}),
    checks: rollChecks(o.statusCheckRollup),
    ...(review === 'APPROVED' ? { review: 'approved' as const } : review === 'CHANGES_REQUESTED' ? { review: 'changes' as const } : review === 'REVIEW_REQUIRED' ? { review: 'required' as const } : {}),
  }
}

/** `gh pr list --json …` → PRs by head branch; an open PR wins over a closed one, then the newest. */
export function parsePrList(text: string): Map<string, Pr> {
  const out = new Map<string, Pr>()
  const arr = parseJson(text)
  if (!Array.isArray(arr)) return out
  for (const v of arr) {
    const pr = toPr(v)
    // A fork's PR can share the branch's name (`alice:main`): only PRs from this repository match a local branch.
    if (pr === undefined || pr.head === '' || obj(v)?.isCrossRepository === true) continue
    const had = out.get(pr.head)
    const better = had === undefined || (had.state !== 'open' && pr.state === 'open') || ((had.state === 'open') === (pr.state === 'open') && pr.number > had.number)
    if (better) out.set(pr.head, pr)
  }
  return out
}

export type RawStack = { trunk: string; current?: string; branches: { name: string; merged: boolean; queued: boolean; rebase: boolean; number?: number; url?: string }[] }

/** `gh stack view --json` → the stack, bottom first; undefined when it is not one. */
export function parseStack(text: string): RawStack | undefined {
  const o = obj(parseJson(text))
  if (o === undefined || !Array.isArray(o.branches)) return undefined
  const branches: RawStack['branches'] = []
  let isCurrent: string | undefined
  for (const b of o.branches) {
    const r = obj(b)
    const name = str(r?.name)
    if (r === undefined || name === undefined) continue
    if (r.isCurrent === true) isCurrent = name
    const pr = obj(r.pr) ?? obj(r.pullRequest)
    const url = str(pr?.url)
    branches.push({
      name,
      merged: r.isMerged === true,
      queued: r.isQueued === true,
      rebase: r.needsRebase === true,
      ...(typeof pr?.number === 'number' ? { number: pr.number } : {}),
      ...(url !== undefined ? { url } : {}),
    })
  }
  if (branches.length === 0) return undefined
  const current = str(o.currentBranch) ?? isCurrent
  return { trunk: str(o.trunk) ?? 'main', ...(current !== undefined ? { current } : {}), branches }
}

/** The state the pane shows: the current branch's PR and, on a stack, every member (at most 30). */
export function buildPrState(at: number, branch: string, prs: Map<string, Pr>, stack?: RawStack): PrState {
  const current = prs.get(branch)
  const base: PrState = { at, branch: branch.slice(0, 200), ...(current !== undefined ? { current } : {}) }
  const here = stack?.branches.findIndex(b => b.name === branch) ?? -1
  if (stack === undefined || here < 0) return base
  // At most 30 members, in a window that keeps the current branch (so its index and the cursor stay true).
  const from = Math.max(0, Math.min(here - 15, stack.branches.length - 30))
  const items: StackItem[] = stack.branches.slice(from, from + 30).map(b => {
    const pr = prs.get(b.name)
    const number = pr?.number ?? b.number
    const url = pr?.url ?? b.url
    const state = b.merged ? 'merged' : pr?.state
    return {
      branch: b.name.slice(0, 200),
      ...(number !== undefined ? { number } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(pr !== undefined ? { title: pr.title, checks: pr.checks } : {}),
      ...(pr?.draft === true ? { draft: true as const } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(b.queued ? { queued: true as const } : {}),
      ...(b.rebase ? { rebase: true as const } : {}),
    }
  })
  return { ...base, stack: { trunk: stack.trunk.slice(0, 200), items } }
}

/** The index of the current branch in the stack, or -1. */
export const stackIndex = (s: PrState): number => s.stack?.items.findIndex(i => i.branch === s.branch) ?? -1

/** Whether a shell command may have moved the branch or a PR, so the PR state is worth fetching again. */
export function touchesPr(command: string): boolean {
  // Git's global options may come first (`git -C dir switch x`, `git --no-pager pull`), each with its value where it takes one.
  const gitOpts = String.raw`(?:\s+(?:-[Cc]\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|-{1,2}[\w-]+(?:=\S+)?))*`
  return new RegExp(String.raw`\bgit` + gitOpts + String.raw`\s+(checkout|switch|push|commit|rebase|pull|merge|reset|branch)\b|\bgh\s+(pr|stack)\b`).test(command)
}

/** The mark for a PR's or stack item's state: merged ✓, closed ✕, queued ◎, draft ◌, open ○. */
export function prMark(p: { state?: Pr['state']; draft?: true; queued?: true }): string {
  if (p.state === 'merged') return '✓'
  if (p.state === 'closed') return '✕'
  if (p.queued === true) return '◎'
  if (p.draft === true) return '◌'
  return '○'
}

/** The checks' short mark: ✓ pass, ✗ fail, … pending, '' none. */
export const checksMark = (c: PrChecks | undefined): string => (c === 'pass' ? '✓' : c === 'fail' ? '✗' : c === 'pending' ? '…' : '')
