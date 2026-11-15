import { describe, expect, test } from 'vitest'

import { bar, buckets, crewRow, meter, pillRun, pips, spark, tether } from '../mod/hooks/views/fit'
import { ASCII, C, dialOf, GLYPHS, HULL, podOf, podStateOf, RAIL, roleOf, TETHER, UNICODE } from '../mod/hooks/views/style'
import type { Pod, PodState, Role, Run } from '../mod/hooks/views/style'

const text = (runs: Run[]): string => runs.map(r => r.text).join('')
const EVEN = 4_000 // Math.floor(4000 / 1000) % 2 === 0: the pulse's bold beat
const ODD = 5_000

describe('the glyph sets', () => {
  test('GLYPHS is the Unicode set; the ASCII set sits beside it with the same shape', () => {
    expect(GLYPHS).toBe(UNICODE)
    expect(Object.keys(ASCII).sort()).toEqual(Object.keys(UNICODE).sort())
    expect(Object.keys(ASCII.hull).sort()).toEqual(['build', 'check', 'lead', 'scout'])
  })

  test('every hull is one Geometric Shapes character; every ASCII glyph is one printable ASCII character', () => {
    for (const role of ['lead', 'scout', 'build', 'check'] as const) {
      for (const g of UNICODE.hull[role]) {
        expect(g.length).toBe(1)
        expect(g.codePointAt(0)! >= 0x25a0 && g.codePointAt(0)! <= 0x25ff).toBe(true)
      }
      for (const g of ASCII.hull[role]) expect(/^[\x21-\x7e]$/.test(g)).toBe(true)
    }
    for (const g of [...ASCII.dial, ...ASCII.pip, ...ASCII.sparks, ASCII.bar.lit, ASCII.bar.rest]) expect(/^[\x21-\x7e]$/.test(g)).toBe(true)
  })

  test('HULL maps each role to its outline, lit and solid glyph (spec "Crew: pods")', () => {
    expect(HULL).toEqual({
      lead: ['◇', '◈', '◆'],
      scout: ['○', '◉', '●'],
      build: ['□', '▣', '■'],
      check: ['△', '◬', '▲'],
    })
  })

  test('RAIL and TETHER name the bracket and tree glyphs', () => {
    expect(RAIL).toEqual({ top: '┏', mid: '┃', bottom: '┗', topRight: '┓', bottomRight: '┛' })
    expect(TETHER).toEqual({ mid: '├╌', last: '╰╌', guide: '┆' })
  })

  test('the palette adds the lead and spark colour (claude) and the pill text (inverseText)', () => {
    expect(C.lead).toBe('claude')
    expect(C.spark).toBe('claude')
    expect(C.inverse).toBe('inverseText')
  })
})

describe('roleOf', () => {
  test('the main conversation, Plan and planners lead', () => {
    for (const t of ['main', 'Plan', 'planner', 'sprint-planner', 'PLAN']) expect(roleOf(t)).toBe('lead')
  })
  test('Explore, search and research scout', () => {
    for (const t of ['Explore', 'explorer', 'code-search', 'web-research', 'Researcher', 'SEARCH']) expect(roleOf(t)).toBe('scout')
  })
  test('review, test and verify check', () => {
    for (const t of ['code-reviewer', 'Review', 'test-runner', 'unit-tester', 'verifier', 'verify-fix', 'VERIFY']) expect(roleOf(t)).toBe('check')
  })
  test('general-purpose, implementers, workflow agents and anything unknown build', () => {
    for (const t of ['general-purpose', 'implementer', 'workflow-subagent', 'statusline-setup', '', 'zzz']) expect(roleOf(t)).toBe('build')
  })
})

