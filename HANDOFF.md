# Claude Report handoff

Updated 24 November 2026. Notes for the next session. Excluded from the VSIX by `.vscodeignore`.

## State

- 0.12.5 is released: GitHub release, Open VSX and the VS Code Marketplace (tag `v0.12.5`, commit `38a132a`).
- 0.12.2 added the plan-usage poll (`src/plan-usage.js`): memory → shared temp cache (`%TEMP%/claude_oauth_usage.json`) → Anthropic OAuth `/api/oauth/usage` → stale cache, with the status-line hook as a parallel writer. Setting `claudeReport.planUsage.enabled` (default on).
- 0.12.3 fixed the poll freezing (re-saving the shared cache bumped its mtime), added backoff, expiry checks and a non-blocking sidebar refresh.
- 0.12.4 fixed history trimming (an older shared reading deleted newer hook points), read `expiresAt` as milliseconds, kept late API answers in the sidebar's final post, and stubbed plan-usage in the host tests (they had been reading the real login). Also: plan gauges drawn before the transcript scan, the last scan kept in `~/.claude-report/scan-cache.json` (instant Metrics after a restart), and the "needs Claude Code connected" banner shown only without any plan reading.
- 0.12.5 stacked the Metrics rows like Claude Code's usage panel (label and figure, full-width bar, details below), so a narrow sidebar no longer cuts figures off.
- 293 tests pass (`node --test`).

## Remaining

1. **Check in the real editor.** Testing so far used the suite, a stub-vscode harness driving the real `extension.js`, and headless Edge screenshots of `design/panel-preview.html`. Confirm in Cursor: gauges show at once after a reload, narrow rows read well, and **Diagnose Status Bar** reports `plan usage route: shared-fresh` or `oauth-api`.
2. **Per-file incremental scan cache** (biggest speed gain left). Claude Control (`lucasdonordeste/claude-control`, `src/metrics.js`) caches each transcript's parsed result keyed by mtime and size, so only changed files are read. Claude Report re-reads every transcript per scan (`src/scan.js` `scanPeriod`), at start and every 2 minutes while the sidebar is visible. About 0.5 s on 100 MB today; grows with history. Needs `scanPeriod`'s per-project aggregation split into per-file results that can be merged.
3. **Retry soon after a login refresh.** After an expired token (`expired` route) the poll waits 15 minutes (`AUTH_BACKOFF_MS`). Watch the mtime of `.credentials.json` during that backoff and retry once it changes.
4. **Connect tab dot.** `template/panel/shell.html` `tabs()` still marks Connect whenever the hook is not connected, though the gauges no longer need it. Show it only without a plan reading, like the Metrics banner.
5. **Policy decision for the owner.** `/api/oauth/usage` is undocumented (beta header `oauth-2025-04-20`) and the poll is on by default and silent. Confirm that using Claude Code's login from another extension is acceptable under Anthropic's terms. The other routes keep working if the endpoint goes away.
6. **Small cleanups.**
   - Release and CI workflows: move `actions/checkout` and `actions/setup-node` from v4 to v5 (Node 20 deprecation warning).
   - Narrow-sidebar truncation left at ~200 px: token stat ("513…"), "Only the open project" row, some scope tags.
   - Linux: the shared cache sits in the shared `/tmp`. The file is written with mode 0600; other users could still pre-create it. Consider `flag: 'wx'` on the temp file or skipping the shared write when `/tmp` is shared.

## Publishing

`.github/workflows/release.yml` runs on a pushed tag like `v0.12.6`: tests on Windows, checks the tag matches `package.json`, builds the VSIX, publishes to the VS Code Marketplace (`vsce publish --oidc`, trusted publishing) and Open VSX (`ovsx --trusted-publishing`), then creates the GitHub release from the CHANGELOG section. No tokens needed.

Release steps: bump `version` in `package.json`, add `## <version>` to `CHANGELOG.md`, run `node --test`, commit, `git push origin main`, then `git tag v<version>` and `git push origin v<version>`. Store listings can lag a few minutes; query Open VSX by version (`/api/haitham72/claude-report/<version>`) since its latest endpoint is cached.

## Testing notes

- Host tests (`test/report-host.test.js`, `test/wiring.test.js`) stub `./src/plan-usage`; keep it that way so tests never read the real login or call the network.
- `design/build-preview.js` writes `design/panel-preview.html` (gitignored, real data). `DEMO=1` rewrites the tracked `design/demo-preview.html` and `design/demo-report.html`.
