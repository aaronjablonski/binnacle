// Text prepared for a `Code` element. Pure.
//
// A drawing may hold 100,000 `Code` characters in all; the three sections of a
// step's detail share a budget well under that.

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// C0 controls and DEL, except tab (09) and newline (0A).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g

/** CRLF to LF, colour escapes removed, every other control character but tab and newline dropped. */
export function clean(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ANSI, '').replace(CONTROL, '')
}

/** `text` cut to `max` characters; `cut` is how many were left out. */
export function cutChars(text: string, max: number): { text: string; cut: number } {
  if (text.length <= max) return { text, cut: 0 }
  const keep = Math.max(0, max)
  return { text: text.slice(0, keep), cut: text.length - keep }
}

const linesOf = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * One hunk replacing `before` with `after`: a real `@@ -a,b +c,d @@` header,
 * the removed lines, then the added. Cut by whole lines to `max` characters,
 * and the header counts follow what is kept. `''` when both are empty.
 * `cut` is how many lines were left out.
 */
export function diffOf(before: string, after: string, max: number): { source: string; cut: number } {
  const removed = linesOf(clean(before))
  const added = linesOf(clean(after))
  if (removed.length === 0 && added.length === 0) return { source: '', cut: 0 }
  const body = [...removed.map(l => `-${l}`), ...added.map(l => `+${l}`)]
  const room = Math.max(0, max - 40)
  const kept: string[] = []
  let used = 0
  for (const line of body) {
    if (used + line.length + 1 > room) break
    kept.push(line)
    used += line.length + 1
  }
  const keptRemoved = Math.min(removed.length, kept.length)
  const keptAdded = kept.length - keptRemoved
  const start = (n: number): number => (n === 0 ? 0 : 1)
  const header = `@@ -${start(keptRemoved)},${keptRemoved} +${start(keptAdded)},${keptAdded} @@`
  return { source: [header, ...kept].join('\n'), cut: body.length - kept.length }
}