describe('podOf', () => {
  const ROLES: { role: Role; type: string; id: string }[] = [
    { role: 'lead', type: 'main', id: 'main' },
    { role: 'scout', type: 'Explore', id: 'a1' },
    { role: 'build', type: 'general-purpose', id: 'a2' },
    { role: 'check', type: 'code-reviewer', id: 'a3' },
  ]
  const status = (s: PodState) => (s === 'done' ? 'done' : s === 'failed' ? 'error' : 'running') as 'running' | 'done' | 'error'

  for (const { role, type, id } of ROLES) {
    const [outline, lit, solid] = HULL[role]
    const pod = (state: PodState, now = EVEN): Pod => podOf({ id, type, status: status(state), state }, now)

    test(`${role}: queued is the outline, dim, with no signal`, () => {
      expect(pod('queued')).toEqual({ role, state: 'queued', hull: { text: outline, dim: true } })
    })
    test(`${role}: working is the lit core, bold in ${role === 'lead' ? 'claude' : 'the accent'} on the even second, plain on the odd`, () => {
      const color = role === 'lead' ? 'claude' : 'suggestion'
      expect(pod('working', EVEN)).toEqual({ role, state: 'working', hull: { text: lit, color, bold: true } })
      expect(pod('working', ODD)).toEqual({ role, state: 'working', hull: { text: lit, color } })
    })
    test(`${role}: waiting is the lit core in warning, bold, with a bold ? in warning; no pulse`, () => {
      const p = { role, state: 'waiting', hull: { text: lit, color: 'warning', bold: true }, signal: { text: '?', color: 'warning', bold: true } }
      expect(pod('waiting', EVEN)).toEqual(p)
      expect(pod('waiting', ODD)).toEqual(p)
    })
    test(`${role}: stalled is the lit core in warning with z`, () => {
      expect(pod('stalled')).toEqual({ role, state: 'stalled', hull: { text: lit, color: 'warning' }, signal: { text: 'z', color: 'warning' } })
    })
    test(`${role}: failed is the outline in error with a bold !`, () => {
      expect(pod('failed')).toEqual({ role, state: 'failed', hull: { text: outline, color: 'error' }, signal: { text: '!', color: 'error', bold: true } })
    })
    test(`${role}: done is solid and dim`, () => {
      expect(pod('done')).toEqual({ role, state: 'done', hull: { text: solid, dim: true } })
    })
  }

  test('the state follows the status when none is given: running works, error fails, done is done', () => {
    expect(podStateOf({ id: 'a', type: 'Explore', status: 'running' })).toBe('working')
    expect(podStateOf({ id: 'a', type: 'Explore', status: 'error' })).toBe('failed')
    expect(podStateOf({ id: 'a', type: 'Explore', status: 'done' })).toBe('done')
    expect(podStateOf({ id: 'a', type: 'Explore', status: 'running', state: 'stalled' })).toBe('stalled')
  })

  test('the role comes from subagentType when present, else the type; main is always the lead', () => {
    expect(podOf({ id: 'a', type: 'general-purpose', subagentType: 'Explore', status: 'done' }, EVEN).role).toBe('scout')
    expect(podOf({ id: 'a', type: 'code-reviewer', status: 'done' }, EVEN).role).toBe('check')
    expect(podOf({ id: 'main', type: 'whatever', status: 'running' }, EVEN).role).toBe('lead')
  })
})

describe('dialOf', () => {
  test('○ at 0, ◔ up to 25, ◑ up to 50, ◕ under 100, ● at 100', () => {
    const g = (p: number) => dialOf(p).text
    expect(g(0)).toBe('○')
    expect(g(-5)).toBe('○')
    expect(g(1)).toBe('◔')
    expect(g(25)).toBe('◔')
    expect(g(26)).toBe('◑')
    expect(g(50)).toBe('◑')
    expect(g(51)).toBe('◕')
    expect(g(99)).toBe('◕')
    expect(g(99.9)).toBe('◕')
    expect(g(100)).toBe('●')
    expect(g(140)).toBe('●')
  })
  test('the accent under 70, warning from 70, error from 90', () => {
    expect(dialOf(69).color).toBe('suggestion')
    expect(dialOf(70).color).toBe('warning')
    expect(dialOf(89).color).toBe('warning')
    expect(dialOf(90).color).toBe('error')
  })
})

describe('meter', () => {
  test('`CTX ◔ 9%`: the label dim, the dial, the value bold; at most 10 wide', () => {
    expect(meter('CTX', 9)).toEqual([
      { text: 'CTX', dim: true },
      { text: ' ' },
      { text: '◔', color: 'suggestion' },
      { text: ' ' },
      { text: '9%', bold: true },
    ])
    expect(text(meter('CTX', 100)).length).toBeLessThanOrEqual(10)
    expect(text(meter('5H', 78))).toBe('5H ◕ 78%')
  })
  test('from 70 the value takes the rate colour', () => {
    expect(meter('5H', 78)[4]).toEqual({ text: '78%', bold: true, color: 'warning' })
    expect(meter('7D', 96)[4]).toEqual({ text: '96%', bold: true, color: 'error' })
  })
  test('a fraction is rounded; a value past 100 still fits 10', () => {
    expect(text(meter('7D', 22.4))).toBe('7D ◔ 22%')
    expect(text(meter('CTX', 250)).length).toBeLessThanOrEqual(10)
  })
})

