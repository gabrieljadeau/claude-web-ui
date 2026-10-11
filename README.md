# Claude Web UI

A local browser interface for [Claude Code](https://code.claude.com), built on the Claude Agent SDK.
It works with **Amazon Bedrock** (and any other setup the `claude` command already uses), where the
built-in Remote Control feature isn't available.

Everything runs on your own computer, on `127.0.0.1` only. Nothing is exposed to the network.

## Features

- **Chat** with live streaming answers and visible tool activity (commands, file edits, results)
- **History**: list past chats for the current folder and resume them (shared with the `claude` terminal history)
- **Approvals**: Allow / Always allow / Refuse before Claude edits files, runs commands or acts in the browser
- **Working folder** picker
- **Model** picker: default, Opus, Sonnet, Haiku, or any custom model ID (e.g. a Bedrock inference profile)
- **Modes**: ask before changes, auto-accept file edits, or plan only
- **Drag and drop** files (or paste, or the paperclip button) to attach them to a message
- **Voice input** (French, Spanish, English) and optional **read replies aloud**
- **Browser actions**: Claude can open Microsoft Edge, navigate, click and fill pages (via [Playwright MCP](https://github.com/microsoft/playwright-mcp))

## Requirements

- Windows, macOS or Linux
- [Node.js](https://nodejs.org) 20 or later (LTS recommended)
- Microsoft Edge or Google Chrome (voice input relies on the browser's speech recognition)
- A working Claude Code configuration. For Amazon Bedrock, run `claude` once in a terminal and use
  `/setup-bedrock` so the settings are saved in `~/.claude/settings.json`. Environment variables set only in
  one terminal session will not be seen by this app.

## Install and run (Windows)

```bat
git clone https://github.com/<owner>/claude-web-ui.git
cd claude-web-ui
start.bat
```

Or double-click `start.bat`. The first run installs dependencies; Edge then opens automatically.
Keep the black window open while you use the interface; close it (or press Ctrl+C) to stop.

## Install and run (macOS / Linux)

```bash
git clone https://github.com/<owner>/claude-web-ui.git
cd claude-web-ui
npm install
npm start
```

## Notes

- The page address contains a random access token that changes at every start, so other websites
  or local programs cannot connect to it. Use the link printed in the terminal.
- Dropped files are saved to a temporary folder and their paths are passed to Claude. Ask Claude to copy
  them into your project if you want to keep them there.
- The first browser action downloads Playwright MCP through `npx`, which can take a minute.
- Change the port with the `PORT` environment variable (default `3737`).

## Security

Claude can read and change files in the working folder and run commands, like the `claude` terminal command.
Keep "Ask before changes" on unless you trust the task, and review approval requests before accepting them.

## License

MIT
