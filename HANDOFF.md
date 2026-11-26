# Claude Report handoff

Updated 26 November 2026. Notes for the next session. Excluded from the VSIX by `.vscodeignore`.

## State

- Released **0.12.6** on 26 November 2026 (tag `v0.12.6`). The unreleased local builds 0.12.6–0.12.8 were folded into this one release; their VSIX files were removed from `dist`.
- Export workflow (owner preference): iterate the export first — run `npm run package` — so the IDE shows the update; for the real push to Open VSX, go back to the latest live version and release the next one.
- `.vscodeignore` excludes `.desktop-main-stage/**` — without it an untracked dev-tool folder inflated a VSIX to 25 MB.
- Plan usage (`src/plan-usage.js`, since 0.12.2): memory → shared temp cache (`%TEMP%/claude_oauth_usage.json`) → Anthropic OAuth `/api/oauth/usage` → stale cache, with the status-line hook as a parallel writer. Setting `claudeReport.planUsage.enabled` (default on).

## What 0.12.6 changed

1. **Status bars** — `src/statusbar.js` `bar(pct)`: 5 cells of `█`/`░`, used by the VS Code status bar and the colored terminal line in `bin/hook.js`. `src/install.js` copies `src/statusbar.js` into the versioned runtime.
2. **Trend colored by height** — `sparkline()` in `template/panel/metrics.js`: a vertical `linearGradient` with `gradientUnits="userSpaceOnUse"` from y(0) to y(100).
3. **Early refills** — `refillTimes()`: a drop of `REFILL` (8) points or more while the scheduled reset (`sr`/`wr`) has not passed or changed is drawn as `.spark-reset.spark-refill`. `refreshNote()` adds the "weekly was probably refreshed" note when both windows refilled in 24 h.
4. **Folded lists** — `foldList()` (exported from metrics.js, used by the sidebar shell too): `.hrows[data-list] > .hrows-list (first rows + .hmore-body) + .hmore button[data-key]`. Open, `.hrows-list` scrolls as one area (max 320 px). The shell owns keyed lists: `S.more[key]`, redraw keeps them open and keeps their inner scroll.
5. **Folding sections** — `head(key, …)` in `template/panel/shell.html`: `.cp-scope.click[data-fold]` with an inner `.fold-t` button for keyboard and `aria-expanded`; `S.closed[key]`. Both persist through `api.setState`.
6. README: `media/marketplace/metrics.png` redrawn from `design/marketplace-ads.html#metrics` (gauges, height-colored trend with a refill marker, status bar strip).

## Remaining — start here

1. **Confirm 0.12.6 in the real editor** (Cursor) after the store update: folds and lists, the height-colored trend and refill markers, status bar bars, gauges at once after a reload, and **Diagnose Status Bar** reporting `plan usage route: shared-fresh` or `oauth-api`.
2. **Day/night icons to flip to light mode** — requested, not implemented. Only the report page has a theme select (`src/webview.js`); the sidebar has none. Owner decides: flip the whole editor theme, or only the sidebar/report.
3. **Refill threshold** — 8 points is a guess; check it against real history once the owner sees another early refill.
4. **Windsurf listing** — `marketplace.windsurf.com/vscode/item?itemName=haitham72.claude-report` returns "page not found". GitHub support says it is a Windsurf issue. Windsurf installs from Open VSX, where the extension is live, so searching "Claude Report" in Windsurf's Extensions view should still work.
5. **Per-file incremental scan cache** (biggest speed gain left). Claude Control (`lucasdonordeste/claude-control`, `src/metrics.js`) caches each transcript's parsed result keyed by mtime and size; Claude Report re-reads every transcript (`src/scan.js` `scanPeriod`) at start and every 2 minutes while the sidebar is visible. ~0.5 s on 100 MB today, grows with history. Needs per-file results that can be merged.
6. **Retry soon after a login refresh.** After `expired` the poll waits 15 minutes (`AUTH_BACKOFF_MS`). Watch mtime of `.credentials.json` during backoff and retry when it changes.
7. **Connect tab dot.** `template/panel/shell.html` `tabs()` marks Connect whenever the hook is not connected; show it only without a plan reading, like the Metrics banner.
8. **Policy decision for the owner.** `/api/oauth/usage` is undocumented (beta header `oauth-2025-04-20`), poll on by default and silent. Confirm with Anthropic's terms; other routes keep working if the endpoint goes away.
9. **Small cleanups.** Release/CI workflows: `actions/checkout` and `actions/setup-node` v4 → v5. Narrow-sidebar truncation at ~200 px (token stat, "Only the open project" row, scope tags). Linux shared cache in `/tmp`: consider `flag: 'wx'` or skipping the shared write when `/tmp` is shared.

## Publishing

`.github/workflows/release.yml` runs on a pushed tag like `v0.12.8`: tests on Windows, checks the tag matches `package.json`, builds the VSIX, publishes to the VS Code Marketplace (`vsce publish --oidc`, trusted publishing) and Open VSX (`ovsx --trusted-publishing`), then creates the GitHub release from the CHANGELOG section. No tokens needed.

Release steps: bump `version` in `package.json`, add `## <version>` to `CHANGELOG.md`, run `node --test`, commit, `git push origin main`, then `git tag v<version>` and `git push origin v<version>`. Store listings can lag a few minutes; query Open VSX by version (`/api/haitham72/claude-report/<version>`) since its latest endpoint is cached.

## Testing notes

- Host tests (`test/report-host.test.js`, `test/wiring.test.js`) stub `./src/plan-usage`; keep it that way so tests never read the real login or call the network.
- `test/statusbar-env.test.js` asserts the `bar()` glyphs and status item texts; `test/metrics-tab.test.js` asserts the height gradient, the latest dot, refill markers and the refresh note, the list caps, the .hrows wrapper and the expand toggle.
- `design/build-preview.js` writes `design/panel-preview.html` (gitignored, real data). `DEMO=1` rewrites the tracked `design/demo-preview.html` and `design/demo-report.html`.