describe('bar', () => {
  const lit = (v: number, t: number, n: 10 | 22 = 10) => (bar(v, t, n).find(r => r.text.startsWith('▮'))?.text ?? '').length

  test('exactly 10 or 22 cells of ▮ and ▯', () => {
    for (const n of [10, 22] as const) {
      for (const [v, t] of [[0, 100], [1, 100], [50, 100], [99, 100], [100, 100], [5, 0], [300, 100]]) {
        const s = text(bar(v!, t!, n))
        expect(s.length).toBe(n)
        expect(/^▮*▯*$/.test(s)).toBe(true)
      }
    }
  })
  test('any non-zero value lights one cell; only 100 % lights all', () => {
    expect(lit(0, 100)).toBe(0)
    expect(lit(1, 1000)).toBe(1)
    expect(lit(1, 1000, 22)).toBe(1)
    expect(lit(99, 100)).toBe(9)
    expect(lit(99.9, 100, 22)).toBe(21)
    expect(lit(100, 100)).toBe(10)
    expect(lit(100, 100, 22)).toBe(22)
    expect(lit(150, 100)).toBe(10)
    expect(lit(50, 100)).toBe(5)
    expect(lit(9, 100, 22)).toBe(2)
    expect(lit(5, 0)).toBe(0)
    expect(lit(-3, 10)).toBe(0)
  })
  test('the lit run takes the rate colour by default (or the colour given); the rest is subtle', () => {
    expect(bar(18, 100, 22)).toEqual([
      { text: '▮'.repeat(4), color: 'suggestion' },
      { text: '▯'.repeat(18), color: 'subtle' },
    ])
    expect(bar(78, 100, 10)[0]?.color).toBe('warning')
    expect(bar(96, 100, 10)[0]?.color).toBe('error')
    expect(bar(993, 1512, 10, 'merged')[0]).toEqual({ text: '▮▮▮▮▮▮▮', color: 'merged' })
    expect(bar(0, 100, 10)).toEqual([{ text: '▯'.repeat(10), color: 'subtle' }])
    expect(bar(100, 100, 10)).toEqual([{ text: '▮'.repeat(10), color: 'error' }])
    expect(bar(5, 5, 10, 'suggestion')).toEqual([{ text: '▮'.repeat(10), color: 'suggestion' }])
  })
})

describe('pips', () => {
  test('one per task: ▪ done dim, ▸ current bold in the accent, ▫ queued dim', () => {
    expect(pips(9, 14)).toEqual([
      { text: '▪'.repeat(9), dim: true },
      { text: '▸', color: 'suggestion', bold: true },
      { text: '▫'.repeat(4), dim: true },
    ])
  })
  test('all done has no current pip; none done starts with it; nothing is drawn for no tasks', () => {
    expect(pips(3, 3)).toEqual([{ text: '▪▪▪', dim: true }])
    expect(pips(0, 2)).toEqual([{ text: '▸', color: 'suggestion', bold: true }, { text: '▫', dim: true }])
    expect(pips(0, 0)).toEqual([])
  })
  test('`active` current pips (none when nothing is in progress)', () => {
    expect(text(pips(2, 6, 22, 2))).toBe('▪▪▸▸▫▫')
    expect(text(pips(2, 6, 22, 0))).toBe('▪▪▫▫▫▫')
  })
  test('22 tasks are still pips; over 22 (or `max`) they become a bar of `max` cells in the accent', () => {
    expect(text(pips(10, 22)).length).toBe(22)
    expect(text(pips(10, 22))).toContain('▸')
    const over = pips(10, 23)
    expect(text(over).length).toBe(22)
    expect(/^▮+▯+$/.test(text(over))).toBe(true)
    expect(over[0]?.color).toBe('suggestion')
    expect(text(pips(9, 14, 10)).length).toBe(10)
    expect(/^▮+▯+$/.test(text(pips(9, 14, 10)))).toBe(true)
  })
})

