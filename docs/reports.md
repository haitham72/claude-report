# Reports

How a monthly report is built, what is in it, and how to change what it says.

## What is in a report

- **Header and navigation** show your username (the part of your Claude account email before the `@`), the period, and links to Overview, Usage, Projects, Advice, Prompting and Evidence. A row of totals shows tokens (with the cache-read share), active days, projects and recorded commits.
- **Summary, Goal and Achievement** describe the period from project reports. Sustained work across multiple days takes priority, and the goal reflects the broader objective supported by activity throughout the month.
- **Advice** is its own section after Projects, kept apart from the achievement report. It shows three tiles in Quick and Deep reports: a strength, a thing to watch and a habit to try, with where each was seen. It rests on a short note each project card writes about how you phrased your prompts (Deep uses the full project reviews). Under ten prompts it is labelled a first look. It has no scores. The **Learn more** links come from a fixed list of official Claude documentation pages chosen by topic, never from the model.
- **Usage** shows tokens by day as stacked bars. The eight largest projects keep a colour and the rest group as **Other**. Use the project picker to focus the chart, hover, focus or click a legend entry to highlight a project, or open the data table. A line under the chart splits input, output, cache reads and cache writes.
- **Projects** are ranked rows. Each collapsed row shows an icon, the name, a one-line summary, tokens and prompts, a share-of-tokens bar and the outcome counts. The icon is assigned from the project name. The first five show, with the remaining projects under **Show more**. Expand a row for up to eight examples with details and supporting evidence, plus AI uses, friction and next steps. Each example carries a status: **Requested** (asked for, no result recorded), **Recorded** (a commit, file change or agent report records a change) or **Verified** (a test result, run or confirmation is recorded). Time appears only for examples with a recorded result. Older reports have no status, so only clear wording such as "no fix is recorded" is read as a request and marked **inferred**. Reports built with a local model mark rows **local draft**.
- **Prompting** shows the cross-project synthesis, then each project's review. A finding shows the checked excerpt of your own wording, its observation and a UTC reference. The suggested rewrite and the project context note are model-written and labelled as such.
- **Evidence** lists dated commits from available local refs, limited to commits matching the repository's configured author email, with repository names, subjects and counts. The first 20 show for each repository. If no author email is configured every commit is listed and the report says so. A commit shows when a change was recorded, not that a prompt produced it. All times are UTC. A note explains how tokens, prompts and time estimates are counted.

Turn on **Report → Output → AI time estimates** to show estimated time with and without AI and the estimated savings in example cards. The setting applies to Create and Enhance. The report labels the estimates and uses any time you supply for a matching task.

## Cloud hooks and models

Under **Report → Model → Cloud**, choose a signed-in hook and expand it to pick the per-project and overview models and supported reasoning effort. The same picker is available under **Connect → Report model**. Claude Code, Codex, Muse, Antigravity, OpenCode, Cursor CLI and Gemini CLI are checked for eligible native sign-ins. OpenCode models must belong to a connected OAuth provider. If a CLI cannot list its models and supports running with its default, the picker shows **CLI default**.

Use **Connect** to sign in through the provider where supported, then rescan. Sign-in stays with the CLI or provider. The extension requires an existing subscription login to run a cloud report.

