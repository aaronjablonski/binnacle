import type { EngineInterface, RenderElement } from 'claude-code'

import type { ArtifactKind, Tab } from '../../types'
import { summary } from '../model/select'
import { leaveDetail, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { elapsed, fit } from './fit'
import { openStep } from './openstep'
import type { ViewCtx } from './shell'

const ARTIFACT_GLYPH: Record<ArtifactKind, string> = { page: '↗', document: '▤', result: '◆', link: '⎇' }
const MIN_SPLIT = 8

/** The Overview tab: what is happening now, in six short sections. */
export function overviewView({ e, t, cols, now }: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button, Progress } = $.ui.resolve(e)
  const s = summary(t)
  const sections: RenderElement[] = []

  // A heading that opens its tab.
  const go = (tab: Tab, text: string): RenderElement => (
    <Button key={`go-${tab}`} plain onPress={() => updateUi($, u => ({ ...leaveDetail(u), tab }))}>
      <Text bold>{fit(text, cols)}</Text>
    </Button>
  )
  // A heading with nothing to open.
  const title = (text: string): RenderElement => <Text bold>{fit(text, cols)}</Text>
  // Left text and a dim right text on one row, or two rows when they do not fit.
  const split = (left: string, right: string): RenderElement => {
    const room = cols - right.length - 1
    if (right === '') return <Text>{fit(left, cols)}</Text>
    if (room < MIN_SPLIT) {
      return (
        <Box flexDirection="column">
          <Text>{fit(left, cols)}</Text>
          <Text dimColor>{fit(right, cols)}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text>{fit(left, room)}</Text>
        <Text dimColor>{right}</Text>
      </Box>
    )
  }

  // NOW
  const fromClaude = s.fromClaude && s.focusAt !== undefined ? `from Claude · ${elapsed(s.focusAt, now)} ago` : ''
  sections.push(
    <Box key="now" flexDirection="column">
      {fromClaude !== '' && cols >= 'NOW '.length + fromClaude.length ? (
        <Box flexDirection="row" columnGap={1}>
          {title('NOW')}
          <Text dimColor>{fromClaude}</Text>
        </Box>
      ) : (
        title('NOW')
      )}
      {fromClaude !== '' && cols < 'NOW '.length + fromClaude.length ? (
        <Text dimColor>{fit(fromClaude, cols)}</Text>
      ) : null}
      {s.focus ? <Text bold>{fit(s.focus, cols)}</Text> : <Text dimColor>Idle. Nothing running yet.</Text>}
      {s.next ? (
        <Text>
          <Text dimColor>Next </Text>
          {fit(s.next, Math.max(0, cols - 'Next '.length))}
        </Text>
      ) : null}
    </Box>,
  )

  // TASKS
  const more = Math.max(0, t.tasks.filter(x => x.status === 'pending').length - (s.upcoming ? 1 : 0))
  sections.push(
    <Box key="tasks" flexDirection="column">
      {s.total > 0 ? go('tasks', `TASKS ${s.done}/${s.total}`) : go('tasks', 'TASKS')}
      {s.total > 0 ? (
        <Progress label="Tasks" value={s.done} max={s.total} valueText={`${s.done} of ${s.total}`} />
      ) : (
        <Text dimColor>No tasks yet.</Text>
      )}
      {s.current ? split(`▶ ${s.current.subject}`, elapsed(s.current.updatedAt, now)) : null}
      {s.upcoming ? <Text>{fit(`☐ ${s.upcoming.subject}`, cols)}</Text> : null}
      {s.done > 0 || more > 0 ? <Text dimColor>{fit(`  ✔ ${s.done} done · ☐ ${more} more`, cols)}</Text> : null}
    </Box>,
  )

  // AGENTS
  if (s.running.length > 0 || s.finished > 0) {
    sections.push(
      <Box key="agents" flexDirection="column">
        {go('agents', `AGENTS ${s.running.length} running · ${s.finished} done`)}
        {s.running.map(a => (
          <Box key={`agent-${a.id}`} flexDirection="column">
            <Text>{fit(`▶ ${a.type} · ${a.description}`, cols)}</Text>
            {a.doing !== '' ? <Text dimColor>{fit(`  ${a.doing}`, cols)}</Text> : null}
          </Box>
        ))}
      </Box>,
    )
  }

  // LATEST
  if (s.steps > 0) {
    sections.push(
      <Box key="latest" flexDirection="column">
        {go('timeline', `LATEST ${s.steps} steps · ${s.errors} errors · ${s.changed} files changed`)}
        {s.latest.map(x => {
          const star = x.pin !== undefined ? '★ ' : ''
          const note = x.pin ? ` · ${x.pin}` : ''
          const who = x.agent !== 'main' ? ` · ${t.agents[x.agent]?.type ?? x.agent}` : ''
          return (
            <Button
              key={`step-${x.id}`}
              plain
              label={fit(`${STEP_GLYPH[x.status]} ${star}${x.label}${note}${who}`, cols)}
              onPress={() => openStep($, x.id)}
            />
          )
        })}
      </Box>,
    )
  }

  // NOTES
  if (s.notes.length > 0) {
    sections.push(
      <Box key="notes" flexDirection="column">
        {title('NOTES')}
        {s.notes.map((n, i) => {
          const who = n.agent !== 'main' ? ` · ${t.agents[n.agent]?.type ?? n.agent}` : ''
          return <Text key={`note-${i}`}>{fit(`• ${n.text}${who}`, cols)}</Text>
        })}
      </Box>,
    )
  }

  // ARTIFACTS
  if (t.artifacts.length > 0) {
    sections.push(
      <Box key="artifacts" flexDirection="column">
        {go('artifacts', `ARTIFACTS ${t.artifacts.length}`)}
        {s.artifacts.map(a => (
          <Box key={`artifact-${a.id}`} flexDirection="column">
            {split(`${ARTIFACT_GLYPH[a.kind]} ${a.title}`, `${a.kind} · ${elapsed(a.updatedAt, now)}`)}
          </Box>
        ))}
      </Box>,
    )
  }

  return <Box flexDirection="column" rowGap={1}>{sections}</Box>
}
