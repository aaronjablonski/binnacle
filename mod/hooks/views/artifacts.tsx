import type { EngineInterface, RenderElement } from 'claude-code'

import type { ArtifactKind, ArtifactRow } from '../../types'
import { debug, errText } from '../state'
import { elapsed, fit, fitLeft, splitRow } from './fit'
import { openStep } from './openstep'
import { flushRight, sectionHeader } from './parts'
import type { ViewCtx } from './shell'
import { C } from './style'

const GLYPH: Record<ArtifactKind, string> = { page: '↗', document: '▤', result: '◆', link: '⎇' }
const COLOR: Record<ArtifactKind, string> = { page: C.accent, document: C.doc, result: C.accent, link: C.accent }
const KINDS: ArtifactKind[] = ['page', 'document', 'result', 'link']
const EMPTY = 'No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.'
const INDENT = '  '

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

async function copyText($: EngineInterface, text: string, surface: Surface): Promise<void> {
  try {
    const got = await $.ui.copy({ text, surface })
    $.ui.toast(got.isCopied ? 'Copied.' : `Not copied: ${got.reason}`)
  } catch (err) {
    debug($, `copy failed: ${errText(err)}`)
    $.ui.toast(`Not copied: ${errText(err)}`)
  }
}

/** The dim second line: the summary, else the ref cut from the left, then `· ×n` when written more than once. */
function detailLine(a: ArtifactRow, cols: number): string {
  const suffix = a.count > 1 ? `×${a.count}` : ''
  const joiner = suffix !== '' ? ' · ' : ''
  const room = Math.max(0, cols - INDENT.length - joiner.length - suffix.length)
  let base = ''
  if (a.summary !== undefined && a.summary !== '') base = fit(a.summary, room)
  else if (a.ref !== undefined && a.ref !== '') base = fitLeft(a.ref, room)
  if (base === '') return suffix !== '' ? `${INDENT}${suffix}` : ''
  return `${INDENT}${base}${joiner}${suffix}`
}

/**
 * One artifact as one Button: glyph, bold title and a dim `<kind> · <elapsed>`
 * flush right; then the dim second line, a `Text` child that begins with a
 * newline (C7). The key is the step's id when it is unique among the rows,
 * else the row's own id: identity, never the position (C8).
 */
function artifactRow(ctx: ViewCtx, a: ArtifactRow, key: string, hasStep: boolean, $: EngineInterface): RenderElement {
  const { Text, Button } = $.ui.resolve(ctx.e)
  const { cols, now } = ctx
  const glyph = GLYPH[a.kind]
  const meta = `${a.kind} · ${elapsed(a.updatedAt, now)}`
  const head = splitRow(`${glyph} ${a.title}`, meta, cols)
  const room = Math.max(0, head.left.length - glyph.length - 1)
  const lines: RenderElement[] = [
    <Text key="glyph" color={COLOR[a.kind]}>
      {glyph}
    </Text>,
    <Text key="title" bold>
      {` ${fit(a.title, room)}`}
    </Text>,
  ]
  if (head.right !== '' && !head.stacked) {
    lines.push(
      <Text key="meta" dimColor>
        {flushRight(head.left.length, head.right, cols)}
      </Text>,
    )
  }
  if (head.stacked) {
    lines.push(
      <Text key="meta" dimColor>{`
${fit(`${INDENT}${head.right}`, cols)}`}</Text>,
    )
  }
  const second = detailLine(a, cols)
  if (second !== '') {
    lines.push(
      <Text key="detail" dimColor>{`
${second}`}</Text>,
    )
  }
  const stepId = a.stepId
  return (
    <Button
      key={key}
      plain
      onPress={press => {
        if (hasStep && stepId !== undefined) return openStep($, stepId)
        return copyText($, a.ref ?? a.title, press.surface)
      }}
    >
      {lines}
    </Button>
  )
}

/** The Artifacts tab: newest first, a legend, and a note that code edits live in the Timeline. */
export function artifactsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, cols, e } = ctx
  try {
    if (t.artifacts.length === 0) return <Text dimColor>{EMPTY}</Text>
    const rows = [...t.artifacts].sort((a, b) => b.updatedAt - a.updatedAt)
    const stepIds = new Set(t.steps.map(s => s.id))
    const uses = new Map<string, number>()
    for (const a of rows) {
      if (a.stepId !== undefined) uses.set(a.stepId, (uses.get(a.stepId) ?? 0) + 1)
    }
    const keyOf = (a: ArtifactRow): string => {
      if (a.stepId !== undefined && uses.get(a.stepId) === 1) return `art-${a.stepId}`
      return `art-${a.id}`
    }
    const n = t.changed.length
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          {sectionHeader('ARTIFACTS', String(rows.length), cols, e, $)}
          {rows.map(a => artifactRow(ctx, a, keyOf(a), a.stepId !== undefined && stepIds.has(a.stepId), $))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {KINDS.map(k => (
            <Text key={`legend-${k}`}>
              <Text color={COLOR[k]}>{GLYPH[k]}</Text>
              <Text dimColor>{` ${k}`}</Text>
            </Text>
          ))}
        </Box>
        <Text dimColor>{`Code edits are not listed here; they are steps in the Timeline (${n} ${n === 1 ? 'file' : 'files'} changed).`}</Text>
      </Box>
    )
  } catch (err) {
    debug($, `artifacts view failed: ${errText(err)}`)
    return <Text dimColor>{fit(`Artifacts: ${errText(err)}`, cols)}</Text>
  }
}
