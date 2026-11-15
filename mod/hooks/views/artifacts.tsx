import type { EngineInterface, RenderElement } from 'claude-code'

import type { ArtifactKind, ArtifactRow, Timeline } from '../../types'
import { debug, errText, updateUi } from '../state'
import { clock, elapsed, fitLeft, shortPaths, wordFit, wrapWords } from './fit'
import { showInChat } from './find'
import { exportDigest } from './handoff'
import { openStepInline } from './openstep'
import { blank, footer, more, opened, row, section } from './parts'
import type { Action, Detail, Hint, Run } from './parts'
import type { ViewCtx } from './shell'
import { C, COL } from './style'

const GLYPH: Record<ArtifactKind, string> = { page: '↗', document: '▤', result: '◆', link: '⎇' }
const COLOR: Record<ArtifactKind, string> = { page: C.accent, document: C.doc, result: C.result, link: C.accent }
const KIND: Record<ArtifactKind, string> = { page: 'page', document: 'doc', result: 'result', link: 'link' }
const EMPTY = 'No artifacts yet. Pages Claude publishes, documents it writes and results it reports are listed here.'
const NOTE = 'kept ★ steps go in with full input and result'
// Rows each list shows before its `+ n more` line.
const ARTIFACT_CAP = 6
const FILES_CAP = 3

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

/** The Artifacts tab: ARTIFACTS (the newest opened), FILES CHANGED and HANDOFF. */
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
          onPress: () =>
            updateUi($, s => ({ ...s, artifactOpen: (s.artifactOpen ?? newest) === a.id ? '' : a.id })),
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
      list.push(opened(ctx, $, detailsOf(t, a, cols, seq), actions))
      if (i < Math.min(rows.length, ARTIFACT_CAP) - 1 || rows.length > ARTIFACT_CAP) list.push(blank(ctx, $, `below-${a.id}`))
    })
    if (rows.length > ARTIFACT_CAP) list.push(more(ctx, $, rows.length - ARTIFACT_CAP))
    blocks.push(list)

    if (t.changed.length > 0) {
      const files: RenderElement[] = [section(ctx, $, 'FILES CHANGED')]
      // `changed` is oldest first: the newest edits lead.
      const newestFirst = [...t.changed].reverse()
      newestFirst.slice(0, FILES_CAP).forEach((p, i) => {
        files.push(row(ctx, $, { key: `file-${i}`, glyph: '·', name: shortPaths(p) }))
      })
      if (newestFirst.length > FILES_CAP) files.push(more(ctx, $, newestFirst.length - FILES_CAP))
      blocks.push(files)
    }

    blocks.push([
      section(ctx, $, 'HANDOFF', 'to'),
      row(ctx, $, {
        key: 'handoff-export',
        glyph: '↥',
        glyphColor: C.accent,
        name: 'Export digest',
        metric: 'journal',
        onPress: async () => void (await exportDigest($)),
      }),
      <Text key="handoff-note" dimColor wrap="truncate-end">{`    ${wordFit(NOTE, Math.max(1, cols - 4))}`}</Text>,
    ])

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
