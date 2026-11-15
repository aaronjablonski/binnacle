import type { EngineInterface, RenderElement } from 'claude-code'

import type { ArtifactKind, ArtifactRow, Timeline } from '../../types'
import { debug, errText, updateUi } from '../state'
import { clock, elapsed, fitLeft, shortPaths, wrapWords } from './fit'
import { showInChat } from './find'
import { openInEditor } from './editor'
import { digestParts, exportDigest } from './handoff'
import type { DigestParts } from './handoff'
import { paneState } from './needs'
import { openStep, openStepInline } from './openstep'
import { openPage } from './pagenav'
import { blank, footer, inst, more, opened, page, richDeck, row, section } from './parts'
import type { Action, Detail, Hint, InstSpec, Run } from './parts'
import { stack } from './raster'
import type { Hue } from './raster'
import type { ViewCtx } from './shell'
import { C, COL, DECK, tableCols } from './style'

const GLYPH: Record<ArtifactKind, string> = { page: '↗', document: '▤', result: '✦', link: '⎇' }
const COLOR: Record<ArtifactKind, string> = { page: C.accent, document: C.doc, result: C.result, link: C.accent }
const KIND: Record<ArtifactKind, string> = { page: 'page', document: 'doc', result: 'result', link: 'link' }
const EMPTY = 'No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.'
// Rows each list shows before its `+ n more` line.
const ARTIFACT_CAP = 6
const FILES_CAP = 3
/** The DIGEST stack's width: the gauge. */
const STACK = 22
/** An edit bar's width and the column it starts on. */
const BAR = 6
const BAR_COL = 41
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

/** The four parts in stack order: what the stack and its legend call them, the text colour and the Raster hue. */
const PARTS: { key: 'tasks' | 'steps' | 'kept' | 'made'; color: string; hue: Hue | 'mute' }[] = [
  { key: 'tasks', color: C.accent, hue: 'iris' },
  { key: 'steps', color: C.subtle, hue: 'mute' },
  { key: 'kept', color: C.spark, hue: 'ember' },
  { key: 'made', color: C.result, hue: 'mint' },
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

/** Cells for each weight by largest remainder; a zero weight gets none. */
function shares(w: number[], cells: number): number[] {
  const total = w.reduce((a, b) => a + b, 0)
  if (total === 0) return w.map(() => 0)
  const raw = w.map(v => (v * cells) / total)
  const out = raw.map(Math.floor)
  let left = cells - out.reduce((a, b) => a + b, 0)
  raw
    .map((v, i) => [v - Math.floor(v), i] as const)
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => {
      if (left > 0 && (w[i] ?? 0) > 0) {
        out[i] = (out[i] ?? 0) + 1
        left--
      }
    })
  return out
}

/** The DIGEST stack as an instrument: a Raster stack, in text a run of `▄` in the parts' colours. */
function digestInst(p: DigestParts): InstSpec {
  const w = weights(p)
  const cells = shares(w, STACK)
  const empty = cells.every(n => n === 0)
  return {
    key: 'digest',
    columns: STACK,
    rows: 1,
    sig: `digest:${cells.join(':')}`,
    frames: () => [stack(STACK, empty ? [[1, 'rest']] : PARTS.map((x, i) => [cells[i] ?? 0, x.hue] as const))],
    fallback: [
      empty
        ? [{ text: '─'.repeat(STACK), color: C.subtle }]
        : PARTS.map((x, i): Run => ({ text: '▄'.repeat(cells[i] ?? 0), color: x.color })).filter(r => r.text !== ''),
    ],
  }
}

