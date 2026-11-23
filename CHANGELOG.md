# Changelog

All notable changes are listed here, newest first.

## 0.11.2

- Runs in several editors at once. The status-line hook is copied to a folder per version (`~/.claude-report/runtime/<version>/`), so editors on different builds never overwrite each other's copy or a file Claude Code is running. The newest build moves the status line forward; an older build in another editor never moves it back.
- Repairs itself: on startup, a connected editor rewrites a missing hook and repoints the status line if the file it named is gone. The panel counts as connected only when that file exists, and Connect refreshes the files even when the setting is already in place.
- Plan usage no longer depends on the hook alone. When the hook is silent, the five-hour and weekly gauges read the shared usage cache under the system temp folder, newest reading first, ignored once it is older than six hours.

## 0.11.1

- Rewrites the README, which is also the Marketplace page, as a short product page: a cover, a GIF of a report, and four images for plan usage, what you shipped, prompting advice and evidence. The full manual moves to `docs/guide.md`.

## 0.11.0

- Adds an Advice section to Quick and Deep reports, apart from the achievement overview: one strength, one thing to watch and one habit to try, each with where it was seen. Project cards now write a short note on how prompts were phrased, and the advice is built from those notes or from the Deep reviews. Under ten prompts it is labelled a first look, and it never gives scores.
- Adds Learn more links under the advice. They come from a fixed list of official Claude documentation pages, never from the model, and the page shows only those addresses.
- Redesigns the collapsed project rows: an icon, the name, a one-line summary, tokens and prompts, a share bar and the outcome counts. Icons are built-in inline shapes assigned from the project name.
- Adds the `browser-ai-report` skill in `skills/` for people who use Claude in the browser without an IDE. The extension does not use it.

## 0.10.5

- Runs Deep at the selected evidence depth. Haiku reviews cloud projects independently, three at a time, and Sonnet synthesizes their findings in one final report request.
- Reuses identical project reviews from the cache and splits input only when the project evidence exceeds the reviewer context.
- Caps model requests. Deep lists its planned requests before it starts, runs at one depth only, and refuses any request for another depth, an unplanned kind, or past the planned count. A run can no longer repeat every project at every effort.
- Stops Claude Code from respawning without end when its executable cannot be started.
- Rebuilds the report page: a section nav, a totals row, a ranked project list, a usage chart that groups small projects with a data table, a prompting section and an evidence section. It opens in standards mode with UTF-8 and a phone viewport, keeps System, Light and Dark, opens fully for PDF, and meets AA text contrast.
- Labels each example Requested, Recorded or Verified, and counts saved time only for examples with a recorded result. Older reports stay readable.
- Shows the checked excerpt of the user's own words with each prompting finding, with UTC references. Labels the rewrite and project context as model-written.
- Counts only your own messages as prompts: Codex subagent briefs no longer inflate prompt counts or project eligibility, while their tokens still count.
- Lists only commits by the configured Git author. Lists commit dates apart from prompt dates, so a one-day activity summary no longer hides commits on other days.
- Keeps a split project's review summary across batches, ends over-length overview cards at a whole sentence, and keeps prompt IDs out of the synthesis.
- Existing Deep review caches are not reused once, so reviews regain their excerpts.

## 0.10.4

- Adds current Claude plan usage and reset countdowns above the 24-hour and seven-day trends.
- Reads existing local Claude Control usage history when available. Burn-rate estimates require at least 15 minutes of readings in the active quota window.

## 0.10.3

- Expands project cards with editable example details and more room for distinct work, evidence, friction and next steps. An evidence-rich project can get one expansion pass when its draft is short.
- Charts Claude's five-hour plan usage over 24 hours and weekly usage over seven days. Shows reset timestamps and preserves gaps in recorded readings.

## 0.10.2

- Plans Deep reviews from the model context, preserving user wording and splitting by session only when needed.
- Runs Deep through the chosen evidence level and reuses earlier findings when their source fingerprints match.
- Excludes known injected browser and editor context from the writing review and checks evidence excerpts against the cited prompt.

## 0.10.1

- Fixes Report depth and AI time estimates switches. Adds optional custom report dates and opens reports only when selected.

## 0.10.0

- Adds Quick and Deep report depth. Deep runs a separate per-project writing and prompting review with a local preflight, three evidence levels, and automatic batching.
- Adds subtle gradient fills to the three overview cards and moves manual time entry to editing a saved report example.

## 0.9.8

- Restores optional AI estimates for example times and savings, with labels that distinguish them from user-supplied time.

## 0.9.7

- Reads user prompts from newer Codex transcript records so projects with Codex activity appear in the Report tab.

## 0.9.6

- Adds List and Flow views to live report progress, with completion time, Open report, and a retry action for partial runs.

## 0.9.5

- Sizes the context for new local model loads using current VRAM and a 90% GPU memory target. Larger contexts can carry more report evidence.

## 0.9.4

- Adds a saved report menu for exporting, revealing or removing exported copies, hiding and restoring runs, and moving saved reports to Trash.
- Lets you edit project cards, retry failed projects, enhance selected projects or the whole report, and compare a revision with its parent. Enhancement has per-run cloud and local model controls.
- Saves a private redacted evidence sample for each run and tracks its original date cutoff. Adds cancellation and a runtime log with stage and model timings and context size when available.
- Gives expanded project cards more room for examples and evidence. The monthly overview now prioritizes sustained work across days. Report generation saves project drafts directly after validation.

