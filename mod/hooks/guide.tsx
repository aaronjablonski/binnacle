import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { Update } from '../types'
import { UPDATE_TOOL } from './capture'
import { MAX_LINE, MAX_REF } from './model/limits'
import { apply, debug, errText } from './state'

// The guide is the one place the mod adds to a conversation: one tool and
// one fixed system-prompt section. Everything here is off with `guide: false`.

const TOOL_NAME = 'update'
const FIELD_MAX = MAX_LINE
const NOTED = { result: 'Noted.' }
const SECTION_ID = 'mission-control:guide'
const ROW_PREFIX = '◆ Mission Control updated: '

const DESCRIPTION =
  'Keep the Mission Control overview current for the person watching this session. Cheap; returns nothing useful.'

export const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    focus: { type: 'string', maxLength: FIELD_MAX },
    next: { type: 'string', maxLength: FIELD_MAX },
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

// The same text on every call, so the prompt cache holds.
export const GUIDE_TEXT = [
  '# Mission Control',
  'The person follows this session in a side panel called Mission Control. Keep it current:',
  '- Keep the task list up to date with the task tools as work starts and finishes.',
  '- When a request needs tools, include a mcp__mission-control__update call with `focus` (and `next` when you know it) alongside your first tool call(s), and again whenever what you are working on changes; skip it for replies that need no tools. One short line each.',
  '- Add `note` when you learn something the person would want to find again later: a decision, a root cause, a surprising fact. One line.',
  '- Add `artifact` when you produce a result or a link worth keeping (review findings, a report, a pull request).',
  'Batch these into one call, at most once per step, and never call it only to say nothing changed. Do not mention the panel or these updates in your replies.',
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

/** The four fields the tool takes, as given; the reducer drops what it cannot use. */
function updateOf(e: Record<string, unknown>): Update {
  const out: Record<string, unknown> = {}
  for (const k of ['focus', 'next', 'note', 'artifact'] as const) if (e[k] !== undefined) out[k] = e[k]
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
    if (!on_ || !e.tools.includes(UPDATE_TOOL)) return out
    return { sections: [...out.sections.filter(s => s.id !== SECTION_ID), SECTION] }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!on_ || e.component !== 'ToolUse' || e.props.tool !== UPDATE_TOOL || e.props.isExpanded === true) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{rowText(e.props.input, e.viewport?.columns ?? 80)}</Text>
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!on_ || e.component !== 'ToolResult' || e.props.tool !== UPDATE_TOOL || e.props.isExpanded === true) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))
}
