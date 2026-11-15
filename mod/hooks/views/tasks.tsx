import type { EngineInterface, RenderElement } from 'claude-code'

import type { TaskItem } from '../../types'
import { taskTree } from '../model/select'
import { debug, errText } from '../state'
import { elapsed, fit, splitRow } from './fit'
import type { ViewCtx } from './shell'

const TASK_GLYPH: Record<TaskItem['status'], string> = { completed: '✔', in_progress: '▶', pending: '☐' }
const EMPTY = 'No tasks yet. They appear when Claude writes a task list.'
const AGENT_INDENT = '  '
const NESTED_INDENT = '      '

/** The Tasks tab: each task, the agents working on it, and those agents' own tasks. */
export function tasksView({ e, t, cols, now }: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  try {
    const nodes = taskTree(t)
    if (nodes.length === 0) return <Text dimColor>{EMPTY}</Text>

    // One task at a given indent: a glyph and its subject; in progress it is
    // bold, shows `activeForm` and how long since it last changed.
    const taskLine = (task: TaskItem, indent: string): RenderElement => {
      const glyph = TASK_GLYPH[task.status]
      if (task.status === 'in_progress') {
        const row = splitRow(`${indent}${glyph} ${task.activeForm ?? task.subject}`, elapsed(task.updatedAt, now), cols)
        return (
          <Box key={`task-${task.id}`} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text bold>{row.left}</Text>
              {row.right !== '' && !row.stacked ? <Text dimColor>{row.right}</Text> : null}
            </Box>
            {row.stacked ? <Text dimColor>{fit(`${indent}  ${row.right}`, cols)}</Text> : null}
          </Box>
        )
      }
      const line = fit(`${indent}${glyph} ${task.subject}`, cols)
      return task.status === 'completed' ? (
        <Text key={`task-${task.id}`} dimColor>{line}</Text>
      ) : (
        <Text key={`task-${task.id}`}>{line}</Text>
      )
    }

    const done = t.tasks.filter(x => x.status === 'completed').length
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          {nodes.map(n => (
            <Box key={`node-${n.task.id}-${n.task.owner}`} flexDirection="column">
              {taskLine(n.task, '')}
              {n.agents.map(a => (
                <Box key={`agent-${a.agent.id}`} flexDirection="column">
                  <Text>{fit(`${AGENT_INDENT}└ ${a.agent.type} · ${a.agent.description}`, cols)}</Text>
                  {a.agent.doing !== '' ? (
                    <Text dimColor>{fit(`${NESTED_INDENT}▶ ${a.agent.doing}`, cols)}</Text>
                  ) : null}
                  {a.tasks.map(x => taskLine(x, NESTED_INDENT))}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
        <Text dimColor>{fit(`${done} of ${t.tasks.length} done`, cols)}</Text>
      </Box>
    )
  } catch (err) {
    debug($, `tasks view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Tasks: ${errText(err)}`, cols)}</Text>
  }
}
