## Summary

<!-- What changes and why. For anything visible, add before and after screenshots. -->

## Linked issue

<!-- Fixes #123. Features and changes to what the pane shows need an agreed issue first. -->

## Checks

- [ ] `npm test` passes
- [ ] `npx tsc -p mod --noEmit` passes
- [ ] `claude plugin validate ./mod` passes
- [ ] `claude plugin test ./mod` run locally (list any failures, and whether they also fail on `main`)
- [ ] Tests added or updated for the behaviour change
- [ ] UI change: README text and pictures updated (`node docs/readme/tools/make.mjs`)
- [ ] UI or behaviour change: ruling added or amended in `docs/superpowers/plans/2026-11-16-cockpit-critters-rulings.md`
- [ ] Capture hooks still only observe; nothing new is added to the conversation
- [ ] No secrets, tokens, personal paths or private data in code, fixtures or screenshots

Claude Code version tested with:
