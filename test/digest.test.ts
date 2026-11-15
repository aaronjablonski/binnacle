import { describe, expect, it } from 'vitest'

import type { Step, StepBody, Timeline } from '../mod/types'
import { digest, fenced, quoteOf, stamp, stepMarkdown } from '../mod/hooks/model/digest'
import { empty } from '../mod/hooks/model/reduce'

const NOW = 2_000_000
const step = (id: string, extra: Partial<Step> = {}): Step => ({
  id, seq: 1, agent: 'main', tool: 'Edit', label: `Edit ${id}.ts`, status: 'done', startedAt: 1, endedAt: 2, ...extra,
})
const body = (extra: Partial<StepBody> = {}): StepBody => ({ input: { file_path: 'a.ts' }, text: 'ok', cut: 0, isError: false, ...extra })

const tl: Timeline = {
  ...empty,
  turns: [{ id: 't1', agent: 'main', prompt: 'Add rate limiting\nto uploads', startedAt: 1 }],
  tasks: [
    { id: '1', subject: 'Read route', status: 'completed', owner: 'main', updatedAt: 1 },
    { id: '2', subject: 'Write limiter', status: 'pending', owner: 'main', updatedAt: 1 },
  ],
  notes: [{ text: 'bodyLimit runs first', agent: 'main', at: 1 }],
  steps: [step('p', { pin: 'the limiter' }), step('u')],
  artifacts: [{ id: 'a', kind: 'link', title: 'Design', ref: 'https://x.test/d', agent: 'main', count: 1, updatedAt: 1 }],
  changed: ['src/a.ts'],
}

describe('digest', () => {
  const out = digest(tl, { p: body({ text: 'PINNED-RESULT' }), u: body({ text: 'UNPINNED-RESULT' }) }, NOW)

  it('holds tasks, notes, artifacts, files', () => {
    expect(out).toContain('# Add rate limiting to uploads')
    expect(out).toContain('## Tasks (1/2)')
    expect(out).toContain('- [x] Read route')
    expect(out).toContain('- [ ] Write limiter')
    expect(out).toContain('- bodyLimit runs first')
    expect(out).toContain('- Design (link) https://x.test/d')
    expect(out).toContain('- src/a.ts')
  })

  it('holds pinned bodies and never unpinned ones', () => {
    expect(out).toContain('### ★ Edit p.ts')
    expect(out).toContain('Note: the limiter')
    expect(out).toContain('PINNED-RESULT')
    expect(out).toContain('"file_path": "a.ts"')
    expect(out).not.toContain('UNPINNED-RESULT')
  })

  it('cuts input and result to 2,000 characters each', () => {
    const long = digest(tl, { p: body({ text: 'x'.repeat(5000), input: { c: 'y'.repeat(5000) } }) }, NOW)
    expect(long).toContain('x'.repeat(2000))
    expect(long).not.toContain('x'.repeat(2001))
    expect(long).toContain('… 3000 more characters not shown')
    expect(long).not.toContain('y'.repeat(2001))
  })

  it('lists open problems and says None when empty', () => {
    const asking: Timeline = { ...tl, steps: [step('r', { status: 'running', asking: 5, label: 'Bash rm' })] }
    expect(digest(asking, {}, NOW)).toContain('- asking: Bash rm')
    expect(out).toContain('## Open problems\n\n_None._')
    expect(digest(empty, {}, NOW)).toContain('# Session handoff')
  })

  it('says when a pinned body is not kept', () => {
    expect(digest(tl, {}, NOW)).toContain('_Result not kept on disk._')
  })
})

describe('pieces', () => {
  it('fenced grows its fence past backticks inside', () => {
    expect(fenced('a')).toBe('```\na\n```')
    expect(fenced('```x```')).toBe('````\n```x```\n````')
  })
  it('stepMarkdown has tool, input and result in fences', () => {
    const md = stepMarkdown(step('s'), body())
    expect(md).toContain('Tool: Edit (done)')
    expect(md).toContain('```json\n{\n  "file_path": "a.ts"\n}\n```')
    expect(md).toContain('Result:\n\n```\nok\n```')
  })
  it('quoteOf puts > before every line', () => {
    const q = quoteOf(step('s'), body({ text: 'a\n\nb' }))
    expect(q.split('\n').filter(l => l !== '').every(l => l.startsWith('>'))).toBe(true)
    expect(q).toContain('>\n')
    expect(q.endsWith('\n')).toBe(true)
  })
  it('stamp is yyyy-mm-dd-hhmm', () => {
    expect(stamp(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/)
  })
})
