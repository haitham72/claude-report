# Contributing

Thanks for helping. Claude Report is small on purpose, so changes that keep it lean are the easiest to accept.

## Set up

```
git clone https://github.com/haitham72/claude-report.git
cd claude-report
node --test
```

There is nothing to install: plain Node 18 or newer, CommonJS, no dependencies and no bundler. Press F5 in VS Code to start an Extension Development Host with the extension loaded.

## Rules of the road

- **No new dependencies.** If you think one is needed, open an issue first.
- **Tests with every change.** `node --test` must pass. Tests never touch your real home folder, the network, a model server or the `claude` command: inject fakes, as the existing tests do.
- **Privacy is a feature.** Do not add anything that sends data anywhere, reads more files than it needs, or stores prompts. If a change touches what is read, written or sent, update `docs/privacy.md` in the same pull request.
- **No real data in the repository.** Screenshots and fixtures use invented data (`design/demo-data.js`). Never commit anything from `~/.claude` or `~/.claude-report`.
- **Keep the sidebar dense.** It follows the compact style of Claude Control and takes its colours from the editor theme. Check both a light and a dark theme.
- **Write plainly.** Short sentences, no hype, in code comments and in the docs. Comments say why, not what.

## Working on the UI

The sidebar and report are plain HTML, CSS and JavaScript in `template/`. You can see them without installing the extension:

```
node design/build-preview.js        # your real data, git-ignored
DEMO=1 node design/build-preview.js # invented data
```

Open the generated `design/*-preview.html` from a local static server (some browsers block `file:` pages). The preview has a fake host, so every tab and a simulated report run work. Try it in light and dark and at a narrow width.

## Pull requests

- Keep each pull request to one change, with a clear title and what you checked.
- Update `CHANGELOG.md` under a new version heading for anything a user would notice.
- If you change what the report says, edit the skills in `skills/` and check the output with a few real projects.

## Reporting bugs

Open an issue with your editor and extension version, what you did and what you expected. Include the lines from the **Claude Report** output panel (run **Claude Report: Diagnose Status Bar**). Do not paste prompts, tokens or paths you consider private. For security problems, see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the MIT license.
