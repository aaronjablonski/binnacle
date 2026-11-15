import { describe, expect, test } from 'vitest'

import {
  at, bar10, buckets10, DIAGRAM, fitRuns, keepCells, line, placed, promptTitle, shortPaths, spark10, stack10, toolCell, wordFit, wrapWords,
} from '../mod/hooks/views/fit'
import { C, cellCol, cellsFor, COL, GRID, rateColor, statusColor, TAB_CELL, tableCols, tier } from '../mod/hooks/views/style'

describe('the grid', () => {
  test('GRID is a 2-column margin and 12-column cells of 10 columns of content', () => {
    expect(GRID).toEqual({ margin: 2, cell: 12, content: 10 })
    expect([0, 1, 2, 3, 4].map(cellCol)).toEqual([2, 14, 26, 38, 50])
  })

  test('the fixed columns are the spec table', () => {
    expect(COL).toEqual({
      gutter: 0, glyph: 2, name: 4, detailKey: 6, action: 6, arg: 10, detailValue: 14, nameEnd: 36, metric: 38, time: 50,
    })
  })

  test('cellsFor is min(5, floor((cols - 2) / 12)) and never negative', () => {
    expect(cellsFor(62)).toBe(5)
    expect(cellsFor(120)).toBe(5)
    expect(cellsFor(61)).toBe(4)
    expect(cellsFor(50)).toBe(4)
    expect(cellsFor(49)).toBe(3)
    expect(cellsFor(38)).toBe(3)
    expect(cellsFor(37)).toBe(2)
    expect(cellsFor(32)).toBe(2)
    expect(cellsFor(13)).toBe(0)
    expect(cellsFor(0)).toBe(0)
  })

  test('tier follows the Widths table', () => {
    expect(tier(200)).toBe('wide')
    expect(tier(62)).toBe('wide')
    expect(tier(61)).toBe('mid')
    expect(tier(50)).toBe('mid')
    expect(tier(38)).toBe('mid')
    expect(tier(37)).toBe('icon')
    expect(tier(32)).toBe('icon')
    expect(tier(31)).toBe('slim')
    expect(tier(20)).toBe('slim')
    expect(TAB_CELL).toEqual({ wide: 12, mid: 7, icon: 5 })
  })

  test('tableCols: name, metric and time at 62; time on the last cell at 50 to 61 and 38 to 49; name only below', () => {
    expect(tableCols(62)).toEqual({ nameEnd: 36, metric: 38, time: 50 })
    expect(tableCols(90)).toEqual({ nameEnd: 36, metric: 38, time: 50 })
    expect(tableCols(61)).toEqual({ nameEnd: 36, time: 38 })
    expect(tableCols(50)).toEqual({ nameEnd: 36, time: 38 })
    expect(tableCols(49)).toEqual({ nameEnd: 24, time: 26 })
    expect(tableCols(38)).toEqual({ nameEnd: 24, time: 26 })
    expect(tableCols(37)).toEqual({ nameEnd: 37 })
    expect(tableCols(28)).toEqual({ nameEnd: 28 })
  })
})

describe('colours', () => {
  test('the HUD v2 keys are theme keys', () => {
    expect(C).toMatchObject({
      accent: 'suggestion', live: 'suggestion', wait: 'warning', error: 'error', fail: 'error',
      model: 'merged', doc: 'merged', result: 'success', rule: 'subtle', subtle: 'subtle',
    })
  })

  test('statusColor: live in the accent, done dim, failure in error, the rest dim', () => {
    expect(statusColor('running')).toBe('suggestion')
    expect(statusColor('in_progress')).toBe('suggestion')
    expect(statusColor('done')).toBe(undefined)
    expect(statusColor('completed')).toBe(undefined)
    expect(statusColor('error')).toBe('error')
    expect(statusColor('denied')).toBe('error')
    expect(statusColor('interrupted')).toBe(undefined)
    expect(statusColor('pending')).toBe(undefined)
  })

  test('rateColor: warning from 70 %, error from 90 %', () => {
    expect(rateColor(0)).toBe('suggestion')
    expect(rateColor(69)).toBe('suggestion')
    expect(rateColor(70)).toBe('warning')
    expect(rateColor(89)).toBe('warning')
    expect(rateColor(90)).toBe('error')
    expect(rateColor(140)).toBe('error')
  })
})

describe('at, placed and line', () => {
  test('segments land on their columns', () => {
    const s = line([at(2, '▸'), at(4, 'find callers'), at(38, '72k'), at(50, '1m')])
    expect(s.indexOf('▸')).toBe(2)
    expect(s.indexOf('find callers')).toBe(4)
    expect(s.indexOf('72k')).toBe(38)
    expect(s.indexOf('1m')).toBe(50)
    expect(s.length).toBe(52)
  })

  test('a start column offsets the line, as inside a Button that starts at column 2', () => {
    const s = line([at(2, '▸'), at(4, 'x'), at(38, 'm')], 2)
    expect(s.indexOf('▸')).toBe(0)
    expect(s.indexOf('m')).toBe(36)
  })

  test('placed hands each segment its gap; an overlapping segment starts right after the one before', () => {
    expect(placed([at(0, 'ab'), at(5, 'c')]).map(p => p.gap)).toEqual(['', '   '])
    expect(placed([at(0, 'abcdef'), at(3, 'g')]).map(p => p.gap)).toEqual(['', ''])
    expect(line([at(0, 'ab'), at(2, 'cd')])).toBe('abcd')
  })
})

