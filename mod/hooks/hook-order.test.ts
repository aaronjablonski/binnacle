import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, Register } from 'claude-code'

// Task 1 finding (k): with one tool.call hook that has a { tool } matcher
// and one without, both run, the one registered first outermost. Pinned so
// a change in a later build shows up here. Inline plugins run in environments of
// their own, so the hooks report their order through the call itself: on
// the way in each appends its name to the Bash command, on the way out to
// the result's `trail`.

type Trail = { trail?: string[] }

// Each hook is written out in full: an inline plugin is loaded as a module
// of its own, so a hook must be a function literal with no outside names.
const matchedFirst: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const r = await next({ ...e, command: `${e.command} matched` })
    if (r.deny !== undefined) return r
    const trail = (r.result as { trail?: string[] } | undefined)?.trail ?? []
    return { result: { trail: [...trail, 'matched'] } }
  })
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const r = await next({ ...e, command: `${e.command} plain` })
    if (r.deny !== undefined) return r
    const trail = (r.result as { trail?: string[] } | undefined)?.trail ?? []
    return { result: { trail: [...trail, 'plain'] } }
  })
}

const plainFirst: Register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const r = await next({ ...e, command: `${e.command} plain` })
    if (r.deny !== undefined) return r
    const trail = (r.result as { trail?: string[] } | undefined)?.trail ?? []
    return { result: { trail: [...trail, 'plain'] } }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const r = await next({ ...e, command: `${e.command} matched` })
    if (r.deny !== undefined) return r
    const trail = (r.result as { trail?: string[] } | undefined)?.trail ?? []
    return { result: { trail: [...trail, 'matched'] } }
  })
}

// The test's own hook stands for the engine beneath both plugin hooks.
async function run($: Engine, on: On): Promise<{ seenByEngine: string; trail: string[] }> {
  let seenByEngine = ''
  on('tool.call', ($, e) => {
    seenByEngine = e.tool === 'Bash' ? e.command : ''
    return { result: { trail: [] } }
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  return { seenByEngine, trail: (r.result as Trail).trail ?? [] }
}

test('(k) matched registered first: both run, the first registered outermost', { plugins: [{ name: 'k1', register: matchedFirst }] }, async ($, on) => {
  const got = await run($, on)
  expect(got.seenByEngine).toBe('ls matched plain')
  expect(got.trail).toEqual(['plain', 'matched'])
})

test('(k) plain registered first: both run, the first registered outermost', { plugins: [{ name: 'k2', register: plainFirst }] }, async ($, on) => {
  const got = await run($, on)
  expect(got.seenByEngine).toBe('ls plain matched')
  expect(got.trail).toEqual(['matched', 'plain'])
})
