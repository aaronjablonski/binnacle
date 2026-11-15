// Which rows of a long list to draw for a scroll position. Pure.

/**
 * The rows `[from, to)` to draw: those in view at `offset` (a window of
 * `bodyRows`) and `pad` more on each side. An offset past the end gives the
 * last window.
 */
export function windowRows(
  count: number,
  offset: number,
  bodyRows: number,
  pad = 20,
): { from: number; to: number } {
  if (count <= 0) return { from: 0, to: 0 }
  const rows = Math.max(1, bodyRows)
  const last = Math.max(0, count - rows)
  const at = Math.min(Math.max(0, offset), last)
  const margin = Math.max(0, pad)
  return { from: Math.max(0, at - margin), to: Math.min(count, at + rows + margin) }
}
