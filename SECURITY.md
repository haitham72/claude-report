# Security

## Reporting a problem

Please open a private security advisory on GitHub (Security tab, Report a vulnerability) rather than a public issue. Include what you did, what happened and your editor and extension version. I aim to answer within a week.

## What the extension touches

- Reads Claude Code transcripts in `~/.claude/projects`.
- Writes `~/.claude-report/` and, when you press Connect, `~/.claude/settings.json` (backup first, atomic write).
- Optionally sends the same redacted prompts to a model server on your own computer (localhost) instead.
- Runs your own `claude` command to write reports, with a redacted prompt on standard input and `--no-session-persistence`.

It has no telemetry. Its only network traffic is to a model server on localhost (LM Studio or Ollama), and only if you turn the local model on. Your account email is read only to show your username on a report; only the part before the @ is used.

## Known limits

- Redaction is pattern based. It cannot recognise every secret or piece of personal data. Read a report before sharing it.
- The status line hook only runs where Claude Code runs status lines.

The full list of what is read, written and sent is in [docs/privacy.md](docs/privacy.md).
