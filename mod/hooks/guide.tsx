import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { Update } from '../types'
import { UPDATE_TOOL } from './capture'
import { MAX_LINE, MAX_LIST_ITEMS, MAX_LIST_TITLE, MAX_REF } from './model/limits'
import { apply, debug, errText } from './state'
import { wordFit } from './views/fit'
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

// The guide: ONE fixed text for the whole session (R15 as amended 2026-11-16,
// review C1C2 I-1), whatever tools a request offers, so the prompt cache holds
// and the instruction never changes under the model mid-request. The to-do
// bullet names the task tools first and the update tool's `tasks` field
// second; round 1 section 4's rules on threshold, grain, one task in progress
// and closing stand, as do its headline, note and artifact bullets.
export const GUIDE_TEXT = [
  '# Mission Control',
  'The person follows this session in a side panel with a headline, a to-do list and notes. They glance at it instead of reading the transcript, so keep it true.',
  '- To-do list: when a request will take 3 or more distinct steps, create the list with your task tools (TaskCreate, or TodoWrite) before any other tool call; if you have neither, send it in the `tasks` field of mcp__mission-control__update alongside your first tool call(s), the whole list each time, each `{ "title", "state" }` with state "todo", "doing" or "done". Write 3 to 10 tasks, in the order you plan to do them. Each is an outcome the person would recognise, under 60 characters ("Cover the middleware with tests"), never a single tool call ("Run grep"). Keep one task in progress at a time. When the state of a task changes, send the list with your next tool call; if there is none, send it alone: an update carrying only `tasks` is fine the moment a task is done. Do not save the updates for the end. If the plan changes, change the list: add what you found, delete what you dropped. If a small request grows past 3 steps, create the list then. Leave no task in progress when you give your final answer. A request of one or two steps needs no list.',
  '- Headline: with your first tool call(s) on a new request, call mcp__mission-control__update with `focus`: the goal of the whole request as a plain clause of at most 8 words ("Adding rate limiting to the upload route"). Send it again only if the goal itself changes; the to-do list shows the current step.',
  '- Add `note` when you learn something the person would want to find again: a decision, a root cause, a surprising fact. One line.',
  '- Add `artifact` when you produce a result or a link worth keeping (review findings, a report, a pull request).',
  'Send these alongside other tool calls where you can, and never send an update that changes nothing. Skip all of it for replies that need no tools. Do not mention the panel or these updates in your replies.',
].join('\n')

const SECTION = { id: SECTION_ID, text: GUIDE_TEXT, scope: 'session' } as const

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

/** What the transcript row says (M11): the focus, the note, the artifact, "to-do list updated" for a list alone, else "noted"; cut at a word. */
export function rowText(input: unknown, columns: number): string {
  const u = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const art = typeof u.artifact === 'object' && u.artifact !== null ? (u.artifact as Record<string, unknown>) : {}
  const what = str(u.focus) ?? str(u.note) ?? str(art.title) ?? (Array.isArray(u.tasks) ? 'to-do list updated' : 'noted')
  const room = Math.max(ROW_PREFIX.length + 2, columns)
  return ROW_PREFIX + wordFit(what, room - ROW_PREFIX.length)
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
    return { sections: [...out.sections.filter(s => s.id !== SECTION_ID), SECTION] }
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
