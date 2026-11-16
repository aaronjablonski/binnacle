import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Timeline } from '../types'
import { DESCRIPTION, GUIDE_FIELD, GUIDE_TASKS, GUIDE_TODO, guideText, guideVariant } from './guide'

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
  // Round 1 section 4: the description the model reads at call time names `focus` and `tasks`.
  expect(spec.description).toBe(DESCRIPTION)
  expect(DESCRIPTION).toBe(
    'Keep the Mission Control panel true for the person watching: the headline (`focus`), the to-do list (`tasks`, the whole list each time), notes and artifacts. Cheap; returns nothing useful.',
  )
  const tasks = (spec.inputSchema.properties as Record<string, { maxItems?: number; items?: { properties: Record<string, { maxLength?: number; enum?: string[] }>; required: string[] } }>).tasks!
  expect(tasks.maxItems).toBe(12)
  expect(tasks.items?.properties.title?.maxLength).toBe(60)
  expect(tasks.items?.properties.state?.enum).toEqual(['todo', 'doing', 'done'])
  expect(tasks.items?.required).toEqual(['title', 'state'])
  expect(spec.inputSchema.additionalProperties).toBe(false)
  const artifact = (spec.inputSchema.properties as Record<string, { properties: Record<string, { maxLength?: number }> }>).artifact!
  expect(artifact.properties.title?.maxLength).toBe(200)
  expect(artifact.properties.summary?.maxLength).toBe(200)
  expect(artifact.properties.ref?.maxLength).toBe(1000)
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

test("prompt.compose gains exactly one section, last, the guide text for its tools, and the engine's sections are untouched", async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))

  const first = await $.prompt.compose(COMPOSE)
  const second = await $.prompt.compose(COMPOSE)

  expect(first.sections.length).toBe(ENGINE_SECTIONS.length + 1)
  expect(first.sections.slice(0, ENGINE_SECTIONS.length)).toEqual(ENGINE_SECTIONS)
  const added = first.sections[first.sections.length - 1]
  // Only the update tool offered: variant C, the `tasks` field.
  expect(added?.text).toBe(GUIDE_FIELD)
  expect(added?.scope).toBe('session')
  // The same text on every call: the prompt cache holds.
  expect(second).toEqual(first)
})

test('with the task tools offered the guide names TaskCreate; with TodoWrite, TodoWrite; with neither, the `tasks` field', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))
  const textFor = async (tools: string[]) => (await $.prompt.compose({ ...COMPOSE, tools: [UPDATE, ...tools] })).sections.at(-1)?.text

  const a = await textFor(['Read', 'TaskCreate', 'TaskUpdate', 'TaskList'])
  const b = await textFor(['Read', 'TodoWrite'])
  const c = await textFor(['Read', 'Bash'])
  // A deferred task tool is not in `tools`: it counts as not offered.
  const deferred = await textFor(['Read', 'ToolSearch'])

  expect(a).toBe(GUIDE_TASKS)
  expect(a).toContain('create the list with TaskCreate before any other tool call')
  expect(a).toContain('Mark one task in_progress')
  expect(a).not.toContain('`tasks` field')
  expect(b).toBe(GUIDE_TODO)
  expect(b).toContain('create the list with TodoWrite before any other tool call')
  expect(b).toContain('Mark one item in_progress')
  expect(c).toBe(GUIDE_FIELD)
  expect(c).toContain('send the list in the `tasks` field of mcp__mission-control__update')
  expect(c).not.toContain('TaskCreate')
  expect(deferred).toBe(GUIDE_FIELD)
  // Each variant is a fixed string, the same on every call.
  expect(await textFor(['Read', 'TaskCreate', 'TaskUpdate'])).toBe(a)
  expect(guideVariant(['TaskCreate'])).toBe('field')
  expect(guideVariant(['TaskCreate', 'TaskUpdate', 'TodoWrite'])).toBe('tasks')
  expect(guideText(['TodoWrite'])).toBe(GUIDE_TODO)
  for (const text of [GUIDE_TASKS, GUIDE_TODO, GUIDE_FIELD]) {
    expect(text.startsWith('# Mission Control\n')).toBe(true)
    expect(text).toContain('A request of one or two steps needs no list.')
    expect(text).toContain('with `focus`: the goal of the whole request as a plain clause of at most 8 words')
  }
})