describe('diagrams, all exactly 10 wide', () => {
  test('DIAGRAM is 10', () => {
    expect(DIAGRAM).toBe(10)
  })

  test('bar10: any non-zero value gets 1, only 100 % gets 10', () => {
    const n = (v: number, t: number) => bar10(v, t).fill.length
    expect(n(0, 100)).toBe(0)
    expect(n(1, 1000)).toBe(1)
    expect(n(9, 100)).toBe(1)
    expect(n(22, 100)).toBe(2)
    expect(n(9, 14)).toBe(6)
    expect(n(99, 100)).toBe(9)
    expect(n(999, 1000)).toBe(9)
    expect(n(100, 100)).toBe(10)
    expect(n(150, 100)).toBe(10)
    expect(n(5, 0)).toBe(0)
    expect(n(-3, 10)).toBe(0)
    for (const [v, t] of [[0, 1], [3, 7], [7, 7], [1, 3], [5, 0]] as const) {
      const b = bar10(v, t)
      expect(b.fill.length + b.rest.length).toBe(10)
      expect(b.fill).toBe('━'.repeat(b.fill.length))
      expect(b.rest).toBe('─'.repeat(b.rest.length))
    }
  })

  test('stack10: largest remainder, every non-zero part at least 1, sums to 10', () => {
    expect(stack10([2, 3, 1])).toEqual([3, 5, 2])
    expect(stack10([1, 1, 1])).toEqual([4, 3, 3])
    expect(stack10([98, 1, 1])).toEqual([8, 1, 1])
    expect(stack10([5, 0, 5])).toEqual([5, 0, 5])
    expect(stack10([1, 0, 0])).toEqual([10, 0, 0])
    expect(stack10([0, 0, 0])).toEqual([0, 0, 0])
    expect(stack10([])).toEqual([])
    for (const counts of [[2, 3, 1], [7, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [100, 1, 1, 1]]) {
      const w = stack10(counts)
      expect(w.reduce((a, b) => a + b, 0)).toBe(10)
    }
  })

  test('buckets10 counts times per tenth of the span', () => {
    expect(buckets10([0, 5, 15, 99, 100], 0, 100)).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 2])
    expect(buckets10([], 0, 100)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(buckets10([7, 7], 7, 7)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 2])
    expect(buckets10([-5, 200], 0, 100)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  test('spark10: 10 buckets, 8 levels scaled to the largest', () => {
    expect(spark10([2, 2, 3, 5, 3, 7, 5, 2, 3, 5])).toBe('▃▃▄▆▄█▆▃▄▆')
    expect(spark10([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('▁▁▁▁▁▁▁▁▁▁')
    expect(spark10([1, 2])).toHaveLength(10)
    expect(spark10([1, 2])).toBe('▁▁▁▁▁▁▁▁▅█')
    // more than 10 values: the newest 10 count
    expect(spark10([9, 9, 1, 1, 1, 1, 1, 1, 1, 1, 9, 9])).toBe('▂▂▂▂▂▂▂▂██')
  })
})

describe('words', () => {
  test('wordFit cuts at a word boundary and ends with …', () => {
    expect(wordFit('find every caller of stepRow', 40)).toBe('find every caller of stepRow')
    expect(wordFit('find every caller of stepRow', 20)).toBe('find every caller…')
    expect(wordFit('find every caller of stepRow', 18)).toBe('find every caller…')
    expect(wordFit('find every caller of stepRow', 17)).toBe('find every…')
    expect(wordFit('a  b\n c', 10)).toBe('a b c')
    expect(wordFit('abc', 0)).toBe('')
  })

  test('wordFit never ends inside a word when a word fits', () => {
    const text = 'Grouping timeline steps by agent and humanising their labels'
    const words = new Set(text.split(' '))
    // from 9, the room for the first word and its …
    for (let cols = 9; cols <= text.length; cols++) {
      const got = wordFit(text, cols)
      expect(got.length <= cols).toBe(true)
      const body = got.endsWith('…') ? got.slice(0, -1) : got
      for (const w of body.split(' ')) expect(words.has(w)).toBe(true)
    }
  })

  // BEHAVIOUR CHANGE (binding rule 1): a single word wider than the room was cut mid-word ('superca…').
  test('wordFit never cuts inside a word: a long token is cut where a part ends, else left out', () => {
    expect(wordFit('supercalifragilistic', 8)).toBe('')
    expect(wordFit('supercalifragilistic and more', 8)).toBe('')
    expect(wordFit('docs/superpowers/specs/rich.md', 20)).toBe('docs/superpowers…')
    expect(wordFit('Incomprehensibilities_of_the_internationalization', 30)).toBe('Incomprehensibilities_of_the…')
    expect(wordFit('SubagentHandback', 5)).toBe('')
  })

  test('toolCell: a tool whole, its short name, or nothing; never cut', () => {
    expect(toolCell('Edit')).toBe('Edit')
    expect(toolCell('SubagentHandback')).toBe('Hand')
    expect(toolCell('TodoWrite')).toBe('Todo')
    expect(toolCell('mcp__plugin__thing')).toBe('')
  })

  test('wrapWords: lines of at most cols, at most 2 by default, the last cut by word', () => {
    expect(wrapWords('Grouping timeline steps by agent', 22)).toEqual(['Grouping timeline', 'steps by agent'])
    expect(wrapWords('one two', 20)).toEqual(['one two'])
    expect(wrapWords('', 10)).toEqual([])
    expect(wrapWords('abc', 0)).toEqual([])
    const three = wrapWords('Grouping timeline steps by agent and humanising labels', 18)
    expect(three).toEqual(['Grouping timeline', 'steps by agent…'])
    expect(wrapWords('aa bb cc dd', 5, 3)).toEqual(['aa bb', 'cc dd'])
    expect(wrapWords('aa bb cc dd ee', 5, 1)).toEqual(['aa…'])
  })

  test('wrapWords marks a cut even when the last line would have room for the next word alone', () => {
    // at 5, 'e' would start a third line: the second ends with … rather than stopping silently
    expect(wrapWords('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd'])
    expect(wrapWords('aa bb cc dd e', 5)).toEqual(['aa bb', 'cc…'])
    for (const cols of [6, 10, 22]) {
      for (const l of wrapWords('Grouping timeline steps by agent and humanising labels', cols)) expect(l.length <= cols).toBe(true)
    }
  })

  test('fitRuns keeps the runs and cuts the last one by word', () => {
    const runs = [{ text: 'npm ' }, { text: 'test', u: true }, { text: ' -- timeline' }]
    expect(fitRuns(runs, 40)).toBe(runs)
    expect(fitRuns(runs, 10)).toEqual([{ text: 'npm ' }, { text: 'test', u: true }, { text: '…' }])
    expect(fitRuns(runs, 6)).toEqual([{ text: 'npm' }, { text: '…' }])
    expect(fitRuns(runs, 0)).toEqual([])
  })
})

describe('paths and titles', () => {
  test('shortPaths shortens each path to …/<last segment>', () => {
    expect(shortPaths('edit C:\\Users\\aaron\\mod\\hooks\\fit.ts now')).toBe('edit …/fit.ts now')
    expect(shortPaths('read mod/hooks/views/fit.ts, then /home/a/b.md.')).toBe('read …/fit.ts, then …/b.md.')
    expect(shortPaths('see (views/fit.ts)')).toBe('see (…/fit.ts)')
    expect(shortPaths('the dir mod/hooks/views/')).toBe('the dir …/views/')
  })

  test('shortPaths leaves what is not a path', () => {
    expect(shortPaths('count .ts files in mod/')).toBe('count .ts files in mod/')
    expect(shortPaths('9/14 done and/or 2026/11/15')).toBe('9/14 done and/or 2026/11/15')
    expect(shortPaths('open https://claude.ai/a/b/c')).toBe('open https://claude.ai/a/b/c')
    expect(shortPaths('plain words')).toBe('plain words')
  })

  test('promptTitle quotes the prompt on one line with its paths shortened', () => {
    expect(promptTitle('group timeline steps by agent')).toBe('“group timeline steps by agent”')
    expect(promptTitle('fix C:\\repo\\mod\\hooks\\fit.ts\nplease')).toBe('“fix …/fit.ts please”')
    expect(promptTitle('group timeline steps by agent', 20)).toBe('“group timeline…”')
    expect(promptTitle('   ')).toBe('')
  })

  test('promptTitle strips <agent-message> wrappers and names a hand-back by its label', () => {
    expect(promptTitle('<agent-message from="a8ea70b5622da885c">\n[Subagent hand-back] The text below is the final report')).toBe(
      '“Subagent hand-back”',
    )
    expect(promptTitle('<agent-message from="a1">count the files</agent-message>')).toBe('“count the files”')
  })
})

describe('keepCells', () => {
  test('drops by rank, lowest first, then from the end, keeping order', () => {
    const cells = [
      { id: 'TASKS' }, { id: 'AGENTS' }, { id: 'STEPS', drop: 2 }, { id: 'CTX', drop: 3 }, { id: '7D', drop: 1 },
    ]
    const ids = (n: number) => keepCells(cells, n).map(c => c.id)
    expect(ids(5)).toEqual(['TASKS', 'AGENTS', 'STEPS', 'CTX', '7D'])
    expect(ids(4)).toEqual(['TASKS', 'AGENTS', 'STEPS', 'CTX'])
    expect(ids(3)).toEqual(['TASKS', 'AGENTS', 'CTX'])
    expect(ids(2)).toEqual(['TASKS', 'AGENTS'])
    expect(ids(1)).toEqual(['TASKS'])
    expect(ids(0)).toEqual([])
  })
})