describe('buckets and spark', () => {
  test('buckets counts times into n equal parts of the span; the end falls in the last', () => {
    expect(buckets([0, 5, 15, 99, 100], 0, 100, 10)).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 2])
    const b22 = buckets([0, 50, 100], 0, 100, 22)
    expect(b22.length).toBe(22)
    expect(b22[0]).toBe(1)
    expect(b22[11]).toBe(1)
    expect(b22[21]).toBe(1)
    expect(buckets([7, 7], 7, 7, 22)[21]).toBe(2)
    expect(buckets([-5, 200], 0, 100, 22).every(n => n === 0)).toBe(true)
  })
  test('spark draws exactly n levels, scaled to the largest, in the accent (or the colour given)', () => {
    const s22 = spark([2, 1, 2, 3, 2, 3, 5, 4, 3, 2, 5, 7, 6, 5, 3, 2, 2, 3, 4, 5, 3, 5], 22)
    expect(s22).toHaveLength(1)
    expect(s22[0]?.text.length).toBe(22)
    expect(s22[0]?.color).toBe('suggestion')
    expect(s22[0]?.text[11]).toBe('█')
    expect(spark([0, 0, 0], 10)[0]?.text).toBe('▁'.repeat(10))
    expect(spark([1, 2, 3, 4], 10, 'subtle')[0]).toEqual({ text: '▁▁▁▁▁▁▃▅▆█', color: 'subtle' })
  })
  test('more buckets than n keep the newest n; fewer are padded with zeros at the start', () => {
    const many = Array.from({ length: 30 }, (_, i) => (i === 29 ? 8 : 0))
    expect(spark(many, 22)[0]?.text).toBe(`${'▁'.repeat(21)}█`)
    expect(spark([8], 22)[0]?.text).toBe(`${'▁'.repeat(21)}█`)
  })
})

describe('crewRow', () => {
  const p = (state: PodState, type = 'general-purpose', id = 'a'): Pod =>
    podOf({ id, type, status: state === 'done' ? 'done' : state === 'failed' ? 'error' : 'running', state }, EVEN)
  const CREW = [p('working', 'main', 'main'), p('working', 'Explore'), p('working'), p('failed', 'code-reviewer'), p('done', 'Explore'), p('done', 'Explore'), p('done')]

  test('pods sit at a pitch of 3 (hull, signal, gap); the last has no trailing gap', () => {
    const s = text(crewRow(CREW))
    expect(s).toBe('◈  ◉  ▣  △! ●  ●  ■')
    for (let i = 0; i < 7; i++) expect('◈◉▣△●●■'.includes(s[i * 3]!)).toBe(true)
    expect(s.length).toBe(19)
  })
  test('runs keep each hull and signal styled', () => {
    const runs = crewRow([p('failed', 'code-reviewer'), p('working')])
    expect(runs).toEqual([
      { text: '△', color: 'error' },
      { text: '!', color: 'error', bold: true },
      { text: ' ' },
      { text: '▣', color: 'suggestion', bold: true },
    ])
  })
  test('at most `max` (7) pods; more show 6 and a dim +n', () => {
    const eight = [...CREW, p('queued')]
    const runs = crewRow(eight)
    expect(runs[runs.length - 1]).toEqual({ text: '+2', dim: true })
    expect(text(runs)).toBe('◈  ◉  ▣  △! ●  ●  +2')
    expect(text(runs).length).toBeLessThanOrEqual(22)
    const twelve = Array.from({ length: 13 }, () => p('done'))
    expect(text(crewRow(twelve, 12)).endsWith('+2')).toBe(true)
  })
  test('a crew row from column 14 never passes column 36, even with 99 more', () => {
    const many = Array.from({ length: 106 }, () => p('done'))
    expect(14 + text(crewRow(many)).length).toBeLessThanOrEqual(36)
  })
  test('tight: no gaps, a signal only where there is one (the one-row band)', () => {
    expect(text(crewRow(CREW, 12, { tight: true }))).toBe('◈◉▣△!●●■')
  })
  test('no pods draws nothing', () => {
    expect(crewRow([])).toEqual([])
  })
})

describe('tether and pill', () => {
  test('tether: ├╌ or ╰╌ at depth 1; at depth 2 the outer guide ┆ (or a blank) and then the tether', () => {
    expect(tether(1, false)).toBe('├╌')
    expect(tether(1, true)).toBe('╰╌')
    expect(tether(2, false, true)).toBe('┆ ├╌')
    expect(tether(2, true, false)).toBe('  ╰╌')
    expect(tether(0, false)).toBe('')
  })
  test('pillRun: one space each side, on the colour, in inverseText, bold', () => {
    expect(pillRun('WORKING', 'suggestion')).toEqual({ text: ' WORKING ', bg: 'suggestion', color: 'inverseText', bold: true })
    expect(pillRun('NEEDS YOU', 'warning').text).toBe(' NEEDS YOU ')
  })
})
