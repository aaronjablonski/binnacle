import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, StepBody } from '../../types'
import { BUDGET_CHANGE, BUDGET_INPUT, BUDGET_TOTAL, clean, cutChars, cutLines, diffOf } from '../model/code'
import { apply, debug, errText, leaveDetail, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { clock, elapsed, fit, packParts } from './fit'
import type { ViewCtx } from './shell'

async function togglePin($: EngineInterface, s: Step): Promise<void> {
  if (s.pin === undefined) await apply($, { kind: 'pin', id: s.id, note: '' })
  else await apply($, { kind: 'unpin', id: s.id })
}

async function copyResult($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): Promise<void> {
  try {
    const got = await $.ui.copy({ text, surface })
    $.ui.toast(got.isCopied ? 'Copied.' : `Not copied: ${got.reason}`)
  } catch (err) {
    debug($, `copy failed: ${errText(err)}`)
    $.ui.toast(`Not copied: ${errText(err)}`)
  }
}

// What the three Code blocks draw, sharing one budget (K7).
function codeOf(body: StepBody) {
  const inputCut = cutLines(clean(JSON.stringify(body.input, null, 2) ?? ''), BUDGET_INPUT)
  const before = body.input.old_string
  const after = body.input.new_string
  const change =
    typeof before === 'string' && typeof after === 'string'
      ? diffOf(before, after, BUDGET_CHANGE)
      : { source: '', cut: 0 }
  const room = Math.max(0, BUDGET_TOTAL - inputCut.text.length - change.source.length)
  const result = cutChars(clean(body.text), room)
  return { input: inputCut, change, result }
}

/** The step detail: Back, Pin and Copy, the header, then Input, Change and Result. */
export function detailView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text, Button, Code } = $.ui.resolve(ctx.e)
  const { t, u, cols, now } = ctx
  try {
    const d = u.detail
    if (d === undefined) return <Text dimColor>No step open.</Text>
    const s = t.steps.find(x => x.id === d.stepId)
    const body = d.body

    // The keys are in the labels: VS Code gives buttons no hotkeys (C4).
    const back = (
      <Button key="detail-back" label="Back (b)" hotkey="b" role="dismiss" onPress={() => updateUi($, leaveDetail)} />
    )
    if (s === undefined) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {back}
          </Box>
          <Text dimColor>This step is no longer kept.</Text>
        </Box>
      )
    }

    const isPinned = s.pin !== undefined
    const buttons = (
      <Box key="buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {back}
        <Button
          key="detail-pin"
          label={isPinned ? 'Unpin (p)' : 'Pin (p)'}
          hotkey="p"
          onPress={() => togglePin($, s)}
        />
        {body !== undefined ? (
          <Button
            key="detail-copy"
            label="Copy result (c)"
            hotkey="c"
            onPress={press => copyResult($, body.text, press.surface)}
          />
        ) : null}
      </Box>
    )

    const end = s.status === 'running' ? now : (s.endedAt ?? s.startedAt)
    const meta = packParts(
      [s.agent === 'main' ? 'main' : (t.agents[s.agent]?.type ?? s.agent), clock(s.startedAt, true), elapsed(s.startedAt, end), s.status],
      cols,
    )
    const pinLine = isPinned ? fit(s.pin === '' ? '★ pinned' : `★ ${s.pin}`, cols) : ''
    const header = (
      <Box key="header" flexDirection="column">
        <Text bold>{fit(`${STEP_GLYPH[s.status]} ${s.label}`, cols)}</Text>
        <Text dimColor>{meta.join('\n')}</Text>
        {pinLine !== '' ? <Text>{pinLine}</Text> : null}
      </Box>
    )

    if (body === undefined) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {buttons}
          {header}
          <Text dimColor>Result not kept on disk.</Text>
        </Box>
      )
    }

    const code = codeOf(body)
    return (
      <Box flexDirection="column" rowGap={1}>
        {buttons}
        {header}
        <Box key="input" flexDirection="column">
          <Text bold>Input</Text>
          <Code source={code.input.text} language="json" />
          {code.input.cut > 0 ? <Text dimColor>{fit(`… ${code.input.cut} more lines not shown`, cols)}</Text> : null}
        </Box>
        {code.change.source !== '' ? (
          <Box key="change" flexDirection="column">
            <Text bold>Change</Text>
            <Code source={code.change.source} format="diff" wrap="truncate-end" />
            {code.change.cut > 0 ? <Text dimColor>{fit(`… ${code.change.cut} more lines not shown`, cols)}</Text> : null}
          </Box>
        ) : null}
        <Box key="result" flexDirection="column">
          <Text bold>{body.isError ? 'Result (error)' : 'Result'}</Text>
          {code.result.text !== '' ? <Code source={code.result.text} /> : <Text dimColor>(empty)</Text>}
          {code.result.cut > 0 ? <Text dimColor>{fit(`… ${code.result.cut} more characters not shown`, cols)}</Text> : null}
          {body.cut > 0 ? <Text dimColor>{fit(`… ${body.cut} more characters not kept`, cols)}</Text> : null}
        </Box>
      </Box>
    )
  } catch (err) {
    debug($, `detail view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Detail: ${errText(err)}`, cols)}</Text>
  }
}
