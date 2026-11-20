# Troubleshooting

Start with **Claude Report: Diagnose Status Bar**. It prints what every live source returned to the **Claude Report** output panel. The panel also logs activation and errors.

## The status bar does not show

- It sits at the **left** end by default. Setting `claudeReport.statusBarSide` moves it, and needs a reload.
- Right-click the status bar and check that **Claude Report** is ticked.
- Run **Diagnose Status Bar**. If it lists model and context but you see nothing, the bar is hidden or crowded. If it lists nothing, no recent Claude Code session was found: use Claude Code once and press the refresh button in the sidebar.

## 5h and 7d are missing

- They come only from Claude Code's status line command. Open **Connect** and make sure **Status line hook** says Connected.
- Press **Test**. It runs the exact saved command and shows whether it ran, what it printed and whether it saved a reading.
- They need a Pro, Max, Team or Ultra plan, and Claude Code only reports them after a session's first response. Sometimes it sends a reading without them. The last good values are kept until the window resets, and the tooltip says how old they are.
- If **Last reading** never changes after you send a message in Claude Code, your Claude Code version or editor is not running status lines.

## Connect fails

- `EPERM: operation not permitted, rename … settings.json`: another program has `settings.json` open. Current versions retry and then write in place. Update the extension and press Connect again.
- **Update** appears next to Hook copy: your status line still points at an old copy of the hook. Press it once.
- **Remove** appears next to Previous status line: the program your old status line ran has been uninstalled. Press it to drop the dead entry.
- "needs Node.js": install Node.js and make sure `node` is on your PATH, then Connect again. If you install or move Node later, Disconnect and Connect again so the saved path is right.

## Create report fails or does nothing

- Run `claude -p "hello"` in a terminal. If that fails, sign in to Claude Code first, and make sure `claude` is on your PATH.
- No project listed: only projects with at least one prompt this month are shown.
- Local mode says the server is not running: start LM Studio's server or Ollama, load a model, or switch back to Cloud on **Connect**.
- A project shows `failed`: the model returned something that was not a usable report. Press Create report again for that project.
- Reports are written to `~/.claude-report/reports/<month>/` even if the preview does not open.

## Sessions open an empty Claude

Claude Code can only find a session from the folder it ran in. Sessions from the folder you have open resume in the Claude Code panel. Any other session resumes in a terminal opened in its own folder with `claude --resume`. If that folder was deleted you are warned, and the session may not be found.

## Export problems

- **PDF is HTML:** neither Microsoft Edge nor Google Chrome was found. Install one, or use HTML.
- **No Outlook draft with the file attached:** classic Outlook (Windows) or Outlook for Mac is needed. With the new Outlook for Windows, a plain draft opens and the file is selected for you to drag in.
- **Nothing saved:** the folder may not exist or be writable. Check the folder shown under **Save a copy**.

## The sidebar is blank or stuck

- Press the refresh button at the top of the sidebar (a soft reload), or run **Claude Report: Reload**.
- If that does not help, run **Claude Report: Restart Extension**.
- Open Help, then Toggle Developer Tools, and look for errors in the Console. Include them if you open an issue.

## Local model limits look wrong

The numbers are estimates, see [Local models](local-models.md). They need `nvidia-smi`. LM Studio must be running for its models to be listed.

## Still stuck

Open an issue at https://github.com/haitham72/claude-report/issues with your editor and extension version, what you did, and the lines from the **Claude Report** output panel. Do not paste prompts or secrets.
