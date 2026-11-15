import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../types'
import { GUIDE_TEXT } from './guide'

type Box = { timeline?: Timeline; registered: Record<string, unknown>[] }

const UPDATE = 'mcp__mission-control__update'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// The world beneath the mod, as in capture.test.tsx: a clock, no home folder
// (the journal stays quiet), a debug log that goes nowhere, a recorder of
// the timeline the mod writes and of the tools it registers.
function world(on: On): Box {
  const box: Box = { registered: [] }
  mock.clock(on, { now: 1000 })
  mock.env(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('state.set', async (_, e, next) => {
    const out = await next(e)
    if (e.key === 'timeline') box.timeline = (e.value as { value?: Timeline } | undefined)?.value
    return out
  })
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('tool.register', (_, e) => {
    box.registered.push(e as unknown as Record<string, unknown>)
    return { value: { tool: `mcp__mission-control__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return box
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
}

const ENGINE_SECTIONS = [
  { id: 'lean_body', text: 'body', scope: 'shared' },
  { id: 'env_info_simple', text: 'env', scope: 'session' },
] as const

const COMPOSE = {
  model: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5', surfaces: [], tools: [UPDATE],
  outputStyle: null, traits: ['lean', 'print'],
} as const

test('registers the update tool, not deferred', async ($, on) => {
  const box = world(on)

  await start($)

  expect(box.registered.length).toBe(1)
  const spec = box.registered[0] as { name: string; description: string; isDeferred: boolean; inputSchema: Record<string, unknown> }
  expect(spec.name).toBe('update')
  expect(spec.isDeferred).toBe(false)
  expect(spec.description).toBe(
    'Keep the Mission Control overview current for the person watching this session. Cheap; returns nothing useful.',
  )
  expect(spec.inputSchema.additionalProperties).toBe(false)
})

test('a focus update sets now and answers Noted.', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'engine' }))

  const got = await $.tool.call({ tool: UPDATE, focus: 'Reading the README', next: 'Summarise it' } as never)

  expect(got.result).toBe('Noted.')
  expect(box.timeline?.now?.focus).toBe('Reading the README')
  expect(box.timeline?.now?.next).toBe('Summarise it')
})

test("a subagent's focus sets its doing", async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'engine' }))

  const got = await $.tool.call({ tool: UPDATE, focus: 'Counting files', agentId: 'a1' } as never)

  expect(got.result).toBe('Noted.')
  expect(box.timeline?.agents.a1?.doing).toBe('Counting files')
  expect(box.timeline?.now).toBe(undefined)
})

test('a note and an artifact in one call both land', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'engine' }))

  await $.tool.call({
    tool: UPDATE,
    note: 'The cache key ignores the locale',
    artifact: { title: 'Review findings', kind: 'result', summary: '3 issues' },
  } as never)

  expect(box.timeline?.notes.map(n => n.text)).toEqual(['The cache key ignores the locale'])
  expect(box.timeline?.artifacts.map(a => a.title)).toEqual(['Review findings'])
})

test('a call with no fields answers Noted. and changes nothing', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'engine' }))

  const empty = await $.tool.call({ tool: UPDATE } as never)
  const malformed = await $.tool.call({ tool: UPDATE, focus: 42, artifact: 'x' } as never)

  expect(empty.result).toBe('Noted.')
  expect(malformed.result).toBe('Noted.')
  expect(box.timeline?.now).toBe(undefined)
  expect(box.timeline?.notes.length ?? 0).toBe(0)
  expect(box.timeline?.artifacts.length ?? 0).toBe(0)
  expect(box.timeline?.steps.length ?? 0).toBe(0)
})

test('a 5,000-character focus is stored cut to 200', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'engine' }))

  await $.tool.call({ tool: UPDATE, focus: 'f'.repeat(5000) } as never)

  const focus = box.timeline?.now?.focus ?? ''
  expect(focus.length > 0).toBe(true)
  expect(focus.length <= 200).toBe(true)
})

test("prompt.compose gains exactly one section, last, equal to GUIDE_TEXT, and the engine's sections are untouched", async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))

  const first = await $.prompt.compose(COMPOSE)
  const second = await $.prompt.compose(COMPOSE)

  expect(first.sections.length).toBe(ENGINE_SECTIONS.length + 1)
  expect(first.sections.slice(0, ENGINE_SECTIONS.length)).toEqual(ENGINE_SECTIONS)
  const added = first.sections[first.sections.length - 1]
  expect(added?.text).toBe(GUIDE_TEXT)
  expect(added?.scope).toBe('session')
  expect(second).toEqual(first)
})

test('with guide: false no tool is registered and no section is added', { options: { guide: false } }, async ($, on) => {
  const box = world(on)
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))
  on('tool.call', () => ({ result: 'engine' }))

  await start($)
  const composed = await $.prompt.compose(COMPOSE)
  const called = await $.tool.call({ tool: UPDATE, focus: 'x' } as never)

  expect(box.registered.length).toBe(0)
  expect(composed.sections).toEqual(ENGINE_SECTIONS)
  expect(called.result).toBe('engine')
  expect(box.timeline?.now).toBe(undefined)
})

function row(tool: string, input: unknown) {
  return {
    tool_use_id: 'toolu_1', tool, input,
    isRunning: false, isErrored: false, isInterrupted: false,
  }
}

test('the tool\'s row draws one dim line on every surface', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'mission-control', surface, component: 'ToolUse', requestId: 'toolu_1',
      props: row(UPDATE, { focus: 'Reading the README '.repeat(10) }),
      viewport: { columns: 60, rows: 40 },
    })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.length).toBe(1)
    const text = texts[0]?.text ?? ''
    expect(text.startsWith('◆ Mission Control updated: Reading the README')).toBe(true)
    expect(text.length <= 60).toBe(true)
    expect(await ui.drawn()).toMatchObject({ type: 'Text', props: { dimColor: true } })
    await ui.unmount()

    const noted = await $.ui.mount({
      plugin: 'mission-control', surface, component: 'ToolUse', requestId: 'toolu_2',
      props: row(UPDATE, {}),
    })
    expect((await noted.find({ type: 'Text' }))?.text).toBe('◆ Mission Control updated: noted')
    await noted.unmount()

    const result = await $.ui.mount({
      plugin: 'mission-control', surface, component: 'ToolResult', requestId: 'toolu_1',
      props: { tool_use_id: 'toolu_1', tool: UPDATE, output: 'Noted.', isErrored: false },
    })
    expect(await result.findAll({ type: 'Text' })).toHaveLength(0)
    await result.unmount()
  }
})

test("another tool's row is left to the engine", async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'mission-control', surface, component: 'ToolUse', requestId: 'toolu_3',
      props: row('Bash', { command: 'ls' }),
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()

    const result = await $.ui.mount({
      plugin: 'mission-control', surface, component: 'ToolResult', requestId: 'toolu_3',
      props: { tool_use_id: 'toolu_3', tool: 'Bash', output: { stdout: 'a' }, isErrored: false },
    })
    expect((await result.find({ type: 'Text' }))?.text).toBe('engine')
    await result.unmount()
  }
})
