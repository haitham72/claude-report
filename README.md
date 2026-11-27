<p align="center"><img src="media/marketplace/cover.png" alt="Claude Report: usage, prompting advice and reports for Claude Code, Codex, Antigravity and Cursor"></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=haitham72.claude-report"><img src="https://img.shields.io/visual-studio-marketplace/v/haitham72.claude-report?label=VS%20Code%20Marketplace" alt="Marketplace version"></a>
  <a href="https://open-vsx.org/extension/haitham72/claude-report"><img src="https://img.shields.io/open-vsx/v/haitham72/claude-report?label=Open%20VSX" alt="Open VSX version"></a>
  <a href="https://github.com/haitham72/claude-report/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

Claude Report shows your Claude Code, Codex, Antigravity and Cursor usage inside your editor, and turns a month of sessions into a report: what you shipped, how you prompt, and the commits behind it. It works in VS Code, Cursor, Windsurf, Antigravity and other Open VSX editors.

<p align="center"><img src="media/marketplace/report.gif" alt="A report scrolling from totals and overview to a project's examples with time saved, then to prompting advice"></p>

<p align="center"><img src="media/marketplace/metrics.png" alt="Know where your plan stands: five-hour and weekly usage, burn rate, a trend colored by level that marks early refills, and small bars in the status bar"></p>

<p align="center"><img src="media/marketplace/report.png" alt="See what you shipped: each project's work, examples and estimated time saved"></p>

<p align="center"><img src="media/marketplace/advice.png" alt="Advice on how you prompt: one strength, one thing to watch and one habit to try"></p>

<p align="center"><img src="media/marketplace/evidence.png" alt="Every finding shows its source: your quoted prompt, the changed lines and the commit"></p>

## Also included

- **Sessions:** browse your Claude Code history and resume any session in its own folder.
- **Status bar:** model, context, and five-hour and weekly usage as small bars.
- **Tidy sidebar:** sections fold from their headings, and long lists show the first rows with the rest behind a scrollable "more".
- **Cloud or local:** choose a signed-in CLI and its models to write your report, or use LM Studio or Ollama on your machine. Cloud previews estimate the share of your subscription when local quota history supports it and show the expected workload otherwise.
- **Export:** save reports as HTML or PDF.
- **Private:** reads local transcripts, redacts common secrets, no telemetry.

## Supported agents

| Agent | What is read | Tokens |
| --- | --- | --- |
| Claude Code | Local transcripts | Yes |
| Codex | Local session rollouts | Yes |
| Antigravity | Conversation index (read-only) | No |
| Cursor | Chat state database (read-only) | Only when Cursor records them |

Antigravity and Cursor need SQLite support: the editor's built-in `node:sqlite`, or `node` 22.13+ or 24 on your PATH. Devin (cloud sessions, no local transcripts) and Windsurf (encrypted history) are not supported.

## Get started

1. Install **Claude Report** from the Extensions view.
2. Open **Claude Report** in the activity bar to see Sessions and Metrics.
3. Plan gauges use your Claude Code login automatically. Optional: open **Connect** to add the status-line hook as another source (needs Node.js).
4. In **Report**, choose a date range, select projects, and expand your cloud hook to choose models. Review the usage estimate before pressing **Create report**.

[Full guide](docs/guide.md) · [Privacy](docs/privacy.md) · [Troubleshooting](docs/troubleshooting.md) · [Changelog](CHANGELOG.md)

Independent project, not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC. Images use invented data. Metrics layout adapted from [Claude Control](https://github.com/lucasdonordeste/claude-control) by Lucas do Nordeste.
