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

// ---- Call signature -------------------------------------------------------------

/** Past this many characters a string is not read further for a signature. */
const SIG_TEXT_MAX = 100_000
const SIG_DEPTH_MAX = 20

/** `v` as JSON with keys sorted and strings on one line, so equal inputs give equal text. Cycles and deep nesting are cut. */
function stableText(v: unknown, seen: WeakSet<object>, depth: number): string {
  if (typeof v === 'string') return JSON.stringify(oneLine(v.slice(0, SIG_TEXT_MAX)))
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return JSON.stringify(v)
  if (typeof v !== 'object') return '"?"'
  if (seen.has(v) || depth > SIG_DEPTH_MAX) return '"~"'
  seen.add(v)
  let out: string
  if (Array.isArray(v)) {
    out = `[${v.map((x) => stableText(x, seen, depth + 1)).join(',')}]`
  } else {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).sort()
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableText(o[k], seen, depth + 1)}`).join(',')}}`
  }
  seen.delete(v)
  return out
}

/** cyrb53: a stable 53-bit string hash, in base 36 (at most 11 characters). */
function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** What a call's signature is read from: a shell command, a file tool's path, else the whole input. */
function sigText(tool: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(tool)) {
    const c = str(input.command)
    if (c) return oneLine(c.slice(0, SIG_TEXT_MAX))
  }
  if (FILE_TOOLS.has(tool)) {
    const p = str(input.file_path) ?? str(input.notebook_path)
    if (p) return p.trim().replace(/\\/g, '/')
  }
  return stableText(input, new WeakSet(), 0).slice(0, SIG_TEXT_MAX)
}

/**
 * A call's signature: a short stable hash (≤ MAX_SIG) of its tool and its
 * normalised input. Two calls share it when they run the same command, touch
 * the same file, or (any other tool) give the same input. Never throws.
 */
export function sigOf(tool: string, input: Record<string, unknown>): string {
  let text: string
  try {
    text = sigText(tool, input ?? {})
  } catch {
    text = ''
  }
  return hash53(`${tool}\u0000${text}`)
}
