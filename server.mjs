// Claude Web UI — a local browser interface for Claude Code.
// Runs on 127.0.0.1 only. Uses the Claude Agent SDK, which reads the same
// configuration as the `claude` command (~/.claude/settings.json), so an
// Amazon Bedrock setup made with /setup-bedrock works as-is.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3737);
const TOKEN = crypto.randomBytes(16).toString('hex');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(ROOT, 'public', 'index.html');
const IS_WIN = process.platform === 'win32';
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-web-ui-uploads');
const MAX_UPLOAD = 25 * 1024 * 1024;
const URL_WITH_TOKEN = `http://${HOST}:${PORT}/?t=${TOKEN}`;

const SYSTEM_APPEND = [
  'You are being used through a local web interface on the user\'s computer.',
  'When the user asks you to visit websites or act in a web page, use the browser tools',
  '(their names start with mcp__browser__), which control Microsoft Edge.',
  'Keep answers readable: short paragraphs, lists where helpful.',
].join(' ');

// Playwright's MCP server lets Claude drive Edge (navigate, click, type, read pages).
function browserServer() {
  const args = ['-y', '@playwright/mcp@latest', '--browser', 'msedge'];
  return IS_WIN
    ? { type: 'stdio', command: 'cmd', args: ['/c', 'npx', ...args] }
    : { type: 'stdio', command: 'npx', args };
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/' && url.searchParams.get('t') === TOKEN) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(await fsp.readFile(INDEX));
    return;
  }
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Open the link printed in the terminal (it contains an access token).');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws' || url.searchParams.get('t') !== TOKEN || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  const st = {
    cwd: os.homedir(),
    sessionId: null,
    mode: 'default',
    model: '',            // '' = default from settings; or opus / sonnet / haiku / full model ID
    browser: true,
    abort: null,
    running: false,
    pending: new Map(),   // permission request id -> resolve
    alwaysAllow: new Set(),
  };

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  send({ type: 'hello', cwd: st.cwd, platform: process.platform });

  function denyAllPending(message) {
    for (const [, resolve] of st.pending) resolve({ behavior: 'deny', message });
    st.pending.clear();
  }

  function allowKey(toolName) {
    // "Always allow" on one browser action allows all browser actions.
    return toolName.startsWith('mcp__') ? toolName.split('__').slice(0, 2).join('__') : toolName;
  }

  function askPermission(toolName, input, { signal }) {
    if (st.alwaysAllow.has(allowKey(toolName))) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      st.pending.set(id, (answer) => {
        st.pending.delete(id);
        resolve(answer.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : answer);
      });
      signal?.addEventListener('abort', () => {
        if (st.pending.has(id)) st.pending.get(id)({ behavior: 'deny', message: 'Cancelled.' });
      }, { once: true });
      send({ type: 'permission', id, tool: toolName, input });
    });
  }

  async function run(text) {
    st.running = true;
    const ac = new AbortController();
    st.abort = ac;
    send({ type: 'busy', value: true });
    try {
      const q = query({
        prompt: text,
        options: {
          cwd: st.cwd,
          resume: st.sessionId || undefined,
          abortController: ac,
          includePartialMessages: true,
          permissionMode: st.mode,
          model: st.model || undefined,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
          mcpServers: st.browser ? { browser: browserServer() } : {},
          canUseTool: askPermission,
        },
      });
      for await (const m of q) handleMessage(m);
    } catch (err) {
      if (!ac.signal.aborted) send({ type: 'error', message: String(err?.message || err) });
    } finally {
      denyAllPending('Cancelled.');
      st.running = false;
      st.abort = null;
      send({ type: 'busy', value: false });
    }
  }

  function handleMessage(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.session_id && m.session_id !== st.sessionId) {
        st.sessionId = m.session_id;
        send({ type: 'session', id: st.sessionId });
      }
      return;
    }
    if (m.parent_tool_use_id) return; // hide subagent internals
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') send({ type: 'delta', text: e.delta.text });
      return;
    }
    if (m.type === 'assistant') {
      const content = m.message?.content || [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      if (text) send({ type: 'assistantText', text });
      for (const b of content) if (b.type === 'tool_use') send({ type: 'toolUse', id: b.id, name: b.name, input: b.input });
      return;
    }
    if (m.type === 'user') {
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        send({ type: 'toolResult', id: b.tool_use_id, isError: !!b.is_error, content: resultText(b.content) });
      }
      return;
    }
    if (m.type === 'result') {
      send({
        type: 'done',
        ok: m.subtype === 'success' && !m.is_error,
        cost: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
        message: m.subtype !== 'success' ? (m.errors?.join?.('\n') || m.subtype) : null,
      });
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.type) {
        case 'send': {
          if (st.running || typeof msg.text !== 'string') break;
          const files = Array.isArray(msg.files) ? msg.files.filter((f) => typeof f === 'string' && f.startsWith(UPLOAD_DIR)) : [];
          let text = msg.text.trim();
          if (files.length) text += `\n\nAttached files (read them with your tools):\n${files.map((f) => `- ${f}`).join('\n')}`;
          if (text) run(text);
          break;
        }
        case 'stop':
          denyAllPending('The user stopped the task.');
          st.abort?.abort();
          break;
        case 'permit': {
          const resolve = st.pending.get(msg.id);
          if (!resolve) break;
          if (msg.always) st.alwaysAllow.add(allowKey(msg.tool || ''));
          resolve(msg.allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user refused this action.' });
          break;
        }
        case 'settings':
          if (['default', 'acceptEdits', 'plan'].includes(msg.mode)) st.mode = msg.mode;
          if (typeof msg.browser === 'boolean') st.browser = msg.browser;
          if (typeof msg.model === 'string') st.model = msg.model.trim().slice(0, 200);
          break;
        case 'upload': {
          // Dropped files are saved to a temp folder; their paths are added to the prompt.
          const name = path.basename(String(msg.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
          const buf = Buffer.from(String(msg.data || ''), 'base64');
          if (buf.length > MAX_UPLOAD) { send({ type: 'error', message: `${name} is larger than 25 MB.` }); break; }
          const dir = path.join(UPLOAD_DIR, crypto.randomUUID());
          await fsp.mkdir(dir, { recursive: true });
          const file = path.join(dir, name);
          await fsp.writeFile(file, buf);
          send({ type: 'uploaded', ref: msg.ref, name, path: file, size: buf.length });
          break;
        }
        case 'setCwd': {
          if (st.running) break;
          const dir = path.resolve(String(msg.path || ''));
          if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            st.cwd = dir; st.sessionId = null; st.alwaysAllow.clear();
            send({ type: 'cwd', cwd: dir });
          } else send({ type: 'error', message: `Folder not found: ${dir}` });
          break;
        }
        case 'ls':
          send({ type: 'ls', ...(await listDirs(msg.path)) });
          break;
        case 'newChat':
          if (st.running) break;
          st.sessionId = null; st.alwaysAllow.clear();
          send({ type: 'session', id: null });
          break;
        case 'sessions': {
          const list = await listSessions({ dir: st.cwd, limit: 60 }).catch(() => []);
          send({
            type: 'sessions',
            items: list.map((s) => ({
              id: s.sessionId,
              title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
              when: s.lastModified,
            })),
          });
          break;
        }
        case 'openSession': {
          if (st.running) break;
          const msgs = await getSessionMessages(msg.id, { dir: st.cwd }).catch(() => []);
          st.sessionId = msg.id; st.alwaysAllow.clear();
          send({ type: 'session', id: msg.id });
          send({ type: 'history', items: simplifyHistory(msgs) });
          break;
        }
      }
    } catch (err) {
      send({ type: 'error', message: String(err?.message || err) });
    }
  });

  ws.on('close', () => { denyAllPending('Disconnected.'); st.abort?.abort(); });
});

