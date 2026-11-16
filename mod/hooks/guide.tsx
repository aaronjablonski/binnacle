import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { Update } from '../types'
import { UPDATE_TOOL } from './capture'
import { MAX_LINE, MAX_LIST_ITEMS, MAX_LIST_TITLE, MAX_REF } from './model/limits'
import { apply, debug, errText } from './state'
import { observeRow } from './views/onscreen'

// The guide is the one place the mod adds to a conversation: one tool and
// one fixed system-prompt section. Everything here is off with `guide: false`,
// except the ToolUse hook's observer, which adds nothing to a conversation.

const TOOL_NAME = 'update'
const FIELD_MAX = MAX_LINE
const NOTED = { result: 'Noted.' }
const SECTION_ID = 'mission-control:guide'
const ROW_PREFIX = '◆ Mission Control updated: '

export const DESCRIPTION =
  'Keep the Mission Control panel true for the person watching: the headline (`focus`), the to-do list (`tasks`, the whole list each time), notes and artifacts. Cheap; returns nothing useful.'

export const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    focus: { type: 'string', maxLength: FIELD_MAX },
    next: { type: 'string', maxLength: FIELD_MAX },
    tasks: {
      type: 'array',
      maxItems: MAX_LIST_ITEMS,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: MAX_LIST_TITLE },
          state: { type: 'string', enum: ['todo', 'doing', 'done'] },
        },
        required: ['title', 'state'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', maxLength: FIELD_MAX },
    artifact: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: FIELD_MAX },
        kind: { type: 'string', enum: ['result', 'link'] },
        ref: { type: 'string', maxLength: MAX_REF },
        summary: { type: 'string', maxLength: FIELD_MAX },
      },
      required: ['title', 'kind'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

// The guide's three variants (R15, round 1 section 4, "Exact wording"): each a fixed
// string, picked from the tools the request offers, so the text is the same on
// every call while the tools are (the prompt cache holds). A deferred task
// tool is not in `e.tools`: it counts as not offered.
const HEAD = [
  '# Mission Control',
  'The person follows this session in a side panel with a headline, a to-do list and notes. They glance at it instead of reading the transcript, so keep it true.',
]
const TAIL = [
  '- Headline: with your first tool call(s) on a new request, call mcp__mission-control__update with `focus`: the goal of the whole request as a plain clause of at most 8 words ("Adding rate limiting to the upload route"). Send it again only if the goal itself changes; the to-do list shows the current step.',
  '- Add `note` when you learn something the person would want to find again: a decision, a root cause, a surprising fact. One line.',
  '- Add `artifact` when you produce a result or a link worth keeping (review findings, a report, a pull request).',
  'Send these alongside other tool calls, never as a call of their own just to say nothing changed. Skip all of it for replies that need no tools. Do not mention the panel or these updates in your replies.',
]
const toolsBullet = (create: string, unit: string): string =>
  `- To-do list: when a request will take 3 or more distinct steps, create the list with ${create} before any other tool call. Write 3 to 10 tasks, in the order you plan to do them. Each is an outcome the person would recognise, under 60 characters ("Cover the middleware with tests"), never a single tool call ("Run grep"). Mark one ${unit} in_progress when you start it and completed the moment it is done; do not save the updates for the end. If the plan changes, change the list: add what you found, delete what you dropped. If a small request grows past 3 steps, create the list then. Leave no task in_progress when you give your final answer. A request of one or two steps needs no list.`
const FIELD_BULLET =
  '- To-do list: when a request will take 3 or more distinct steps, send the list in the `tasks` field of mcp__mission-control__update alongside your first tool call(s). Write 3 to 10 tasks, in the order you plan to do them, each `{ "title", "state" }` with state "todo", "doing" or "done". Each title is an outcome the person would recognise, under 60 characters ("Cover the middleware with tests"), never a single tool call. Send the whole list again each time a state changes, alongside your next tool call: one task "doing" at a time, "done" the moment it is finished. If the plan changes, change the list. Leave no task "doing" when you give your final answer. A request of one or two steps needs no list.'

const variant = (bullet: string): string => [...HEAD, bullet, ...TAIL].join('\n')

/** Variant A: TaskCreate and TaskUpdate are offered. */
export const GUIDE_TASKS = variant(toolsBullet('TaskCreate', 'task'))
/** Variant B: TodoWrite is offered (and not both of A's tools). */
export const GUIDE_TODO = variant(toolsBullet('TodoWrite', 'item'))
/** Variant C: neither: the list goes in the update tool's `tasks` field. */
export const GUIDE_FIELD = variant(FIELD_BULLET)
/** The variant the session's usual tools pick (A); kept under its old name for the tests that read one text. */
export const GUIDE_TEXT = GUIDE_TASKS

export type GuideVariant = 'tasks' | 'todo' | 'field'

/** Which variant a request's tools pick (R15). */
export function guideVariant(tools: readonly string[]): GuideVariant {
  if (tools.includes('TaskCreate') && tools.includes('TaskUpdate')) return 'tasks'
  if (tools.includes('TodoWrite')) return 'todo'
  return 'field'
}

const TEXTS: Record<GuideVariant, string> = { tasks: GUIDE_TASKS, todo: GUIDE_TODO, field: GUIDE_FIELD }

/** The guide's text for a request's tools: one of three fixed strings. */
export function guideText(tools: readonly string[]): string {
  return TEXTS[guideVariant(tools)]
}

const isOn = (options: PluginOptions): boolean => options.guide !== false

/** Session-start work, called from register.tsx's one session.start hook. Never throws. */
export async function startGuide($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!isOn(options)) return
  try {
    await $.tool.register({ name: TOOL_NAME, description: DESCRIPTION, inputSchema: UPDATE_SCHEMA, isDeferred: false })
  } catch (err) {
    debug($, `tool.register failed: ${errText(err)}`)
  }
}

