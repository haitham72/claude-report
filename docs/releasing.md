# Releasing

A checklist for the maintainer. Nothing here runs by itself.

## Before the first public release

1. **Name.** The extension id is `haitham72.claude-report` and cannot be changed after the first publish. The display name can. Search the [Marketplace](https://marketplace.visualstudio.com/search?term=claude%20report&target=VSCode) and [Open VSX](https://open-vsx.org/?search=claude%20report) again right before publishing. "Claude" is Anthropic's mark. [Anthropic's trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines) require approval for any use of their marks and forbid implying affiliation, and they do not say whether a third-party product name containing "Claude" is allowed. The README states that this is an independent project. If in doubt, ask Anthropic or choose a name without "Claude" before the first publish.
2. **Git history.** A public repository keeps everything ever pushed. Check what the history exposes before announcing it:
   ```
   git log --all --name-only --format= | sort -u
   git log --all -S"<a private project or person name>" --oneline
   ```
   Also check commit author emails with `git log --all --format="%an <%ae>" | sort -u`. Removing something from the current files does not remove it from history. If the history holds anything private, rewrite it (for example with `git filter-repo`) or publish from a fresh repository.
3. **Images.** Every image in the README must be tracked by Git and pushed, because Marketplace pages load them from the repository. Check with `git ls-files media/screenshots` and make sure no `.gitignore` rule matches them.

## Before every release

1. `node --test` passes (no network, no real home folder is touched).
2. Update `CHANGELOG.md` and the `version` in `package.json`. A version cannot be published twice.
3. If the UI changed, regenerate the screenshots (below) so the Marketplace page matches.
4. Build and inspect the package:
   ```
   npm run package
   npx @vscode/vsce ls --no-dependencies
   ```
   The VSIX is written to `dist/`. The list should hold the extension code, `bin/`, `skills/`, `template/`, `media/icon.*`, `README.md`, `CHANGELOG.md` and `LICENSE`. Local router and handoff files, private outputs, and development assets are excluded.
5. Install the `.vsix` in a clean profile and walk through: Sessions, Metrics, Connect (Connect, Test, Disconnect), Create report for one project, export to PDF, and the Local switch if LM Studio is available.

## Regenerating the images

The pictures in `media/screenshots/` come from invented data (`design/demo-data.js`), never from a real machine.

```
DEMO=1 node design/build-preview.js
```

This writes `design/demo-preview.html` (the real sidebar inside a mock editor, with a fake host) and `design/demo-report.html` (the report page). Both are git-ignored. Serve the `design/` folder from any static server and open both in a browser, using a device scale factor of 2.

| File | How to capture it |
| --- | --- |
| `sessions-*.png`, `metrics-*.png`, `report-*.png` | Viewport 1100 by 760. Click the tab, then take an element screenshot of `#side`. Use `colorScheme` dark and light |
| `connect-cloud-dark.png`, `connect-local-dark.png` | Viewport 1100 by 840. Open the Connect tab. Click `[data-mode=local]` for the Local one |
| `statusbar.png` | Element screenshot of the first `.sbwrap`, dark |
| `report-page.png` | Open `demo-report.html` at 900 by 1250 and take a viewport screenshot. Hide the scrollbar first |
| `report-projects.png` | Click the first project summary only (not **Expand all**) and clip from the Projects heading to the third row |
| `report-advice.png` | Element screenshot of `#advice` with a small margin |
| `social-preview.png` | Open `design/social-preview.html` from a server that serves the repository root, at 1280 by 640 |

The README is also the Marketplace page. Its images in `media/marketplace/` are designed, not screenshots:

- `cover.png`, `metrics.png`, `report.png`, `advice.png` and `evidence.png` come from `design/marketplace-ads.html`. Open it with `#cover` at 1280 by 640, or with `#metrics`, `#report`, `#advice` or `#evidence` at 1280 by 720, at a device scale factor of 2, and save each as `media/marketplace/<name>.png`.
- `report.gif` comes from `node design/build-gif.js` after `DEMO=1 node design/build-preview.js`. It needs Chrome or Edge and `ffmpeg` on the PATH.

The full manual is `docs/guide.md`; its screenshots stay in `media/screenshots/`.

Check that no real project, session or person appears in any image before committing.

## Accounts you need once

### Visual Studio Marketplace

1. Sign in at https://marketplace.visualstudio.com/manage with a Microsoft account.
2. **Create publisher.** The ID must be `haitham72` to match `package.json`. It is permanent. The display name can change later.
3. Create a Personal Access Token. At https://dev.azure.com, create a free organization if you have none, then open **User settings → Personal access tokens → New Token**. Set **Organization** to **All accessible organizations**, choose **Custom defined**, show all scopes, and tick **Marketplace → Manage**. A token with a narrower organization or the wrong scope fails with a 401 or 403 at publish time. Copy it once. It is shown only once.
4. Check it: `npx @vscode/vsce verify-pat haitham72` and paste the token.

### Open VSX (Cursor, Antigravity, VSCodium)

1. Sign in at https://open-vsx.org with GitHub.
2. Open your profile and link an Eclipse Foundation account (create one if needed). Its GitHub username field must match the account you signed in with. Sign the **Publisher Agreement** there. Publishing is refused until it is signed.
3. Open **Settings → Access Tokens** and create a token.
4. Create the namespace once: `npx ovsx create-namespace haitham72 -p <open-vsx token>`.
5. Optional: claim the namespace as yours by opening an issue in the `EclipseFdn/open-vsx.org` repository. Until then, listings show as unverified.

Keep both tokens out of the repository, the shell history and chat. Prefer the `VSCE_PAT` and `OVSX_PAT` environment variables to `-p`.

## Publishing

Releases publish from GitHub Actions ([release.yml](../.github/workflows/release.yml)). Open VSX needs no token: on open-vsx.org, open the extension under **Settings → Extensions**, choose **Add a trusted publisher**, and enter owner `haitham72`, repository `claude-report`, workflow `release.yml` and no environment. The VS Code Marketplace needs a `VSCE_PAT` secret under the repository's **Settings → Secrets and variables → Actions**; without it that step is skipped with a warning.

1. Update `CHANGELOG.md` and the `version` in `package.json`, and commit.
2. Push the commit, then a tag for that version:
   ```
   git push origin main
   git tag v<version>
   git push origin v<version>
   ```
3. The workflow runs the tests, checks that the tag matches `package.json`, builds the VSIX, publishes it to the Marketplace and Open VSX, and creates a GitHub release with the VSIX and this version's changelog section.

Ordinary pushes never publish. The Marketplace can take several minutes to show a new version while it is scanned. To publish by hand instead:

```
npm run package
npx @vscode/vsce publish --no-dependencies -p <marketplace token>
npx ovsx publish dist/claude-report-<version>.vsix -p <open-vsx token>
```

After the first publish, add the badges below the title in the README and check that every image loads on the Marketplace page. Relative image links are rewritten to the GitHub repository, so they only work once the repository is public and the images are pushed.

```
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/haitham72.claude-report)](https://marketplace.visualstudio.com/items?itemName=haitham72.claude-report)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/haitham72.claude-report)](https://marketplace.visualstudio.com/items?itemName=haitham72.claude-report)
[![Open VSX](https://img.shields.io/open-vsx/v/haitham72/claude-report)](https://open-vsx.org/extension/haitham72/claude-report)
```

## Publishing without a token

The Marketplace also accepts a manual upload, which needs no Azure DevOps organization or token. Open https://marketplace.visualstudio.com/manage, choose the publisher, then **+ New extension**, **Visual Studio Code**, and upload `dist/claude-report-<version>.vsix`. To update, use the extension's menu, **Update**, and upload the new file. Version 0.11.0 was published this way on 20 November 2026. Open VSX still needs its own token.

## GitHub repository

- Set the description, website and topics in the repository settings, for example topics `vscode-extension`, `claude-code`, `codex`, `usage-tracking` and `ai-report`.
- Upload `media/screenshots/social-preview.png` under **Settings → General → Social preview**. GitHub offers no API for this.

## After publishing

- Install it from the registry in a clean profile and confirm it activates.
- Watch the issue tracker. `docs/troubleshooting.md` is the first place to point people.
