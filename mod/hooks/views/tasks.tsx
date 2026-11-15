import type { EngineInterface, RenderElement } from 'claude-code'

import type { TaskItem } from '../../types'
import { taskTree } from '../model/select'
import { debug, errText } from '../state'
import { elapsed, fit } from './fit'
import { sectionHeader, splitLine } from './parts'
import type { ViewCtx } from './shell'
import { glyphColor } from './style'

const TASK_GLYPH: Record<TaskItem['status'], string> = { completed: '✔', in_progress: '▶', pending: '○' }
const EMPTY = 'No tasks yet. They appear when Claude writes a task list.'
const AGENT_INDENT = '  '
const NESTED_INDENT = '      '

/** The Tasks tab: each task, the agents working on it, and those agents' own tasks. */
export function tasksView({ e, t, u, cols, now }: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  try {
    const nodes = taskTree(t)
    if (nodes.length === 0) return <Text dimColor>{EMPTY}</Text>

    // One task at a given indent: a coloured glyph and its subject; in
    // progress it is bold, shows `activeForm` and, right-aligned, how long
    // since it last changed. A completed task's subject is dim.
    const ctx: ViewCtx = { e, t, u, cols, now }
    const taskLine = (task: TaskItem, indent: string): RenderElement => {
      const glyph = TASK_GLYPH[task.status]
      const color = glyphColor(task.status)
      if (task.status === 'in_progress') {
        const row = splitLine(ctx, $, glyph, color, task.activeForm ?? task.subject, elapsed(task.updatedAt, now), true, indent)
        return <Box key={`task-${task.id}`}>{row}</Box>
      }
      const body = ` ${fit(task.subject, Math.max(0, cols - indent.length - glyph.length - 1))}`
      return (
        <Text key={`task-${task.id}`}>
          {indent}
          {color !== undefined ? <Text color={color}>{glyph}</Text> : <Text dimColor>{glyph}</Text>}
          {task.status === 'completed' ? <Text dimColor>{body}</Text> : body}
        </Text>
      )
    }

    const done = t.tasks.filter(x => x.status === 'completed').length
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          {sectionHeader('TASKS', `${done}/${t.tasks.length}`, cols, e, $)}
          {nodes.map(n => (
            <Box key={`node-${n.task.id}-${n.task.owner}`} flexDirection="column">
              {taskLine(n.task, '')}
              {n.agents.map(a => (
                <Box key={`agent-${a.agent.id}`} flexDirection="column">
                  <Text>
                    <Text dimColor>{`${AGENT_INDENT}└ `}</Text>
                    {fit(`${a.agent.type} · ${a.agent.description}`, Math.max(0, cols - AGENT_INDENT.length - 2))}
                  </Text>
                  {a.agent.doing !== '' ? (
                    <Text>
                      {NESTED_INDENT}
                      <Text color={glyphColor('running')}>▶</Text>
                      <Text dimColor>{` ${fit(a.agent.doing, Math.max(0, cols - NESTED_INDENT.length - 2))}`}</Text>
                    </Text>
                  ) : null}
                  {a.tasks.map(x => taskLine(x, NESTED_INDENT))}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    )
  } catch (err) {
    debug($, `tasks view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Tasks: ${errText(err)}`, cols)}</Text>
  }
}
