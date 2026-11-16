import type { EngineInterface, RenderElement } from 'claude-code'

import type { ArtifactKind, ArtifactRow, Timeline } from '../../types'
import { debug, errText, updateUi } from '../state'
import { lineOf } from './crewnode'
import type { Seg } from './crewnode'
import { clock, fitLeft, ruleBar, span, toolName, toolRoom, wordFit, wrapWords } from './fit'
import { showInChat } from './find'
import { openInEditor } from './editor'
import { digestParts, exportDigest } from './handoff'
import type { DigestParts } from './handoff'
import { openStep, openStepInline } from './openstep'
import type { FootHint } from './overview'
import { openPage } from './pagenav'
import { blank, frameFootInst, frameTopInst, inst, page, primaryButton, primaryWidth, runText, section } from './parts'
import type { Action, Detail, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, CK, COL, DECK, edges } from './style'
import { colHeads, flushRight, growBody, hasTime, midEnd, moreRow, nameLimit, openedBlock, pathFit } from './tabkit'

// The Artifacts tab (cockpit spec "CockpitArtifacts"): Handoff as the header
// (the one filled button, what the digest will contain), then Artifacts with
// the newest opened, Files changed with edit marks, and Kept. Enter opens an
// artifact's page.

const GLYPH: Record<ArtifactKind, string> = { page: '↗', document: '▤', result: '✦', link: '⎇' }
const TONE: Record<ArtifactKind, Omit<Run, 'text'>> = { page: { color: CK.accent }, document: { dim: true }, result: { dim: true }, link: { color: CK.accent } }
const KIND: Record<ArtifactKind, string> = { page: 'page', document: 'doc', result: 'result', link: 'link' }
const EMPTY = 'No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.'
// Rows each list shows before its `+ n more` line.
const ARTIFACT_CAP = 6
const FILES_CAP = 3
const KEPT_CAP = 3
/** The most edit marks a file shows. */
const MARKS = 6
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

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

// ---------- open: a link in the browser, a file in the editor ----------

/** A web link that no shell can read as more than a link: no `&`, quote, caret, backtick or space. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#@%+=,;!*()[\]]+$/

/** `ref` as a link when it is one: with a scheme, or (for a page or a link) a bare host such as `claude.ai/artifact/x`. */
function urlOf(a: Pick<ArtifactRow, 'kind' | 'ref'>): string | undefined {
  const ref = a.ref?.trim() ?? ''
  if (ref === '') return undefined
  if (/^https?:\/\//i.test(ref)) return ref
  if ((a.kind === 'page' || a.kind === 'link') && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/|$)/.test(ref)) return `https://${ref}`
  return undefined
}

/**
 * `o: open` (press only): a document or any path goes to the editor; a link
 * goes to the system's opener (`start`, `open` or `xdg-open`), tried in turn
 * and only for a link no shell could read as more. Where nothing opens it the
 * ref is copied and a toast says why. Never throws.
 */
async function openRef($: EngineInterface, a: ArtifactRow, surface: Surface): Promise<void> {
  const ref = a.ref ?? ''
  if (ref === '') return
  const url = urlOf(a)
  if (url === undefined) {
    await openInEditor($, ref, undefined, surface)
    return
  }
  if (SAFE_URL.test(url)) {
    const tries = [['cmd', '/d', '/c', 'start', '', url], ['open', url], ['xdg-open', url]]
    for (const argv of tries) {
      try {
        const got = await $.process.run(argv, { timeoutMs: 15_000 })
        if (got.exitCode === 0) return
      } catch (err) {
        debug($, `open ${argv[0]} failed: ${errText(err)}`)
      }
    }
  }
  await copyText($, url, surface)
  try {
    $.ui.toast('Could not open the link. It is copied.')
  } catch {
    // nowhere left to say it
  }
}

// ---------- the digest ----------

/** The four parts in stack order: the bar's style and the legend's word. */
const PARTS: { key: 'steps' | 'tasks' | 'kept' | 'made'; style: Omit<Run, 'text'> }[] = [
  { key: 'steps', style: { color: CK.accent } },
  { key: 'tasks', style: { color: CK.accent, dim: true } },
  { key: 'kept', style: { dim: true } },
  { key: 'made', style: { color: C.subtle } },
]