test('the `tasks` field replaces the caller\'s own list, bounded; a subagent\'s list never touches the lead\'s', async ($, on) => {
  const box = world(on)
  on('tool.call', () => ({ result: 'engine' }))

  await $.tool.call({ tool: UPDATE, tasks: [{ title: 'Read the route', state: 'doing' }, { title: 'Write the limiter', state: 'todo' }] } as never)
  expect(box.timeline?.tasks.map(x => [x.subject, x.status, x.owner])).toEqual([
    ['Read the route', 'in_progress', 'main'],
    ['Write the limiter', 'pending', 'main'],
  ])

  // The whole list again, with a state changed: replaced, never merged.
  await $.tool.call({ tool: UPDATE, tasks: [{ title: 'Read the route', state: 'done' }, { title: 'Write the limiter', state: 'doing' }, { title: 'Test it', state: 'todo' }] } as never)
  expect(box.timeline?.tasks.map(x => [x.subject, x.status])).toEqual([
    ['Read the route', 'completed'],
    ['Write the limiter', 'in_progress'],
    ['Test it', 'pending'],
  ])

  // A subagent's list is its own.
  await $.tool.call({ tool: UPDATE, agentId: 'a1', tasks: [{ title: 'Scan', state: 'doing' }] } as never)
  expect(box.timeline?.tasks.filter(x => x.owner === 'main').length).toBe(3)
  expect(box.timeline?.tasks.filter(x => x.owner === 'a1').map(x => x.subject)).toEqual(['Scan'])

  // Bounded: 12 items, titles cut to 60, bad items skipped.
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `${'t'.repeat(100)}${i}`, state: 'todo' }))
  await $.tool.call({ tool: UPDATE, tasks: [{ title: '', state: 'todo' }, { title: 'x', state: 'maybe' }, ...many] } as never)
  const lead = box.timeline?.tasks.filter(x => x.owner === 'main') ?? []
  expect(lead.length).toBe(12)
  expect(lead.every(x => x.subject.length <= 60)).toBe(true)
})

test('prompt.compose adds no section when the request does not offer the update tool', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))

  const composed = await $.prompt.compose({ ...COMPOSE, tools: ['Read', 'Bash'] })
  const none = await $.prompt.compose({ ...COMPOSE, tools: [] })

  expect(composed.sections).toEqual(ENGINE_SECTIONS)
  expect(none.sections).toEqual(ENGINE_SECTIONS)
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

const SEEN = { first: 0, last: 2, of: 3 }
const OTHER_TOOLS = ['Bash', 'Read', 'Edit', 'Agent', 'mcp__github__get_issue', 'mcp__mission-control__other']

test("every other tool's row is the engine's node, unchanged, on screen or not", async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const tool = e.component === 'ToolUse' ? e.props.tool : '?'
    return (
      <Box key="engine-row" flexDirection="column">
        <Text>{`engine ${tool}`}</Text>
      </Box>
    )
  })
  for (const surface of SURFACES) {
    for (const tool of OTHER_TOOLS) {
      for (const onScreen of [SEEN, null, undefined]) {
        const props = onScreen === undefined ? row(tool, { a: 1 }) : { ...row(tool, { a: 1 }), onScreen }
        const ui = await $.ui.mount({
          plugin: 'mission-control', surface, component: 'ToolUse', requestId: 'toolu_1', props,
        })
        expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { key: 'engine-row' } })
        const texts = await ui.findAll({ type: 'Text' })
        expect(texts.map(t => t.text)).toEqual([`engine ${tool}`])
        await ui.redraw({ ...row(tool, { a: 1 }), onScreen: null })
        expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([`engine ${tool}`])
        await ui.unmount()
      }
    }
  }
})

test('an expanded update row is the engine\'s too', async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'mission-control', surface, component: 'ToolUse', requestId: 'toolu_9',
      props: { ...row(UPDATE, { focus: 'x' }), isExpanded: true, onScreen: SEEN },
    })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['engine'])
    await ui.unmount()
  }
})

test("with guide: false the update tool's row is the engine's and other rows pass unchanged", { options: { guide: false } }, async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const surface of SURFACES) {
    for (const tool of [UPDATE, 'Bash']) {
      const ui = await $.ui.mount({
        plugin: 'mission-control', surface, component: 'ToolUse', requestId: 'toolu_8',
        props: { ...row(tool, { focus: 'x' }), onScreen: SEEN },
      })
      expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['engine'])
      await ui.unmount()
    }
  }
})
