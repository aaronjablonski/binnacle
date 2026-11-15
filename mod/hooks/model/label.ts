import { DOC_EXT } from './limits'

const LABEL_MAX = 80

/** Whitespace collapsed to single spaces, trimmed. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** `s` cut to `max` characters, ending in `…` when cut. */
export function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

/** The last two segments of a path, `/` or `\` separated. */
export function tail2(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).slice(-2).join('/')
}

/** The last segment of a path. */
export function basename(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? ''
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

function rawLabel(tool: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(tool)) {
    const c = str(input.command)
    if (c) return `${tool} ${c}`
  }
  if (FILE_TOOLS.has(tool)) {
    const p = str(input.file_path) ?? str(input.notebook_path)
    if (p) return `${tool} ${tail2(p)}`
  }
  if (tool === 'Grep') {
    const p = str(input.pattern)
    if (p) return `Grep "${p}"`
  }
  if (tool === 'Agent') {
    const type = str(input.subagent_type)
    const d = str(input.description)
    if (type && d) return `Agent ${type} · ${d}`
    if (type || d) return `Agent ${type ?? d}`
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    const status = str(input.status)
    if (id && status) return `Task ${id} → ${status}`
    if (id) return `Task ${id} updated`
  }
  for (const v of Object.values(input)) {
    const s = str(v)
    if (s) return `${tool} ${s}`
  }
  return tool
}

/** A one-line label for a tool call, at most 80 characters. */
export function labelOf(tool: string, input: Record<string, unknown>): string {
  return cut(oneLine(rawLabel(tool, input ?? {})), LABEL_MAX)
}

/** The file paths a tool call names (`file_path`, `notebook_path`). */
export function pathsOf(_tool: string, input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path']) {
    const p = str(input?.[k])
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** True when the path's extension is in DOC_EXT, case-insensitive. */
export function isDoc(path: string): boolean {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 && DOC_EXT.includes(name.slice(dot))
}