/** The fields the tool takes, as given; the reducer drops what it cannot use. */
function updateOf(e: Record<string, unknown>): Update {
  const out: Record<string, unknown> = {}
  for (const k of ['focus', 'next', 'note', 'artifact', 'tasks'] as const) if (e[k] !== undefined) out[k] = e[k]
  return out as Update
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

function rowText(input: unknown, columns: number): string {
  const u = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const art = typeof u.artifact === 'object' && u.artifact !== null ? (u.artifact as Record<string, unknown>) : {}
  const what = str(u.focus) ?? str(u.note) ?? str(art.title) ?? 'noted'
  const full = (ROW_PREFIX + what).replace(/\s+/g, ' ').trim()
  const room = Math.max(ROW_PREFIX.length + 1, columns)
  return full.length <= room ? full : `${full.slice(0, room - 1)}…`
}

export function registerGuide(on: On, options: PluginOptions): void {
  const on_ = isOn(options)

  on('tool.call', { tool: 'mcp__mission-control__update' }, async ($, e, next) => {
    if (!on_ || e.tool !== UPDATE_TOOL) return next(e)
    const at = await $.clock.now().catch(() => 0)
    await apply($, { kind: 'update', at, agent: e.agentId ?? 'main', update: updateOf(e as unknown as Record<string, unknown>) })
    return NOTED
  }).catch(($, e, next) => (on_ && e.tool === UPDATE_TOOL ? NOTED : next(e)))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    // Only where the request offers the tool: never tell the model to call one it lacks.
    // prompt.compose is raised for the main loop's prompts alone (probe finding j),
    // so subagents get no section (R17): their cards come from their steps.
    if (!on_ || !e.tools.includes(UPDATE_TOOL)) return out
    const section = { id: SECTION_ID, text: guideText(e.tools), scope: 'session' } as const
    return { sections: [...out.sections.filter(s => s.id !== SECTION_ID), section] }
  }).catch(($, e, next) => next(e))

  // The one ToolUse hook, registered with the guide on or off. Every other
  // tool's row is only observed for the Timeline's on-screen mark and handed
  // on untouched; the update tool's compact row is the guide's alone.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.component !== 'ToolUse') return next(e)
    if (e.props.tool !== UPDATE_TOOL) {
      observeRow($, e)
      return next(e)
    }
    if (!on_ || e.props.isExpanded === true) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{rowText(e.props.input, e.viewport?.columns ?? 80)}</Text>
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!on_ || e.component !== 'ToolResult' || e.props.tool !== UPDATE_TOOL || e.props.isExpanded === true) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))
}
