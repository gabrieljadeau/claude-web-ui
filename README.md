# Claude Web UI

A local browser interface for [Claude Code](https://code.claude.com), built on the Claude Agent SDK.
It gives people who only have the `claude` terminal command (for example on **Amazon Bedrock**, where
the official desktop app and Remote Control are not available) an interface close to claude.ai:
chats, Cowork tasks, Code sessions grouped per project, routines, skills, connectors and plugins.

Everything runs on your own computer, on `127.0.0.1` only. Nothing is exposed to the network.

## What you get

- **Chat** — plain conversations (Claude can read attached files and fetch web pages, nothing else)
- **Cowork** — give Claude a folder and a task; it works on its own and saves results in that folder
- **Code** — sessions inside a project folder, like the `claude` terminal: reads code, edits files, runs commands
- **Projects** — sessions grouped per folder in the sidebar, like the desktop app
- **Routines** — prompts that run on a schedule (daily, every N minutes, once) in a folder, with templates and run history
- **Customize** — install and manage **skills** (`~/.claude/skills`), **connectors** (MCP servers) and **plugins**
  (official marketplace), shared with the terminal `claude`
- Several sessions can run at the same time; the sidebar shows which ones are working or need an approval
- **Approvals**: Allow / Always allow / Refuse before Claude edits files, runs commands or acts in the browser
- Model picker (default, Opus, Sonnet, Haiku, or any model ID such as a Bedrock inference profile), permission modes
- Drag and drop or paste files, **voice input** (French, Spanish, English), optional read-aloud
- **Browser actions**: Claude can open a browser, navigate, click and fill pages (via [Playwright MCP](https://github.com/microsoft/playwright-mcp))
- Search (Ctrl/⌘+K), rename, pin, archive, delete, light and dark theme

## Requirements

- Windows, macOS or Linux
- [Node.js](https://nodejs.org) 20 or later (LTS recommended)
- Microsoft Edge or Google Chrome (voice input relies on the browser's speech recognition)
- The `claude` command installed and logged in (see **Connecting** below)

## Install and run (Windows)

```bat
git clone https://github.com/gabrieljadeau/claude-web-ui.git
cd claude-web-ui
start.bat
```

Or double-click `start.bat`. The first run installs dependencies; the browser then opens automatically.
Keep the black window open while you use the interface; close it (or press Ctrl+C) to stop.

## Install and run (macOS / Linux)

```bash
git clone https://github.com/gabrieljadeau/claude-web-ui.git
cd claude-web-ui
npm install
npm start
```

## Connecting

The interface uses exactly the same login as the `claude` terminal command. At start it runs
`claude auth status`; if you are not connected, a **Connect Claude** screen explains what to do:

1. Open a terminal and run `claude` (the "Open a terminal with claude" button does it for you).
2. Log in there: `/login` for a Claude account, or your company's Amazon Bedrock setup
   (the AWS credentials and `CLAUDE_CODE_USE_BEDROCK=1` must be in `~/.claude/settings.json` → `env`,
   or in your system environment; variables set only in one terminal window are not seen by this app).
3. Type `/exit`, come back to the browser and press **Check again**. **Test with a real request** sends one tiny
   message to confirm everything works end to end.

## Update to the latest version

In the `claude-web-ui` folder:

```bat
git pull
npm install
```

Then start it again with `start.bat` (or `npm start`).

## Notes

- The page address contains a random access token that changes at every start, so other websites
  or local programs cannot connect to it. Use the link printed in the terminal.
- Chats, sessions and history are stored by Claude Code in `~/.claude/projects` (shared with the terminal).
  App settings, projects and routines are in `~/.claude-web-ui/state.json`.
- Routines run only while the app is open. A run that was missed by more than 6 hours (computer off) is skipped.
- Dropped files are saved to a temporary folder and their paths are passed to Claude. Ask Claude to copy
  them into your project if you want to keep them there.
- The first browser action downloads Playwright MCP through `npx`, which can take a minute.
- Change the port with the `PORT` environment variable (default `3737`).

## Security

Claude can read and change files in the working folder and run commands, like the `claude` terminal command.
"Autonomous" permission mode never asks for confirmation: use it only for folders and tasks you trust.
Keep "Ask before changes" on for Code sessions unless you trust the task, and review approval requests before accepting them.

## License

MIT