## 0.9.3

- Exports reports in month folders as `Report_MM-DD-YYYY_HH-mm-ss_name.html`.
- Adds a System, Light and Dark theme selector in the report header.
- Adds dated Git evidence from available local refs and tighter evidence-review instructions for local models.

## 0.9.2

- Keeps projects visible during refresh and discovers local models in a background worker.
- Local generates the full report on the selected server, with one project at a time and model-specific thinking controls.
- Saves each run with its own timestamp, shows project failures, and uses time supplied in the Report tab.
- Adds Claude, Codex, and All filters to the Metrics header. Codex local activity can also contribute to reports.

## 0.9.1

- Fixed New session doing nothing. It used the Claude Code command that only tells an open panel to start over. It now opens a fresh conversation in the Claude Code extension, whether or not a panel was open, and never falls back to the command line while that extension is installed.

## 0.9.0

- Connect tab: a Report model block with a Cloud | Local switch. Cloud shows Haiku and Sonnet. Local reveals the LM Studio | Ollama swap, your GPU and the models with their context limits. The separate "Use for project summaries" switch is gone, the mode is the switch.
- A label such as "too big" no longer wraps onto two lines.
- Documentation: a rewritten README with screenshots, and guides for how it works, reports, local models, privacy, troubleshooting and releasing. Contributing guide, code of conduct, issue and pull request templates, and a CI workflow.

## 0.8.3

- Fixed `EPERM: operation not permitted, rename ... settings.json`: on Windows another program can hold settings.json open. The write is retried briefly and then done in place, and the temp file is always removed.
- Local model requests always ask for thinking off. A server that rejects those flags is asked again without them before the schema is dropped.

## 0.8.2

- Local model: the token budget starts at 4,000 and a reply cut off by the limit is retried once with double, since one rambling run in eight hit the old 1,800 limit.

## 0.8.1

- Fixed the local model switches and engine picker doing nothing: the editor refuses to save a setting its manifest cache does not know yet, which happens right after installing a new version. Choices now live in `~/.claude-report/prefs.json`.
- The Local model block is collapsed when the sidebar loads and only looks for servers when opened.
- The loading screen stays up for under a second on a cold start so it can be seen.

## 0.8.0

- Local model: Connect detects LM Studio and Ollama, lists their models with the largest context each fits on your GPU, and can write the per-project summaries locally. If the server is down you are told, nothing falls back to Claude silently.
- The 5h and 7d readings now survive a restart. Claude Code only sends them after a session's first response, so the last good values are kept until the window resets, and the tooltip says how old they are.
- Project cards written by the local model are marked "local draft".
- The report prompts no longer contain example values a small model can copy (project name, time estimates).

## 0.7.0

- Connect tab redesigned: a Connection block with a state badge and plain buttons, and a Bottom bar block that lists where each number comes from and how old the last reading is.
- Refresh now reloads the extension: caches dropped, status bar and sidebar page rebuilt, data read again. New Reload and Restart Extension commands.
- A loading screen with the Claude Report logo while the sidebar reads your sessions. Sessions and the connection now appear before the slower scans finish.
- New logo (media/logo.svg).
- Corrected the docs: Claude Code in VS Code does run the status line command.

## 0.6.1

- The Report tab is redesigned as one clear flow: Projects, Output (format, preview, save, email) as switches, a full-width Create button that says how many projects, then a progress bar with a status per project, and saved reports with an export link.

## 0.6.0

- Resuming a session from another folder or editor now works: it opens a terminal in that session's own folder and runs `claude --resume`. Only sessions from the open folder use the Claude Code panel, which cannot find the others.
- The status line Claude Code shows in the terminal is now a coloured line of its own (project, model, context, 5h, 7d) when no other status line is chained.
- Connect shows Remove old status line when the program a previous status line ran has been uninstalled.
- The output panel records what the bottom bar shows, to help diagnose a missing bar.

## 0.5.0

- New Sessions tab, first and always the one the sidebar opens on: your Claude Code sessions with a one-click resume, like the Claude Code panel.
- The sidebar follows the editor theme, light and dark.
- The plan usage API is removed completely. The extension makes no network calls. 5h and 7d come only from the status line hook.
- A status line still pointing at the old Companio hook can be moved with one click (Update the hook). Test the hook now checks both folders and hides colour codes.

## 0.4.0

- Every project with prompts can be reported: the 4-prompt minimum is gone.
- After creating, the Report tab can save a copy (Downloads or a folder you pick), preview, and open an Outlook draft with the report attached. HTML or PDF. Saved reports have an export link.
- Status bar moved to the left by default, with explicit item ids. New Diagnose Status Bar command and a Claude Report output panel.
- Print layout and a #print mode so the PDF shows every project card open.

## 0.3.0

First public version, named Claude Report.

- Status bar with ring gauges for 5h and 7d usage, plus model and context.
- Model and context now come from session transcripts, so they work in every IDE. The status line hook is optional.
- Optional plan usage API for 5h and 7d, off by default, behind a confirmation.
- Sidebar with Metrics, Report and Connect tabs. Metrics follows Claude Control's layout.
- Report: choose projects up front, live per-project progress, Haiku workers, Sonnet overview, skills as the instructions, HTML output with a hover-highlight chart.
- Connect: test the hook with the exact saved command.
- Prompts that mention `.env` files or paste env lines are never sent or shown.
- Renamed from the working name Companio. A config from earlier builds is carried over on first start.
