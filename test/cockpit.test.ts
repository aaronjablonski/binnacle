import { describe, expect, test } from 'vitest'

import { countdown, doing, pctBar, ruleBar, span, todoBar, TOOL_NAMES, toolName, toolRoom, wrapWords } from '../mod/hooks/views/fit'
import { CK, COCKPIT, critterArgs, critterGlyph, critterOf, crewRole, edges, gaugeStyle, groundOf, isTextTheme, motionOn, themeOf, typeName } from '../mod/hooks/views/style'
import type { Run } from '../mod/hooks/views/style'

const textOf = (runs: Run[]) => runs.map(r => r.text).join('')

describe('doing(step): tool calls as the spec’s verbs', () => {
  test('Read, Grep, Glob, Bash, Edit, Write, Agent, thinking and asking', () => {
    expect(doing({ tool: 'Read', label: 'Read server/upload.ts', pending: { file_path: '/repo/src/server/upload.ts' } })).toBe('Reading server/upload.ts')
    expect(doing({ tool: 'Grep', label: 'Grep "upload("', pending: { pattern: 'upload(', path: 'src/server' } })).toBe('Searching src/server for “upload(”')
    expect(doing({ tool: 'Grep', label: 'Grep "upload("' })).toBe('Searching for “upload(”')
    expect(doing({ tool: 'Glob', label: 'Glob **/*.ts', pending: { pattern: '**/*.ts' } })).toBe('Searching for **/*.ts')
    expect(doing({ tool: 'Bash', label: 'Bash npm test upload', pending: { command: 'npm test upload' } })).toBe('Running npm test upload')
    expect(doing({ tool: 'Bash', label: 'Bash npm test upload' })).toBe('Running npm test upload')
    expect(doing({ tool: 'Edit', label: 'Edit test/rateLimit.test.ts' })).toBe('Editing test/rateLimit.test.ts')
    expect(doing({ tool: 'Write', label: 'Write docs/plan.md', pending: { file_path: 'C:\\repo\\docs\\plan.md' } })).toBe('Writing docs/plan.md')
    expect(doing({ tool: 'Agent', label: 'Agent Explore · find every caller', pending: { subagent_type: 'Explore', description: 'find every caller' } })).toBe('Delegating: find every caller')
    expect(doing({ tool: 'Agent', label: 'Agent Explore · find every caller' })).toBe('Delegating: find every caller')
    expect(doing(undefined)).toBe('Thinking')
    expect(doing({ tool: 'Bash', label: 'Bash rm -rf build', asking: 1 })).toBe('Waiting for your answer')
    expect(doing({ tool: 'AskUserQuestion', label: 'AskUserQuestion which one?' })).toBe('Waiting for your answer')
  })

  test('the rest: the to-do tools, the web, skills, MCP tools; never a raw tool name first', () => {
    expect(doing({ tool: 'TodoWrite', label: 'TodoWrite' })).toBe('Updating the to-do list')
    expect(doing({ tool: 'TaskUpdate', label: 'Task 3 → completed' })).toBe('Updating the to-do list')
    expect(doing({ tool: 'WebFetch', label: 'WebFetch https://example.com/a', pending: { url: 'https://example.com/a' } })).toBe('Reading example.com')
    expect(doing({ tool: 'WebSearch', label: 'WebSearch rate limits', pending: { query: 'rate limits' } })).toBe('Searching the web for “rate limits”')
    expect(doing({ tool: 'mcp__github__get_issue', label: 'mcp__github__get_issue 12' })).toBe('Using get_issue')
    expect(doing({ tool: 'Edit', label: 'Edit' })).toBe('Editing')
  })
})

describe('wrapWords: the headline (2 lines) and slim (3)', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean)
  const SAMPLES = [
    'Wiring the limiter into the middleware chain',
    'Rate limiting is wired in and tested',
    'Map every caller of upload() across src/server and the CLI before changing anything',
    'a b c d e f g h i j k l m n o p q r s t u v w x y z',
    'Short',
  ]

  test('never cuts a word, and never ends in … while the text fits the lines', () => {
    for (const s of SAMPLES) {
      for (const cols of [12, 20, 24, 29, 40]) {
        for (const max of [2, 3]) {
          const lines = wrapWords(s, cols, max)
          expect(lines.length).toBeLessThanOrEqual(max)
          for (const l of lines) expect(l.length).toBeLessThanOrEqual(cols)
          const out = lines.join(' ')
          const cut = out.endsWith('…')
          // every word drawn is a whole word of the text (the last may carry the … of a cut)
          const drawn = words(out.replace(/…$/, ''))
          const src = words(s)
          drawn.forEach((w, i) => expect(w).toBe(src[i]))
          // fits: greedy wrapping holds every word in `max` lines, so nothing may be cut
          const fits = src.every(w => w.length <= cols) && greedyLines(src, cols) <= max
          if (fits) {
            expect(cut).toBe(false)
            expect(drawn).toEqual(src)
          }
        }
      }
    }
  })

  test('the mock headline at 29: two lines, cut at a word', () => {
    expect(wrapWords('Wiring the limiter into the middleware chain', 29, 2)).toEqual(['Wiring the limiter into the', 'middleware chain'])
    expect(wrapWords('Wiring the limiter into the middleware chain', 24, 3)).toEqual(['Wiring the limiter into', 'the middleware chain'])
  })
})