/**
 * The stack's weights: each part's count, but a part that has anything keeps
 * at least about one cell, so two kept steps still show beside 300 others.
 */
function weights(p: DigestParts): number[] {
  const counts = PARTS.map(x => p[x.key])
  const total = counts.reduce((a, b) => a + b, 0)
  return counts.map(n => (n > 0 ? Math.max(n, total * 0.06) : 0))
}

/**
 * The legend's words per part: `summary`, `9 tasks`, `3 kept`, `6 files`; a part with nothing is left out. The last
 * part is the files changed (the mock's word), or the artifacts when no file changed.
 */
function legendOf(p: DigestParts, t: Timeline): { style: Omit<Run, 'text'>; text: string }[] {
  const files = t.changed.length
  const words: Record<(typeof PARTS)[number]['key'], string> = {
    steps: 'summary',
    tasks: `${p.tasks} ${p.tasks === 1 ? 'task' : 'tasks'}`,
    kept: `${p.kept} kept`,
    made: files > 0 ? `${files} ${files === 1 ? 'file' : 'files'}` : `${t.artifacts.length} ${t.artifacts.length === 1 ? 'artifact' : 'artifacts'}`,
  }
  return PARTS.filter(x => p[x.key] > 0).map(x => ({ style: x.style, text: words[x.key] }))
}

// ---------- files changed, with edit marks ----------

type FileEdit = { path: string; edits: number; at?: number }

/** The path a write step names: its label without the tool. */
const fileOf = (label: string, tool: string): string => (label.startsWith(`${tool} `) ? label.slice(tool.length + 1) : label)

/** Each changed file with how many times a step wrote it and when last, the newest edit first (`changed` is oldest first). */
function fileEdits(t: Timeline): FileEdit[] {
  const out = [...t.changed].reverse().map((path): FileEdit => ({ path, edits: 0 }))
  for (const s of t.steps) {
    if (!WRITE_TOOLS.has(s.tool) || s.status !== 'done') continue
    const named = fileOf(s.label, s.tool)
    const hit = out.find(f => f.path === named) ?? out.find(f => f.path.endsWith(named) || named.endsWith(f.path))
    if (hit === undefined) continue
    hit.edits++
    hit.at = Math.max(hit.at ?? 0, s.startedAt)
  }
  return out.map(f => (f.edits === 0 ? { ...f, edits: 1 } : f))
}

// The file whose actions are open (a press selects it). Ephemeral: a reload starts with none.
let fileOpen: string | undefined

/** `now` for a moment ago, else a short span (`2 min`, `40s`). */
const ago = (ms: number): string => (ms < 5000 ? 'now' : span(ms))

/** The opened artifact's lines: its link, what it is about, and who made it and which step. */
function detailsOf(t: Timeline, a: ArtifactRow, cols: number, stepSeq: number | undefined): Detail[] {
  const room = Math.max(0, edges(cols).right + 1 - 14)
  const out: Detail[] = []
  if (a.ref !== undefined && a.ref !== '') {
    // A path keeps its end (the file name); a link or page keeps its start.
    // M14: a link is whole or not shown (a cut link opens nothing); a path keeps its end.
    if (a.kind === 'document') out.push({ key: 'Link', value: fitLeft(a.ref, room) })
    else if (a.ref.length <= room) out.push({ key: 'Link', value: a.ref })
  }
  if (a.summary !== undefined && a.summary !== '') out.push({ key: 'About', value: a.summary })
  const who = a.agent === 'main' ? 'main' : (t.agents[a.agent]?.type ?? a.agent)
  const bits = [who, ...(stepSeq !== undefined ? [`step ${stepSeq}`] : []), ...(a.count > 1 ? [`version ${a.count}`] : [])]
  // Whole bits only: "main, step 148" before "main, step 148, version…".
  const madeBy = bits.reduce((got, bit) => (got === '' ? bit : `${got}, ${bit}`.length <= room ? `${got}, ${bit}` : got), '')
  out.push({ key: 'Made by', value: madeBy })
  return out
}

