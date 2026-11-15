// Open in editor (rich spec binding rule 5): every file a step or artifact
// names gets `o: open`, which runs the person's editor on the press only.
//
// The editor is the plugin option `editor` (default `code`), handed in by
// registerShell. The call is `<editor> -r -g <path>[:line]`, which VS Code,
// Cursor and Windsurf read as "reuse the window, go to the line". Where it
// cannot run or exits non-zero, the path goes on the clipboard and a toast
// says why. Images open the same way (the editor's image preview).

import type { EngineInterface, RenderElement } from 'claude-code'

import { debug, errText } from '../state'

/** The editor when the option is unset or blank. */
export const DEFAULT_EDITOR = 'code'

let editor = DEFAULT_EDITOR
let knownRoot: string | undefined

/** Takes the `editor` option (registerShell). A blank or non-string value means `code`. */
export function configureEditor(name: unknown): void {
  editor = typeof name === 'string' && name.trim() !== '' ? name.trim() : DEFAULT_EDITOR
}

/** The editor `openInEditor` runs. */
export function editorName(): string {
  return editor
}

/** Remembers the session's project root, so a draw can make a relative path absolute without waiting (startShell). */
export function rememberRoot(root: string | undefined): void {
  knownRoot = root
}

const ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/])/

/**
 * `path` made absolute against `root`: an absolute path (`C:\…`, `C:/…`,
 * `/…`, `\\server\…`) stays as it is; a relative one is joined to `root` with
 * the root's own separator, a leading `./` dropped. Without a root it stays.
 *
 * @example absolute('src/a.ts', 'C:\\repo') // 'C:\\repo\\src\\a.ts'
 */
export function absolute(path: string, root: string | undefined): string {
  const p = path.trim()
  if (ABSOLUTE.test(p) || root === undefined || root === '') return p
  const sep = root.includes('/') || !root.includes('\\') ? '/' : '\\'
  const rel = p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)
  return root.endsWith('/') || root.endsWith('\\') ? `${root}${rel}` : `${root}${sep}${rel}`
}

/**
 * The `vscode://file/` URL for `path` (made absolute against the remembered
 * root), with `:line` when given: what a click on `fileLink` opens.
 *
 * @example fileHref('C:\\repo\\a.ts', 12) // 'vscode://file/C:/repo/a.ts:12'
 */
export function fileHref(path: string, line?: number): string {
  const abs = absolute(path, knownRoot).replace(/\\/g, '/')
  const tail = line !== undefined && line > 0 ? `:${Math.floor(line)}` : ''
  const lead = abs.startsWith('/') ? '' : '/'
  return encodeURI(`vscode://file${lead}${abs}${tail}`)
}

/**
 * A file as a `Link` the person can click (VS Code's `vscode://file/` URL):
 * the click path beside `o: open`. The text is `label`, or the path.
 *
 * @example fileLink(ctx.e, $, step.path, 12)
 */
export function fileLink(e: Parameters<EngineInterface['ui']['resolve']>[0], $: EngineInterface, path: string, line?: number, label?: string): RenderElement {
  const { Link } = $.ui.resolve(e)
  return Link({ href: fileHref(path, line), children: label ?? path })
}

/** What cmd.exe may be handed in the fallback: no metacharacter that could start another command. */
const SAFE_FOR_CMD = /^[\w\-.:\\/ ~@+,=#]+$/

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

/** The project root, or the working directory, or none. Never throws. */
async function rootOf($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.root()
  } catch {
    try {
      return await $.session.cwd()
    } catch {
      return knownRoot
    }
  }
}

/**
 * Opens `path` (at `line`) in the person's editor: `$.process.run([editor,
 * '-r', '-g', 'path:line'])`, the path made absolute against the session's
 * root. Call it from a press handler only, never while drawing.
 *
 * Where the editor cannot start (Windows runs `code` as `code.cmd`, which no
 * process starts without a shell) it tries once more through `cmd /d /c`,
 * only when the editor and the path hold no character cmd would read as a
 * command. Where that fails too, or the editor exits non-zero, the path goes
 * on the clipboard of `surface` and a toast says why. Never throws.
 *
 * @returns true when the editor took it
 * @example onPress: () => openInEditor($, file.path, file.line, ctx.e.surface)
 */
export async function openInEditor($: EngineInterface, path: string, line?: number, surface?: Surface): Promise<boolean> {
  const abs = absolute(path, await rootOf($))
  const target = line !== undefined && line > 0 ? `${abs}:${Math.floor(line)}` : abs
  const argv = [editor, '-r', '-g', target]
  let reason: string
  try {
    const got = await $.process.run(argv, { timeoutMs: 15_000 })
    if (got.exitCode === 0) return true
    reason = `${editor} exited ${got.exitCode}`
  } catch (err) {
    reason = `${editor} did not start: ${errText(err)}`
    if (SAFE_FOR_CMD.test(editor) && SAFE_FOR_CMD.test(target)) {
      try {
        const got = await $.process.run(['cmd', '/d', '/c', ...argv], { timeoutMs: 15_000 })
        if (got.exitCode === 0) return true
        reason = `${editor} exited ${got.exitCode}`
      } catch (again) {
        debug($, `open in editor: cmd fallback failed: ${errText(again)}`)
      }
    }
  }
  debug($, `open in editor failed: ${reason}`)
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text: abs, surface })).isCopied
  } catch (err) {
    debug($, `copy failed: ${errText(err)}`)
  }
  try {
    $.ui.toast(isCopied ? `Not opened: ${reason}. Path copied.` : `Not opened: ${reason}. ${abs}`)
  } catch {
    // nowhere left to say it
  }
  return false
}