function greedyLines(words: string[], cols: number): number {
  let lines = 0
  let w = -1
  for (const x of words) {
    if (w >= 0 && w + 1 + x.length <= cols) w += 1 + x.length
    else {
      lines++
      w = x.length
    }
  }
  return lines
}

describe('tool names in narrow columns (R31)', () => {
  test('short names at middle widths; the column dropped below 40', () => {
    expect(toolRoom(62)).toBe(5)
    expect(toolRoom(48)).toBe(5)
    expect(toolRoom(40)).toBe(5)
    expect(toolRoom(39)).toBe(0)
    expect(toolName('TaskCreate', toolRoom(48))).toBe('Task+')
    expect(toolName('TaskUpdate', toolRoom(48))).toBe('Task✓')
    expect(toolName('SubagentHandback', 5)).toBe('Back')
    expect(toolName('NotebookEdit', 5)).toBe('Cell')
    expect(toolName('TodoWrite', 5)).toBe('Todo')
    expect(toolName('WebSearch', 5)).toBe('Web')
    expect(toolName('WebFetch', 5)).toBe('Fetch')
    expect(toolName('MultiEdit', 5)).toBe('Edit')
    expect(toolName('Edit', 5)).toBe('Edit')
    expect(toolName('Read', toolRoom(39))).toBe('')
  })

  test('the R31 list, each name 5 wide or less', () => {
    for (const n of ['Edit', 'Read', 'Write', 'Bash', 'Grep', 'Glob', 'Agent', 'Skill']) expect(toolName(n, 5)).toBe(n)
    for (const v of Object.values(TOOL_NAMES)) expect([...v].length).toBeLessThanOrEqual(5)
  })

  test('an MCP tool takes its last part, cut at a word; a cell other rows fill is never empty', () => {
    expect(toolName('mcp__github__get_issue', 5)).toBe('get')
    expect(toolName('mcp__x__list', 5)).toBe('list')
    expect(toolName('mcp__mission-control__update', 6)).toBe('update')
    for (const t of ['mcp__mission-control__update', 'StructuredOutput', 'SomethingUnheardOf', 'mcp__a__b', 'X']) {
      for (const room of [1, 3, 5, 8]) {
        const got = toolName(t, room)
        expect(got.length).toBeGreaterThan(0)
        expect([...got].length).toBeLessThanOrEqual(room)
      }
    }
  })
})

describe('words: durations (R27)', () => {
  test('45s, 2m 14s on Steps only, 12 min, 1 h 12 min, m:ss for a countdown', () => {
    expect(span(45_000)).toBe('45s')
    expect(span(134_000, { steps: true })).toBe('2m 14s')
    expect(span(134_000)).toBe('2 min')
    expect(span(12 * 60_000 + 5_000)).toBe('12 min')
    expect(span(72 * 60_000)).toBe('1 h 12 min')
    expect(span(120 * 60_000)).toBe('2 h')
    expect(span(-5)).toBe('0s')
    expect(countdown(288_000)).toBe('4:48')
  })
})

describe('bars in ━ (R13, R22)', () => {
  test('todoBar: one segment a task with a one-cell gap, exactly the width', () => {
    const b = todoBar(58, 14, 9, 1)
    expect(textOf(b)).toHaveLength(58)
    const segs = textOf(b).split(' ')
    expect(segs).toHaveLength(14)
    expect(segs.every(s => /^━{3,4}$/.test(s))).toBe(true)
    const lit = b.filter(r => r.text.includes('━'))
    expect(lit.find(r => r.color === CK.accent && r.dim !== true)?.text).toMatch(/^━{3,4}$/)
    expect(b.some(r => r.color === 'subtle')).toBe(true)
  })

  test('todoBar: more tasks than cells is proportional (done, current, open) with no gaps', () => {
    const b = todoBar(24, 40, 30, 1)
    expect(textOf(b)).toBe('━'.repeat(24))
    expect(b.map(r => (r.dim === true ? 'done' : r.color === CK.accent ? 'now' : 'open'))).toEqual(['done', 'now', 'open'])
  })

  test('todoBar: all done is success; no tasks is the rest', () => {
    expect(todoBar(20, 4, 4, 0).every(r => r.text.trim() === '' || r.color === 'success')).toBe(true)
    expect(todoBar(10, 0, 0, 0)).toEqual([{ text: '━'.repeat(10), color: 'subtle' }])
  })

  test('ruleBar and pctBar: exactly the width, a non-zero part keeps a cell', () => {
    const r = ruleBar(28, [{ count: 71, color: CK.accent }, { count: 29, dim: true }])
    expect(textOf(r)).toBe('━'.repeat(28))
    expect(r[0]!.text.length).toBe(20)
    expect(textOf(ruleBar(10, [{ count: 1000 }, { count: 1, color: 'x' }]))).toHaveLength(10)
    expect(ruleBar(10, [{ count: 1000 }, { count: 1, color: 'x' }]).some(p => p.color === 'x')).toBe(true)
    expect(textOf(pctBar(9, 62))).toBe('━'.repeat(9))
    expect(pctBar(9, 1)[0]).toEqual({ text: '━', color: 'suggestion' })
    expect(pctBar(9, 0)).toEqual([{ text: '━'.repeat(9), color: 'subtle' }])
  })
})

