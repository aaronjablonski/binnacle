import type { EngineInterface, On } from 'claude-code'

// Developer probe: records what the engine hands a mod, one JSON line per
// event, to <cwd>/.mc-probe/<session-id>.jsonl. Active only with the
// `probe` userConfig option on. Every hook returns exactly what `next(e)`
// resolved to.

type ProbeEvent =
  | 'tool.call'
  | 'tool.result'
  | 'agent.spawn'
  | 'agent.spawned'
  | 'turn.start'
  | 'turn.complete'
  | 'session.receive'

const CUT = 500

function cut(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > CUT ? value.slice(0, CUT) : value
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => cut(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = cut(v, depth + 1)
  return out
}

// Probe-only: the lines of this run and a write queue. A developer probe
// keeps them in module variables; the real mod keeps state in $.state.
const lines: string[] = []
let queue: Promise<void> = Promise.resolve()
let base: string | undefined

async function record($: EngineInterface, event: ProbeEvent, e: unknown, r?: unknown): Promise<void> {
  try {
    const at = await $.clock.now()
    const line: Record<string, unknown> = { at, event, e: cut(e) }
    if (r !== undefined) line.r = cut(r)
    lines.push(JSON.stringify(line))
    queue = queue.then(async () => {
      try {
        if (base === undefined) {
          const id = await $.session.id()
          const cwd = await $.session.cwd()
          base = `${cwd}/.mc-probe/${id}`
        }
        await $.fs.write(`${base}.jsonl`, lines.join('\n') + '\n')
      } catch (err) {
        $.ui.log(`mission-control probe: write failed: ${String(err)}`, { to: 'debug' })
      }
    })
    await queue
  } catch (err) {
    $.ui.log(`mission-control probe: ${String(err)}`, { to: 'debug' })
  }
}

export function registerProbe(on: On, options: { probe?: boolean }): void {
  if (options.probe !== true) return

  on('tool.call', async ($, e, next) => {
    await record($, 'tool.call', e)
    const r = await next(e)
    await record($, 'tool.result', { tool: e.tool, tool_use_id: e.tool_use_id, agentId: e.agentId }, r)
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    await record($, 'agent.spawn', e)
    const r = await next(e)
    await record($, 'agent.spawned', { tool_use_id: e.tool_use_id, parentAgentId: e.parentAgentId }, r)
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await record($, 'turn.start', e, r)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await record($, 'turn.complete', e, r)
    return r
  })

  on('session.receive', async ($, e, next) => {
    const r = await next(e)
    await record($, 'session.receive', e, r)
    return r
  })
}
