import { describe, expect, it } from 'vitest'

import { isDoc, labelOf, pathsOf, sigOf } from '../mod/hooks/model/label'

describe('labelOf', () => {
  it('pins the listed tools', () => {
    expect(labelOf('Bash', { command: 'npm test' })).toBe('Bash npm test')
    expect(labelOf('Read', { file_path: 'C:/r/src/a.ts' })).toBe('Read src/a.ts')
    expect(labelOf('Edit', { file_path: 'C:/r/src/a.ts', old_string: 'x' })).toBe('Edit src/a.ts')
    expect(labelOf('Write', { file_path: 'C:\\r\\docs\\b.md', content: 'x' })).toBe('Write docs/b.md')
    expect(labelOf('Grep', { pattern: 'on\\(' })).toBe('Grep "on\\("')
    expect(labelOf('Agent', { description: 'find sites', subagent_type: 'Explore' })).toBe('Agent Explore · find sites')
    expect(labelOf('TaskUpdate', { taskId: '3', status: 'completed' })).toBe('Task 3 → completed')
  })

  it('an unlisted tool is its name plus its first string argument', () => {
    expect(labelOf('Glob', { limit: 3, pattern: '**/*.ts', path: 'src' })).toBe('Glob **/*.ts')
    expect(labelOf('mcp__x__y', { n: 1, q: 'hello' })).toBe('mcp__x__y hello')
  })

  it('a 500-character command is cut to 80 with …', () => {
    const l = labelOf('Bash', { command: 'x'.repeat(500) })
    expect(l).toHaveLength(80)
    expect(l.endsWith('…')).toBe(true)
    expect(l.startsWith('Bash xxx')).toBe(true)
  })

  it('a multi-line command is one line', () => {
    expect(labelOf('Bash', { command: 'cd a\n  npm   test\r\n' })).toBe('Bash cd a npm test')
  })

  it('input with no string argument yields the bare tool name', () => {
    expect(labelOf('Thing', {})).toBe('Thing')
    expect(labelOf('Thing', { n: 1, b: true, o: { s: 'x' }, e: '' })).toBe('Thing')
  })
})

describe('pathsOf', () => {
  it('names file_path and notebook_path', () => {
    expect(pathsOf('Write', { file_path: 'a/b.ts', content: 'x' })).toEqual(['a/b.ts'])
    expect(pathsOf('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual(['n.ipynb'])
    expect(pathsOf('Bash', { command: 'ls' })).toEqual([])
  })
})

describe('isDoc', () => {
  it('checks the extension case-insensitively', () => {
    expect(isDoc('A/B.MD')).toBe(true)
    expect(isDoc('C:\\x\\report.Html')).toBe(true)
    expect(isDoc('a.ts')).toBe(false)
    expect(isDoc('md')).toBe(false)
    expect(isDoc('dir.md/file')).toBe(false)
  })
})

describe('sigOf', () => {
  it('is short, and the same for the same call with whitespace and key order changed', () => {
    const a = sigOf('Bash', { command: 'npm test' })
    expect(a.length).toBeGreaterThan(0)
    expect(a.length <= 16).toBe(true)
    expect(sigOf('Bash', { command: '  npm   test\n', description: 'run the tests' })).toBe(a)
    expect(sigOf('Glob', { pattern: '*.ts', path: 'src' })).toBe(sigOf('Glob', { path: 'src', pattern: '*.ts' }))
  })

  it('tells apart two long commands that share their first 80 characters', () => {
    const head = 'npx vitest run --reporter=verbose --coverage --coverage.reporter=text --pool=forks '
    expect(sigOf('Bash', { command: `${head}test/a.test.ts` })).not.toBe(sigOf('Bash', { command: `${head}test/b.test.ts` }))
  })

  it('a file tool is keyed by its path alone, so two hunks of one file share it', () => {
    const one = sigOf('Edit', { file_path: 'C:/r/src/x.ts', old_string: 'a', new_string: 'b' })
    expect(sigOf('Edit', { file_path: 'C:/r/src/x.ts', old_string: 'c', new_string: 'd' })).toBe(one)
    expect(sigOf('Edit', { file_path: 'C:/r/src/y.ts', old_string: 'a', new_string: 'b' })).not.toBe(one)
    expect(sigOf('Read', { file_path: 'C:/r/src/x.ts', offset: 1 })).toBe(sigOf('Read', { file_path: 'C:/r/src/x.ts', offset: 400 }))
  })

  it('tells tools apart, and other tools by their whole input', () => {
    expect(sigOf('Bash', { command: 'ls' })).not.toBe(sigOf('PowerShell', { command: 'ls' }))
    expect(sigOf('Grep', { pattern: 'x', path: 'a' })).not.toBe(sigOf('Grep', { pattern: 'x', path: 'b' }))
    expect(sigOf('TodoWrite', { todos: [{ content: 'a' }] })).not.toBe(sigOf('TodoWrite', { todos: [{ content: 'b' }] }))
  })

  it('takes a huge or odd input without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(sigOf('X', circular).length <= 16).toBe(true)
    expect(sigOf('Write', { file_path: 'a.md', content: 'x'.repeat(3_000_000) }).length <= 16).toBe(true)
  })
})
