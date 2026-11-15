// Pure text helpers for the views. No claude-code import, so vitest loads it.

/** Cuts `text` to `columns` cells with a trailing '…'; '' when there is no room. */
export function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (text.length <= columns) return text
  if (columns === 1) return '…'
  return `${text.slice(0, columns - 1)}…`
}

/** Cuts `text` from the left, with a leading '…'. */
export function fitLeft(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (text.length <= columns) return text
  if (columns === 1) return '…'
  return `…${text.slice(text.length - (columns - 1))}`
}

/** A span as '8s', '2m' or '1h04'. */
export function elapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.floor((toMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = String(minutes % 60).padStart(2, '0')
  return `${hours}h${rest}`
}

/** How many of `columns` cells a progress bar fills for done of total. */
export function bar(done: number, total: number, columns: number): { filled: number; rest: number } {
  if (total <= 0 || columns <= 0) return { filled: 0, rest: Math.max(0, columns) }
  const share = Math.min(1, Math.max(0, done / total))
  const filled = Math.round(share * columns)
  return { filled, rest: columns - filled }
}

/** A left text and a dim right text for one row of `columns`; `stacked` when the right text gets a row of its own. */
export function splitRow(left: string, right: string, columns: number, minLeft = 8): { left: string; right: string; stacked: boolean } {
  if (right === '') return { left: fit(left, columns), right: '', stacked: false }
  const room = columns - right.length - 1
  if (room < minLeft) return { left: fit(left, columns), right: fit(right, columns), stacked: true }
  return { left: fit(left, room), right, stacked: false }
}

/** The time of day as 'hh:mm', or 'hh:mm:ss' with `seconds`; the machine's own clock. */
export function clock(ms: number, seconds = false): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  const base = `${two(d.getHours())}:${two(d.getMinutes())}`
  return seconds ? `${base}:${two(d.getSeconds())}` : base
}

/** `parts` joined by ' · ' and packed into lines of at most `columns`; a part wider than a line is cut. */
export function packParts(parts: string[], columns: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const raw of parts) {
    const part = fit(raw, columns)
    if (part === '') continue
    if (line === '') {
      line = part
    } else if (line.length + 3 + part.length <= columns) {
      line = `${line} · ${part}`
    } else {
      lines.push(line)
      line = part
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

/** A line of '─' as wide as `columns`; '' for no room. */
export function rule(columns: number): string {
  return '─'.repeat(Math.max(0, columns))
}

/** The filled and the resting blocks of a progress bar of `columns` cells. */
export function blockBar(done: number, total: number, columns: number): { filled: string; rest: string } {
  const cells = bar(done, total, columns)
  return { filled: '█'.repeat(cells.filled), rest: '░'.repeat(cells.rest) }
}

/**
 * The three parts of `LABEL ─── meta` for a row of `columns`: the rule part
 * carries its own spaces, so the parts sum to `columns` exactly. The meta
 * gives way first, then the rule.
 */
export function headerParts(label: string, meta: string, columns: number): { label: string; rule: string; meta: string } {
  const head = fit(label, columns)
  const room = columns - head.length - meta.length
  // A rule between label and meta needs a space on each side and one dash.
  if (meta !== '' && room >= 3) return { label: head, rule: ` ${rule(room - 2)} `, meta }
  const left = columns - head.length
  if (left >= 2) return { label: head, rule: ` ${rule(left - 1)}`, meta: '' }
  return { label: head, rule: '', meta: '' }
}
