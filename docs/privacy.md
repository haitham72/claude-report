# Privacy

Claude Report is built to work on your computer. This page lists exactly what it reads, writes and sends, so you can decide whether to use it, and what to check before you share a report.

## What it reads

| File or place | Why |
| --- | --- |
| `~/.claude/projects/**/*.jsonl` (Claude Code transcripts) | Token counts, tool calls, working hours, models, the model and context for the status bar, session titles, and the prompts you typed (for the report) |
| `~/.codex/sessions/**/rollout-*.jsonl` (Codex activity, or `CODEX_HOME` if set) | Token counts, models, and prompts for reports and metrics |
| Available local Git refs for report projects | Repository names, commit IDs, dates and redacted subjects within the reporting period, limited to your configured Git author email when one is set |
| Selected project Git diffs and root README.md or CLAUDE.md | Deep Medium adds relevant filenames and context excerpts. High adds selected changed lines |
| `~/.claude/sessions/*.json` | Which sessions are running |
| `~/.claude/settings.json` | Whether the hook is connected, and its previous status line |
| `~/.claude/cursor-claude-control/usage-history.json` when present | Reads timestamps and plan usage percentages for Metrics. The source file is read-only |
| `~/.claude/.credentials.json` or the macOS Keychain entry `Claude Code-credentials` | Local Claude Code login token, used only to call Anthropic’s plan-usage API (same as `/usage`). Never logged or copied elsewhere. Off via `claudeReport.planUsage.enabled` |
| `%TEMP%/claude_oauth_usage.json` (or `$TMPDIR`) when present | Shared plan-usage cache written by Claude Code status tools, Claude Control, or this extension |
| `~/.claude.json` | Only the part of your account email before the `@`, to show a username on a report. The address itself is never stored or sent |
| `nvidia-smi` output | GPU name and memory, to estimate local model limits |
| `localhost:1234` and `localhost:11434` | Only when you choose Local: the model list from LM Studio or Ollama |

Report evidence comes from prompts, activity counts, Git commit metadata and time you supply.

## What it writes

Claude Report keeps its working files under `~/.claude-report/`.

- `live/`, `windows.json`, `usage-history.json`: model, context, plan usage and working folder from the status line and/or the plan-usage poll. The trend history stores timestamps, plan percentages and reset times for up to eight days. No prompts.
- `%TEMP%/claude_oauth_usage.json` (or `$TMPDIR`): last plan-usage payload shared with other local status tools. Utilization numbers only.
- `config.json`: your previous status line command, kept so it can be restored.
- `prefs.json` keeps your Cloud or Local choice, engine, model and any previously entered time evidence. New time entries are saved with the report example.
- `runtime/`: a copy of the hook script.
- `reports/<month>/runs/<timestamp>/` holds `report.html`, `report.json` and `reports.json` for each run. Legacy reports may be stored directly under the month.
- A saved run can also keep a private redacted sample of up to 60 prompts per project, the original date cutoff, model and runtime details, and its parent revision. Archive status and successfully exported copy paths are stored alongside the run. These records are separate from the HTML, PDF and report data you share.

And, only when you press **Connect**, one change to `~/.claude/settings.json`: the `statusLine` entry. A backup `settings.json.claude-report.bak` is written once, and **Disconnect** puts your previous entry back. A saved copy or PDF goes to the folder you chose, and an email draft is only opened, never sent.

## What it sends

Model requests are made when you confirm **Create report**, **Enhance report** or **Retry failed projects**, using evidence for the projects selected for that run.

**Deep prompting review** asks for separate confirmation after counting and planning locally. Low sends redacted user messages. Medium includes relevant filenames and project context in the same project review. High also includes selected inline diff excerpts. The final synthesis receives the project cards and validated review findings. The exported revision includes findings, timestamp references, filenames and available line ranges. The private `~/.claude-report/deep-review-cache/` stores source fingerprints, check times and project findings for reuse. Raw Deep messages, inline diffs and documentation excerpts are excluded from the cache, synthesis input, and exported report.

- **Cloud mode** sends redacted prompts, activity totals and summaries of available Git evidence through the `claude` command using your Claude Code sign-in and plan. The extension runs the command with `--no-session-persistence` in a temporary working folder.
- **Local mode** sends the project and overview inputs to the model server on this computer.

When an overview is generated, its input contains the project summaries and activity coverage across the period. Enhancement uses the saved sample where available. For an older run, it can rebuild evidence from activity still available for the original report period.

**Plan usage** (Metrics gauges and status-bar 5h/7d), when `claudeReport.planUsage.enabled` is on (the default), sends your existing Claude Code login token to `api.anthropic.com/api/oauth/usage` over HTTPS — the same endpoint `/usage` uses. The token is read locally and never stored by Claude Report. Turn the setting off to stop those requests; gauges then rely only on the status-line hook and any shared cache already on disk. API-key-only logins have no OAuth token, so this path stays empty.

Nothing else is sent when you open the sidebar, browse sessions or look at metrics. There is no telemetry, no analytics and no Claude Report account.

## What is removed before sending

- Prompts that mention a `.env` file, or paste two or more `KEY=value` lines, are dropped completely.
- Text that looks like an API key, bearer token, JWT, private key, password, a password inside a URL, or an email address is replaced with `[redacted]`.
- Model report text is scrubbed again with the same rules before it is saved or shown.

Redaction is pattern based. Review the text, project names and commit subjects before sharing a report.

## Reports are estimates

Report examples display any time you supply for a task. The **AI time estimates** option can add model estimates for other examples.

## Removing everything

To remove an individual run, use **Delete saved report** in the Report tab. It moves the saved report and its private evidence to Trash. Exported copies stay in their destination folders and can be managed separately from the saved report menu while the run is still available.

To remove all extension data, press **Disconnect** on the Connect tab, uninstall the extension, and delete `~/.claude-report/`. Remove any copies kept in your export folders or Trash separately. To report a security problem, see [SECURITY.md](../SECURITY.md).