/** The Artifacts tab: Handoff, then Artifacts (the newest opened), Files changed and Kept. */
export function artifactsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, e } = ctx
  const { left, right } = edges(cols)
  const ground = ctx.ground ?? 'night'
  const mid = midEnd(cols)
  try {
    const rows = [...t.artifacts].sort((a, b) => b.updatedAt - a.updatedAt)
    const stepSeq = new Map(t.steps.map(s => [s.id, s.seq]))
    const newest = rows[0]?.id
    // Absent, the newest is open; '' means the person closed it.
    const openId = u.artifactOpen ?? newest
    // R37: Artifacts, Files changed and Kept keep the mock's caps at 46 rows and grow with the pane after that.
    const lists = [
      { count: rows.length, cap: ARTIFACT_CAP },
      { count: t.changed.length, cap: FILES_CAP },
      { count: t.steps.filter(x => x.pin !== undefined).length, cap: KEPT_CAP },
    ]
    const build = (caps: number[]): { out: RenderElement[]; hints: FootHint[] } => {
      const out: RenderElement[] = []
      const gap = (): void => void out.push(blank(ctx, $, `gap-${out.length}`))

      // ---- Handoff: the header (a press exports the digest), what the digest will contain
      const parts = digestParts(t, ctx.now)
      const last = t.lastExport
      const lastRuns: Run[] = [{ text: last !== undefined ? `last exported ${clock(last.at)}` : 'not exported yet', dim: true }]
      const exportNow = async (): Promise<void> => void (await exportDigest($))
      const content = right - left + 1
      out.push(inst(ctx, $, frameTopInst('handoff-lintel', cols, 'iris', ground)))
      out.push(lineOf(ctx, $, { key: 'handoff-title', body: [{ col: left, text: 'Handoff', bold: true }, ...flushRight(lastRuns, right)] }))
      out.push(blank(ctx, $, 'handoff-gap-button'))
      const exportLabel = 'e: Export digest'
      const buttonW = primaryWidth(exportLabel)
      const sentence = 'saved to this session and copied'
      out.push(
        <Box key="handoff-export-row" flexDirection="row">
          <Text key="handoff-export-pad">{' '.repeat(left)}</Text>
          {primaryButton(ctx, $, { key: 'handoff-export', label: exportLabel, hotkey: 'e', onPress: exportNow })}
          {left + buttonW + 2 + sentence.length <= right + 1 ? <Text key="handoff-export-note" dimColor>{`  ${sentence}`}</Text> : null}
        </Box>,
      )
      out.push(blank(ctx, $, 'handoff-gap-digest'))
      // M5: the label and the bar share a row, the bar from the column after the label, a gap between its parts
      // (the mock's "It will hold" row). Where the bar would be under 12 cells it takes its own row under the label.
      const label = 'The digest will contain'
      const barCol = left + label.length + 2
      const beside = right + 1 - barCol >= 12
      const w = weights(parts)
      const barCells = beside ? right + 1 - barCol : content
      const bar = ruleBar(barCells, PARTS.map((x, i) => ({ count: w[i] ?? 0, ...x.style })), undefined, true).map((r, i) => runText(r, ctx.e, $, `digest-bar-${i}`))
      if (beside) {
        out.push(
          <Text key="digest-row" wrap="truncate-end">
            {' '.repeat(left)}
            <Text key="digest-label" dimColor>{label}</Text>
            {'  '}
            {bar}
          </Text>,
        )
      } else {
        out.push(lineOf(ctx, $, { key: 'digest-label', body: [{ col: left, text: label, dim: true }] }))
        out.push(
          <Text key="digest-bar" wrap="truncate-end">
            {' '.repeat(left)}
            {bar}
          </Text>,
        )
      }
      // The legend wraps to a second row before any word is cut (M14): a part is a square and its word, whole or not shown.
      const legendRows: Seg[][] = [[]]
      let lc: number = left
      for (const x of legendOf(parts, t)) {
        const need = 2 + x.text.length
        if (lc + need > right + 1 && legendRows[legendRows.length - 1]!.length > 0 && legendRows.length < 2) {
          legendRows.push([])
          lc = left
        }
        if (lc + need > right + 1) continue
        legendRows[legendRows.length - 1]!.push({ col: lc, text: '■', ...x.style }, { col: lc + 2, text: x.text, dim: true })
        lc += need + 2
      }
      legendRows.forEach((l, i) => out.push(lineOf(ctx, $, { key: `digest-legend${i === 0 ? '' : `-${i}`}`, body: l })))
      out.push(inst(ctx, $, frameFootInst('handoff-sill', cols, 'iris', ground)))
      gap()

      // ---- Artifacts
      const files = fileEdits(t)
      // A file's actions show only while no artifact is open: they share the hotkeys `o` and `c`.
      const noArtifactOpen = openId === undefined || openId === ''
      const fileSel = noArtifactOpen ? (files.find(f => f.path === fileOpen) ?? (rows.length === 0 ? files[0] : undefined))?.path : undefined

      out.push(section(ctx, $, 'Artifacts', rows.length > 0 ? colHeads(cols, String(rows.length), 'kind', 'age') : undefined, { key: 'sec-artifacts' }))
      if (rows.length === 0) {
        wrapWords(EMPTY, Math.max(1, right - left + 1), 5).forEach((l, i) => {
          out.push(lineOf(ctx, $, { key: `empty-${i}`, body: [{ col: left, text: l, dim: true }] }))
        })
      }
      const shownRows = rows.slice(0, caps[0]!)
      shownRows.forEach((a, i) => {
        const seq = a.stepId !== undefined ? stepSeq.get(a.stepId) : undefined
        const isOpen = a.id === openId
        const room = Math.max(1, nameLimit(cols) - COL.name)
        const body: Seg[] = [{ col: 2, text: GLYPH[a.kind], ...(isOpen && a.kind === 'page' ? { color: CK.accent } : TONE[a.kind]) }, { col: COL.name, text: wordFit(a.title, room), ...(isOpen ? { bold: true } : {}) }]
        if (mid !== undefined) body.push(...flushRight([{ text: KIND[a.kind], dim: true }], mid))
        if (hasTime(cols)) body.push(...flushRight([{ text: ago(ctx.now - a.updatedAt), dim: true }], right))
        out.push(
          lineOf(ctx, $, {
            key: `art-${a.id}`,
            ...(isOpen ? { pre: [{ col: 0, text: '▍', color: CK.accent }] } : {}),
            body,
            // Enter on an artifact row opens its page (rich rule 4); `b` comes back to the row.
            onPress: () => openPage($, 'artifact', a.id, `art-${a.id}`),
          }),
        )
        if (!isOpen) return
        const stepId = a.stepId
        const actions: Action[] = []
        if (stepId !== undefined && seq !== undefined) {
          actions.push({ hotkey: 'o', label: 'step', key: `act-o-${a.id}`, onPress: () => openStepInline($, stepId) })
        }
        const hasRef = a.ref !== undefined && a.ref !== ''
        actions.push({ hotkey: 'c', label: hasRef ? 'copy link' : 'copy', key: `act-c-${a.id}`, onPress: () => copyText($, a.ref ?? a.title, e.surface) })
        if (stepId !== undefined && seq !== undefined) {
          actions.push({ hotkey: 'g', label: 'chat', key: `act-g-${a.id}`, onPress: () => showInChat($, stepId) })
        }
        out.push(<Box key={`open-${a.id}`} flexDirection="column">{openedBlock(ctx, $, { key: `open-${a.id}`, details: detailsOf(t, a, cols, seq), actions })}</Box>)
        if (i < shownRows.length - 1 || rows.length > caps[0]!) out.push(blank(ctx, $, `below-${a.id}`))
      })
      if (rows.length > caps[0]!) out.push(moreRow(ctx, $, 'artifacts-more', `+ ${rows.length - caps[0]!} more`))

      // ---- Files changed
      if (files.length > 0) {
        gap()
        out.push(section(ctx, $, 'Files changed', colHeads(cols, String(files.length), 'edits', 'last'), { key: 'sec-files' }))
        const markCol = mid !== undefined ? mid - 13 : undefined
        const limit = markCol !== undefined ? markCol - 2 : nameLimit(cols)
        files.slice(0, caps[1]!).forEach((f, i) => {
          const select = () => {
            fileOpen = f.path
            return updateUi($, s => ({ ...s, artifactOpen: '' })).then(() => {
              try {
                $.ui.invalidate('ui.render')
              } catch (err) {
                debug($, `invalidate failed: ${errText(err)}`)
              }
            })
          }
          const sel = f.path === fileSel
          const body: Seg[] = [
            { col: 2, text: '·', ...(sel ? { color: CK.accent } : { dim: true }) },
            { col: COL.name, text: pathFit(f.path, Math.max(1, limit - COL.name)), ...(sel ? { bold: true } : {}) },
          ]
          if (markCol !== undefined) body.push({ col: markCol, text: '▪'.repeat(Math.min(MARKS, f.edits)), dim: true })
          if (mid !== undefined) body.push(...flushRight([{ text: String(f.edits), dim: true }], mid))
          if (hasTime(cols) && f.at !== undefined) body.push(...flushRight([{ text: ago(ctx.now - f.at), dim: true }], right))
          out.push(lineOf(ctx, $, { key: `file-${i}`, body, onPress: select }))
          if (!sel) return
          const path = f.path
          out.push(
            <Box key={`open-file-${i}`} flexDirection="column">
              {openedBlock(ctx, $, {
                key: `open-file-${i}`,
                details: [{ key: 'Path', value: fitLeft(path, Math.max(0, right + 1 - 14)) }],
                actions: [
                  { hotkey: 'o', label: 'open', key: `act-o-file-${i}`, onPress: async () => void (await openInEditor($, path, undefined, e.surface)) },
                  { hotkey: 'c', label: 'copy path', key: `act-c-file-${i}`, onPress: () => copyText($, path, e.surface) },
                ],
              })}
            </Box>,
          )
        })
        if (files.length > caps[1]!) out.push(moreRow(ctx, $, 'files-more', `+ ${files.length - caps[1]!} more`))
      }

      // ---- Kept: the steps kept in full
      const keptSteps = t.steps.filter(s => s.pin !== undefined).sort((a, b) => b.startedAt - a.startedAt)
      if (keptSteps.length > 0) {
        gap()
        out.push(section(ctx, $, 'Kept', colHeads(cols, String(keptSteps.length), 'from', 'age'), { key: 'sec-kept' }))
        const toolW = toolRoom(cols)
        keptSteps.slice(0, caps[2]!).forEach(s => {
          const note = s.pin !== undefined && s.pin !== '' ? s.pin.replace(/\s+/g, ' ').trim() : ''
          const text = note !== '' ? note : s.label.startsWith(`${s.tool} `) ? s.label.slice(s.tool.length + 1) : s.label
          const body: Seg[] = [{ col: 2, text: '★', color: CK.accent }, { col: COL.name, text: pathFit(text, Math.max(1, nameLimit(cols) - COL.name)) }]
          if (mid !== undefined) body.push(...flushRight([{ text: toolName(s.tool, Math.max(toolW, 4)), dim: true }], mid))
          if (hasTime(cols)) body.push(...flushRight([{ text: ago(ctx.now - s.startedAt), dim: true }], right))
          out.push(lineOf(ctx, $, { key: `kept-${s.id}`, body, onPress: () => openStep($, s.id, `kept-${s.id}`) }))
        })
        if (keptSteps.length > caps[2]!) out.push(moreRow(ctx, $, 'kept-more', `+ ${keptSteps.length - caps[2]!} more`))
        const keptNote = ['Kept steps are never trimmed and export in full.', 'Kept steps export in full.'].find(x => x.length <= right - COL.name + 1)
        if (keptNote !== undefined) out.push(lineOf(ctx, $, { key: 'kept-note', body: [{ col: COL.name, text: keptNote, dim: true }] }))
      }

      // `e` is armed by the Export button above, so the footer only says it.
      const hints: FootHint[] = [{ key: '↵', label: 'open artifact' }, { key: 'e', label: 'export' }, { key: 'esc', label: 'prompt' }]
    return { out, hints }
    }
    return <Box flexDirection="column">{growBody(ctx, $, lists, build)}</Box>
  } catch (err) {
    debug($, `artifacts view failed: ${errText(err)}`)
    return <Text dimColor>{`Artifacts: ${errText(err)}`.slice(0, Math.max(1, cols))}</Text>
  }
}

