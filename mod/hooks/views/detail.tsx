import type { EngineInterface, RenderElement } from 'claude-code'

import type { Step, StepBody } from '../../types'
import { BUDGET_CHANGE, BUDGET_INPUT, BUDGET_TOTAL, clean, cutChars, cutLines, diffOf } from '../model/code'
import { quoteOf, stepMarkdown } from '../model/digest'
import { apply, debug, errText, leaveDetail, updateUi } from '../state'
import { STEP_GLYPH } from './agentmeta'
import { openInEditor } from './editor'
import { showInChat } from './find'
import { clock, elapsed, fit, packParts, shortPaths } from './fit'
import { bodyOfOpen, openStep } from './openstep'
import { pageOf } from './pagenav'
import { glyphLine, page, sectionHeader } from './parts'
import type { Action, PageBlock, RowSpec } from './parts'
import type { ViewCtx } from './shell'
import { C, COL, glyphColor, statusColor, tableCols } from './style'

/** What the toast says when a step is kept. */
export const KEPT_TOAST = 'Kept: never trimmed, exported in full'

/**
 * `k`: keeps the step (no note) or lets it go. A keep toasts what it means;
 * the reducer's events keep their old names (`pin`, `unpin`). Presses only.
 */
export async function toggleKeep($: EngineInterface, s: Step): Promise<void> {
  if (s.pin === undefined) {
    await apply($, { kind: 'pin', id: s.id, note: '' })
    $.ui.toast(KEPT_TOAST)
  } else {
    await apply($, { kind: 'unpin', id: s.id })
    $.ui.toast('Unkept.')
  }
}

// Presses only: the draft is filled, never submitted.
export async function quoteInPrompt($: EngineInterface, text: string): Promise<void> {
  try {
    const got = await $.prompt.fill({ text, mode: 'insert' })
    if (!got.isFilled) $.ui.toast('Not quoted: the prompt is busy.')
  } catch (err) {
    debug($, `quote failed: ${errText(err)}`)
    $.ui.toast(`Not quoted: ${errText(err)}`)
  }
}

export async function copyResult($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): Promise<void> {
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

/** The full step (the second press on a step): Back, Keep and Copy, the header, then Input, Change and Result. */
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

    const isKept = s.pin !== undefined
    const buttons = (
      <Box key="buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {back}
        <Button
          key="detail-keep"
          label={isKept ? 'Unkeep (k)' : 'Keep (k)'}
          hotkey="k"
          onPress={() => toggleKeep($, s)}
        />
        <Button key="detail-chat" label="Show in chat" onPress={() => showInChat($, s.id)} />
        {body !== undefined ? (
          <Button
            key="detail-copy"
            label="Copy result (c)"
            hotkey="c"
            onPress={press => copyResult($, body.text, press.surface)}
          />
        ) : null}
        {body !== undefined ? (
          <Button
            key="detail-md"
            label="Copy as Markdown"
            onPress={press => copyResult($, stepMarkdown(s, body), press.surface)}
          />
        ) : null}
        {body !== undefined ? (
          <Button
            key="detail-quote"
            label="Quote in prompt (q)"
            hotkey="q"
            onPress={() => quoteInPrompt($, quoteOf(s, body))}
          />
        ) : null}
      </Box>
    )

    const end = s.status === 'running' ? now : (s.endedAt ?? s.startedAt)
    const meta = packParts(
      [s.agent === 'main' ? 'main' : (t.agents[s.agent]?.type ?? s.agent), clock(s.startedAt, true), elapsed(s.startedAt, end), s.status],
      cols,
    )
    const pinLine = isKept ? fit(s.pin === '' ? '★ kept' : `★ ${s.pin}`, cols) : ''
    const header = (
      <Box key="header" flexDirection="column">
        {sectionHeader('STEP', s.status, cols, ctx.e, $)}
        {glyphLine(ctx, $, STEP_GLYPH[s.status], glyphColor(s.status), s.label, true)}
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
          {sectionHeader('INPUT', '', cols, ctx.e, $)}
          <Code source={code.input.text} language="json" />
          {code.input.cut > 0 ? <Text dimColor>{fit(`… ${code.input.cut} more lines not shown`, cols)}</Text> : null}
        </Box>
        {code.change.source !== '' ? (
          <Box key="change" flexDirection="column">
            {sectionHeader('CHANGE', '', cols, ctx.e, $)}
            <Code source={code.change.source} format="diff" wrap="truncate-end" />
            {code.change.cut > 0 ? <Text dimColor>{fit(`… ${code.change.cut} more lines not shown`, cols)}</Text> : null}
          </Box>
        ) : null}
        <Box key="result" flexDirection="column">
          {sectionHeader('RESULT', body.isError ? 'error' : '', cols, ctx.e, $)}
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


// ---- the step page ------------------------------------------------------------

/** A file a step names: its path, the line when the input gives one, and whether the editor shows it as an image. */
export type FileRef = { path: string; line?: number; image: boolean }

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i
const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/
// A Bash word that clearly names a path: absolute, `./`, `../`, `~/`, a drive, or a folder path ending in an extension.
const CLEAR_PATH = /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/|[^\s/\\]+[\\/][^\s]*\.[A-Za-z0-9]{1,8}$)/

const lineOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)

