import { describe, expect, it } from 'vitest'

import { buildPrState, checksMark, parsePrList, parseStack, prMark, rollChecks, stackIndex, touchesPr } from '../mod/hooks/model/pr'

const STACK = JSON.stringify({
  trunk: 'main',
  currentBranch: 's2',
  branches: [
    { name: 's1', base: 'a', isCurrent: false, isMerged: true, isQueued: false, needsRebase: false, pr: { number: 10, url: 'https://github.com/o/r/pull/10' } },
    { name: 's2', base: 'b', isCurrent: true, isMerged: false, isQueued: false, needsRebase: true },
    { name: 's3', base: 'c', isCurrent: false, isMerged: false, isQueued: true, needsRebase: false },
  ],
})

const pr = (n: number, head: string, extra: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: head,
  reviewDecision: '', statusCheckRollup: [], ...extra,
})

describe('rollChecks', () => {
  it('reads none, pass, pending and fail', () => {
    expect(rollChecks([])).toBe('none')
    expect(rollChecks(undefined)).toBe('none')
    expect(rollChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe('pass')
    expect(rollChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending')
    expect(rollChecks([{ state: 'PENDING' }])).toBe('pending')
    expect(rollChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('fail')
    expect(rollChecks([{ state: 'ERROR' }])).toBe('fail')
    expect(rollChecks([{ state: 'SUCCESS' }])).toBe('pass')
  })
})

describe('parsePrList', () => {
  it('keys PRs by head branch and maps state, draft, review and checks', () => {
    const m = parsePrList(JSON.stringify([
      pr(7, 'feat/a', { isDraft: true, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
      pr(8, 'feat/b', { state: 'MERGED', reviewDecision: 'APPROVED' }),
    ]))
    expect(m.get('feat/a')).toEqual({ number: 7, title: 'PR 7', url: 'https://github.com/o/r/pull/7', head: 'feat/a', state: 'open', draft: true, checks: 'pass', review: 'changes' })
    expect(m.get('feat/b')).toMatchObject({ state: 'merged', review: 'approved', checks: 'none' })
  })

  it('prefers the open PR on a branch, then the newest', () => {
    const m = parsePrList(JSON.stringify([pr(9, 'x', { state: 'OPEN' }), pr(12, 'x', { state: 'CLOSED' }), pr(3, 'y', { state: 'CLOSED' }), pr(5, 'y', { state: 'MERGED' })]))
    expect(m.get('x')?.number).toBe(9)
    expect(m.get('y')?.number).toBe(5)
  })

  it('answers empty for malformed or missing output', () => {
    expect(parsePrList('').size).toBe(0)
    expect(parsePrList('not json').size).toBe(0)
    expect(parsePrList('{"a":1}').size).toBe(0)
    expect(parsePrList(JSON.stringify([{ title: 'no number' }])).size).toBe(0)
  })
})

describe('parseStack', () => {
  it('reads the real gh stack view --json shape, bottom first', () => {
    expect(parseStack(STACK)).toEqual({
      trunk: 'main', current: 's2',
      branches: [
        { name: 's1', merged: true, queued: false, rebase: false, number: 10, url: 'https://github.com/o/r/pull/10' },
        { name: 's2', merged: false, queued: false, rebase: true },
        { name: 's3', merged: false, queued: true, rebase: false },
      ],
    })
  })

  it('falls back to isCurrent and to main', () => {
    const s = parseStack(JSON.stringify({ branches: [{ name: 'a' }, { name: 'b', isCurrent: true }] }))
    expect(s?.current).toBe('b')
    expect(s?.trunk).toBe('main')
  })

  it('answers undefined off a stack', () => {
    expect(parseStack('')).toBe(undefined)
    expect(parseStack('✗ current branch "main" is not part of a stack')).toBe(undefined)
    expect(parseStack(JSON.stringify({ branches: [] }))).toBe(undefined)
  })
})

describe('buildPrState', () => {
  const prs = parsePrList(JSON.stringify([pr(11, 's2', { statusCheckRollup: [{ state: 'FAILURE' }] }), pr(12, 's3', { isDraft: true })]))

  it('a single PR off a stack', () => {
    const st = buildPrState(5, 's2', prs)
    expect(st).toMatchObject({ at: 5, branch: 's2', current: { number: 11, checks: 'fail' } })
    expect(st.stack).toBe(undefined)
  })

  it('a branch with no PR', () => {
    expect(buildPrState(5, 'lonely', prs)).toEqual({ at: 5, branch: 'lonely' })
  })

  it('a stack: each member with its PR, the stack PR number when gh pr list missed it', () => {
    const st = buildPrState(5, 's2', prs, parseStack(STACK))
    expect(st.stack?.trunk).toBe('main')
    expect(st.stack?.items).toEqual([
      { branch: 's1', number: 10, url: 'https://github.com/o/r/pull/10', state: 'merged' },
      { branch: 's2', number: 11, url: 'https://github.com/o/r/pull/11', title: 'PR 11', checks: 'fail', state: 'open', rebase: true },
      { branch: 's3', number: 12, url: 'https://github.com/o/r/pull/12', title: 'PR 12', checks: 'none', draft: true, state: 'open', queued: true },
    ])
    expect(stackIndex(st)).toBe(1)
  })

  it('a stack the current branch is not on is ignored', () => {
    expect(buildPrState(5, 'other', prs, parseStack(STACK)).stack).toBe(undefined)
  })
})

describe('marks and triggers', () => {
  it('prMark and checksMark', () => {
    expect(prMark({ state: 'merged' })).toBe('✓')
    expect(prMark({ state: 'closed' })).toBe('✕')
    expect(prMark({ state: 'open', queued: true })).toBe('◎')
    expect(prMark({ state: 'open', draft: true })).toBe('◌')
    expect(prMark({})).toBe('○')
    expect(checksMark('pass') + checksMark('fail') + checksMark('pending') + checksMark('none')).toBe('✓✗…')
  })

  it('touchesPr picks branch-moving git and gh pr/stack commands', () => {
    for (const c of ['git checkout -b x', 'git switch main', 'git push -u origin x', 'cd a && git commit -m y', 'gh pr create --fill', 'gh stack submit', 'git rebase main'])
      expect(touchesPr(c)).toBe(true)
    for (const c of ['git status', 'git log --oneline', 'git diff', 'gh issue list', 'npm test', 'echo github'])
      expect(touchesPr(c)).toBe(false)
  })
})
