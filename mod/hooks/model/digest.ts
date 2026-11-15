import type { Step, StepBody, Timeline } from '../../types'
import { clean, cutChars } from './code'
import { cut, oneLine } from './label'
import { problems } from './select'

/** What a step's input and result are each cut to when it is copied or quoted (a kept step is exported whole). */
export const DIGEST_CUT = 2000

/** A fenced block whose fence is longer than any backtick run inside. */
export function fenced(text: string, lang = ''): string {
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)))
  return `${fence}${lang}\n${text}\n${fence}`
}

const inputText = (body: StepBody): string => clean(JSON.stringify(body.input, null, 2) ?? '')

/** `text` cut to `max`, with a line saying how much was left out. */
function capped(text: string, max: number): string {
  const c = cutChars(text, max)
  return c.cut > 0 ? `${c.text}\n… ${c.cut} more characters not shown` : c.text
}

/** One step as Markdown: its tool and label, then input and result in fenced blocks. */
export function stepMarkdown(s: Step, body: StepBody | undefined, max = DIGEST_CUT): string {
  const out = [`### ${s.pin !== undefined ? '★ ' : ''}${oneLine(s.label)}`, `Tool: ${s.tool} (${s.status})`]
  if (s.pin !== undefined && s.pin !== '') out.push(`Note: ${oneLine(s.pin)}`)
  if (body === undefined) {
    out.push('_Result not kept on disk._')
    return out.join('\n\n')
  }
  out.push('Input:', fenced(capped(inputText(body), max), 'json'))
  out.push(body.isError ? 'Result (error):' : 'Result:', fenced(capped(clean(body.text), max)))
  return out.join('\n\n')
}

/** The step as a quote: every line of its tool, input and result behind `> `. */
export function quoteOf(s: Step, body: StepBody | undefined, max = DIGEST_CUT): string {
  const lines = [`${s.tool}: ${oneLine(s.label)}`]
  if (body !== undefined) {
    lines.push('Input:', ...capped(inputText(body), max).split('\n'))
    lines.push('Result:', ...capped(clean(body.text), max).split('\n'))
  }
  return lines.map(l => (l === '' ? '>' : `> ${l}`)).join('\n') + '\n'
}

/** `yyyy-mm-dd-hhmm`, local time. */
export function stamp(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const

/**
 * The handoff digest: tasks, notes, kept steps with their whole stored input
 * and result (the journal already caps a body at 20,000 characters),
 * artifacts, changed files and open problems. `bodies` is keyed by step id;
 * only kept steps are ever read from it.
 */
export function digest(t: Timeline, bodies: Record<string, StepBody | undefined>, now: number): string {
  const title = t.turns[0] !== undefined ? cut(oneLine(t.turns[0].prompt), 80) : 'Session handoff'
  const done = t.tasks.filter(x => x.status === 'completed').length
  const out: string[] = [`# ${title === '' ? 'Session handoff' : title}`, `${stamp(now)} · ${t.steps.length} steps · ${t.changed.length} files`]

  out.push(`## Tasks (${done}/${t.tasks.length})`)
  out.push(t.tasks.length === 0 ? '_None._' : t.tasks.map(x => `- ${MARK[x.status]} ${oneLine(x.subject)}`).join('\n'))

  out.push('## Notes')
  out.push(t.notes.length === 0 ? '_None._' : t.notes.map(n => `- ${oneLine(n.text)}`).join('\n'))

  const kept = t.steps.filter(s => s.pin !== undefined)
  out.push('## Kept steps')
  out.push(kept.length === 0 ? '_None._' : kept.map(s => stepMarkdown(s, bodies[s.id], Infinity)).join('\n\n'))

  out.push('## Artifacts')
  out.push(
    t.artifacts.length === 0
      ? '_None._'
      : t.artifacts.map(a => `- ${oneLine(a.title)} (${a.kind})${a.ref !== undefined ? ` ${a.ref}` : ''}`).join('\n'),
  )

  out.push('## Changed files')
  out.push(t.changed.length === 0 ? '_None._' : t.changed.map(f => `- ${f}`).join('\n'))

  const open = problems(t, now, [])
  out.push('## Open problems')
  out.push(open.length === 0 ? '_None._' : open.map(p => `- ${p.kind}: ${oneLine(p.label)}`).join('\n'))

  return out.join('\n\n') + '\n'
}