/**
 * Every file a step names: `file_path` and `notebook_path`; `path` where it
 * names a file (it has an extension, or the tool is Read); and the words of a
 * Bash command that clearly are paths (`src/a.ts`, `./run.sh`, `C:\x\y.md`,
 * with a trailing `:12` read as the line). The line is `line` or a Read's
 * `offset`. Each path once, in the order the input names it.
 *
 * @example filesOf('Read', { file_path: 'src/a.ts', offset: 40 }) // [{ path: 'src/a.ts', line: 40, image: false }]
 */
export function filesOf(tool: string, input: Record<string, unknown> | undefined): FileRef[] {
  if (input === undefined) return []
  const out: FileRef[] = []
  const add = (raw: string, line?: number): void => {
    const path = raw.trim()
    if (path === '' || out.some(f => f.path === path)) return
    out.push({ path, ...(line !== undefined ? { line } : {}), image: IMAGE.test(path) })
  }
  const own = lineOf(input.line) ?? (tool === 'Read' ? lineOf(input.offset) : undefined)
  for (const key of ['file_path', 'notebook_path'] as const) {
    const v = input[key]
    if (typeof v === 'string') add(v, own)
  }
  const p = input.path
  if (typeof p === 'string' && (HAS_EXT.test(p) || tool === 'Read')) add(p, own)
  const cmd = input.command
  if (tool === 'Bash' && typeof cmd === 'string') {
    for (const word of cmd.split(/\s+/)) {
      const bare = word.replace(/^["'`(]+|["'`);,]+$/g, '')
      if (bare === '' || bare.startsWith('-') || bare.includes('://') || /[*?<>|&$=]/.test(bare)) continue
      const at = /^(.*[^\d:]):(\d+)$/.exec(bare)
      const path = at?.[1] ?? bare
      if (!CLEAR_PATH.test(path) || !HAS_EXT.test(path)) continue
      add(path, at !== null ? lineOf(Number(at[2])) : undefined)
    }
  }
  return out
}

/** `text` as lines of at most `room` characters, whitespace kept: a long line is split, never cut. */
function chunked(text: string, room: number): string[] {
  const out: string[] = []
  for (const l of text.split('\n')) {
    if (l.length <= room) out.push(l)
    else for (let i = 0; i < l.length; i += room) out.push(l.slice(i, i + room))
  }
  return out
}

/** The step's change as diff lines: Edit's old and new text, a Write's content, each MultiEdit hunk. */
function changeOf(input: Record<string, unknown>): string {
  const hunk = (a: unknown, b: unknown): string => (typeof a === 'string' && typeof b === 'string' ? diffOf(a, b, Number.MAX_SAFE_INTEGER).source : '')
  const edits = input.edits
  if (Array.isArray(edits)) {
    return edits
      .map(e => (typeof e === 'object' && e !== null ? hunk((e as Record<string, unknown>).old_string, (e as Record<string, unknown>).new_string) : ''))
      .filter(x => x !== '')
      .join('\n')
  }
  if (typeof input.old_string === 'string') return hunk(input.old_string, input.new_string)
  if (typeof input.content === 'string' && typeof input.file_path === 'string') return hunk('', input.content)
  return ''
}

const PILL: Record<Step['status'], string> = { error: 'FAILED', running: 'RUNNING', done: 'OK', denied: 'DENIED', interrupted: 'STOPPED' }

type PageLines = { text: string; color?: string; dim?: boolean }[][]

/**
 * The step page (`ui.page = { kind: 'step', id: <step id> }`; Enter on a step
 * row anywhere, through `openStep`): the full step with nothing cut. `n`/`p`
 * step to the next and previous step; the lintel says `step k of n`. TOOL, AGENT,
 * STATUS, TIME; INPUT wrapped in full; CHANGE for Edit, MultiEdit and Write
 * (a diff: added green, removed red); RESULT in full (the pane scrolls);
 * FILES, every path the step names with `o: open` (a press on a row opens that
 * one, the key opens the first, at the line when the input gives it) and a
 * note that an image opens in the editor's image preview. Actions: `o`, `g`,
 * `k`, `c` (as Markdown), `q`, then `b`. The body is the one `openStep`
 * stored beside `stepOpen`.
 */
export function stepPage(ctx: ViewCtx, $: EngineInterface, id: string): RenderElement {
  const { t, u, cols } = ctx
  const s = t.steps.find(x => x.id === id)
  if (s === undefined) return page(ctx, $, { key: 'step-page', title: 'This step is gone.' })
  const surface = ctx.e.surface
  const got = bodyOfOpen(u, id)
  const body = got?.body ?? (u.detail?.stepId === id ? u.detail.body : undefined)
  const input = body?.input ?? s.pending
  const room = Math.max(8, cols - COL.name)
  const end = s.status === 'running' ? ctx.now : (s.endedAt ?? s.startedAt)
  const who = s.agent === 'main' ? 'main' : (t.agents[s.agent]?.type ?? s.agent)
  const word = s.status === 'error' ? 'failed' : s.status === 'done' ? 'done' : s.status
  const files = filesOf(s.tool, input)
  const first = files[0]

  const blocks: PageBlock[] = []
  if (input !== undefined) {
    const text = clean(JSON.stringify(input, null, 2) ?? '')
    blocks.push({ key: 'input', label: 'INPUT', lines: chunked(text, room).map(l => [{ text: l }]) })
  }
  const change = input !== undefined ? changeOf(input) : ''
  if (change !== '') {
    blocks.push({
      key: 'change',
      label: 'CHANGE',
      lines: chunked(change, room).map(l => [l.startsWith('+') ? { text: l, color: C.result } : l.startsWith('-') ? { text: l, color: C.fail } : { text: l, dim: true }]),
    })
  }
  if (body !== undefined) {
    const text = clean(body.text)
    const lines: PageLines = chunked(text, room).map(l => [{ text: l }])
    if (text === '') lines.push([{ text: '(empty)', dim: true }])
    if (body.cut > 0) lines.push([{ text: `${body.cut} more characters were not kept.`, dim: true }])
    blocks.push({ key: 'result', label: 'RESULT', ...(body.isError ? { heads: { metric: 'error' } } : {}), lines })
  } else {
    const note =
      s.status === 'running' ? 'No result yet: the step is still running.' : got?.missing === true ? 'Result not kept on disk.' : 'Reading the result.'
    blocks.push({ key: 'result', label: 'RESULT', lines: [[{ text: note, dim: true }]] })
  }
  if (files.length > 0) {
    const nameRoom = tableCols(cols).nameEnd - COL.name
    // A path the row cannot hold shows its file name there and the whole path in the lines under it: a row never ends in `…`.
    const nameOf = (f: FileRef): string => {
      const short = shortPaths(f.path)
      return short.length <= nameRoom ? short : (f.path.split(/[\/]/).pop() ?? f.path)
    }
    const rows: RowSpec[] = files.map((f, i) => ({
      key: `step-page-file-${i}`,
      glyph: f.image ? '▧' : '▤',
      name: nameOf(f),
      metric: 'o: open',
      ...(f.line !== undefined ? { time: `line ${f.line}` } : {}),
      onPress: () => void openInEditor($, f.path, f.line, surface),
    }))
    const lines: PageLines = []
    for (const f of files) {
      if (nameOf(f) !== f.path) for (const l of chunked(f.path, room)) lines.push([{ text: l, dim: true }])
    }
    if (files.some(f => f.image)) lines.push([{ text: "An image opens in your editor's image preview.", dim: true }])
    blocks.push({ key: 'files', label: 'FILES', heads: { metric: 'open', time: 'line' }, rows, ...(lines.length > 0 ? { lines } : {}) })
  }

  const actions: Action[] = []
  if (first !== undefined) {
    actions.push({ hotkey: 'o', label: 'open', key: 'step-page-open', onPress: () => void openInEditor($, first.path, first.line, surface) })
  }
  actions.push(
    { hotkey: 'g', label: 'chat', key: 'step-page-chat', onPress: () => showInChat($, s.id) },
    { hotkey: 'k', label: s.pin === undefined ? 'keep' : 'unkeep', key: 'step-page-keep', onPress: () => toggleKeep($, s) },
    { hotkey: 'c', label: 'copy as Markdown', key: 'step-page-copy', onPress: () => copyResult($, stepMarkdown(s, body), surface) },
    { hotkey: 'q', label: 'quote', key: 'step-page-quote', onPress: () => quoteInPrompt($, quoteOf(s, body)) },
  )
  // n and p step to the next and the previous step (in the order they started), keeping where `b` returns to.
  const order = [...t.steps].sort((a, b) => a.seq - b.seq)
  const at = order.findIndex(x => x.id === s.id)
  const from = pageOf(u)?.from
  const nextStep = order[at + 1]
  const prevStep = at > 0 ? order[at - 1] : undefined
  if (nextStep !== undefined) actions.push({ hotkey: 'n', label: 'next', key: 'step-page-next', onPress: () => openStep($, nextStep.id, from) })
  if (prevStep !== undefined) actions.push({ hotkey: 'p', label: 'previous', key: 'step-page-prev', onPress: () => openStep($, prevStep.id, from) })
  const status = statusColor(s.status)
  return page(ctx, $, {
    key: 'step-page',
    frame: { pill: PILL[s.status], ...(s.status === 'error' ? { pillColor: C.fail } : {}), right: `step ${at + 1} of ${order.length}` },
    title: s.label,
    fields: [
      { label: 'TOOL', value: [{ text: s.tool, bold: true }] },
      { label: 'AGENT', value: who },
      { label: 'STATUS', value: [{ text: word, ...(status !== undefined ? { color: status } : {}) }] },
      { label: 'TIME', value: `${clock(s.startedAt, true)} · ${elapsed(s.startedAt, end)}` },
      ...(s.pin !== undefined ? [{ label: 'KEPT', value: s.pin === '' ? '★' : `★ ${s.pin}` }] : []),
    ],
    blocks,
    actions,
  })
}