Google AI personal accounts use Antigravity. Gemini CLI requires a Gemini Code Assist Standard or Enterprise license and a configured Google Cloud project. [Google's Gemini CLI transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)

Before starting, the Report tab estimates the workload for the chosen projects, models, and report depth. For Claude Code and Codex, it can show a rough percentage range when there are enough usable local samples to match changes in a quota window to transcript token usage. Claude's windows are five hours and one week. Where a current reading is available, the estimate also projects utilization after the run. With insufficient history, the preview shows approximate tokens and requests, with current utilization if available. Muse can show current usage when its CLI exposes an allowance.

Cloud reports follow the provider account's usage and billing settings. If your account allows paid overages, check the provider's account usage settings before running close to an included limit.

## Report depth

**Quick** creates the normal report. **Deep** saves the project cards first, runs a separate prompting review with its own context, and saves the synthesized report as a revision. You can also choose **Run Deep prompting review** from any saved report.

**Date range** defaults to this month. Choose **Custom…** to enter inclusive start and end dates. The selected dates apply to the project list, report activity, and any later Deep review or enhancement of that report.

| Deep review depth | Evidence in each project request |
| --- | --- |
| Low | Redacted user messages in session order |
| Medium | Redacted user messages, relevant changed filenames, and excerpts from the root README.md or CLAUDE.md |
| High | Redacted user messages, relevant filenames and root documents, and selected changed lines |

Before model requests, Deep displays message and word counts, the model's context budget, estimated input tokens, and its batching plan. It preserves wording when it fits. Larger projects are packed by session. A message larger than an entire request is sent in ordered fragments. The report runtime log records provider-measured input tokens when available. Claude Code Cloud uses a 200,000-token planning window by default, which you can set to the context of your model using claudeReport.deep.cloudContext.

Each project gets one request at the selected depth whenever its evidence fits the model context. In Cloud mode, the selected per-project model reviews projects independently, at most three at a time, and the overview model gets the project cards and validated reviews for one final synthesis. Local mode uses the selected model for both steps and reviews projects one at a time. The cache reuses a review when its hook, depth, evidence, and model settings match. Changing the depth builds a fresh project review with that selection. Model reasoning effort is a separate setting.

A Deep run reviews at one depth within a request budget. The confirmation lists the uncached project review batches and the final synthesis, and the estimate allows for splitting an oversized batch. The first confirmation for Create gives the workload for the project drafts.

The reviewer looks for clear goals and constraints, logical follow-ups, depth and verification, and examples of effective wording. The app checks that each quoted excerpt exists in the prompt it cites. Findings, rewrites and timestamp references appear near the top of the report. Git evidence uses commits matching the repository's configured author email and includes staged and working-tree changes when reviewing activity through the current day.

Projects with the same folder name receive distinct display labels. A stable project identifier preserves their identity across revisions.

A project comes from the working directory in a supported activity source, grouped by the nearest local Git root. The picker requires eligible user prompts in the selected dates. It shows up to five project rows before the **more** control. Daily token totals and selected prompts are separate inputs. A saved report's chart can include activity whose prompts were unavailable or omitted from its evidence sample.

## Manage a saved report

Open a saved report's menu in the **Report** tab.

| Action | What happens |
| --- | --- |
| Open report | Opens the saved run in the editor |
| Export | Exports the chosen run with the settings in **Output**. You can re-export older reports with the current layout |
| Manage exported copies | Shows copies saved by the extension, with actions to reveal a copy, remove its history entry, or move the file to Trash |
| Edit projects | Saves an edited report as a new revision. You can rename or remove a project, edit its summary, or update its examples, time evidence, AI uses and notes |
| Enhance report | Rewrites all projects or the projects you select using the chosen cloud model and effort, or a local engine, model and supported thinking setting |
| Retry failed projects | Runs the enhancement workflow for projects that failed in a partial report |
| Runtime log | Opens the Claude Report output with elapsed times for run stages and model requests, plus context size when available |
| Compare with previous revision | Shows what changed from the revision's parent while it is still saved |
| Hide from history | Moves the run to **Hidden reports**, where you can restore it |
| Delete saved report | Moves the selected run's files to Trash. Exported copies stay in their folders |

Enhancement of all projects also writes a new monthly overview when every project succeeds. A project edit or an enhancement whose scope or results cover only part of the report marks the overview as needing review. Each revision has its own history entry. Use **Cancel** in the Report tab to stop an active generation or enhancement.

**Progress** opens when a run starts. **List** shows project statuses and **Flow** groups them under the report phases. Your selected view is remembered. A completed run shows its elapsed time and **Open report**. Partial results stay expanded with **Retry failed**.

New runs keep a private redacted sample of up to 60 prompts for each project, with the time the original scan stopped. Enhancement uses that sample. For older reports without a sample, Claude Report rebuilds evidence from activity still available for the original reporting period and marks the run as using rebuilt evidence.

## Where reports are saved

New reports and revisions are saved under `~/.claude-report/reports/<YYYY-MM>/runs/<timestamp>/`. Older reports can still live directly under `~/.claude-report/reports/<YYYY-MM>/` and appear alongside newer runs.

| File | What it is |
| --- | --- |
| `report.html` | The page you see: one self-contained file with no external requests |
| `report.json` | The same report as data, with a `schemaVersion`. Meant to be importable by other tools without any model |
| `reports.json` | The per-project texts alone |
| `report-metadata.json` | Run details such as cloud hook, model, workload estimate when available, timing, parent revision and original cutoff |
| `report-evidence.json` | The private sample used for enhancement |
| `report-history.json` | Hidden status and tracked exported copies, when present |

## The skills

The report models receive instructions from Markdown files in `skills/`.

| Skill | Used for |
| --- | --- |
| `skills/project-ai-report/SKILL.md` | The per-project JSON shape and rules for describing work and giving supported examples |
| `skills/monthly-ai-report/SKILL.md` | The overview JSON shape and rules for summarizing sustained work and supported outcomes |

You can edit them to change tone and coverage. They are also valid Claude Code skills, so you can copy a folder into `~/.claude/skills/` to run them by hand. The project summary stays within 35 words. Expanded project text has a separate length target tied to the supplied evidence. A short first draft can receive one expansion pass. The overview is a separate model request.

## `report.json` shape

```json
{
  "schemaVersion": 1,
  "month": "2026-11",
  "label": "November 2026",
  "user": "alex.m",
  "overview": { "summary": "", "goal": "", "achievement": "" },
  "days": ["2026-11-01"],
  "projects": [
    {
      "name": "web-storefront",
      "tokens": 143500000,
      "sessions": 12,
      "prompts": 48,
      "daily": { "2026-11-03": 4100000 },
      "report": {
        "project": "web-storefront",
        "summary": "",
        "usedFor": [""],
        "examples": [{ "task": "Verify keyboard navigation", "detail": "Checked focus return on dialogs.", "withoutAI": "3 h", "withAI": "0.5 h", "basis": "Time supplied by you", "timeSource": "reported" }],
        "didntWork": [""],
        "nextMonth": [""],
        "source": "local"
      }
    }
  ]
}
```

`report` can be absent for a project with a failed model request. New projects have an opaque `id` and a `baseName` for retaining their identity across edits. Cards written locally carry `source: "local"`. New time entries come from the hours you supply for a task. Savings are shown when you also provide a baseline, and older reports can contain model estimates.

## Exporting

On the Report tab, **Output** decides what happens after a report is created. Use **Export** in a saved report's menu to repeat it for that run.

| Choice | Effect |
| --- | --- |
| Format | HTML, or PDF printed by Microsoft Edge or Google Chrome in a headless run. All project cards are opened for the PDF. If neither browser is found you get HTML and a note in the output panel |
| Save a copy | Saves the file in a month folder under `Downloads/Reports` or a folder you pick. When the filename already exists, the new copy gets a suffix such as `-2` |
