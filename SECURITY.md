# Security policy

## Supported versions

Binnacle is early and has no release branches. Only the latest commit on
`main` is supported; fixes land there. It targets Claude Code 2.1.325 or
newer, and a report against an older Claude Code build may be closed if it
cannot be reproduced on a current one.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a
security problem.

Report it privately through GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/aaronjablonski/binnacle-claude-mod/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**). Include:

- what an attacker can do, and what they need first (for example a crafted
  file in the repository, a crafted tool result or a malicious link);
- steps to reproduce, with your Claude Code version and operating system;
- the commit of Binnacle you tested.

You should get a first answer within a week. Once a fix is on `main`, the
advisory is published with credit to you unless you ask otherwise.

## What the mod does, and the scope of a report

Binnacle runs inside Claude Code as a mod, with only the capabilities Claude
Code's mods API gives it. In scope is anything that makes it do more than
the following, or do it with input an attacker controls.

- **Reads its own session.** It observes the events of the session it runs
  in: prompts, tool calls and results, agents, tasks and the budget figures.
  It does not read other sessions' transcripts.
- **Writes a journal on your machine** under `~/.claude/binnacle/`: step
  bodies, a timeline snapshot, exported digests (`export-<stamp>.md`) and
  ledger CSVs. It prunes its own older session folders (`rm -rf` or
  `rmdir /s /q`, only on a folder under that root that holds its own journal
  files). One row per
  session is kept in the mod's store.
- **Runs local commands** through `$.process.run`, each as an argument list
  with no shell, except `cmd /c` on Windows where the argument is checked
  first:
  - your editor (`editor` option, `code` by default) when you press
    `o: open` on a file;
  - the system opener (`open`, `xdg-open` or `start`) for an `http(s)` link
    you press, after the link passes a strict pattern;
  - `rm` or `rmdir` for journal pruning, as above;
  - read-only `git` and `gh` queries (current branch, pull requests and
    stacks) for the pull request view. These use your own `gh` sign-in.
- **Adds one tool and one system-prompt section** to the main conversation
  (`mcp__binnacle__update`, `mod/hooks/guide.tsx`). The `guide: false` option
  removes both.
- **Raises notifications** and, if you turn on `doneSound`, plays a bundled
  sound.

It never:

- changes tool input, tool output or your prompts (capture hooks return what
  Claude Code produced);
- sends anything over the network itself, or sends telemetry;
- reads or stores credentials or tokens;
- starts agents, picks a model or effort, or sends requests on your behalf;
- runs a command you did not press for, other than pruning its own journal
  and the read-only `git`/`gh` queries above.

Examples of what we want to hear about: a tool result or file name that gets
a command run with attacker-chosen arguments, a link that reaches the opener
as something other than a plain URL, a path that makes pruning delete outside
`~/.claude/binnacle/`, or session content written somewhere other than the
journal.

Out of scope: vulnerabilities in Claude Code itself, in `git`, `gh` or your
editor (report those to their maintainers), and anything that needs an
attacker who can already run code as you.
