import { describe, expect, it } from 'vitest'

import { isDoc, labelOf, pathsOf } from '../mod/hooks/model/label'

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
