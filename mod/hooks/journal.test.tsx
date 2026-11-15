import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import type { Timeline } from '../types'
import { MAX_TEXT, bodyOf, loadSnapshot, prune, readBody, saveSnapshot, writeBody } from './journal'
import { empty } from './model/reduce'

const HOME = 'C:/home'
const ROOT = `${HOME}/.claude/mission-control`

type File = { text: string; mtimeMs: number }

const norm = (p: string): string => p.replace(/\\/g, '/')

// An in-memory disk: files in a map (folders implied by their paths), and
// the removals the platform's own command was asked for.
class Disk {
  files = new Map<string, File>()
  removed: string[] = []
  private clock = 1

  under(dir: string): string[] {
    return [...this.files.keys()].filter(k => k.startsWith(`${norm(dir)}/`))
  }
  write(path: string, text: string): void {
    this.files.set(norm(path), { text, mtimeMs: this.clock++ })
  }
  read(path: string): string {
    const f = this.files.get(norm(path))
    if (f === undefined) throw new Error(`ENOENT: ${path}`)
    return f.text
  }
  exists(path: string): boolean {
    return this.files.has(norm(path)) || this.under(path).length > 0
  }
  list(path: string) {
    const names = new Set<string>()
    for (const k of this.under(path)) names.add(k.slice(norm(path).length + 1).split('/')[0]!)
    return [...names].map(name => {
      const isFile = this.files.has(`${norm(path)}/${name}`)
      return { name, kind: isFile ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false }
    })
  }
  stat(path: string) {
    const f = this.files.get(norm(path))
    if (f !== undefined) return { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
    if (this.under(path).length > 0) return { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
    throw new Error(`ENOENT: ${path}`)
  }
  remove(argv: readonly string[]) {
    const path = norm(argv[argv.length - 1] ?? '')
    this.removed.push(path)
    for (const k of this.under(path)) this.files.delete(k)
    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
}

// The test kit's `$` carries only the event nouns (no fs, env or process),
// so the journal's functions are handed an engine stand-in over the disk:
// exactly the calls journal.ts makes, each async as the engine's are.
function engineOver(d: Disk, env: Record<string, string> = { USERPROFILE: HOME, OS: 'Windows_NT' }): EngineInterface {
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      write: async (p: string, t: string) => d.write(p, t),
      read: async (p: string) => d.read(p),
      exists: async (p: string) => d.exists(p),
      list: async (p: string) => d.list(p),
      stat: async (p: string) => d.stat(p),
    },
    process: { run: async (argv: readonly string[]) => d.remove(argv) },
    ui: { log: () => undefined },
  }
  return $ as unknown as EngineInterface
}

test('bodyOf cuts text to MAX_TEXT and reports cut', () => {
  const body = bodyOf({ command: 'ls' }, { text: 'x'.repeat(30000) })
  expect(body.text.length).toBe(20000)
  expect(MAX_TEXT).toBe(20000)
  expect(body.cut).toBe(10000)
  expect(body.isError).toBe(false)
})

test('bodyOf tolerates a missing or non-string text', () => {
  expect(bodyOf({}, undefined).text).toBe('')
  expect(bodyOf({}, { text: 42 }).text).toBe('')
  expect(bodyOf({}, { text: 42, isError: true }).isError).toBe(true)
})

test('a 3 MB result writes one file under 64 KB', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  await writeBody($, 's1', 'toolu_1', bodyOf({ command: 'cat big' }, { text: 'y'.repeat(3 * 1024 * 1024) }))

  const files = [...d.files.entries()]
  expect(files.length).toBe(1)
  expect(files[0]![0]).toBe(`${ROOT}/s1/steps/toolu_1.json`)
  expect(files[0]![1].text.length < 64 * 1024).toBe(true)
})

test('write then read round-trips', async () => {
  const $ = engineOver(new Disk())
  const body = bodyOf({ command: 'ls', n: 2 }, { text: 'a b', isError: true })
  await writeBody($, 's1', 'toolu_2', body)

  expect(await readBody($, 's1', 'toolu_2')).toEqual(body)
})

test('readBody of a missing file is undefined', async () => {
  const $ = engineOver(new Disk())
  expect(await readBody($, 's1', 'nope')).toBe(undefined)
})

test('snapshot round-trips', async () => {
  const $ = engineOver(new Disk())
  const t: Timeline = { ...empty, seq: 3, notes: [{ text: 'hi', agent: 'main', at: 5 }] }
  await saveSnapshot($, 's1', t)

  expect(await loadSnapshot($, 's1')).toEqual(t)
})