describe('style: ground, theme, columns, roles', () => {
  test('groundOf (R21): night and day win, auto reads the theme', () => {
    expect(groundOf('day', 'dark')).toBe('day')
    expect(groundOf('night', 'light')).toBe('night')
    expect(groundOf('auto', 'light')).toBe('day')
    expect(groundOf('auto', 'light-daltonized')).toBe('day')
    expect(groundOf(undefined, 'light-ansi')).toBe('day')
    expect(groundOf('auto', 'dark')).toBe('night')
    expect(groundOf('auto', undefined)).toBe('night')
    expect(isTextTheme('dark-ansi')).toBe(true)
    expect(isTextTheme('light-daltonized')).toBe(true)
    expect(isTextTheme('dark')).toBe(false)
    expect(motionOn(undefined)).toBe(true)
    expect(motionOn('off')).toBe(false)
  })

  test('themeOf reads the theme row and never throws', async () => {
    expect(await themeOf({ config: { list: async () => [{ key: 'model', value: 'x' }, { key: 'theme', value: 'light' }] } })).toBe('light')
    expect(await themeOf({ config: { list: async () => { throw new Error('no') } } })).toBeUndefined()
  })

  test('columns: content 2 to 59 at 62, slim from 1; the header stops', () => {
    expect(edges(62)).toEqual({ left: 2, right: 59 })
    expect(edges(26)).toEqual({ left: 1, right: 24 })
    expect(COCKPIT).toMatchObject({ text: 9, gauge: 40, gauge2: 51, mid: 49, right: 59, headline: 29 })
  })

  test('gauge words (R9): dim, bold ink from 70, red from 90; never amber', () => {
    expect(gaugeStyle(62)).toEqual({ dim: true })
    expect(gaugeStyle(70)).toEqual({ bold: true })
    expect(gaugeStyle(95)).toEqual({ color: 'error' })
  })

  test('role words never lie (R23): friendly types; only main is the lead; unknown builds', () => {
    expect(typeName('general-purpose')).toBe('General')
    expect(typeName('Explore')).toBe('Explorer')
    expect(typeName('code-reviewer')).toBe('Code reviewer')
    expect(typeName('statusLineSetup')).toBe('Status line setup')
    expect(typeName('main')).toBe('Claude')
    expect(crewRole('main', 'main')).toBe('lead')
    expect(crewRole('a1', 'Plan')).toBe('build')
    expect(crewRole('a1', 'Explore')).toBe('scout')
    expect(crewRole('a1', 'code-reviewer')).toBe('check')
    expect(crewRole('a1', 'whatever')).toBe('build')
  })

  test('a critter instrument: 6 x 3 small, 5 x 2 micro, the text form the same size (R22)', () => {
    const s = critterArgs('build', 'waiting', { size: 'small' })
    expect([s.columns, s.rows]).toEqual([6, 3])
    expect(s.fallback).toHaveLength(3)
    for (const row of s.fallback) expect(textOf(row)).toHaveLength(6)
    expect(textOf(s.fallback[0]!)).toBe('●    ?')
    expect(textOf(s.fallback[1]!)).toBe('build ')
    const m = critterArgs('scout', 'failed', { size: 'micro' })
    expect([m.columns, m.rows]).toEqual([5, 2])
    expect(m.fallback.map(textOf)).toEqual(['×   !', 'scout'])
    expect(critterGlyph('failed').badge).toEqual({ text: '!', color: 'error', bold: true })
    const f = s.frames()
    expect([f[0]!.columns, f[0]!.rows]).toEqual([6, 3])
    const a = critterOf({ id: 'a7', type: 'Explore', status: 'running' }, { motion: true })
    expect(a.role).toBe('scout')
    expect(a.frames()).toHaveLength(4)
    expect(critterOf({ id: 'a7', type: 'Explore', status: 'running' }, { motion: false }).frames()).toHaveLength(1)
  })
})
