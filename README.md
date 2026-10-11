# Claude Web UI

A local browser interface for [Claude Code](https://code.claude.com), built on the Claude Agent SDK.
It works with **Amazon Bedrock** (and any other setup the `claude` command already uses), where the
built-in Remote Control feature isn't available.

Everything runs on your own computer, on `127.0.0.1` only. Nothing is exposed to the network.

## Features

- **Familiar chat layout**: recent chats on the left (grouped by date, searchable, rename and delete), the conversation in the middle, a welcome screen for new chats
- **Progress panel** on the right, so you can follow what the agent is doing:
  - **Progress**: Claude's plan and to-do list, ticked off live
  - **Outputs**: files Claude created or changed, with a preview (web pages, images, Markdown, text)
  - **Steps**: every action as it happens (files read, commands run, browser actions, helper agents), with details and results
  - **Used in this chat**: the tools involved
- **In the chat**: streaming answers, a collapsible "thinking" block, compact step summaries ("Read 2 files, ran a command"), code blocks with a copy button, tables
- **Edit and retry** any message: the conversation continues from that point
- **Approvals**: Allow, Always allow for this chat, or Deny before Claude edits files, runs commands or uses the browser
- **Working folder** with the Windows folder picker and a list of recent folders
- **Model**, **thinking effort** and **approval mode** right in the message box
- **Drag and drop** files (or paste, or use +) to attach them, with image thumbnails
- **Voice input** (French, Spanish, English) and **read replies aloud**
- **Browser actions**: Claude can open Microsoft Edge, navigate, click and fill pages (via [Playwright MCP](https://github.com/microsoft/playwright-mcp))
- Light and dark mode, black and white design

## Requirements

- Windows, macOS or Linux
- [Node.js](https://nodejs.org) 20 or later (LTS recommended)
- Microsoft Edge or Google Chrome (voice input relies on the browser's speech recognition)
- A working Claude Code configuration. For Amazon Bedrock, run `claude` once in a terminal and use
  `/setup-bedrock` so the settings are saved in `~/.claude/settings.json`. Environment variables set only in
  one terminal session will not be seen by this app.

## Install and run (Windows)

```bat
git clone https://github.com/gabrieljadeau/claude-web-ui.git
cd claude-web-ui
start.bat
```

Or double-click `start.bat`. The first run installs dependencies; Edge then opens automatically.
Keep the black window open while you use the interface; close it (or press Ctrl+C) to stop.

## Install and run (macOS / Linux)

```bash
git clone https://github.com/gabrieljadeau/claude-web-ui.git
cd claude-web-ui
npm install
npm start
```

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
- Dropped files are saved to a temporary folder and their paths are passed to Claude. Ask Claude to copy
  them into your project if you want to keep them there.
- The first browser action downloads Playwright MCP through `npx`, which can take a minute.
- Change the port with the `PORT` environment variable (default `3737`).

## Security

Claude can read and change files in the working folder and run commands, like the `claude` terminal command.
Keep "Ask before changes" on unless you trust the task, and review approval requests before accepting them.

## License

MIT