test('loadSnapshot of corrupt JSON is undefined', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  d.files.set(`${ROOT}/s1/timeline.json`, { text: '{"seq": 1, "steps": [', mtimeMs: 1 })
  expect(await loadSnapshot($, 's1')).toBe(undefined)
  d.files.set(`${ROOT}/s1/timeline.json`, { text: '{"seq": 1}', mtimeMs: 1 })
  expect(await loadSnapshot($, 's1')).toBe(undefined)
})

test('prune keeps the newest 20', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  for (let i = 0; i < 25; i++) {
    d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  }

  await prune($, 20)

  expect(d.removed.sort()).toEqual([0, 1, 2, 3, 4].map(i => `${ROOT}/sess-${i}`).sort())
  const left = new Set([...d.files.keys()].map(k => k.split('/')[4]))
  expect(left.size).toBe(20)
})

test('prune spares the running session even when it is old', async () => {
  const d = new Disk()
  const $ = engineOver(d)
  for (let i = 0; i < 22; i++) {
    d.files.set(`${ROOT}/sess-${i}/timeline.json`, { text: '{}', mtimeMs: 100 + i })
  }

  await prune($, 20, 'sess-0')

  expect(d.removed).toEqual([`${ROOT}/sess-1`])
})

test('with no home folder the journal writes nothing', async () => {
  const d = new Disk()
  await writeBody(engineOver(d, {}), 's1', 'toolu_3', bodyOf({}, { text: 'x' }))
  expect(d.files.size).toBe(0)
})

// Through the mod itself: the disk answers the engine's fs calls beneath it.
function world(on: On, d: Disk, sessionId: string): { timeline?: Timeline } {
  const box: { timeline?: Timeline } = {}
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: sessionId }))
  on('command.register', () => ({ value: { command: 'mc' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('fs.read', (_, e) => ({ value: d.read(e.path) }))
  on('fs.write', (_, e) => ({ value: d.write(e.path, e.text) }))
  on('fs.exists', (_, e) => ({ value: d.exists(e.path) }))
  on('fs.list', (_, e) => ({ value: d.list(e.path) }))
  on('fs.stat', (_, e) => ({ value: d.stat(e.path) }))
  on('process.run', (_, e) => ({ value: d.remove(e.argv) }))
  on('state.set', async (_, e, next) => {
    const out = await next(e)
    if (e.key === 'timeline') box.timeline = (e.value as { value?: Timeline } | undefined)?.value
    return out
  })
  return box
}

const saved: Timeline = { ...empty, seq: 7, notes: [{ text: 'from before', agent: 'main', at: 9 }] }

test('a resumed session restores its snapshot', async ($, on) => {
  const d = new Disk()
  d.write(`${ROOT}/sess-r/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-new')

  await $.classic.SessionStart({ source: 'resume', session_id: 'sess-r' })

  expect(box.timeline).toEqual(saved)
})

test('session start prunes old folders and restores this session', async ($, on) => {
  const d = new Disk()
  for (let i = 0; i < 22; i++) d.write(`${ROOT}/old-${i}/timeline.json`, '{}')
  d.write(`${ROOT}/sess-s/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-s')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(box.timeline).toEqual(saved)
  expect(d.removed.length).toBe(3)
  expect(d.exists(`${ROOT}/sess-s`)).toBe(true)
})

test('a snapshot does not replace a timeline already under way', async ($, on) => {
  const d = new Disk()
  d.write(`${ROOT}/sess-r/timeline.json`, JSON.stringify(saved))
  const box = world(on, d, 'sess-r')
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('clock.now', () => ({ value: 1 }))

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.classic.SessionStart({ source: 'resume', session_id: 'sess-r' })

  expect(box.timeline?.steps.length).toBe(1)
  expect(box.timeline?.seq).toBe(1)
})

test('a tool call writes its body to the journal', async ($, on) => {
  const d = new Disk()
  world(on, d, 'sess-b')
  on('tool.call', () => ({ result: {}, text: 'listing' }))
  const clock = mock.clock(on, { now: 1 })

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  // The body is written after the hook returns: let that work settle.
  await clock.advance(1)

  const path = [...d.files.keys()].find(k => k.startsWith(`${ROOT}/sess-b/steps/`))
  expect(path === undefined).toBe(false)
  const body = JSON.parse(d.read(path!)) as { text: string; input: Record<string, unknown> }
  expect(body.text).toBe('listing')
  expect(body.input).toEqual({ command: 'ls' })
})

test('a main turn end saves a snapshot', async ($, on) => {
  const d = new Disk()
  world(on, d, 'sess-t')
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on, { now: 1 })

  await $.turn.start({ text: 'hello', turnId: 't1' })
  await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)

  const snap = JSON.parse(d.read(`${ROOT}/sess-t/timeline.json`)) as Timeline
  expect(snap.turns[0]?.id).toBe('t1')
  expect(snap.turns[0]?.endedAt).toBe(1)
})
