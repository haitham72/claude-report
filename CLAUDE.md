# Claude Report

Read [README.md](README.md) for what the product does and [docs/guide.md](docs/guide.md) for supported sources, build, and project layout. Read [HANDOFF.md](HANDOFF.md) for local work in progress when the file exists.

| Work | Start here |
| --- | --- |
| Activity, project matching, or token counts | `src/scan-worker.js`, `src/scan.js`, `src/codex-activity.js`, `src/antigravity-activity.js`, `src/cursor-activity.js`, `src/sqlite-read.js`, `src/sources.js` |
| Claude plan usage or status line | `bin/hook.js`, `src/live.js`, `template/panel/metrics.js` |
| Quick cards, overview, or model routing | `src/generate.js`, `src/overview.js`, `src/local-report.js`, `src/local-fit.js`, `skills/` |
| Deep evidence selection, Haiku project reviews, or Sonnet synthesis | `src/deep-review.js`, `src/deep-stages.js`, `src/deep-git.js`, `src/overview.js`, `extension.js` |
| Report HTML design and audit | `template/report.html`, `src/render.js`, `test/render.test.js`, `design/build-preview.js` |
| Sidebar, saved history, or export | `extension.js`, `src/host.js`, `template/panel/`, `src/report-store.js`, `src/export.js` |

Run `node --test` before packaging. Run `npm run package` to build the VSIX in `dist/`.

Use synthetic fixtures in tracked files. Keep transcripts, personal report data, and local release notes out of version control and VSIX packages.
