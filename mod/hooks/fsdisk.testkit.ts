// A test helper, not part of the mod. Imported by *.test.ts(x) files only.
//
// Tests simulate Windows (USERPROFILE 'C:/Users/x', OS 'Windows_NT'), so the
// mod asks for paths like 'C:/Users/x/.claude/binnacle/...'. On a POSIX host
// the test kit resolves such a path, which is not absolute there, against the
// working directory before a hook sees it: '/tmp/run/C:/Users/x/...'. This
// cuts anything before a Windows drive and turns backslashes into slashes, so
// a fake disk keyed by Windows paths, and a path assertion, read the same on
// Windows and on macOS or Linux.

/** The Windows path the mod asked for, from the path the test kit handed a hook. */
export function diskPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
}