/**
 * The artifact page (`ui.page = { kind: 'artifact', id: <artifact id> }`,
 * spec "Detail pages"): the full title, the kind and when it was made, the
 * ref (a path or a link), the summary and the step that made it, none of it
 * cut. `o: open` (a file in the editor, a link in the browser, on a press
 * only), `c: copy` the ref (the title when it has none), `g: chat` and
 * `b: back`. The Made by row is a Button: it opens that step's page.
 */
export function artifactPage(ctx: ViewCtx, $: EngineInterface, id: string): RenderElement {
  const { t, e } = ctx
  const a = t.artifacts.find(x => x.id === id)
  if (a === undefined) return page(ctx, $, { key: 'artifact-page', title: 'This artifact is gone.' })
  const sorted = [...t.artifacts].sort((x, y) => y.updatedAt - x.updatedAt)
  const at = sorted.findIndex(x => x.id === id) + 1
  const step = a.stepId !== undefined ? t.steps.find(s => s.id === a.stepId) : undefined
  const who = a.agent === 'main' ? 'main' : (t.agents[a.agent]?.type ?? a.agent)
  const hasRef = a.ref !== undefined && a.ref !== ''
  const stepId = step?.id
  const fields: Parameters<typeof page>[2]['fields'] = [
    { key: 'artifact-title', label: 'Title', value: [{ text: a.title, bold: true }] },
    {
      key: 'artifact-kind',
      label: 'Kind',
      value: [{ text: `${GLYPH[a.kind]} `, ...TONE[a.kind] }, { text: KIND[a.kind] }],
      cells: [
        { col: DECK.value, runs: [{ text: 'made', dim: true }] },
        { col: DECK.aside, runs: [{ text: `${span(ctx.now - a.updatedAt)} ago`, dim: true }] },
      ],
    },
  ]
  if (a.count > 1) fields.push({ key: 'artifact-written', label: 'Written', value: `${a.count} times, the newest shown` })
  if (hasRef) fields.push({ key: 'artifact-ref', label: a.kind === 'document' ? 'Path' : 'Link', value: a.ref ?? '' })
  if (a.summary !== undefined && a.summary !== '') fields.push({ key: 'artifact-summary', label: 'Summary', value: a.summary })
  fields.push({
    key: 'artifact-madeby',
    label: 'Made by',
    value:
      step !== undefined
        ? [{ text: '▸ ', color: CK.accent }, { text: `step ${step.seq}  ${step.tool}` }]
        : [{ text: 'a step no longer in the timeline', dim: true }],
    cells: [
      { col: DECK.value, runs: [{ text: who, dim: true }] },
      { col: DECK.aside, runs: [{ text: clock(a.updatedAt), dim: true }] },
    ],
    ...(stepId !== undefined ? { onPress: () => openStep($, stepId) } : {}),
  })
  fields.push({ key: 'artifact-handoff', label: 'Handoff', value: `goes into the digest as ${a.kind === 'document' ? 'a file path' : 'a link'}` })
  const actions: Action[] = []
  if (hasRef) {
    actions.push({ hotkey: 'o', label: 'open', key: 'artifact-page-open', onPress: async () => void (await openRef($, a, e.surface)) })
  }
  actions.push({ hotkey: 'c', label: 'copy', key: 'artifact-page-copy', onPress: () => copyText($, a.ref ?? a.title, e.surface) })
  if (stepId !== undefined) actions.push({ hotkey: 'g', label: 'chat', key: 'artifact-page-chat', onPress: () => showInChat($, stepId) })
  return page(ctx, $, {
    key: 'artifact-page',
    frame: { pill: KIND[a.kind].toUpperCase(), right: `artifact ${at} of ${sorted.length}` },
    fields,
    actions,
  })
}