// ---------- helpers ----------
function resultText(content) {
  let s = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
    : '';
  return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s;
}

function simplifyHistory(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const c = m.message?.content;
    if (m.type === 'user') {
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (text.trim()) out.push({ role: 'user', text });
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      const tools = c.filter((b) => b.type === 'tool_use').map((b) => b.name);
      if (text.trim() || tools.length) out.push({ role: 'assistant', text, tools });
    }
  }
  return out;
}

async function listDirs(p) {
  if (IS_WIN && (!p || p === 'drives')) {
    const drives = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) drives.push({ name: `${l}:`, path: `${l}:\\` });
    return { path: 'drives', parent: null, dirs: drives };
  }
  const dir = path.resolve(p || os.homedir());
  let entries = [];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* unreadable folder */ }
  const up = path.dirname(dir);
  const parent = up !== dir ? up : (IS_WIN ? 'drives' : null);
  return { path: dir, parent, dirs: entries, home: os.homedir() };
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  if (IS_WIN) exec(`start "" msedge "${url}"`, (err) => { if (err) exec(`start "" "${url}"`); });
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

server.listen(PORT, HOST, () => {
  console.log('\n  Claude Web UI is running.');
  console.log(`  Open: ${URL_WITH_TOKEN}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
  openBrowser(URL_WITH_TOKEN);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other window or set PORT=3738.`);
  else console.error(err);
  process.exit(1);
});
