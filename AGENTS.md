# Project instructions

## Git workflow exception — 7 November 2026

The owner explicitly set this exception for the home-budget project and its
`lirielgozi/israeli-bank-scrapers` fork only. It overrides inherited instructions
requiring a pull request for these two repositories. It does not change the
workflow of any other repository or any unrelated instruction.

- Always do work on a working branch. Use an isolated worktree when other sessions
  share a checkout; do not switch or overwrite their work.
- Keep commits small and revertible. Complete the requested work and appropriate
  checks before merging. Documentation-only changes need no code tests.
- Merge tested changes directly into the default branch and push it. Do not open
  new pull requests. Fast-forward integration is allowed; never force-push.
- The default branch of this fork is `master` on remote `fork`
  (`lirielgozi/israeli-bank-scrapers`). Remote `origin` is the upstream
  `eshaham/israeli-bank-scrapers` repository; do not push this project's work there.
  The companion `lirielgozi/home-budget` repository uses `main` on its `origin`.
- Coordinate concurrent default-branch updates: fetch the latest default, preserve
  other workers' commits, and bring shared local default checkouts up to date by
  fast-forward only. If a push races another update, integrate it and retry without
  force-pushing.
- Clean up only your own merged branches and worktrees after verifying their
  commits are ancestors of the default branch and nothing still uses them.
- Preserve existing merged pull-request history. This exception remains in effect
  until the owner changes the policy or the project is prepared for public release.

This Git policy does not authorize deployments or database changes.