/** `~2.1k words`: an estimate, since kept bodies are read from disk only when the export runs. */
function wordsText(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k words` : `~${n} words`
}

// ---------- files changed, with edit bars ----------

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

/** A file's edit bar: filled in proportion to the most-edited file's count, never empty. */
function editBar(key: string, edits: number, most: number): InstSpec {
  const lit = Math.max(1, Math.min(BAR, Math.ceil((edits / Math.max(1, most)) * BAR)))
  return {
    key,
    columns: BAR,
    rows: 1,
    sig: `edits:${lit}`,
    frames: () => [stack(BAR, [[lit, 'iris'], [BAR - lit, 'rest']])],
    fallback: [[{ text: '▮'.repeat(lit), color: C.accent }, { text: '▯'.repeat(BAR - lit), color: C.subtle }]],
  }
}

/**
 * An opened artifact's action line: `opened` draws at most 3 actions, and this
 * row has four (`o`, `c`, `g`, `p`), so it draws its own from column 6, three
 * apart, leaving off from the end those that do not fit.
 */
function actionLine(ctx: ViewCtx, $: EngineInterface, actions: Action[], key: string): RenderElement {
  const { Box, Button } = $.ui.resolve(ctx.e)
  const shown: Action[] = []
  let used: number = COL.action
  for (const a of actions) {
    const w = (shown.length > 0 ? 3 : 0) + a.hotkey.length + 2 + a.label.length
    if (used + w > ctx.cols) break
    shown.push(a)
    used += w
  }
  return (
    <Box key={key} flexDirection="row" paddingLeft={COL.action} columnGap={3}>
      {shown.map(a => (
        <Button key={a.key} hotkey={a.hotkey} plain onPress={a.onPress}>
          {a.label}
        </Button>
      ))}
    </Box>
  )
}

/**
 * The lintel's readout when it fits: the pill starts on the gauge column (14)
 * and the readout hangs from the right edge, so on a narrow pane the two
 * would meet and the Raster refuses the cell. Left out then.
 */
function readout(cols: number, pill: string, right: string): { right?: string } {
  return cols - 2 - [...right].length > DECK.gauge - 1 + pill.length + 2 + 1 ? { right } : {}
}

// The file whose actions are open (a press selects it). Ephemeral: a reload starts with none.
let fileOpen: string | undefined

/** The opened row's lines: the link, what it is about, and who wrote it and when. */
function detailsOf(t: Timeline, a: ArtifactRow, cols: number, stepSeq: number | undefined): Detail[] {
  const room = Math.max(0, cols - COL.detailValue)
  const out: Detail[] = []
  if (a.ref !== undefined && a.ref !== '') {
    // A path keeps its end (the file name); a link or page keeps its start.
    out.push({ key: 'link', value: a.kind === 'document' ? fitLeft(a.ref, room) : a.ref })
  }
  if (a.summary !== undefined && a.summary !== '') out.push({ key: 'about', value: a.summary })
  const who = a.agent === 'main' ? 'main' : (t.agents[a.agent]?.type ?? a.agent)
  const step = stepSeq !== undefined ? ` · step ${stepSeq}` : ''
  out.push({ key: 'from', value: [{ text: `${who}${step} · ${clock(a.updatedAt)}`, dim: true }] satisfies Run[] })
  return out
}

/** The Artifacts tab: the HANDOFF, DIGEST and KEPT deck, then ARTIFACTS (the newest opened) and FILES CHANGED. */
export function artifactsView(ctx: ViewCtx, $: EngineInterface): RenderElement {
  const { Box, Text } = $.ui.resolve(ctx.e)
  const { t, u, cols, e } = ctx
  try {
    const rows = [...t.artifacts].sort((a, b) => b.updatedAt - a.updatedAt)
    const stepSeq = new Map(t.steps.map(s => [s.id, s.seq]))
    const newest = rows[0]?.id
    // Absent, the newest is open; '' means the person closed it.
    const openId = u.artifactOpen ?? newest
    const blocks: RenderElement[][] = []

    // ---- the deck: HANDOFF (a press exports the digest), DIGEST (what it will hold), KEPT
    const parts = digestParts(t, ctx.now)
    const kept = parts.kept
    const keptLine: Run[] =
      kept > 0
        ? [
            { text: '★ ', color: C.spark },
            { text: String(kept), bold: true },
            { text: ` ${kept === 1 ? 'step goes' : 'steps go'} in full`, dim: true },
          ]
        : [
            { text: '★ ', color: C.spark },
            { text: 'none kept yet', dim: true },
          ]
    const last = t.lastExport
    const legend: Run[] = PARTS.flatMap((x, i): Run[] => [
      { text: '▪', color: x.color },
      { text: ` ${x.key}${i < PARTS.length - 1 ? '  ' : ''}`, dim: true },
    ])
    const word = paneState(ctx)
    const handoff = richDeck(
      ctx,
      $,
      [
        {
          key: 'handoff-export',
          label: 'HANDOFF',
          onPress: async () => void (await exportDigest($)),
          cells: [
            { col: DECK.gauge, runs: [{ text: '↥ ', color: C.accent }, { text: 'Export digest', bold: true }] },
            { col: DECK.value, runs: [{ text: 'journal', dim: true }] },
            { col: DECK.aside, runs: [{ text: last !== undefined ? clock(last.at) : 'not yet', dim: true }], whole: true },
          ],
        },
        {
          key: 'digest',
          label: 'DIGEST',
          inst: digestInst(parts),
          cells: [
            { col: DECK.value, runs: [{ text: wordsText(parts.words), bold: true }], whole: true },
            { col: DECK.aside, runs: [{ text: `${parts.count} ${parts.count === 1 ? 'part' : 'parts'}`, dim: true }], whole: true },
          ],
        },
        { key: 'digest-legend', cells: [{ col: DECK.gauge, runs: legend }] },
        {
          label: 'KEPT',
          cells: [
            { col: DECK.gauge, runs: keptLine },
            { col: DECK.value, runs: [{ text: 'the rest in brief', dim: true }] },
          ],
        },
      ],
      {
        key: 'artifacts-deck',
        ...(word.word === 'WAITING' ? { tone: 'warning' as const } : {}),
        frame: { pill: word.word, pillColor: word.color, ...(rows.length > 0 ? readout(cols, word.word, `${rows.length} made`) : {}) },
      },
    )
    if (handoff !== null) blocks.push([handoff])

    const files = fileEdits(t)
    // A file's actions show only while no artifact is open: they share the hotkeys `o` and `c`.
    const noArtifactOpen = openId === undefined || openId === ''
    const fileSel = noArtifactOpen ? (files.find(f => f.path === fileOpen) ?? (rows.length === 0 ? files[0] : undefined))?.path : undefined

    const list: RenderElement[] = [section(ctx, $, 'ARTIFACTS', 'kind', 'age')]
    if (rows.length === 0) {
      wrapWords(EMPTY, Math.max(1, cols - COL.glyph), 5).forEach((l, i) => {
        list.push(
          <Text key={`empty-${i}`} dimColor wrap="truncate-end">{`  ${l}`}</Text>,
        )
      })
    }
    rows.slice(0, ARTIFACT_CAP).forEach((a, i) => {
      const seq = a.stepId !== undefined ? stepSeq.get(a.stepId) : undefined
      const isOpen = a.id === openId
      if (isOpen && i > 0) list.push(blank(ctx, $, `above-${a.id}`))
      list.push(
        row(ctx, $, {
          key: `art-${a.id}`,
          glyph: GLYPH[a.kind],
          glyphColor: COLOR[a.kind],
          name: a.title,
          bold: isOpen,
          metric: a.count > 1 ? `${KIND[a.kind]} ×${a.count}` : KIND[a.kind],
          time: elapsed(a.updatedAt, ctx.now),
          onPress: () => {
            fileOpen = undefined
            return updateUi($, s => ({ ...s, artifactOpen: (s.artifactOpen ?? newest) === a.id ? '' : a.id }))
          },
        }),
      )
      if (!isOpen) return
      const stepId = a.stepId
      const actions: Action[] = []
      if (stepId !== undefined && seq !== undefined) {
        actions.push({ hotkey: 'o', label: 'step', key: `act-o-${a.id}`, onPress: () => openStepInline($, stepId) })
      }
      const hasRef = a.ref !== undefined && a.ref !== ''
      actions.push({
        hotkey: 'c',
        label: hasRef ? 'copy link' : 'copy',
        key: `act-c-${a.id}`,
        onPress: () => copyText($, a.ref ?? a.title, e.surface),
      })
      if (stepId !== undefined && seq !== undefined) {
        actions.push({ hotkey: 'g', label: 'chat', key: `act-g-${a.id}`, onPress: () => showInChat($, stepId) })
      }
      actions.push({ hotkey: 'p', label: 'page', key: `act-p-${a.id}`, onPress: () => openPage($, 'artifact', a.id) })
      list.push(opened(ctx, $, detailsOf(t, a, cols, seq), []), actionLine(ctx, $, actions, `actions-${a.id}`))
      if (i < Math.min(rows.length, ARTIFACT_CAP) - 1 || rows.length > ARTIFACT_CAP) list.push(blank(ctx, $, `below-${a.id}`))
    })
    if (rows.length > ARTIFACT_CAP) list.push(more(ctx, $, rows.length - ARTIFACT_CAP))
    blocks.push(list)

    if (files.length > 0) {
      const out: RenderElement[] = [section(ctx, $, 'FILES CHANGED', 'edits', 'last')]
      const most = Math.max(...files.map(f => f.edits))
      const tc = tableCols(cols)
      // The edit bar sits between the count and the time: only where both columns exist.
      const barred = tc.metric === DECK.value && tc.time === DECK.aside
      files.slice(0, FILES_CAP).forEach((f, i) => {
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
        const base = row(ctx, $, {
          key: `file-${i}`,
          glyph: '▪',
          glyphColor: f.path === fileSel ? C.accent : undefined,
          name: shortPaths(f.path),
          bold: f.path === fileSel,
          metric: String(f.edits),
          ...(barred ? {} : f.at !== undefined ? { time: elapsed(f.at, ctx.now) } : {}),
          onPress: select,
        })
        if (barred) {
          out.push(
            <Box key={`filerow-${i}`} flexDirection="row">
              <Box key={`filerow-${i}-name`} width={BAR_COL} flexShrink={0}>
                {base}
              </Box>
              {inst(ctx, $, editBar(`edits-${i}`, f.edits, most))}
              <Text key={`filerow-${i}-time`} dimColor wrap="truncate-end">
                {f.at !== undefined ? `${' '.repeat(DECK.aside - BAR_COL - BAR)}${elapsed(f.at, ctx.now)}` : ''}
              </Text>
            </Box>,
          )
        } else {
          out.push(base)
        }
        if (f.path !== fileSel) return
        const path = f.path
        out.push(
          opened(
            ctx,
            $,
            [{ key: 'path', value: fitLeft(path, Math.max(0, cols - COL.detailValue)) }],
            [
              { hotkey: 'o', label: 'open', key: `act-o-file-${i}`, onPress: async () => void (await openInEditor($, path, undefined, e.surface)) },
              { hotkey: 'c', label: 'copy path', key: `act-c-file-${i}`, onPress: () => copyText($, path, e.surface) },
            ],
          ),
        )
      })
      if (files.length > FILES_CAP) out.push(more(ctx, $, files.length - FILES_CAP))
      blocks.push(out)
    }

    const hints: Hint[] = [
      { text: '↵ open' },
      { hotkey: 'e', label: 'export', key: 'hint-e', onPress: async () => void (await exportDigest($)) },
      { text: 'esc prompt' },
    ]
    const out: RenderElement[] = []
    for (const lines of blocks) {
      if (out.length > 0) out.push(blank(ctx, $, `gap-${out.length}`))
      out.push(...lines)
    }
    const foot = footer(ctx, $, hints)
    if (foot !== null) {
      out.push(blank(ctx, $, 'gap-footer'))
      out.push(foot)
    }
    return <Box flexDirection="column">{out}</Box>
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
 * `b: back`. The MADE BY row is a Button: it opens that step's page.
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
    { key: 'artifact-title', label: 'TITLE', value: [{ text: a.title, bold: true }] },
    {
      key: 'artifact-kind',
      label: 'KIND',
      value: [{ text: `${GLYPH[a.kind]} `, color: COLOR[a.kind] }, { text: KIND[a.kind] }],
      cells: [
        { col: DECK.value, runs: [{ text: 'made', dim: true }] },
        { col: DECK.aside, runs: [{ text: `${elapsed(a.updatedAt, ctx.now)} ago`, dim: true }] },
      ],
    },
  ]
  if (a.count > 1) fields.push({ key: 'artifact-written', label: 'WRITTEN', value: `${a.count} times, the newest shown` })
  if (hasRef) fields.push({ key: 'artifact-ref', label: a.kind === 'document' ? 'PATH' : 'REF', value: a.ref ?? '' })
  if (a.summary !== undefined && a.summary !== '') fields.push({ key: 'artifact-summary', label: 'SUMMARY', value: a.summary })
  fields.push({
    key: 'artifact-madeby',
    label: 'MADE BY',
    value:
      step !== undefined
        ? [{ text: '▸ ', color: C.accent }, { text: `step ${step.seq}  ${step.tool}` }]
        : [{ text: 'a step no longer in the timeline', dim: true }],
    cells: [
      { col: DECK.value, runs: [{ text: who, dim: true }] },
      { col: DECK.aside, runs: [{ text: clock(a.updatedAt), dim: true }] },
    ],
    ...(stepId !== undefined ? { onPress: () => openStep($, stepId) } : {}),
  })
  fields.push({ key: 'artifact-handoff', label: 'HANDOFF', value: `goes into the digest as ${a.kind === 'document' ? 'a file path' : 'a link'}` })
  const actions: Action[] = []
  if (hasRef) {
    actions.push({ hotkey: 'o', label: 'open', key: 'artifact-page-open', onPress: async () => void (await openRef($, a, e.surface)) })
  }
  actions.push({ hotkey: 'c', label: 'copy', key: 'artifact-page-copy', onPress: () => copyText($, a.ref ?? a.title, e.surface) })
  if (stepId !== undefined) actions.push({ hotkey: 'g', label: 'chat', key: 'artifact-page-chat', onPress: () => showInChat($, stepId) })
  return page(ctx, $, {
    key: 'artifact-page',
    frame: { pill: KIND[a.kind].toUpperCase(), ...readout(ctx.cols, KIND[a.kind], `artifact ${at} of ${sorted.length}`) },
    fields,
    actions,
  })
}
