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
